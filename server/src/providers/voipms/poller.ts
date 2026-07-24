import { config } from '../../config.js';
import { getSMS, getMMS, getMediaMMS, getDIDsInfo, type VoipMsSms, type VoipMsDid } from './client.js';
import { messageExists, reactionExists, getKv, setKv, upsertAccount, getAccounts } from '../../store/db.js';
import { ingest } from '../../services/ingest.js';
import { backfillReactions } from '../../services/backfill.js';
import { broadcast } from '../../realtime/sse.js';
import { listAccounts } from '../registry.js';
import { normalizeTel } from '../../contacts/match.js';

let status = 'idle';
let timer: NodeJS.Timeout | undefined;
let running = false;

export function getPollerStatus(): string {
  return status;
}

function dateNDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function accountIdForDid(did: string): string {
  return `voipms:${normalizeTel(did) ?? did}`;
}

function formatDidLabel(d: string): string {
  const digits = d.replace(/\D/g, '').slice(-10);
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return d;
}

async function refreshAccounts(): Promise<VoipMsDid[]> {
  try {
    const dids = await getDIDsInfo();
    for (const d of dids) {
      upsertAccount({
        id: accountIdForDid(d.did),
        provider: 'voipms',
        label: d.description ? `${formatDidLabel(d.did)} — ${d.description}` : formatDidLabel(d.did),
      });
    }
    broadcast({ type: 'accounts', data: listAccounts() });
    return dids;
  } catch (err) {
    console.error('[voipms] getDIDsInfo failed:', (err as Error).message);
    // Fall back to previously-seen accounts.
    return getAccounts()
      .filter((a) => a.provider === 'voipms')
      .map((a) => ({ did: a.id.slice('voipms:'.length), description: a.label }));
  }
}

/** Map a raw voip.ms row to a provider-normalized message. */
function toNormalized(sms: VoipMsSms, idOverride?: string, mediaUrls?: string[]) {
  const did = normalizeTel(sms.did) ?? sms.did;
  const contact = normalizeTel(sms.contact) ?? sms.contactRaw;
  return {
    id: idOverride ?? sms.id,
    accountId: `voipms:${did}`,
    chatRemoteId: contact,
    contactRaw: sms.contactRaw,
    ts: sms.ts,
    date: sms.date,
    outgoing: sms.type === 0,
    body: sms.message,
    carrierStatus: sms.carrierStatus,
    mediaUrls,
  };
}

async function pollOnce(): Promise<number> {
  if (running) return 0;
  running = true;
  let newCount = 0;
  try {
    const dids = await refreshAccounts();
    // Track the highest SMS id we've SEEN (not just ingested) so suppressed
    // reactions (not stored in the messages table) still advance the cursor.
    const sinceId = BigInt(getKv('voipms:poller_since_id') ?? '0');
    const from = dateNDaysAgo(7);
    let maxSmsId = sinceId;

    for (const { did } of dids) {
      const accountId = accountIdForDid(did);
      let messages: VoipMsSms[];
      try {
        messages = await getSMS({ did, from, limit: 200 });
      } catch (err) {
        console.error(`[voipms] getSMS failed for ${did}:`, (err as Error).message);
        status = `error: ${(err as Error).message}`;
        continue;
      }
      for (const sms of messages) {
        const id = BigInt(sms.id || '0');
        if (id > maxSmsId) maxSmsId = id;
        if (sinceId > 0n && id <= sinceId) continue;
        if (await ingest(toNormalized(sms), 'poll')) newCount++;
      }

      // MMS pass (namespaced provider id mms:<id> so it can't collide with SMS ids).
      let mms: VoipMsSms[];
      try {
        mms = await getMMS({ did, from, limit: 200 });
      } catch (err) {
        console.error(`[voipms] getMMS failed for ${did}:`, (err as Error).message);
        continue;
      }
      for (const m of mms) {
        const key = `mms:${m.id}`;
        // Skip if already stored as a message OR processed as a reaction.
        if (messageExists(`${accountId}:${key}`) || reactionExists(`${accountId}:${key}`)) continue;
        // getMMS omits media inline even for image MMS — fetch via getMediaMMS.
        let mediaUrls = m.mediaUrls;
        if (!mediaUrls || !mediaUrls.length) {
          try {
            mediaUrls = await getMediaMMS(m.id);
          } catch (err) {
            console.error(`[voipms] getMediaMMS failed for ${m.id}:`, (err as Error).message);
          }
        }
        if (await ingest(toNormalized(m, key, mediaUrls?.length ? mediaUrls : undefined), 'poll')) newCount++;
      }
    }
    // Persist the highest id seen so suppressed reactions don't loop forever.
    setKv('voipms:poller_since_id', maxSmsId.toString());
    status = `ok (${new String(newCount)} new @ ${new Date().toLocaleTimeString()})`;
    // A reaction may be ingested before its target within a batch; heal.
    if (newCount > 0) backfillReactions();
  } catch (err) {
    status = `error: ${(err as Error).message}`;
    console.error('[voipms] poll error:', (err as Error).message);
  } finally {
    running = false;
  }
  return newCount;
}

export async function startPoller(): Promise<void> {
  status = 'starting';
  await pollOnce(); // immediate catch-up on boot
  const interval = Math.max(5_000, config.voipms.pollIntervalMs);
  timer = setInterval(() => {
    void pollOnce();
  }, interval);
  console.log(`[voipms] poller started, polling every ${interval}ms`);
}

export async function runPollOnce(): Promise<number> {
  return pollOnce();
}

const HISTORY_CHUNK_DAYS = 90; // voip.ms caps date-range queries at ~92 days

export interface BackfillResult {
  from: string;
  to: string;
  newMessages: number;
  reachedLimit: boolean;
}

/**
 * Fetch one 90-day chunk of history older than the last backfill point and
 * ingest it. Idempotent (deduped by message id). Call repeatedly to page back
 * through history.
 */
export async function backfillHistoryChunk(): Promise<BackfillResult> {
  const oldestStr = getKv('voipms:history_oldest');
  const oldest = oldestStr ? Number(oldestStr) : Date.now();
  const fromTs = oldest - HISTORY_CHUNK_DAYS * 86400000;
  const from = new Date(fromTs).toISOString().slice(0, 10);
  const to = new Date(oldest).toISOString().slice(0, 10);
  const dids = await refreshAccounts();
  let n = 0;
  for (const { did } of dids) {
    const accountId = accountIdForDid(did);
    try {
      for (const sms of await getSMS({ did, from, to, limit: 9999 })) {
        if (await ingest(toNormalized(sms), 'poll', false)) n++;
      }
    } catch (e) {
      console.error(`[voipms backfill] getSMS ${did}:`, (e as Error).message);
    }
    try {
      for (const m of await getMMS({ did, from, to, limit: 9999 })) {
        const key = `mms:${m.id}`;
        if (messageExists(`${accountId}:${key}`)) continue;
        let mediaUrls = m.mediaUrls;
        if (!mediaUrls?.length) {
          try {
            mediaUrls = await getMediaMMS(m.id);
          } catch {
            /* non-fatal */
          }
        }
        if (await ingest(toNormalized(m, key, mediaUrls?.length ? mediaUrls : undefined), 'poll', false)) n++;
      }
    } catch (e) {
      console.error(`[voipms backfill] getMMS ${did}:`, (e as Error).message);
    }
  }
  setKv('voipms:history_oldest', String(fromTs));
  console.log(`[voipms backfill] ${from} → ${to}: ${n} new`);
  // A reaction may be ingested before its target within/across chunks; heal now.
  backfillReactions();
  return { from, to, newMessages: n, reachedLimit: n === 0 };
}

export function stopPoller(): void {
  if (timer) clearInterval(timer);
}

/**
 * One-time importer: migrate history from a voipms-frontend app.db into the
 * universal-messenger unified schema.
 *
 *   npm run import-voipms -- --db /path/to/old/data/app.db
 *
 * Idempotent (message ids are preserved namespaced, ON CONFLICT DO NOTHING).
 */
import Database from 'better-sqlite3';
import { initDb, getOrCreateChat, upsertAccount } from './store/db.js';
import { ingest } from './services/ingest.js';
import { addReaction, reactionExists } from './store/db.js';
import { parseVoipDate } from './providers/voipms/client.js';
import { normalizeTel } from './contacts/match.js';

interface OldMessage {
  id: string;
  date: string;
  ts: number;
  type: 0 | 1;
  did: string;
  contact: string;
  contact_raw: string;
  message: string;
  carrier_status: string | null;
  read: number;
  media: string | null;
}

interface OldReaction {
  id: string;
  target_id: string | null;
  did: string;
  contact: string;
  emoji: string;
  from_tel: string | null;
  ts: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function accountIdForDid(did: string): string {
  return `voipms:${normalizeTel(did) ?? did}`;
}

async function main() {
  const srcPath = arg('db');
  if (!srcPath) {
    console.error('Usage: npm run import-voipms -- --db /path/to/old/app.db');
    process.exit(1);
  }

  initDb();
  const src = new Database(srcPath, { readonly: true });

  const messages = src.prepare('SELECT * FROM messages').all() as unknown as OldMessage[];
  const reactions = src.prepare('SELECT * FROM reaction_events').all() as unknown as OldReaction[];
  console.log(`[import] source: ${messages.length} messages, ${reactions.length} reactions`);

  // Accounts: one per DID seen in the old data.
  const dids = [...new Set(messages.map((m) => m.did))];
  for (const did of dids) {
    upsertAccount({ id: accountIdForDid(did), provider: 'voipms', label: normalizeTel(did) ?? did });
  }

  let imported = 0;
  let skipped = 0;
  for (const m of messages) {
    const accountId = accountIdForDid(m.did);
    const contact = normalizeTel(m.contact) ?? m.contact_raw ?? m.contact;
    const chat = getOrCreateChat(accountId, contact, { contactRaw: m.contact_raw || m.contact });
    // Preserve the old id (already namespaced 'mms:<id>' for MMS).
    const ok = await ingest(
      {
        id: m.id,
        accountId,
        chatRemoteId: chat.remoteId,
        contactRaw: m.contact_raw || m.contact,
        ts: m.ts || parseVoipDate(m.date),
        date: m.date,
        outgoing: m.type === 0,
        body: m.message,
        media: m.media ? (JSON.parse(m.media) as { url: string; contentType: string }[]) : undefined,
        carrierStatus: m.carrier_status ?? '',
      },
      'import',
      false
    );
    if (ok) imported++;
    else skipped++;
  }

  // Reactions: map old (did, contact) + target id onto the new namespaced ids.
  let mapped = 0;
  for (const r of reactions) {
    const accountId = accountIdForDid(r.did);
    const contact = normalizeTel(r.contact) ?? r.contact;
    const chatId = `${accountId}:${contact}`;
    const id = `${accountId}:${r.id}`;
    if (reactionExists(id)) continue;
    addReaction({
      id,
      messageId: r.target_id ? `${accountId}:${r.target_id}` : null,
      chatId,
      emoji: r.emoji,
      fromSender: r.from_tel ?? undefined,
      ts: r.ts,
    });
    mapped++;
  }

  console.log(`[import] done: ${imported} messages imported (${skipped} dupes skipped), ${mapped} reactions mapped`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[import] failed:', err);
  process.exit(1);
});

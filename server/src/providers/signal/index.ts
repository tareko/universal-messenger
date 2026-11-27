import { getKv, setKv } from '../../store/db.js';
import {
  addReaction,
  findMessageIdsBySuffix,
  getChat,
  getOrCreateChat,
  getMessage,
  getName,
  getReactionsForMessage,
  isRecentOutgoing,
  markMessageDeleted,
  removeReactions,
  replaceChatParticipants,
  setAccountStatus,
  setName,
  setProviderAccountsStatus,
  updateMessageBody,
  updateMessageReceipt,
  upsertAccount,
} from '../../store/db.js';
import { saveMediaBuffer, saveUploadedMedia } from '../../services/media.js';
import { ingest } from '../../services/ingest.js';
import { broadcast, broadcastTyping } from '../../realtime/sse.js';
import { listAccounts } from '../registry.js';
import type { Chat, Message } from '../../types.js';
import type { Provider, SendPayload, SendResult } from '../types.js';

type SignalState = 'idle' | 'connecting' | 'qr' | 'open' | 'error';

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  /** Device-sync echo of messages sent from the phone / other linked devices. */
  syncMessage?: { sentMessage?: SignalDataMessage & { destination?: string; destinationNumber?: string } };
  typingMessage?: { action?: string; timestamp?: number };
  receiptMessage?: { type?: string; isDelivery?: boolean; isRead?: boolean; timestamps?: number[] };
}
interface SignalDataMessage {
  timestamp: number;
  message?: string | null;
  expiresInSeconds?: number;
  attachments?: { id: string; contentType?: string; filename?: string; size?: number }[];
  groupInfo?: { groupId?: string; type?: string; name?: string };
  quote?: { id?: number; author?: string; authorNumber?: string; text?: string };
  reaction?: {
    emoji?: string;
    targetAuthor?: string;
    targetAuthorNumber?: string;
    targetSentTimestamp?: number;
    isRemove?: boolean;
  };
  editMessage?: { targetSentTimestamp?: number; dataMessage?: SignalDataMessage };
  remoteDelete?: { timestamp?: number };
  mentions?: unknown;
}

/**
 * Signal provider via a signal-cli REST API sidecar
 * (https://github.com/bbernhard/signal-cli-rest-api, a thin wrapper around
 * signal-cli). Runs locally as a secondary linked device — history is NOT
 * available from Signal, so messages accrue from link time onward.
 */
export class SignalProvider implements Provider {
  id = 'signal';
  capabilities = {
    reply: true,
    react: true,
    forward: false,
    edit: true,
    delete: true,
    groups: true,
    attachments: true,
    crossChatQuotes: false,
  };

  private state: SignalState = 'idle';
  private accountId: string | null = null;
  private number: string | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  private get base(): string {
    return (getKv('signal:api_url') ?? 'http://localhost:8080').replace(/\/+$/, '');
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    if (!getKv('signal:enabled')) {
      console.log('[signal] not configured — set it up via the Accounts dialog');
      return;
    }
    try {
      await this.connect();
    } catch (e) {
      this.state = 'error';
      console.error('[signal] connect failed:', (e as Error).message);
    }
    // Self-heal: the docker sidecar can die (host suspend/reboot) and come
    // back later — retry while we're enabled but not open/qr. Skipped when
    // the user deliberately disconnected (signal:enabled cleared).
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => {
        if (this.state !== 'open' && this.state !== 'qr' && getKv('signal:enabled')) {
          console.log('[signal] health sweep: state=%s — reconnecting', this.state);
          void this.connect().catch(() => {
            // connect() sets 'connecting' before its first await; a failure
            // must not leave that lying state behind.
            if (this.state === 'connecting') this.state = 'error';
          });
        }
      }, 60_000);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.ws?.close();
    this.ws = null;
  }

  status(): string {
    return this.state;
  }

  getPublicState(): { state: SignalState; accountId: string | null; url: string } {
    return { state: this.state, accountId: this.accountId, url: this.base };
  }

  /** Registered accounts on the sidecar (also used to detect link success). */
  private async accounts(): Promise<string[]> {
    const res = await fetch(`${this.base}/v1/accounts`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`signal /v1/accounts: HTTP ${res.status}`);
    return (await res.json()) as string[];
  }

  /** Fetch the device-linking QR (PNG bytes) from the sidecar. */
  async getLinkQr(): Promise<{ data: string; contentType: string } | null> {
    try {
      const res = await fetch(`${this.base}/v1/qrcodelink?device_name=universal-messenger`, {
        signal: AbortSignal.timeout(15000),
      });
      const ct = res.headers.get('content-type') ?? '';
      // The sidecar serves a PNG; anything else means the URL is wrong
      // (e.g. another app occupies the port).
      if (!res.ok || !ct.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return { data: buf.toString('base64'), contentType: ct };
    } catch {
      return null;
    }
  }

  /** Poll until the link completes and connect. */
  async waitForLink(): Promise<void> {
    this.state = 'qr';
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const accs = await this.accounts();
        if (accs.length > 0) {
          setKv('signal:enabled', '1');
          await this.connect();
          return;
        }
      } catch {
        /* sidecar not ready */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    this.state = 'idle';
    throw new Error('link timed out');
  }

  async configure(apiUrl: string): Promise<void> {
    setKv('signal:api_url', apiUrl.replace(/\/+$/, ''));
  }

  async connect(): Promise<void> {
    this.state = 'connecting';
    const accs = await this.accounts();
    if (!accs.length) throw new Error('no linked account on the signal sidecar');
    this.number = accs[0];
    this.accountId = `signal:${this.number}`;
    upsertAccount({ id: this.accountId, provider: 'signal', label: this.number });
    setAccountStatus(this.accountId, 'active');
    this.state = 'open';
    broadcast({ type: 'accounts', data: listAccounts() });
    console.log(`[signal] connected as ${this.number}`);
    void this.syncContacts().then(() => this.syncGroups());
    this.connectWs();
  }

  /** Map uuid→number and capture contact display names from the sidecar.
   *  Signal's number privacy means many contacts arrive as bare UUIDs — the
   *  sidecar's contact book still knows who they are (nickname > name >
   *  profile name), so mirror that into the names table. */
  private uuidToNumber = new Map<string, string>();
  private lastContactSync = 0;
  private healthTimer: NodeJS.Timeout | null = null;

  /** Group names + members from the sidecar. Messages often carry no
   *  groupInfo.name, so chats created from them end up untitled (and before
   *  the fix, named after whoever spoke). The sidecar is authoritative. */
  private async syncGroups(): Promise<void> {
    if (!this.number || !this.accountId) return;
    try {
      const res = await fetch(`${this.base}/v1/groups/${encodeURIComponent(this.number)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return;
      const groups = (await res.json()) as {
        id?: string;
        internal_id?: string;
        name?: string;
        members?: string[];
      }[];
      let fixed = 0;
      for (const g of groups) {
        if (!g.name) continue;
        const keys = [g.id, g.internal_id ? `group.${g.internal_id}` : null].filter(Boolean) as string[];
        for (const key of keys) {
          const chatId = `${this.accountId}:${key}`;
          const existing = getChat(chatId);
          if (!existing) continue;
          // Blank title, or a title/contactRaw that is actually a person's
          // name (the old ingest bug) — heal both.
          if (!existing.title || existing.contactRaw !== g.name) {
            getOrCreateChat(this.accountId, key, {
              type: 'group',
              title: g.name,
              contactRaw: g.name,
            });
            fixed++;
          }
          if (g.members?.length) {
            replaceChatParticipants(
              chatId,
              g.members
                .map((m) => ({ id: m, name: getName(m) ?? getName(this.uuidToNumber.get(m) ?? '') ?? '' }))
            );
          }
        }
      }
      if (fixed) {
        broadcast({ type: 'chats-updated' });
        console.log(`[signal] group sync: titled ${fixed} chats`);
      }
    } catch (e) {
      console.error('[signal] group sync failed:', (e as Error).message);
    }
  }

  private async syncContacts(): Promise<void> {
    if (!this.number) return;
    try {
      const res = await fetch(
        `${this.base}/v1/contacts/${encodeURIComponent(this.number)}`,
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!res.ok) return;
      const contacts = (await res.json()) as Array<{
        number?: string;
        uuid?: string;
        name?: string;
        nickname?: { name?: string; given_name?: string; family_name?: string };
        profile?: { given_name?: string; lastname?: string };
      }>;
      for (const c of contacts) {
        const nick = [c.nickname?.name, [c.nickname?.given_name, c.nickname?.family_name].filter(Boolean).join(' ')]
          .find((s) => s && s.trim());
        const prof = [c.profile?.given_name, c.profile?.lastname].filter(Boolean).join(' ').trim();
        const best = (nick || c.name || prof || '').trim();
        if (c.uuid && c.number) this.uuidToNumber.set(c.uuid, c.number);
        if (c.uuid && best) setName(c.uuid, best);
        if (c.number && best) setName(c.number, best);
      }
      this.lastContactSync = Date.now();
      console.log(`[signal] synced ${contacts.length} contacts`);
    } catch (e) {
      console.error('[signal] contact sync failed:', (e as Error).message);
    }
  }

  async disconnect(): Promise<void> {
    this.stop();
    setKv('signal:enabled', '');
    this.state = 'idle';
    // Unconditional: this.accountId may already be null when disconnect is
    // called from an error/idle state — the DB row is the source of truth.
    setProviderAccountsStatus('signal', 'disconnected');
    this.accountId = null;
    broadcast({ type: 'accounts', data: listAccounts() });
  }

  // ---------- websocket (receive) ----------

  private connectWs(): void {
    if (!this.number) return;
    // Receiving is a WebSocket at /v1/receive/{number} (the /api/v1/events
    // path from older docs doesn't exist on this sidecar version).
    const wsUrl = `${this.base.replace(/^http/, 'ws')}/v1/receive/${encodeURIComponent(this.number)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    this.stopped = false;

    ws.onmessage = (ev) => {
      try {
        const env = JSON.parse(String(ev.data)) as { envelope?: SignalEnvelope };
        if (env.envelope) void this.onEnvelope(env.envelope);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.stopped && this.state === 'open') {
        this.reconnectTimer = setTimeout(() => this.connectWs(), 5000);
      }
    };
    ws.onerror = () => ws.close();
  }

  private async onEnvelope(env: SignalEnvelope): Promise<void> {
    if (!this.accountId) return;
    try {
      if (env.typingMessage) {
        if (env.typingMessage.action === 'STARTED' && env.sourceNumber) {
          broadcastTyping(`${this.accountId}:${env.sourceNumber}`, env.sourceName ?? null);
        }
        return;
      }
      // Read/delivery receipts for our outgoing messages. signal-cli reports
      // isRead/isDelivery booleans (type is unreliable/absent).
      if (env.receiptMessage?.timestamps?.length) {
        const status = env.receiptMessage.isRead
          ? 'read'
          : env.receiptMessage.isDelivery
            ? 'delivered'
            : null;
        if (!status) return;
        const source = env.sourceNumber ?? env.source ?? '';
        for (const ts of env.receiptMessage.timestamps) {
          const id = `${this.accountId}:${source}:${ts}`;
          if (updateMessageReceipt(id, status)) {
            const updated = getMessage(id);
            if (updated) broadcast({ type: 'message-updated', data: updated });
          }
        }
        return;
      }
      // Device-sync echo of messages sent from the phone / other devices.
      if (env.syncMessage?.sentMessage) {
        await this.onDataMessage(env.syncMessage.sentMessage, env, {
          outgoing: true,
          destination: env.syncMessage.sentMessage.destinationNumber ?? env.syncMessage.sentMessage.destination,
        });
        return;
      }
      if (env.dataMessage) {
        await this.onDataMessage(env.dataMessage, env, { outgoing: false });
      }
    } catch (e) {
      console.error('[signal] envelope failed:', (e as Error).message);
    }
  }

  private async onDataMessage(
    dm: SignalDataMessage,
    env: SignalEnvelope,
    opts: { outgoing: boolean; destination?: string }
  ): Promise<void> {
    if (!this.accountId) return;
    let source = env.sourceNumber ?? env.source ?? '';
    // Number-privacy contacts arrive as bare UUIDs. Prefer the phone number
    // when the contact book knows it (merges into the phone-keyed chat);
    // otherwise refresh the contact book in the background to learn the name.
    if (!env.sourceNumber && source.includes('-')) {
      const mapped = this.uuidToNumber.get(source);
      if (mapped) source = mapped;
      else if (Date.now() - this.lastContactSync > 10 * 60_000) void this.syncContacts();
    }
      const groupId = dm.groupInfo?.groupId;
      const chatRemoteId = groupId ? `group.${groupId}` : (opts.destination ?? source);
      const baseId = `${chatRemoteId}:${dm.timestamp}`;
      if (!chatRemoteId) return;

      // Our own send echoes also arrive via syncMessage — suppress dupes.
      if (opts.outgoing && dm.timestamp && !dm.reaction && !dm.editMessage && !dm.remoteDelete) {
        if (isRecentOutgoing(`${this.accountId}:${chatRemoteId}`, dm.message ?? '', dm.timestamp)) {
          return;
        }
      }

      // Resolve a protocol target (delete/edit) by its sent timestamp. The
      // envelope's chat id form (sync of an own phone action carries the
      // destination in a different encoding than we stored, and may omit
      // groupInfo) doesn't always match, so fall back to a suffix lookup.
      const resolveTarget = (ts: number): string | null => {
        const direct = `${this.accountId}:${chatRemoteId}:${ts}`;
        if (getMessage(direct)) return direct;
        const hit = findMessageIdsBySuffix(this.accountId!, String(ts))[0];
        return hit ? hit.id : null;
      };

      // Delete-for-everyone.
      if (dm.remoteDelete?.timestamp) {
        const targetId = resolveTarget(dm.remoteDelete.timestamp);
        console.log(
          `[signal] remoteDelete ts=${dm.remoteDelete.timestamp} chat=${chatRemoteId} → ${targetId ?? 'NOT FOUND'}`
        );
        if (targetId) {
          markMessageDeleted(targetId);
          const updated = getMessage(targetId);
          if (updated) broadcast({ type: 'message-updated', data: updated });
          broadcast({ type: 'chats-updated' });
        }
        return;
      }

      // Edit.
      if (dm.editMessage?.targetSentTimestamp && dm.editMessage.dataMessage) {
        const id = resolveTarget(dm.editMessage.targetSentTimestamp);
        if (!id) return;
        updateMessageBody(id, dm.editMessage.dataMessage.message ?? '');
        const updated = getMessage(id);
        if (updated) {
          updated.reactions = getReactionsForMessage(id);
          broadcast({ type: 'message-updated', data: updated });
        }
        return;
      }

      // Reaction.
      if (dm.reaction?.emoji !== undefined && dm.reaction.targetSentTimestamp) {
        const targetId = resolveTarget(dm.reaction.targetSentTimestamp);
        if (!targetId) return;
        const from = env.sourceNumber ?? source;
        // Capture the reactor's profile name (keyed by both uuid and phone) so
        // the reaction tooltip can show it — people who only react never pass
        // through the message-ingest name capture.
        if (env.sourceName && from !== 'me') {
          setName(from, env.sourceName);
          if (env.source && env.source !== from) setName(env.source, env.sourceName);
        }
        if (dm.reaction.isRemove || !dm.reaction.emoji) {
          removeReactions(targetId, from);
        } else {
          addReaction({
            id: `${targetId}:${from}`,
            messageId: targetId,
            chatId: getMessage(targetId)?.chatId ?? `${this.accountId}:${chatRemoteId}`,
            emoji: dm.reaction.emoji,
            fromSender: from,
            ts: dm.timestamp,
          });
        }
        const updated = getMessage(targetId);
        if (updated) {
          updated.reactions = getReactionsForMessage(targetId);
          broadcast({ type: 'message-updated', data: updated });
        }
        return;
      }

      // Plain message.
      const text = dm.message ?? '';
      let media;
      if (dm.attachments?.length) {
        const refs = [];
        for (const a of dm.attachments) {
          if (!a.contentType?.startsWith('image/')) continue;
          try {
            const res = await fetch(`${this.base}/v1/attachments/${a.id}`, {
              signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            refs.push(saveMediaBuffer(buf, a.contentType, baseId + a.id, a.filename ?? undefined));
          } catch {
            /* skip failed downloads */
          }
        }
        if (refs.length) media = refs;
      }
      if (!text && !media) return;

      // Sender must be an IDENTIFIER (phone, else uuid) — reactions send it as
      // target_author and Signal rejects names. Display name → names table.
      const senderId = env.sourceNumber ?? source;
      if (!opts.outgoing && env.sourceName) setName(senderId, env.sourceName);

      await ingest(
        {
          id: baseId,
          accountId: this.accountId,
          chatRemoteId,
          chatType: groupId ? 'group' : 'dm',
          chatTitle: dm.groupInfo?.name,
          // Groups: the sender's name must never become the chat's name —
          // use the group name, else the id ("Council-2026", not "Gertrud").
          contactRaw: groupId
            ? (dm.groupInfo?.name ?? chatRemoteId)
            : opts.outgoing
              ? (opts.destination ?? '')
              : (env.sourceName ?? source),
          // Phone/uuid as sender id (reactions + reply-privately resolution).
          sender: groupId ? senderId : undefined,
          ts: dm.timestamp || Date.now(),
          outgoing: opts.outgoing,
          body: text,
          media,
          quotedRemoteId: dm.quote?.id ? `${chatRemoteId}:${dm.quote.id}` : undefined,
        },
        opts.outgoing ? 'send' : 'poll'
      );
  }

  // ---------- outbound ----------

  /** Group members for @mention autocomplete. */
  async fetchParticipants(chat: Chat): Promise<{ id: string; name: string }[] | null> {
    if (!this.number || this.state !== 'open' || chat.type !== 'group') return null;
    try {
      const res = await fetch(`${this.base}/v1/groups/${encodeURIComponent(this.number)}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const groups = (await res.json()) as { id?: string; members?: string[] }[];
      const groupId = chat.remoteId.replace(/^group\./, '');
      const g = groups.find((x) => x.id === groupId);
      return (g?.members ?? []).map((m) => ({ id: m, name: getName(m) ?? m }));
    } catch {
      return null;
    }
  }

  /** Fetch the contact's avatar via the sidecar profile endpoint. */
  async fetchAvatar(chat: Chat): Promise<{ data: Buffer; contentType: string } | null> {
    if (!this.number || this.state !== 'open' || chat.type !== 'dm') return null;
    try {
      const res = await fetch(
        `${this.base}/v1/profiles/${encodeURIComponent(this.number)}/${encodeURIComponent(chat.remoteId)}/avatar`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) return null;
      return {
        data: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg',
      };
    } catch {
      return null;
    }
  }

  /** Identifier the sidecar resolves for a chat. We store groups as
   *  'group.<internal_id>' where internal_id is already base64; the sidecar
   *  wants that internal_id string base64-encoded ONCE MORE ('group.' +
   *  base64(internal_id) — exactly its own /v1/groups `id` field). Groups
   *  whose internal_id contains '/', '+' or '=' (Phoenix) resolve under no
   *  other form; clean ids happened to pass with the raw form. */
  private static sidecarId(chat: Chat): string {
    const m = /^group\.(.+)$/.exec(chat.remoteId);
    if (!m) return chat.remoteId; // dm: '+1555...'
    return `group.${Buffer.from(m[1], 'utf-8').toString('base64')}`;
  }

  /** signal-cli recipients format for a chat remoteId. */
  private static recipientsFor(chat: Chat): string[] {
    return [SignalProvider.sidecarId(chat)];
  }

  private async postSend(body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.base}/v2/send`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`signal /v2/send: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
  }

  async send(chat: Chat, payload: SendPayload): Promise<SendResult> {
    if (!this.number || !this.accountId || this.state !== 'open') {
      throw new Error('signal not connected');
    }
    const ts = Date.now();
    const body: Record<string, unknown> = {
      message: payload.body,
      number: this.number,
      recipients: SignalProvider.recipientsFor(chat),
    };

    // Quote: signal wants { author, id (target timestamp), text }.
    if (payload.quotedId) {
      const target = getMessage(payload.quotedId);
      if (target) {
        const targetTs = Number(target.id.slice(`${this.accountId}:`.length).split(':').pop());
        body.quote = {
          author: target.outgoing === 1 ? this.number : (target.sender ?? chat.remoteId),
          id: targetTs,
          text: target.body,
        };
      }
    }

    const m = payload.media?.[0];
    if (m) body.base64_attachments = [`data:${m.contentType};base64,${m.data}`];

    // Signal mentions: {author, start, length} ranges into the message text.
    const mentions: { author: string; start: number; length: number }[] = [];
    for (const mention of payload.mentions ?? []) {
      const start = payload.body.indexOf(`@${mention.name}`);
      if (start >= 0) {
        mentions.push({ author: mention.memberId, start, length: mention.name.length + 1 });
      }
    }
    if (mentions.length) body.mentions = mentions;

    await this.postSend(body);

    const localId = `${chat.remoteId}:${ts}`;
    await ingest(
      {
        id: localId,
        accountId: this.accountId,
        chatRemoteId: chat.remoteId,
        chatType: chat.type,
        ts,
        outgoing: true,
        body: payload.body,
        media: m ? [saveUploadedMedia(Buffer.from(m.data, 'base64'), m.contentType, m.name)] : undefined,
        quotedRemoteId: payload.quotedId
          ? payload.quotedId.slice(`${this.accountId}:`.length)
          : undefined,
        forwardedFrom: payload.forwardedFrom,
      },
      'send'
    );
    return { id: localId };
  }

  async react(chat: Chat, target: Message, emoji: string): Promise<void> {
    if (!this.number || !this.accountId || this.state !== 'open') {
      throw new Error('signal not connected');
    }
    const targetTs = Number(target.id.slice(`${this.accountId}:`.length).split(':').pop());
    // Removal on this sidecar build: the same emoji with remove:true (an
    // empty reaction string is rejected as "reaction missing").
    const removing = emoji === '';
    const existing = removing
      ? (getReactionsForMessage(target.id) ?? []).find((r) => r.from === 'me')?.emoji
      : null;
    if (removing && !existing) return; // nothing to remove
    const res = await fetch(`${this.base}/v1/reactions/${encodeURIComponent(this.number)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reaction: removing ? existing : emoji,
        ...(removing ? { remove: true } : {}),
        recipient: SignalProvider.sidecarId(chat),
        target_author: target.outgoing === 1 ? this.number : (target.sender ?? chat.remoteId),
        timestamp: targetTs,
      }),
    });
    if (!res.ok) throw new Error(`signal reactions: HTTP ${res.status}`);
    if (removing) {
      removeReactions(target.id, 'me');
      const updatedR = getMessage(target.id);
      if (updatedR) {
        updatedR.reactions = getReactionsForMessage(target.id);
        broadcast({ type: 'message-updated', data: updatedR });
      }
      return;
    }
    addReaction({
      id: `${target.id}:me`,
      messageId: target.id,
      chatId: chat.id,
      emoji,
      fromSender: 'me',
      ts: Date.now(),
    });
    const updated = getMessage(target.id);
    if (updated) {
      updated.reactions = getReactionsForMessage(target.id);
      broadcast({ type: 'message-updated', data: updated });
    }
  }

  /** Tell the chat we're typing. */
  async sendTyping(chat: Chat): Promise<void> {
    if (!this.number || this.state !== 'open') return;
    try {
      await fetch(`${this.base}/v1/typing/${encodeURIComponent(this.number)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: SignalProvider.sidecarId(chat), action: 'start' }),
      });
    } catch {
      /* non-fatal */
    }
  }
}

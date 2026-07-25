import { getKv, setKv } from '../../store/db.js';
import {
  addReaction,
  getMessage,
  getReactionsForMessage,
  isRecentOutgoing,
  markMessageDeleted,
  removeReactions,
  setAccountStatus,
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
  receiptMessage?: { type?: string; timestamps?: number[] };
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
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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
    this.connectWs();
  }

  async disconnect(): Promise<void> {
    this.stop();
    setKv('signal:enabled', '');
    this.state = 'idle';
    this.accountId = null;
    if (this.accountId) setAccountStatus(this.accountId, 'disconnected');
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
      // Read/delivery receipts for our outgoing messages.
      if (env.receiptMessage?.timestamps?.length) {
        const status = env.receiptMessage.type === 'READ' ? 'read' : 'delivered';
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
    const source = env.sourceNumber ?? env.source ?? '';
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

      // Delete-for-everyone.
      if (dm.remoteDelete?.timestamp) {
        markMessageDeleted(`${this.accountId}:${chatRemoteId}:${dm.remoteDelete.timestamp}`);
        const updated = getMessage(`${this.accountId}:${chatRemoteId}:${dm.remoteDelete.timestamp}`);
        if (updated) broadcast({ type: 'message-updated', data: updated });
        broadcast({ type: 'chats-updated' });
        return;
      }

      // Edit.
      if (dm.editMessage?.targetSentTimestamp && dm.editMessage.dataMessage) {
        const id = `${this.accountId}:${chatRemoteId}:${dm.editMessage.targetSentTimestamp}`;
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
        const targetId = `${this.accountId}:${chatRemoteId}:${dm.reaction.targetSentTimestamp}`;
        const from = env.sourceNumber ?? source;
        if (dm.reaction.isRemove || !dm.reaction.emoji) {
          removeReactions(targetId, from);
        } else {
          addReaction({
            id: `${targetId}:${from}`,
            messageId: targetId,
            chatId: `${this.accountId}:${chatRemoteId}`,
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
            refs.push(saveMediaBuffer(buf, a.contentType, baseId + a.id));
          } catch {
            /* skip failed downloads */
          }
        }
        if (refs.length) media = refs;
      }
      if (!text && !media) return;

      await ingest(
        {
          id: baseId,
          accountId: this.accountId,
          chatRemoteId,
          chatType: groupId ? 'group' : 'dm',
          chatTitle: dm.groupInfo?.name,
          contactRaw: opts.outgoing ? (opts.destination ?? '') : (env.sourceName ?? source),
          sender: groupId ? (env.sourceName ?? source) : undefined,
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

  /** signal-cli recipients format for a chat remoteId. */
  private static recipientsFor(chat: Chat): string[] {
    return [chat.remoteId]; // dm: '+1555...', group: 'group.<base64>'
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
        media: m ? [saveUploadedMedia(Buffer.from(m.data, 'base64'), m.contentType)] : undefined,
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
    const res = await fetch(`${this.base}/v1/reactions/${encodeURIComponent(this.number)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reaction: emoji,
        recipient: chat.remoteId,
        target_author: target.outgoing === 1 ? this.number : (target.sender ?? chat.remoteId),
        timestamp: targetTs,
      }),
    });
    if (!res.ok) throw new Error(`signal reactions: HTTP ${res.status}`);
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
        body: JSON.stringify({ recipient: chat.remoteId, action: 'start' }),
      });
    } catch {
      /* non-fatal */
    }
  }
}

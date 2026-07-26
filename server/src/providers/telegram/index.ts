import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, Raw } from 'telegram/events';
import type { Entity } from 'telegram/define';
import { getKv, setKv, getDb } from '../../store/db.js';
import {
  addReaction,
  clearReactions,
  findMessageIdsBySuffix,
  getMessage,
  getName,
  getOldestMessage,
  getOrCreateChat,
  getReactionsForMessage,
  markMessageDeleted,
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

export type TgState =
  | 'idle'
  | 'needs-api'
  | 'awaiting-phone'
  | 'awaiting-code'
  | 'awaiting-password'
  | 'connecting'
  | 'open'
  | 'error';

/**
 * Telegram provider via GramJS (MTProto user account). Requires an api_id /
 * api_hash pair from https://my.telegram.org (entered once in the Accounts
 * dialog), then phone → code → optional 2FA password. The session string is
 * persisted in the kv table and reused on boot.
 */
export class TelegramProvider implements Provider {
  id = 'telegram';
  capabilities = {
    reply: true,
    react: true,
    forward: true, // native forward via messages.forwardMessages
    edit: true,
    delete: true,
    groups: true,
    attachments: true,
    crossChatQuotes: false,
  };

  private client: TelegramClient | null = null;
  private state: TgState = 'idle';
  private accountId: string | null = null; // 'telegram:<user-id>'
  private pendingResolve: ((v: string) => void) | null = null;
  private entityCache = new Map<string, Entity>(); // remoteId ('user:123') -> entity
  private nameCache = new Map<string, string>(); // user id -> display name
  private handlersAttached = false;

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    const apiId = Number(getKv('telegram:api_id') ?? 0);
    const apiHash = getKv('telegram:api_hash') ?? '';
    const session = getKv('telegram:session') ?? '';
    if (!apiId || !apiHash) {
      this.state = 'needs-api';
      console.log('[telegram] no api credentials — configure via the Accounts dialog');
      return;
    }
    if (!session) {
      this.state = 'idle';
      console.log('[telegram] no session — sign in via the Accounts dialog');
      return;
    }
    try {
      await this.resume(apiId, apiHash, session);
    } catch (e) {
      this.state = 'error';
      console.error('[telegram] resume failed:', (e as Error).message);
    }
  }

  stop(): void {
    void this.client?.disconnect();
    this.client = null;
  }

  status(): string {
    return this.state;
  }

  getPublicState(): { state: TgState; accountId: string | null; hasApiCreds: boolean } {
    return {
      state: this.state,
      accountId: this.accountId,
      hasApiCreds: Boolean(getKv('telegram:api_id')),
    };
  }

  setCredentials(apiId: number, apiHash: string): void {
    setKv('telegram:api_id', String(apiId));
    setKv('telegram:api_hash', apiHash);
    if (this.state === 'needs-api') this.state = 'idle';
  }

  /** Resume an existing session string. */
  private async resume(apiId: number, apiHash: string, session: string): Promise<void> {
    this.state = 'connecting';
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 5,
    });
    this.client = client;
    await client.connect();
    if (!(await client.isUserAuthorized())) {
      this.state = 'idle';
      return; // session expired — user must sign in again
    }
    await this.onAuthorized(client);
  }

  /**
   * Full sign-in flow, driven from the web UI: each GramJS callback parks on a
   * promise that the /credential endpoint resolves.
   */
  async connect(): Promise<void> {
    if (this.client && this.state === 'open') return;
    const apiId = Number(getKv('telegram:api_id') ?? 0);
    const apiHash = getKv('telegram:api_hash') ?? '';
    if (!apiId || !apiHash) {
      this.state = 'needs-api';
      throw new Error('api_id/api_hash not configured');
    }
    this.state = 'connecting';
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 5,
    });
    this.client = client;
    try {
      await client.start({
        phoneNumber: () => this.waitForCredential('awaiting-phone'),
        phoneCode: () => this.waitForCredential('awaiting-code'),
        password: () => this.waitForCredential('awaiting-password'),
        onError: (err) => console.error('[telegram] auth error:', err.message),
      });
      setKv('telegram:session', (client.session as StringSession).save());
      await this.onAuthorized(client);
    } catch (e) {
      this.state = 'error';
      throw e;
    }
  }

  /** Called by the API when the user submits the value the flow is waiting for. */
  provideCredential(value: string): void {
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    if (resolve) resolve(value);
  }

  private waitForCredential(state: TgState): Promise<string> {
    this.state = state;
    return new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve;
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          reject(new Error('login timed out'));
        }
      }, 5 * 60_000);
    });
  }

  private async onAuthorized(client: TelegramClient): Promise<void> {
    const me = (await client.getMe()) as Api.User;
    this.accountId = `telegram:${me.id}`;
    const name = displayName(me);
    upsertAccount({
      id: this.accountId,
      provider: 'telegram',
      label: me.username ? `${name} (@${me.username})` : name,
    });
    setAccountStatus(this.accountId, 'active');
    this.state = 'open';
    broadcast({ type: 'accounts', data: listAccounts() });
    console.log(`[telegram] signed in as ${name}`);
    this.attachHandlers(client);
    void this.syncDialogsAndHistory();
  }

  async logout(): Promise<void> {
    try {
      if (this.client) {
        await this.client.invoke(new Api.auth.LogOut());
        await this.client.disconnect();
      }
    } catch {
      /* best effort */
    }
    this.client = null;
    this.state = 'idle';
    setProviderAccountsStatus('telegram', 'disconnected');
    this.accountId = null;
    this.entityCache.clear();
    setKv('telegram:session', '');
    broadcast({ type: 'accounts', data: listAccounts() });
  }

  // ---------- dialogs & history ----------

  private async syncDialogsAndHistory(): Promise<void> {
    if (!this.client || !this.accountId) return;
    try {
      const dialogs = await this.client.getDialogs({ limit: 100 });
      for (const d of dialogs) {
        const e = d.entity;
        if (!e) continue;
        const chat = this.chatFromEntity(e);
        if (chat) {
          getOrCreateChat(this.accountId, chat.remoteId, {
            type: chat.type,
            title: chat.title,
            contactRaw: chat.contactRaw,
          });
        }
      }
      broadcast({ type: 'chats-updated' });
      console.log(`[telegram] synced ${dialogs.length} dialogs`);

      // One-time recent-history fetch (real-time updates cover the rest).
      if (!getKv('telegram:history_synced')) {
        setKv('telegram:history_synced', '1');
        let n = 0;
        for (const d of dialogs.slice(0, 30)) {
          if (!d.entity) continue;
          try {
            for await (const msg of this.client.iterMessages(d.entity, { limit: 100 })) {
              if (await this.ingestTgMessage(msg, { downloadMedia: false, notify: false })) n++;
            }
          } catch {
            /* skip dialogs we can't read */
          }
        }
        console.log(`[telegram] history: ${n} messages ingested`);
        broadcast({ type: 'chats-updated' });
      }
    } catch (e) {
      console.error('[telegram] dialog sync failed:', (e as Error).message);
    }
  }

  /** Map a Telegram entity to our chat addressing. */
  private chatFromEntity(e: Entity): { remoteId: string; type: 'dm' | 'group'; title: string; contactRaw: string } | null {
    if (e instanceof Api.User) {
      if (e.id.toString() === '777000' || e.self) return null;
      const name = displayName(e);
      this.entityCache.set(`user:${e.id}`, e);
      this.nameCache.set(String(e.id), name);
      setName(String(e.id), name);
      return {
        remoteId: `user:${e.id}`,
        type: 'dm',
        title: name,
        contactRaw: e.username ? `@${e.username}` : name,
      };
    }
    if (e instanceof Api.Chat) {
      this.entityCache.set(`chat:${e.id}`, e);
      return { remoteId: `chat:${e.id}`, type: 'group', title: e.title ?? 'Group', contactRaw: e.title ?? 'Group' };
    }
    if (e instanceof Api.Channel) {
      this.entityCache.set(`channel:${e.id}`, e);
      const title = e.title ?? 'Channel';
      return { remoteId: `channel:${e.id}`, type: 'group', title, contactRaw: title };
    }
    return null;
  }

  private async peerFor(remoteId: string): Promise<Entity> {
    const cached = this.entityCache.get(remoteId);
    if (cached) return cached;
    // Rebuild the cache once (entity access hashes don't survive restarts).
    if (this.client) {
      const dialogs = await this.client.getDialogs({ limit: 100 });
      for (const d of dialogs) if (d.entity) this.chatFromEntity(d.entity);
      const found = this.entityCache.get(remoteId);
      if (found) return found;
    }
    throw new Error(`telegram: no entity for ${remoteId}`);
  }

  // ---------- realtime events ----------

  private attachHandlers(client: TelegramClient): void {
    if (this.handlersAttached) return;
    this.handlersAttached = true;

    client.addEventHandler(
      (ev) => void this.ingestTgMessage(ev.message, { downloadMedia: true, notify: true }),
      new NewMessage({})
    );

    client.addEventHandler(
      (update) => void this.onRawUpdate(update),
      new Raw({
        types: [
          Api.UpdateEditMessage,
          Api.UpdateEditChannelMessage,
          Api.UpdateDeleteMessages,
          Api.UpdateDeleteChannelMessages,
          Api.UpdateMessageReactions,
          Api.UpdateUserTyping,
          Api.UpdateChatUserTyping,
          Api.UpdateChannelUserTyping,
          Api.UpdateReadHistoryOutbox,
        ],
      })
    );
  }

  private async onRawUpdate(update: Api.TypeUpdate): Promise<void> {
    if (!this.accountId) return;
    try {
      if (update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage) {
        const msg = update.message;
        if (msg instanceof Api.Message) {
          const chatRemoteId = peerKey(msg.peerId);
          const id = `${this.accountId}:${chatRemoteId}:${msg.id}`;
          if (typeof msg.message === 'string') {
            updateMessageBody(id, msg.message);
            const updated = getMessage(id);
            if (updated) {
              updated.reactions = getReactionsForMessage(id);
              broadcast({ type: 'message-updated', data: updated });
            }
          }
        }
        return;
      }
      if (update instanceof Api.UpdateDeleteMessages) {
        for (const msgId of update.messages) this.deleteBySuffix(String(msgId));
        return;
      }
      if (update instanceof Api.UpdateDeleteChannelMessages) {
        for (const msgId of update.messages) {
          this.deleteBySuffix(`channel:${update.channelId}:${msgId}`);
        }
        return;
      }
      if (update instanceof Api.UpdateReadHistoryOutbox) {
        // The peer read our outgoing messages up to maxId.
        const chatRemoteId = peerKey(update.peer);
        const chatId = `${this.accountId}:${chatRemoteId}`;
        const rows = getDb()
          .prepare("SELECT id FROM messages WHERE chat_id = ? AND outgoing = 1 AND receipt != 'read'")
          .all(chatId) as { id: string }[];
        const maxId = Number(update.maxId);
        for (const row of rows) {
          const msgId = Number(row.id.split(':').pop());
          if (msgId && msgId <= maxId && updateMessageReceipt(row.id, 'read')) {
            const updated = getMessage(row.id);
            if (updated) broadcast({ type: 'message-updated', data: updated });
          }
        }
        return;
      }
      if (update instanceof Api.UpdateUserTyping || update instanceof Api.UpdateChatUserTyping || update instanceof Api.UpdateChannelUserTyping) {
        this.onTyping(update);
        return;
      }
      if (update instanceof Api.UpdateMessageReactions) {
        const chatRemoteId = peerKey(update.peer);
        const id = `${this.accountId}:${chatRemoteId}:${update.msgId}`;
        clearReactions(id);
        let i = 0;
        for (const r of update.reactions?.results ?? []) {
          const emoji = r.reaction instanceof Api.ReactionEmoji ? r.reaction.emoticon : null;
          if (!emoji) continue;
          addReaction({
            id: `${id}:push:${i++}`,
            messageId: id,
            chatId: `${this.accountId}:${chatRemoteId}`,
            emoji,
            fromSender: r.chosenOrder !== undefined ? 'me' : 'others',
            ts: Date.now(),
          });
        }
        const updated = getMessage(id);
        if (updated) {
          updated.reactions = getReactionsForMessage(id);
          broadcast({ type: 'message-updated', data: updated });
        }
      }
    } catch (e) {
      console.error('[telegram] update handling failed:', (e as Error).message);
    }
  }

  /** Typing indicators from contacts (typing/recording only, not uploads). */
  private onTyping(update: Api.UpdateUserTyping | Api.UpdateChatUserTyping | Api.UpdateChannelUserTyping): void {
    if (!this.accountId) return;
    const action = update.action;
    const active =
      action instanceof Api.SendMessageTypingAction ||
      action instanceof Api.SendMessageRecordAudioAction;
    if (!active) return;

    let chatRemoteId: string;
    let userId: string | null = null;
    if (update instanceof Api.UpdateUserTyping) {
      userId = String(update.userId);
      chatRemoteId = `user:${update.userId}`;
    } else if (update instanceof Api.UpdateChatUserTyping) {
      userId = String(update.fromId && 'userId' in update.fromId ? update.fromId.userId : '');
      chatRemoteId = `chat:${update.chatId}`;
    } else {
      userId = String(update.fromId && 'userId' in update.fromId ? update.fromId.userId : '');
      chatRemoteId = `channel:${update.channelId}`;
    }
    const name = userId ? (this.nameCache.get(userId) ?? getName(userId)) : null;
    broadcastTyping(`${this.accountId}:${chatRemoteId}`, name);
  }

  private deleteBySuffix(suffix: string): void {
    if (!this.accountId) return;
    for (const row of findMessageIdsBySuffix(this.accountId, suffix)) {
      markMessageDeleted(row.id);
      const updated = getMessage(row.id);
      if (updated) broadcast({ type: 'message-updated', data: updated });
    }
    broadcast({ type: 'chats-updated' });
  }

  // ---------- inbound normalization ----------

  private async ingestTgMessage(
    msg: Api.Message,
    opts: { downloadMedia: boolean; notify: boolean }
  ): Promise<boolean> {
    if (!this.accountId || !this.client) return false;
    if (!(msg instanceof Api.Message)) return false;
    if (msg.action) return false; // service messages (joins, title changes, …)

    const chatRemoteId = peerKey(msg.peerId);
    if (!chatRemoteId) return false;
    const isGroup = !chatRemoteId.startsWith('user:');
    const text = msg.message ?? '';

    // Media: photos and image documents only (videos/files are skipped for now).
    let media;
    const hasImage = Boolean(msg.photo) || Boolean(msg.document && isImageDocument(msg.document));
    if (hasImage && opts.downloadMedia) {
      try {
        const buf = await this.client.downloadMedia(msg, {});
        if (buf && typeof buf !== 'string') {
          const mime = msg.document?.mimeType ?? 'image/jpeg';
          media = [saveMediaBuffer(buf as Buffer, mime, `${chatRemoteId}:${msg.id}`)];
        }
      } catch (e) {
        console.error('[telegram] media download failed:', (e as Error).message);
      }
    }
    if (!text && !hasImage) return false;

    // Group sender: store the user id (resolvable to a DM for reply-privately);
    // the display name is hydrated from the names table at query time.
    let sender: string | undefined;
    if (isGroup && !msg.out) {
      const fromId = msg.fromId && 'userId' in msg.fromId ? String(msg.fromId.userId) : '';
      if (fromId) sender = `user:${fromId}`;
    }

    const stored = await ingest(
      {
        id: `${chatRemoteId}:${msg.id}`,
        accountId: this.accountId,
        chatRemoteId,
        chatType: isGroup ? 'group' : 'dm',
        contactRaw: chatRemoteId,
        sender,
        ts: Number(msg.date) * 1000 || Date.now(),
        outgoing: Boolean(msg.out),
        body: text,
        media,
        quotedRemoteId: msg.replyTo?.replyToMsgId
          ? `${chatRemoteId}:${msg.replyTo.replyToMsgId}`
          : undefined,
      },
      'poll',
      opts.notify
    );

    // Capture any reactions already present on the message.
    if (stored && msg.reactions?.results) {
      let i = 0;
      for (const r of msg.reactions.results) {
        const emoji = r.reaction instanceof Api.ReactionEmoji ? r.reaction.emoticon : null;
        if (!emoji) continue;
        addReaction({
          id: `${this.accountId}:${chatRemoteId}:${msg.id}:snap:${i++}`,
          messageId: `${this.accountId}:${chatRemoteId}:${msg.id}`,
          chatId: `${this.accountId}:${chatRemoteId}`,
          emoji,
          fromSender: r.chosenOrder !== undefined ? 'me' : 'others',
          ts: Number(msg.date) * 1000,
        });
      }
    }
    return stored;
  }

  // ---------- outbound ----------

  /** 'user:123:456' -> 456 (the per-chat message id). */
  private static msgIdOf(providerId: string): number {
    return Number(providerId.split(':').pop());
  }

  async send(chat: Chat, payload: SendPayload): Promise<SendResult> {
    if (!this.client || this.state !== 'open' || !this.accountId) {
      throw new Error('telegram not connected');
    }
    const peer = await this.peerFor(chat.remoteId);
    const replyTo = payload.quotedId
      ? TelegramProvider.msgIdOf(payload.quotedId.slice(`${this.accountId}:`.length))
      : undefined;

    let sent: Api.Message;
    const m = payload.media?.[0];
    if (m) {
      const buf = Buffer.from(m.data, 'base64');
      sent = (await this.client.sendFile(peer, {
        file: buf,
        caption: payload.body || undefined,
        replyTo,
      })) as Api.Message;
      await ingest(
        {
          id: `${chat.remoteId}:${sent.id}`,
          accountId: this.accountId,
          chatRemoteId: chat.remoteId,
          chatType: chat.type,
          ts: Date.now(),
          outgoing: true,
          body: payload.body,
          media: [saveUploadedMedia(buf, m.contentType)],
          quotedRemoteId: payload.quotedId
            ? payload.quotedId.slice(`${this.accountId}:`.length)
            : undefined,
          forwardedFrom: payload.forwardedFrom,
        },
        'send'
      );
    } else {
      sent = await this.client.sendMessage(peer, { message: payload.body, replyTo });
      await ingest(
        {
          id: `${chat.remoteId}:${sent.id}`,
          accountId: this.accountId,
          chatRemoteId: chat.remoteId,
          chatType: chat.type,
          ts: Date.now(),
          outgoing: true,
          body: payload.body,
          quotedRemoteId: payload.quotedId
            ? payload.quotedId.slice(`${this.accountId}:`.length)
            : undefined,
          forwardedFrom: payload.forwardedFrom,
        },
        'send'
      );
    }
    return { id: `${chat.remoteId}:${sent.id}` };
  }

  async react(chat: Chat, target: Message, emoji: string): Promise<void> {
    if (!this.client || this.state !== 'open' || !this.accountId) {
      throw new Error('telegram not connected');
    }
    const peer = await this.peerFor(chat.remoteId);
    const msgId = TelegramProvider.msgIdOf(target.id.slice(`${this.accountId}:`.length));
    await this.client.invoke(
      new Api.messages.SendReaction({
        peer,
        msgId,
        reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
      })
    );
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

  /** Native forward between two chats on this account. */
  async forward(sourceChat: Chat, message: Message, targetChat: Chat): Promise<SendResult> {
    if (!this.client || this.state !== 'open' || !this.accountId) {
      throw new Error('telegram not connected');
    }
    const fromPeer = await this.peerFor(sourceChat.remoteId);
    const toPeer = await this.peerFor(targetChat.remoteId);
    const msgId = TelegramProvider.msgIdOf(message.id.slice(`${this.accountId}:`.length));
    const result = (await this.client.forwardMessages(toPeer, {
      messages: [msgId],
      fromPeer,
    })) as Api.Message[];
    const fwd = result?.[0];
    return { id: fwd ? `${targetChat.remoteId}:${fwd.id}` : '' };
  }

  /** Tell the chat we're typing. */
  async sendTyping(chat: Chat): Promise<void> {
    if (!this.client || this.state !== 'open') return;
    try {
      const peer = await this.peerFor(chat.remoteId);
      await this.client.invoke(
        new Api.messages.SetTyping({ peer, action: new Api.SendMessageTypingAction() })
      );
    } catch {
      /* non-fatal */
    }
  }

  /** Mark the whole dialog read on Telegram (clears unread on other devices). */
  async markRead(chat: Chat): Promise<void> {
    if (!this.client || this.state !== 'open') return;
    try {
      const peer = await this.peerFor(chat.remoteId);
      await this.client.invoke(
        new Api.messages.ReadHistory({ peer, maxId: 0 }) // 0 = everything read
      );
    } catch (e) {
      console.error('[telegram] markRead failed:', (e as Error).message);
    }
  }

  /** Fetch the next older page of a chat's history (scroll-back pagination). */
  async fetchOlder(chat: Chat, _beforeTs: number): Promise<number> {
    if (!this.client || this.state !== 'open' || !this.accountId) return 0;
    const oldest = getOldestMessage(chat.id);
    if (!oldest) return 0;
    const peer = await this.peerFor(chat.remoteId);
    const offsetId = TelegramProvider.msgIdOf(oldest.id.slice(`${this.accountId}:`.length));
    if (!offsetId) return 0;
    let n = 0;
    for await (const msg of this.client.iterMessages(peer, { limit: 100, offsetId })) {
      if (await this.ingestTgMessage(msg, { downloadMedia: false, notify: false })) n++;
    }
    return n;
  }
}

// ---------- helpers ----------

/** Stable chat addressing: 'user:<id>' | 'chat:<id>' | 'channel:<id>'. */
function peerKey(peer: Api.TypePeer | undefined): string {
  if (!peer) return '';
  if (peer instanceof Api.PeerUser) return `user:${peer.userId}`;
  if (peer instanceof Api.PeerChat) return `chat:${peer.chatId}`;
  if (peer instanceof Api.PeerChannel) return `channel:${peer.channelId}`;
  return '';
}

function displayName(u: Api.User): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return name || (u.username ? `@${u.username}` : `user ${u.id}`);
}

function isImageDocument(doc: Api.Document): boolean {
  return Boolean(doc.mimeType?.startsWith('image/'));
}

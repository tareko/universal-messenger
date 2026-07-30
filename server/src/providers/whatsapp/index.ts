import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  WAMessageStubType,
  type AnyMessageContent,
  type ConnectionState,
  type WASocket,
  type WAMessage,
  type WAMessageKey,
  type proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { projectRoot } from '../../config.js';
import type { Chat, Message } from '../../types.js';
import type { Provider, SendPayload, SendResult } from '../types.js';
import {
  addReaction,
  addReceiptReader,
  countReceiptReaders,
  getDb,
  getMessage,
  getMessages,
  getName,
  getOldestMessage,
  getChat,
  getOrCreateChat,
  getReactionsForMessage,
  getMediaPending,
  fillMediaPending,
  markMessageDeleted,
  mergeChats,
  recipientCount,
  removeReactions,
  replaceChatParticipants,
  rewriteBodyFragment,
  rewriteSender,
  setAccountStatus,
  setChatEphemeral,
  setChatTitleIfBlank,
  setName,
  setProviderAccountsStatus,
  updateMessageBody,
  updateMessageMedia,
  updateMessageReceipt,
  upsertAccount,
} from '../../store/db.js';
import { saveMediaBuffer, saveUploadedMedia } from '../../services/media.js';
import { ingest, ingestBatch } from '../../services/ingest.js';
import { broadcast, broadcastTyping } from '../../realtime/sse.js';
import { listAccounts } from '../registry.js';
import type { NormalizedMessage } from '../types.js';

const logger = pino({ level: 'warn' });
const sessionDir = resolve(projectRoot, 'data', 'sessions', 'whatsapp');
const HISTORY_PER_CHAT = 150;

export type WaState = 'idle' | 'connecting' | 'qr' | 'open' | 'close';

/**
 * WhatsApp provider via Baileys (WhatsApp Web multi-device protocol).
 * Unofficial: the account is linked by scanning a QR code, like WhatsApp Web.
 * Session credentials persist under data/sessions/whatsapp/.
 */
export class WhatsAppProvider implements Provider {
  id = 'whatsapp';
  capabilities = {
    reply: true,
    react: true,
    forward: false, // copy-fallback forwarding handled by the server
    edit: true,
    delete: true,
    groups: true,
    attachments: true,
    crossChatQuotes: true, // native quotes can reference the original (group) chat
  };

  private sock: WASocket | null = null;
  private state: WaState = 'idle';
  private qr: string | null = null;
  private accountId: string | null = null; // 'whatsapp:+<digits>' once linked
  private reconnectTimer: NodeJS.Timeout | null = null;
  private wasPaired = false;

  async start(): Promise<void> {
    // Auto-connect only if we have persisted credentials to resume.
    if (existsSync(sessionDir) && readdirSync(sessionDir).length > 0) {
      await this.connect();
    } else {
      console.log('[whatsapp] no session — connect via the Accounts dialog to link');
    }
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.end(undefined);
    this.sock = null;
  }

  status(): string {
    return this.state;
  }

  getState(): { state: WaState; qr: string | null; accountId: string | null } {
    return { state: this.state, qr: this.state === 'qr' ? this.qr : null, accountId: this.accountId };
  }

  async connect(): Promise<void> {
    if (this.sock) return; // already connecting/connected
    mkdirSync(sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    let version;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined; // Baileys falls back to its bundled default
    }
    this.state = 'connecting';
    this.qr = null;
    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      printQRInTerminal: false,
      browser: ['Universal Messenger', 'Chrome', '1.0'],
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => void this.onConnection(u));
    sock.ev.on('messages.upsert', ({ messages, type }) => void this.onMessages(messages, type));
    sock.ev.on('messages.update', (updates) => this.onMessageUpdates(updates));
    sock.ev.on('messages.reaction', (items) => void this.onReactions(items));
    sock.ev.on('messaging-history.set', ({ messages, chats, contacts }) =>
      void this.onHistory(messages, chats, contacts)
    );
    // Disappearing-messages setting changes (toggled on/off in a chat).
    // undefined = update doesn't mention the setting (leave as-is);
    // null = explicitly turned off; number = duration in seconds.
    const syncEphemeral = async (id: string | null | undefined, expiration: number | null | undefined) => {
      if (!this.accountId || !id || expiration === undefined) return;
      // u.id is a jid; our dm chats are keyed by normalized phone, not jid.
      const remoteId = id.endsWith('@g.us') ? id : await this.phoneFromJid(id);
      setChatEphemeral(`${this.accountId}:${remoteId}`, Number(expiration ?? 0));
    };
    sock.ev.on('chats.update', (updates) => {
      for (const u of updates) void syncEphemeral(u.id, u.ephemeralExpiration);
    });
    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) void syncEphemeral(c.id, c.ephemeralExpiration);
    });
    // Read/delivery receipts for our outgoing messages.
    sock.ev.on('message-receipt.update', (updates) => {
      if (!this.accountId) return;
      void (async () => {
        for (const { key, receipt } of updates) {
          try {
            if (!key.id) continue;
            const id = `${this.accountId}:${key.id}`;
            const chatId = `${this.accountId}:${key.remoteJid}`;
            const isGroup = Boolean(key.remoteJid?.endsWith('@g.us'));

            if (receipt.readTimestamp) {
              if (isGroup) {
                // Group blue = ALL recipients read. Track per-reader.
                const reader = receipt.userJid ? await this.phoneFromJid(receipt.userJid) : null;
                if (reader) addReceiptReader(id, reader);

                const selfPhone = this.accountId!.slice('whatsapp:'.length);
                let total = recipientCount(chatId, selfPhone);
                if (total === 0) {
                  // Participant list not fetched yet — fetch now.
                  const chat = getChat(chatId);
                  if (chat) {
                    const parts = await this.fetchParticipants(chat);
                    if (parts?.length) replaceChatParticipants(chatId, parts);
                    total = recipientCount(chatId, selfPhone);
                  }
                }
                const readers = countReceiptReaders(id);
                if (total > 0 && readers < total) {
                  // Partial: show delivered until everyone has read.
                  if (updateMessageReceipt(id, 'delivered')) this.broadcastUpdated(id);
                } else if (updateMessageReceipt(id, 'read')) {
                  this.broadcastUpdated(id);
                }
              } else if (updateMessageReceipt(id, 'read')) {
                this.broadcastUpdated(id);
              }
            } else if (receipt.deliveredDeviceJid?.length || receipt.receiptTimestamp) {
              if (updateMessageReceipt(id, 'delivered')) this.broadcastUpdated(id);
            }
          } catch {
            /* skip individual receipts */
          }
        }
      })();
    });
    sock.ev.on('presence.update', ({ id, presences }) => {
      if (!this.accountId) return;
      void (async () => {
        const isGroup = id.endsWith('@g.us');
        const chatRemoteId = isGroup ? id : await this.phoneFromJid(id);
        const chatId = `${this.accountId!}:${chatRemoteId}`;
        for (const [participant, p] of Object.entries(presences)) {
          const presence = (p as { lastKnownPresence?: string }).lastKnownPresence;
          if (presence !== 'composing' && presence !== 'recording') continue;
          // For groups, name the participant; for DMs the chat label suffices.
          let name: string | null = null;
          if (isGroup) {
            const phone = await this.phoneFromJid(participant);
            name = getName(phone) ?? phone;
          }
          broadcastTyping(chatId, name);
        }
      })();
    });
  }

  /** Unlink the device and wipe the local session. */
  async logout(): Promise<void> {
    try {
      await this.sock?.logout();
    } catch {
      /* already closed */
    }
    this.stop();
    this.state = 'idle';
    setProviderAccountsStatus('whatsapp', 'disconnected');
    this.accountId = null;
    this.qr = null;
    rmSync(sessionDir, { recursive: true, force: true });
    broadcast({ type: 'accounts', data: listAccounts() });
  }

  // ---------- connection ----------

  private async onConnection(u: Partial<ConnectionState>): Promise<void> {
    const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
      ?.output?.statusCode;
    if (u.qr) {
      this.state = 'qr';
      this.qr = u.qr;
      console.log('[whatsapp] QR ready — scan with your phone');
    }
    if (u.connection === 'open') {
      this.state = 'open';
      this.qr = null;
      this.wasPaired = true;
      const me = this.sock?.user;
      const phone = me?.id?.split(':')[0];
      this.accountId = phone ? `whatsapp:+${phone}` : null;
      if (this.accountId) {
        upsertAccount({
          id: this.accountId,
          provider: 'whatsapp',
          label: me?.name ? `${me.name} (+${phone})` : `+${phone}`,
        });
        setAccountStatus(this.accountId, 'active');
      }
      broadcast({ type: 'accounts', data: listAccounts() });
      console.log(`[whatsapp] connected as ${me?.name ?? phone}`);
      void this.syncGroups();
      void this.mergeLidChats();
      void this.syncChannelTitles();
    }
    if (u.connection === 'close') {
      this.sock = null;
      this.qr = null;
      if (code === DisconnectReason.loggedOut) {
        this.state = 'idle';
        if (this.accountId) setAccountStatus(this.accountId, 'disconnected');
        this.accountId = null;
        this.wasPaired = false;
        rmSync(sessionDir, { recursive: true, force: true });
        console.log('[whatsapp] logged out — session cleared');
      } else {
        this.state = 'close';
        // Reconnect only when previously paired (unpaired QR timeouts shouldn't loop).
        if (this.wasPaired || code !== DisconnectReason.timedOut) {
          this.reconnectTimer = setTimeout(() => void this.connect(), 3000);
        }
      }
      broadcast({ type: 'accounts', data: listAccounts() });
    }
  }

  /** Create chat rows (with subjects) for all groups we participate in. */
  private async syncGroups(): Promise<void> {
    if (!this.sock || !this.accountId) return;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const g of Object.values(groups)) {
        getOrCreateChat(this.accountId, g.id, {
          type: 'group',
          title: g.subject,
          contactRaw: g.subject ?? g.id,
        });
        // Group metadata carries the disappearing-messages duration.
        setChatEphemeral(`${this.accountId}:${g.id}`, Number(g.ephemeralDuration ?? 0));
      }
      broadcast({ type: 'chats-updated' });
      console.log(`[whatsapp] synced ${Object.keys(groups).length} groups`);
    } catch (e) {
      console.error('[whatsapp] group sync failed:', (e as Error).message);
    }
  }

  // ---------- inbound ----------

  private async onMessages(messages: WAMessage[], _type: string): Promise<void> {
    for (const msg of messages) {
      try {
        await this.ingestWaMessage(msg, true, true);
      } catch (e) {
        console.error('[whatsapp] ingest failed:', (e as Error).message);
      }
    }
  }

  private async onHistory(
    messages: WAMessage[],
    chats: { id?: string | null; name?: string | null; ephemeralExpiration?: number | null }[],
    contacts?: { id?: string | null; name?: string | null; notify?: string | null }[]
  ): Promise<void> {
    const names = new Map(
      chats.filter((c): c is { id: string; name?: string | null } => Boolean(c.id)).map((c) => [c.id, c.name ?? undefined])
    );
    // Persist each chat's disappearing-messages duration for send-time use.
    if (this.accountId) {
      for (const c of chats) {
        if (c.id && c.ephemeralExpiration !== undefined && c.ephemeralExpiration !== null) {
          const remoteId = c.id.endsWith('@g.us') ? c.id : await this.phoneFromJid(c.id);
          setChatEphemeral(`${this.accountId}:${remoteId}`, Number(c.ephemeralExpiration));
        }
      }
    }
    // Contact pushnames from the phone → names table (drives sender display).
    for (const c of contacts ?? []) {
      if (!c.id) continue;
      const display = c.notify ?? c.name;
      if (display) setName(phoneFromJid(c.id), display);
    }
    // Keep only the most recent N messages per chat — history sync is for
    // context, not archival; older pages are fetched on demand when scrolling.
    const byChat = new Map<string, WAMessage[]>();
    for (const m of messages) {
      const jid = m.key?.remoteJid;
      if (!jid) continue;
      const arr = byChat.get(jid) ?? [];
      arr.push(m);
      byChat.set(jid, arr);
    }
    let n = 0;
    for (const [jid, arr] of byChat.entries()) {
      arr.sort((a, b) => Number(a.messageTimestamp ?? 0) - Number(b.messageTimestamp ?? 0));
      // Normalize async (jid/name resolution), then store the whole chat in
      // ONE SQLite transaction — per-message autocommits block the event
      // loop during big syncs and freeze the HTTP server.
      const normalized: NormalizedMessage[] = [];
      for (const msg of arr.slice(-HISTORY_PER_CHAT)) {
        try {
          // History: text only — downloading every old image would be slow and
          // WhatsApp's media retention may have expired anyway.
          const norm = await this.normalizeWaMessage(msg, false, names);
          if (norm) normalized.push(norm.msg);
        } catch {
          /* skip individual failures */
        }
      }
      n += ingestBatch(normalized);
      // Resolve a pending fetchOlder waiter with what this chat received
      // (received, not ingested — duplicates still mean history exists).
      const waiter = this.historyWaiters.get(jid);
      if (waiter) {
        this.historyWaiters.delete(jid);
        waiter(Math.min(arr.length, HISTORY_PER_CHAT));
      }
    }
    console.log(`[whatsapp] history sync: ${n} messages ingested`);
    broadcast({ type: 'chats-updated' });
  }

  /**
   * Ask WhatsApp for older messages in a chat (on-demand history sync). The
   * messages arrive asynchronously via messaging-history.set — we park a
   * waiter and resolve it with the actual ingested count, so scroll-back
   * pagination can tell when history is exhausted.
   */
  private historyWaiters = new Map<string, (n: number) => void>();

  async fetchOlder(chat: Chat, _beforeTs: number): Promise<number> {
    const sock = this.sock as (WASocket & {
      fetchMessageHistory?: (jid: string, count: number, oldestMsg?: WAMessage) => Promise<unknown>;
    }) | null;
    if (!sock || this.state !== 'open') return 0;
    if (typeof sock.fetchMessageHistory !== 'function') return 0;
    try {
      const oldest = getOldestMessage(chat.id);
      if (!oldest) return 0;
      const key = this.reconstructKey(oldest);
      const jid = this.jidForChat(chat);
      const countPromise = new Promise<number>((resolve) => {
        this.historyWaiters.set(jid, resolve);
        setTimeout(() => {
          // No response in time — resolve with "nothing new" only once.
          if (this.historyWaiters.get(jid) === resolve) {
            this.historyWaiters.delete(jid);
            resolve(0);
          }
        }, 20000);
      });
      await sock.fetchMessageHistory(jid, HISTORY_PER_CHAT, {
        key,
        message: { conversation: oldest.body },
      } as WAMessage);
      return await countPromise;
    } catch (e) {
      console.error('[whatsapp] fetchOlder failed:', (e as Error).message);
      return 0;
    }
  }

  /** Normalize a WAMessage and feed the ingest pipeline. Returns true if stored. */
  private async ingestWaMessage(
    msg: WAMessage,
    downloadMedia: boolean,
    notify: boolean,
    historyNames?: Map<string, string | undefined>
  ): Promise<boolean> {
    const norm = await this.normalizeWaMessage(msg, downloadMedia, historyNames);
    if (!norm) return false;
    const stored = await ingest(norm.msg, 'poll', notify);
    // Already stored (re-sync) but missing its attachment payload — fill it
    // so the attachment can be fetched on demand.
    if (!stored && norm.msg.mediaPending && this.accountId) {
      fillMediaPending(`${this.accountId}:${norm.rawKeyId}`, norm.msg.mediaPending);
    }
    return stored;
  }

  /** WAMessage → NormalizedMessage (null = skip: reactions/protocol/status). */
  private async normalizeWaMessage(
    msg: WAMessage,
    downloadMedia: boolean,
    historyNames?: Map<string, string | undefined>
  ): Promise<{ msg: NormalizedMessage; rawKeyId: string } | null> {
    const key = msg.key;
    if (!key?.id || !key.remoteJid || key.remoteJid === 'status@broadcast') return null;
    if (!this.accountId) return null;

    const content = unwrap(msg.message);
    if (!content) return null;

    const text = extractText(content);
    const mediaNode = extractMedia(content);
    const ctx = extractContext(content);
    if (!text && !mediaNode) return null; // reactions/protocol handled elsewhere

    const isGroup = key.remoteJid.endsWith('@g.us');
    const isChannel = key.remoteJid.endsWith('@newsletter');
    const chatRemoteId = isGroup || isChannel ? key.remoteJid : await this.phoneFromJid(key.remoteJid);
    // Newsletters: fetch the channel name once, in the background.
    if (isChannel) void this.ensureChannelTitle(key.remoteJid);

    // Ephemeral messages carry the chat's expiration in contextInfo — learn
    // the setting passively from incoming (and echoed) messages.
    const eph = (ctx as { ephemeralExpiration?: number | null } | null)?.ephemeralExpiration;
    if (eph) {
      setChatEphemeral(`${this.accountId}:${chatRemoteId}`, Number(eph));
    }
    // Recent Baileys exposes the real phone alongside lid participants.
    const keyAny = key as WAMessageKey & { participantPn?: string; senderPn?: string };
    const senderJid = keyAny.participantPn ?? keyAny.senderPn ?? key.participant ?? '';
    const sender = isGroup
      ? key.fromMe
        ? null
        : (await this.phoneFromJid(senderJid)) || null
      : null;

    // Capture display names for the names table (drives sender display).
    // Lid-keyed too — migrated to the phone number when the lid resolves.
    if (msg.pushName && !key.fromMe) {
      if (!isGroup && !chatRemoteId.endsWith('@lid')) setName(chatRemoteId, msg.pushName);
      if (sender) setName(sender, msg.pushName);
    }

    // Rewrite @<number> mentions to @Name using everything we know.
    const body = await this.resolveMentions(text ?? mediaCaption(mediaNode) ?? '', ctx);

    let media;
    if (mediaNode && downloadMedia) {
      media = await this.download(msg);
    }
    // No media yet (history sync or a failed download) — stash the node so it
    // can be fetched on demand when the user views the chat.
    const mediaPending = mediaNode && !media ? encodeMediaNode(mediaNode) : undefined;

    const ts = Number(msg.messageTimestamp ?? 0) * 1000 || Date.now();
    return {
      rawKeyId: key.id,
      msg: {
        id: key.id,
        accountId: this.accountId,
        chatRemoteId,
        chatType: isChannel ? 'channel' : isGroup ? 'group' : 'dm',
        chatTitle: isGroup ? historyNames?.get(key.remoteJid) : undefined,
        contactRaw: msg.pushName ?? chatRemoteId,
        sender: sender ?? undefined,
        ts,
        outgoing: Boolean(key.fromMe),
        body,
        media,
        mediaPending,
        quotedRemoteId: ctx?.stanzaId ?? undefined,
        // WhatsApp marks forwards in contextInfo (isForwarded/forwardingScore).
        forwardedFrom: (ctx as { isForwarded?: boolean } | null)?.isForwarded ? 'incoming' : undefined,
      },
    };
  }

  /**
   * Replace WhatsApp's raw `@<number>` mentions with `@Name` using our names
   * table + CardDAV. The mention digits in the text match the jid's user part
   * (which may itself be a lid, so resolve those too).
   */
  private async resolveMentions(body: string, ctx: proto.IContextInfo | null): Promise<string> {
    if (!body.includes('@') || !ctx?.mentionedJid?.length) return body;
    let out = body;
    for (const jid of ctx.mentionedJid) {
      if (!jid) continue;
      const user = jid.split('@')[0];
      const phone = await this.phoneFromJid(jid);
      const name = getName(phone) ?? getName(user);
      if (name) out = out.split(`@${user}`).join(`@${name}`);
    }
    return out;
  }

  // Max 3 concurrent media downloads (viewing a large backlog can trigger
  // dozens; WhatsApp throttles us otherwise).
  private dlSlots = 3;
  private dlWaiters: (() => void)[] = [];
  private async dlAcquire(): Promise<void> {
    if (this.dlSlots > 0) {
      this.dlSlots--;
      return;
    }
    await new Promise<void>((r) => this.dlWaiters.push(r));
  }
  private dlRelease(): void {
    const w = this.dlWaiters.shift();
    if (w) w();
    else this.dlSlots++;
  }

  /** Download the media payload of a message (if any) and cache it locally. */
  private async download(msg: WAMessage) {
    if (!this.sock) return undefined;
    await this.dlAcquire();
    try {
      const buf = (await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger, reuploadRequest: this.sock.updateMediaMessage }
      )) as Buffer;
      const content = unwrap(msg.message);
      const node = content ? extractMedia(content) : null;
      const mime = node?.mimetype ?? 'application/octet-stream';
      return [saveMediaBuffer(buf, mime, msg.key?.id ?? undefined)];
    } catch (e) {
      console.error('[whatsapp] media download failed:', (e as Error).message);
      return undefined;
    } finally {
      this.dlRelease();
    }
  }

  /**
   * Lazily download an attachment we skipped at ingest (history sync stores
   * the media node as media_pending). Rebuilds a minimal WAMessage from the
   * stored node and runs the normal download path.
   */
  async downloadPendingMedia(message: Message): Promise<boolean> {
    if (!this.sock || this.state !== 'open' || !this.accountId) return false;
    const raw = getMediaPending(message.id);
    if (!raw) return false;
    try {
      const { type, node } = decodeMediaNode(raw);
      const fake = {
        key: this.reconstructKey(message),
        message: { [`${type}Message`]: node },
      } as WAMessage;
      const media = await this.download(fake);
      if (!media) return false;
      updateMessageMedia(message.id, media);
      const updated = getMessage(message.id);
      if (updated) {
        updated.reactions = getReactionsForMessage(message.id);
        broadcast({ type: 'message-updated', data: updated });
      }
      return true;
    } catch (e) {
      console.error('[whatsapp] lazy media download failed:', (e as Error).message);
      return false;
    }
  }

  private onMessageUpdates(
    updates: { key: WAMessageKey; update: Partial<WAMessage> }[]
  ): void {
    if (!this.accountId) return;
    for (const { key, update } of updates) {
      if (!key.id) continue;
      const id = `${this.accountId}:${key.id}`;

      // DM read/delivery receipts arrive as message status updates
      // (group receipts come via message-receipt.update instead).
      // Status enum: PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5.
      const st = Number(update.status);
      if (st >= 2) {
        const receiptStatus = st >= 4 ? 'read' : st === 3 ? 'delivered' : 'sent';
        if (updateMessageReceipt(id, receiptStatus)) {
          const updated = getMessage(id);
          if (updated) broadcast({ type: 'message-updated', data: updated });
        }
        continue;
      }

      // Delete-for-everyone: Baileys translates the REVOKE protocol message
      // into update.message = null + messageStubType = REVOKE, with key.id
      // already pointing at the TARGET message. Leave a tombstone behind.
      if (update.message === null || Number(update.messageStubType) === WAMessageStubType.REVOKE) {
        markMessageDeleted(id);
        const updated = getMessage(id);
        if (updated) broadcast({ type: 'message-updated', data: updated });
        broadcast({ type: 'chats-updated' });
        continue;
      }

      const inner = update.message ? unwrap(update.message) : null;

      // Edit: message.editedMessage.message carries the new content.
      const edited = inner?.editedMessage?.message;
      if (edited) {
        const newText = extractText(unwrap(edited) ?? edited);
        if (newText) {
          updateMessageBody(id, newText);
          const updated = getMessage(id);
          if (updated) {
            updated.reactions = getReactionsForMessage(id);
            broadcast({ type: 'message-updated', data: updated });
          }
        }
      }
    }
  }

  private async onReactions(items: { key: WAMessageKey; reaction: proto.IReaction }[]): Promise<void> {
    if (!this.accountId) return;
    for (const { key, reaction } of items) {
      try {
        if (!key.id || !key.remoteJid) continue;
        const targetId = `${this.accountId}:${key.id}`;
        const emoji = reaction.text ?? '';
        const isGroup = key.remoteJid.endsWith('@g.us');
        const chatRemoteId = isGroup ? key.remoteJid : await this.phoneFromJid(key.remoteJid);
        const chatId = `${this.accountId}:${chatRemoteId}`;
        // key.fromMe describes the TARGET message's author. The REACTOR is in
        // reaction.key (the outer message's key): fromMe = us, participant =
        // the reacting group member.
        const outer = (reaction as { key?: WAMessageKey }).key;
        const reactor = outer?.fromMe
          ? 'me'
          : outer?.participant
            ? (await this.phoneFromJid(outer.participant)) || 'others'
            : isGroup
              ? 'others'
              : chatRemoteId;
        const ts = Number(reaction.senderTimestampMs ?? Date.now());

        if (emoji) {
          addReaction({
            id: `${targetId}:${reactor}:${emoji}`,
            messageId: targetId,
            chatId,
            emoji,
            fromSender: reactor,
            ts,
          });
        } else {
          removeReactions(targetId, reactor);
        }
        const updated = getMessage(targetId);
        if (updated) {
          updated.reactions = getReactionsForMessage(targetId);
          broadcast({ type: 'message-updated', data: updated });
        }
      } catch (e) {
        console.error('[whatsapp] reaction failed:', (e as Error).message);
      }
    }
  }

  /**
   * '@lid' jids hide the phone number for privacy; resolve to E.164 via
   * Baileys' lid mapping (API first, on-disk mapping files as fallback) and
   * fold any lid-keyed chat into the phone-keyed one.
   */
  private async phoneFromJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return phoneFromJid(jid);
    const lidUser = jid.split('@')[0];
    let pn: string | null = null;
    try {
      const repo = this.sock?.signalRepository as
        | { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> } }
        | undefined;
      pn = (await repo?.lidMapping?.getPNForLID?.(jid)) ?? null;
    } catch {
      /* fall through to file lookup */
    }
    if (!pn) {
      try {
        const raw = readFileSync(
          resolve(sessionDir, `lid-mapping-${lidUser}_reverse.json`),
          'utf-8'
        );
        pn = JSON.parse(raw) as string;
      } catch {
        /* no mapping on disk */
      }
    }
    if (!pn) return jid;
    const phone = phoneFromJid(`${pn}@s.whatsapp.net`);
    // Fold the lid-keyed chat (if any) into the phone-keyed one.
    if (this.accountId) {
      mergeChats(`${this.accountId}:${jid}`, `${this.accountId}:${phone}`);
      // Carry a lid-keyed pushname over to the phone number.
      const lidName = (
        getDb().prepare('SELECT name FROM names WHERE id = ?').get(jid) as
          | { name: string }
          | undefined
      )?.name;
      const phoneName = (
        getDb().prepare('SELECT name FROM names WHERE id = ?').get(phone) as
          | { name: string }
          | undefined
      )?.name;
      if (lidName && !phoneName) setName(phone, lidName);
    }
    return phone;
  }

  /** One-time sweep: merge all existing @lid chats we can resolve. */
  private async mergeLidChats(): Promise<void> {
    if (!this.accountId) return;
    try {
      const rows = getDb()
        .prepare(`SELECT remote_id FROM chats WHERE account_id = ? AND remote_id LIKE '%@lid'`)
        .all(this.accountId) as { remote_id: string }[];
      let n = 0;
      for (const { remote_id } of rows) {
        const resolved = await this.phoneFromJid(remote_id);
        if (resolved !== remote_id) n++;
      }

      // Rewrite group senders stored as lids so name resolution works on them.
      const lidSenders = getDb()
        .prepare(`SELECT DISTINCT sender FROM messages WHERE account_id = ? AND sender LIKE '%@lid'`)
        .all(this.accountId) as { sender: string }[];
      for (const { sender } of lidSenders) {
        const resolved = await this.phoneFromJid(sender);
        if (resolved !== sender) rewriteSender(this.accountId, sender, resolved);
      }

      // Rewrite raw @<liduser> mentions in stored bodies to @Name when we
      // know one (or at least to the real phone number's digits).
      const candidates = new Set<string>();
      const bodyRows = getDb()
        .prepare(`SELECT body FROM messages WHERE account_id = ? AND body LIKE '%@%'`)
        .all(this.accountId) as { body: string }[];
      for (const { body } of bodyRows) {
        for (const m of body.matchAll(/@(\d{8,20})\b/g)) candidates.add(m[1]);
      }
      for (const digits of candidates) {
        const resolved = await this.phoneFromJid(`${digits}@lid`);
        const phone = resolved.endsWith('@lid') ? `+${digits}` : resolved;
        const name = getName(phone) ?? getName(digits);
        if (name) rewriteBodyFragment(`@${digits}`, `@${name}`);
      }

      if (n) {
        console.log(`[whatsapp] merged ${n} lid chats`);
        broadcast({ type: 'chats-updated' });
      }
    } catch (e) {
      console.error('[whatsapp] lid sweep failed:', (e as Error).message);
    }
  }

  /** Broadcast a message refreshed with its current state. */
  private broadcastUpdated(id: string): void {
    const updated = getMessage(id);
    if (updated) broadcast({ type: 'message-updated', data: updated });
  }

  /** Fetch a newsletter's name and set it as the chat title (once). */
  private async ensureChannelTitle(jid: string): Promise<void> {
    if (!this.sock || !this.accountId) return;
    try {
      const md = (await this.sock.newsletterMetadata('jid', jid)) as {
        name?: string | null;
        thread_metadata?: { name?: string | { text?: string } | null } | null;
      } | null;
      // Actual payloads nest the name as thread_metadata.name.text.
      const raw = md?.thread_metadata?.name;
      const name = (typeof raw === 'object' ? raw?.text : raw) ?? md?.name ?? null;
      if (name) {
        setChatTitleIfBlank(`${this.accountId}:${jid}`, name);
        broadcast({ type: 'chats-updated' });
      }
    } catch {
      /* metadata unavailable */
    }
  }

  /** Backfill titles for all known channel chats missing them (boot sweep). */
  private async syncChannelTitles(): Promise<void> {
    if (!this.accountId) return;
    const rows = getDb()
      .prepare(
        `SELECT remote_id FROM chats WHERE account_id = ? AND type = 'channel'
         AND (title IS NULL OR title = '')`
      )
      .all(this.accountId) as { remote_id: string }[];
    for (const { remote_id } of rows) {
      await this.ensureChannelTitle(remote_id);
    }
    if (rows.length) console.log(`[whatsapp] titled ${rows.length} channels`);
  }

  // ---------- outbound ----------

  /** Mark the chat read on WhatsApp (clears the unread badge on the phone). */
  async markRead(chat: Chat): Promise<void> {
    if (!this.sock || this.state !== 'open') return;
    const latest = getMessages(chat.id, 50)
      .reverse()
      .find((m) => m.outgoing === 0);
    if (!latest) return;
    try {
      await this.sock.readMessages([this.reconstructKey(latest)]);
    } catch (e) {
      console.error('[whatsapp] markRead failed:', (e as Error).message);
    }
  }

  /** Is this phone number registered on WhatsApp? (null = can't check now) */
  async checkNumber(number: string): Promise<boolean | null> {
    if (!this.sock || this.state !== 'open') return null;
    try {
      const digits = number.replace(/\D/g, '');
      const res = (await this.sock.onWhatsApp(`${digits}@s.whatsapp.net`)) as
        | { exists: boolean }[]
        | undefined;
      return Boolean(res?.[0]?.exists);
    } catch {
      return null;
    }
  }

  /** Group members for @mention autocomplete. */
  async fetchParticipants(chat: Chat): Promise<{ id: string; name: string }[] | null> {
    if (!this.sock || this.state !== 'open' || chat.type !== 'group') return null;
    try {
      const md = await this.sock.groupMetadata(chat.remoteId);
      const out: { id: string; name: string }[] = [];
      for (const p of md.participants) {
        const phone = await this.phoneFromJid(p.id);
        out.push({ id: phone, name: getName(phone) ?? phone });
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Subscribe to presence for a chat (required to receive typing updates). */
  async subscribePresence(chat: Chat): Promise<void> {
    if (!this.sock || this.state !== 'open') return;
    try {
      await this.sock.presenceSubscribe(this.jidForChat(chat));
    } catch {
      /* non-fatal */
    }
  }

  /** Edit our own message (WhatsApp edit-for-everyone, ~15 min window). */
  async editMessage(chat: Chat, target: Message, newBody: string): Promise<void> {
    if (!this.sock || this.state !== 'open') throw new Error('whatsapp not connected');
    await this.sock.sendMessage(this.jidForChat(chat), {
      text: newBody,
      edit: this.reconstructKey(target),
    });
    updateMessageBody(target.id, newBody);
    const updated = getMessage(target.id);
    if (updated) broadcast({ type: 'message-updated', data: updated });
  }

  /** Tell the chat we're typing (WhatsApp shows "typing…" to the other side). */
  async sendTyping(chat: Chat): Promise<void> {
    if (!this.sock || this.state !== 'open') return;
    try {
      await this.sock.sendPresenceUpdate('composing', this.jidForChat(chat));
    } catch {
      /* non-fatal */
    }
  }

  /** WhatsApp jid for a chat (dm chats store the phone as remoteId). */
  private jidForChat(chat: Chat): string {
    // Groups and unresolved lid contacts already store a full jid.
    if (chat.type === 'group' || chat.remoteId.includes('@')) return chat.remoteId;
    return `${chat.remoteId.replace(/\D/g, '')}@s.whatsapp.net`;
  }

  /** Reconstruct a minimal WAMessage suitable for quoting/reacting. */
  private reconstructKey(target: Message): WAMessageKey {
    const chat = target.chatId.slice(`${target.accountId}:`.length);
    const isGroup = chat.endsWith('@g.us');
    return {
      id: target.id.slice(`${target.accountId}:`.length),
      remoteJid: isGroup ? chat : `${chat.replace(/\D/g, '')}@s.whatsapp.net`,
      fromMe: target.outgoing === 1,
      participant: isGroup && target.sender ? `${target.sender.replace(/\D/g, '')}@s.whatsapp.net` : undefined,
    };
  }

  async send(chat: Chat, payload: SendPayload): Promise<SendResult> {
    if (!this.sock || this.state !== 'open' || !this.accountId) {
      throw new Error('whatsapp not connected');
    }
    const jid = this.jidForChat(chat);

    const quotedTarget = payload.quotedId ? getMessage(payload.quotedId) : null;
    const quoted = quotedTarget
      ? ({
          key: this.reconstructKey(quotedTarget),
          message: { conversation: quotedTarget.body },
        } as WAMessage)
      : undefined;

    const m = payload.media?.[0];
    let text = payload.body;
    const mentionedJids: string[] = [];
    // WhatsApp renders mention text as @<number>; swap our @Name back to it.
    for (const mention of payload.mentions ?? []) {
      const digits = mention.memberId.replace(/\D/g, '');
      if (!digits) continue;
      const idx = text.indexOf(`@${mention.name}`);
      if (idx >= 0) {
        text = `${text.slice(0, idx)}@${digits}${text.slice(idx + mention.name.length + 1)}`;
      }
      const jid = `${digits}@s.whatsapp.net`;
      if (!mentionedJids.includes(jid)) mentionedJids.push(jid);
    }
    const content: AnyMessageContent = m
      ? {
          image: Buffer.from(m.data, 'base64'),
          caption: text || undefined,
          mimetype: m.contentType,
          mentions: mentionedJids.length ? mentionedJids : undefined,
        }
      : { text, mentions: mentionedJids.length ? mentionedJids : undefined };

    // Respect the chat's disappearing-messages setting, if enabled.
    const sendOpts: Parameters<WASocket['sendMessage']>[2] = { quoted };
    if (chat.ephemeralSeconds && chat.ephemeralSeconds > 0) {
      sendOpts.ephemeralExpiration = chat.ephemeralSeconds;
    }

    const sent = await this.sock.sendMessage(jid, content, sendOpts);
    const localId = sent?.key.id ?? `local-${Date.now()}`;

    // Store the echo immediately (media prebuilt — a fake WAMessage wouldn't download).
    await ingest(
      {
        id: localId,
        accountId: this.accountId,
        chatRemoteId: chat.remoteId,
        chatType: chat.type,
        contactRaw: chat.contactRaw,
        ts: Date.now(),
        outgoing: true,
        body: payload.body,
        media: m ? [saveUploadedMedia(Buffer.from(m.data, 'base64'), m.contentType)] : undefined,
        quotedRemoteId: quotedTarget
          ? quotedTarget.id.slice(`${this.accountId}:`.length)
          : undefined,
        forwardedFrom: payload.forwardedFrom,
      },
      'send'
    );
    return { id: localId };
  }

  async react(chat: Chat, target: Message, emoji: string): Promise<void> {
    if (!this.sock || this.state !== 'open') throw new Error('whatsapp not connected');
    const jid = this.jidForChat(chat);
    await this.sock.sendMessage(jid, {
      react: { text: emoji, key: this.reconstructKey(target) },
    });
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
}

// ---------- helpers ----------

/** Unwrap container messages (ephemeral, view-once, edited) to the real content. */
function unwrap(m: proto.IMessage | null | undefined): proto.IMessage | null {
  let cur = m;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur.ephemeralMessage?.message) cur = cur.ephemeralMessage.message;
    else if (cur.viewOnceMessage?.message) cur = cur.viewOnceMessage.message;
    else if (cur.viewOnceMessageV2?.message) cur = cur.viewOnceMessageV2.message;
    else if (cur.documentWithCaptionMessage?.message) cur = cur.documentWithCaptionMessage.message;
    else break;
  }
  return cur ?? null;
}

function extractText(m: proto.IMessage): string | null {
  return m.conversation ?? m.extendedTextMessage?.text ?? null;
}

/** The media-bearing sub-message (image/video/document/sticker/audio), if any. */
function extractMedia(m: proto.IMessage) {
  return m.imageMessage ?? m.videoMessage ?? m.documentMessage ?? m.stickerMessage ?? m.audioMessage ?? null;
}

/** Captions exist on image/video/document; stickers and audio have none. */
function mediaCaption(node: ReturnType<typeof extractMedia>): string | null {
  if (!node) return null;
  return (node as { caption?: string | null }).caption ?? null;
}

const BINARY_FIELDS = ['mediaKey', 'fileSha256', 'fileEncSha256', 'streamingSidecar', 'thumbnailDirectPath'];

/**
 * Serialize a Baileys media node for the media_pending column. Binary fields
 * (mediaKey etc.) are base64-wrapped; jpegThumbnail is dropped (big, unused).
 */
function encodeMediaNode(node: object): string {
  const kind = nodeKind(node);
  const clean = { ...(node as Record<string, unknown>) };
  delete clean.jpegThumbnail;
  for (const k of BINARY_FIELDS) {
    const v = clean[k];
    if (v instanceof Uint8Array) clean[k] = { __b64: Buffer.from(v).toString('base64') };
  }
  return JSON.stringify({ type: kind, node: clean });
}

function decodeMediaNode(raw: string): { type: string; node: Record<string, unknown> } {
  const parsed = JSON.parse(raw) as { type: string; node: Record<string, unknown> };
  for (const k of BINARY_FIELDS) {
    const v = parsed.node[k] as { __b64?: string } | undefined;
    if (v && typeof v === 'object' && v.__b64) parsed.node[k] = Buffer.from(v.__b64, 'base64');
  }
  return parsed;
}

/** Identify which `*Message` wrapper a media node belongs to. */
function nodeKind(node: object): string {
  const mime = String((node as { mimetype?: unknown }).mimetype ?? '');
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if ('isAnimated' in node || 'stickerSentTs' in node) return 'sticker';
  if (mime.startsWith('image/')) return 'image';
  return 'document';
}

function extractContext(m: proto.IMessage): proto.IContextInfo | null {
  return (
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo ??
    m.documentMessage?.contextInfo ??
    null
  );
}

/** '15551234567:12@s.whatsapp.net' -> '+15551234567'; non-phone jids pass through. */
function phoneFromJid(jid: string): string {
  const [user, domain] = jid.split('@');
  if (domain === 's.whatsapp.net') return `+${user.split(':')[0]}`;
  return jid;
}

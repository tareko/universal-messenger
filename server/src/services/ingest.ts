import {
  insertMessage,
  getContactName,
  getName,
  messageExists,
  isDuplicateMessage,
  isDuplicateReaction,
  getMessage,
  getReactionsForMessage,
  getMessages,
  reactionExists,
  addReaction,
  getOrCreateChat,
  getChat,
  getDb,
} from '../store/db.js';
import { broadcast } from '../realtime/sse.js';
import { notifyMessage } from '../notify/notify.js';
import { downloadAndCacheMedia } from './media.js';
import { getProvider } from '../providers/registry.js';
import { matchTarget } from '../providers/voipms/reactions.js';
import type { MediaRef, Message } from '../types.js';
import type { NormalizedMessage } from '../providers/types.js';

function namespacedId(msg: NormalizedMessage): string {
  return `${msg.accountId}:${msg.id}`;
}

function chatDisplayName(chatId: string, fallback: string): string {
  const chat = getChat(chatId);
  if (!chat) return fallback;
  if (chat.type === 'group' || chat.type === 'channel') return chat.title ?? fallback;
  return getContactName(chat.remoteId) ?? chat.contactRaw ?? fallback;
}

/** Broadcast a target message refreshed with its current reactions. */
function broadcastUpdated(targetId: string): void {
  const msg = getMessage(targetId);
  if (!msg) return;
  msg.reactions = getReactionsForMessage(targetId);
  broadcast({ type: 'message-updated', data: msg });
}

/**
 * Handle a provider-detected reaction payload (e.g. an iMessage tapback text).
 * Records it, attaches it to the matched message if found (and suppresses the
 * text bubble), otherwise falls through so the raw text is still shown.
 * Returns true if the message was consumed as a reaction (do not store as text).
 */
function handleInboundReaction(msg: NormalizedMessage, emoji: string, quoted: string, notify: boolean): boolean {
  const id = namespacedId(msg);
  if (reactionExists(id)) return true; // already processed

  const chat = getOrCreateChat(msg.accountId, msg.chatRemoteId, {
    type: msg.chatType,
    contactRaw: msg.contactRaw,
    title: msg.chatTitle,
  });
  const fromSender = msg.outgoing ? 'me' : (msg.sender ?? chat.remoteId);

  // Group-MMS leg duplicate (different id, same content) — skip.
  if (isDuplicateReaction(chat.id, emoji, msg.ts)) return true;

  const recent = getMessages(chat.id, 200);
  const target = matchTarget(recent, quoted);

  addReaction({ id, messageId: target?.id ?? null, chatId: chat.id, emoji, fromSender, ts: msg.ts });

  if (target) {
    broadcastUpdated(target.id);
    if (notify && !msg.outgoing) {
      void notifyMessage({
        name: chatDisplayName(chat.id, msg.contactRaw ?? msg.chatRemoteId),
        chatId: chat.id,
        preview: `reacted ${emoji}`,
        id,
      });
    }
    return true; // suppress the "Liked …" text bubble
  }
  return false; // no target → keep as a normal text message
}

/**
 * Ingest a provider-normalized message. Detects provider-specific reaction
 * payloads, downloads + caches media, dedups, persists, broadcasts via SSE,
 * and fires a push notification (if incoming, new, and `notify` is true).
 *
 * Pass `notify: false` when backfilling history.
 */
export async function ingest(
  msg: NormalizedMessage,
  source: 'poll' | 'webhook' | 'send' | 'import',
  notify: boolean = true
): Promise<boolean> {
  const provider = getProvider(msg.accountId.split(':')[0]);
  const detected = provider?.classifyInbound?.(msg.body);
  if (detected) return handleInboundReaction(msg, detected.emoji, detected.quoted, notify);

  const chat = getOrCreateChat(msg.accountId, msg.chatRemoteId, {
    type: msg.chatType,
    contactRaw: msg.contactRaw,
    title: msg.chatTitle,
  });

  const id = namespacedId(msg);
  let media = msg.media;
  if (!media && msg.mediaUrls && msg.mediaUrls.length && !messageExists(id)) {
    const refs = await Promise.all(msg.mediaUrls.map((u) => downloadAndCacheMedia(u)));
    media = refs.filter((r): r is MediaRef => r !== null);
    if (!media.length) media = undefined;
  }

  // Resolve a quoted reply reference to our namespaced id, if known.
  const quotedId = msg.quotedRemoteId ? `${msg.accountId}:${msg.quotedRemoteId}` : null;
  const quotedKnown = quotedId && messageExists(quotedId) ? quotedId : null;

  const stored: Message = {
    id,
    chatId: chat.id,
    accountId: msg.accountId,
    ts: msg.ts,
    date: msg.date ?? '',
    outgoing: msg.outgoing ? 1 : 0,
    sender: msg.sender ?? null,
    body: msg.body,
    carrierStatus: msg.carrierStatus ?? '',
    read: 0,
    media,
    quotedId: quotedKnown,
    forwardedFrom: msg.forwardedFrom ?? null,
  };

  // Group-MMS leg duplicate (different id, same content+timestamp) — skip.
  if (isDuplicateMessage(chat.id, stored.body, stored.ts)) return false;

  const inserted = insertMessage(
    stored,
    source === 'import' ? 'poll' : source,
    media ? undefined : msg.mediaPending,
    msg.vcard
  );
  if (inserted) {
    // Hydrate the sender display name BEFORE broadcasting — otherwise clients
    // render the raw number first and swap to the name on the next refetch.
    const withNames = {
      ...stored,
      senderName: stored.sender ? (getName(stored.sender) ?? null) : null,
    };
    broadcast({ type: 'message', data: withNames });
    broadcast({ type: 'chats-updated' });
    if (notify && !msg.outgoing) {
      void notifyMessage({
        name: chatDisplayName(chat.id, msg.contactRaw ?? msg.chatRemoteId),
        chatId: chat.id,
        preview: stored.body || (stored.media?.length ? '📷 Photo' : ''),
        id,
      });
    }
  }
  return inserted;
}

/**
 * Synchronous bulk ingest for history syncs: no media downloads, no
 * notifications, and — crucially — everything inside ONE SQLite transaction.
 * Thousands of autocommit inserts would otherwise block the event loop for
 * seconds, freezing the HTTP server while a sync runs.
 */
export function ingestBatch(messages: NormalizedMessage[]): number {
  let stored = 0;
  const tx = getDb().transaction((items: NormalizedMessage[]) => {
    for (const msg of items) {
      const provider = getProvider(msg.accountId.split(':')[0]);
      const detected = provider?.classifyInbound?.(msg.body);
      if (detected) {
        handleInboundReaction(msg, detected.emoji, detected.quoted, false);
        continue;
      }
      const chat = getOrCreateChat(msg.accountId, msg.chatRemoteId, {
        type: msg.chatType,
        contactRaw: msg.contactRaw,
        title: msg.chatTitle,
      });
      const id = namespacedId(msg);
      const quotedId = msg.quotedRemoteId ? `${msg.accountId}:${msg.quotedRemoteId}` : null;
      const quotedKnown = quotedId && messageExists(quotedId) ? quotedId : null;
      const storedMsg: Message = {
        id,
        chatId: chat.id,
        accountId: msg.accountId,
        ts: msg.ts,
        date: msg.date ?? '',
        outgoing: msg.outgoing ? 1 : 0,
        sender: msg.sender ?? null,
        body: msg.body,
        carrierStatus: msg.carrierStatus ?? '',
        read: 0,
        media: msg.media,
        quotedId: quotedKnown,
        forwardedFrom: msg.forwardedFrom ?? null,
      };
      if (isDuplicateMessage(chat.id, storedMsg.body, storedMsg.ts)) continue;
      if (
        insertMessage(storedMsg, 'poll', msg.media ? undefined : msg.mediaPending, msg.vcard)
      )
        stored++;
    }
  });
  tx(messages);
  if (stored > 0) broadcast({ type: 'chats-updated' });
  return stored;
}

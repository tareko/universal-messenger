import type { Capabilities, Chat, MediaRef, Message } from '../types.js';

/**
 * A provider-normalized inbound message. The ingest pipeline namespaces the id
 * (`<accountId>:<id>`), resolves/creates the chat, dedups, persists, and
 * broadcasts it. Providers only fill this shape and call `ingest()`.
 */
export interface NormalizedMessage {
  id: string; // provider-local message id (unique within the account)
  accountId: string;
  chatRemoteId: string; // contact tel / group id (provider-specific)
  chatType?: 'dm' | 'group' | 'channel';
  chatTitle?: string;
  contactRaw?: string;
  sender?: string; // group sender id; null/undefined for dm or own messages
  ts: number;
  date?: string;
  outgoing: boolean;
  body: string;
  mediaUrls?: string[]; // remote URLs the ingest pipeline should download+cache
  media?: MediaRef[]; // prebuilt local refs (e.g. a just-sent attachment)
  /** Serialized provider payload enabling on-demand download later (JSON). */
  mediaPending?: string;
  quotedRemoteId?: string; // provider-local id of the quoted message
  forwardedFrom?: string;
  carrierStatus?: string;
}

export interface OutgoingMedia {
  data: string; // base64 (no data: prefix)
  contentType: string;
  /** Original filename (documents keep their name on the receiving side). */
  name?: string;
}

export interface SendPayload {
  body: string;
  media?: OutgoingMedia[];
  quotedId?: string; // internal (namespaced) id of the message being replied to
  forwardedFrom?: string; // marked on the stored copy when forwarding
  /** @mentions to attach (picked via the composer autocomplete). */
  mentions?: { name: string; memberId: string }[];
}

export interface SendResult {
  id: string; // provider-local id of the sent message ('' if unknown)
}

/** Result of a provider detecting a non-message payload inside a text body. */
export interface InboundReaction {
  emoji: string;
  quoted: string; // provider-specific reference to the target (e.g. quoted text for SMS tapbacks)
}

/**
 * A messaging source (voip.ms, WhatsApp, Telegram, Mattermost, ...).
 * Implementations live under providers/<id>/ and register with the registry.
 */
export interface Provider {
  id: string;
  capabilities: Capabilities;
  /** Connect accounts and start receiving (poller, sockets, ...). */
  start(): Promise<void>;
  stop?(): void;
  /** Short human-readable status for the status bar. */
  status(): string;
  /** Send a message in a chat. Returns the provider-local message id. */
  send(chat: Chat, payload: SendPayload): Promise<SendResult>;
  /** React to a message (native or fallback, provider's business). */
  react?(chat: Chat, target: Message, emoji: string): Promise<void>;
  /**
   * Native forward of a message to another chat on the SAME provider/account.
   * If absent, the server falls back to sending a copy (body + media).
   */
  forward?(sourceChat: Chat, message: Message, targetChat: Chat): Promise<SendResult>;
  /**
   * Fetch older-than-stored history from the provider (scroll-back pagination).
   * Returns the number of messages ingested (0 = unsupported/exhausted).
   */
  fetchOlder?(chat: Chat, beforeTs: number): Promise<number>;
  /**
   * Mark a chat as read on the provider itself (clears unread badges on the
   * user's other devices). Optional; voip.ms has no such concept.
   */
  markRead?(chat: Chat): Promise<void>;
  /**
   * Lazily download a message's attachment (stored as media_pending at ingest
   * time, e.g. history-synced media). Broadcasts message-updated when done.
   */
  downloadPendingMedia?(message: Message): Promise<boolean>;
  /** Tell the provider we're typing in this chat (throttled by the client). */
  sendTyping?(chat: Chat): Promise<void>;
  /**
   * Subscribe to a chat's presence (typing) updates — WhatsApp only sends
   * presence for subscribed chats. Called when the user opens a chat.
   */
  subscribePresence?(chat: Chat): Promise<void>;
  /** Group member list for @mention autocomplete (null = not a group/unsupported). */
  fetchParticipants?(chat: Chat): Promise<{ id: string; name: string }[] | null>;
  /** Edit one of our own messages in place (where the service supports it). */
  editMessage?(chat: Chat, target: Message, newBody: string): Promise<void>;
  /** Fetch the chat/contact profile photo (null = unavailable). */
  fetchAvatar?(chat: Chat): Promise<{ data: Buffer; contentType: string } | null>;
  /**
   * Inspect an inbound text body; return non-null if it's actually a reaction
   * (e.g. iMessage tapback fallback over SMS) rather than a normal message.
   */
  classifyInbound?(body: string): InboundReaction | null;
}

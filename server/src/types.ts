export interface MediaRef {
  url: string; // local serving path, e.g. /api/media/<file>
  contentType: string;
  /** Original filename from the sender (for downloads/display). */
  name?: string;
}

export interface ReactionRef {
  emoji: string;
  from?: string; // sender id of the reactor ('me' for our own)
}

export type ChatType = 'dm' | 'group' | 'channel';

/** What a provider can do; the UI gates actions on this. */
export interface Capabilities {
  reply: boolean; // quoted replies
  react: boolean; // native emoji reactions
  forward: boolean;
  edit: boolean;
  delete: boolean;
  groups: boolean;
  attachments: boolean;
  /**
   * Native quotes can reference a message in a DIFFERENT chat on the same
   * account (WhatsApp: "reply privately" keeps a link to the group message).
   * When false, cross-chat quotes fall back to "> quoted text".
   */
  crossChatQuotes: boolean;
}

export interface Account {
  id: string; // '<provider>:<remote-id>', e.g. 'voipms:+12125550100'
  provider: string;
  label: string; // human-readable, e.g. phone number or username
  status: string; // 'active' | 'connecting' | 'error: ...'
  capabilities: Capabilities;
}

export interface Message {
  id: string; // globally unique: '<accountId>:<provider-msg-id>'
  chatId: string;
  accountId: string;
  ts: number; // epoch ms
  date: string; // display/provider date string ('' when n/a)
  outgoing: 0 | 1;
  sender: string | null; // group messages: who sent it; null for dm/own
  senderName?: string | null; // resolved display name (hydrated at query time)
  body: string;
  carrierStatus: string;
  read: number; // 0/1 (local only)
  media?: MediaRef[];
  /** True when the provider can lazily download this message's attachment. */
  mediaPending?: boolean;
  quotedId?: string | null;
  forwardedFrom?: string | null;
  edited?: number;
  /** 1 = delete-for-everyone tombstone (body/media blanked). */
  deleted?: number;
  /** Outgoing receipt status: 'sent' | 'delivered' | 'read' (providers that support it). */
  receipt?: string;
  /** A shared contact card (parsed from the stored vCard at query time). */
  contactCard?: { name: string; tel: string | null } | null;
  reactions?: ReactionRef[];
  /** Hydrated quote preview (resolved at query time). */
  quoted?: {
    id: string;
    chatId: string; // quoted message's chat (may differ from this message's)
    body: string;
    sender: string | null;
    outgoing: 0 | 1;
    senderName?: string | null;
    deleted?: number;
  } | null;
}

export interface Chat {
  id: string; // '<accountId>:<remote-id>'
  accountId: string;
  provider: string;
  type: ChatType;
  remoteId: string; // contact tel / group id, provider-specific
  contactRaw: string; // as reported by the provider
  title: string | null; // group title or provider-supplied name
  name: string | null; // resolved contact name (address book)
  unread: number;
  ts: number; // last message ts
  lastMessage?: Message;
  /** Disappearing messages duration in seconds (0 = off). */
  ephemeralSeconds?: number;
  /** Group chat pinned into the main chat list (Groups tab otherwise). */
  pinned?: number;
  /** Shelved conversation (Hidden tab until manually restored). */
  hidden?: number;
  /** AI translate action enabled for this chat (off by default). */
  translateEnabled?: number;
  /** Auto AI reply suggestions when the chat is opened. */
  suggestEnabled?: number;
}

export interface Contact {
  tel: string; // normalized E.164
  name: string;
  rawTel: string;
}

export interface Tag {
  id: number;
  name: string;
  description: string;
  color: string;
}

export type SseEvent =
  | { type: 'message'; data: Message }
  | { type: 'message-updated'; data: Message }
  | { type: 'message-deleted'; data: { id: string; chatId: string } }
  | { type: 'chats-updated' }
  | { type: 'typing'; data: { chatId: string; name: string | null; expiresAt: number } }
  | { type: 'accounts'; data: Account[] }
  | { type: 'contacts-refreshed'; data: { count: number } }
  | { type: 'status'; data: { providers: Record<string, string>; carddav: string } };

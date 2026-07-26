export interface MediaRef {
  url: string;
  contentType: string;
}

export interface ReactionRef {
  emoji: string;
  from?: string;
}

export type ChatType = 'dm' | 'group' | 'channel';

export interface Capabilities {
  reply: boolean;
  react: boolean;
  forward: boolean;
  edit: boolean;
  delete: boolean;
  groups: boolean;
  attachments: boolean;
}

export interface Account {
  id: string;
  provider: string;
  label: string;
  status: string;
  capabilities: Capabilities;
}

export interface Message {
  id: string;
  chatId: string;
  accountId: string;
  ts: number;
  date: string;
  outgoing: 0 | 1;
  sender: string | null;
  senderName?: string | null;
  body: string;
  carrierStatus: string;
  read: number;
  media?: MediaRef[];
  /** True when the attachment can be fetched on demand via /media/fetch. */
  mediaPending?: boolean;
  quotedId?: string | null;
  forwardedFrom?: string | null;
  edited?: number;
  /** 1 = delete-for-everyone tombstone (body/media blanked). */
  deleted?: number;
  /** Outgoing receipt status: 'sent' | 'delivered' | 'read' (where supported). */
  receipt?: string;
  reactions?: ReactionRef[];
  quoted?: {
    id: string;
    chatId: string; // quoted message's chat (may differ from this message's)
    body: string;
    sender: string | null;
    outgoing: 0 | 1;
    senderName?: string | null;
    deleted?: number;
  } | null;
  status?: 'sending' | 'sent' | 'failed'; // client-only outgoing state
  /** Failure reason when status === 'failed' (shown in tooltip/retry). */
  error?: string;
}

export interface Chat {
  id: string;
  accountId: string;
  provider: string;
  type: ChatType;
  remoteId: string;
  contactRaw: string;
  title: string | null;
  name: string | null;
  unread: number;
  ts: number;
  lastMessage?: Message;
  /** Disappearing messages duration in seconds (0/undefined = off). */
  ephemeralSeconds?: number;
  /** Group pinned into the main chat list (1) vs Groups tab (0). */
  pinned?: number;
  /** Shelved conversation (1 = Hidden tab until manually restored). */
  hidden?: number;
  /** Set when this chat is linked into a person (identity group). */
  personId?: number | null;
}

export interface Person {
  id: number;
  name: string;
  defaultChatId: string | null;
  sendMode: 'origin' | 'default';
  chatIds: string[];
}

export interface ProviderNotifyRules {
  enabled: boolean;
  dm: boolean;
  group: boolean;
  channel: boolean;
}

export interface NotifySettings {
  providers: Record<string, ProviderNotifyRules>;
  mutedChats: string[];
  unmutedChats: string[];
}

export interface Contact {
  tel: string;
  name: string;
  rawTel: string;
}

export interface AppStatus {
  providers: Record<string, string>;
  carddav: string;
  webhook: { configured: boolean; publicUrl: string };
  accounts: Account[];
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

import type { Account, AppStatus, Chat, Contact, Message, NotifySettings, Person, Tag } from './types';

const base = '/api';

/** Optional API token (APP_API_TOKEN) stored by the user via the login prompt. */
export function getToken(): string {
  return localStorage.getItem('um-token') ?? '';
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Pull a readable message out of an error response body ({error} JSON or text). */
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    /* not JSON */
  }
  return `${res.status} ${text}`;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(base + path, { headers: authHeaders() });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

export interface WhatsAppState {
  state: 'idle' | 'connecting' | 'qr' | 'open' | 'close' | 'unavailable';
  qr: string | null; // data URL when returned by /qr
  accountId: string | null;
}

export interface TelegramState {
  state:
    | 'idle'
    | 'needs-api'
    | 'awaiting-phone'
    | 'awaiting-code'
    | 'awaiting-password'
    | 'connecting'
    | 'open'
    | 'error'
    | 'unavailable';
  accountId: string | null;
  hasApiCreds: boolean;
}

export interface MattermostState {
  state: 'idle' | 'connecting' | 'open' | 'error' | 'unavailable';
  accountId: string | null;
  url: string;
  dmsOnly?: boolean;
}

export interface SignalState {
  state: 'idle' | 'connecting' | 'qr' | 'open' | 'error' | 'unavailable';
  accountId: string | null;
  url: string;
}

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string | null;
  siteName: string | null;
}

export const api = {
  status: () => getJson<AppStatus>('/status'),
  accounts: () => getJson<Account[]>('/accounts'),
  whatsappStatus: () => getJson<WhatsAppState>('/providers/whatsapp/status'),
  whatsappQr: () => getJson<WhatsAppState>('/providers/whatsapp/qr'),
  whatsappConnect: () => postJson<{ ok: boolean }>('/providers/whatsapp/connect', {}),
  whatsappLogout: () => postJson<{ ok: boolean }>('/providers/whatsapp/logout', {}),
  telegramStatus: () => getJson<TelegramState>('/providers/telegram/status'),
  telegramCredentials: (apiId: number, apiHash: string) =>
    postJson<{ ok: boolean }>('/providers/telegram/credentials', { apiId, apiHash }),
  telegramConnect: () => postJson<{ ok: boolean }>('/providers/telegram/connect', {}),
  telegramCredential: (value: string) =>
    postJson<{ ok: boolean }>('/providers/telegram/credential', { value }),
  telegramLogout: () => postJson<{ ok: boolean }>('/providers/telegram/logout', {}),
  mattermostStatus: () => getJson<MattermostState>('/providers/mattermost/status'),
  mattermostConnect: (url: string, token: string) =>
    postJson<{ ok: boolean }>('/providers/mattermost/connect', { url, token }),
  mattermostLogout: () => postJson<{ ok: boolean }>('/providers/mattermost/logout', {}),
  mattermostSettings: (dmsOnly: boolean) =>
    postJson<{ ok: boolean }>('/providers/mattermost/settings', { dmsOnly }),
  signalStatus: () => getJson<SignalState>('/providers/signal/status'),
  signalConfigure: (url: string) => postJson<{ ok: boolean }>('/providers/signal/configure', { url }),
  signalQrcode: () => getJson<{ qr: string | null }>('/providers/signal/qrcode'),
  signalLink: () => postJson<{ ok: boolean }>('/providers/signal/link', {}),
  signalDisconnect: () => postJson<{ ok: boolean }>('/providers/signal/disconnect', {}),
  notifySettings: () => getJson<NotifySettings>('/notify-settings'),
  saveNotifySettings: (s: NotifySettings) =>
    fetch(`${base}/notify-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(s),
    }).then(async (r) => {
      if (!r.ok) throw new Error(await errorMessage(r));
      return (await r.json()) as { ok: boolean };
    }),
  chats: (accountId?: string) =>
    getJson<Chat[]>(accountId ? `/chats?account=${encodeURIComponent(accountId)}` : '/chats'),
  newChat: (accountId: string, to: string) =>
    postJson<{ ok: boolean; chatId: string }>('/chats', { accountId, to }),
  dmChat: (chatId: string, sender: string) =>
    postJson<{ ok: boolean; chatId: string }>('/dm-chat', { chatId, sender }),
  messages: (chatId: string, before?: number) =>
    getJson<Message[]>(
      `/messages?chat=${encodeURIComponent(chatId)}${before ? `&before=${before}` : ''}`
    ),
  fetchOlder: (chatId: string) =>
    postJson<{ ok: boolean; fetched: number }>('/fetch-older', { chatId }),
  send: (chatId: string, message: string, quotedId?: string, mentions?: { name: string; memberId: string }[]) =>
    postJson<{ ok: boolean; id: string }>('/send', { chatId, message, quotedId, mentions }),
  sendMedia: (chatId: string, message: string, file: Blob, contentType: string) => {
    const fd = new FormData();
    fd.append('chatId', chatId);
    fd.append('message', message);
    fd.append('media', file, contentType.startsWith('image/') ? 'photo' : 'attachment');
    return fetch(base + '/send-media', { method: 'POST', headers: authHeaders(), body: fd }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return (await r.json()) as { ok: boolean; id: string };
    });
  },
  react: (chatId: string, messageId: string, emoji: string) =>
    postJson<{ ok: boolean }>('/react', { chatId, messageId, emoji }),
  editMessage: (messageId: string, text: string) =>
    postJson<{ ok: boolean }>('/edit', { messageId, text }),
  forward: (messageId: string, targetChatId: string) =>
    postJson<{ ok: boolean; id: string }>('/forward', { messageId, targetChatId }),
  markRead: (chatId: string) => postJson('/markread', { chatId }),
  pinChat: (chatId: string, pinned: boolean) =>
    postJson<{ ok: boolean }>('/chats/pin', { chatId, pinned }),
  hideChat: (chatId: string, hidden: boolean) =>
    postJson<{ ok: boolean }>('/chats/hide', { chatId, hidden }),
  setTranslateEnabled: (chatId: string, enabled: boolean) =>
    postJson<{ ok: boolean }>('/chats/translate', { chatId, enabled }),
  setSuggestEnabled: (chatId: string, enabled: boolean) =>
    postJson<{ ok: boolean }>('/chats/suggest', { chatId, enabled }),
  typing: (chatId: string) => postJson('/typing', { chatId }),
  fetchMedia: (messageId: string) =>
    postJson<{ ok: boolean; pending: boolean }>('/media/fetch', { messageId }),
  aiSuggest: (chatId: string) =>
    postJson<{ suggestions: string[] }>('/ai/suggest', { chatId }),
  aiTranslate: (text: string, targetLang?: string) =>
    postJson<{ translation: string }>('/ai/translate', { text, targetLang }),
  tags: () => getJson<Tag[]>('/tags'),
  createTag: (name: string, description: string, color: string) =>
    postJson<{ ok: boolean; id: number }>('/tags', { name, description, color }),
  deleteTag: (id: number) =>
    fetch(`${base}/tags/${id}`, { method: 'DELETE', headers: authHeaders() }).then(async (r) => {
      if (!r.ok) throw new Error(await errorMessage(r));
      return (await r.json()) as { ok: boolean };
    }),
  setChatTags: (chatId: string, tagIds: number[]) =>
    postJson<{ ok: boolean }>('/chats/tags', { chatId, tagIds }),
  removeChatTag: (chatId: string, tagId: number) =>
    fetch(`${base}/chats/tags/${encodeURIComponent(chatId)}/${tagId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }).then(async (r) => {
      if (!r.ok) throw new Error(await errorMessage(r));
      return (await r.json()) as { ok: boolean };
    }),
  aiClassifyStart: (force?: boolean) => postJson<{ ok: boolean }>('/ai/classify', { force }),
  aiClassifyStatus: () =>
    getJson<{ running: boolean; total: number; done: number; tagged: number; lastError?: string }>(
      '/ai/classify/status'
    ),
  aiClassifyChat: (chatId: string) => postJson<{ ok: boolean }>('/ai/classify-chat', { chatId }),
  aiStatsTags: () => postJson<{ frequentContacts: number }>('/ai/stats-tags', {}),
  linkPreview: (messageId: string) =>
    getJson<{ preview: LinkPreview | null }>(`/link-preview?msg=${encodeURIComponent(messageId)}`),
  whatsappCheck: (number: string) =>
    getJson<{ onWhatsApp: boolean | null }>(`/providers/whatsapp/check?number=${encodeURIComponent(number)}`),
  contactLookup: (tel: string) =>
    getJson<{ name: string | null; numbers: string[] }>(`/contacts/lookup?tel=${encodeURIComponent(tel)}`),
  people: () => getJson<Person[]>('/people'),
  createPerson: (name: string, chatIds: string[], defaultChatId?: string, sendMode?: string) =>
    postJson<{ ok: boolean; id: number }>('/people', { name, chatIds, defaultChatId, sendMode }),
  updatePerson: (id: number, patch: Record<string, unknown>) =>
    fetch(`${base}/people/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(patch),
    }).then(async (r) => {
      if (!r.ok) throw new Error(await errorMessage(r));
      return (await r.json()) as { ok: boolean };
    }),
  deletePerson: (id: number) =>
    fetch(`${base}/people/${id}`, { method: 'DELETE', headers: authHeaders() }).then(async (r) => {
      if (!r.ok) throw new Error(await errorMessage(r));
      return (await r.json()) as { ok: boolean };
    }),
  contacts: (q: string) => getJson<Contact[]>(`/contacts?q=${encodeURIComponent(q)}`),
  participants: (chatId: string) =>
    getJson<{ id: string; name: string }[]>(`/participants?chat=${encodeURIComponent(chatId)}`),
  search: (q: string) =>
    getJson<{ message: Message; chatId: string; chatName: string | null }[]>(
      `/search?q=${encodeURIComponent(q)}`
    ),
  refreshContacts: () => postJson('/contacts/refresh', {}),
  poll: () => postJson('/poll', {}),
  backfillHistory: () =>
    postJson<{ ok: boolean; from: string; to: string; newMessages: number; reachedLimit: boolean }>(
      '/backfill-history',
      {}
    ),
  applyWebhook: (accountId: string) => postJson('/webhook/apply', { accountId }),
};

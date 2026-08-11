import { Router } from 'express';
import multer from 'multer';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import {
  getChats,
  getMessages,
  getMessage,
  getChat,
  getOldestMessage,
  getOrCreateChat,
  markChatRead,
  searchContacts,
  searchMessages,
  getContactName,
  upsertContact,
  getKv,
  setKv,
  setChatPinned,
  setChatHidden,
  setChatsHidden,
  setChatTranslateEnabled,
  setChatSuggestEnabled,
  getChatParticipants,
  replaceChatParticipants,
  getParticipantsAge,
  getTags,
  createTag,
  deleteTag,
  setChatTags,
  getChatTagMap,
  removeChatTag,
  getPeople,
  getChatPersonMap,
  createPerson,
  updatePerson,
  addChatToPerson,
  removeChatFromPerson,
  deletePerson,
  dedupMessages,
  dedupReactionEvents,
  registerPushEndpoint,
  unregisterPushEndpoint,
} from '../store/db.js';
import { listAccounts, providerStatuses, providerForAccount, getProvider } from '../providers/registry.js';
import { runPollOnce, backfillHistoryChunk } from '../providers/voipms/poller.js';
import { VoipMsProvider } from '../providers/voipms/index.js';
import { WhatsAppProvider } from '../providers/whatsapp/index.js';
import { TelegramProvider } from '../providers/telegram/index.js';
import { MattermostProvider } from '../providers/mattermost/index.js';
import { SignalProvider } from '../providers/signal/index.js';
import { syncContacts, getCarddavStatus, updateContactPhoto, createContact } from '../contacts/carddav.js';
import { aiEnabled } from '../ai/actions.js';
import { config as appConfig } from '../config.js';
import { getNotifySettings, saveNotifySettings, type NotifySettings } from '../notify/settings.js';import { broadcast } from '../realtime/sse.js';
import { getMediaPath, mediaContentType, saveUploadedMedia, loadMediaBuffer, saveAvatar, getAvatarPath } from '../services/media.js';
import { backfillReactions } from '../services/backfill.js';
import { normalizeTel } from '../contacts/match.js';
import { ingest } from '../services/ingest.js';
import { nowVoipDate } from '../providers/voipms/client.js';
import { createHash } from 'node:crypto';

export const api = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // documents up to 100MB
});

// Optional bearer-token auth. If APP_API_TOKEN is unset (default), the backend
// is open and relies on the VPN for access control. Accepts a Bearer header or
// (for EventSource, which can't set headers) a ?token= query param.
export function checkAuth(req: { headers: { authorization?: string }; query: Record<string, unknown> }): boolean {
  if (!config.auth.token) return true;
  if (req.headers.authorization === `Bearer ${config.auth.token}`) return true;
  if (req.query && req.query.token === config.auth.token) return true;
  return false;
}

api.use((req, res, next) => {
  if (checkAuth(req as never)) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// ---------- WhatsApp onboarding ----------

function whatsapp(): WhatsAppProvider | null {
  return (getProvider('whatsapp') as WhatsAppProvider | undefined) ?? null;
}

/** Check whether a phone number is registered on WhatsApp (cached 6h). */
api.get('/providers/whatsapp/check', async (req, res) => {
  const number = String(req.query.number || '');
  if (!number) return res.status(400).json({ error: 'number required' });
  const digits = number.replace(/\D/g, '');
  const cacheKey = `wa-check:${digits}`;
  const cached = getKv(cacheKey);
  if (cached && Date.now() - Number(cached.split(':')[0]) < 6 * 3600_000) {
    return res.json({ onWhatsApp: cached.split(':')[1] === '1' });
  }
  const wa = whatsapp();
  if (!wa) return res.json({ onWhatsApp: null });
  const result = await wa.checkNumber(digits);
  if (result !== null) setKv(cacheKey, `${Date.now()}:${result ? '1' : '0'}`);
  res.json({ onWhatsApp: result });
});

api.get('/providers/whatsapp/status', (_req, res) => {
  res.json(whatsapp()?.getState() ?? { state: 'unavailable', qr: null, accountId: null });
});

api.post('/providers/whatsapp/connect', async (_req, res) => {
  try {
    await whatsapp()?.connect();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Current pairing QR as a PNG data URL (only while state === 'qr'). */
api.get('/providers/whatsapp/qr', async (_req, res) => {
  const wa = whatsapp();
  const st = wa?.getState();
  if (!st || st.state !== 'qr' || !st.qr) return res.json({ qr: null, state: st?.state ?? 'unavailable' });
  try {
    const QRCode = (await import('qrcode')).default;
    const dataUrl = await QRCode.toDataURL(st.qr, { margin: 1, width: 256 });
    res.json({ qr: dataUrl, state: st.state });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

api.post('/providers/whatsapp/logout', async (_req, res) => {
  try {
    await whatsapp()?.logout();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------- Telegram onboarding ----------

function telegram(): TelegramProvider | null {
  return (getProvider('telegram') as TelegramProvider | undefined) ?? null;
}

api.get('/providers/telegram/status', (_req, res) => {
  res.json(
    telegram()?.getPublicState() ?? { state: 'unavailable', accountId: null, hasApiCreds: false }
  );
});

/** Save api_id/api_hash from https://my.telegram.org (stored server-side only). */
api.post('/providers/telegram/credentials', (req, res) => {
  const { apiId, apiHash } = req.body as { apiId: number; apiHash: string };
  if (!apiId || !apiHash) return res.status(400).json({ error: 'apiId and apiHash required' });
  telegram()?.setCredentials(Number(apiId), String(apiHash));
  res.json({ ok: true });
});

/** Begin the sign-in flow (phone → code → optional 2FA, via /credential). */
api.post('/providers/telegram/connect', (_req, res) => {
  void telegram()
    ?.connect()
    .catch((e) => console.error('[telegram] connect failed:', (e as Error).message));
  res.json({ ok: true });
});

/** Submit the value the sign-in flow is waiting for (phone, code, or password). */
api.post('/providers/telegram/credential', (req, res) => {
  const { value } = req.body as { value: string };
  if (!value) return res.status(400).json({ error: 'value required' });
  telegram()?.provideCredential(String(value));
  res.json({ ok: true });
});

api.post('/providers/telegram/logout', async (_req, res) => {
  try {
    await telegram()?.logout();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------- Mattermost onboarding ----------

function mattermost(): MattermostProvider | null {
  return (getProvider('mattermost') as MattermostProvider | undefined) ?? null;
}

api.get('/providers/mattermost/status', (_req, res) => {
  res.json(
    mattermost()?.getPublicState() ?? { state: 'unavailable', accountId: null, url: '', dmsOnly: false }
  );
});

/** Toggle DMs-only sync (no group channels). Purges group chats when enabled. */
api.post('/providers/mattermost/settings', (req, res) => {
  const { dmsOnly } = req.body as { dmsOnly?: boolean };
  mattermost()?.setDmsOnly(Boolean(dmsOnly));
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true });
});

/** Connect with a server URL + personal access token (Profile → Security → Personal Access Tokens). */
api.post('/providers/mattermost/connect', async (req, res) => {
  try {
    const { url, token } = req.body as { url: string; token: string };
    if (!url || !token) return res.status(400).json({ error: 'url and token required' });
    await mattermost()?.connect(String(url), String(token));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

api.post('/providers/mattermost/logout', async (_req, res) => {
  try {
    await mattermost()?.logout();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i;

interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string | null;
  siteName: string | null;
}

function pickMeta(html: string, prop: string): string | null {
  const m =
    html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i')) ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i')) ??
    html.match(new RegExp(`<meta[^>]+name=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i')) ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']og:${prop}["']`, 'i'));
  return m ? m[1].trim() : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  const key = `linkprev:${createHash('sha1').update(url).digest('hex')}`;
  const cached = getKv(key);
  if (cached) {
    try {
      return JSON.parse(cached) as LinkPreview;
    } catch {
      /* refetch */
    }
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; universal-messenger/1.0; +https://localhost) AppleWebKit/537.36',
        Accept: 'text/html',
      },
    });
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || !ct.includes('text/html')) {
      // Cache failures briefly too — a slow/dead site shouldn't cost 8s every render.
      setKv(key, JSON.stringify(null));
      return null;
    }
    const html = (await res.text()).slice(0, 200_000);
    const title =
      pickMeta(html, 'title') ??
      html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ??
      '';
    const preview: LinkPreview = {
      url,
      title: decodeEntities(title).slice(0, 200),
      description: decodeEntities(pickMeta(html, 'description') ?? '').slice(0, 300),
      image: pickMeta(html, 'image'),
      siteName: pickMeta(html, 'site_name') ?? new URL(url).host,
    };
    setKv(key, JSON.stringify(preview));
    return preview;
  } catch {
    setKv(key, JSON.stringify(null)); // negative-cache fetch errors as well
    return null;
  }
}

/** Link preview for the first URL in a message body (cached 24h). */
api.get('/link-preview', async (req, res) => {
  const messageId = String(req.query.msg || '');
  const message = messageId ? getMessage(messageId) : null;
  if (!message) return res.status(404).json({ error: 'message not found' });
  const url = message.body.match(URL_RE)?.[0];
  if (!url) return res.json({ preview: null });
  const preview = await fetchLinkPreview(url);
  res.json({ preview });
});

// ---------- Signal onboarding (signal-cli REST sidecar) ----------

function signal(): SignalProvider | null {
  return (getProvider('signal') as SignalProvider | undefined) ?? null;
}

api.get('/providers/signal/status', (_req, res) => {
  res.json(signal()?.getPublicState() ?? { state: 'unavailable', accountId: null, url: '' });
});

/** Save the sidecar URL (default http://localhost:8080). */
api.post('/providers/signal/configure', async (req, res) => {
  const { url } = req.body as { url?: string };
  await signal()?.configure(url || 'http://localhost:8080');
  res.json({ ok: true });
});

/** The device-linking QR from the sidecar (PNG as data URL). */
api.get('/providers/signal/qrcode', async (_req, res) => {
  const qr = await signal()?.getLinkQr();
  if (!qr) return res.json({ qr: null });
  res.json({ qr: `data:${qr.contentType};base64,${qr.data}` });
});

/** Start waiting for the link to complete (polls the sidecar's accounts). */
api.post('/providers/signal/link', (_req, res) => {
  void signal()
    ?.waitForLink()
    .catch((e) => console.error('[signal] link failed:', (e as Error).message));
  res.json({ ok: true });
});

api.post('/providers/signal/disconnect', async (_req, res) => {
  try {
    await signal()?.disconnect();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Fine-grained notification settings (per-provider rules + muted chats). */
api.get('/notify-settings', (_req, res) => {
  res.json(getNotifySettings());
});

api.put('/notify-settings', (req, res) => {
  const body = req.body as NotifySettings;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'settings required' });
  saveNotifySettings({
    providers: body.providers ?? {},
    mutedChats: Array.isArray(body.mutedChats) ? body.mutedChats : [],
    unmutedChats: Array.isArray(body.unmutedChats) ? body.unmutedChats : [],
  });
  res.json({ ok: true });
});

/**
 * Resolve (creating if needed) the DM chat with a given sender on the same
 * account as an existing chat — used by "reply privately" from groups.
 */
api.post('/dm-chat', async (req, res) => {
  try {
    const { chatId, sender } = req.body as { chatId: string; sender: string };
    if (!chatId || !sender) return res.status(400).json({ error: 'chatId and sender required' });
    const chat = getChat(chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const provider = providerForAccount(chat.accountId);
    if (!provider) return res.status(400).json({ error: 'no provider for account' });

    if (chat.provider === 'mattermost') {
      // DM channels are opaque hashes — create/find via the API.
      const mm = provider as MattermostProvider;
      const channelId = await mm.createDmChannel(sender);
      const dm = getOrCreateChat(chat.accountId, channelId, {
        type: 'dm',
        contactRaw: sender,
        title: sender,
      });
      return res.json({ ok: true, chatId: dm.id });
    }

    if (chat.provider === 'voipms') {
      return res.status(400).json({ error: 'no groups on this service' });
    }

    // whatsapp/signal: sender is a phone; telegram: sender is 'user:<id>'.
    const dm = getOrCreateChat(chat.accountId, sender, { type: 'dm', contactRaw: sender });
    res.json({ ok: true, chatId: dm.id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Pin/unpin a group chat into the main chat list. */
api.post('/chats/pin', (req, res) => {
  const { chatId, pinned } = req.body as { chatId: string; pinned: boolean };
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  setChatPinned(chatId, Boolean(pinned));
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true });
});

/** Enable/disable the AI translate action for a chat. */
api.post('/chats/translate', (req, res) => {
  const { chatId, enabled } = req.body as { chatId: string; enabled: boolean };
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  setChatTranslateEnabled(chatId, Boolean(enabled));
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true });
});

/** Enable/disable auto AI reply suggestions on chat open. */
api.post('/chats/suggest', (req, res) => {
  const { chatId, enabled } = req.body as { chatId: string; enabled: boolean };
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  setChatSuggestEnabled(chatId, Boolean(enabled));
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true });
});

/**
 * Hide/unhide a conversation. Also accepts 'person:N' — hides (or restores)
 * ALL of that person's linked chats at once. Hiding also mutes.
 */
api.post('/chats/hide', (req, res) => {
  const { chatId, hidden } = req.body as { chatId: string; hidden: boolean };
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const keys: string[] = [];
  if (chatId.startsWith('person:')) {
    const person = getPeople().find((p) => p.id === Number(chatId.slice(7)));
    if (!person) return res.status(404).json({ error: 'person not found' });
    setChatsHidden(person.chatIds, Boolean(hidden));
    keys.push(...person.chatIds, chatId);
  } else {
    setChatHidden(chatId, Boolean(hidden));
    keys.push(chatId);
  }
  // Hiding also mutes (unhide unmutes).
  const settings = getNotifySettings();
  const mutedChats = hidden
    ? [...new Set([...settings.mutedChats, ...keys])]
    : settings.mutedChats.filter((c) => !keys.includes(c));
  saveNotifySettings({ ...settings, mutedChats });
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true });
});

api.get('/status', (_req, res) => {
  res.json({
    providers: providerStatuses(),
    carddav: getCarddavStatus(),
    webhook: { configured: Boolean(config.webhook.key), publicUrl: config.webhook.publicUrl },
    accounts: listAccounts(),
    ai: { enabled: aiEnabled(), model: aiEnabled() ? appConfig.ai.model : null },
  });
});

api.get('/accounts', (_req, res) => {
  res.json(listAccounts());
});

api.get('/chats', (req, res) => {
  const account = String(req.query.account || '');
  const chats = getChats(account || undefined);
  const personMap = getChatPersonMap();
  const tagMap = getChatTagMap();
  res.json(chats.map((c) => ({ ...c, personId: personMap.get(c.id) ?? null, tags: tagMap.get(c.id) ?? [] })));
});

// ---------- tag taxonomy (manual management; AI classification is under /api/ai) ----------

api.get('/tags', (_req, res) => {
  res.json(getTags());
});

api.post('/tags', (req, res) => {
  const { name, description, color } = req.body as { name?: string; description?: string; color?: string };
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const id = createTag(name.trim().toLowerCase(), description ?? '', color ?? '#008069');
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true, id });
});

api.delete('/tags/:id', (req, res) => {
  deleteTag(Number(req.params.id));
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true });
});

/** Manually set a chat's tags (locks them against AI re-tagging). */
api.post('/chats/tags', (req, res) => {
  const { chatId, tagIds } = req.body as { chatId: string; tagIds: number[] };
  if (!chatId || !Array.isArray(tagIds)) return res.status(400).json({ error: 'chatId and tagIds required' });
  setChatTags(
    chatId,
    tagIds.map((tagId) => ({ tagId, source: 'manual' as const }))
  );
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true });
});

api.delete('/chats/tags/:chatId/:tagId', (req, res) => {
  removeChatTag(String(req.params.chatId), Number(req.params.tagId));
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true });
});

// ---------- people (cross-provider identity linking) ----------

api.get('/people', (_req, res) => {
  res.json(getPeople());
});

api.post('/people', (req, res) => {
  const { name, chatIds, defaultChatId, sendMode } = req.body as {
    name: string;
    chatIds: string[];
    defaultChatId?: string;
    sendMode?: 'origin' | 'default';
  };
  if (!name || !Array.isArray(chatIds) || chatIds.length < 2) {
    return res.status(400).json({ error: 'name and at least 2 chatIds required' });
  }
  const id = createPerson(name, chatIds, defaultChatId ?? chatIds[0], sendMode ?? 'origin');
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true, id });
});

api.patch('/people/:id', (req, res) => {
  const id = Number(req.params.id);
  const person = getPeople().find((p) => p.id === id);
  if (!person) return res.status(404).json({ error: 'person not found' });
  const { name, defaultChatId, sendMode, addChatIds, removeChatIds } = req.body as {
    name?: string;
    defaultChatId?: string;
    sendMode?: 'origin' | 'default';
    addChatIds?: string[];
    removeChatIds?: string[];
  };
  updatePerson(id, { name, defaultChatId, sendMode });
  for (const c of addChatIds ?? []) addChatToPerson(id, c);
  for (const c of removeChatIds ?? []) removeChatFromPerson(c);
  // If the person is down to one chat, dissolve the link entirely.
  const remaining = getPeople().find((p) => p.id === id);
  if (remaining && remaining.chatIds.length < 2) deletePerson(id);
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true });
});

api.delete('/people/:id', (req, res) => {
  deletePerson(Number(req.params.id));
  broadcast({ type: 'chats-updated' });
  res.json({ ok: true });
});

api.get('/messages', (req, res) => {
  const chatId = String(req.query.chat || '');
  if (!chatId) return res.status(400).json({ error: 'chat required' });
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const before = req.query.before ? Number(req.query.before) : undefined;
  res.json(getMessages(chatId, limit, before));
});

/**
 * Ask the provider to fetch history older than what we have stored
 * (scroll-back pagination). Only providers with fetchOlder support it.
 */
api.post('/fetch-older', async (req, res) => {
  try {
    const { chatId } = req.body as { chatId: string };
    if (!chatId) return res.status(400).json({ error: 'chatId required' });
    const chat = getChat(chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const provider = providerForAccount(chat.accountId);
    if (!provider?.fetchOlder) return res.json({ ok: true, fetched: 0 });
    const oldest = getOldestMessage(chatId);
    const fetched = await provider.fetchOlder(chat, oldest?.ts ?? Date.now());
    if (fetched > 0) broadcast({ type: 'chats-updated' });
    res.json({ ok: true, fetched });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Start a new dm chat (e.g. from a contact search or a raw number). */
api.post('/chats', (req, res) => {
  const { accountId, to } = req.body as { accountId: string; to: string };
  if (!accountId || !to) return res.status(400).json({ error: 'accountId and to required' });
  const provider = providerForAccount(accountId);
  if (!provider) return res.status(404).json({ error: 'unknown account' });
  const remote = normalizeTel(to) ?? to;
  const chat = getOrCreateChat(accountId, remote, { contactRaw: to });
  res.json({ ok: true, chatId: chat.id });
});

/** Build the "> quoted text" fallback body for cross-provider/unsupported quotes. */
function withQuoteFallback(
  message: string,
  quotedId: string | undefined,
  chatId: string,
  accountId: string,
  caps: { reply: boolean; crossChatQuotes: boolean }
): { body: string; quotedId?: string } {
  if (!quotedId) return { body: message };
  const target = getMessage(quotedId);
  // Native quoting requires same account AND (same chat OR a provider that
  // supports cross-chat quote references, like WhatsApp's reply-privately).
  const sameAccount = target?.accountId === accountId;
  const chatOk = target?.chatId === chatId || caps.crossChatQuotes;
  if (target && sameAccount && chatOk && caps.reply) {
    return { body: message, quotedId };
  }
  if (!target) return { body: message };
  const author = target.outgoing === 1 ? 'You' : (target.senderName ?? target.sender ?? '');
  const quotedLines = (target.body || '📎 Attachment')
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  const header = author ? `> ${author}:\n` : '';
  return { body: `${header}${quotedLines}\n\n${message}` };
}

/** Group participants for @mention autocomplete (cached, hourly refresh). */
api.get('/participants', async (req, res) => {
  const chatId = String(req.query.chat || '');
  if (!chatId) return res.status(400).json({ error: 'chat required' });
  const chat = getChat(chatId);
  if (!chat) return res.status(404).json({ error: 'chat not found' });
  if (getChatParticipants(chatId).length === 0 || getParticipantsAge(chatId) > 3600_000) {
    const provider = providerForAccount(chat.accountId);
    if (provider?.fetchParticipants) {
      try {
        const members = await provider.fetchParticipants(chat);
        if (members && members.length) replaceChatParticipants(chatId, members);
      } catch {
        /* serve whatever we have */
      }
    }
  }
  res.json(getChatParticipants(chatId));
});

api.post('/send', async (req, res) => {
  try {
    const { chatId, message, quotedId, mentions } = req.body as {
      chatId: string;
      message: string;
      quotedId?: string;
      mentions?: { name: string; memberId: string }[];
    };
    if (!chatId || !message) return res.status(400).json({ error: 'chatId, message required' });
    const chat = getChat(chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const provider = providerForAccount(chat.accountId);
    if (!provider) return res.status(400).json({ error: 'no provider for account' });

    // Quoting is only native within the same account. Cross-provider quotes
    // (and providers without replies, e.g. SMS) fall back to "> quoted text".
    const q = withQuoteFallback(message, quotedId, chatId, chat.accountId, provider.capabilities);
    const result = await provider.send(chat, { body: q.body, quotedId: q.quotedId, mentions });
    res.json({ ok: true, id: result.id ? `${chat.accountId}:${result.id}` : '' });
  } catch (err) {
    console.error('[api] send failed:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Send a message with an attachment (multipart upload — images or documents). */
api.post('/send-media', upload.single('media'), async (req, res) => {
  try {
    const chatId = String(req.body?.chatId || '');
    const message = String(req.body?.message || '');
    const file = req.file;
    if (!chatId || !file) {
      return res.status(400).json({ error: 'chatId and media file required' });
    }
    const chat = getChat(chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const provider = providerForAccount(chat.accountId);
    if (!provider) return res.status(400).json({ error: 'no provider for account' });
    if (!provider.capabilities.attachments) {
      return res.status(400).json({ error: 'provider does not support attachments' });
    }

    const q = withQuoteFallback(
      message,
      req.body?.quotedId ? String(req.body.quotedId) : undefined,
      chatId,
      chat.accountId,
      provider.capabilities
    );
    const fileName = req.body?.filename ? String(req.body.filename) : undefined;
    const result = await provider.send(chat, {
      body: q.body,
      quotedId: q.quotedId,
      media: [{ data: file.buffer.toString('base64'), contentType: file.mimetype, name: fileName }],
    });
    res.json({ ok: true, id: result.id ? `${chat.accountId}:${result.id}` : '' });
  } catch (err) {
    console.error('[api] send-media failed:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Kick off a lazy attachment download for a message (media_pending set at
 * ingest, e.g. history-synced WhatsApp media). Returns immediately; the
 * provider broadcasts message-updated when the file is cached.
 */
api.post('/media/fetch', (req, res) => {
  const { messageId } = req.body as { messageId: string };
  if (!messageId) return res.status(400).json({ error: 'messageId required' });
  const message = getMessage(messageId);
  if (!message) return res.status(404).json({ error: 'message not found' });
  const provider = providerForAccount(message.accountId);
  if (!provider?.downloadPendingMedia) return res.json({ ok: true, pending: false });
  void provider.downloadPendingMedia(message).catch((e) =>
    console.error('[api] media fetch failed:', (e as Error).message)
  );
  res.json({ ok: true, pending: true });
});

/** Edit one of our own messages in place (where the service supports it). */
api.post('/edit', async (req, res) => {
  try {
    const { messageId, text } = req.body as { messageId: string; text: string };
    if (!messageId || !text?.trim()) return res.status(400).json({ error: 'messageId, text required' });
    const target = getMessage(messageId);
    if (!target) return res.status(404).json({ error: 'message not found' });
    if (target.outgoing !== 1) return res.status(400).json({ error: 'can only edit own messages' });
    const chat = getChat(target.chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const provider = providerForAccount(chat.accountId);
    if (!provider?.editMessage) {
      return res.status(400).json({ error: 'editing not supported on this service' });
    }
    await provider.editMessage(chat, target, text.trim());
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] edit failed:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Serve a cached media attachment. */
api.get('/media/:file', (req, res) => {
  const file = basename(String(req.params.file));
  const path = getMediaPath(file);
  if (!existsSync(path)) return res.status(404).send('not found');
  res.setHeader('Content-Type', mediaContentType(file));
  // Content-hashed filename = safe to treat as immutable.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path);
});

/** Serve a cached avatar file. */
api.get('/media/avatars/:file', (req, res) => {
  const file = basename(String(req.params.file));
  const path = getAvatarPath(file);
  if (!existsSync(path)) return res.status(404).send('not found');
  res.setHeader('Content-Type', mediaContentType(file));
  // Content-hashed filename = safe to treat as immutable.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path);
});

/**
 * Avatar for a chat. Serves the cache if fresh; otherwise kicks a BACKGROUND
 * provider fetch and answers immediately ({retry: true}) so slow provider
 * lookups (WhatsApp profilePictureUrl can take 16s) never occupy a browser
 * connection slot and stall everything else.
 */
const avatarInflight = new Set<string>();

api.get('/avatar/:chatId', async (req, res) => {
  try {
    const chatId = String(req.params.chatId);
    const chat = getChat(chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });

    const key = `avatar:${chatId}`;
    const cached = getKv(key);
    if (cached) {
      const { url, ts } = JSON.parse(cached) as { url: string | null; ts: number };
      // Photos cache a week; misses only 15 minutes (provider may have been
      // mid-connect when it failed).
      const freshFor = url ? 7 * 86400000 : 900_000;
      if (Date.now() - ts < freshFor) return res.json({ url });
    }

    // Kick the provider fetch in the background and answer immediately.
    const provider = providerForAccount(chat.accountId);
    if (provider?.fetchAvatar && provider.status() === 'open' && !avatarInflight.has(chatId)) {
      avatarInflight.add(chatId);
      void (async () => {
        try {
          const avatar = await provider.fetchAvatar!(chat);
          const ref = avatar ? saveAvatar(chatId, avatar.data, avatar.contentType) : null;
          setKv(key, JSON.stringify({ url: ref?.url ?? null, ts: Date.now() }));
        } catch {
          setKv(key, JSON.stringify({ url: null, ts: Date.now() }));
        } finally {
          avatarInflight.delete(chatId);
        }
      })();
    }
    res.json({ url: null, retry: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Save a chat's avatar into the DAV contact card's PHOTO property. */
api.post('/avatar/pick', async (req, res) => {
  try {
    const { chatId, avatarChatId } = req.body as { chatId: string; avatarChatId?: string };
    const chat = chatId ? getChat(chatId) : null;
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const sourceChat = avatarChatId ? getChat(avatarChatId) : chat;
    if (!sourceChat) return res.status(404).json({ error: 'source chat not found' });

    // Resolve a phone for the contact: the chat itself, or a linked member chat.
    let tel = chat.remoteId.startsWith('+') ? chat.remoteId : null;
    if (!tel) {
      const personId = getChatPersonMap().get(chatId);
      if (personId !== undefined) {
        const person = getPeople().find((p) => p.id === personId);
        for (const memberId of person?.chatIds ?? []) {
          const member = getChat(memberId);
          if (member?.remoteId.startsWith('+')) {
            tel = member.remoteId;
            break;
          }
        }
      }
    }
    if (!tel) return res.status(400).json({ error: 'no phone number for this chat' });

    // Use the CACHED avatar when fresh (the photo you're clicking on!),
    // refetching from the provider only on a miss.
    let avatar: { data: Buffer; contentType: string } | null = null;
    const cachedRaw = getKv(`avatar:${sourceChat.id}`);
    if (cachedRaw) {
      const { url, ts } = JSON.parse(cachedRaw) as { url: string | null; ts: number };
      if (url && Date.now() - ts < 7 * 86400000) {
        const file = basename(url);
        try {
          avatar = {
            data: readFileSync(getAvatarPath(file)),
            contentType: mediaContentType(file),
          };
        } catch {
          /* fall through to refetch */
        }
      }
    }
    if (!avatar) {
      const provider = providerForAccount(sourceChat.accountId);
      avatar = provider?.fetchAvatar ? await provider.fetchAvatar(sourceChat) : null;
    }
    if (!avatar) return res.status(404).json({ error: 'no avatar available from this service' });

    const ok = await updateContactPhoto(tel, avatar.data, avatar.contentType);
    if (!ok) return res.status(502).json({ error: 'failed to write photo to the contact card' });
    // Picking a photo also updates the in-app avatar so it shows immediately.
    const ref = saveAvatar(chatId, avatar.data, avatar.contentType);
    setKv(`avatar:${chatId}`, JSON.stringify({ url: ref.url, ts: Date.now() }));
    broadcast({ type: 'chats-updated' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Upload a custom photo (user-provided) into the DAV contact card. */
api.post('/avatar/upload', upload.single('photo'), async (req, res) => {
  try {
    const { chatId } = req.body as { chatId: string };
    const file = req.file;
    const chat = chatId ? getChat(chatId) : null;
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    if (!file || !file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'image file required' });
    }

    let tel = chat.remoteId.startsWith('+') ? chat.remoteId : null;
    if (!tel) {
      const personId = getChatPersonMap().get(chatId);
      if (personId !== undefined) {
        const person = getPeople().find((p) => p.id === personId);
        for (const memberId of person?.chatIds ?? []) {
          const member = getChat(memberId);
          if (member?.remoteId.startsWith('+')) {
            tel = member.remoteId;
            break;
          }
        }
      }
    }
    if (!tel) return res.status(400).json({ error: 'no phone number for this chat' });

    const ok = await updateContactPhoto(tel, file.buffer, file.mimetype);
    if (!ok) return res.status(502).json({ error: 'failed to write photo to the contact card' });
    // Show the uploaded photo in-app too.
    const ref = saveAvatar(chatId, file.buffer, file.mimetype);
    setKv(`avatar:${chatId}`, JSON.stringify({ url: ref.url, ts: Date.now() }));
    broadcast({ type: 'chats-updated' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Render page 1 of a PDF attachment to PNG (poppler), cached beside the file. */
api.get('/media/pdf-thumb/:file', async (req, res) => {
  try {
    const file = basename(String(req.params.file));
    const src = getMediaPath(file);
    if (!existsSync(src)) return res.status(404).send('not found');
    const { createHash } = await import('node:crypto');
    const thumbName = `${createHash('sha1').update(file).digest('hex').slice(0, 20)}.thumb.png`;
    const thumbPath = getMediaPath(thumbName);
    if (!existsSync(thumbPath)) {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)(
        'pdftoppm',
        ['-f', '1', '-l', '1', '-png', '-singlefile', '-scale-to', '480', src, thumbPath.replace(/\.png$/, '')],
        { timeout: 15000 }
      );
    }
    if (!existsSync(thumbPath)) return res.status(404).send('no thumbnail');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(thumbPath);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** React to a message (native where supported, fallback text over SMS). */
api.post('/react', async (req, res) => {
  try {
    const { messageId, emoji } = req.body as {
      chatId?: string;
      messageId: string;
      emoji: string;
    };
    if (!messageId || !emoji) {
      return res.status(400).json({ error: 'messageId, emoji required' });
    }
    const target = getMessage(messageId);
    if (!target) return res.status(404).json({ error: 'message not found' });
    // Route via the target message's own chat — works for person selections
    // too (the passed chatId may be 'person:N' and not resolvable directly).
    const chat = getChat(target.chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const provider = providerForAccount(chat.accountId);
    if (!provider?.react) return res.status(400).json({ error: 'reactions not supported' });

    await provider.react(chat, target, emoji);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] react failed:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Forward a message to any chat. Uses the provider's native forward when the
 * target is on the same account and the provider implements it; otherwise
 * falls back to sending a copy (body + locally-cached media).
 */
api.post('/forward', async (req, res) => {
  try {
    const { messageId, targetChatId } = req.body as {
      messageId: string;
      targetChatId: string;
    };
    if (!messageId || !targetChatId) {
      return res.status(400).json({ error: 'messageId and targetChatId required' });
    }
    const message = getMessage(messageId);
    const targetChat = getChat(targetChatId);
    if (!message || !targetChat) return res.status(404).json({ error: 'not found' });
    const sourceChat = getChat(message.chatId);
    const provider = providerForAccount(targetChat.accountId);
    if (!provider) return res.status(400).json({ error: 'no provider for account' });

    let result;
    if (provider.forward && sourceChat && message.accountId === targetChat.accountId) {
      result = await provider.forward(sourceChat, message, targetChat);
    } else {
      if (!message.body && !message.media?.length) {
        return res.status(400).json({ error: 'nothing to forward' });
      }
      const media = (message.media ?? [])
        .map((m) => loadMediaBuffer(m))
        .filter((m): m is { data: string; contentType: string } => m !== null);
      result = await provider.send(targetChat, {
        body: message.body,
        media: media.length ? media : undefined,
        forwardedFrom: message.chatId,
      });
    }
    broadcast({ type: 'chats-updated' });
    res.json({ ok: true, id: result.id ? `${targetChat.accountId}:${result.id}` : '' });
  } catch (err) {
    console.error('[api] forward failed:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Relay "user is typing" to the provider (throttled client-side). */
api.post('/typing', (req, res) => {
  const { chatId } = req.body as { chatId: string };
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const chat = getChat(chatId);
  if (!chat) return res.status(404).json({ error: 'chat not found' });
  const provider = providerForAccount(chat.accountId);
  if (provider?.sendTyping) {
    provider.sendTyping(chat).catch(() => {
      /* non-fatal */
    });
  }
  res.json({ ok: true });
});

api.post('/markread', (req, res) => {
  const { chatId } = req.body as { chatId: string };
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  markChatRead(chatId);
  broadcast({ type: 'chats-updated' });
  // Best-effort: clear the unread badge on the provider too.
  const chat = getChat(chatId);
  if (chat) {
    const provider = providerForAccount(chat.accountId);
    if (provider?.markRead) {
      provider.markRead(chat).catch((e) =>
        console.error(`[api] provider markRead failed:`, (e as Error).message)
      );
    }
    // Opening a chat subscribes to its typing/presence updates (WhatsApp).
    if (provider?.subscribePresence) {
      provider.subscribePresence(chat).catch(() => {
        /* non-fatal */
      });
    }
  }
  res.json({ ok: true });
});

/** Full-text search across all message bodies. */
api.get('/search', (req, res) => {
  const q = String(req.query.q || '');
  if (!q.trim()) return res.json([]);
  res.json(searchMessages(q, 40));
});

api.get('/contacts', (req, res) => {
  const q = String(req.query.q || '');
  res.json(searchContacts(q, 50));
});

/** Create a contact in the DAV address book (e.g. from a received vCard). */
api.post('/contacts/add', async (req, res) => {
  const { name, tel } = req.body as { name?: string; tel?: string };
  if (!name?.trim() || !tel?.trim()) return res.status(400).json({ error: 'name and tel required' });
  const ok = await createContact(name.trim(), tel.trim());
  if (!ok) return res.status(502).json({ error: 'failed to create contact card' });
  // Optimistic local rename while the DAV sync catches up.
  upsertContact(tel.trim(), name.trim());
  broadcast({ type: 'chats-updated' });
  void syncContacts(); // refresh the local index in the background
  res.json({ ok: true });
});

/** A DAV contact's name + all their numbers (for channel switching). */
api.get('/contacts/lookup', (req, res) => {
  const tel = String(req.query.tel || '');
  if (!tel) return res.status(400).json({ error: 'tel required' });
  const name = getContactName(tel);
  if (!name) return res.json({ name: null, numbers: [] });
  const rows = searchContacts(name, 20).filter((c) => c.name === name);
  res.json({ name, numbers: rows.map((c) => c.tel) });
});

api.post('/contacts/refresh', async (_req, res) => {
  const count = await syncContacts();
  broadcast({ type: 'contacts-refreshed', data: { count } });
  res.json({ ok: true, count });
});

api.post('/poll', async (_req, res) => {
  const n = await runPollOnce();
  res.json({ ok: true, newMessages: n });
});

/** Fetch one older 90-day chunk of voip.ms history (the "Load older" button). */
api.post('/backfill-history', async (_req, res) => {
  try {
    const result = await backfillHistoryChunk();
    broadcast({ type: 'chats-updated' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Convert existing iMessage-style reaction texts into reaction badges. */
api.post('/backfill-reactions', (_req, res) => {
  const result = backfillReactions();
  res.json({ ok: true, ...result });
});

/** Remove duplicate bubbles created by voip.ms group-MMS leg expansion. */
api.post('/dedup', (_req, res) => {
  const messages = dedupMessages();
  const reactions = dedupReactionEvents();
  res.json({ ok: true, removedMessages: messages, removedReactions: reactions });
});

/** Register a UnifiedPush/ntfy endpoint for push (companion apps). */
api.post('/push/register', (req, res) => {
  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  registerPushEndpoint(endpoint);
  res.json({ ok: true });
});

api.post('/push/unregister', (req, res) => {
  const { endpoint } = req.body as { endpoint?: string };
  if (endpoint) unregisterPushEndpoint(endpoint);
  res.json({ ok: true });
});

/** Apply the voip.ms SMS URL callback to a DID (webhook setup helper). */
api.post('/webhook/apply', async (req, res) => {
  try {
    const { accountId } = req.body as { accountId: string };
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    if (!config.webhook.key || !config.webhook.publicUrl) {
      return res.status(400).json({ error: 'WEBHOOK_KEY and PUBLIC_WEBHOOK_URL must be set' });
    }
    const url = `${config.webhook.publicUrl}/api/webhook/inbound?to={TO}&from={FROM}&message={MESSAGE}&id={ID}&date={TIMESTAMP}&media={MEDIA}&key=${config.webhook.key}`;
    await VoipMsProvider.applyWebhook(accountId.slice('voipms:'.length), url);
    res.json({ ok: true, url });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * voip.ms inbound SMS callback. Accepts GET (per spec). voip.ms may delimit params
 * with ';' or '&', so we parse both. Must respond with the literal text "ok".
 */
api.all('/webhook/inbound', (req, res) => {
  try {
    if (!config.webhook.key) return res.status(503).send('webhook disabled');
    const params: Record<string, string> = {};
    const qIndex = req.url.indexOf('?');
    const qs = qIndex >= 0 ? req.url.slice(qIndex + 1) : '';
    for (const pair of qs.split(/[&;]/)) {
      if (!pair) continue;
      const [k, ...rest] = pair.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(rest.join('='));
    }

    if (!params.key || params.key !== config.webhook.key) {
      return res.status(401).send('unauthorized');
    }

    const from = params.from || params.FROM || '';
    const to = params.to || params.TO || '';
    const id = params.id || params.ID || `hw-${Date.now()}`;
    const date = params.date || params.TIMESTAMP || nowVoipDate();
    const text = params.message || params.MESSAGE || '';
    if (!from || !to) return res.send('ok'); // nothing to do, still ack

    const did = normalizeTel(to) ?? to;
    const contact = normalizeTel(from) ?? from;
    void ingest(
      {
        id: String(id),
        accountId: `voipms:${did}`,
        chatRemoteId: contact,
        contactRaw: from,
        ts: Date.now(),
        date,
        outgoing: false,
        body: text.replace(/\+/g, ' '),
      },
      'webhook'
    );
    res.send('ok');
  } catch (err) {
    console.error('[webhook] error:', (err as Error).message);
    res.send('ok'); // always ack so voip.ms doesn't retry-loop
  }
});

/** Save an uploaded media buffer without sending (shared by future providers). */
api.post('/media/upload', upload.single('media'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'media file required' });
  const ref = saveUploadedMedia(file.buffer, file.mimetype);
  res.json({ ok: true, ...ref });
});

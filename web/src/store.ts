import { create } from 'zustand';
import { api } from './api';
import type { Account, AppStatus, Chat, Message, NotifySettings, Person } from './types';

export function isPersonSelection(sel: string | null): boolean {
  return sel?.startsWith('person:') ?? false;
}

export interface StoreState {
  status: AppStatus | null;
  sseStatus: 'connecting' | 'connected';
  accounts: Account[];
  /** 'all' or an account id — filters the chat list. */
  selectedAccount: string;

  chats: Chat[];
  people: Person[];
  notifySettings: NotifySettings;
  selectedChat: string | null; // chat id, or 'person:<id>' for a linked person
  messages: Message[];
  replyTo: Message | null; // message being quoted in the composer
  editing: Message | null; // message being edited in the composer
  /** Unsent composer text retained per chat. */
  drafts: Record<string, string>;
  /** AI suggestion cache per chat, keyed to the latest message ts at fetch time. */
  suggestionCache: Record<string, { lastTs: number; items: string[] }>;
  /** Persistent per-chat avatar upload failure (visible until next success). */
  avatarErrors: Record<string, string>;
  /** Bumped whenever an avatar is primed — tells mounted Avatars to refresh. */
  avatarVersion: number;
  hasOlder: boolean; // more history available (DB or provider-side)
  loadingOlder: boolean;
  unreadAtOpen: number; // unread count captured when the chat was opened
  /** Message id to scroll to once the target chat loads (cross-chat quote jump). */
  pendingJump: string | null;
  /** True once the first message fetch for the open chat has completed. */
  messagesLoaded: boolean;
  /** chatId → who is typing there (auto-expires). */
  typing: Record<string, { name: string | null; expiresAt: number }>;
  /** Bumped on every send — the thread scrolls to the bottom when it changes. */
  scrollNonce: number;

  loading: boolean;
  error: string | null;

  init: () => Promise<void>;
  selectAccount: (accountId: string) => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  closeChat: () => void;
  openNewChat: (to: string) => Promise<void>;
  refreshChats: () => Promise<void>;
  refreshPeople: () => Promise<void>;
  saveNotifySettings: (s: NotifySettings) => Promise<void>;
  toggleMute: (key: string) => Promise<void>;
  refreshMessages: () => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  backfillHistory: () => Promise<{ newMessages: number; reachedLimit: boolean }>;
  sendMessage: (text: string, forceChatId?: string, mentions?: { name: string; memberId: string }[]) => Promise<void>;
  sendMedia: (
    file: Blob,
    contentType: string,
    text: string,
    previewUrl?: string,
    forceChatId?: string,
    filename?: string
  ) => Promise<void>;
  retryText: (id: string, text: string) => Promise<void>;
  reactMessage: (messageId: string, emoji: string) => Promise<void>;
  forwardMessage: (messageId: string, targetChatId: string) => Promise<void>;
  replyPrivately: (msg: Message) => Promise<void>;
  setReplyTo: (msg: Message | null) => void;
  setEditing: (msg: Message | null) => void;
  submitEdit: (text: string) => Promise<void>;
  setDraft: (chatId: string, text: string) => void;
  setSuggestionCache: (chatId: string, lastTs: number, items: string[]) => void;
  setAvatarError: (chatId: string, error: string | null) => void;
  bumpAvatarVersion: () => void;
  /** Effective chat id for actions (resolves person selections to a real chat). */
  targetChatId: () => string | null;
  markRead: (chatId: string) => Promise<void>;
  setStatus: (s: AppStatus) => void;
  patchStatus: (p: { providers?: Record<string, string>; carddav?: string }) => void;
  setAccounts: (a: Account[]) => void;
  onMessage: (msg: Message) => Promise<void>;
  onMessageUpdated: (msg: Message) => void;
  onMessageDeleted: (id: string) => void;
  onTyping: (data: { chatId: string; name: string | null; expiresAt: number }) => void;
  setPendingJump: (id: string | null) => void;
}

export const useStore = create<StoreState>((set, get) => ({
  status: null,
  sseStatus: 'connecting',
  accounts: [],
  selectedAccount: 'all',
  chats: [],
  people: [],
  notifySettings: { providers: {}, mutedChats: [], unmutedChats: [] },
  selectedChat: null,
  messages: [],
  replyTo: null,
  editing: null,
  drafts: {},
  suggestionCache: {},
  avatarErrors: {},
  avatarVersion: 0,
  hasOlder: true,
  loadingOlder: false,
  unreadAtOpen: 0,
  pendingJump: null,
  messagesLoaded: false,
  typing: {},
  scrollNonce: 0,
  loading: false,
  error: null,

  init: async () => {
    set({ loading: true, error: null });
    try {
      const status = await api.status();
      const accounts = status.accounts?.length ? status.accounts : await api.accounts();
      const [people, notifySettings] = await Promise.all([api.people(), api.notifySettings()]);
      set({ status, accounts, people, notifySettings, loading: false });
      await get().refreshChats();
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  selectAccount: async (accountId: string) => {
    set({ selectedAccount: accountId });
    await get().refreshChats();
  },

  selectChat: async (chatId: string) => {
    (window as unknown as { __umChatT0?: number }).__umChatT0 = performance.now();
    // Capture the unread boundary BEFORE markRead zeroes it (summed across
    // member chats for a linked person), for the unread divider.
    let unread: number;
    if (isPersonSelection(chatId)) {
      const person = get().people.find((p) => `person:${p.id}` === chatId);
      unread = get()
        .chats.filter((c) => person?.chatIds.includes(c.id))
        .reduce((sum, c) => sum + c.unread, 0);
    } else {
      unread = get().chats.find((c) => c.id === chatId)?.unread ?? 0;
    }
    set({
      selectedChat: chatId,
      replyTo: null,
      editing: null,
      hasOlder: true,
      // Keep failed/in-flight bubbles for this chat so they survive switching.
      messages: get().messages.filter(
        (m) =>
          (m.status === 'failed' || m.status === 'sending') &&
          (isPersonSelection(chatId)
            ? (get().people.find((p) => `person:${p.id}` === chatId)?.chatIds ?? []).includes(m.chatId)
            : m.chatId === chatId)
      ),
      messagesLoaded: false,
      unreadAtOpen: unread,
    });
    // Fire-and-forget: don't block the message fetch behind roundtrips.
    void get().markRead(chatId);
    await get().refreshMessages();
  },

  closeChat: () => {
    set({ selectedChat: null, messages: [], replyTo: null });
  },

  openNewChat: async (to: string) => {
    const { accounts, selectedAccount } = get();
    // New chats by phone number only make sense on an SMS-capable account.
    const account =
      (selectedAccount !== 'all' ? accounts.find((a) => a.id === selectedAccount) : undefined) ??
      accounts.find((a) => a.provider === 'voipms');
    if (!account) {
      set({ error: 'No SMS-capable account to start a chat from' });
      return;
    }
    try {
      const r = await api.newChat(account.id, to);
      await get().refreshChats();
      await get().selectChat(r.chatId);
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  refreshChats: async () => {
    const { selectedAccount } = get();
    try {
      const chats = await api.chats(selectedAccount === 'all' ? undefined : selectedAccount);
      set({ chats, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  refreshPeople: async () => {
    try {
      const people = await api.people();
      set({ people });
    } catch {
      /* non-fatal */
    }
  },

  saveNotifySettings: async (s: NotifySettings) => {
    set({ notifySettings: s });
    try {
      await api.saveNotifySettings(s);
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  /**
   * Toggle notifications for a chat ('<chatId>') or person ('person:<id>').
   * Groups/channels are muted by default — toggling there UNMUTES
   * (adds an unmute override); elsewhere it MUTES.
   */
  toggleMute: async (key: string) => {
    const { notifySettings, chats } = get();
    const chat = chats.find((c) => c.id === key);
    const defaultMuted = chat ? chat.type !== 'dm' && !chat.pinned : false;
    const effectivelyMuted =
      notifySettings.mutedChats.includes(key) || (defaultMuted && !notifySettings.unmutedChats.includes(key));
    const mutedChats = effectivelyMuted
      ? notifySettings.mutedChats.filter((c) => c !== key)
      : [...notifySettings.mutedChats.filter((c) => c !== key), key];
    const unmutedChats = effectivelyMuted
      ? [...notifySettings.unmutedChats.filter((c) => c !== key), key]
      : notifySettings.unmutedChats.filter((c) => c !== key);
    await get().saveNotifySettings({ ...notifySettings, mutedChats, unmutedChats });
  },

  refreshMessages: async () => {
    const sel = get().selectedChat;
    if (!sel) return;
    try {
      const fetchT0 = performance.now();
      const ids = memberChatIds(get());
      const pages = await Promise.all(ids.map((id) => api.messages(id)));
      const fetchMs = performance.now() - fetchT0;
      if (fetchMs > 300) console.log(`[um] message fetch slow: ${Math.round(fetchMs)}ms (${ids.length} chats)`);
      // Stale-response guard: user switched chats while we were fetching.
      if (get().selectedChat !== sel) return;
      const { messages } = get();
      const mapped: Message[] = pages
        .flat()
        .map((m) => (m.outgoing === 1 ? ({ ...m, status: 'sent' } as Message) : m));
      // Merge (don't replace): keep already-loaded older pages and any
      // in-flight optimistic sends the server doesn't know yet.
      const byId = new Map<string, Message>(mapped.map((m) => [m.id, m]));
      for (const m of messages) {
        if (!byId.has(m.id)) byId.set(m.id, m);
      }
      const merged = [...byId.values()].sort((a, b) => a.ts - b.ts);
      set({ messages: merged, messagesLoaded: true });
    } catch (e) {
      set({ error: (e as Error).message, messagesLoaded: true });
    }
  },

  /** Load the next older page (DB first; if exhausted, ask the provider). */
  loadOlderMessages: async () => {
    const sel = get().selectedChat;
    const { loadingOlder, hasOlder } = get();
    if (!sel || loadingOlder || !hasOlder) return;
    set({ loadingOlder: true });
    try {
      const ids = memberChatIds(get());
      // Per member chat: oldest loaded ts → older DB page → provider fallback.
      const results = await Promise.all(
        ids.map(async (id) => {
          const oldest = get().messages.filter((m) => m.chatId === id)[0]?.ts;
          if (oldest === undefined) return { id, msgs: [] as Message[], exhausted: true };
          let msgs = await api.messages(id, oldest);
          let exhausted = msgs.length < 100;
          if (exhausted) {
            const r = await api.fetchOlder(id);
            if (r.fetched > 0) {
              msgs = await api.messages(id, oldest);
              exhausted = false;
            }
          }
          return { id, msgs, exhausted };
        })
      );
      if (get().selectedChat !== sel) {
        set({ loadingOlder: false });
        return;
      }
      const byId = new Map<string, Message>();
      let allExhausted = true;
      for (const r of results) {
        for (const m of r.msgs) byId.set(m.id, m);
        if (!r.exhausted) allExhausted = false;
      }
      for (const m of get().messages) if (!byId.has(m.id)) byId.set(m.id, m);
      set({
        messages: [...byId.values()].sort((a, b) => a.ts - b.ts),
        hasOlder: !allExhausted,
        loadingOlder: false,
      });
    } catch (e) {
      set({ loadingOlder: false, error: (e as Error).message });
    }
  },

  backfillHistory: async () => {
    try {
      const r = await api.backfillHistory();
      await get().refreshChats();
      await get().refreshMessages();
      return { newMessages: r.newMessages, reachedLimit: r.reachedLimit };
    } catch (e) {
      set({ error: (e as Error).message });
      return { newMessages: 0, reachedLimit: true };
    }
  },

  sendMessage: async (text: string, forceChatId?: string, mentions?: { name: string; memberId: string }[]) => {
    const { selectedChat, messages, chats, replyTo } = get();
    const body = text.trim();
    if (!selectedChat || !body) return;
    void get().markRead(selectedChat); // replying = actively reading
    // Linked person: route to default chat, or the chat of the last incoming
    // message ("reply via originating service").
    const targetChatId = resolveTargetChat(get(), forceChatId);
    const chat = chats.find((c) => c.id === targetChatId);
    const quoted = replyTo
      ? {
          id: replyTo.id,
          chatId: replyTo.chatId,
          body: replyTo.body,
          sender: replyTo.sender,
          outgoing: replyTo.outgoing,
        }
      : null;
    set({ replyTo: null });
    const now = Date.now();
    const optId = `opt-${now}-${Math.random().toString(36).slice(2, 6)}`;
    const opt: Message = {
      id: optId,
      chatId: targetChatId,
      accountId: chat?.accountId ?? '',
      date: clientDate(now),
      ts: now,
      outgoing: 1,
      sender: null,
      body,
      carrierStatus: '',
      read: 0,
      status: 'sending',
      quoted,
    };
    set({ messages: [...messages, opt], scrollNonce: get().scrollNonce + 1 });
    bumpChat(targetChatId, opt, set);
    try {
      const res = await api.send(targetChatId, body, quoted?.id, mentions);
      patchMessage(set, optId, { id: res.id || optId, status: 'sent' });
    } catch (e) {
      patchMessage(set, optId, { status: 'failed', error: (e as Error).message });
      set({ error: (e as Error).message });
    }
    void get().refreshChats();
  },

  sendMedia: async (
    file: Blob,
    contentType: string,
    text: string,
    previewUrl?: string,
    forceChatId?: string,
    filename?: string
  ) => {
    const { selectedChat, messages, chats } = get();
    const body = text.trim();
    if (!selectedChat) return;
    void get().markRead(selectedChat);
    const targetChatId = resolveTargetChat(get(), forceChatId);
    const chat = chats.find((c) => c.id === targetChatId);
    const now = Date.now();
    const optId = `opt-mms-${now}-${Math.random().toString(36).slice(2, 6)}`;
    const opt: Message = {
      id: optId,
      chatId: targetChatId,
      accountId: chat?.accountId ?? '',
      date: clientDate(now),
      ts: now,
      outgoing: 1,
      sender: null,
      body,
      carrierStatus: '',
      read: 0,
      status: 'sending',
      media: previewUrl ? [{ url: previewUrl, contentType }] : undefined,
    };
    set({ messages: [...messages, opt], scrollNonce: get().scrollNonce + 1 });
    bumpChat(targetChatId, opt, set);
    try {
      const res = await api.sendMedia(targetChatId, body, file, contentType, filename);
      patchMessage(set, optId, { id: res.id || optId, status: 'sent' });
      // Free the optimistic blob URL once the server echo takes over.
      if (opt.media?.[0]?.url.startsWith('blob:')) URL.revokeObjectURL(opt.media[0].url);
    } catch (e) {
      patchMessage(set, optId, { status: 'failed', error: (e as Error).message });
      set({ error: (e as Error).message });
    }
    void get().refreshChats();
  },

  retryText: async (id: string, text: string) => {
    patchMessage(set, id, { status: 'sending', error: undefined });
    const msg = get().messages.find((m) => m.id === id);
    const target = msg?.chatId ?? get().selectedChat;
    if (!target) return;
    try {
      const res = await api.send(target, text);
      patchMessage(set, id, { id: res.id || id, status: 'sent', error: undefined });
    } catch (e) {
      patchMessage(set, id, { status: 'failed', error: (e as Error).message });
      set({ error: (e as Error).message });
    }
    void get().refreshChats();
  },

  reactMessage: async (messageId: string, emoji: string) => {
    const { selectedChat, messages } = get();
    if (!selectedChat) return;
    const target = messages.find((m) => m.id === messageId);
    // Mattermost allows multiple reactions per user; others replace.
    const multiReact = target?.accountId.split(':')[0] === 'mattermost';
    const next = messages.map((m) =>
      m.id === messageId
        ? { ...m, reactions: multiReact ? addMyReaction(m.reactions, emoji) : setMyReaction(m.reactions, emoji) }
        : m
    );
    set({ messages: next });
    try {
      await api.react(selectedChat, messageId, emoji);
      // server broadcasts message-updated to reconcile
    } catch (e) {
      set({
        messages: get().messages.map((m) =>
          m.id === messageId
            ? { ...m, reactions: (m.reactions ?? []).filter((r) => !(r.from === 'me' && r.emoji === emoji)) }
            : m
        ),
        error: (e as Error).message,
      });
    }
  },

  forwardMessage: async (messageId: string, targetChatId: string) => {
    try {
      await api.forward(messageId, targetChatId);
      await get().refreshChats();
      if (get().selectedChat === targetChatId) await get().refreshMessages();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  /**
   * WhatsApp-style "reply privately": open the DM with a group message's
   * sender (same service) and quote their message. Cross-chat quotes fall
   * back to "> quoted text" on send automatically.
   */
  replyPrivately: async (msg: Message) => {
    if (!msg.sender) return;
    try {
      const r = await api.dmChat(msg.chatId, msg.sender);
      await get().refreshChats();
      await get().selectChat(r.chatId);
      set({ replyTo: msg });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  setReplyTo: (msg) => set({ replyTo: msg }),

  setEditing: (msg) => set({ editing: msg }),

  submitEdit: async (text: string) => {
    const { editing } = get();
    if (!editing || !text.trim()) return;
    try {
      await api.editMessage(editing.id, text.trim());
      set({ editing: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  setDraft: (chatId, text) =>
    set((s) => ({ drafts: text ? { ...s.drafts, [chatId]: text } : Object.fromEntries(Object.entries(s.drafts).filter(([k]) => k !== chatId)) })),

  setSuggestionCache: (chatId, lastTs, items) =>
    set((s) => ({ suggestionCache: { ...s.suggestionCache, [chatId]: { lastTs, items } } })),

  setAvatarError: (chatId, error) =>
    set((s) => ({
      avatarErrors: error
        ? { ...s.avatarErrors, [chatId]: error }
        : Object.fromEntries(Object.entries(s.avatarErrors).filter(([k]) => k !== chatId)),
    })),

  markRead: async (chatId: string) => {
    const ids = isPersonSelection(chatId) ? memberChatIds(get()) : [chatId];
    set((s) => ({
      chats: s.chats.map((c) => (ids.includes(c.id) ? { ...c, unread: 0 } : c)),
    }));
    for (const id of ids) {
      try {
        await api.markRead(id);
      } catch {
        /* non-fatal */
      }
    }
    try {
      // Re-fetch to confirm — overrides any stale refresh that raced with us.
      await get().refreshChats();
    } catch {
      /* non-fatal */
    }
  },

  setStatus: (s) => set({ status: s }),
  patchStatus: (p) => set((s) => (s.status ? { ...s, status: { ...s.status, ...p } } : s)),
  setAccounts: (a) => set({ accounts: a }),
  setPendingJump: (id) => set({ pendingJump: id }),
  bumpAvatarVersion: () => set((s) => ({ avatarVersion: s.avatarVersion + 1 })),
  targetChatId: () => {
    if (!get().selectedChat) return null;
    return resolveTargetChat(get());
  },

  onMessage: async (msg) => {
    const { selectedChat, messages } = get();
    if (selectedChat && memberChatIds(get()).includes(msg.chatId)) {
      const byId = messages.findIndex((m) => m.id === msg.id);
      if (byId >= 0) {
        const next = [...messages];
        next[byId] = {
          ...next[byId],
          ...msg,
          status: (msg.outgoing === 1 ? 'sent' : next[byId].status) as Message['status'],
        };
        set({ messages: next });
      } else if (msg.outgoing === 1) {
        // Merge an echoed sent message into its optimistic placeholder.
        const ph = messages.findIndex(
          (m) =>
            m.outgoing === 1 &&
            m.body === msg.body &&
            (m.status === 'sending' || m.status === 'sent') &&
            Math.abs(m.ts - msg.ts) < 60000
        );
        if (ph >= 0) {
          const next = [...messages];
          next[ph] = { ...next[ph], ...msg, status: 'sent' as const };
          set({ messages: next });
        } else {
          set({
            messages: [...messages, { ...msg, status: 'sent' as const }].sort((a, b) => a.ts - b.ts),
          });
        }
      } else {
        const next = [...messages, msg].sort((a, b) => a.ts - b.ts);
        set({ messages: next });
        if (document.visibilityState === 'visible') {
          await get().markRead(msg.chatId);
        }
      }
    }
    await get().refreshChats();
  },

  onMessageUpdated: (msg) => {
    const { selectedChat, messages } = get();
    if (msg.chatId === selectedChat) {
      const idx = messages.findIndex((m) => m.id === msg.id);
      if (idx >= 0) {
        const next = [...messages];
        // keep client-only status from the existing bubble
        next[idx] = { ...msg, status: messages[idx].status };
        set({ messages: next });
      }
    }
    void get().refreshChats();
  },

  onMessageDeleted: (id) => {
    set((s) => ({ messages: s.messages.filter((m) => m.id !== id) }));
    void get().refreshChats();
  },

  onTyping: (data) => {
    set((s) => ({ typing: { ...s.typing, [data.chatId]: { name: data.name, expiresAt: data.expiresAt } } }));
    // Clear when it lapses (providers stop sending when typing stops).
    const ttl = Math.max(0, data.expiresAt - Date.now());
    setTimeout(() => {
      const cur = get().typing[data.chatId];
      if (cur && cur.expiresAt <= Date.now()) {
        set((s) => {
          const next = { ...s.typing };
          delete next[data.chatId];
          return { typing: next };
        });
      }
    }, ttl + 50);
  },
}));

// ---------- helpers ----------

/** Chat ids backing the current selection (member chats for a person). */
function memberChatIds(s: StoreState): string[] {
  const sel = s.selectedChat;
  if (!sel) return [];
  if (isPersonSelection(sel)) {
    const person = s.people.find((p) => `person:${p.id}` === sel);
    return person?.chatIds ?? [];
  }
  // A raw chat id may belong to a person — expand so the view merges live.
  const person = s.people.find((p) => p.chatIds.includes(sel));
  return person?.chatIds ?? [sel];
}

/** Where an outgoing message should go for the current selection. */
function resolveTargetChat(s: StoreState, override?: string): string {
  if (override) return override;
  const sel = s.selectedChat ?? '';
  const person = isPersonSelection(sel)
    ? s.people.find((p) => `person:${p.id}` === sel)
    : s.people.find((p) => p.chatIds.includes(sel));
  if (!person) return sel;
  if (person.sendMode === 'origin') {
    // Quote-replying? Route to the service the quoted message arrived on.
    if (s.replyTo && person.chatIds.includes(s.replyTo.chatId)) return s.replyTo.chatId;
    const lastIncoming = [...s.messages].reverse().find((m) => m.outgoing === 0);
    if (lastIncoming && person.chatIds.includes(lastIncoming.chatId)) return lastIncoming.chatId;
  }
  return person.defaultChatId ?? person.chatIds[0] ?? sel;
}

function setMyReaction(reactions: Message['reactions'], emoji: string) {
  const others = (reactions ?? []).filter((r) => r.from !== 'me');
  return [...others, { emoji, from: 'me' }];
}

/** Mattermost semantics: multiple of my reactions coexist (dedupe same emoji). */
function addMyReaction(reactions: Message['reactions'], emoji: string) {
  const kept = (reactions ?? []).filter((r) => !(r.from === 'me' && r.emoji === emoji));
  return [...kept, { emoji, from: 'me' }];
}

function clientDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

type SetFn = (
  partial: StoreState | ((s: StoreState) => Partial<StoreState> | StoreState)
) => void;

function patchMessage(set: SetFn, id: string, patch: Partial<Message>): void {
  set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
}

function bumpChat(chatId: string, msg: Message, set: SetFn): void {
  set((s) => ({
    chats: s.chats
      .map((c) => (c.id === chatId ? { ...c, lastMessage: msg, ts: msg.ts } : c))
      .sort((a, b) => b.ts - a.ts),
  }));
}

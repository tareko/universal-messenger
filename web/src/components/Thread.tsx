import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore, isPersonSelection } from '../store';
import { api } from '../api';
import { Avatar } from './Avatar';
import { MessageStatus } from './MessageStatus';
import { ForwardDialog } from './ForwardDialog';
import { EmojiPicker } from './EmojiPicker';
import { Formatted } from './Formatted';
import { ProfilePanel } from './ProfilePanel';
import { providerBadge } from './AccountSwitcher';
import type { Message } from '../types';

/** Reaction quick-sets per provider (SMS = iMessage tapbacks; MM = mapped set). */
const REACTION_SETS: Record<string, string[]> = {
  voipms: ['❤️', '👍', '👎', '😂', '‼️', '❓'],
  whatsapp: ['👍', '❤️', '😂', '😮', '😢', '🙏'],
  telegram: ['👍', '❤️', '😂', '😮', '😢', '🙏'],
  mattermost: ['❤️', '👍', '👎', '😂', '‼️', '❓', '🎉', '😢', '🔥', '👀'],
};
const DEFAULT_SET = REACTION_SETS.voipms;
const MORE_ALLOWED = new Set(['whatsapp', 'telegram']);

export function Thread() {
  const selectedChat = useStore((s) => s.selectedChat);
  const chats = useStore((s) => s.chats);
  const people = useStore((s) => s.people);
  const accounts = useStore((s) => s.accounts);
  const typing = useStore((s) => s.typing);
  const person = useMemo(
    () =>
      isPersonSelection(selectedChat)
        ? people.find((p) => `person:${p.id}` === selectedChat)
        : people.find((p) => selectedChat != null && p.chatIds.includes(selectedChat)),
    [people, selectedChat]
  );
  const memberChats = useMemo(
    () => (person ? chats.filter((c) => person.chatIds.includes(c.id)) : []),
    [person, chats]
  );
  const [showProfile, setShowProfile] = useState(false);
  const [summary, setSummary] = useState<{ text: string; streaming: boolean } | null>(null);
  const aiEnabled = useStore((s) => s.status?.ai?.enabled ?? false);

  /** Stream an AI summary of the current chat into the panel. */
  async function summarize() {
    if (!selectedChat || summary?.streaming) return;
    setSummary({ text: '', streaming: true });
    try {
      const res = await fetch('/api/ai/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: selectedChat }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const payload = JSON.parse(line.slice(5).trim()) as { delta?: string; error?: string };
            if (payload.error) throw new Error(payload.error);
            if (payload.delta) {
              setSummary((s) => (s ? { ...s, text: s.text + payload.delta } : s));
            }
          } catch (e) {
            if (e instanceof Error && e.message !== 'Unexpected end of JSON input') throw e;
          }
        }
      }
      setSummary((s) => (s ? { ...s, streaming: false } : s));
    } catch (e) {
      setSummary({ text: `Summary failed: ${(e as Error).message}`, streaming: false });
    }
  }
  const messages = useStore((s) => s.messages);
  const messagesLoaded = useStore((s) => s.messagesLoaded);
  const unreadAtOpen = useStore((s) => s.unreadAtOpen);
  const hasOlder = useStore((s) => s.hasOlder);
  const loadingOlder = useStore((s) => s.loadingOlder);
  const loadOlderMessages = useStore((s) => s.loadOlderMessages);
  const selectChat = useStore((s) => s.selectChat);
  const retryText = useStore((s) => s.retryText);
  const reactMessage = useStore((s) => s.reactMessage);
  const replyPrivately = useStore((s) => s.replyPrivately);
  const setReplyTo = useStore((s) => s.setReplyTo);
  const setEditing = useStore((s) => s.setEditing);
  const scrollNonce = useStore((s) => s.scrollNonce);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [showJump, setShowJump] = useState(false);

  // Sending a message (or a provider echo arriving) scrolls to the bottom.
  useEffect(() => {
    if (scrollNonce > 0) jumpToBottom();
  }, [scrollNonce]);

  const chat = useMemo(() => {
    if (person) {
      const latest = memberChats.reduce<(typeof memberChats)[number] | undefined>(
        (a, b) => ((b.lastMessage?.ts ?? b.ts) > ((a?.lastMessage?.ts ?? a?.ts) || 0) ? b : a),
        undefined
      );
      return latest ? { ...latest, name: person.name, title: person.name } : undefined;
    }
    return chats.find((x) => x.id === selectedChat);
  }, [chats, selectedChat, person, memberChats]);
  const account = useMemo(
    () => accounts.find((a) => a.id === chat?.accountId),
    [accounts, chat]
  );
  const typingEntry = useStore((s) => (selectedChat ? s.typing[selectedChat] : undefined));
  const isTyping = person
    ? memberChats.some((c) => typing[c.id] && typing[c.id].expiresAt > Date.now())
    : Boolean(typingEntry && typingEntry.expiresAt > Date.now());
  const replyTo = useStore((s) => s.replyTo);
  const canReact = account?.capabilities.react ?? false;
  const canReply = account?.capabilities.reply ?? false;

  const name = chat?.name ?? chat?.title ?? chat?.contactRaw ?? '';
  const muted = useStore((s) => {
    const key = person ? `person:${person.id}` : (chat?.id ?? '');
    if (!key) return false;
    if (s.notifySettings.mutedChats.includes(key)) return true;
    // Groups/channels are muted by default unless pinned or unmuted.
    if (chat && chat.type !== 'dm' && !chat.pinned && !s.notifySettings.unmutedChats.includes(key)) {
      return true;
    }
    return false;
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  // When set, restore the viewport anchor instead of jumping to the bottom
  // (used when prepending an older page at the top).
  const anchorRef = useRef<number | null>(null);
  const lastChatRef = useRef<string | null>(null);
  // Set on chat switch: the next messages render should land on the unread
  // divider (or the bottom if there's nothing unread).
  const pendingInitialScroll = useRef(false);
  // True while the viewport should follow content growth (e.g. images
  // loading in below) — cleared when the user scrolls away from the bottom.
  const stickRef = useRef(true);
  // The unread divider may only be cleared AFTER the initial scroll has
  // positioned the thread — blocks stray "near bottom" events during load.
  const canClearUnreadRef = useRef(false);
  // The thread stays hidden until the initial scroll has positioned it,
  // so no intermediate (e.g. bottom-of-chat) state is ever painted.
  const [positioned, setPositioned] = useState(false);

  // Safety net: never leave the gate closed for long, whatever goes wrong.
  useEffect(() => {
    if (positioned) return;
    const t = setTimeout(() => setPositioned(true), 1500);
    return () => clearTimeout(t);
  }, [positioned, selectedChat]);

  // When the reply preview appears above the composer, push the thread's
  // visible text up by the same amount so the last message stays in view.
  useEffect(() => {
    if (!replyTo) return;
    const el = scrollRef.current;
    requestAnimationFrame(() => {
      const preview = document.querySelector('.reply-preview');
      if (el && preview) el.scrollTop += (preview as HTMLElement).offsetHeight + 8;
    });
  }, [replyTo]);

  // Index of the first unread message (the last `unreadAtOpen` incoming ones).
  // Only the most recent RENDER_WINDOW messages render at once — older loaded
  // pages stay in the store but off-DOM (scroll-to-load still works).
  const RENDER_WINDOW = 300;
  const visibleMessages = messages.length > RENDER_WINDOW ? messages.slice(-RENDER_WINDOW) : messages;

  const firstUnreadIdx = useMemo(() => {
    if (!unreadAtOpen) return -1;
    let remaining = unreadAtOpen;
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i].outgoing === 0 && --remaining === 0) return i;
    }
    // More unread than loaded messages — the boundary is off-screen above.
    return visibleMessages.some((m) => m.outgoing === 0) ? 0 : -1;
  }, [visibleMessages, unreadAtOpen]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Chat switch detection lives HERE (layout phase, pre-paint) so the
    // flags are reset before any scroll event can fire — a useEffect would
    // leave a window where stale flags clear the new chat's divider.
    if (lastChatRef.current !== selectedChat) {
      lastChatRef.current = selectedChat;
      pendingInitialScroll.current = true;
      canClearUnreadRef.current = false;
      setPositioned(false);
    }
    if (anchorRef.current !== null) {
      // Older page prepended: keep the viewport where it was.
      el.scrollTop = el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
      return;
    }
    if (pendingInitialScroll.current && messages.length > 0) {
      // A cross-chat quote jump is pending: land on the target message.
      const jump = useStore.getState().pendingJump;
      if (jump) {
        const flash = (target: HTMLElement) => {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('flash');
          setTimeout(() => target.classList.remove('flash'), 1200);
        };
        const land = () => {
          pendingInitialScroll.current = false;
          useStore.getState().setPendingJump(null);
          canClearUnreadRef.current = true;
          stickRef.current = false;
          setPositioned(true);
        };
        const el2 = document.getElementById(`msg-${jump}`);
        if (el2) {
          land();
          flash(el2);
          return;
        }
        // Not in the first page — page back looking for it, then land there.
        void (async () => {
          for (let i = 0; i < 5; i++) {
            if (!useStore.getState().hasOlder) break;
            anchorRef.current = el.scrollHeight - el.scrollTop;
            await loadOlderMessages();
            await new Promise((r) => setTimeout(r, 250));
            const retry = document.getElementById(`msg-${jump}`);
            if (retry) {
              land();
              flash(retry);
              return;
            }
          }
          // Give up: land at the bottom, gate open.
          pendingInitialScroll.current = false;
          useStore.getState().setPendingJump(null);
          canClearUnreadRef.current = true;
          stickRef.current = true;
          el.scrollTop = el.scrollHeight;
          setPositioned(true);
        })();
        return;
      }
      // Position on the unread divider (or the bottom). This may run several
      // times (partial commits during load) — it's only CONSUMED once the
      // full first fetch has landed, so late arrivals can't steal it.
      const divider = el.querySelector('.unread-divider');
      if (divider) {
        divider.scrollIntoView({ block: 'start' });
        stickRef.current = false;
      } else {
        el.scrollTop = el.scrollHeight;
        stickRef.current = true;
      }
      if (messagesLoaded) {
        pendingInitialScroll.current = false;
        // Initial positioning done — the divider may now be cleared at bottom.
        canClearUnreadRef.current = true;
        setPositioned(true);
      }
      return;
    }
    if (pendingInitialScroll.current && messagesLoaded) {
      // Empty chat: nothing to position, just open the gate.
      pendingInitialScroll.current = false;
      canClearUnreadRef.current = true;
      setPositioned(true);
      return;
    }
    // Follow new content ONLY when the user is parked at the bottom (set by
    // real scroll events — not by how close they happen to be while reading).
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, messagesLoaded]);

  // Media loading below the fold grows the content — re-stick to the bottom
  // so a fully-read chat still lands on the very last message.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onLoad = () => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('load', onLoad, true); // capture: img loads don't bubble
    return () => el.removeEventListener('load', onLoad, true);
  }, [selectedChat]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && anchorRef.current !== null) {
      el.scrollTop = el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
    }
  }, [messages]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // Track whether the user is parked at the bottom (drives stickiness).
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stickRef.current = nearBottom;
    setShowJump(!nearBottom && el.scrollHeight - el.scrollTop - el.clientHeight > 300);
    // Reaching the bottom of a SCROLLABLE thread clears the unread divider —
    // but only once the initial positioning has run (canClearUnreadRef).
    const scrollable = el.scrollHeight > el.clientHeight + 1;
    if (nearBottom && scrollable && canClearUnreadRef.current && useStore.getState().unreadAtOpen > 0) {
      useStore.setState({ unreadAtOpen: 0 });
    }
    if (el.scrollTop > 60 || !hasOlder || loadingOlder) return;
    anchorRef.current = el.scrollHeight - el.scrollTop;
    void loadOlderMessages();
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setShowJump(false);
    if (useStore.getState().unreadAtOpen > 0) useStore.setState({ unreadAtOpen: 0 });
  }

  /** Jump to a quoted message — same chat: scroll/flash; other chat: open it there. */
  async function jumpToMessage(quotedId: string, quotedChatId?: string) {
    const flash = (el: HTMLElement) => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1200);
    };
    const found = document.getElementById(`msg-${quotedId}`);
    if (found && (!quotedChatId || quotedChatId === selectedChat)) return flash(found);
    // Cross-chat quote (e.g. reply-privately): open the quoted chat at it.
    if (quotedChatId && quotedChatId !== selectedChat) {
      useStore.getState().setPendingJump(quotedId);
      await selectChat(quotedChatId);
      return;
    }
    const container = scrollRef.current;
    for (let i = 0; i < 5; i++) {
      if (!useStore.getState().hasOlder) return;
      if (container) anchorRef.current = container.scrollHeight - container.scrollTop;
      await loadOlderMessages();
      await new Promise((r) => setTimeout(r, 250));
      const retry = document.getElementById(`msg-${quotedId}`);
      if (retry) return flash(retry);
    }
  }

  if (!selectedChat || !chat) {
    return (
      <div className="thread empty">
        <div className="thread-empty-card">
          <h2>Universal Messenger</h2>
          <p>Select a chat on the left, or search a contact to start a new one.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="thread">
      <div className="thread-header">
        <button
          className="tool-btn back-btn"
          title="Back to chats"
          onClick={() => useStore.getState().closeChat()}
        >
          ←
        </button>
        <Avatar
          name={name || chat.remoteId}
          size={36}
          chatId={person ? (person.defaultChatId ?? person.chatIds[0] ?? undefined) : chat.id}
        />
        <div
          className="thread-header-name clickable"
          onClick={() => setShowProfile(true)}
          title="View profile"
        >          <div className="thread-name" title={name || formatNumber(chat.remoteId)}>
            {chat.type === 'group' ? '👥 ' : chat.type === 'channel' ? '📢 ' : ''}
            {name || formatNumber(chat.remoteId)}
            {muted && (
              <span className="muted-bell" title="Notifications muted for this chat">
                🔕
              </span>
            )}
            {chat.ephemeralSeconds ? (
              <span
                className="ephemeral-icon"
                title={`Disappearing messages: new messages disappear after ${ephemeralLabel(chat.ephemeralSeconds)}`}
              >
                ⏳
              </span>
            ) : null}
          </div>
          <div className="thread-sub">
            {isTyping ? (
              <span className="typing-indicator">
                {chat.type === 'group' && typingEntry?.name
                  ? `${typingEntry.name} is typing…`
                  : 'typing…'}
              </span>
            ) : (
              <>
                {name && chat.type === 'dm' ? `${formatNumber(chat.remoteId)} · ` : ''}
                via {account?.label ?? chat.accountId}
                {chat.type === 'dm' && <ContactActions chat={chat} />}
              </>
            )}
          </div>
        </div>
        {aiEnabled && (
          <button
            className="tool-btn"
            title="Summarize this chat (AI)"
            disabled={summary?.streaming}
            onClick={() => void summarize()}
          >
            {summary?.streaming ? '…' : '✨'}
          </button>
        )}
      </div>

      {summary && (
        <div className="ai-summary">
          <div className="ai-summary-head">
            <span>✨ AI summary{summary.streaming ? ' (writing…)' : ''}</span>
            <button className="attach-remove" onClick={() => setSummary(null)}>✕</button>
          </div>
          <div className="ai-summary-body" dir="auto">
            {summary.text || '…'}
          </div>
        </div>
      )}

      <div
        className="thread-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        style={{ visibility: positioned ? 'visible' : 'hidden' }}
      >
        {loadingOlder && <div className="thread-day">Loading older…</div>}
        {!hasOlder && messages.length > 0 && <div className="thread-day">Start of history</div>}
        {visibleMessages.map((m, i) => {
          const prev = visibleMessages[i - 1];
          const showDate =
            !prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString();
          return (
            <Fragment key={m.id}>
              {showDate && (
                <div className="thread-day">
                  <span className="date-chip">{dayLabel(m.ts)}</span>
                </div>
              )}
              {i === firstUnreadIdx && (
                <div className="unread-divider">
                  <span>
                    {unreadAtOpen} unread message{unreadAtOpen === 1 ? '' : 's'}
                  </span>
                </div>
              )}
              <MemoBubble
                msg={m}
                isGroup={chat.type === 'group'}
                canReact={canReact}
                canReply={canReply}
                provider={account?.provider ?? ''}
                showProvider={Boolean(person)}
                canTranslate={Boolean(chat.translateEnabled)}
                onReact={(emoji) => void reactMessage(m.id, emoji)}
                onReply={() => setReplyTo(m)}
                onEdit={() => setEditing(m)}
                onReplyPrivately={() => void replyPrivately(m)}
                onForward={() => setForwarding(m)}
                onRetry={(msg) => void retryText(msg.id, msg.body)}
                onQuoteClick={() => void jumpToMessage(m.quotedId!, m.quoted?.chatId)}
              />
            </Fragment>
          );
        })}
      </div>

      {forwarding && <ForwardDialog message={forwarding} onClose={() => setForwarding(null)} />}
      {showProfile && (
        <ProfilePanel chat={chat} person={person ?? null} memberChats={memberChats} onClose={() => setShowProfile(false)} />
      )}
      {showJump && (
        <button className="jump-bottom" title="Jump to latest" onClick={jumpToBottom}>
          ↓
        </button>
      )}
    </div>
  );
}

/** Cached group participants per chat (for @mention rendering). */
const participantsCache = new Map<string, { id: string; name: string }[]>();

function useParticipants(chatId: string, isGroup: boolean): { id: string; name: string }[] {
  const [list, setList] = useState(participantsCache.get(chatId) ?? []);
  useEffect(() => {
    if (!isGroup || participantsCache.has(chatId)) return;
    void api
      .participants(chatId)
      .then((r) => {
        participantsCache.set(chatId, r);
        setList(r);
      })
      .catch(() => {});
  }, [chatId, isGroup]);
  return list;
}

/** A received contact card (shared contact) with save/message actions. */
function ContactCard({ msg }: { msg: Message }) {
  const selectChat = useStore((s) => s.selectChat);
  const refreshChats = useStore((s) => s.refreshChats);
  const accounts = useStore((s) => s.accounts);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const card = msg.contactCard!;
  const waAccount = accounts.find((a) => a.provider === 'whatsapp' && a.status === 'active');

  async function save() {
    setState('saving');
    try {
      await api.addContact(card.name, card.tel ?? '');
      setState('saved');
    } catch {
      setState('error');
    }
  }

  async function messageOnWhatsApp() {
    if (!card.tel || !waAccount) return;
    try {
      const r = await api.newChat(waAccount.id, card.tel);
      await refreshChats();
      await selectChat(r.chatId);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="contact-card">
      <Avatar name={card.name} size={40} />
      <div className="contact-card-info">
        <div className="contact-card-name">{card.name}</div>
        {card.tel && <div className="contact-card-tel">{card.tel}</div>}
      </div>
      <div className="contact-card-actions">
        <button className="dialog-cancel" disabled={state === 'saving' || state === 'saved'} onClick={() => void save()}>
          {state === 'saved' ? '✓ Saved' : state === 'saving' ? 'Saving…' : 'Save to contacts'}
        </button>
        {waAccount && card.tel && (
          <button className="dialog-cancel" onClick={() => void messageOnWhatsApp()}>
            Message on WhatsApp
          </button>
        )}
      </div>
    </div>
  );
}

function Bubble({
  msg,
  isGroup,
  canReact,
  canReply,
  provider,
  showProvider,
  canTranslate,
  onReact,
  onReply,
  onEdit,
  onReplyPrivately,
  onForward,
  onRetry,
  onQuoteClick,
}: {
  msg: Message;
  isGroup: boolean;
  canReact: boolean;
  canReply: boolean;
  provider: string;
  showProvider?: boolean;
  canTranslate?: boolean;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onReplyPrivately: () => void;
  onForward: () => void;
  onRetry: (msg: Message) => void;
  onQuoteClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [picker, setPicker] = useState(false);
  const [morePicker, setMorePicker] = useState(false);
  const [mediaRequested, setMediaRequested] = useState(false);
  const [translation, setTranslation] = useState<{ text: string; loading: boolean } | null>(null);
  const aiEnabled = useStore((s) => s.status?.ai?.enabled ?? false);
  const rowRef = useRef<HTMLDivElement>(null);

  async function translate() {
    if (translation?.loading) return;
    setTranslation({ text: '', loading: true });
    try {
      const r = await api.aiTranslate(msg.body);
      setTranslation({ text: r.translation, loading: false });
    } catch (e) {
      setTranslation({ text: `Translation failed: ${(e as Error).message}`, loading: false });
    }
  }
  // Highlight this row while it's the message being quoted in the composer.
  const isReplyTarget = useStore((s) => s.replyTo?.id === msg.id);
  const selectChat = useStore((s) => s.selectChat);
  const refreshChats = useStore((s) => s.refreshChats);
  const participants = useParticipants(msg.chatId, isGroup);
  const mentionList = useMemo(
    () => participants.map((p) => ({ name: p.name, memberId: p.id })),
    [participants]
  );
  const emojiSet = REACTION_SETS[provider] ?? DEFAULT_SET;
  const allowMore = MORE_ALLOWED.has(provider);

  /** Open a DM with a mentioned person (same service). */
  function onMentionClick(memberId: string) {
    void api.dmChat(msg.chatId, memberId).then(async (r) => {
      await refreshChats();
      await selectChat(r.chatId);
    });
  }

  // Lazy attachment: fetch only once the bubble is actually near the viewport
  // (opening a 300-message backlog must not fire 50 WhatsApp downloads at
  // once — each completion re-renders the whole list).
  useEffect(() => {
    if (!msg.mediaPending || msg.media?.length || mediaRequested) return;
    const el = rowRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          setMediaRequested(true);
          void api.fetchMedia(msg.id).catch(() => {});
        }
      },
      { rootMargin: '200px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [msg.id, msg.mediaPending, msg.media, mediaRequested]);
  const media = msg.media ?? [];
  const images = media.filter((x) => x.contentType.startsWith('image/'));
  const videos = media.filter((x) => x.contentType.startsWith('video/'));
  const audios = media.filter((x) => x.contentType.startsWith('audio/'));
  const files = media.filter(
    (x) =>
      !x.contentType.startsWith('image/') &&
      !x.contentType.startsWith('video/') &&
      !x.contentType.startsWith('audio/')
  );
  const hasMedia = media.length > 0 || Boolean(msg.mediaPending);
  const caption = msg.body;
  const incoming = msg.outgoing === 0;
  const canForward = Boolean(msg.body || msg.media?.length) && msg.status !== 'sending';
  // Edit windows per service (WhatsApp ~15 min, Telegram ~48h, Mattermost none).
  const EDIT_WINDOW_MS: Record<string, number> = {
    whatsapp: 15 * 60_000,
    telegram: 48 * 3600_000,
  };
  const editWindow = EDIT_WINDOW_MS[provider];
  const editableProvider =
    provider === 'whatsapp' || provider === 'telegram' || provider === 'mattermost';
  const canEdit = Boolean(
    msg.outgoing === 1 &&
      msg.body &&
      !msg.media?.length &&
      !msg.deleted &&
      editableProvider &&
      (editWindow === undefined || Date.now() - msg.ts < editWindow)
  );

  // Delete-for-everyone tombstone.
  if (msg.deleted) {
    return (
      <div className={`bubble-row ${incoming ? 'in' : 'out'}`} id={`msg-${msg.id}`}>
        <div className="bubble deleted-bubble">
          <span className="deleted-text">
            🚫 {msg.outgoing === 1 ? 'You deleted this message' : 'This message was deleted'}
          </span>
          <span className="bubble-meta">
            <span className="bubble-time">{formatTime(msg.ts)}</span>
          </span>
        </div>
      </div>
    );
  }

  // Double-click on the row (but not on the bubble itself) = quote-reply.
  function onRowDoubleClick(e: React.MouseEvent) {
    if (!canReply) return;
    if ((e.target as HTMLElement).closest('.bubble')) return;
    onReply();
  }

  return (
    <div
      ref={rowRef}
      className={`bubble-row ${incoming ? 'in' : 'out'}${isReplyTarget ? ' reply-selected' : ''}`}
      id={`msg-${msg.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={onRowDoubleClick}
    >
      {picker && morePicker && (
        <>
          <div className="react-backdrop" onClick={() => { setMorePicker(false); setPicker(false); }} />
          <div className="react-full-picker">
            <EmojiPicker
              onPick={(char) => {
                onReact(char);
                setMorePicker(false);
                setPicker(false);
              }}
              onClose={() => { setMorePicker(false); setPicker(false); }}
            />
          </div>
        </>
      )}

      {picker && !morePicker && (
        <div className="react-backdrop" onClick={() => setPicker(false)} />
      )}
      <div className={`bubble-wrap ${incoming ? 'in' : 'out'}`}>
        {hover && !morePicker && (canReact || canForward) && (
          <div className={`hover-actions ${incoming ? 'in' : 'out'}`}>
            {picker && !morePicker ? (
              <div className="react-bar">
                {emojiSet.map((e) => (
                  <button
                    key={e}
                    className="react-bar-emoji"
                    title={e}
                    onClick={() => {
                      onReact(e);
                      setPicker(false);
                    }}
                  >
                    {e}
                  </button>
                ))}
                {allowMore && (
                  <button
                    className="react-bar-emoji react-bar-more"
                    title="More emojis"
                    onClick={() => setMorePicker(true)}
                  >
                    ➕
                  </button>
                )}
              </div>
            ) : (
              <>
                {canReact && (
                  <button className="action-btn" title="React" onClick={() => setPicker(true)}>
                    😀
                  </button>
                )}
                {isGroup && incoming && msg.sender && (
                  <button className="action-btn" title="Reply privately" onClick={onReplyPrivately}>
                    👤
                  </button>
                )}
                {canEdit && (
                  <button className="action-btn" title="Edit message" onClick={onEdit}>
                    ✏️
                  </button>
                )}
                {aiEnabled && msg.body && canTranslate && (
                  <button
                    className="action-btn"
                    title="Translate"
                    disabled={translation?.loading}
                    onClick={() => void translate()}
                  >
                    {translation?.loading ? '…' : '🌐'}
                  </button>
                )}
                {canForward && (
                  <button className="action-btn" title="Forward" onClick={onForward}>
                    ↪
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <div className={`bubble${hasMedia ? ' has-media' : ''}`}>
          {incoming && isGroup && msg.sender && (
            <div className="bubble-sender">{msg.senderName ?? formatNumber(msg.sender)}</div>
          )}
          {msg.quoted && (
            <div className="bubble-quote" onClick={onQuoteClick} role="button">
              <div className="bubble-quote-author">
                {msg.quoted.outgoing === 1
                  ? 'You'
                  : (msg.quoted.senderName ?? formatNumber(msg.quoted.sender ?? ''))}
              </div>
              <div className="bubble-quote-text" dir="auto">
                {msg.quoted.deleted ? (
                  '🚫 This message was deleted'
                ) : msg.quoted.body ? (
                  <Formatted text={msg.quoted.body} provider={msg.accountId.split(':')[0]} />
                ) : (
                  '📎 Attachment'
                )}
              </div>
            </div>
          )}
          {msg.forwardedFrom && <div className="bubble-forwarded">↪ Forwarded</div>}
          {msg.contactCard && <ContactCard msg={msg} />}
          {msg.mediaPending && !media.length && (
            <div className="bubble-media-pending">📹 Attachment — downloading…</div>
          )}
          {images.length > 0 && (
            <div className="bubble-media">
              {images.map((img, i) => (
                <a key={i} href={img.url} target="_blank" rel="noreferrer">
                  <img src={img.url} alt="" loading="lazy" />
                </a>
              ))}
            </div>
          )}
          {videos.map((v, i) => (
            <div className="bubble-media" key={i}>
              <video src={v.url} controls preload="metadata" playsInline />
            </div>
          ))}
          {audios.map((a, i) => (
            <div className="bubble-audio" key={i}>
              <audio src={a.url} controls preload="metadata" />
            </div>
          ))}
          {files.map((f, i) => (
            <div key={i}>
              {f.contentType === 'application/pdf' && (
                <a href={f.url} target="_blank" rel="noreferrer">
                  <img
                    className="pdf-thumb"
                    src={f.url.replace('/api/media/', '/api/media/pdf-thumb/')}
                    alt="PDF preview"
                    loading="lazy"
                    onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                  />
                </a>
              )}
              <a className="bubble-file" href={f.url} target="_blank" rel="noreferrer" download={f.name ?? true}>
                <span className="bubble-file-icon">📎</span>
                <span className="bubble-file-name">{f.name ?? fileLabel(f.contentType)}</span>
              </a>
            </div>
          ))}
          {caption && (
            <span className="bubble-text" dir="auto">
              <Formatted
                text={caption}
                provider={msg.accountId.split(':')[0]}
                mentions={mentionList}
                onMentionClick={onMentionClick}
              />
            </span>
          )}
          {translation && (
            <div className="bubble-translation" dir="auto">
              {translation.loading ? 'Translating…' : translation.text}
            </div>
          )}
          {caption && !hasMedia && URL_RE.test(caption) && <LinkPreview messageId={msg.id} />}
          <span className="bubble-meta">
            {showProvider && (
              <span className="provider-badge meta-badge">
                {providerBadge(msg.accountId.split(':')[0])}
              </span>
            )}
            {msg.edited ? <span className="bubble-edited">edited</span> : null}
            <span className="bubble-time">{formatTime(msg.ts)}</span>
            <MessageStatus msg={msg} onRetry={onRetry} />
          </span>
        </div>
        {msg.reactions && msg.reactions.length > 0 && (
          <div className={`reactions ${incoming ? 'in' : 'out'}`}>
            {dedupeReactions(msg.reactions).map((r, i) => (
              <span key={i} className="reaction-badge" title={r.from === 'me' ? 'You reacted' : 'Reaction'}>
                {r.emoji}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i;

/** og: preview card for the first URL in a message (server-fetched, cached). */
function LinkPreview({ messageId }: { messageId: string }) {
  const [preview, setPreview] = useState<import('../api').LinkPreview | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .linkPreview(messageId)
      .then((r) => {
        if (active) {
          setPreview(r.preview);
          setDone(true);
        }
      })
      .catch(() => active && setDone(true));
    return () => {
      active = false;
    };
  }, [messageId]);

  if (!done || !preview || (!preview.title && !preview.image)) return null;
  return (
    <a className="link-preview" href={preview.url} target="_blank" rel="noreferrer">
      {preview.image && <img src={preview.image} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />}
      <div className="link-preview-body">
        {preview.siteName && <div className="link-preview-site">{preview.siteName}</div>}
        {preview.title && <div className="link-preview-title" dir="auto">{preview.title}</div>}
        {preview.description && <div className="link-preview-desc" dir="auto">{preview.description}</div>}
      </div>
    </a>
  );
}

/** Short human label for a non-media attachment's mime type. */
function fileLabel(contentType: string): string {
  const FRIENDLY: Record<string, string> = {
    'application/pdf': 'PDF document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
    'application/msword': 'Word document',
    'application/vnd.ms-excel': 'Excel spreadsheet',
    'application/vnd.ms-powerpoint': 'PowerPoint',
    'application/zip': 'ZIP archive',
    'application/x-rar-compressed': 'RAR archive',
    'application/x-7z-compressed': '7z archive',
    'text/plain': 'Text file',
    'text/csv': 'CSV file',
    'application/json': 'JSON file',
  };
  if (FRIENDLY[contentType]) return FRIENDLY[contentType];
  const subtype = contentType.split('/')[1] ?? contentType;
  return subtype.toUpperCase().slice(0, 24);
}

/** DM header extras: DAV number switcher + "on WhatsApp" jump button. */
function ContactActions({ chat }: { chat: import('../types').Chat }) {
  const accounts = useStore((s) => s.accounts);
  const refreshChats = useStore((s) => s.refreshChats);
  const selectChat = useStore((s) => s.selectChat);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [onWhatsApp, setOnWhatsApp] = useState<boolean | null>(null);

  const isPhone = chat.remoteId.startsWith('+');
  const waAccount = accounts.find((a) => a.provider === 'whatsapp' && a.status === 'active');

  useEffect(() => {
    setNumbers([]);
    setOnWhatsApp(null);
    if (!isPhone) return;
    void api.contactLookup(chat.remoteId).then((r) => setNumbers(r.numbers)).catch(() => {});
    // Only check WhatsApp when we're not already on a WhatsApp chat.
    if (waAccount && chat.provider !== 'whatsapp') {
      void api.whatsappCheck(chat.remoteId).then((r) => setOnWhatsApp(r.onWhatsApp)).catch(() => {});
    }
  }, [chat.remoteId, chat.provider, isPhone, waAccount?.id]);

  async function openWaChat() {
    if (!waAccount) return;
    try {
      const r = await api.newChat(waAccount.id, chat.remoteId);
      await refreshChats();
      await selectChat(r.chatId);
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      {numbers.length > 1 && (
        <select
          className="contact-number-switch"
          value={chat.remoteId}
          title="Other numbers for this contact"
          onChange={(e) => {
            const tel = e.target.value;
            const voip = accounts.find((a) => a.provider === 'voipms');
            if (voip) {
              void api.newChat(voip.id, tel).then(async (r) => {
                await refreshChats();
                await selectChat(r.chatId);
              });
            }
          }}
        >
          {numbers.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      )}
      {onWhatsApp && waAccount && (
        <button
          className="wa-badge"
          title={`${chat.remoteId} is also on WhatsApp — switch to the WhatsApp chat`}
          onClick={() => void openWaChat()}
        >
          ↗ WhatsApp
        </button>
      )}
    </>
  );
}

function dedupeReactions(reactions: { emoji: string; from?: string }[]) {
  // collapse duplicates to one badge per emoji
  const seen = new Set<string>();
  const out: { emoji: string; from?: string }[] = [];
  for (const r of reactions) {
    if (seen.has(r.emoji)) continue;
    seen.add(r.emoji);
    out.push(r);
  }
  return out;
}

function formatNumber(d: string | null): string {
  if (!d) return '';
  const digits = d.replace(/\D/g, '');
  // NANP: (519) 555-0100. Others: international groups (+972 599 426 678).
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1'))
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  const cc = digits.slice(0, digits.length - 9);
  const rest = digits.slice(digits.length - 9);
  return `+${cc} ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
}

/** Human label for a disappearing-messages duration. */
function ephemeralLabel(s: number): string {
  if (s === 86400) return '24 hours';
  if (s === 604800) return '7 days';
  if (s === 7776000) return '90 days';
  if (s % 604800 === 0) return `${s / 604800} weeks`;
  if (s % 86400 === 0) return `${s / 86400} days`;
  if (s % 3600 === 0) return `${s / 3600} hours`;
  return `${s} seconds`;
}

/** Date-separator chip label: Today / Yesterday / July 17 (/ July 17, 2025). */
function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString([], {
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** Shallow content comparison for Bubble memoization (ignores handler refs). */
function bubbleEqual(
  a: { msg: Message; isGroup: boolean; canReact: boolean; canReply: boolean; provider: string; showProvider?: boolean; canTranslate?: boolean },
  b: { msg: Message; isGroup: boolean; canReact: boolean; canReply: boolean; provider: string; showProvider?: boolean; canTranslate?: boolean }
): boolean {
  const m1 = a.msg;
  const m2 = b.msg;
  return (
    m1.id === m2.id &&
    m1.ts === m2.ts &&
    m1.body === m2.body &&
    m1.edited === m2.edited &&
    m1.deleted === m2.deleted &&
    m1.receipt === m2.receipt &&
    m1.status === m2.status &&
    m1.mediaPending === m2.mediaPending &&
    m1.sender === m2.sender &&
    m1.senderName === m2.senderName &&
    (m1.reactions?.length ?? 0) === (m2.reactions?.length ?? 0) &&
    (m1.media?.length ?? 0) === (m2.media?.length ?? 0) &&
    m1.quotedId === m2.quotedId &&
    a.isGroup === b.isGroup &&
    a.canReact === b.canReact &&
    a.canReply === b.canReply &&
    a.provider === b.provider &&
    a.showProvider === b.showProvider &&
    a.canTranslate === b.canTranslate
  );
}

const MemoBubble = memo(Bubble, bubbleEqual);


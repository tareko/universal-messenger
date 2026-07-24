import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { Contact, Message } from '../types';
import { Avatar } from './Avatar';
import { providerBadge } from './AccountSwitcher';
import { formatTime } from './Thread';

interface SearchHit {
  message: Message;
  chatId: string;
  chatName: string | null;
}

export function ChatList() {
  const chats = useStore((s) => s.chats);
  const accounts = useStore((s) => s.accounts);
  const typing = useStore((s) => s.typing);
  const selectedChat = useStore((s) => s.selectedChat);
  const selectedAccount = useStore((s) => s.selectedAccount);
  const selectChat = useStore((s) => s.selectChat);
  const openNewChat = useStore((s) => s.openNewChat);
  const backfillHistory = useStore((s) => s.backfillHistory);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Contact[]>([]);
  const [msgHits, setMsgHits] = useState<SearchHit[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  // Sidebar tab: regular chats vs WhatsApp channels (newsletters).
  const [tab, setTab] = useState<'chats' | 'channels'>(
    () => (localStorage.getItem('um-tab') as 'chats' | 'channels') || 'chats'
  );

  const hasVoipMs = accounts.some((a) => a.provider === 'voipms');
  const channelCount = chats.filter((c) => c.type === 'channel').length;

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setMsgHits([]);
      return;
    }
    let active = true;
    const t = setTimeout(async () => {
      try {
        const r = await api.contacts(q);
        if (active) setResults(r);
      } catch {
        /* ignore */
      }
      try {
        const h = await api.search(q);
        if (active) setMsgHits(h);
      } catch {
        /* ignore */
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [query]);

  const filteredChats = useMemo(() => {
    const byTab = chats.filter((c) => (tab === 'channels' ? c.type === 'channel' : c.type !== 'channel'));
    const q = query.trim().toLowerCase();
    if (!q) return byTab;
    return byTab.filter(
      (c) =>
        c.name?.toLowerCase().includes(q) ||
        c.title?.toLowerCase().includes(q) ||
        c.contactRaw.toLowerCase().includes(q) ||
        c.remoteId.includes(q)
    );
  }, [chats, query, tab]);

  function switchTab(t: 'chats' | 'channels') {
    setTab(t);
    localStorage.setItem('um-tab', t);
  }

  const showingSearch = query.trim().length > 0;

  function chatSubtitle(c: (typeof chats)[number]): { text: string; typing: boolean } {
    const t = typing[c.id];
    if (t && t.expiresAt > Date.now()) {
      return { text: c.type === 'group' && t.name ? `${t.name} is typing…` : 'typing…', typing: true };
    }
    return { text: previewText(c.lastMessage), typing: false };
  }

  async function loadOlder() {
    if (loadingMore || exhausted) return;
    setLoadingMore(true);
    try {
      const r = await backfillHistory();
      if (r.reachedLimit && r.newMessages === 0) setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="contact-list">
      {channelCount > 0 && (
        <div className="chat-tabs">
          <button
            className={`chat-tab${tab === 'chats' ? ' active' : ''}`}
            onClick={() => switchTab('chats')}
          >
            Chats
          </button>
          <button
            className={`chat-tab${tab === 'channels' ? ' active' : ''}`}
            onClick={() => switchTab('channels')}
          >
            📢 Channels ({channelCount})
          </button>
        </div>
      )}
      <div className="search-bar">
        <input
          type="search"
          placeholder="Search chats or start a new one"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="search-clear" title="Clear search" onClick={() => setQuery('')}>
            ✕
          </button>
        )}
      </div>

      <div className="contact-list-scroll">
        {showingSearch ? (
          <>
            {filteredChats.length > 0 &&
              filteredChats.map((c) => {
                const sub = chatSubtitle(c);
                return (
                  <ChatRow
                    key={c.id}
                    name={c.name ?? c.title ?? c.contactRaw ?? c.remoteId}
                    subtitle={sub.text}
                    subtitleTyping={sub.typing}
                    ts={c.lastMessage?.ts ?? c.ts}
                    unread={c.unread}
                    active={selectedChat === c.id}
                    badge={selectedAccount === 'all' ? providerBadge(c.provider) : undefined}
                    group={c.type === 'group'}
                channel={c.type === 'channel'}
                    onClick={() => void selectChat(c.id)}
                  />
                );
              })}
            {results.map((c) => (
              <ChatRow
                key={c.tel}
                name={c.name}
                subtitle={c.rawTel || c.tel}
                unread={0}
                active={false}
                onClick={() => void openNewChat(c.tel)}
              />
            ))}
            {msgHits.length > 0 && (
              <>
                <div className="search-section">Messages</div>
                {msgHits.map((h) => (
                  <ChatRow
                    key={h.message.id}
                    name={h.chatName ?? h.chatId}
                    subtitle={h.message.body}
                    ts={h.message.ts}
                    unread={0}
                    active={false}
                    onClick={() => void selectChat(h.chatId)}
                  />
                ))}
              </>
            )}
            {filteredChats.length === 0 && results.length === 0 && msgHits.length === 0 && (
              <div className="empty-hint">
                No matches for “{query}”. Enter a phone number to start a new SMS chat.
              </div>
            )}
          </>
        ) : (
          filteredChats.map((c) => {
            const sub = chatSubtitle(c);
            return (
              <ChatRow
                key={c.id}
                name={c.name ?? c.title ?? c.contactRaw ?? c.remoteId}
                subtitle={sub.text}
                subtitleTyping={sub.typing}
                ts={c.lastMessage?.ts ?? c.ts}
                unread={c.unread}
                active={selectedChat === c.id}
                badge={selectedAccount === 'all' ? providerBadge(c.provider) : undefined}
                group={c.type === 'group'}
                channel={c.type === 'channel'}
                onClick={() => void selectChat(c.id)}
              />
            );
          })
        )}

        {!showingSearch && chats.length === 0 && (
          <div className="empty-hint">No chats yet. Search a contact to start one.</div>
        )}

        {!showingSearch && hasVoipMs && (
          <button
            className="load-more-btn"
            disabled={loadingMore || exhausted}
            onClick={() => void loadOlder()}
          >
            {exhausted
              ? 'No older history'
              : loadingMore
                ? 'Loading older…'
                : 'Load older SMS history'}
          </button>
        )}
      </div>
    </div>
  );
}

function previewText(
  m: { body: string; media?: { contentType: string }[]; deleted?: number } | undefined
): string {
  if (!m) return '';
  if (m.deleted) return '🚫 This message was deleted';
  if (m.body) return m.body;
  const ct = m.media?.[0]?.contentType ?? '';
  if (ct.startsWith('image/')) return '📷 Photo';
  if (ct.startsWith('video/')) return '📹 Video';
  if (ct.startsWith('audio/')) return '🎧 Audio';
  if (ct) return '📎 File';
  return '';
}

function ChatRow({
  name,
  subtitle,
  subtitleTyping,
  ts,
  unread,
  active,
  badge,
  group,
  channel,
  onClick,
}: {
  name: string;
  subtitle: string;
  subtitleTyping?: boolean;
  ts?: number;
  unread: number;
  active: boolean;
  badge?: string;
  group?: boolean;
  channel?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`contact-row${active ? ' active' : ''}`} onClick={onClick}>
      <Avatar name={name} />
      <div className="contact-row-main">
        <div className="contact-row-top">
          <span className="contact-name">
            {group ? '👥 ' : channel ? '📢 ' : ''}
            {name}
            {badge ? <span className="provider-badge">{badge}</span> : null}
          </span>
          {ts ? <span className="contact-time">{formatTime(ts)}</span> : null}
        </div>
        <div className="contact-row-bottom">
          <span className={`contact-preview${subtitleTyping ? ' typing' : ''}`} dir="auto">{subtitle}</span>
          {unread > 0 ? <span className="unread-badge">{unread}</span> : null}
        </div>
      </div>
    </button>
  );
}

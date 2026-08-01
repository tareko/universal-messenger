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
  const people = useStore((s) => s.people);
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
  const [tagFilter, setTagFilter] = useState<number | null>(null);
  // Sidebar tabs: main chats (dms + pinned groups), groups, channels, hidden.
  const [tab, setTab] = useState<'chats' | 'groups' | 'channels' | 'hidden'>(
    () => (localStorage.getItem('um-tab') as 'chats' | 'groups' | 'channels' | 'hidden') || 'chats'
  );

  const hasVoipMs = accounts.some((a) => a.provider === 'voipms');
  // The voip.ms 90-day backfill only applies to SMS accounts (other providers
  // page back via thread scroll). Show it only on the main tab when relevant.
  const showSmsBackfill =
    hasVoipMs && tab === 'chats' && (selectedAccount === 'all' || selectedAccount.startsWith('voipms:'));
  const channelCount = chats.filter((c) => c.type === 'channel' && !c.hidden).length;
  const groupCount = chats.filter((c) => c.type === 'group' && !c.hidden).length;
  const hiddenCount = chats.filter((c) => c.hidden).length;

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
    const byTab = chats.filter((c) => {
      if (tab === 'hidden') return Boolean(c.hidden);
      if (c.hidden) return false; // hidden conversations leave the other tabs
      if (tab === 'channels') return c.type === 'channel';
      if (tab === 'groups') return c.type === 'group';
      // Main: dms + pinned groups (groups default to the Groups tab).
      return c.type === 'dm' || (c.type === 'group' && Boolean(c.pinned));
    });
    const q = query.trim().toLowerCase();
    let rows = byTab;
    if (tagFilter !== null) {
      rows = rows.filter((c) => c.tags?.some((t) => t.id === tagFilter));
    }
    if (!q) return rows;
    return rows.filter(
      (c) =>
        c.name?.toLowerCase().includes(q) ||
        c.title?.toLowerCase().includes(q) ||
        c.contactRaw.toLowerCase().includes(q) ||
        c.remoteId.includes(q) ||
        (c.personId != null &&
          people.find((p) => p.id === c.personId)?.name.toLowerCase().includes(q))
    );
  }, [chats, query, tab, people, tagFilter]);

  // Unique tags present across visible chats (for the filter chip row).
  const presentTags = useMemo(() => {
    const map = new Map<number, { id: number; name: string; color: string }>();
    for (const c of chats) {
      for (const t of c.tags ?? []) map.set(t.id, t);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [chats]);

  /** Person-grouped rows: linked chats collapse into one row per person. */
  const displayRows = useMemo(() => {
    interface Row {
      selId: string;
      name: string;
      subtitle: string;
      subtitleTyping: boolean;
      ts: number;
      unread: number;
      badges: string[];
      linked: boolean;
      group?: boolean;
      channel?: boolean;
      pinned?: boolean;
      tags?: { id: number; name: string; color: string }[];
    }
    const rows: Row[] = [];
    const seenPeople = new Set<number>();
    for (const c of filteredChats) {
      const typingHere = typing[c.id] && typing[c.id].expiresAt > Date.now();
      if (c.personId != null) {
        if (seenPeople.has(c.personId)) continue;
        seenPeople.add(c.personId);
        const person = people.find((p) => p.id === c.personId);
        const members = chats.filter((x) => x.personId === c.personId);
        const latest = members.reduce((a, b) =>
          (b.lastMessage?.ts ?? b.ts) > (a.lastMessage?.ts ?? a.ts) ? b : a
        );
        const anyTyping = members.some((m) => typing[m.id] && typing[m.id].expiresAt > Date.now());
        rows.push({
          selId: `person:${c.personId}`,
          name: person?.name ?? c.name ?? c.contactRaw ?? '?',
          subtitle: anyTyping ? 'typing…' : previewText(latest.lastMessage),
          subtitleTyping: anyTyping,
          ts: latest.lastMessage?.ts ?? latest.ts,
          unread: members.reduce((sum, x) => sum + x.unread, 0),
          badges: members.map((x) => providerBadge(x.provider)),
          linked: true,
          group: latest.type === 'group',
          channel: latest.type === 'channel',
          tags: [...new Map(members.flatMap((x) => x.tags ?? []).map((t) => [t.id, t])).values()],
        });
      } else {
        const sub = chatSubtitle(c);
        rows.push({
          selId: c.id,
          name: c.name ?? c.title ?? c.contactRaw ?? c.remoteId,
          subtitle: typingHere ? sub.text : sub.text,
          subtitleTyping: sub.typing,
          ts: c.lastMessage?.ts ?? c.ts,
          unread: c.unread,
          badges: selectedAccount === 'all' ? [providerBadge(c.provider)] : [],
          linked: false,
          group: c.type === 'group',
          channel: c.type === 'channel',
          pinned: Boolean(c.pinned),
          tags: c.tags,
        });
      }
    }
    return rows.sort((a, b) => b.ts - a.ts);
  }, [filteredChats, people, chats, typing, selectedAccount, chatSubtitle]);

  function switchTab(t: 'chats' | 'groups' | 'channels' | 'hidden') {
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
      {(channelCount > 0 || groupCount > 0 || hiddenCount > 0) && (
        <div className="chat-tabs">
          <button
            className={`chat-tab${tab === 'chats' ? ' active' : ''}`}
            onClick={() => switchTab('chats')}
          >
            Chats
          </button>
          {groupCount > 0 && (
            <button
              className={`chat-tab${tab === 'groups' ? ' active' : ''}`}
              onClick={() => switchTab('groups')}
            >
              👥 Groups ({groupCount})
            </button>
          )}
          {channelCount > 0 && (
            <button
              className={`chat-tab${tab === 'channels' ? ' active' : ''}`}
              onClick={() => switchTab('channels')}
            >
              📢 Channels ({channelCount})
            </button>
          )}
          {hiddenCount > 0 && (
            <button
              className={`chat-tab${tab === 'hidden' ? ' active' : ''}`}
              onClick={() => switchTab('hidden')}
            >
              📦 ({hiddenCount})
            </button>
          )}
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
      {presentTags.length > 0 && (
        <div className="tag-filter-row">
          {presentTags.map((t) => (
            <button
              key={t.id}
              className={`tag-chip${tagFilter === t.id ? ' active' : ''}`}
              style={{ borderColor: t.color, color: tagFilter === t.id ? '#fff' : t.color, background: tagFilter === t.id ? t.color : 'transparent' }}
              title={`Filter by ${t.name}`}
              onClick={() => setTagFilter(tagFilter === t.id ? null : t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      <div className="contact-list-scroll">
        {showingSearch ? (
          <>
            {displayRows.length > 0 &&
              displayRows.map((r) => (
                <ChatRow
                  key={r.selId}
                  name={r.name}
                  subtitle={r.subtitle}
                  subtitleTyping={r.subtitleTyping}
                  ts={r.ts}
                  unread={r.unread}
                  active={selectedChat === r.selId}
                  badges={r.badges}
                  linked={r.linked}
                  group={r.group}
                  channel={r.channel}
                  pinned={r.pinned}
                  tags={r.tags}
                  selId={r.selId}
                  onClick={() => void selectChat(r.selId)}
                />
              ))}
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
            {displayRows.length === 0 && results.length === 0 && msgHits.length === 0 && (
              <div className="empty-hint">
                No matches for “{query}”. Enter a phone number to start a new SMS chat.
              </div>
            )}
          </>
        ) : (
          displayRows.map((r) => (
            <ChatRow
              key={r.selId}
              name={r.name}
              subtitle={r.subtitle}
              subtitleTyping={r.subtitleTyping}
              ts={r.ts}
              unread={r.unread}
              active={selectedChat === r.selId}
              badges={r.badges}
              linked={r.linked}
              group={r.group}
              channel={r.channel}
              pinned={r.pinned}
              tags={r.tags}
              selId={r.selId}
              onClick={() => void selectChat(r.selId)}
            />
          ))
        )}

        {!showingSearch && chats.length === 0 && (
          <div className="empty-hint">No chats yet. Search a contact to start one.</div>
        )}

        {!showingSearch && showSmsBackfill && (
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
  badges,
  linked,
  group,
  channel,
  selId,
  pinned,
  tags,
  onClick,
}: {
  name: string;
  subtitle: string;
  subtitleTyping?: boolean;
  ts?: number;
  unread: number;
  active: boolean;
  badge?: string;
  badges?: string[];
  linked?: boolean;
  group?: boolean;
  channel?: boolean;
  pinned?: boolean;
  tags?: { id: number; name: string; color: string }[];
  selId?: string;
  onClick: () => void;
}) {
  const allBadges = badges ?? (badge ? [badge] : []);
  return (
    <button className={`contact-row${active ? ' active' : ''}`} onClick={onClick}>
      <Avatar key={selId ?? name} name={name} chatId={selId && !selId.startsWith('person:') ? selId : undefined} />
      <div className="contact-row-main">
        <div className="contact-row-top">
          <span className="contact-name">
            {group ? '👥 ' : channel ? '📢 ' : ''}
            {linked ? '🔗 ' : ''}
            {pinned && group ? '📌 ' : ''}
            {name}
            {allBadges.map((b, i) => (
              <span key={i} className="provider-badge">{b}</span>
            ))}
          </span>
          {ts ? <span className="contact-time">{formatTime(ts)}</span> : null}
        </div>
        <div className="contact-row-bottom">
          <span className={`contact-preview${subtitleTyping ? ' typing' : ''}`} dir="auto">{subtitle}</span>
          {tags && tags.length > 0 && (
            <span className="tag-chip-row">
              {tags.map((t) => (
                <span key={t.id} className="tag-mini" style={{ borderColor: t.color, color: t.color }}>
                  {t.name}
                </span>
              ))}
            </span>
          )}
          {unread > 0 ? <span className="unread-badge">{unread}</span> : null}
        </div>
      </div>
    </button>
  );
}

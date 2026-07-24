import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { providerBadge } from './AccountSwitcher';
import { formatTime } from './Thread';
import type { Chat, Person } from '../types';

/**
 * Right-drawer profile for a chat or linked person: identity details, linked
 * services management, and send behavior (default service vs reply-to-origin).
 */
export function ProfilePanel({
  chat,
  person,
  memberChats,
  onClose,
}: {
  chat: Chat;
  person: Person | null;
  memberChats: Chat[];
  onClose: () => void;
}) {
  const accounts = useStore((s) => s.accounts);
  const chats = useStore((s) => s.chats);
  const refreshPeople = useStore((s) => s.refreshPeople);
  const refreshChats = useStore((s) => s.refreshChats);
  const [name, setName] = useState(person?.name ?? chat.name ?? chat.title ?? '');
  const [addQuery, setAddQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [onWhatsApp, setOnWhatsApp] = useState<boolean | null>(null);
  const [numbers, setNumbers] = useState<string[]>([]);

  const isDm = chat.type === 'dm';
  const account = accounts.find((a) => a.id === chat.accountId);
  const linkedChats = person ? memberChats : [chat];

  useEffect(() => {
    if (!isDm || !chat.remoteId.startsWith('+')) return;
    void api.contactLookup(chat.remoteId).then((r) => setNumbers(r.numbers)).catch(() => {});
    void api.whatsappCheck(chat.remoteId).then((r) => setOnWhatsApp(r.onWhatsApp)).catch(() => {});
  }, [chat.remoteId, isDm]);

  // Chats that could be linked in (not already linked to this person).
  const linkCandidates = useMemo(() => {
    const q = addQuery.trim().toLowerCase();
    return chats
      .filter((c) => !linkedChats.some((m) => m.id === c.id))
      .filter((c) => c.type === 'dm')
      .filter(
        (c) =>
          !q ||
          c.name?.toLowerCase().includes(q) ||
          c.contactRaw.toLowerCase().includes(q) ||
          c.remoteId.includes(q)
      )
      .slice(0, 6);
  }, [chats, addQuery, linkedChats]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refreshPeople();
      await refreshChats();
    } finally {
      setBusy(false);
    }
  }

  async function linkChat(chatId: string) {
    setAddQuery('');
    if (person) {
      await run(() => api.updatePerson(person.id, { addChatIds: [chatId] }));
    } else {
      const personName = name || chat.name || chat.contactRaw || 'Linked contact';
      await run(() => api.createPerson(personName, [chat.id, chatId], chat.id, 'origin'));
    }
  }

  async function unlinkChat(chatId: string) {
    await run(() => api.updatePerson(person!.id, { removeChatIds: [chatId] }));
  }

  return (
    <>
      <div className="dialog-backdrop" onClick={onClose} />
      <aside className="profile-panel">
        <div className="profile-header">
          <Avatar name={person?.name ?? chat.name ?? chat.title ?? chat.remoteId} size={56} />
          <div className="profile-header-text">
            {person ? (
              <input
                className="profile-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && run(() => api.updatePerson(person.id, { name: name.trim() }))}
              />
            ) : (
              <div className="profile-name">{chat.name ?? chat.title ?? chat.contactRaw ?? chat.remoteId}</div>
            )}
            <div className="profile-sub">
              {chat.type === 'group' ? 'Group' : chat.type === 'channel' ? 'Channel' : 'Direct chat'}
              {account ? ` · ${account.label}` : ''}
            </div>
            {chat.ephemeralSeconds ? (
              <div className="profile-sub">⏳ Disappearing messages on</div>
            ) : null}
          </div>
          <button className="attach-remove" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        {isDm && (
          <div className="profile-section">
            <div className="profile-section-title">Details</div>
            <div className="profile-kv">Number: {chat.remoteId}</div>
            {numbers.length > 1 && (
              <div className="profile-kv">Other numbers: {numbers.filter((n) => n !== chat.remoteId).join(', ')}</div>
            )}
            {onWhatsApp !== null && (
              <div className="profile-kv">
                WhatsApp: {onWhatsApp ? '✓ registered' : 'not on WhatsApp'}
              </div>
            )}
          </div>
        )}

        <div className="profile-section">
          <div className="profile-section-title">Linked services</div>
          <p className="profile-hint">
            Messages from all linked services appear in one conversation. Badges show each
            message's source.
          </p>
          {linkedChats.map((c) => (
            <div key={c.id} className="profile-linked-row">
              <span className="provider-badge">{providerBadge(c.provider)}</span>
              <span className="profile-linked-name">
                {c.name ?? c.title ?? c.contactRaw ?? c.remoteId}
                {person && (
                  <span className="profile-linked-ts">
                    {c.lastMessage ? ` · ${formatTime(c.lastMessage.ts)}` : ''}
                  </span>
                )}
              </span>
              {person && (
                <>
                  <label className="profile-default-label" title="Default service">
                    <input
                      type="radio"
                      name="default-chat"
                      checked={person.defaultChatId === c.id}
                      disabled={busy}
                      onChange={() => void run(() => api.updatePerson(person.id, { defaultChatId: c.id }))}
                    />
                    default
                  </label>
                  <button
                    className="attach-remove"
                    title="Unlink"
                    disabled={busy}
                    onClick={() => void unlinkChat(c.id)}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}

          <div className="profile-add-link">
            <input
              type="search"
              placeholder="Link another chat… (search)"
              value={addQuery}
              onChange={(e) => setAddQuery(e.target.value)}
            />
            {addQuery.trim().length > 0 &&
              linkCandidates.map((c) => (
                <button key={c.id} className="contact-row" disabled={busy} onClick={() => void linkChat(c.id)}>
                  <Avatar name={c.name ?? c.contactRaw ?? c.remoteId} size={28} />
                  <div className="contact-row-main">
                    <div className="contact-row-top">
                      <span className="contact-name">
                        {c.name ?? c.title ?? c.contactRaw ?? c.remoteId}
                        <span className="provider-badge">{providerBadge(c.provider)}</span>
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            {addQuery.trim().length > 0 && linkCandidates.length === 0 && (
              <div className="empty-hint">No unlinked chats match.</div>
            )}
          </div>
        </div>

        {person && (
          <div className="profile-section">
            <div className="profile-section-title">Send behavior</div>
            <label className="profile-radio">
              <input
                type="radio"
                name="send-mode"
                checked={person.sendMode === 'origin'}
                disabled={busy}
                onChange={() => void run(() => api.updatePerson(person.id, { sendMode: 'origin' }))}
              />
              When replying, send to the originating service
            </label>
            <label className="profile-radio">
              <input
                type="radio"
                name="send-mode"
                checked={person.sendMode === 'default'}
                disabled={busy}
                onChange={() => void run(() => api.updatePerson(person.id, { sendMode: 'default' }))}
              />
              Always send to the default service
            </label>
          </div>
        )}
      </aside>
    </>
  );
}

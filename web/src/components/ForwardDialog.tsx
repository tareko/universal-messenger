import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { providerBadge } from './AccountSwitcher';
import type { Message } from '../types';

/** Modal: pick a target chat to forward `message` into (any provider). */
export function ForwardDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const chats = useStore((s) => s.chats);
  const forwardMessage = useStore((s) => s.forwardMessage);
  const [query, setQuery] = useState('');
  const [sending, setSending] = useState(false);

  const targets = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Channels are read-only — nothing can be forwarded into them.
    const list = [...chats]
      .filter((c) => c.type !== 'channel')
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (!q) return list;
    return list.filter(
      (c) =>
        c.name?.toLowerCase().includes(q) ||
        c.title?.toLowerCase().includes(q) ||
        c.contactRaw.toLowerCase().includes(q) ||
        c.remoteId.includes(q)
    );
  }, [chats, query]);

  async function pick(chatId: string) {
    if (sending) return;
    setSending(true);
    try {
      await forwardMessage(message.id, chatId);
      onClose();
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="dialog-backdrop" onClick={onClose} />
      <div className="dialog" role="dialog" aria-label="Forward message">
        <div className="dialog-title">Forward to…</div>
        <div className="dialog-search">
          <input
            autoFocus
            type="search"
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="dialog-list">
          {targets.map((c) => (
            <button
              key={c.id}
              className="contact-row"
              disabled={sending}
              onClick={() => void pick(c.id)}
            >
              <Avatar name={c.name ?? c.title ?? c.contactRaw ?? c.remoteId} size={32} chatId={c.id} />
              <div className="contact-row-main">
                <div className="contact-row-top">
                  <span className="contact-name">
                    {c.type === 'group' ? '👥 ' : ''}
                    {c.name ?? c.title ?? c.contactRaw ?? c.remoteId}
                    <span className="provider-badge">{providerBadge(c.provider)}</span>
                  </span>
                </div>
              </div>
            </button>
          ))}
          {targets.length === 0 && <div className="empty-hint">No chats match “{query}”.</div>}
        </div>
        <div className="dialog-actions">
          <button className="dialog-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

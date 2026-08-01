import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Avatar, primeAvatarCache } from './Avatar';
import { providerBadge } from './AccountSwitcher';
import { formatTime } from './Thread';
import type { Chat, Person, Tag } from '../types';

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Resize/re-encode an image for the DAV PHOTO field (max 512px, JPEG q0.85). */
async function prepareImage(file: Blob): Promise<{ blob: Blob; contentType: string }> {
  const img = await loadImageFromBlob(file);
  const scale = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('cannot get canvas context');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('could not encode image');
  return { blob, contentType: 'image/jpeg' };
}

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
  const notifySettings = useStore((s) => s.notifySettings);
  const toggleMute = useStore((s) => s.toggleMute);
  const refreshPeople = useStore((s) => s.refreshPeople);
  const refreshChats = useStore((s) => s.refreshChats);
  const [name, setName] = useState(person?.name ?? chat.name ?? chat.title ?? '');
  const [addQuery, setAddQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [onWhatsApp, setOnWhatsApp] = useState<boolean | null>(null);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [taxonomy, setTaxonomy] = useState<Tag[]>([]);
  const [avatars, setAvatars] = useState<{ chatId: string; provider: string; url: string | null; uploading?: boolean; failed?: boolean }[]>([]);
  const [picked, setPicked] = useState(false);
  const [pickError, setPickError] = useState('');
  const avatarError = useStore((s) => s.avatarErrors[chat.id] ?? null);
  const setAvatarError = useStore((s) => s.setAvatarError);
  const fileRef = useRef<HTMLInputElement>(null);

  const sourceChats = person ? memberChats : [chat];

  useEffect(() => {
    void api.tags().then(setTaxonomy).catch(() => {});
  }, []);

  /** Refresh the displayed photo after pick/upload and bust the stale cache. */
  async function refreshDisplayedPhoto() {
    try {
      const r = await api.avatar(chat.id);
      if (r.url) {
        primeAvatarCache(chat.id, r.url);
        // Show the new photo in the row too.
        setAvatars((prev) => {
          const rest = prev.filter((a) => a.chatId !== chat.id);
          return [...rest, { chatId: chat.id, provider: chat.provider, url: r.url }];
        });
      }
    } catch {
      /* keep old */
    }
  }

  // Load avatar options from each source chat (one per service for linked people).
  useEffect(() => {
    setAvatars([]);
    setPicked(false);
    setPickError('');
    for (const c of sourceChats) {
      void api
        .avatar(c.id)
        .then((r) => {
          if (r.url) {
            setAvatars((prev) =>
              prev.some((p) => p.chatId === c.id)
                ? prev
                : [...prev, { chatId: c.id, provider: c.provider, url: r.url }]
            );
          }
        })
        .catch(() => {});
    }
  }, [chat.id, person?.id]);

  const isDm = chat.type === 'dm';
  const account = accounts.find((a) => a.id === chat.accountId);
  const linkedChats = person ? memberChats : [chat];
  const muteKey = person ? `person:${person.id}` : chat.id;
  const defaultMuted = chat.type !== 'dm' && !chat.pinned;
  const muted =
    notifySettings.mutedChats.includes(muteKey) ||
    (defaultMuted && !notifySettings.unmutedChats.includes(muteKey));

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
      // The open thread may now span more chats — re-merge the stream.
      await useStore.getState().refreshMessages();
    } finally {
      setBusy(false);
    }
  }

  async function pick(chatId: string, avatarChatId?: string) {
    setPickError('');
    setPicked(false);
    // Optimistic: apply the chosen photo IMMEDIATELY, write to DAV in background.
    const chosen = avatars.find((a) => a.chatId === avatarChatId);
    if (chosen?.url) {
      primeAvatarCache(chatId, chosen.url);
      setAvatars((prev) => {
        const rest = prev.filter((a) => a.chatId !== chatId);
        return [...rest, { chatId, provider: chat.provider, url: chosen.url }];
      });
    }
    void (async () => {
      try {
        await api.pickAvatar(chatId, avatarChatId);
        setAvatarError(chatId, null);
        setPicked(true);
        await refreshDisplayedPhoto();
        await refreshChats();
      } catch (e) {
        setAvatarError(chatId, (e as Error).message);
      }
    })();
  }

  async function onPickPhotoFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setPickError('Only image files are supported.');
      return;
    }
    try {
      const { blob } = await prepareImage(file);
      // Optimistic: show the pasted photo as the profile photo IMMEDIATELY,
      // then upload in the background.
      const objectUrl = URL.createObjectURL(blob);
      setAvatars((prev) => [
        ...prev.filter((a) => a.chatId !== '__pending__'),
        { chatId: '__pending__', provider: 'you', url: objectUrl, uploading: true },
      ]);
      setAvatarError(chat.id, null);
      setPickError('');

      void (async () => {
        try {
          await api.uploadAvatar(chat.id, blob);
          setAvatarError(chat.id, null);
          setPicked(true);
          URL.revokeObjectURL(objectUrl);
          await refreshDisplayedPhoto();
          await refreshChats();
        } catch (e) {
          // Persistent failure — visible until the next success.
          setAvatarError(chat.id, (e as Error).message);
          setAvatars((prev) =>
            prev.map((a) => (a.chatId === '__pending__' ? { ...a, uploading: false, failed: true } : a))
          );
        }
      })();
    } catch (e) {
      setPickError((e as Error).message);
    }
  }
  function onPastePhoto(e: ClipboardEvent) {
    // Prefer the items API (most reliable in Firefox), fall back to files.
    let file: File | null = null;
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        file = item.getAsFile();
        break;
      }
    }
    file ??= Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/')) ?? null;
    if (!file) return;
    e.preventDefault();
    void onPickPhotoFile(file);
  }

  // Firefox only delivers paste events on editable elements or the document —
  // listen at document level while the panel is open.
  useEffect(() => {
    document.addEventListener('paste', onPastePhoto);
    return () => document.removeEventListener('paste', onPastePhoto);
  }, []);

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

        {(isDm || person) && (
          <div className="profile-section">
            <div className="profile-section-title">Profile photo</div>
            <div className="profile-avatars">
              {avatars.map((a) => (
                <button
                  key={a.chatId}
                  className={`profile-avatar-option${a.uploading ? ' uploading' : ''}${a.failed ? ' failed' : ''}`}
                  title={
                    a.chatId === '__pending__'
                      ? a.failed
                        ? 'Upload failed — click to retry'
                        : 'Uploading…'
                      : `Use the ${a.provider} photo for the contact card`
                  }
                  disabled={busy || a.uploading}
                  onClick={() => (a.chatId === '__pending__' ? undefined : void pick(chat.id, a.chatId))}
                >
                  <img src={a.url!} alt={a.provider} className="profile-avatar-img" />
                  <span className="provider-badge">
                    {a.uploading ? '…' : a.failed ? '⚠' : providerBadge(a.provider)}
                  </span>
                </button>
              ))}
              <button
                className="profile-avatar-upload"
                title="Upload or paste a photo for the contact card"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                ＋
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => void onPickPhotoFile(e.target.files?.[0])}
              />
            </div>
            <p className="profile-hint">
              {avatars.some((a) => a.uploading)
                ? 'Uploading in the background…'
                : 'Click a photo to use it, or ＋ to upload/paste your own.'}
            </p>
            {avatarError && (
              <div className="attach-error">Upload failed: {avatarError} (photo kept locally; retry by pasting again)</div>
            )}
            {picked && !avatarError && <div className="profile-avatar-picked">✓ Saved to the contact card</div>}
            {pickError && <div className="attach-error">{pickError}</div>}
          </div>
        )}

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

        {chat.type === 'group' && (
          <div className="profile-section">
            <div className="profile-section-title">Placement</div>
            <button
              className="dialog-cancel"
              disabled={busy}
              onClick={() =>
                void run(() => api.pinChat(chat.id, !chat.pinned))
              }
            >
              {chat.pinned ? '📌 Pinned to main chats — click to move to Groups tab' : 'Move to main chats (pin)'}
            </button>
          </div>
        )}

        <div className="profile-section">
          <div className="profile-section-title">Visibility</div>
          <button
            className="dialog-cancel"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const key = person ? `person:${person.id}` : chat.id;
                const hidden = person ? memberChats.every((c) => c.hidden) : Boolean(chat.hidden);
                await api.hideChat(key, !hidden);
                if (!hidden) {
                  // Hiding the open conversation: close panel + thread.
                  onClose();
                  useStore.getState().closeChat();
                }
              })
            }
          >
            {(
              person
                ? memberChats.every((c) => c.hidden)
                : Boolean(chat.hidden)
            )
              ? '📦 Hidden — click to unhide'
              : person
                ? `Hide this person (all ${memberChats.length} services)`
                : 'Hide conversation'}
          </button>
        </div>

        <div className="profile-section">
          <div className="profile-section-title">Notifications</div>
          <button className="dialog-cancel" disabled={busy} onClick={() => void toggleMute(muteKey)}>
            {muted
              ? defaultMuted
                ? '🔕 Muted (groups default) — click to unmute'
                : '🔕 Muted — click to unmute'
              : '🔔 Enabled — click to mute'}
          </button>
        </div>

        <div className="profile-section">
          <div className="profile-section-title">AI features</div>
          <label className="profile-radio">
            <input
              type="checkbox"
              checked={Boolean(chat.translateEnabled)}
              disabled={busy}
              onChange={(e) => void run(() => api.setTranslateEnabled(chat.id, e.target.checked))}
            />
            Enable message translation (🌐) for this chat
          </label>
          <label className="profile-radio">
            <input
              type="checkbox"
              checked={Boolean(chat.suggestEnabled)}
              disabled={busy}
              onChange={(e) => void run(() => api.setSuggestEnabled(chat.id, e.target.checked))}
            />
            Auto-suggest replies (✨) when I open this chat
          </label>
        </div>

        <div className="profile-section">
          <div className="profile-section-title">Tags</div>
          <div className="profile-tags">
            {(chat.tags ?? []).map((t) => (
              <span key={t.id} className="tag-mini" style={{ borderColor: t.color, color: t.color }}>
                {t.name}
                <button
                  className="tag-remove"
                  title="Remove tag"
                  disabled={busy}
                  onClick={() => void run(() => api.removeChatTag(chat.id, t.id))}
                >
                  ✕
                </button>
              </span>
            ))}
            {(chat.tags ?? []).length === 0 && <span className="profile-hint">No tags yet.</span>}
          </div>
          <div className="profile-tag-add">
            <select
              value=""
              disabled={busy}
              onChange={(e) => {
                const tagId = Number(e.target.value);
                if (!tagId) return;
                void run(() =>
                  api.setChatTags(chat.id, [...(chat.tags ?? []).map((t) => t.id), tagId])
                );
              }}
            >
              <option value="">+ Add tag…</option>
              {taxonomy
                .filter((t) => !(chat.tags ?? []).some((ct) => ct.id === t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </div>
        </div>

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
                  <Avatar name={c.name ?? c.contactRaw ?? c.remoteId} size={28} chatId={c.id} />
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, isPersonSelection } from '../store';
import { api } from '../api';
import { EmojiPicker } from './EmojiPicker';
import { providerBadge } from './AccountSwitcher';
import { searchEmojis } from '../emoji';

const SMS_LIMIT = 160;
const MMS_LIMIT = 2048;
const MAX_BYTES = 1_100_000;

interface Attachment {
  blob: Blob;
  contentType: string;
  previewUrl: string;
  name: string;
  size: number;
}

interface EmojiToken {
  start: number;
  query: string;
}

interface MentionCandidate {
  name: string;
  memberId: string;
  source: 'participant' | 'contact';
}

/** Find an `@partial` mention token immediately before the caret. */
function mentionTokenAt(text: string, caret: number): EmojiToken | null {
  const before = text.slice(0, caret);
  const m = before.match(/(^|\s)@([a-z0-9_+\-. ]{1,30})$/i);
  if (!m || m.index === undefined) return null;
  return { start: m.index + m[1].length, query: m[2].toLowerCase() };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function prepareImage(file: File): Promise<{ blob: Blob; contentType: string }> {
  if (file.size <= MAX_BYTES && (file.type === 'image/jpeg' || file.type === 'image/png')) {
    return { blob: file, contentType: file.type };
  }
  const img = await loadImage(file);
  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('cannot get canvas context');
  ctx.drawImage(img, 0, 0, w, h);
  for (const q of [0.85, 0.75, 0.6, 0.45, 0.3]) {
    const blob = await canvasToBlob(canvas, 'image/jpeg', q);
    if (blob && blob.size <= MAX_BYTES) return { blob, contentType: 'image/jpeg' };
  }
  const blob = await canvasToBlob(canvas, 'image/png');
  if (blob) return { blob, contentType: 'image/png' };
  throw new Error('could not encode image');
}

/** Find a `:shortcod` token immediately before the caret. */
function tokenAt(text: string, caret: number): EmojiToken | null {
  const before = text.slice(0, caret);
  // Colon must be at start or after a non-word char; query is letters/digits/_/-/+.
  const m = before.match(/(^|[^a-z0-9_]):([a-z0-9_+-]{1,20})$/i);
  if (!m || m.index === undefined) return null;
  return { start: m.index + m[1].length, query: m[2].toLowerCase() };
}

export function Composer() {
  const selectedChat = useStore((s) => s.selectedChat);
  const chats = useStore((s) => s.chats);
  const people = useStore((s) => s.people);
  const aiEnabled = useStore((s) => s.status?.ai?.enabled ?? false);
  const replyTo = useStore((s) => s.replyTo);
  const setReplyTo = useStore((s) => s.setReplyTo);
  const editing = useStore((s) => s.editing);
  const setEditing = useStore((s) => s.setEditing);
  const submitEdit = useStore((s) => s.submitEdit);
  const sendMessage = useStore((s) => s.sendMessage);
  const sendMedia = useStore((s) => s.sendMedia);
  const [text, setText] = useState('');
  const setDraft = useStore((s) => s.setDraft);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [token, setToken] = useState<EmojiToken | null>(null);
  const [selIdx, setSelIdx] = useState(0);
  const [aiSuggestions, setAiSuggestions] = useState<{ chatId: string; items: string[] } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  // @mention autocomplete state
  const [mentionToken, setMentionToken] = useState<EmojiToken | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [participants, setParticipants] = useState<{ id: string; name: string }[]>([]);
  const [contactMatches, setContactMatches] = useState<MentionCandidate[]>([]);
  const [mentions, setMentions] = useState<{ name: string; memberId: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const chat = chats.find((c) => c.id === selectedChat);
  // SMS character accounting only applies to SMS/MMS providers.
  const isSms = chat?.provider === 'voipms';

  // Linked person: per-message service override via the split send button.
  const person = isPersonSelection(selectedChat)
    ? people.find((p) => `person:${p.id}` === selectedChat)
    : people.find((p) => selectedChat != null && p.chatIds.includes(selectedChat));
  const memberChats = person ? chats.filter((c) => person.chatIds.includes(c.id)) : [];
  const [targetOverride, setTargetOverride] = useState<string | null>(null);
  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  useEffect(() => {
    setTargetOverride(null);
    setMentions([]);
    setParticipants([]);
    setAiSuggestions(null);
    // Restore this chat's draft (empty box for chats without one).
    setText(selectedChat ? (useStore.getState().drafts[selectedChat] ?? '') : '');
    // Auto-suggest replies for chats opted in via the profile.
    if (chat?.suggestEnabled && aiEnabled && selectedChat) {
      void fetchSuggestions();
    }
    // Load group participants for @mention autocomplete.
    if (chat?.type === 'group') {
      void api.participants(chat.id).then(setParticipants).catch(() => setParticipants([]));
    }
  }, [selectedChat, chat?.id, chat?.type]);

  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (!mentionToken) return [];
    const q = mentionToken.query;
    const fromChat = participants
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map((p) => ({ name: p.name, memberId: p.id, source: 'participant' as const }));
    return [...fromChat, ...contactMatches].slice(0, 7);
  }, [mentionToken, participants, contactMatches]);
  const showMentionSuggest = mentionCandidates.length > 0;

  // Second-tier suggestions: DAV contacts when the @ query has few local hits.
  useEffect(() => {
    const q = mentionToken?.query ?? '';
    if (!mentionToken || q.length < 2 || participants.filter((p) => p.name.toLowerCase().includes(q)).length >= 5) {
      setContactMatches([]);
      return;
    }
    let active = true;
    const t = setTimeout(async () => {
      try {
        const r = await api.contacts(q);
        if (active) {
          setContactMatches(
            r.slice(0, 5).map((c) => ({ name: c.name, memberId: c.tel, source: 'contact' as const }))
          );
        }
      } catch {
        /* ignore */
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [mentionToken, participants]);

  const suggestions = token ? searchEmojis(token.query, 8) : [];
  const showSuggest = suggestions.length > 0;

  // Quote-reply (double-click or ↩) → put the cursor in the textbox.
  useEffect(() => {
    if (replyTo) taRef.current?.focus();
  }, [replyTo]);

  // Entering edit mode: prefill the draft with the message body.
  useEffect(() => {
    if (editing) {
      setText(editing.body);
      taRef.current?.focus();
    } else if (selectedChat) {
      setText(useStore.getState().drafts[selectedChat] ?? '');
    }
  }, [editing, selectedChat]);

  // Persist the draft continuously (cheap) so it survives chat switches.
  useEffect(() => {
    if (selectedChat) setDraft(selectedChat, text);
  }, [text, selectedChat, setDraft]);

  // Tell the provider we're typing (throttled; providers time it out themselves).
  const lastTypingSent = useRef(0);
  useEffect(() => {
    if (!selectedChat || !text.trim()) return;
    const now = Date.now();
    if (now - lastTypingSent.current < 4000) return;
    lastTypingSent.current = now;
    void api.typing(selectedChat).catch(() => {});
  }, [text, selectedChat]);

  useEffect(() => () => {
    if (attachment) URL.revokeObjectURL(attachment.previewUrl);
  }, [attachment]);

  const hasImage = Boolean(attachment);
  const mmsMode = isSms && (hasImage || text.length > SMS_LIMIT);
  const limit = isSms ? (mmsMode ? MMS_LIMIT : SMS_LIMIT) : Infinity;
  const overLimit = text.length > limit;
  const trimmed = text.trim();
  const canSend = Boolean(trimmed || hasImage) && !overLimit;

  function recomputeToken(value: string) {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? value.length;
    const newToken = tokenAt(value, caret);
    // Only reset the suggestion index when the query actually changes, so
    // arrow-key navigation isn't wiped out.
    if (newToken?.query !== token?.query) setSelIdx(0);
    setToken(newToken);
    // @mention autocomplete (group chats only)
    const mToken = chat?.type === 'group' ? mentionTokenAt(value, caret) : null;
    if (mToken?.query !== mentionToken?.query) setMentionIdx(0);
    setMentionToken(mToken);
  }

  function acceptMention(idx: number) {
    const c = mentionCandidates[idx];
    if (!c || !mentionToken) return;
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? text.length;
    replaceRange(mentionToken.start, caret, `@${c.name} `);
    setMentions((prev) => [...prev.filter((m) => m.memberId !== c.memberId), { name: c.name, memberId: c.memberId }]);
    setMentionToken(null);
  }

  function replaceRange(start: number, end: number, insert: string) {
    const ta = taRef.current;
    const next = text.slice(0, start) + insert + text.slice(end);
    setText(next);
    const pos = start + insert.length;
    setToken(null);
    requestAnimationFrame(() => {
      if (ta) {
        ta.selectionStart = ta.selectionEnd = pos;
        ta.focus();
      }
    });
  }

  function insertAtCursor(char: string) {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? text.length;
    replaceRange(caret, caret, char);
  }

  function acceptSuggestion(idx: number) {
    const e = suggestions[idx];
    if (!e || !token) return;
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? text.length;
    replaceRange(token.start, caret, e.char);
  }

  async function onPickFile(file: File | undefined) {
    setPrepError(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setPrepError('Only image attachments are supported.');
      return;
    }
    try {
      const { blob, contentType } = await prepareImage(file);
      if (attachment) URL.revokeObjectURL(attachment.previewUrl);
      setAttachment({
        blob,
        contentType,
        name: file.name || 'pasted-image',
        size: blob.size,
        previewUrl: URL.createObjectURL(blob),
      });
    } catch (e) {
      setPrepError((e as Error).message || 'Could not prepare image');
    }
  }

  // Paste an image from the clipboard (like WhatsApp Web) → becomes an
  // attachment with the normal caption flow.
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const file = Array.from(e.clipboardData?.files ?? []).find((f) =>
      f.type.startsWith('image/')
    );
    if (!file) return; // plain-text paste proceeds normally
    e.preventDefault();
    void onPickFile(file);
  }

  async function submit() {
    if (!canSend) return;
    if (editing) {
      const body = trimmed;
      setText('');
      await submitEdit(body);
      return;
    }
    const body = trimmed;
    const forced = targetOverride ?? undefined;
    const picked = mentions.filter((m) => body.includes(`@${m.name}`));
    setTargetOverride(null); // override is per-message
    setMentions([]);
    if (attachment) {
      const att = attachment;
      setAttachment(null);
      setText('');
      setPrepError(null);
      await sendMedia(att.blob, att.contentType, body, att.previewUrl, forced);
    } else {
      setText('');
      setPrepError(null);
      await sendMessage(body, forced, picked);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (showMentionSuggest) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptMention(mentionIdx);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionToken(null);
        return;
      }
    }
    if (showSuggest) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptSuggestion(selIdx);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setToken(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  async function fetchSuggestions() {
    const targetChat = useStore.getState().targetChatId();
    if (!targetChat || suggesting) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const r = await api.aiSuggest(targetChat);
      // Tag suggestions to the chat they were requested for — if the user
      // has since switched chats, they show THERE, not here.
      setAiSuggestions(r.suggestions.length ? { chatId: targetChat, items: r.suggestions } : null);
      if (!r.suggestions.length) setSuggestError('No suggestions came back');
    } catch (e) {
      setAiSuggestions(null);
      setSuggestError((e as Error).message);
      setTimeout(() => setSuggestError(null), 4000);
    } finally {
      setSuggesting(false);
    }
  }

  function applySuggestion(text2: string) {
    setText(text2);
    setAiSuggestions(null);
    taRef.current?.focus();
  }

  if (!selectedChat) return null;

  // WhatsApp channels (newsletters) are broadcast-only for followers.
  if (chat?.type === 'channel') {
    return (
      <div className="composer">
        <div className="channel-readonly">📢 This is a channel — only the owner can post.</div>
      </div>
    );
  }

  return (
    <div className="composer">
      <div className="composer-btn-col">
        <button
          className="tool-btn"
          title="Emoji"
          onClick={() => setPickerOpen((v) => !v)}
        >
          😀
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => void onPickFile(e.target.files?.[0])}
        />
        {aiEnabled && (
          <button
            className={`tool-btn${suggesting ? ' spin' : ''}${suggestError ? ' error' : ''}`}
            title={
              suggesting
                ? 'Asking the AI for reply suggestions…'
                : suggestError
                  ? `Suggestions failed: ${suggestError}`
                  : 'Suggest replies (AI)'
            }
            disabled={suggesting}
            onClick={() => void fetchSuggestions()}
          >
            ✨
          </button>
        )}
        <button
          className="tool-btn"
          title="Attach image"
          onClick={() => fileRef.current?.click()}
        >
          ＋
        </button>
        {pickerOpen && (
          <EmojiPicker
            onPick={(char) => {
              insertAtCursor(char);
              taRef.current?.focus();
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>

      <div className="composer-input-col">
        {editing && (
          <div className="reply-preview">
            <div className="reply-preview-bar" />
            <div className="reply-preview-body">
              <span className="reply-preview-author">Editing message</span>
              <span className="reply-preview-text">{editing.body}</span>
            </div>
            <button className="attach-remove" title="Cancel edit" onClick={() => setEditing(null)}>
              ✕
            </button>
          </div>
        )}
        {aiSuggestions && aiSuggestions.chatId === selectedChat && (
          <div className="ai-suggestions">
            <div className="ai-suggestions-head">
              <span>✨ AI suggestions</span>
              <button className="attach-remove" onClick={() => setAiSuggestions(null)}>✕</button>
            </div>
            {aiSuggestions.items.map((sug, i) => (
              <button key={i} className="ai-suggestion" onClick={() => applySuggestion(sug)} dir="auto">
                {sug}
              </button>
            ))}
          </div>
        )}
        {showMentionSuggest && (
          <div className="emoji-suggest">
            {mentionCandidates.map((c, i) => (
              <button
                key={c.memberId}
                className={`emoji-suggest-row${i === mentionIdx ? ' active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptMention(i);
                }}
                onMouseEnter={() => setMentionIdx(i)}
              >
                <span className="emoji-suggest-char">@</span>
                <span className="emoji-suggest-code">{c.name}</span>
                {c.source === 'contact' && <span className="mention-source">contact</span>}
              </button>
            ))}
          </div>
        )}
        {replyTo && (
          <div className="reply-preview">
            <div className="reply-preview-bar" />
            <div className="reply-preview-body">
              <span className="reply-preview-author">
                {replyTo.outgoing === 1 ? 'You' : (chat?.name ?? chat?.contactRaw ?? '')}
              </span>
              <span className="reply-preview-text">
                {replyTo.body || (replyTo.media?.length ? '📷 Photo' : '')}
              </span>
            </div>
            <button className="attach-remove" title="Cancel reply" onClick={() => setReplyTo(null)}>
              ✕
            </button>
          </div>
        )}
        {showSuggest && (
          <div className="emoji-suggest">
            {suggestions.map((s, i) => (
              <button
                key={s.char + (s.shortcodes[0] ?? '')}
                className={`emoji-suggest-row${i === selIdx ? ' active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptSuggestion(i);
                }}
                onMouseEnter={() => setSelIdx(i)}
              >
                <span className="emoji-suggest-char">{s.char}</span>
                <span className="emoji-suggest-code">:{s.shortcodes[0]}</span>
              </button>
            ))}
          </div>
        )}
        {attachment && (
          <div className="attach-preview">
            <img src={attachment.previewUrl} alt={attachment.name} />
            <div className="attach-info">
              <span className="attach-name">{attachment.name}</span>
              <span className="attach-size">{Math.round(attachment.size / 1024)} KB</span>
            </div>
            <button
              className="attach-remove"
              title="Remove"
              onClick={() => {
                URL.revokeObjectURL(attachment.previewUrl);
                setAttachment(null);
              }}
            >
              ✕
            </button>
          </div>
        )}
        {prepError && <div className="attach-error">{prepError}</div>}
        <textarea
          ref={taRef}
          rows={1}
          placeholder={hasImage ? 'Add a caption (optional)…' : 'Type a message…'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            recomputeToken(e.target.value);
          }}
          onPaste={onPaste}
          onKeyUp={(e) => {
            if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
            recomputeToken(text);
          }}
          onClick={() => recomputeToken(text)}
          onBlur={() => setTimeout(() => setToken(null), 150)}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className="composer-meta">
        {isSms && (
          <span className={`counter${overLimit ? ' over' : ''}`}>
            {text.length}/{limit}
            {mmsMode && <span className="mms-tag">MMS</span>}
          </span>
        )}
        <div className="send-wrap">
          <button
            className={`send-btn${memberChats.length > 1 ? ' split' : ''}`}
            disabled={!canSend}
            onClick={() => void submit()}
          >
            Send
            {editing ? ' (save)' : ''}
            {targetOverride && (
              <span className="provider-badge send-target-badge">
                {providerBadge(
                  memberChats.find((c) => c.id === targetOverride)?.provider ?? ''
                )}
              </span>
            )}
          </button>
          {memberChats.length > 1 && (
            <>
              <button
                className="send-caret"
                title="Choose service for this message"
                onClick={() => setTargetMenuOpen((v) => !v)}
              >
                ▾
              </button>
              {targetMenuOpen && (
                <>
                  <div className="react-backdrop" onClick={() => setTargetMenuOpen(false)} />
                  <div className="send-target-menu">
                    {memberChats.map((c) => (
                      <button
                        key={c.id}
                        className="send-target-row"
                        onClick={() => {
                          setTargetOverride(c.id);
                          setTargetMenuOpen(false);
                        }}
                      >
                        <span className="provider-badge">{providerBadge(c.provider)}</span>
                        <span className="send-target-name">
                          {c.name ?? c.contactRaw ?? c.remoteId}
                        </span>
                        {(targetOverride ?? person?.defaultChatId) === c.id && (
                          <span className="send-target-check">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

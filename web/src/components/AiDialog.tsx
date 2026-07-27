import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { Tag } from '../types';

const PALETTE = ['#008069', '#1976d2', '#d32f2f', '#7c4dff', '#f57c00', '#2e7d32', '#c2185b', '#5d4037'];

/** AI settings: tag taxonomy editor, classification job, stats tags. */
export function AiDialog({ onClose }: { onClose: () => void }) {
  const refreshChats = useStore((s) => s.refreshChats);
  const [tags, setTags] = useState<Tag[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(PALETTE[0]);
  const [progress, setProgress] = useState<{ running: boolean; total: number; done: number; tagged: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setTags(await api.tags());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Poll classification progress while running.
  useEffect(() => {
    if (!progress?.running) return;
    const t = setInterval(async () => {
      const p = await api.aiClassifyStatus();
      setProgress(p);
      if (!p.running) void refreshChats();
    }, 2000);
    return () => clearInterval(t);
  }, [progress?.running, refreshChats]);

  async function addTag() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.createTag(name.trim(), description.trim(), color);
      setName('');
      setDescription('');
      setColor(PALETTE[(tags.length + 1) % PALETTE.length]);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function startClassify() {
    setBusy(true);
    try {
      await api.aiClassifyStart();
      setProgress(await api.aiClassifyStatus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="dialog-backdrop" onClick={onClose} />
      <div className="dialog" role="dialog" aria-label="AI settings">
        <div className="dialog-title">AI settings</div>

        <div className="dialog-section">
          <div className="dialog-section-title">Tag taxonomy</div>
          {tags.map((t) => (
            <div key={t.id} className="tag-edit-row">
              <span className="tag-dot" style={{ background: t.color }} />
              <div className="tag-edit-info">
                <div className="tag-edit-name">{t.name}</div>
                {t.description && <div className="tag-edit-desc">{t.description}</div>}
              </div>
              <button
                className="attach-remove"
                title="Delete tag"
                onClick={() => void api.deleteTag(t.id).then(reload)}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="tg-form">
            <input placeholder="New tag name (e.g. family)" value={name} onChange={(e) => setName(e.target.value)} />
            <input
              placeholder="Description (helps the AI match meaning)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="tag-color-row">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className={`tag-color-dot${color === c ? ' active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <button className="dialog-cancel" disabled={busy || !name.trim()} onClick={() => void addTag()}>
              Add tag
            </button>
          </div>
        </div>

        <div className="dialog-section">
          <div className="dialog-section-title">Classification</div>
          <p className="profile-hint">
            Classify chats into your tags using the local AI (last ~30 messages per chat).
            Manual tags are never overwritten.
          </p>
          <button className="dialog-cancel" disabled={busy || progress?.running} onClick={() => void startClassify()}>
            {progress?.running ? `Classifying… ${progress.done}/${progress.total}` : 'Categorize all chats'}
          </button>
          {progress && !progress.running && progress.total > 0 && (
            <p className="profile-hint">
              Done: {progress.tagged} of {progress.total} chats tagged.
            </p>
          )}
          <button
            className="dialog-cancel"
            disabled={busy}
            onClick={() => void api.aiStatsTags().then(() => refreshChats())}
          >
            Recompute “frequent contact”
          </button>
        </div>

        <div className="dialog-actions">
          <button className="dialog-cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

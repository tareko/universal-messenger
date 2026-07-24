import { useEffect, useMemo, useRef, useState } from 'react';
import { pickerEmojis } from '../emoji';

export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (char: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const list = useMemo(() => pickerEmojis(query).slice(0, 240), [query]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  return (
    <div className="emoji-picker" ref={ref}>
      <input
        className="emoji-search"
        autoFocus
        placeholder="Search emoji…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="emoji-grid">
        {list.map((e) => (
          <button
            key={e.char + e.shortcodes[0]}
            className="emoji-cell"
            title={`:${e.shortcodes[0] ?? ''}`}
            onClick={() => onPick(e.char)}
          >
            {e.char}
          </button>
        ))}
        {list.length === 0 && <div className="emoji-empty">No emoji found</div>}
      </div>
    </div>
  );
}

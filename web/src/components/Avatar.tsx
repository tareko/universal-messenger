import { useEffect, useState } from 'react';
import { api } from '../api';

const cache = new Map<string, string | null>();

function useAvatarUrl(chatId?: string): string | null {
  const [url, setUrl] = useState<string | null>(chatId ? (cache.get(chatId) ?? null) : null);
  useEffect(() => {
    if (!chatId || cache.has(chatId)) return;
    let active = true;
    void api
      .avatar(chatId)
      .then((r) => {
        cache.set(chatId, r.url);
        if (active) setUrl(r.url);
      })
      .catch(() => cache.set(chatId, null));
    return () => {
      active = false;
    };
  }, [chatId]);
  return url;
}

export function Avatar({ name, size = 40, chatId }: { name: string; size?: number; chatId?: string }) {
  const url = useAvatarUrl(chatId);
  const [imgOk, setImgOk] = useState(true);

  useEffect(() => setImgOk(true), [url]);

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

  if (url && imgOk) {
    return (
      <img
        className="avatar avatar-photo"
        src={url}
        alt={name}
        style={{ width: size, height: size }}
        onError={() => setImgOk(false)}
      />
    );
  }

  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        background: `hsl(${hue} 45% 55%)`,
        fontSize: size * 0.4,
      }}
    >
      {initials || '?'}
    </div>
  );
}

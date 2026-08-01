import { useEffect, useState } from 'react';
import { api } from '../api';

const cache = new Map<string, string | null>();

function useAvatarUrl(chatId?: string): string | null {
  const [url, setUrl] = useState<string | null>(chatId ? (cache.get(chatId) ?? null) : null);
  useEffect(() => {
    // Sync with the current chatId (rows get reused in reordered lists).
    setUrl(chatId ? (cache.get(chatId) ?? null) : null);
    if (!chatId || cache.has(chatId)) return;
    let active = true;
    const fetchOnce = () => {
      void api
        .avatar(chatId)
        .then((r) => {
          if (!active) return;
          // Only successful fetches are cached — misses retry on next mount.
          if (r.url) cache.set(chatId, r.url);
          setUrl(r.url);
          // Provider was mid-connect: retry once shortly.
          if (r.retry && active) setTimeout(() => active && fetchOnce(), 15_000);
        })
        .catch(() => {
          /* retry on next mount */
        });
    };
    fetchOnce();
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
        onError={() => {
          // Transient failures (server restart, network) shouldn't hide the
          // photo forever — retry shortly instead of latching to initials.
          setImgOk(false);
          setTimeout(() => setImgOk(true), 30_000);
        }}
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

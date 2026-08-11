import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';

const cache = new Map<string, string | null>();

// Persist across reloads so photos render instantly with no fetch at all.
try {
  const saved = localStorage.getItem('um-avatars');
  if (saved) for (const [k, v] of JSON.parse(saved) as [string, string][]) cache.set(k, v);
} catch {
  /* ignore */
}

function persistCache(): void {
  try {
    localStorage.setItem('um-avatars', JSON.stringify([...cache].slice(-800)));
  } catch {
    /* ignore */
  }
}

/** Prime the avatar cache with a fresh URL (after pick/upload). */
export function primeAvatarCache(chatId: string, url: string): void {
  cache.set(chatId, url);
  persistCache();
  useStore.getState().bumpAvatarVersion();
}

function useAvatarUrl(chatId?: string): string | null {
  const [url, setUrl] = useState<string | null>(chatId ? (cache.get(chatId) ?? null) : null);
  const avatarVersion = useStore((s) => s.avatarVersion);
  useEffect(() => {
    // Sync with the current chatId (rows get reused in reordered lists).
    setUrl(chatId ? (cache.get(chatId) ?? null) : null);
    if (!chatId || cache.has(chatId)) return;
    let active = true;
    let attempts = 0;
    const fetchOnce = () => {
      void api
        .avatar(chatId)
        .then((r) => {
          if (!active) return;
          // Only successful fetches are cached — misses retry on next mount.
          if (r.url) {
            cache.set(chatId, r.url);
            persistCache();
          }
          setUrl(r.url);
          // Server is fetching in the background (or provider still connecting):
          // retry a few times until it lands.
          if (r.retry && active && attempts < 3) {
            attempts++;
            setTimeout(() => active && fetchOnce(), 12_000);
          }
        })
        .catch(() => {
          /* retry on next mount */
        });
    };
    fetchOnce();
    return () => {
      active = false;
    };
  }, [chatId, avatarVersion]);
  return url;
}

export function Avatar({ name, size = 40, chatId }: { name: string; size?: number; chatId?: string }) {
  const url = useAvatarUrl(chatId);
  const [imgOk, setImgOk] = useState(true);
  const retries = useRef(0);

  useEffect(() => {
    setImgOk(true);
    retries.current = 0;
  }, [url]);

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
          // Transient failures (server restart, network) — retry twice, then
          // give up to initials (no infinite retry loops accumulating).
          if (retries.current < 2) {
            retries.current++;
            setImgOk(false);
            setTimeout(() => setImgOk(true), 30_000);
          } else {
            setImgOk(false);
          }
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

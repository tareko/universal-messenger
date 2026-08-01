import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { config, projectRoot } from '../config.js';
import type { MediaRef } from '../types.js';

const mediaDir = resolve(projectRoot, 'data', 'media');
const avatarDir = resolve(projectRoot, 'data', 'media', 'avatars');
mkdirSync(mediaDir, { recursive: true });
mkdirSync(avatarDir, { recursive: true });

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
};

function extFor(contentType: string): string {
  return EXT_BY_TYPE[contentType.toLowerCase()] ?? 'bin';
}

function contentTypeForFile(file: string): string {
  const ext = extname(file).slice(1).toLowerCase();
  for (const [ct, e] of Object.entries(EXT_BY_TYPE)) {
    if (e === ext) return ct;
  }
  return 'application/octet-stream';
}

export function getMediaPath(file: string): string {
  return resolve(mediaDir, basename(file));
}

export function mediaContentType(file: string): string {
  return contentTypeForFile(basename(file));
}

/** Read a cached media ref back into memory (e.g. to forward it elsewhere). */
export function loadMediaBuffer(ref: MediaRef): { data: string; contentType: string } | null {
  try {
    const file = basename(ref.url);
    const buf = readFileSync(getMediaPath(file));
    return { data: buf.toString('base64'), contentType: ref.contentType };
  } catch {
    return null;
  }
}

/** Save a profile avatar and return its local ref (stable filename per key). */
export function saveAvatar(key: string, buf: Buffer, contentType: string): MediaRef {
  const ct = (contentType || 'image/jpeg').split(';')[0].trim();
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 20);
  const file = `${hash}.${extFor(ct)}`;
  writeFileSync(resolve(avatarDir, file), buf);
  return { url: `/api/media/avatars/${file}`, contentType: ct };
}

export function getAvatarPath(file: string): string {
  return resolve(avatarDir, basename(file));
}

/** Save an uploaded attachment buffer (outgoing media) and return its local ref. */
export function saveUploadedMedia(buf: Buffer, contentType: string): MediaRef {
  const ct = contentType || 'image/jpeg';
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 20);
  const file = `${hash}.${extFor(ct)}`;
  writeFileSync(resolve(mediaDir, file), buf);
  return { url: `/api/media/${file}`, contentType: ct };
}

/** Save a provider-downloaded buffer and return its local ref. */
export function saveMediaBuffer(buf: Buffer, contentType: string, key?: string): MediaRef {
  const ct = (contentType || 'application/octet-stream').split(';')[0].trim();
  const hash = createHash('sha1').update(key ?? buf).digest('hex').slice(0, 20);
  const file = `${hash}.${extFor(ct)}`;
  writeFileSync(resolve(mediaDir, file), buf);
  return { url: `/api/media/${file}`, contentType: ct };
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${config.voipms.username}:${config.voipms.password}`).toString('base64');
}

/**
 * Download a remote media URL and cache it locally. For voip.ms media.php URLs,
 * retries with API Basic auth if the server rejects (401/403).
 */
export async function downloadAndCacheMedia(url: string): Promise<MediaRef | null> {
  const isVoipMs = url.includes('voip.ms');
  const attempts: Record<string, string>[] = isVoipMs ? [{}, { Authorization: authHeader() }] : [{}];
  for (const headers of attempts) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 401 || res.status === 403) continue; // try with auth next round
      if (!res.ok) {
        console.error(`[media] download ${res.status} for ${url}`);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const contentType = (res.headers.get('content-type')?.split(';')[0] || 'image/jpeg').trim();
      return saveMediaBuffer(buf, contentType, url);
    } catch (e) {
      console.error('[media] download failed for', url, (e as Error).message);
      // try auth round if available, else give up
    }
  }
  return null;
}

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
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/mpeg': 'mpg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/zip': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/x-7z-compressed': '7z',
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

/** Save a profile avatar and return its local ref (content-hashed filename). */
export function saveAvatar(key: string, buf: Buffer, contentType: string): MediaRef {
  const ct = (contentType || 'image/jpeg').split(';')[0].trim();
  // Content hash in the filename: replacing a photo yields a NEW url, so
  // browsers never serve a stale cached image.
  const hash = createHash('sha1').update(key).update(buf).digest('hex').slice(0, 20);
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
export function saveMediaBuffer(buf: Buffer, contentType: string, key?: string, name?: string): MediaRef {
  const ct = (contentType || 'application/octet-stream').split(';')[0].trim();
  const hash = createHash('sha1').update(key ?? buf).digest('hex').slice(0, 20);
  const file = `${hash}.${extFor(ct)}`;
  writeFileSync(resolve(mediaDir, file), buf);
  return { url: `/api/media/${file}`, contentType: ct, ...(name ? { name } : {}) };
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

import { config } from '../../config.js';

const API_BASE = 'https://voip.ms/api/v1/rest.php';

export class VoipMsError extends Error {
  code: string;
  constructor(code: string) {
    super(`voip.ms API error: ${code}`);
    this.code = code;
  }
}

interface SmsRow {
  id: string;
  date: string;
  type: string; // '0' sent, '1' received
  did: string;
  contact: string;
  message: string;
  carrier_status?: string;
  media?: string[];
  col_media1?: string;
  col_media2?: string;
  col_media3?: string;
}

/** A raw voip.ms SMS/MMS row, normalized to plain fields (pre-provider-mapping). */
export interface VoipMsSms {
  id: string;
  date: string;
  ts: number;
  type: 0 | 1; // 0 sent, 1 received
  did: string;
  contact: string;
  contactRaw: string;
  message: string;
  carrierStatus: string;
  mediaUrls?: string[]; // MMS attachment URLs (voip.ms media.php)
}

export interface MmsMedia {
  data: string; // raw base64 (no data: prefix)
  contentType: string;
}

async function call(method: string, params: Record<string, string | number | undefined> = {}) {
  if (!config.voipms.username || !config.voipms.password) {
    throw new VoipMsError('missing_credentials');
  }
  const url = new URL(API_BASE);
  url.searchParams.set('api_username', config.voipms.username);
  url.searchParams.set('api_password', config.voipms.password);
  url.searchParams.set('method', method);
  url.searchParams.set('content_type', 'json');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new VoipMsError(`http_${res.status}`);
  }
  if (data.status !== 'success') {
    throw new VoipMsError(String(data.status ?? 'unknown'));
  }
  return data;
}

/** voip.ms URL-encodes message bodies with '+' meaning space. */
function decodeMessage(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * Convert a naive 'YYYY-MM-DD HH:MM:SS' (expressed in the given IANA timezone)
 * to a UTC epoch in ms, DST-correct. Falls back to server-local parsing if the
 * timezone is invalid.
 */
function epochFromTimezoneParts(
  Y: number, Mo: number, D: number, h: number, mi: number, s: number,
  tz: string
): number {
  const candidate = Date.UTC(Y, Mo - 1, D, h, mi, s); // instant if the naive time were UTC
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(candidate));
    const m: Record<string, string> = {};
    for (const p of parts) m[p.type] = p.value;
    const wallAsUtc = Date.UTC(+m.year, +m.month - 1, +m.day, (+m.hour) % 24, +m.minute, +m.second);
    const offsetMs = wallAsUtc - candidate; // tz offset at that instant
    return candidate - offsetMs;
  } catch {
    return candidate; // invalid tz -> treat as UTC
  }
}

export function parseVoipDate(date: string): number {
  // voip.ms returns 'YYYY-MM-DD HH:MM:SS' in the account timezone (not UTC).
  if (!date) return Date.now();
  const [d, t] = date.split(' ');
  const [Y, Mo, D] = (d || '').split('-').map(Number);
  const [h, mi, s] = (t || '0:0:0').split(':').map(Number);
  if (!Y || !Mo || !D) return Date.now();
  return epochFromTimezoneParts(Y, Mo, D, h || 0, mi || 0, s || 0, config.voipms.timezone);
}

function normalize(row: SmsRow): VoipMsSms {
  const mediaUrls: string[] = [];
  const mediaArr = row.media;
  if (Array.isArray(mediaArr)) for (const m of mediaArr) if (m) mediaUrls.push(m);
  for (let i = 1; i <= 3; i++) {
    const m = row[`col_media${i}` as 'col_media1' | 'col_media2' | 'col_media3'];
    if (typeof m === 'string' && m && !mediaUrls.includes(m)) mediaUrls.push(m);
  }
  return {
    id: String(row.id),
    date: row.date,
    ts: parseVoipDate(row.date),
    type: String(row.type) === '1' ? 1 : 0,
    did: row.did,
    contact: row.contact,
    contactRaw: row.contact,
    message: decodeMessage(row.message ?? ''),
    carrierStatus: row.carrier_status ?? '',
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
  };
}

export interface VoipMsDid {
  did: string;
  description: string;
}

export async function getDIDsInfo(): Promise<VoipMsDid[]> {
  const data = await call('getDIDsInfo');
  const dids = (data.dids as Array<Record<string, string>> | undefined) ?? [];
  const all = dids
    .filter((d) => String(d.sms_available) === '1')
    .map((d) => ({ did: d.did, description: d.description ?? '' }));

  if (config.voipms.dids.length > 0) {
    const wanted = new Set(config.voipms.dids);
    return all.filter((d) => wanted.has(d.did));
  }
  return all;
}

export interface GetSmsParams {
  did?: string;
  from?: string; // YYYY-MM-DD
  to?: string;
  type?: 0 | 1;
  limit?: number;
  contact?: string;
}

export async function getSMS(params: GetSmsParams): Promise<VoipMsSms[]> {
  let data: Record<string, unknown>;
  try {
    data = await call('getSMS', {
      did: params.did,
      from: params.from,
      to: params.to,
      type: params.type,
      contact: params.contact,
      limit: params.limit,
      all_messages: 0,
    });
  } catch (e) {
    // 'no_sms' just means no messages matched the filter — not an error.
    if (e instanceof VoipMsError && e.code === 'no_sms') return [];
    throw e;
  }
  const rows = (data.sms as SmsRow[] | undefined) ?? [];
  return rows.map(normalize);
}

export async function sendSMS(did: string, dst: string, message: string): Promise<string> {
  const data = await call('sendSMS', { did, dst, message });
  return String((data as { sms?: string }).sms ?? '');
}

export async function getMMS(params: GetSmsParams): Promise<VoipMsSms[]> {
  let data: Record<string, unknown>;
  try {
    data = await call('getMMS', {
      did: params.did,
      from: params.from,
      to: params.to,
      type: params.type,
      contact: params.contact,
      limit: params.limit,
      all_messages: 0,
    });
  } catch (e) {
    // 'no_sms'/'no_mms' just mean no messages matched — not an error.
    if (e instanceof VoipMsError && (e.code === 'no_sms' || e.code === 'no_mms')) return [];
    throw e;
  }
  const rows = (data.sms as SmsRow[] | undefined) ?? [];
  return rows.map(normalize);
}

/**
 * Fetch media URLs for a specific MMS. getMMS frequently returns media fields
 * empty even for image MMS, so this is the reliable way to discover attachments.
 * The response `media` is an object keyed "1".."3" (or sometimes an array).
 */
export async function getMediaMMS(id: string): Promise<string[]> {
  let data: Record<string, unknown>;
  try {
    data = await call('getMediaMMS', { id });
  } catch (e) {
    if (e instanceof VoipMsError && (e.code === 'no_sms' || e.code === 'no_mms')) return [];
    throw e;
  }
  const media = data.media;
  const urls: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v && !urls.includes(v)) urls.push(v);
  };
  if (Array.isArray(media)) for (const m of media) push(m);
  else if (media && typeof media === 'object')
    for (const v of Object.values(media as Record<string, unknown>)) push(v);
  return urls;
}

/**
 * Send an MMS via POST multipart/form-data. GET cannot carry an image
 * (voip.ms' Cloudflare front rejects long URLs), and the endpoint MUST be the
 * no-www host (www.voip.ms 301-redirects and drops the body -> missing_method).
 * media1..3 must be `data:<mime>;base64,<...>`. ~1.2 MB per file.
 */
export async function sendMMS(
  did: string,
  dst: string,
  message: string,
  media: MmsMedia[] = []
): Promise<string> {
  if (!config.voipms.username || !config.voipms.password) {
    throw new VoipMsError('missing_credentials');
  }
  const form = new FormData();
  form.set('api_username', config.voipms.username);
  form.set('api_password', config.voipms.password);
  form.set('method', 'sendMMS');
  form.set('did', did);
  form.set('dst', dst);
  form.set('message', message);
  media.slice(0, 3).forEach((m, i) => {
    form.set(`media${i + 1}`, `data:${m.contentType};base64,${m.data}`);
  });
  const res = await fetch(API_BASE, { method: 'POST', body: form });
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new VoipMsError(`http_${res.status}`);
  }
  if (data.status !== 'success') {
    throw new VoipMsError(String(data.status ?? 'unknown'));
  }
  return String((data as { mms?: string }).mms ?? '');
}

export async function setSmsCallback(
  did: string,
  callbackUrl: string,
  retry = true
): Promise<void> {
  await call('setSMS', {
    did,
    enable: 1,
    url_callback_enable: 1,
    url_callback: callbackUrl,
    url_callback_retry: retry ? 1 : 0,
  });
}

/** voip.ms sendSMS expects 10-digit NANP numbers (no leading country code). */
export function toVoipNumber(tel: string): string {
  const digits = tel.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits || tel;
}

/** Format current time in the account tz, matching voip.ms's date convention. */
export function nowVoipDate(): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.voipms.timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const m: Record<string, string> = {};
  for (const x of p) m[x.type] = x.value;
  return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}:${m.second}`;
}

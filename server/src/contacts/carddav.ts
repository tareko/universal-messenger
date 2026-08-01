import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { getContactHref, getDb, getKv, setContactHref, setKv, upsertContacts } from '../store/db.js';
import type { Contact } from '../types.js';
import { normalizeTel } from './match.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  isArray: (tagName) => tagName === 'response',
});

const LINE_SPLIT = /\r\n|\r|\n/;

/** Decode XML entities (fast-xml-parser leaves numeric refs like &#13; intact). */
function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${config.nextcloud.username}:${config.nextcloud.password}`).toString('base64');
}

async function dav(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${config.nextcloud.url}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function toArrayResponses(xml: unknown): Record<string, unknown>[] {
  const r = (xml as { multistatus?: { response?: unknown } })?.multistatus?.response;
  if (!r) return [];
  return Array.isArray(r) ? (r as Record<string, unknown>[]) : [r as Record<string, unknown>];
}

function addressBookMatches(href: string, displayname: string | undefined): boolean {
  const filter = config.nextcloud.addressbook;
  const hay = `${href} ${config.nextcloud.url}${href} ${displayname ?? ''}`.toLowerCase();
  if (!filter) {
    // By default skip Nextcloud's auto-generated system address book (org directory).
    return !href.includes('system');
  }
  return filter
    .split(',')
    .some((sub) => {
      const s = sub.trim().toLowerCase();
      return s && hay.includes(s);
    });
}

async function discoverAddressBooks(): Promise<string[]> {
  if (config.nextcloud.addressbook && config.nextcloud.addressbook.startsWith('/')) {
    return [config.nextcloud.addressbook];
  }

  const user = encodeURIComponent(config.nextcloud.username);
  const basePath = `/remote.php/dav/addressbooks/users/${user}/`;
  const res = await dav(basePath, {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body: `<?xml version="1.0"?>
      <d:propfind xmlns:d="DAV:">
        <d:prop><d:resourcetype/><d:displayname/></d:prop>
      </d:propfind>`,
  });
  if (!res.ok) throw new Error(`CardDAV discovery failed: HTTP ${res.status}`);
  const xml = parser.parse(await res.text());
  const books: string[] = [];
  for (const entry of toArrayResponses(xml)) {
    const propstat = entry.propstat as Record<string, unknown> | undefined;
    const prop = (propstat?.prop ?? {}) as Record<string, unknown>;
    const rt = prop.resourcetype as Record<string, unknown> | undefined;
    if (rt && 'addressbook' in rt) {
      const href = entry.href as string | undefined;
      const displayname = prop.displayname as string | undefined;
      if (href && addressBookMatches(href, displayname)) books.push(href);
    }
  }
  return books;
}

async function fetchVCards(addressBookHref: string): Promise<{ href: string; card: string }[]> {
  const res = await dav(addressBookHref, {
    method: 'REPORT',
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    // Request only FN and TEL — avoids pulling base64 photos, cutting payloads
    // from tens of MB down to ~1 MB for thousands of contacts (RFC 6352 §10.5).
    body: `<?xml version="1.0"?>
      <c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
        <d:prop>
          <c:address-data>
            <c:prop name="VERSION"/>
            <c:prop name="FN"/>
            <c:prop name="TEL"/>
          </c:address-data>
        </d:prop>
      </c:addressbook-query>`,
  });
  if (!res.ok) throw new Error(`CardDAV query failed: HTTP ${res.status} for ${addressBookHref}`);
  const xml = parser.parse(await res.text());
  const cards: { href: string; card: string }[] = [];
  for (const entry of toArrayResponses(xml)) {
    const href = String(entry.href ?? '');
    const propstat = entry.propstat as Record<string, unknown> | undefined;
    const prop = (propstat?.prop ?? {}) as Record<string, unknown>;
    const data = prop['address-data'];
    const texts: string[] = [];
    if (typeof data === 'string') texts.push(unescapeXml(data));
    else if (Array.isArray(data)) for (const d of data) if (typeof d === 'string') texts.push(unescapeXml(d));
    for (const card of texts) cards.push({ href, card });
  }
  return cards;
}

/** Unfold RFC 6350 line continuations (a folded line starts with space/tab). */
function unfoldVcard(text: string): string {
  return text.replace(/(?:\r\n|\r|\n)[ \t]/g, '');
}

export interface ParsedVCard {
  fn: string | null;
  tels: string[];
}

export function parseVCard(text: string): ParsedVCard | null {
  if (!/BEGIN:VCARD/i.test(text)) return null;
  const lines = unfoldVcard(text).split(LINE_SPLIT);
  let fn: string | null = null;
  const tels: string[] = [];
  for (const line of lines) {
    // Property lines may carry a group prefix (ITEM1.TEL) and/or params
    // (TEL;TYPE=CELL) before the colon.
    if (/^(?:[A-Z0-9]+\.)?FN:/i.test(line)) {
      if (fn === null) fn = line.slice(line.indexOf(':') + 1).trim();
    } else if (/^(?:[A-Z0-9]+\.)?TEL(?:;[^:]*)?:/i.test(line)) {
      const value = line.slice(line.indexOf(':') + 1).trim();
      if (value) tels.push(value);
    }
  }
  if (!fn && tels.length === 0) return null;
  return { fn: fn ?? 'Unknown', tels };
}

let lastStatus = 'idle';

export function getCarddavStatus(): string {
  return lastStatus;
}

/**
 * Write a PHOTO into a contact's vCard (Nextcloud CardDAV).
 * Finds the contact by phone number, replaces/inserts PHOTO, PUTs it back.
 */
export async function updateContactPhoto(
  tel: string,
  imageData: Buffer,
  contentType: string
): Promise<boolean> {
  if (!config.nextcloud.url || !config.nextcloud.username || !config.nextcloud.password) return false;
  try {
    // Find the vCard by normalized digits (TEL formats vary wildly in DAV).
    const targetDigits = tel.replace(/\D/g, '').slice(-9);
    const hrefCacheKey = `davhref:${targetDigits}`;
    let href: string | undefined = getContactHref(tel) ?? undefined;
    if (!href) {
      try {
        const cached = getKv(hrefCacheKey);
        if (cached) href = (JSON.parse(cached) as { href: string }).href;
      } catch {
        /* miss */
      }
    }

    if (!href) {
      const books = await discoverAddressBooks();
      for (const book of books) {
        const report = await dav(book, {
          method: 'REPORT',
          headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
          body: `<?xml version="1.0"?>
            <c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
              <d:prop><d:getetag/>
                <c:address-data><c:prop name="VERSION"/><c:prop name="FN"/><c:prop name="TEL"/></c:address-data>
              </d:prop>
            </c:addressbook-query>`,
        });
        const xml = await report.text();
        // Per response entry: href + TELs — match normalized digits.
        for (const entry of xml.split(/<d:response>/i).slice(1)) {
          const candidate = entry.match(/<[^>]*href[^>]*>([^<]+\.vcf)<\/[^>]*href>/i)?.[1];
          if (!candidate) continue;
          const tels = [...unescapeXml(entry).matchAll(/TEL[^:]*:([^<\n]+)/g)].map((m) =>
            m[1].replace(/\D/g, '')
          );
          if (!tels.some((t) => t.endsWith(targetDigits))) continue;
          href = candidate;
          break;
        }
        if (href) break;
      }
      if (href) setKv(hrefCacheKey, JSON.stringify({ href, ts: Date.now() }));
    }
    if (!href) return false;

    // Fetch the full vCard, swap PHOTO, PUT back.
    const getRes = await dav(href, { headers: { 'Content-Type': 'text/vcard' } });
    const vcardText = await getRes.text();
    if (!vcardText.includes('BEGIN:VCARD')) return false;

    const mime = contentType.toUpperCase().includes('PNG') ? 'PNG' : 'JPEG';
    const folded = (imageData.toString('base64').match(/.{1,72}/g) ?? []).join('\r\n ');
    const photoLine = `PHOTO;ENCODING=b;TYPE=${mime}:${folded}`;
    const updated = vcardText
      .replace(/^PHOTO[^:]*:.*(?:\r?\n(?:[ \t].*)?)*/gim, '')
      .replace(/(FN:.*(?:\r?\n|$))/i, `$1${photoLine}\r\n`);

    const put = await dav(href, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/vcard; charset=utf-8' },
      body: updated,
    });
    if (put.status === 204 || put.status === 201) return true;
    // Stale cached href? Drop it so the next lookup re-scans.
    if (put.status === 404 || put.status === 412) {
      getDb().prepare('DELETE FROM kv WHERE key = ?').run(hrefCacheKey);
    }
    return false;
  } catch (e) {
    console.error('[carddav] updateContactPhoto failed:', (e as Error).message);
    return false;
  }
}

export async function syncContacts(): Promise<number> {
  if (!config.nextcloud.url || !config.nextcloud.username || !config.nextcloud.password) {
    lastStatus = 'disabled';
    return 0;
  }
  try {
    lastStatus = 'syncing';
    const books = await discoverAddressBooks();
    const contacts: Contact[] = [];
    for (const book of books) {
      const cards = await fetchVCards(book);
      for (const { href, card } of cards) {
        const parsed = parseVCard(card);
        if (!parsed) continue;
        for (const rawTel of parsed.tels) {
          const tel = normalizeTel(rawTel);
          if (tel) {
            contacts.push({ tel, name: parsed.fn ?? 'Unknown', rawTel });
            if (href) setContactHref(tel, href);
          }
        }
      }
    }
    const count = upsertContacts(contacts);
    lastStatus = `ok (${count} contacts, ${new Date().toLocaleTimeString()})`;
    console.log(`[carddav] synced ${count} contacts from ${books.length} address book(s)`);
    return count;
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const detail = e.cause ? ` [${e.cause.code ?? e.cause.message}]` : '';
    lastStatus = `error: ${e.message}${detail}`;
    console.error('[carddav] sync failed:', e.message, detail);
    return 0;
  }
}

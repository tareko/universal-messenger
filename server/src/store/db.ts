import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import type { Chat, Contact, MediaRef, Message, ReactionRef } from '../types.js';

let db: Database.Database;

export function initDb() {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id        TEXT PRIMARY KEY,   -- '<provider>:<remote-id>'
      provider  TEXT NOT NULL,
      label     TEXT NOT NULL,
      status    TEXT NOT NULL DEFAULT 'active',
      sort      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chats (
      id          TEXT PRIMARY KEY, -- '<accountId>:<remoteId>'
      account_id  TEXT NOT NULL REFERENCES accounts(id),
      type        TEXT NOT NULL DEFAULT 'dm',  -- 'dm' | 'group'
      remote_id   TEXT NOT NULL,               -- contact tel / group id
      contact_raw TEXT NOT NULL DEFAULT '',
      title       TEXT,
      created     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_chats_account ON chats(account_id);

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY, -- '<accountId>:<provider-msg-id>'
      chat_id       TEXT NOT NULL REFERENCES chats(id),
      account_id    TEXT NOT NULL,
      ts            INTEGER NOT NULL,
      date          TEXT NOT NULL DEFAULT '',
      outgoing      INTEGER NOT NULL, -- 0 incoming, 1 outgoing
      sender        TEXT,             -- group sender (null for dm/own)
      body          TEXT NOT NULL,
      media         TEXT,             -- JSON MediaRef[]
      quoted_id     TEXT,
      forwarded_from TEXT,
      edited        INTEGER NOT NULL DEFAULT 0,
      read          INTEGER NOT NULL DEFAULT 0,
      source        TEXT NOT NULL DEFAULT 'poll',
      carrier_status TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, ts);
    CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts);

    CREATE TABLE IF NOT EXISTS reactions (
      id         TEXT PRIMARY KEY,  -- provider id of the reaction event
      message_id TEXT,              -- matched target message (nullable)
      chat_id    TEXT NOT NULL,
      emoji      TEXT NOT NULL,
      from_sender TEXT,
      ts         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_react_chat ON reactions(chat_id);
    CREATE INDEX IF NOT EXISTS idx_react_target ON reactions(message_id);

    CREATE TABLE IF NOT EXISTS contacts (
      tel     TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      raw_tel TEXT
    );

    CREATE TABLE IF NOT EXISTS contact_hrefs (
      tel  TEXT PRIMARY KEY,
      href TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS names (
      id   TEXT PRIMARY KEY,  -- '+15551234567' (phone), telegram user id, ...
      name TEXT NOT NULL      -- display name (pushname, telegram name, ...)
    );

    CREATE TABLE IF NOT EXISTS push_endpoints (
      endpoint TEXT PRIMARY KEY,
      created  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS people (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      default_chat_id TEXT,
      send_mode       TEXT NOT NULL DEFAULT 'origin', -- 'origin' | 'default'
      created         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS person_chats (
      chat_id   TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_participants (
      chat_id   TEXT NOT NULL,
      member_id TEXT NOT NULL,
      name      TEXT,
      PRIMARY KEY (chat_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS receipt_readers (
      message_id TEXT NOT NULL,
      reader     TEXT NOT NULL,
      PRIMARY KEY (message_id, reader)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      color       TEXT NOT NULL DEFAULT '#008069'
    );

    CREATE TABLE IF NOT EXISTS chat_tags (
      chat_id TEXT NOT NULL,
      tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      source  TEXT NOT NULL DEFAULT 'ai',  -- 'ai' | 'manual' | 'stats'
      locked  INTEGER NOT NULL DEFAULT 0,  -- manual overrides lock against AI re-tagging
      PRIMARY KEY (chat_id, tag_id)
    );
  `);

  // Full-text search index over message bodies (external-content FTS5).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      body, content='messages', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
      INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
    END;
  `);
  // Backfill the index if it's behind (e.g. after an upgrade import).
  const behind = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM messages) > (SELECT COUNT(*) FROM messages_fts) AS behind`
    )
    .get() as { behind: number };
  if (behind.behind) {
    db.prepare(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`).run();
    console.log('[db] rebuilt full-text index');
  }
  // Lazy media: provider payload needed to download an attachment on demand.
  try {
    db.exec('ALTER TABLE messages ADD COLUMN media_pending TEXT');
  } catch {
    /* column exists */
  }
  // Disappearing messages: per-chat ephemeral duration (seconds; 0 = off).
  try {
    db.exec('ALTER TABLE chats ADD COLUMN ephemeral_seconds INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* column exists */
  }
  // WhatsApp newsletters predating the 'channel' chat type were stored as dms.
  db.exec(`UPDATE chats SET type = 'channel' WHERE remote_id LIKE '%@newsletter' AND type != 'channel'`);
  // Delete-for-everyone tombstones (body/media blanked, row kept as a stub).
  try {
    db.exec('ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* column exists */
  }
  // Group chats live in the Groups tab unless pinned into the main chat list.
  try {
    db.exec('ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* column exists */
  }
  // Read receipts for outgoing messages: '' | 'sent' | 'delivered' | 'read'.
  try {
    db.exec("ALTER TABLE messages ADD COLUMN receipt TEXT NOT NULL DEFAULT ''");
  } catch {
    /* column exists */
  }
  // Hidden conversations (shelved from all tabs until manually restored).
  try {
    db.exec('ALTER TABLE chats ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* column exists */
  }
  // Per-chat opt-in for the AI translate action (off by default).
  try {
    db.exec('ALTER TABLE chats ADD COLUMN translate_enabled INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* column exists */
  }
  // Per-chat opt-in for auto AI reply suggestions on chat open.
  try {
    db.exec('ALTER TABLE chats ADD COLUMN suggest_enabled INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* column exists */
  }
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not initialised');
  return db;
}

// ---------- KV ----------
export function getKv(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}
export function setKv(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

// ---------- names (provider-captured display names) ----------
export function setName(id: string, name: string): void {
  if (!id || !name) return;
  getDb()
    .prepare(
      `INSERT INTO names(id, name) VALUES(?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`
    )
    .run(id, name);
}

/** Provider-captured name first, then the CardDAV address book. */
export function getName(id: string): string | null {
  const row = getDb().prepare('SELECT name FROM names WHERE id = ?').get(id) as
    | { name: string }
    | undefined;
  return row?.name ?? getContactName(id);
}

/** Rewrite a stored group sender id (e.g. a resolved WhatsApp lid → phone). */
export function rewriteSender(accountId: string, from: string, to: string): void {
  getDb()
    .prepare('UPDATE messages SET sender = ? WHERE account_id = ? AND sender = ?')
    .run(to, accountId, from);
  getDb().prepare('UPDATE reactions SET from_sender = ? WHERE from_sender = ?').run(to, from);
}

/** Replace a text fragment in stored message bodies (mention display fixes). */
export function rewriteBodyFragment(from: string, to: string): number {
  const res = getDb()
    .prepare('UPDATE messages SET body = REPLACE(body, ?, ?) WHERE body LIKE ?')
    .run(from, to, `%${from}%`);
  return res.changes;
}

// ---------- accounts ----------
export function upsertAccount(a: { id: string; provider: string; label: string; status?: string }): void {
  getDb()
    .prepare(
      `INSERT INTO accounts(id, provider, label, status) VALUES(?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label`
    )
    .run(a.id, a.provider, a.label, a.status ?? 'active');
}

export function setAccountStatus(id: string, status: string): void {
  getDb().prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, id);
}

/**
 * Mark all of a provider's accounts with a status (e.g. 'disconnected' on
 * logout). Chat history is intentionally kept, so rows aren't deleted.
 */
export function setProviderAccountsStatus(provider: string, status: string): void {
  getDb().prepare('UPDATE accounts SET status = ? WHERE provider = ?').run(status, provider);
}

export function getAccounts(): { id: string; provider: string; label: string; status: string }[] {
  const rows = getDb()
    .prepare('SELECT id, provider, label, status FROM accounts ORDER BY sort, label')
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    provider: String(r.provider),
    label: String(r.label),
    status: String(r.status),
  }));
}

// ---------- chats ----------
export function chatId(accountId: string, remoteId: string): string {
  return `${accountId}:${remoteId}`;
}

export function getOrCreateChat(
  accountId: string,
  remoteId: string,
  opts: { type?: string; contactRaw?: string; title?: string } = {}
): Chat {
  const id = chatId(accountId, remoteId);
  getDb()
    .prepare(
      `INSERT INTO chats(id, account_id, type, remote_id, contact_raw, title, created)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(id, accountId, opts.type ?? 'dm', remoteId, opts.contactRaw ?? remoteId, opts.title ?? null, Date.now());
  return getChat(id)!;
}

export function getChat(id: string): Chat | null {
  const row = getDb().prepare('SELECT * FROM chats WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToChat(row) : null;
}

/**
 * Fold `sourceId` chat into `targetId` (creating the target from the source's
 * metadata if needed). Messages/reactions are moved; exact duplicates
 * (same message id in both) are dropped with the source. Used when a
 * privacy-masked id (WhatsApp @lid) resolves to a real phone number and the
 * two ended up as separate chats.
 */
export function mergeChats(sourceId: string, targetId: string): void {
  const source = getChat(sourceId);
  if (!source || sourceId === targetId) return;
  const account = sourceId.split(':').slice(0, 2).join(':');
  const targetRemoteId = targetId.slice(account.length + 1);
  const tx = getDb().transaction(() => {
    if (!getChat(targetId)) {
      getDb()
        .prepare(
          `INSERT INTO chats(id, account_id, type, remote_id, contact_raw, title, created)
           SELECT ?, account_id, type, ?, contact_raw, title, created FROM chats WHERE id = ?`
        )
        .run(targetId, targetRemoteId, sourceId);
    }
    // Prefer a real name as the display label over a raw number/lid.
    const target = getChat(targetId)!;
    if (/[a-zA-Z]/.test(source.contactRaw) && !/[a-zA-Z]/.test(target.contactRaw)) {
      getDb().prepare('UPDATE chats SET contact_raw = ? WHERE id = ?').run(source.contactRaw, targetId);
    }
    // Preserve a disappearing-messages setting the target doesn't know yet.
    getDb()
      .prepare(
        `UPDATE chats SET ephemeral_seconds = ?
         WHERE id = ? AND ephemeral_seconds = 0 AND ? > 0`
      )
      .run(source.ephemeralSeconds ?? 0, targetId, source.ephemeralSeconds ?? 0);
    getDb().prepare('UPDATE OR IGNORE messages SET chat_id = ? WHERE chat_id = ?').run(targetId, sourceId);
    getDb().prepare('UPDATE OR IGNORE reactions SET chat_id = ? WHERE chat_id = ?').run(targetId, sourceId);
    // Anything left behind collided with an existing row — drop it.
    getDb().prepare('DELETE FROM messages WHERE chat_id = ?').run(sourceId);
    getDb().prepare('DELETE FROM reactions WHERE chat_id = ?').run(sourceId);
    getDb().prepare('DELETE FROM chats WHERE id = ?').run(sourceId);
  });
  tx();
  console.log(`[db] merged chat ${sourceId} → ${targetId}`);
}

/** Delete all chats (and their messages/reactions) of one type for an account. */
export function purgeChats(accountId: string, type: 'dm' | 'group'): number {
  const ids = getDb()
    .prepare('SELECT id FROM chats WHERE account_id = ? AND type = ?')
    .all(accountId, type) as { id: string }[];
  const delMsgs = getDb().prepare('DELETE FROM messages WHERE chat_id = ?');
  const delReacts = getDb().prepare('DELETE FROM reactions WHERE chat_id = ?');
  const delChat = getDb().prepare('DELETE FROM chats WHERE id = ?');
  const tx = getDb().transaction((rows: { id: string }[]) => {
    for (const r of rows) {
      delMsgs.run(r.id);
      delReacts.run(r.id);
      delChat.run(r.id);
    }
    return rows.length;
  });
  return tx(ids);
}

function rowToChat(r: Record<string, unknown>): Chat {
  const rawType = String(r.type);
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    provider: String(r.account_id).split(':')[0],
    type: (rawType === 'group' || rawType === 'channel' ? rawType : 'dm') as Chat['type'],
    remoteId: String(r.remote_id),
    contactRaw: r.contact_raw ? String(r.contact_raw) : '',
    title: r.title ? String(r.title) : null,
    name: r.name !== undefined && r.name !== null ? String(r.name) : null,
    unread: r.unread !== undefined ? Number(r.unread) : 0,
    ts: r.ts !== undefined ? Number(r.ts) : 0,
    ephemeralSeconds: Number(r.ephemeral_seconds ?? 0),
    pinned: Number(r.pinned ?? 0),
    hidden: Number(r.hidden ?? 0),
    translateEnabled: Number(r.translate_enabled ?? 0),
    suggestEnabled: Number(r.suggest_enabled ?? 0),
  };
}

/** Pin/unpin a group chat into the main chat list (also unmutes it by default). */
export function setChatPinned(chatIdArg: string, pinned: boolean): void {
  getDb().prepare('UPDATE chats SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, chatIdArg);
}

/** Enable/disable the AI translate action for a chat (off by default). */
export function setChatTranslateEnabled(chatIdArg: string, enabled: boolean): void {
  getDb().prepare('UPDATE chats SET translate_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, chatIdArg);
}

/** Enable/disable auto AI reply suggestions when the chat is opened. */
export function setChatSuggestEnabled(chatIdArg: string, enabled: boolean): void {
  getDb().prepare('UPDATE chats SET suggest_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, chatIdArg);
}

/** Hide/unhide a conversation (shelved from all tabs until manually restored). */
export function setChatHidden(chatIdArg: string, hidden: boolean): void {
  getDb().prepare('UPDATE chats SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, chatIdArg);
}

/** Hide/unhide many chats at once (e.g. all of a person's linked chats). */
export function setChatsHidden(chatIds: string[], hidden: boolean): void {
  const stmt = getDb().prepare('UPDATE chats SET hidden = ? WHERE id = ?');
  const tx = getDb().transaction((ids: string[]) => {
    for (const id of ids) stmt.run(hidden ? 1 : 0, id);
  });
  tx(chatIds);
}

/** Record a chat's disappearing-messages duration (seconds; 0 = off). */
export function setChatEphemeral(chatIdArg: string, seconds: number): void {
  getDb().prepare('UPDATE chats SET ephemeral_seconds = ? WHERE id = ?').run(seconds, chatIdArg);
}

/**
 * Chat list across one or all accounts: last message per chat + unread count.
 * Display name resolution order: CardDAV contact (your own naming) →
 * provider pushname (names table) → chat title → raw contact id.
 */
export function getChats(accountId?: string): Chat[] {
  const where = accountId
    ? "WHERE c.account_id = ? AND (m.id IS NOT NULL OR c.type = 'dm')"
    : "WHERE (m.id IS NOT NULL OR c.type = 'dm')";
  const args: unknown[] = accountId ? [accountId] : [];
  const rows = getDb()
    .prepare(
      `SELECT c.*, COALESCE(ct.name, nm.name) AS name,
              m.ts AS ts, m.id AS last_id,
              (SELECT COUNT(*) FROM messages u WHERE u.chat_id = c.id AND u.outgoing = 0 AND u.read = 0) AS unread
       FROM chats c
       LEFT JOIN contacts ct ON ct.tel = c.remote_id
       LEFT JOIN names nm ON nm.id = c.remote_id
       LEFT JOIN messages m ON m.chat_id = c.id
         AND m.ts = (SELECT MAX(m2.ts) FROM messages m2 WHERE m2.chat_id = c.id)
       ${where}
       GROUP BY c.id
       ORDER BY ts DESC NULLS LAST, c.created DESC`
    )
    .all(...args) as Record<string, unknown>[];
  return rows.map((r) => {
    const chat = rowToChat(r);
    const last = r.last_id
      ? getMessage(String(r.last_id))
      : latestMessageForChat(chat.id);
    chat.lastMessage = last ?? undefined;
    return chat;
  });
}

function latestMessageForChat(chatId: string): Message | null {
  const row = getDb()
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT 1')
    .get(chatId) as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

// ---------- messages ----------
function parseMedia(raw: unknown): MediaRef[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) return arr as MediaRef[];
  } catch {
    /* malformed */
  }
  return undefined;
}

function rowToMessage(r: Record<string, unknown>): Message {
  return {
    id: String(r.id),
    chatId: String(r.chat_id),
    accountId: String(r.account_id),
    ts: Number(r.ts),
    date: r.date ? String(r.date) : '',
    outgoing: Number(r.outgoing) as Message['outgoing'],
    sender: r.sender ? String(r.sender) : null,
    body: String(r.body),
    carrierStatus: r.carrier_status ? String(r.carrier_status) : '',
    read: Number(r.read),
    media: parseMedia(r.media),
    mediaPending: Boolean(r.media_pending),
    deleted: Number(r.deleted ?? 0),
    receipt: r.receipt ? String(r.receipt) : undefined,
    quotedId: r.quoted_id ? String(r.quoted_id) : null,
    forwardedFrom: r.forwarded_from ? String(r.forwarded_from) : null,
    edited: Number(r.edited ?? 0),
  };
}

export function messageExists(id: string): boolean {
  return Boolean(getDb().prepare('SELECT 1 FROM messages WHERE id = ?').get(id));
}

/**
 * Content-based duplicate check. voip.ms expands a group MMS into one row per
 * "leg" (same sender + body + timestamp, different ids); dedup by content so we
 * don't show the same bubble twice. A human re-sending identical text would
 * have a different second-precision timestamp, so this is safe.
 */
export function isDuplicateMessage(chatId: string, body: string, ts: number): boolean {
  return Boolean(
    getDb()
      .prepare('SELECT 1 FROM messages WHERE chat_id = ? AND body = ? AND ts = ? LIMIT 1')
      .get(chatId, body, ts)
  );
}

/** Dedup provider sync-echoes of our own sends (same text within a minute). */
export function isRecentOutgoing(chatId: string, body: string, ts: number, windowMs = 60000): boolean {
  return Boolean(
    getDb()
      .prepare(
        'SELECT 1 FROM messages WHERE chat_id = ? AND outgoing = 1 AND body = ? AND ts BETWEEN ? AND ? LIMIT 1'
      )
      .get(chatId, body, ts - windowMs, ts + windowMs)
  );
}

/** Remove existing duplicate bubbles (keeps the first of each content group). */
export function dedupMessages(): number {
  const res = getDb()
    .prepare(
      `DELETE FROM messages WHERE rowid NOT IN (
         SELECT MIN(rowid) FROM messages GROUP BY chat_id, body, ts
       )`
    )
    .run();
  return res.changes;
}

/** Insert a message; returns true if it was new. */
export function insertMessage(
  msg: Message,
  source: 'poll' | 'webhook' | 'send' = 'poll',
  mediaPending?: string
): boolean {
  const res = getDb()
    .prepare(
      `INSERT INTO messages(id, chat_id, account_id, ts, date, outgoing, sender, body, media, quoted_id, forwarded_from, read, source, carrier_status, media_pending)
       VALUES(@id, @chatId, @accountId, @ts, @date, @outgoing, @sender, @body, @media, @quotedId, @forwardedFrom, @read, @source, @carrierStatus, @mediaPending)
       ON CONFLICT(id) DO NOTHING`
    )
    .run({
      id: msg.id,
      chatId: msg.chatId,
      accountId: msg.accountId,
      ts: msg.ts,
      date: msg.date ?? '',
      outgoing: msg.outgoing,
      sender: msg.sender ?? null,
      body: msg.body,
      media: msg.media ? JSON.stringify(msg.media) : null,
      quotedId: msg.quotedId ?? null,
      forwardedFrom: msg.forwardedFrom ?? null,
      read: msg.read ?? 0,
      source,
      carrierStatus: msg.carrierStatus ?? '',
      mediaPending: mediaPending ?? null,
    });
  return res.changes > 0;
}

/** Raw lazy-download payload for a message (null when none). */
export function getMediaPending(id: string): string | null {
  const row = getDb().prepare('SELECT media_pending FROM messages WHERE id = ?').get(id) as
    | { media_pending: string | null }
    | undefined;
  return row?.media_pending ?? null;
}

/** Backfill the lazy-download payload on an already-stored message (re-sync). */
export function fillMediaPending(id: string, payload: string): void {
  getDb()
    .prepare('UPDATE messages SET media_pending = ? WHERE id = ? AND media IS NULL AND media_pending IS NULL')
    .run(payload, id);
}

/** Store freshly-downloaded media and clear the pending marker. */
export function updateMessageMedia(id: string, media: MediaRef[]): void {
  getDb()
    .prepare('UPDATE messages SET media = ?, media_pending = NULL WHERE id = ?')
    .run(JSON.stringify(media), id);
}

const RECEIPT_RANK: Record<string, number> = { '': 0, sent: 1, delivered: 2, read: 3 };

/** Advance a message's receipt status (monotonic: never downgrades). */
export function updateMessageReceipt(id: string, status: 'sent' | 'delivered' | 'read'): boolean {
  const row = getDb().prepare('SELECT receipt FROM messages WHERE id = ?').get(id) as
    | { receipt: string }
    | undefined;
  if (!row) return false;
  if ((RECEIPT_RANK[status] ?? 0) > (RECEIPT_RANK[row.receipt] ?? 0)) {
    getDb().prepare('UPDATE messages SET receipt = ? WHERE id = ?').run(status, id);
    return true;
  }
  return false;
}

/** Mark all outgoing messages in a chat up to a timestamp as read. */
export function markReceiptsReadUpTo(chatIdArg: string, maxTs: number): number {
  const res = getDb()
    .prepare("UPDATE messages SET receipt = 'read' WHERE chat_id = ? AND outgoing = 1 AND ts <= ? AND receipt != 'read'")
    .run(chatIdArg, maxTs);
  return res.changes;
}

export function getMessages(chatIdArg: string, limit = 100, before?: number): Message[] {
  // Most recent page first (DESC), then re-sort ascending for display.
  const rows = (
    before !== undefined
      ? getDb()
          .prepare('SELECT * FROM messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?')
          .all(chatIdArg, before, limit)
      : getDb()
          .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?')
          .all(chatIdArg, limit)
  ) as Record<string, unknown>[];
  const messages = rows.map(rowToMessage).reverse();
  return hydrateExtras(messages, chatIdArg);
}

/** Oldest stored message in a chat (provider-side pagination anchor). */
export function getOldestMessage(chatIdArg: string): Message | null {
  const row = getDb()
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY ts ASC LIMIT 1')
    .get(chatIdArg) as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

export interface SearchHit {
  message: Message;
  chatId: string;
  chatName: string | null;
}

/** Full-text search across all message bodies, newest first. */
export function searchMessages(query: string, limit = 40): SearchHit[] {
  // Quote each token for FTS5 safety (avoids syntax errors on user input).
  const match = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
  if (!match) return [];
  const rows = getDb()
    .prepare(
      `SELECT m.*, c.title AS chat_title, c.contact_raw AS chat_contact, ct.name AS contact_name
       FROM messages_fts f
       JOIN messages m ON m.rowid = f.rowid
       JOIN chats c ON c.id = m.chat_id
       LEFT JOIN contacts ct ON ct.tel = c.remote_id
       WHERE messages_fts MATCH ?
       ORDER BY m.ts DESC
       LIMIT ?`
    )
    .all(match, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    message: rowToMessage(r),
    chatId: String(r.chat_id),
    chatName: r.contact_name ?? r.chat_title ?? r.chat_contact ?? null,
  })) as SearchHit[];
}

export function markChatRead(chatIdArg: string): void {
  getDb()
    .prepare('UPDATE messages SET read = 1 WHERE chat_id = ? AND outgoing = 0 AND read = 0')
    .run(chatIdArg);
}

export function getMessage(id: string): Message | null {
  const row = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const [msg] = hydrateExtras([rowToMessage(row)], String(row.chat_id));
  return msg;
}

export function deleteMessage(id: string): void {
  getDb().prepare('DELETE FROM messages WHERE id = ?').run(id);
  // Reactions pointing at the deleted message are orphaned; drop them.
  getDb().prepare('DELETE FROM reactions WHERE message_id = ?').run(id);
}

/** Tombstone a message (delete-for-everyone): blank it, keep the row. */
export function markMessageDeleted(id: string): void {
  getDb()
    .prepare("UPDATE messages SET deleted = 1, body = '', media = NULL, media_pending = NULL WHERE id = ?")
    .run(id);
  // Reactions on a deleted message no longer make sense.
  getDb().prepare('DELETE FROM reactions WHERE message_id = ?').run(id);
}

/**
 * Find messages whose provider-local id ends with a suffix (e.g. Telegram msg
 * ids are only unique per chat, so delete events must be resolved by suffix).
 */
export function findMessageIdsBySuffix(accountId: string, suffix: string): { id: string; chat_id: string }[] {
  return getDb()
    .prepare(`SELECT id, chat_id FROM messages WHERE account_id = ? AND id LIKE ? ESCAPE '\\'`)
    .all(accountId, `%:${suffix.replace(/[%_]/g, (m) => '\\' + m)}`) as { id: string; chat_id: string }[];
}

export function updateMessageBody(id: string, body: string): void {
  getDb().prepare('UPDATE messages SET body = ?, edited = 1 WHERE id = ?').run(body, id);
}

/** Set a chat title (e.g. group subject) if we don't have one yet. */
export function setChatTitleIfBlank(chatIdArg: string, title: string): void {
  getDb()
    .prepare('UPDATE chats SET title = ? WHERE id = ? AND (title IS NULL OR title = \'\')')
    .run(title, chatIdArg);
}

/** Update a chat's display labels (e.g. a DM resolved to the other person's name). */
export function setChatLabel(chatIdArg: string, label: string): void {
  if (!label) return;
  getDb()
    .prepare('UPDATE chats SET title = ?, contact_raw = ? WHERE id = ?')
    .run(label, label, chatIdArg);
}

/** Attach reactions, sender names, and quote previews to a list of messages. */
function hydrateExtras(messages: Message[], chatIdArg: string): Message[] {
  const byTarget = reactionsForChat(chatIdArg);
  return messages.map((m) => {
    let out = m;
    const r = byTarget.get(m.id);
    if (r && r.length) out = { ...out, reactions: r };
    if (out.sender) {
      // Try the id as stored, then without any provider prefix ('user:123').
      const sn =
        getName(out.sender) ??
        (out.sender.includes(':') ? getName(out.sender.split(':').pop()!) : null);
      if (sn) out = { ...out, senderName: sn };
    }
    if (out.quotedId) {
      const q = getMessageRaw(out.quotedId);
      if (q) {
        out = {
          ...out,
          quoted: {
            id: q.id,
            chatId: q.chatId,
            body: q.body,
            sender: q.sender,
            outgoing: q.outgoing,
            senderName: q.sender ? getName(q.sender) : null,
            deleted: q.deleted ?? 0,
          },
        };
      }
    }
    return out;
  });
}

function getMessageRaw(id: string): Message | null {
  const row = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToMessage(row) : null;
}

// ---------- reactions ----------
export function reactionExists(id: string): boolean {
  return Boolean(getDb().prepare('SELECT 1 FROM reactions WHERE id = ?').get(id));
}

export function getReactionEvent(id: string): { message_id: string | null } | undefined {
  return getDb().prepare('SELECT message_id FROM reactions WHERE id = ?').get(id) as
    | { message_id: string | null }
    | undefined;
}

export function isDuplicateReaction(chatIdArg: string, emoji: string, ts: number): boolean {
  return Boolean(
    getDb()
      .prepare('SELECT 1 FROM reactions WHERE chat_id = ? AND emoji = ? AND ts = ? LIMIT 1')
      .get(chatIdArg, emoji, ts)
  );
}

export function addReaction(ev: {
  id: string;
  messageId: string | null;
  chatId: string;
  emoji: string;
  fromSender?: string;
  ts: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO reactions(id, message_id, chat_id, emoji, from_sender, ts)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET message_id = excluded.message_id, emoji = excluded.emoji`
    )
    .run(ev.id, ev.messageId, ev.chatId, ev.emoji, ev.fromSender ?? null, ev.ts);
}

export function getReactionsForMessage(id: string): ReactionRef[] {
  const rows = getDb()
    .prepare('SELECT emoji, from_sender FROM reactions WHERE message_id = ?')
    .all(id) as { emoji: string; from_sender: string | null }[];
  return rows.map((r) => ({ emoji: r.emoji, from: r.from_sender ?? undefined }));
}

/** Remove a reactor's reaction(s) from a message (emoji cleared on the provider). */
export function removeReactions(messageId: string, fromSender: string): void {
  getDb()
    .prepare('DELETE FROM reactions WHERE message_id = ? AND from_sender = ?')
    .run(messageId, fromSender);
}

/** Remove ALL reactions from a message (provider pushed a full replacement list). */
export function clearReactions(messageId: string): void {
  getDb().prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);
}

/** Remove duplicate reaction events (keeps the first of each group). */
export function dedupReactionEvents(): number {
  const res = getDb()
    .prepare(
      `DELETE FROM reactions WHERE rowid NOT IN (
         SELECT MIN(rowid) FROM reactions GROUP BY chat_id, emoji, ts
       )`
    )
    .run();
  return res.changes;
}

function reactionsForChat(chatIdArg: string): Map<string, ReactionRef[]> {
  const rows = getDb()
    .prepare('SELECT message_id, emoji, from_sender FROM reactions WHERE chat_id = ? AND message_id IS NOT NULL')
    .all(chatIdArg) as { message_id: string; emoji: string; from_sender: string | null }[];
  const map = new Map<string, ReactionRef[]>();
  for (const r of rows) {
    const list = map.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, from: r.from_sender ?? undefined });
    map.set(r.message_id, list);
  }
  return map;
}

// ---------- chat participants (group members, for @mentions) ----------
export interface Participant {
  id: string;
  name: string;
}

export function replaceChatParticipants(chatIdArg: string, members: Participant[]): void {
  const tx = getDb().transaction((items: Participant[]) => {
    getDb().prepare('DELETE FROM chat_participants WHERE chat_id = ?').run(chatIdArg);
    const stmt = getDb().prepare(
      'INSERT INTO chat_participants(chat_id, member_id, name) VALUES(?, ?, ?)'
    );
    for (const m of items) stmt.run(chatIdArg, m.id, m.name);
  });
  tx(members);
  setKv(`participants_ts:${chatIdArg}`, String(Date.now()));
}

export function getChatParticipants(chatIdArg: string): Participant[] {
  const rows = getDb()
    .prepare('SELECT member_id AS id, name FROM chat_participants WHERE chat_id = ?')
    .all(chatIdArg) as { id: string; name: string }[];
  return rows;
}

export function getParticipantsAge(chatIdArg: string): number {
  const ts = Number(getKv(`participants_ts:${chatIdArg}`) ?? '0');
  return ts ? Date.now() - ts : Infinity;
}

// ---------- per-reader group receipts ----------
export function addReceiptReader(messageId: string, reader: string): void {
  getDb()
    .prepare(
      'INSERT INTO receipt_readers(message_id, reader) VALUES(?, ?) ON CONFLICT(message_id, reader) DO NOTHING'
    )
    .run(messageId, reader);
}

export function countReceiptReaders(messageId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM receipt_readers WHERE message_id = ?')
    .get(messageId) as { n: number };
  return row.n;
}

/** Group member count excluding our own account (recipients only). */
export function recipientCount(chatIdArg: string, selfId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM chat_participants WHERE chat_id = ? AND member_id != ?')
    .get(chatIdArg, selfId) as { n: number };
  return row.n;
}

// ---------- tags (chat categorization) ----------
export interface Tag {
  id: number;
  name: string;
  description: string;
  color: string;
}

export function getTags(): Tag[] {
  return (getDb().prepare('SELECT * FROM tags ORDER BY name COLLATE NOCASE').all() as Record<string, unknown>[]).map(
    (r) => ({
      id: Number(r.id),
      name: String(r.name),
      description: String(r.description ?? ''),
      color: String(r.color),
    })
  );
}

export function createTag(name: string, description: string, color: string): number {
  const res = getDb()
    .prepare('INSERT INTO tags(name, description, color) VALUES(?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, color = excluded.color')
    .run(name, description, color);
  return Number(res.lastInsertRowid);
}

export function deleteTag(id: number): void {
  getDb().prepare('DELETE FROM chat_tags WHERE tag_id = ?').run(id);
  getDb().prepare('DELETE FROM tags WHERE id = ?').run(id);
}

export interface ChatTagAssignment {
  chatId: string;
  tagId: number;
  source: string;
  locked: boolean;
}

export function setChatTags(
  chatId: string,
  assignments: { tagId: number; source: 'ai' | 'manual' | 'stats' }[]
): void {
  const tx = getDb().transaction((items: typeof assignments) => {
    // AI/stats re-tagging replaces only their own source's rows; manual rows stay.
    const sources = [...new Set(items.map((a) => a.source))];
    for (const source of sources) {
      getDb().prepare('DELETE FROM chat_tags WHERE chat_id = ? AND source = ? AND locked = 0').run(chatId, source);
    }
    const stmt = getDb().prepare(
      'INSERT INTO chat_tags(chat_id, tag_id, source, locked) VALUES(?, ?, ?, ?) ON CONFLICT(chat_id, tag_id) DO UPDATE SET source = excluded.source, locked = excluded.locked'
    );
    for (const a of items) stmt.run(chatId, a.tagId, a.source, a.source === 'manual' ? 1 : 0);
  });
  tx(assignments);
}

export function getChatTags(chatIdArg?: string): (ChatTagAssignment & { name: string; color: string })[] {
  const rows = (
    chatIdArg
      ? getDb()
          .prepare('SELECT ct.*, t.name, t.color FROM chat_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.chat_id = ?')
          .all(chatIdArg)
      : getDb().prepare('SELECT ct.*, t.name, t.color FROM chat_tags ct JOIN tags t ON t.id = ct.tag_id').all()
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    chatId: String(r.chat_id),
    tagId: Number(r.tag_id),
    source: String(r.source),
    locked: Boolean(r.locked),
    name: String(r.name),
    color: String(r.color),
  }));
}

export function removeChatTag(chatId: string, tagId: number): void {
  getDb().prepare('DELETE FROM chat_tags WHERE chat_id = ? AND tag_id = ?').run(chatId, tagId);
}

/** Tag ids per chat (for annotating the chat list). */
export function getChatTagMap(): Map<string, { id: number; name: string; color: string; source: string }[]> {
  const map = new Map<string, { id: number; name: string; color: string; source: string }[]>();
  for (const t of getChatTags()) {
    const arr = map.get(t.chatId) ?? [];
    arr.push({ id: t.tagId, name: t.name, color: t.color, source: t.source });
    map.set(t.chatId, arr);
  }
  return map;
}

// ---------- people (cross-provider identity linking) ----------
export interface Person {
  id: number;
  name: string;
  defaultChatId: string | null;
  sendMode: 'origin' | 'default';
  chatIds: string[];
}

export function createPerson(
  name: string,
  chatIds: string[],
  defaultChatId: string | null,
  sendMode: 'origin' | 'default'
): number {
  const tx = getDb().transaction(() => {
    const id = Number(
      getDb()
        .prepare('INSERT INTO people(name, default_chat_id, send_mode, created) VALUES(?, ?, ?, ?)')
        .run(name, defaultChatId, sendMode, Date.now()).lastInsertRowid
    );
    const stmt = getDb().prepare('INSERT INTO person_chats(chat_id, person_id) VALUES(?, ?)');
    for (const c of chatIds) stmt.run(c, id);
    return id;
  });
  return tx();
}

export function updatePerson(
  id: number,
  patch: { name?: string; defaultChatId?: string | null; sendMode?: 'origin' | 'default' }
): void {
  if (patch.name !== undefined) getDb().prepare('UPDATE people SET name = ? WHERE id = ?').run(patch.name, id);
  if (patch.defaultChatId !== undefined)
    getDb().prepare('UPDATE people SET default_chat_id = ? WHERE id = ?').run(patch.defaultChatId, id);
  if (patch.sendMode !== undefined)
    getDb().prepare('UPDATE people SET send_mode = ? WHERE id = ?').run(patch.sendMode, id);
}

export function addChatToPerson(personId: number, chatId: string): void {
  getDb()
    .prepare('INSERT INTO person_chats(chat_id, person_id) VALUES(?, ?) ON CONFLICT(chat_id) DO UPDATE SET person_id = excluded.person_id')
    .run(chatId, personId);
}

export function removeChatFromPerson(chatId: string): void {
  getDb().prepare('DELETE FROM person_chats WHERE chat_id = ?').run(chatId);
}

export function deletePerson(id: number): void {
  getDb().prepare('DELETE FROM person_chats WHERE person_id = ?').run(id);
  getDb().prepare('DELETE FROM people WHERE id = ?').run(id);
}

export function getPeople(): Person[] {
  const people = getDb().prepare('SELECT * FROM people ORDER BY name COLLATE NOCASE').all() as Record<
    string,
    unknown
  >[];
  const links = getDb().prepare('SELECT chat_id, person_id FROM person_chats').all() as {
    chat_id: string;
    person_id: number;
  }[];
  const byPerson = new Map<number, string[]>();
  for (const l of links) {
    const arr = byPerson.get(l.person_id) ?? [];
    arr.push(l.chat_id);
    byPerson.set(l.person_id, arr);
  }
  return people.map((p) => ({
    id: Number(p.id),
    name: String(p.name),
    defaultChatId: p.default_chat_id ? String(p.default_chat_id) : null,
    sendMode: (String(p.send_mode) === 'default' ? 'default' : 'origin') as Person['sendMode'],
    chatIds: byPerson.get(Number(p.id)) ?? [],
  }));
}

/** chatId → personId map (for annotating the chat list). */
export function getChatPersonMap(): Map<string, number> {
  const rows = getDb().prepare('SELECT chat_id, person_id FROM person_chats').all() as {
    chat_id: string;
    person_id: number;
  }[];
  return new Map(rows.map((r) => [r.chat_id, r.person_id]));
}

// ---------- contacts ----------
/** Replace the entire contact set atomically (CardDAV sync is a full refresh). */
export function upsertContacts(contacts: Contact[]): number {
  const tx = getDb().transaction((items: Contact[]) => {
    getDb().prepare(`DELETE FROM contacts`).run();
    const stmt = getDb().prepare(
      `INSERT INTO contacts(tel, name, raw_tel) VALUES(?, ?, ?)
       ON CONFLICT(tel) DO UPDATE SET name = excluded.name, raw_tel = excluded.raw_tel`
    );
    for (const c of items) stmt.run(c.tel, c.name, c.rawTel ?? null);
    return items.length;
  });
  return tx(contacts);
}

/** Record a contact's vCard href (for fast photo writes — no full-book scan). */
export function setContactHref(tel: string, href: string): void {
  getDb()
    .prepare('INSERT INTO contact_hrefs(tel, href) VALUES(?, ?) ON CONFLICT(tel) DO UPDATE SET href = excluded.href')
    .run(tel, href);
}

export function getContactHref(tel: string): string | null {
  const digits = tel.replace(/\D/g, '');
  const rows = getDb().prepare('SELECT tel, href FROM contact_hrefs').all() as {
    tel: string;
    href: string;
  }[];
  for (const r of rows) {
    if (r.tel.replace(/\D/g, '').endsWith(digits.slice(-9))) return r.href;
  }
  return null;
}

export function getContactName(tel: string): string | null {
  const row = getDb().prepare(`SELECT name FROM contacts WHERE tel = ?`).get(tel) as
    | { name: string }
    | undefined;
  return row?.name ?? null;
}

export function searchContacts(query: string, limit = 50): Contact[] {
  const q = `%${query.replace(/[%_]/g, (m) => '\\' + m)}%`;
  const rows = getDb()
    .prepare(
      `SELECT tel, name, raw_tel AS rawTel FROM contacts
       WHERE name LIKE ? ESCAPE '\\' OR raw_tel LIKE ? ESCAPE '\\' OR tel LIKE ? ESCAPE '\\'
       ORDER BY name COLLATE NOCASE LIMIT ?`
    )
    .all(q, q, q, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    tel: String(r.tel),
    name: String(r.name),
    rawTel: r.rawTel ? String(r.rawTel) : '',
  }));
}

// ---------- push endpoints ----------
export function registerPushEndpoint(endpoint: string): void {
  getDb()
    .prepare('INSERT INTO push_endpoints(endpoint, created) VALUES(?, ?) ON CONFLICT(endpoint) DO NOTHING')
    .run(endpoint, Date.now());
}

export function unregisterPushEndpoint(endpoint: string): void {
  getDb().prepare('DELETE FROM push_endpoints WHERE endpoint = ?').run(endpoint);
}

export function getPushEndpoints(): string[] {
  const rows = getDb().prepare('SELECT endpoint FROM push_endpoints').all() as { endpoint: string }[];
  return rows.map((r) => r.endpoint);
}

import { getKv, setKv, purgeChats } from '../../store/db.js';
import {
  addReaction,
  getMessage,
  getOldestMessage,
  getOrCreateChat,
  getReactionsForMessage,
  markMessageDeleted,
  removeReactions,
  setAccountStatus,
  setChatLabel,
  setProviderAccountsStatus,
  updateMessageBody,
  upsertAccount,
} from '../../store/db.js';
import { saveMediaBuffer, saveUploadedMedia } from '../../services/media.js';
import { ingest } from '../../services/ingest.js';
import { broadcast, broadcastTyping } from '../../realtime/sse.js';
import { listAccounts } from '../registry.js';
import type { Chat, Message } from '../../types.js';
import type { Provider, SendPayload, SendResult } from '../types.js';

type MmState = 'idle' | 'connecting' | 'open' | 'error';

/** Mattermost emoji-name ↔ unicode for the common reaction set. */
const EMOJI_TO_NAME: Record<string, string> = {
  '❤️': 'heart',
  '👍': '+1',
  '👎': '-1',
  '😂': 'joy',
  '‼️': 'exclamation',
  '❓': 'question',
  '🎉': 'tada',
  '😢': 'cry',
  '🔥': 'fire',
  '👀': 'eyes',
  '🤷': 'shrug',
  '🤦': 'face_palm',
  '😅': 'sweat_smile',
  '😊': 'smile',
  '😇': 'innocent',
  '😍': 'heart_eyes',
  '😘': 'kissing_heart',
  '😜': 'stuck_out_tongue_winking_eye',
  '😭': 'sob',
  '😡': 'rage',
  '🤔': 'thinking_face',
  '🙌': 'raised_hands',
  '💪': 'muscle',
  '👏': 'clap',
  '🤝': 'handshake',
  '✅': 'white_check_mark',
  '💯': '100',
  '🥳': 'partying_face',
  '😴': 'sleeping',
  '🤯': 'exploding_head',
};
const NAME_TO_EMOJI: Record<string, string> = Object.fromEntries(
  Object.entries(EMOJI_TO_NAME).map(([e, n]) => [n, e])
);

interface MmPost {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  root_id?: string;
  create_at: number;
  type?: string;
  file_ids?: string[];
  metadata?: { files?: { id: string; mime_type?: string }[]; reactions?: MmReaction[] };
  pending_post_id?: string;
}
interface MmReaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
  create_at?: number;
}
interface MmUser {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
}

/** Display preference: nickname → full name → username. */
function displayNameOf(u: MmUser): string {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return u.nickname?.trim() || full || u.username;
}
interface MmChannel {
  id: string;
  type: 'O' | 'P' | 'D' | 'G';
  display_name: string;
  name: string;
  last_post_at?: number;
  delete_at?: number;
}

/**
 * Mattermost provider: REST v4 for sends/history, WebSocket for realtime.
 * Configured with a server URL + personal access token in the Accounts dialog
 * (stored server-side in the kv table).
 */
export class MattermostProvider implements Provider {
  id = 'mattermost';
  capabilities = {
    reply: true, // root_id threads
    react: true,
    forward: false, // copy fallback
    edit: true,
    delete: true,
    groups: true, // channels + group DMs
    attachments: true,
    crossChatQuotes: false,
  };

  private state: MmState = 'idle';
  private accountId: string | null = null;
  private me: { id: string; username: string } | null = null;
  private ws: WebSocket | null = null;
  private wsSeq = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  /** Terminal auth failure (PAT rejected) — retrying won't help; needs human. */
  private authFailed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastWsTraffic = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private userCache = new Map<string, string>(); // user id -> username
  private channelCache = new Map<string, MmChannel>(); // channel id -> channel

  // ---------- lifecycle ----------

  private get base(): string {
    return `${(getKv('mattermost:url') ?? '').replace(/\/+$/, '')}/api/v4`;
  }

  private get token(): string {
    return getKv('mattermost:token') ?? '';
  }

  /** When enabled, only 1:1 direct channels are synced (no group channels). */
  get dmsOnly(): boolean {
    return getKv('mattermost:dms_only') === '1';
  }

  setDmsOnly(on: boolean): void {
    setKv('mattermost:dms_only', on ? '1' : '0');
    if (on && this.accountId) purgeChats(this.accountId, 'group');
    if (this.state === 'open') void this.syncChannels();
  }

  async start(): Promise<void> {
    if (!getKv('mattermost:url') || !this.token) {
      console.log('[mattermost] not configured — connect via the Accounts dialog');
      return;
    }
    try {
      await this.connect();
    } catch (e) {
      this.state = 'error';
      console.error('[mattermost] connect failed:', (e as Error).message);
    }
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.ws?.close();
    this.ws = null;
  }

  status(): string {
    return this.state;
  }

  getPublicState(): { state: MmState; accountId: string | null; url: string; dmsOnly: boolean } {
    return {
      state: this.state,
      accountId: this.accountId,
      url: getKv('mattermost:url') ?? '',
      dmsOnly: this.dmsOnly,
    };
  }

  async connect(url?: string, token?: string): Promise<void> {
    if (url && token) {
      setKv('mattermost:url', url.replace(/\/+$/, ''));
      setKv('mattermost:token', token);
    }
    this.authFailed = false; // a fresh connect attempt resets terminal auth state
    this.state = 'connecting';
    try {
      // Validate credentials and identify ourselves.
      const me = await this.rest<{ id: string; username: string }>('GET', '/users/me');
      this.me = me;
      this.userCache.set(me.id, me.username);
      this.accountId = `mattermost:${me.id}`;
      upsertAccount({
        id: this.accountId,
        provider: 'mattermost',
        label: `${me.username} @ ${new URL(this.base).host}`,
      });
      setAccountStatus(this.accountId, 'active');
      this.state = 'open';
      broadcast({ type: 'accounts', data: listAccounts() });
      console.log(`[mattermost] connected as ${me.username}`);
      void this.syncChannels();
      // Keep channel list + names fresh (self-heals after token renewals).
      if (this.syncTimer) clearInterval(this.syncTimer);
      this.syncTimer = setInterval(() => void this.syncChannels(), 30 * 60_000);
      // Self-heal sweep: suspend/resume, network blips, or WS zombies can
      // leave us in 'error' with valid stored creds — retry periodically.
      if (!this.healthTimer) {
        this.healthTimer = setInterval(() => {
          if (this.state !== 'open' && !this.authFailed && getKv('mattermost:url') && getKv('mattermost:token')) {
            console.log('[mattermost] health sweep: state=%s — reconnecting', this.state);
            void this.connect().catch(() => {});
          }
        }, 60_000);
      }
      // Close any previous socket before opening a new one (reconnect/edit).
      this.ws?.close();
      this.ws = null;
      this.connectWs();
    } catch (e) {
      this.state = 'error';
      throw e;
    }
  }

  async logout(): Promise<void> {
    this.stop();
    setKv('mattermost:url', '');
    setKv('mattermost:token', '');
    setProviderAccountsStatus('mattermost', 'disconnected');
    this.state = 'idle';
    this.accountId = null;
    this.me = null;
    this.channelCache.clear();
    broadcast({ type: 'accounts', data: listAccounts() });
  }

  // ---------- REST ----------

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // PAT expired mid-session: flip to error so the UI prompts for re-auth.
    if (res.status === 401 && this.state === 'open') {
      this.authFailed = true; // terminal — don't retry until a human re-links
      this.state = 'error';
      this.ws?.close();
      this.ws = null;
      broadcast({ type: 'accounts', data: listAccounts() });
      console.error('[mattermost] token rejected (401) — needs re-auth');
    }
    if (!res.ok) {
      // Mattermost errors are JSON with a readable `message` — surface that.
      const raw = (await res.text().catch(() => '')).slice(0, 300);
      let detail = raw;
      try {
        const parsed = JSON.parse(raw) as { message?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        /* keep raw */
      }
      throw new Error(`mattermost ${method} ${path}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    return (await res.json()) as T;
  }

  // ---------- channels & history ----------

  /** Fetch the user's profile image (DMs only — channels have no icon). */
  async fetchAvatar(chat: Chat): Promise<{ data: Buffer; contentType: string } | null> {
    if (this.state !== 'open' || chat.type !== 'dm') return null;
    try {
      // Resolve the other user id from the DM channel name (<uid1>__<uid2>).
      const channel = this.channelCache.get(chat.remoteId) ?? (await this.lookupChannel(chat.remoteId));
      const parts = channel?.name.split('__') ?? [];
      const otherId = parts.length === 2 ? parts.find((p) => p !== this.me?.id) : undefined;
      if (!otherId) return null;
      const res = await fetch(`${this.base}/users/${otherId}/image`, {
        signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) return null;
      return {
        data: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg',
      };
    } catch {
      return null;
    }
  }

  private async syncChannels(): Promise<void> {
    if (!this.accountId) return;
    try {
      const all = await this.rest<MmChannel[]>('GET', '/users/me/channels');
      const channels = this.dmsOnly ? all.filter((c) => c.type === 'D') : all;

      // Batch-resolve DM partner names in one request (per-user fetches are
      // slow and prone to partial failure mid-sync).
      const nameById = new Map<string, string>();
      const otherIds = channels
        .filter((c) => c.type === 'D')
        .map((c) => c.name.split('__'))
        .filter((p) => p.length === 2)
        .map((p) => p.find((x) => x !== this.me?.id))
        .filter((x): x is string => Boolean(x));
      if (otherIds.length) {
        try {
          const users = await this.rest<MmUser[]>('POST', '/users/ids', otherIds);
          for (const u of users) {
            nameById.set(u.id, displayNameOf(u));
            this.userCache.set(u.id, displayNameOf(u));
          }
        } catch (e) {
          console.error('[mattermost] batch user fetch failed:', (e as Error).message);
        }
      }

      for (const c of channels) {
        if (c.delete_at) continue; // archived
        this.channelCache.set(c.id, c);
        // DM display_name is empty on some servers — resolve the other person.
        const display = c.type === 'D' ? ((await this.dmDisplayName(c, nameById)) ?? c.display_name) : c.display_name;
        const chat = getOrCreateChat(this.accountId, c.id, {
          type: c.type === 'D' ? 'dm' : 'group',
          title: display,
          contactRaw: display,
        });
        // Only relabel with a REAL name — never overwrite with a raw id.
        if (display && display !== chat.remoteId && (chat.title !== display || chat.contactRaw !== display)) {
          setChatLabel(chat.id, display);
        }
      }
      broadcast({ type: 'chats-updated' });
      console.log(`[mattermost] synced ${channels.length} channels`);

      // Recent-history fetch per active channel (once per boot).
      const active = channels
        .filter((c) => (c.last_post_at ?? 0) > 0)
        .sort((a, b) => (b.last_post_at ?? 0) - (a.last_post_at ?? 0))
        .slice(0, 30);
      let n = 0;
      for (const c of active) {
        try {
          const data = await this.rest<{ order: string[]; posts: Record<string, MmPost> }>(
            'GET',
            `/channels/${c.id}/posts?per_page=100`
          );
          for (const postId of data.order) {
            if (await this.ingestPost(data.posts[postId], { downloadMedia: false, notify: false })) n++;
          }
        } catch {
          /* skip channels we can't read */
        }
      }
      console.log(`[mattermost] history: ${n} posts ingested`);
      broadcast({ type: 'chats-updated' });
    } catch (e) {
      console.error('[mattermost] channel sync failed:', (e as Error).message);
    }
  }

  /** Older-page fetch for scroll-back pagination (anchors on post id). */
  async fetchOlder(chat: Chat, _beforeTs: number): Promise<number> {
    if (!this.accountId) return 0;
    const oldest = getOldestMessage(chat.id);
    if (!oldest) return 0;
    const oldestPostId = oldest.id.slice(`${this.accountId}:`.length);
    const data = await this.rest<{ order: string[]; posts: Record<string, MmPost> }>(
      'GET',
      `/channels/${chat.remoteId}/posts?per_page=100&before=${oldestPostId}`
    );
    let n = 0;
    for (const postId of data.order) {
      if (await this.ingestPost(data.posts[postId], { downloadMedia: false, notify: false })) n++;
    }
    return n;
  }

  // ---------- websocket ----------

  private connectWs(): void {
    const wsUrl = `${this.base.replace(/^http/, 'ws')}/websocket`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    this.lastWsTraffic = Date.now();

    ws.onopen = () => {
      this.lastWsTraffic = Date.now();
      ws.send(
        JSON.stringify({
          seq: ++this.wsSeq,
          action: 'authentication_challenge',
          data: { token: this.token },
        })
      );
    };
    ws.onmessage = (ev) => {
      this.lastWsTraffic = Date.now();
      try {
        const msg = JSON.parse(String(ev.data)) as {
          event?: string;
          data?: Record<string, unknown>;
        };
        void this.onWsEvent(msg);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.state === 'open') {
        // Reconnect while the account is still configured.
        this.reconnectTimer = setTimeout(() => this.connectWs(), 5000);
      }
    };
    ws.onerror = () => ws.close();

    // Keepalive + zombie detection: ping every 45s; if nothing (not even the
    // pong) arrives for 150s the socket is dead (e.g. after suspend/resume) —
    // force-close it so onclose triggers the reconnect path.
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) return; // stale timer from a previous socket
      if (this.state !== 'open') return;
      if (Date.now() - this.lastWsTraffic > 150_000) {
        console.log('[mattermost] ws zombie detected — forcing reconnect');
        ws.close();
        return;
      }
      try {
        ws.send(JSON.stringify({ seq: ++this.wsSeq, action: 'ping' }));
      } catch {
        ws.close();
      }
    }, 45_000);
  }

  private async onWsEvent(msg: { event?: string; data?: Record<string, unknown> }): Promise<void> {
    const { event, data } = msg;
    if (!event || !data) return;
    try {
      switch (event) {
        case 'posted': {
          const post = JSON.parse(String(data.post)) as MmPost;
          const channel = await this.lookupChannel(post.channel_id);
          if (this.dmsOnly && channel?.type !== 'D') break; // DMs-only mode
          const isOwn = post.user_id === this.me?.id;
          await this.ingestPost(post, { downloadMedia: true, notify: !isOwn }, channel ?? undefined);
          break;
        }
        case 'post_edited': {
          const post = JSON.parse(String(data.post)) as MmPost;
          if (!this.accountId) return;
          const id = `${this.accountId}:${post.id}`;
          updateMessageBody(id, post.message);
          const updated = getMessage(id);
          if (updated) {
            updated.reactions = getReactionsForMessage(id);
            broadcast({ type: 'message-updated', data: updated });
          }
          break;
        }
        case 'post_deleted': {
          const post = JSON.parse(String(data.post)) as MmPost;
          if (!this.accountId) return;
          const id = `${this.accountId}:${post.id}`;
          markMessageDeleted(id);
          const updated = getMessage(id);
          if (updated) broadcast({ type: 'message-updated', data: updated });
          broadcast({ type: 'chats-updated' });
          break;
        }
        case 'typing': {
          // { channel_id, user_id } — someone's composing in a channel.
          const userId = String(data.user_id ?? '');
          if (!userId || userId === this.me?.id || !this.accountId) break;
          const name = await this.usernameFor(userId);
          broadcastTyping(`${this.accountId}:${String(data.channel_id ?? '')}`, name);
          break;
        }
        case 'reaction_added':
        case 'reaction_removed': {          const r = JSON.parse(String(data.reaction)) as MmReaction;
          if (!this.accountId) return;
          const emoji = NAME_TO_EMOJI[r.emoji_name] ?? null;
          if (!emoji) return; // ignore emojis outside our map
          const targetId = `${this.accountId}:${r.post_id}`;
          const from = r.user_id === this.me?.id ? 'me' : (this.userCache.get(r.user_id) ?? r.user_id);
          if (event === 'reaction_added') {
            addReaction({
              id: `${targetId}:${from}:${emoji}`,
              messageId: targetId,
              chatId: `${this.accountId}:${data.channel_id ?? ''}`,
              emoji,
              fromSender: from,
              ts: r.create_at ?? Date.now(),
            });
          } else {
            removeReactions(targetId, from);
          }
          const updated = getMessage(targetId);
          if (updated) {
            updated.reactions = getReactionsForMessage(targetId);
            broadcast({ type: 'message-updated', data: updated });
          }
          break;
        }
      }
    } catch (e) {
      console.error(`[mattermost] ws ${event} failed:`, (e as Error).message);
    }
  }

  // ---------- inbound normalization ----------

  private async ingestPost(
    post: MmPost,
    opts: { downloadMedia: boolean; notify: boolean },
    knownChannel?: MmChannel
  ): Promise<boolean> {
    if (!this.accountId || !post?.id) return false;
    if (post.type && post.type.startsWith('system_')) return false;

    const channel = knownChannel ?? (await this.lookupChannel(post.channel_id));
    const isDm = channel?.type === 'D';
    const senderName = await this.usernameFor(post.user_id);
    const outgoing = post.user_id === this.me?.id;
    // DM chats are labeled with the other person's name (never our own).
    const display =
      isDm && channel ? ((await this.dmDisplayName(channel)) ?? channel.display_name) : channel?.display_name;

    // Media: WS 'posted' events usually lack metadata.files — fall back to
    // file_ids + /files/<id>/info. Downloads all attachments (images inline,
    // other files as downloadable chips).
    let media;
    let files: { id: string; mime_type?: string; name?: string }[] = post.metadata?.files ?? [];
    if (!files.length && post.file_ids?.length) {
      files = (
        await Promise.all(
          post.file_ids.map(async (id) => {
            try {
              const info = await this.rest<{ mime_type?: string; name?: string }>(
                'GET',
                `/files/${id}/info`
              );
              return { id, mime_type: info.mime_type, name: info.name };
            } catch {
              return { id };
            }
          })
        )
      ).filter(Boolean);
    }
    if (opts.downloadMedia && files.length) {
      const refs = [];
      for (const f of files) {
        try {
          const res = await fetch(`${this.base}/files/${f.id}`, {
            signal: AbortSignal.timeout(30000),
            headers: { Authorization: `Bearer ${this.token}` },
          });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          refs.push(saveMediaBuffer(buf, f.mime_type ?? 'application/octet-stream', post.id + f.id, f.name ?? undefined));
        } catch {
          /* skip failed downloads */
        }
      }
      if (refs.length) media = refs;
    }
    if (!post.message && !files.length) return false;

    const stored = await ingest(
      {
        id: post.id,
        accountId: this.accountId,
        chatRemoteId: post.channel_id,
        chatType: isDm ? 'dm' : 'group',
        chatTitle: isDm ? display : channel?.display_name,
        contactRaw: display ?? senderName,
        sender: isDm || outgoing ? undefined : senderName,
        ts: post.create_at || Date.now(),
        outgoing,
        body: post.message ?? '',
        media,
        quotedRemoteId: post.root_id || undefined,
      },
      'poll',
      opts.notify
    );

    // Snapshot reactions embedded in post metadata.
    if (stored && post.metadata?.reactions?.length) {
      for (const r of post.metadata.reactions) {
        const emoji = NAME_TO_EMOJI[r.emoji_name];
        if (!emoji) continue;
        const from = r.user_id === this.me?.id ? 'me' : (this.userCache.get(r.user_id) ?? r.user_id);
        addReaction({
          id: `${this.accountId}:${post.id}:${from}`,
          messageId: `${this.accountId}:${post.id}`,
          chatId: `${this.accountId}:${post.channel_id}`,
          emoji,
          fromSender: from,
          ts: r.create_at ?? post.create_at,
        });
      }
    }
    return stored;
  }

  /**
   * The other person in a DM channel. Standard DM names are '<uid1>__<uid2>';
   * some servers use an opaque hash, in which case we ask the members list.
   * Returns null when the user can't be resolved (caller keeps trying later
   * instead of storing a raw id as the label).
   */
  private async dmDisplayName(c: MmChannel, nameById?: Map<string, string>): Promise<string | null> {
    let otherId: string | undefined;
    const parts = c.name.split('__');
    if (parts.length === 2) otherId = parts.find((p) => p !== this.me?.id);
    if (otherId && nameById) {
      const hit = nameById.get(otherId);
      if (hit) return hit;
    }
    if (!otherId) {
      try {
        const members = await this.rest<{ user_id: string }[]>(
          'GET',
          `/channels/${c.id}/members`
        );
        otherId = members.find((m) => m.user_id !== this.me?.id)?.user_id;
      } catch {
        /* fall through */
      }
    }
    if (!otherId) return null;
    const name = await this.usernameFor(otherId);
    return name === otherId ? null : name; // lookup failed → unresolved
  }

  private async lookupChannel(channelId: string): Promise<MmChannel | null> {
    const cached = this.channelCache.get(channelId);
    if (cached) return cached;
    try {
      const c = await this.rest<MmChannel>('GET', `/channels/${channelId}`);
      this.channelCache.set(c.id, c);
      return c;
    } catch {
      return null;
    }
  }

  private async usernameFor(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;
    try {
      const u = await this.rest<MmUser>('GET', `/users/${userId}`);
      const name = displayNameOf(u);
      this.userCache.set(u.id, name);
      return name;
    } catch {
      return userId;
    }
  }

  /** Mark the channel viewed on Mattermost (clears the sidebar badge). */
  async markRead(chat: Chat): Promise<void> {
    if (!this.me || this.state !== 'open') return;
    try {
      await this.rest('POST', '/channels/members/me/view', {
        channel_id: chat.remoteId,
        prev_channel_id: '',
      });
    } catch (e) {
      console.error('[mattermost] markRead failed:', (e as Error).message);
    }
  }

  /** Tell the channel we're typing (Mattermost relays this over its WS). */
  /** Channel members for @mention autocomplete. */
  async fetchParticipants(chat: Chat): Promise<{ id: string; name: string }[] | null> {
    if (chat.type !== 'group' || this.state !== 'open') return null;
    try {
      const members = await this.rest<{ user_id: string }[]>(
        'GET',
        `/channels/${chat.remoteId}/members`
      );
      const out: { id: string; name: string }[] = [];
      for (const m of members) {
        const name = await this.usernameFor(m.user_id);
        out.push({ id: name, name });
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Edit our own post (Mattermost PATCH). */
  async editMessage(_chat: Chat, target: Message, newBody: string): Promise<void> {
    if (this.state !== 'open' || !this.accountId) throw new Error('mattermost not connected');
    const postId = target.id.slice(`${this.accountId}:`.length);
    await this.rest('PUT', `/posts/${postId}/patch`, { message: newBody });
    updateMessageBody(target.id, newBody);
    const updated = getMessage(target.id);
    if (updated) broadcast({ type: 'message-updated', data: updated });
  }

  /** Find-or-create a DM channel with a user (by username) for reply-privately. */
  async createDmChannel(username: string): Promise<string> {
    if (!this.me) throw new Error('mattermost not connected');
    const user = await this.rest<{ id: string }>(
      'GET',
      `/users/username/${encodeURIComponent(username)}`
    );
    const channel = await this.rest<{ id: string; display_name?: string }>('POST', '/channels/direct', [
      this.me.id,
      user.id,
    ]);
    this.channelCache.set(channel.id, {
      id: channel.id,
      type: 'D',
      display_name: username,
      name: '',
    } as never);
    return channel.id;
  }

  async sendTyping(chat: Chat): Promise<void> {
    if (!this.ws || this.state !== 'open') return;
    try {
      this.ws.send(
        JSON.stringify({
          action: 'user_typing',
          seq: ++this.wsSeq,
          data: { channel_id: chat.remoteId, parent_id: '' },
        })
      );
    } catch {
      /* non-fatal */
    }
  }

  // ---------- outbound ----------

  async send(chat: Chat, payload: SendPayload): Promise<SendResult> {
    if (!this.accountId || this.state !== 'open') throw new Error('mattermost not connected');
    // Mattermost threads are flat: root_id must be the THREAD ROOT, never
    // another reply. Resolve our quote chain to the top-level post.
    let rootId = payload.quotedId
      ? payload.quotedId.slice(`${this.accountId}:`.length)
      : undefined;
    if (rootId && payload.quotedId) {
      let cursor: string | null | undefined = payload.quotedId;
      for (let i = 0; i < 5 && cursor; i++) {
        const target: Message | null = getMessage(cursor);
        if (!target?.quotedId) break;
        cursor = target.quotedId;
        rootId = cursor.slice(`${this.accountId}:`.length);
      }
    }

    const m = payload.media?.[0];
    let fileIds: string[] | undefined;
    if (m) {
      const form = new FormData();
      form.set('channel_id', chat.remoteId);
      form.set('client_ids', `um-${Date.now()}`);
      // Extension matters: Mattermost renders images inline only when the
      // filename/mime makes the type clear ('image' alone shows a file card).
      const ext =
        { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[
          m.contentType
        ] ?? 'jpg';
      form.append(
        'files',
        new Blob([Buffer.from(m.data, 'base64')], { type: m.contentType }),
        m.name ?? `photo.${ext}`
      );
      const res = await fetch(`${this.base}/files`, {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${this.token}` },
        body: form,
      });
      if (!res.ok) throw new Error(`mattermost file upload: HTTP ${res.status}`);
      const data = (await res.json()) as { file_infos: { id: string }[] };
      fileIds = data.file_infos.map((f) => f.id);
    }

    let post: MmPost;
    let usedRootId: string | undefined = rootId;
    // Mattermost mentions are plain @username — swap picked @Name mentions
    // when the display name differs from the username.
    let mmBody = payload.body;
    for (const mention of payload.mentions ?? []) {
      if (mention.name !== mention.memberId) {
        mmBody = mmBody.split(`@${mention.name}`).join(`@${mention.memberId}`);
      }
    }
    try {
      post = await this.rest<MmPost>('POST', '/posts', {
        channel_id: chat.remoteId,
        message: mmBody,
        root_id: rootId,
        file_ids: fileIds,
      });
    } catch (e) {
      console.error(
        `[mattermost] POST /posts failed: channel=${chat.remoteId} root_id=${rootId ?? 'none'}:`,
        (e as Error).message
      );
      // Safety net: an invalid root_id (cross-channel post, server-side
      // deletion) retries once as a plain message rather than failing.
      if (rootId && /rootid/i.test((e as Error).message)) {
        console.warn('[mattermost] invalid root_id — retrying without quote');
        usedRootId = undefined;
        post = await this.rest<MmPost>('POST', '/posts', {
          channel_id: chat.remoteId,
          message: payload.body,
          file_ids: fileIds,
        });
      } else {
        throw e;
      }
    }

    await ingest(
      {
        id: post.id,
        accountId: this.accountId,
        chatRemoteId: chat.remoteId,
        chatType: chat.type,
        ts: post.create_at || Date.now(),
        outgoing: true,
        body: payload.body,
        media: m ? [saveUploadedMedia(Buffer.from(m.data, 'base64'), m.contentType, m.name)] : undefined,
        quotedRemoteId: usedRootId,
        forwardedFrom: payload.forwardedFrom,
      },
      'send'
    );
    return { id: post.id };
  }

  async react(chat: Chat, target: Message, emoji: string): Promise<void> {
    if (!this.me || this.state !== 'open' || !this.accountId) {
      throw new Error('mattermost not connected');
    }
    const emojiName = EMOJI_TO_NAME[emoji];
    if (!emojiName) throw new Error('unsupported emoji for mattermost');
    const postId = target.id.slice(`${this.accountId}:`.length);
    await this.rest('POST', '/reactions', {
      user_id: this.me.id,
      post_id: postId,
      emoji_name: emojiName,
    });
    addReaction({
      id: `${target.id}:me:${emoji}`,
      messageId: target.id,
      chatId: chat.id,
      emoji,
      fromSender: 'me',
      ts: Date.now(),
    });
    const updated = getMessage(target.id);
    if (updated) {
      updated.reactions = getReactionsForMessage(target.id);
      broadcast({ type: 'message-updated', data: updated });
    }
  }
}

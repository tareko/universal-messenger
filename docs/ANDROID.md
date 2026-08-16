# Android Client — Feature Catalog & Implementation Guide

This document catalogs every notable feature of the universal-messenger web app
and how to build the Android equivalent. It is written against the *actual*
server code — endpoint paths, SSE payloads, and semantics were verified in
`server/src/routes/api.ts`, `server/src/realtime/sse.ts`, `server/src/types.ts`,
and `server/src/notify/notify.ts`.

---

## 1. Architecture: thin client, fat server (recommended)

**The Android app is another frontend to the existing server.** Providers
cannot move on-device:

| Provider | Why it must stay server-side |
|---|---|
| WhatsApp (Baileys) | Node.js multi-device implementation; session lives in `data/sessions/whatsapp/` |
| Signal | Requires the `signal-cli-rest-api` sidecar (JVM + linked device) |
| Telegram (GramJS) | Node client; interactive phone→code→2FA wizard handled by server endpoints |
| Mattermost | REST + WS polling; no reason to duplicate |
| voip.ms | Inbound arrives via public webhook URL — needs a reachable host |

The server already gives you everything a client needs: REST API, SSE
realtime, content-addressed media, FTS5 search, CardDAV contact sync, the AI
harness, and — importantly — **UnifiedPush/ntfy fan-out with deep-link headers**
(`server/src/notify/notify.ts`), built specifically for companion apps.

**Optional native enhancements** (later, not v1):
- Android can be the *default SMS app* and send/receive SMS/MMS natively —
  but keep voip.ms server-side so history stays unified in one DB.
- Telegram could theoretically run via a native MTProto library, but you'd
  lose the unified ingest funnel. Don't.

### Recommended stack

- **Kotlin + Jetpack Compose + Material 3** — the web UI is a chat app;
  Compose maps 1:1 to the component structure (ChatList / Thread / Composer /
  Bubble / Avatar).
- **OkHttp + Retrofit + kotlinx.serialization** for REST.
- **OkHttp `EventSource`** (or `com.launchdarkly:okhttp-eventsource`) for SSE.
- **Coil** for all image loading (avatars, media) — honors `Cache-Control`
  automatically.
- **ViewModel + StateFlow** single-store pattern — port of the zustand store
  in `web/src/store.ts`. One `AppStore` object holding `chats`, `messages`,
  `accounts`, `typing`, `drafts`; composables subscribe to slices.
- **Room** optional, for offline cache of the latest page per chat. The
  server is the source of truth; don't over-engineer.
- **WorkManager + foreground service** for the SSE connection (see §9).

---

## 2. Core data model (client-side)

Mirror these server shapes (`server/src/types.ts`):

```
Account  { id: "voipms:+1519…", provider, label, status }
Chat     { id: "whatsapp:+1519…:12135551234@s.whatsapp.net", accountId, type,
           name, avatarUrl?, lastMessageTs, unread, hidden, pinned,
           ephemeralExpiration?, members? (groups), personId? }
Message  { id: "<accountId>:<providerMsgId>", chatId, senderId, senderName,
           body, ts, media?: MediaRef[], reactions: {emoji: [senderId…]},
           quote?: { id, senderName, body }, edited?, deleted?, status,
           fromMe, ephemeral? }
MediaRef { url: "/api/media/<hash>.<ext>", contentType, name?, pending? }
Person   { id: "person:3", name, chatIds: [per-provider chat ids] }
```

### Invariants (violating these caused real bugs — see §12)

1. **Ids are namespaced.** Never `id.split(':')[1]` — phone numbers contain
   `+`, chat ids contain `@` and `:`. Slice by *known prefixes* only
   (`person:`, `whatsapp:`, …) or carry the parts alongside.
2. **`person:<id>` is a pseudo-id**, not a chat. `/api/messages?chat=` takes a
   REAL chat id only. Person views fetch each member chat and interleave; the
   web store resolves via `memberChatIds()` then merges by `ts`. Every action
   (send, react, markread) must first resolve the person → target chat
   (`resolveTargetChat`: origin chat, or per-service picker when the user
   chooses).
3. **Status field is partly client-authored.** Sent/queued/pending states are
   optimistic client state; the server never sends them. Keep local overrides
   when reconciling SSE `message-updated` (the web store preserves
   `messages[idx].status` on update).

---

## 3. API quick reference

Auth: if `APP_API_TOKEN` is set, send `Authorization: Bearer <token>` on
/api and `?token=` query on /events. All bodies JSON unless noted.

### Reads
- `GET /api/status` — server + provider health (poll on app start)
- `GET /api/accounts` — linked accounts per provider
- `GET /api/chats` — full chat list (tabs filter client-side: all/channels/
  groups/hidden/people)
- `GET /api/messages?chat=<id>&limit=&before=<ts>` — ascending page, newest
  window; `before` = ts pagination for older pages
- `GET /api/participants?chat=` — group members
- `GET /api/search?q=` — FTS5 full-text (body + contact names)
- `GET /api/contacts`, `GET /api/contacts/lookup?q=`
- `GET /api/people`, `GET /api/tags`, `GET /api/notify-settings`
- `GET /api/link-preview?url=` — OpenGraph metadata for composed links

### Media
- `GET /api/media/<hash>.<ext>` — attachment (immutable, content-hashed)
- `GET /api/media/avatars/<hash>.<ext>` — avatar file (immutable)
- `GET /api/media/pdf-thumb/<file>` — rendered PDF first page
- `GET /api/avatar/<chatId>` — avatar *negotiation*: `{url}` if cached &
  fresh, else `{url:null, retry:true}` while the server fetches in the
  background — poll/retry with backoff, don't block UI
- `POST /api/media/fetch` — trigger lazy download of a `pending` media ref
  (WhatsApp history-sync media downloads on view)
- `POST /api/media/upload` (multipart) — stage an attachment before send
- `POST /api/avatar/upload` / `POST /api/avatar/pick` — set chat avatar

### Actions
- `POST /api/send` `{chatId, body, quoteId?, attachments?}` → Message
- `POST /api/send-media` (multipart: chatId, files…, filename!) → Message
- `POST /api/edit` `{messageId, body}` ; `POST /api/react` `{messageId,
  emoji}` (toggle) ; `POST /api/forward` `{messageIds, toChatIds}`
- `POST /api/markread` `{chatId}` ; `POST /api/typing` `{chatId}` (outgoing)
- `POST /api/chats/hide`, `POST /api/chats/pin`, `POST /chats` (compose new),
  `POST /api/dm-chat` (start DM from contact/person)
- People: `POST /api/people`, `PATCH/DELETE /api/people/:id`
- Tags: `POST /api/tags`, `POST /api/chats/tags`, `DELETE …/:chatId/:tagId`
- `POST /api/fetch-older` `{chatId}` — provider history backfill (one page)
- `POST /api/contacts/refresh` — CardDAV re-sync
- Notifications: `GET/PUT /api/notify-settings` (per-provider rules,
  mute/unmute; hidden ⇒ muted)

### Onboarding (per provider)
- WhatsApp: `POST /providers/whatsapp/connect` → poll `GET
  /providers/whatsapp/qr` (data URL) → render QR; `GET
  /providers/whatsapp/check` for lid-mapping diagnostics
- Telegram: `POST /providers/telegram/credentials` (phone) → `…/credential`
  (code) → (2FA password); the server parks on promises until fed
- Signal: `GET /providers/signal/qrcode` + `POST /providers/signal/link`;
  requires sidecar configured
- Mattermost: `POST /providers/mattermost/connect` (token) — prefer bot
  tokens; user PATs expire within days (`api.context.session_expired`)

### AI
- `POST /api/chats/suggest` — ghostwriter reply suggestions (cached
  server-side per chat, keyed by latest message ts — call on chat open and on
  new message only)
- `POST /api/chats/translate` `{chatId?, text?}` — translation

---

## 4. Realtime: SSE protocol

`GET /events` (add `?token=` if configured). Comment heartbeats every 25 s
(`: ping …`). Events are `data: {json}\n\n` — single `type` field:

| type | payload | client action |
|---|---|---|
| `message` | `Message` | append if in open chat (resolve person members!), bump unread + notify check |
| `message-updated` | `Message` | edit/revoke/receipt/reaction changes — replace by id, keep local `status` |
| `message-deleted` | `{id, chatId}` | remove bubble (mark tombstone if mid-thread) |
| `chats-updated` | — | refetch `/api/chats` |
| `typing` | `{chatId, name, expiresAt}` | show indicator, auto-expire by `expiresAt` |
| `accounts` | `Account[]` | refresh account badges |
| `contacts-refreshed` | `{count}` | invalidate contact caches |
| `status` | `{providers, carddav}` | account switcher status dots |

**Person-view filtering:** an incoming `message.chatId` is a real chat id —
match it against the *member* chat ids of the selected person, not the
selected id itself. (This exact bug shipped in the web client: edits didn't
appear until re-entering the chat.)

**Reconnect:** exponential backoff 3 s → 60 s (mirror the web). After any
reconnect, refetch chats + the open chat's tail to close the gap — events
are not replayed.

---

## 5. Feature catalog & implementation hints

### 5.1 Chat list
- Sections/tabs: All · Channels · Groups · Hidden · People. Filter
  client-side from one `/api/chats` response (`type`, `hidden`, person list).
- Row: avatar (Coil + `immutable` cache), name, provider badge, time,
  last-message preview, unread pill, pin indicator, draft indicator.
- Swipe actions: pin / hide (calls `chats/pin`, `chats/hide`).
- **Hint:** maintain `drafts: Map<chatId, string>` in the store (never sent
  to server); show draft in preview over last message.

### 5.2 Thread & bubbles
- Message grouping by sender + time proximity (web groups ≤5 min gaps).
- Bubble states: sent (✓), delivered (✓✓), read (blue ✓✓), pending (clock),
  failed (retry). See §6 receipts — semantics differ per provider.
- `edited` marker, `deleted` tombstones, disappearing ⏳ indicator when
  `chat.ephemeralExpiration` set.
- **Reactions:** row of emojis under bubble; long-press opens picker
  (web uses `EmojiPicker`). Reaction payload is `{emoji: [senderIds]}` —
  multiple users per emoji; own reaction highlighted.
- **Quote/reply:** swipe-to-reply or context menu → sets composer quote
  context; `POST /api/send {quoteId}`. Cross-chat quotes only WhatsApp
  (`crossChatQuotes` capability); SMS falls back to `> quoted` text prefix
  server-side.
- **Edits:** optimistic local patch (`body`, `edited=1`) on submit, then
  reconcile on `message-updated`. Capabilities: `edit` gates the UI.
- **Long-press menu:** react, reply, forward (`ForwardDialog` → multi-select
  target chats), edit, delete, copy, translate.
- **Formatting:** body is markdown-ish (bold/italic/strike/code, ``` fences,
  `>` quote blocks, links, @mentions as plain text). The web renders with a
  custom `Formatted` component — port with `AnnotatedString` +
  `LinkAnnotation`; keep mention plain text.
- **Mentions:** server already rewrites raw `@<digits>` to `@Name`
  (word-bounded). Client just renders text.

### 5.3 Composer
- Attach: photo picker + SAF document picker; `POST /api/send-media`
  multipart with **original filename** (server preserves it in the echo and
  provider upload; extension required for Mattermost inline rendering).
- Reply/edit modes with cancel; edit prefills composer.
- Typing out: fire-and-forget `POST /api/typing` (throttle to ~1 per 4 s
  while composing).
- **Service picker (people):** when the target is `person:N` and the person
  has multiple chats, show a compact provider selector; remember last choice
  per person; "origin" mode = reply in the chat the latest message came
  from. Resolve to a real chat id *before* calling any API.

### 5.4 Media & attachments
- Media list in bubble: images inline (Coil), documents as chips
  (name + ext + size if known) → tap opens viewer / `DownloadManager`
  with the **MediaRef.name** as filename (files on disk are content hashes —
  never surface the hash name to the user).
- `pending: true` media → show shimmer, call `POST /api/media/fetch`, render
  on `message-updated` (server swaps the ref when downloaded).
- PDFs: viewer via `pdf-thumb` preview + open intent.
- Paste-from-clipboard image support (Compose `onPaste` via
  `LocalClipboardManager`).

### 5.5 Avatars
- Negotiation flow (do NOT fetch provider avatars yourself):
  `GET /api/avatar/<chatId>` → cached `{url}` (Coil loads it, immutable,
  cache forever) or `{retry:true}` → retry with backoff (1 s → 10 s) while
  the server fetches from the provider in the background.
- Failure state is persistent server-side; don't hammer.
- Group avatars: server-composited; same endpoints.
- Content-hashed URLs mean a changed photo = new URL → just evict the Coil
  key on `chats-updated` when `avatarUrl` changes (the web bumps an
  `avatarVersion` counter).

### 5.6 People (cross-provider identity)
- A person links N provider chats. List under People tab; detail shows
  member chats + avatars.
- Create/link: multi-select chats → `POST /api/people`; unlink `PATCH`.
- Sending: §5.3 service picker. **Everything routes through
  `resolveTargetChat()` — person ids must never reach a provider route.**

### 5.7 Contacts & cards
- Server syncs CardDAV (`/contacts/refresh`); contact names override
  provider names everywhere (server-side, in `getChats`).
- vCard attachments render as contact cards: show fields, actions =
  save-to-contacts (Android ContactsContract insert intent — much easier
  than the web's DAV round-trip) + message-on-WhatsApp.
- Contact creation from a chat header: `POST /api/contacts/add`.

### 5.8 Search
- `/api/search?q=` — FTS5 over bodies + names. Rank by recency; result rows
  deep-link to `chatId` + highlight `ts` (scroll-to-message in thread).

### 5.9 Notifications
- **Server-side rules** (`/api/notify-settings`): per-provider on/off,
  per-chat mute; `hidden ⇒ muted`. Respect them client-side too (the server
  already suppresses push for muted).
- **Push:** server POSTs to every registered UnifiedPush endpoint
  (`POST /api/push/register {endpoint}`) on new messages, with headers:
  `Title` = chat display name, body = preview (≤200 chars, plain),
  `X-Chat-Id`, `X-Message-Id`.
  - Integrate **UnifiedPush** (no Google dependency, self-hosted ethos):
    distribute the embedded ntfy/UP endpoint from the app to the server.
  - On receipt: post a `NotificationCompat` message-style notification;
    deep-link `X-Chat-Id` → thread activity; mark read via `POST
    /api/markread` from a notification action.
  - Per-provider notification channels; mute = channel off (persisted).
- Foreground service holds SSE while app is foreground for instant
  in-app updates; UnifiedPush covers background.

### 5.10 AI assist
- Suggest: bottom-strip above composer with 2–3 ghostwritten replies —
  call `/api/chats/suggest` on chat open + new message (server caches per
  latest-ts; don't call per keystroke).
- Translate: message context-menu action → inline translated text.

### 5.11 Accounts & onboarding UI
- `AccountsDialog` equivalent: per-provider status dot (SSE `status`),
  connect/logout flows (§3 onboarding). QR screens are simple full-bleed
  `Image`s polling a data URL.
- Telegram wizard: phone → code → (2FA) — sequence of screens against the
  credential endpoints; errors surface verbatim.

### 5.12 Miscellaneous parity
- Unread divider + jump-to-latest FAB when scrolled up; guards for
  empty/short lists (divider placement bugs bit the web twice).
- Infinite scroll up → `GET /api/messages?before=` locally, then
  `POST /api/fetch-older` to extend from the provider.
- Tags on chats (server AI auto-tags; manual add/remove) — filter chips.

---

## 6. Read receipts & status semantics (per provider — traps included)

`Message.status` is a normalized enum but its *meaning* differs:

| Provider | delivered | read | notes |
|---|---|---|---|
| WhatsApp DM | `messages.update` status | same | **PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4 — off-by-one trap** |
| WhatsApp group | n/a | `message-receipt.update` per reader | blue only when ALL recipients read; readers in `receipt_readers` |
| Telegram | n/a | `UpdateReadHistoryOutbox` | read-only; no delivered state |
| Signal | `isDelivery` | `isRead` booleans | |
| Mattermost | n/a | n/a | no receipts |
| voip.ms | n/a | n/a | SMS has no receipts |

Client hint: render ✓✓ for "delivered-or-better" and blue for read; don't
try to surface provider-specific nuance.

---

## 7. Suggested project structure

```
app/
  src/main/kotlin/…/
    data/        Retrofit services, DTOs (mirror server types verbatim)
    store/       AppStore.kt (single StateFlow store), reducers
    realtime/    SseClient.kt (EventSource + backoff + gap refetch)
    push/        UnifiedPush receiver, NotificationPoster
    ui/
      chatlist/  ChatListScreen, ChatRow, Tabs
      thread/    ThreadScreen, Bubble, FormattedText, MessageStatus
      composer/  Composer, AttachSheet, ServicePicker, EmojiSheet
      people/    PeopleScreen, PersonDetail
      onboarding/ ProviderQR, TelegramWizard
      dialogs/   Forward, Accounts, NotifySettings, AiStrip
    util/        IdNamespacing.kt, TimeFormat, FormattedParser
```

Gradle deps (minimum): compose-bom, material3, navigation-compose,
retrofit + okhttp + kotlinx-serialization-converter, okhttp-eventsource,
coil-compose, room (optional), work-runtime, unifiedpush-connector.

---

## 8. Security

- `APP_API_TOKEN`: store in EncryptedSharedPreferences; attach
  `Authorization: Bearer` to every call and `?token=` to `/events`.
- Server is plain HTTP on LAN in the common deployment — enforce
  `android:usesCleartextTraffic` scoping or a network security config limited
  to your host; recommend Caddy TLS in front (repo has `deploy/Caddyfile.example`).
- No secrets in the app binary; the token is the only credential.

---

## 9. Lifecycle & performance hints (hard-won on web)

- **One SSE connection, ever.** Reconnect with backoff; on resume (app
  foregrounded), if the stream was dropped, refetch open chat tail + chats.
- **Never serialize avatar/media negotiation on the UI path** — the web
  starved its connection pool (6/origin) with hanging avatar fetches and
  message loads hit 34 s. On Android: Coil handles async; keep the
  `/api/avatar` negotiation in a background coroutine with retry backoff.
- Pagination: fetch ≤100 messages per page (server caps 500); render-window
  the list (web uses ~300 rows) — use Compose `LazyColumn` with keys =
  message ids.
- Debounce `/api/chats` refetches (`chats-updated` bursts on sync sweeps).
- Drafts, per-chat scroll position, unread divider state: keep in the store,
  survive config changes (ViewModel) — not in `remember {}`.

---

## 10. Message flow walkthrough (canonical)

1. User opens chat → `GET /api/messages?chat=…` (or member chats merged by
   ts for person) + `GET /api/avatar/<chatId>` + `POST /api/chats/suggest`.
2. Compose → optimistic append (`status: pending`) → `POST /api/send` →
   replace with returned Message (`status: sent`).
3. Delivery/read arrive as `message-updated` — merge, keep local status if
   newer.
4. Incoming → SSE `message` → if open chat append + `POST /api/markread`;
   else unread++; notification fan-out happens server-side (UnifiedPush).

---

## 11. What NOT to port

- Provider quirks (lid mapping, receipt juggling, group-MMS dedup) — all
  server-side by design (single ingest funnel in `server/src/services/ingest.ts`).
- SQLite schema, FTS triggers, dedup logic — the DB is the server's.
- AI prompt-injection defenses — server-side; the app only renders results.

## 12. Bug folklore (each of these shipped and was fixed on web)

- Person pseudo-ids reaching action routes (crashes / silent no-ops).
- Unbounded `@digits` mention replacement mangling overlapping numbers.
- SSE-updated messages dropped in person views (`chatId !== selected`).
- Edit not applying until chat re-entry (same root cause).
- Avatar re-fetch storms on every load (fix: persistent cache + immutable).
- Scroll/unread-divider logic assuming non-empty lists.
- Losing filenames on download (MediaRef.name must flow end-to-end).

Keep this list in mind during code review of the Android port.

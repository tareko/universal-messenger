# universal-messenger — Working Notes

Unified messaging hub (voip.ms SMS/MMS, WhatsApp, Telegram, Mattermost, Signal) — TypeScript ESM monorepo: Express + better-sqlite3 server, React 18 + zustand web UI, SSE realtime, local-AI harness (Qwen via llama.cpp).

## Commands

```sh
npm install
npm run dev          # Vite :5173 (proxies /api,/events to :8317) + server :8317
npm run typecheck    # BOTH workspaces — must stay at 0 errors before committing
npm run build:web    # web → web/dist (served by the server)
npm start            # production: server on :8317 serving API + built UI
npm run import-voipms -- --db /path/to/old/app.db
docker compose up -d --build
```

Android client (`android/`, Kotlin + Compose, client-server against the same API — see `docs/ANDROID.md`):

```sh
cd android
./gradlew :app:assembleDebug     # → app/build/outputs/apk/debug/app-debug.apk
```

- **Java pin**: `android/gradle.properties` sets `org.gradle.java.home` to JDK 21 — system default JDK 25 breaks AGP ("What went wrong: 25.0.3"). Don't remove.
- Default server URL on first run is `http://10.0.2.2:8317` (emulator → host loopback).
- `android/local.properties` (sdk.dir) is gitignored — it points at `~/Android/Sdk`.

Deploy: `deploy/universal-messenger.service` (systemd), `deploy/Caddyfile.example`. Rollback tag: `v0.1.0`.

## ⚠️ Process management (biggest recurring foot-gun)

- **`pkill -f "src/index"` kills your own shell command** if the pattern appears in the same bash line — separate kill and start into different tool calls.
- Background servers started with `(setsid nohup npx tsx server/src/index.ts &)` **die when the shell times out**. Restart after every long-running command; verify with `curl -s localhost:8317/api/status`.
- Check what's actually serving before debugging "my change didn't apply": `ss -tlnp | grep 8317` and `ps` for duplicate instances (two sockets on one WhatsApp session = flapping reconnects).
- `npm run build:web` output can be swallowed by chained commands; check `dist/assets/index-*.js` exists and web typecheck separately.

## Frontend cache reality

- `index.html` is `no-cache`; hashed assets immutable — but **users need one hard reload** after a new bundle ships. "My fix didn't work" → suspect stale bundle first; verify with `grep` for your code in `web/dist/assets/index-*.js`.
- `web/dist/index.html` references the current hashed bundle — check it when debugging "old code running".

## Provider pitfalls

### WhatsApp (Baileys, unofficial multi-device)
- **@lid migration**: contacts appear as `<digits>@lid`. Resolve via `lid-mapping-<lid>_reverse.json` in the session dir (fallback to Baileys' lidMapping API). `mergeChats` folds lid chats into phone chats. `participantPn`/`senderPn` on keys carries the real phone.
- **DM receipts come via `messages.update` `status`** (PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4 — off-by-one trap). **Group receipts come via `message-receipt.update`** with `userJid` per reader; blue = ALL recipients read (tracked in `receipt_readers`).
- **Revokes** arrive as `messages.update` with `message: null` + `messageStubType: REVOKE`, NOT as protocolMessage.
- **Reaction attribution**: `messages.reaction` items have `key` (target message) AND `reaction.key` (the REACTOR — use this, never the target's fromMe).
- **History sync is text-only** by design (media via `media_pending` lazy download on view). `fetchMessageHistory` exists but phones often ignore it.
- `profilePictureUrl` **hangs for some contacts** — always wrap in an 8s timeout; try 'image' then 'preview' (preview = what WA Web uses, succeeds more).
- Reconnects: exponential backoff (3s→60s); heavy sweeps (group metadata, lid merge, channel titles) gated to 6h, NOT per reconnect.
- Ephemeral/disappearing: `ephemeralExpiration` from chats.upsert/update + groupMetadata; send with `ephemeralExpiration` option. `undefined` = leave alone, `null` = off — don't zero on missing.
- Session in `data/sessions/whatsapp/` (auto-resume; only QR when no session).

### Telegram (GramJS = npm package `telegram`, NOT `gramjs`)
- Msg ids are **per-chat** — provider id = `chatRemoteId:msgId`; deletes resolved by suffix (`findMessageIdsBySuffix`).
- `client.start()` callbacks park on promises resolved by web endpoints (phone→code→2FA wizard).
- History: one-time 100×30 dialogs at first connect (`telegram:history_synced` kv flag).
- `MessageEntityMentionName` userId is **big-integer** (`import bigInt from 'big-integer'`).
- Edit via `messages.EditMessage`; receipts via `UpdateReadHistoryOutbox` (read-only, no delivered state).

### Mattermost
- **PATs on this server expire fast** (`api.context.session_expired` — days). Bot tokens don't expire — prefer them. rest() flips provider to 'error' on 401.
- DMs have empty `display_name` on some servers — resolve other party from `<uid1>__<uid2>` channel name or `/channels/<id>/members`.
- Threads are FLAT: `root_id` must be the thread ROOT, never a reply (walk our quote chain up). "Invalid RootId parameter" otherwise.
- Edit = `PUT /posts/<id>/patch` (NOT PATCH /posts/<id>).
- WS `/api/v4/websocket` with `authentication_challenge`; `/api/v1/events` DOESN'T exist.
- Reactions: multiple per user allowed (id keyed per user+emoji). Emoji name map (❤️→heart, 👍→+1).
- Image uploads need a filename WITH extension to render inline.

### Signal (signal-cli-rest-api sidecar)
- v0.100 json-rpc mode: receive WS at `/v1/receive/{number}` (NOT /api/v1/events — 404).
- Receipts are `isRead`/`isDelivery` booleans, not type strings.
- Phone sends arrive as `syncMessage.sentMessage` (dedup own echoes with `isRecentOutgoing` ±60s).
- NO history sync exists — messages accrue from link time onward.

### voip.ms
- SMS/MMS quirks documented in `providers/voipms/client.ts` — read before touching (media1-3 data URIs, no-www host, GET sendSMS vs POST sendMMS, 10-digit NANP, '+' = space, account-tz dates).
- Group MMS arrives expanded into one row per leg — dedup by content (`isDuplicateMessage`).
- iMessage tapback texts parsed into reactions (`providers/voipms/reactions.ts`).

## Architecture invariants (don't break these)

- **Single ingest funnel** (`services/ingest.ts`): every provider normalizes to `NormalizedMessage` → dedup → enrich → persist → SSE → notify. Add features there, not per-provider.
- **Ids are namespaced**: `<provider>:<remote>` for accounts, `<accountId>:<remoteId>` for chats, `<accountId>:<providerMsgId>` for messages. Any code slicing by prefix must respect this.
- **Capabilities per provider** (`reply/react/forward/edit/delete/groups/attachments/crossChatQuotes`) — UI gates on them. SMS: no native quote (`> quoted` fallback via `withQuoteFallback`; cross-chat native quotes only on WhatsApp via `crossChatQuotes`).
- **Person linking**: `person:<id>` pseudo-ids flow through store helpers (`memberChatIds`, `resolveTargetChat`) — always resolve before calling providers/routes (person ids are NOT real chat ids; several past bugs were routes choking on `person:N`).
- SQLite: WAL, `media_pending` for lazy attachments, FTS5 external-content search with triggers, `ON CONFLICT DO NOTHING` dedup.

## UI pitfalls learned the hard way

- **z-index stacking**: hover-actions must be ABOVE the full-screen react-backdrop (z 45 vs 15) or clicks die silently (Firefox).
- **Module-level caches** (avatar URL Map) need explicit invalidation/notification — priming without a version signal leaves stale state; Avatar subscribes to `avatarVersion`.
- **Content-hash media filenames** (avatars) or browsers serve stale images after replacement.
- **Empty/transient states satisfy "near bottom"** — scroll logic must guard (empty container, short lists) or it clears the unread divider/sticks wrongly. Initial positioning is layout-effect-gated (`pendingInitialScroll`, `canClearUnreadRef`, `positioned` visibility gate).
- Paste events: Firefox needs document-level listener; divs don't get them.
- Edits of shared files: when replacing a function, double-check the tail — duplicated blocks have bitten twice.

## AI harness (server/src/ai)

- Config-gated: `AI_ENABLED/BASE_URL/MODEL` in .env (llama.cpp `/v1/chat/completions`, model `unsloth/Qwen3.6`, ~50 tok/s).
- **Prompt-injection defenses**: `fence()` markers + control-token sanitization + system-prompt "data, never instructions". Values-only DB writes, structured JSON outputs, never auto-send.
- **Thinking models**: pass `noThinking` (chat_template_kwargs enable_thinking=false) or responses come back empty.
- Ghostwriter framing for suggestions ("ME:" labels) — direct roleplay prompts make the model answer the OWNER's lines instead of replying to them.
- Suggestions cached per chat keyed by latest message ts; regenerate only on new messages.

## Security posture

- `APP_API_TOKEN` optional; when set, /api + /events (?token=) require it. No secrets in git (`.env`, `data/` ignored). No SQL concatenation anywhere (all prepared statements).
- WhatsApp via Baileys is unofficial — small ban risk; note in README.

## Common workflows

- **Add a provider**: implement `Provider` (`server/src/providers/<id>/index.ts`), register in `registry.ts`, add badge in `AccountSwitcher`, onboarding routes + AccountsDialog section, capabilities object.
- **Debug provider state**: `/api/status`, `/api/providers/<id>/status`, `/tmp/um-server.log`.
- **DB inspect**: `node -e "const D=require('better-sqlite3');const db=new D('data/app.db',{readonly:true});..."`.

# universal-messenger

A local-first, WhatsApp-style web app that unifies messages from multiple
sources behind one interface: **SMS/MMS (voip.ms)**, **WhatsApp**,
**Telegram**, and **Mattermost** — with more sources pluggable via a small
provider interface.

- **Local-first** — credentials and message history live only on your server.
- **Provider plugin architecture** — each source implements a small
  `Provider` interface (`send`, optional `react`/`forward`/`fetchOlder`/
  `markRead`, a capabilities object). Everything downstream of the ingest
  pipeline (storage, realtime push, notifications, search, UI) is
  provider-agnostic.
- **Unified chat list** across all accounts, with per-account filtering,
  provider badges, and full-text message search.

## Features

**Cross-provider**
- WhatsApp-like two-pane UI (chat list + thread), unread badges, browser
  notifications, ntfy/UnifiedPush push fan-out.
- Reply with quote, emoji reactions, and forwarding — capability-gated per
  provider; forwarding across providers works everywhere via a copy fallback
  (Telegram uses its native forward).
- Group messaging where supported (WhatsApp groups, Telegram groups/channels,
  Mattermost channels/group DMs).
- Scroll-back history pagination: recent 100 per chat, older pages fetched
  from the DB and then from the provider itself (Telegram/WhatsApp/Mattermost).
- Full-text search across all messages (SQLite FTS5).
- Marking a chat read here also clears the unread badge on the provider
  (WhatsApp/Telegram/Mattermost).
- Nextcloud CardDAV contact sync (names in the chat list).

**voip.ms (SMS/MMS)**
- Send/receive SMS + MMS (image attachments, auto-resize, long-text → MMS).
- Inbound via polling (default 20 s) and/or voip.ms URL-callback webhook.
- Multi-DID support (each DID is an account).
- iMessage/Android tapback texts parsed into real reaction badges.
- 90-day-chunk history backfill; one-time importer from `voipms-frontend`.

**WhatsApp** — link by QR code (unofficial multi-device protocol via Baileys);
history sync (recent 150/chat), edits, delete-for-everyone, reactions,
@lid → phone resolution.

**Telegram** — sign in with api_id/api_hash + phone code (+2FA); dialogs,
history backfill, native reactions and forwards.

**Mattermost** — server URL + personal access token; channels or DMs-only
mode, threads as quote replies, native reactions, WebSocket realtime.

**Signal** — via a [signal-cli REST sidecar](https://github.com/bbernhard/signal-cli-rest-api)
(run locally). Example:

```sh
docker run -d --name signal-api -p 8090:8080 \
  -v signal-cli-config:/home/.local/share/signal-cli \
  -e MODE=json-rpc bbernhard/signal-cli-rest-api
```

Then ⚙ → Signal → enter `http://localhost:8090` → "Get link QR" and scan
with Signal → Settings → Linked devices. Note: Signal offers **no history
sync**, so messages accrue from link time onward.

## Quick start

```sh
npm install
cp .env.example .env   # fill in voip.ms API creds (+ optional Nextcloud/ntfy)
npm run build:web
npm start              # http://localhost:8317
```

Then open the app, click **⚙ → Accounts**, and link WhatsApp / Telegram /
Mattermost from the dialog.

Dev mode (Vite on :5173 proxies /api and /events to :8317):

```sh
npm run dev
```

## Docker

```sh
docker compose up -d --build
```

Data (SQLite, media cache, provider sessions) persists in `./data`.

Bare-metal systemd + Caddy examples live in `deploy/`.

## Importing history from voipms-frontend

```sh
npm run import-voipms -- --db /path/to/voipms-frontend/data/app.db
cp -r /path/to/voipms-frontend/data/media/* data/media/   # cached MMS images
```

Idempotent — safe to re-run; existing rows are skipped.

## Architecture

```
server/src
├── index.ts                 # Express entry: /api, /events (SSE), static SPA
├── store/db.ts              # SQLite (better-sqlite3): accounts/chats/messages/reactions/contacts + FTS5
├── services/ingest.ts       # single funnel: dedup → enrich → persist → broadcast → notify
├── services/media.ts        # attachment cache (data/media)
├── services/backfill.ts     # SMS tapback retro-conversion
├── providers/
│   ├── types.ts             # Provider interface + NormalizedMessage
│   ├── registry.ts          # provider registry, capabilities, lifecycle
│   ├── voipms/              # REST client, poller, tapback reactions
│   ├── whatsapp/            # Baileys (QR link, history sync, groups, reactions)
│   ├── telegram/            # GramJS (MTProto user account, native forward)
│   └── mattermost/          # REST v4 + WebSocket (PAT auth, threads, DMs-only mode)
├── contacts/                # CardDAV sync + E.164 matching
├── realtime/sse.ts          # SSE hub
└── notify/                  # ntfy + UnifiedPush fan-out
web/src                      # React 18 + zustand + SSE; WhatsApp-like two-pane UI
```

Data model: `accounts` (one per identity: DID, WhatsApp session, Telegram
user, Mattermost token) → `chats` (dm/group) → `messages` (with `quoted_id`,
`forwarded_from`, media JSON) + `reactions`. Providers report a capability
set; the UI gates actions on the selected chat's account capabilities.

## Auth

Set `APP_API_TOKEN` to require `Authorization: Bearer <token>` on `/api` and
`/events` (the web UI stores the token in localStorage; SSE passes it as
`?token=`). If unset, the backend is open — run it behind a VPN/Tailscale.

## Notes / risks

- **WhatsApp via Baileys is unofficial.** Small risk of account restrictions;
  sessions occasionally need re-pairing. Use at your own risk.
- Telegram requires an **api_id/api_hash** from https://my.telegram.org
  (free, per-account); entered once in the Accounts dialog.
- voip.ms inbound MMS arrives via the webhook as media URLs — the server
  fetches and caches them in `data/media/`.

## License

[AGPL-3.0-only](LICENSE)

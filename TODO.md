TODO:

1. [-] Create an instagram service — SKIPPED (user decision: not worth Meta ban risk/infra)
2. [-] Create a facebook messenger service — SKIPPED (user decision)
3. [-] Are you able to create a twitter DM service? — SKIPPED (official API is paid tier ~$200/mo; scrapers too fragile)
4. [x] AI replies perspective: reframed as ghostwriter with 'ME:' labeling + last-speaker-aware drafting
5. [x] bug: phone numbers in the top left of a chat now use international format (+CC xxx xxx xxx); NANP keeps (xxx) xxx-xxxx
6. [x] Hiding a conversation now also mutes it (unhide unmutes)
7. [x] Edit message logic: WhatsApp/Telegram/Mattermost providers + /api/edit + pencil hover action + composer edit mode
8. [x] Signal receipts: use isRead/isDelivery booleans — delivered (2 grey) now shows
9. [x] Mattermost attachments: fetch file_ids + /files/info when WS lacks metadata; all file types downloaded (not just images)
10. [x] Mattermost image uploads get proper filename extension so they render inline as pictures

Notes:
- #1/#2 researched: mautrix-meta (AGPL, maintained) would cover both but needs a Matrix homeserver + Meta session; instagrapi viable for Instagram-only. Can revisit if ever wanted.
- #3: X/Twitter DMs behind paid API tiers; unofficial scrapers unreliable.

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Svelte / SvelteKit with `adapter-node`, as **one process** on an Oracle Cloud Always Free VM: it holds the platform connections (started from `hooks.server`) and serves the phone page. Each platform is one adapter with the same interface, emitting one shared event shape: `{id, platform, kind, author, text, amount?, currency?, ts}`.

## Users

One streamer, who runs one YouTube stream and one Twitch stream at the same time (~50 concurrent viewers, ~12 hours a day). They read chat on their phone while streaming, glancing between the stream and the screen. The app is built for them by someone else (the developer), who owns and operates all accounts.

## Product Purpose

chaat-mix merges YouTube and Twitch chat into one feed in true time order, so the streamer reads one screen instead of two apps. It includes paid and support events: YouTube Super Chats, Super Stickers, memberships and milestones; Twitch subs, resubs, gift subs, cheers (bits) and raids.

Success: the streamer never misses a message or paid event, and never has to set anything up or pay for anything.

## Positioning

A private, single-streamer tool with zero operational burden on the streamer: one tap each to connect Twitch and YouTube, nothing to install, nothing to keep running on their PC, no cost.

## Operating Context

- Used on a phone, often propped next to the streaming setup, for hours at a time; the screen must stay awake.
- Opened from the home screen (installed web app) via an HTTPS DuckDNS address.
- Phone network can drop or the browser can suspend the tab; the feed must recover without the streamer doing anything.
- YouTube messages can arrive seconds late; the feed holds a short buffer and inserts by platform timestamp.

## Capabilities and Constraints

- **Reply on both platforms; no moderation.** No deleting or banning.
  - **Twitch:** sent with Send Chat Message as a real reply to the message; needs `user:write:chat` added to the one-time Twitch connect.
  - **YouTube:** live chat has no threads, so a reply is a new message starting with `@author`, sent with `liveChatMessages.insert` (20 quota units each). Needs a one-time "Connect YouTube" Google login with the `youtube.force-ssl` scope.
  - **Google app status:** published "In production" but **unverified**. Testing mode would expire the login every 7 days; unverified production does not, and its 100-user lifetime cap is enough for one streamer. Cost: the streamer sees Google's "unverified app" warning once when connecting. Google verification (3–5 business days) stays optional.
  - Reading YouTube chat keeps using the API key, so a broken Google login only stops replies, never the feed. The issue popup shows "Reconnect YouTube" when it happens.
- **Issue popup:** a small, non-blocking popup appears for any problem (a platform disconnected, Twitch login rejected, YouTube quota used up, phone offline, server unreachable). It names the platform and says what's happening in plain words. Problems the system fixes on its own clear the popup automatically once resolved; problems that need the streamer (e.g. Reconnect Twitch) keep it up with that one action. It never covers the feed or blocks reading.
- **Mark/pin messages:** the streamer can mark a message to come back to (e.g. a Super Chat to read aloud). Stored by the app, not sent to any platform. The same control unpins; "Clear all pins" asks with the count ("Clear 7 pins?").
- **Feed behaviour:** newest at the bottom; auto-scroll only while the streamer is at the bottom, otherwise a "N new ↓" pill. Shows "Waiting for YouTube / Twitch to go live" per platform instead of a blank screen. Keeps the last ~500 messages on screen; pinned and paid events are kept separately so they never drop off. The server keeps the last ~200 events to replay to a phone that reconnects.
- **Never colour alone:** every message shows a platform icon/label; paid events carry a text label and amount ("Super Chat ₹200", "100 bits").
- **Accessibility:** the feed is `role="log"` with an accessible name ("Chat"). `log` is polite by default, which would read every chat message aloud; this app deliberately overrides it with `aria-live="off"` and announces only paid events and issue popups, politely. Tap targets at least 44px. A text-size setting for arm's-length reading. New-message and paid-event motion is off under `prefers-reduced-motion`.
- **Developing without a live stream:** real events are recorded to a JSON file once; the dev server replays them.
- **Private access:** every page and action, including the Connect Twitch step, requires a long secret in the URL path (`/s/<secret>/`). Without it, anyone who finds the address could overwrite the streamer's Twitch connection. Not a cookie: iOS home-screen apps have their own cookie jar, separate from Safari, so the web app manifest's `start_url` is relative and the installed icon carries the secret.
- **Twitch and YouTube connect** (same flow for both, Google returning to `/auth/google/callback`): only `/s/<secret>/connect/<platform>` can start it. It issues a random, single-use OAuth `state` value that expires after a few minutes and is bound to the browser that started it (a short-lived cookie set by `/connect`), as RFC 9700 requires. Twitch returns to a fixed `/auth/twitch/callback` with no secret in it, which accepts only a `state` the server just issued to that same browser and discards it after use. Rotating the access secret therefore never requires changing the Twitch developer console.
- **YouTube:** read with an API key only, no Google login (confirmed 2026-11-24 for `liveChatMessages.list`; `streamList` with only a key still to be tested). One live chat via `liveChatMessages.streamList`; default quota 10,000 units/day.
- **Twitch:** EventSub WebSocket; streamer grants `user:read:chat`, `user:write:chat` and `bits:read` once. `channel.chat.notification` covers subs, resubs, gifts and raids; `channel.cheer` covers bits.
- **Zero cost:** Oracle Always Free VM (never upgraded to Pay As You Go), DuckDNS, Caddy/Let's Encrypt, public GitHub repo with Actions.
- **Fully automated hosting:** an idempotent oci CLI script (`infra/ensure.sh`) + a first-boot script (`infra/boot.sh`); the app runs under systemd with `Restart=always`. The instance's availability recovery action is set to `RESTORE_INSTANCE`, so Oracle itself restarts it after a hardware fault (this does not cover idle reclaims). A GitHub Actions watchdog runs every 30 minutes and decides from the OCI API, never from `/health` alone:
  - instance missing or terminated → launch a new one (first boot rebuilds everything);
  - instance stopped → start it;
  - instance running but `/health` failing → soft reboot through the OCI API (`SOFTRESET`); disk and certificates are kept, no SSH is opened.
  This matters because each rebuild requests a new Let's Encrypt certificate, and Let's Encrypt allows only 5 duplicate certificates per 7 days.
- **State survives rebuilds:** a private OCI Object Storage bucket, created by hand so no script can delete it and reached only through a secret pre-authenticated request link, is the source of truth for the Twitch and Google tokens, pins and Caddy's certificates. Every change is written through immediately; the VM disk is only a cache. Rebuilds never require the streamer to reconnect.
- **One status model:** each platform reports `live`, `waiting` (not streaming), `not connected` or `error` with a reason. The same status drives the issue popup, the feed header and `/health`; the watchdog fails its job (so GitHub emails the developer) when a source is in `error`. YouTube quota used today is tracked and shown in `/health`; reconnects back off before reaching 10,000.
- **Platform connections:** follow Twitch's `session_reconnect` without dropping subscriptions; when a YouTube chat ends, go back to checking whether the channel is live.
- Third-party donations (Streamlabs/StreamElements) are undecided; not in the first version.

## Brand Commitments

Product name: **chaat-mix**. No streamer branding.

## Evidence on Hand

No content, screenshots or assets exist yet. Do not invent streamer names, usernames or testimonials.

## Product Principles

1. **The streamer does nothing.** Any step that needs the streamer's attention is a design failure unless it is the one-time Twitch or YouTube connect.
2. **Never miss a paid event.** Super Chats, memberships, subs, gifts and bits must be impossible to overlook at a glance.
3. **True order over arrival order.** Messages appear by platform timestamp, not by when they reached the server.
4. **Glanceable from arm's length.** The feed is read in quick looks while performing.
5. **Recover silently.** Reconnects, rebuilds and dropped networks fix themselves without prompts.

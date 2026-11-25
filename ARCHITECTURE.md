# Architecture

How chaat-mix is built. Product rules live in [PRODUCT.md](PRODUCT.md); this file is the technical design.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 26 (Active LTS, supported to April 2029) | Current LTS |
| App | SvelteKit 3 (Svelte 5) with `@sveltejs/adapter-node` | One process serves the page and holds the platform connections |
| Env | `process.env` via `src/lib/server/env.ts` (Node's `loadEnvFile` in dev, systemd `EnvironmentFile` in prod) | SvelteKit 3's env schema is more than this app needs |
| Phone ↔ server | Server-Sent Events (`/s/<secret>/events`) | Push only; the browser reconnects and resumes by `Last-Event-ID` on its own; no custom server |
| YouTube | **Now:** `liveChatMessages.list`, polls spread over the day's quota (~25 s apart). **Next:** `streamList` over gRPC once Google's `stream_list.proto` is added. `playlistItems.list` + `videos.list` for live detection | Polling is a marked shortcut in `youtube.ts` |
| Twitch | EventSub WebSocket (`wss://eventsub.wss.twitch.tv/ws`) + Helix API with `fetch` | Twitch's recommended way to read chat |
| State | OCI Object Storage through a bucket pre-authenticated request (PAR) URL, plain `fetch` | Free, survives rebuilds; no SDK, no IAM identity setup |
| HTTPS | Caddy (automatic Let's Encrypt), reverse proxy to the app | Zero-config certificates |
| DNS | DuckDNS | Free |
| VM | Oracle Always Free `VM.Standard.E2.1.Micro` (fallback `VM.Standard.A1.Flex`), Ubuntu LTS | Free |
| Infra | `infra/ensure.sh` (oci CLI, idempotent) + `infra/boot.sh` (first-boot script) | Rebuild from code, no Terraform state to keep |
| CI / watchdog | GitHub Actions in a public repo | Unlimited free minutes |
| Tests | Vitest | Ships with SvelteKit's template |

No database, no Redis, no UI library, no CSS framework: one screen does not need them.

## Runtime shape

```
YouTube (gRPC streamList) ─┐
                           ├─► adapters ─► merge buffer ─► hub ─► WebSocket ─► phone (SvelteKit page)
Twitch (EventSub WS) ──────┘     │            (2 s, by ts)   │
                                 │                           └─► replay ring (last 200 events)
                                 └─► status (per platform) ─► popup, header, /health
state (token, pins) ◄──► OCI bucket (write-through)
Caddy :443 ─► app :3000
```

### Event shape (shared by adapters, hub and UI)

```ts
type ChatEvent = {
  id: string;                 // platform message id
  platform: 'youtube' | 'twitch';
  kind: 'message' | 'superchat' | 'supersticker' | 'membership' | 'milestone'
      | 'gift' | 'sub' | 'resub' | 'cheer' | 'raid';
  author: string;
  text: string;
  amount?: number;            // display amount (e.g. 200, 100 bits)
  currency?: string;          // 'INR', 'BITS', ...
  ts: string;                 // platform timestamp, ISO 8601 UTC
};

type SourceStatus = {
  platform: 'youtube' | 'twitch';
  state: 'live' | 'waiting' | 'not_connected' | 'error';
  reason?: string;            // plain-language, shown in the popup
};
```

### Server modules

```
app/src/lib/server/
  youtube.ts     live detection + streamList; resumes with the last nextPageToken
  twitch.ts      EventSub session, subscriptions, session_reconnect, token refresh
  hub.ts         2 s merge buffer sorted by ts, replay ring, broadcast, status
  state.ts       load/save token + pins to the bucket (write-through)
  quota.ts       YouTube units used today (resets midnight Pacific)
  reply.ts       Twitch: Send Chat Message (reply to message id); YouTube: liveChatMessages.insert
                 with "@author " prefix, Google OAuth token (youtube.force-ssl); refuses when quota is low
app/src/hooks.server.ts                       checks /s/<secret>/, starts adapters once
app/src/routes/s/[secret]/+page.svelte        the feed
app/src/routes/s/[secret]/connect/[platform]/+server.ts  starts Twitch or Google OAuth (state + cookie)
app/src/routes/s/[secret]/reply/+server.ts               POST {platform, messageId, author, text}
app/src/routes/auth/twitch/callback/+server.ts
app/src/routes/auth/google/callback/+server.ts
app/src/routes/health/+server.ts              per-platform status, quota
```

### Phone page

One screen:

- **Header:** a status chip per platform (text + icon, never colour alone), pins count.
- **Feed:** `role="log"`, newest at the bottom, ~500 messages kept; paid events labelled with type and amount.
- **"N new ↓" pill** when scrolled up.
- **Issue popup:** small, non-blocking, bottom of screen; one action when the streamer must act ("Reconnect Twitch").
- **Pins sheet:** list of pinned messages, unpin per item, "Clear N pins?".
- **Text size** control, stored locally.
- Screen Wake Lock while open; web app manifest with a relative `start_url`.

Visual design is done in Figma.

## Infra

```
infra/
  ensure.sh        idempotent, oci CLI: VCN, internet gateway, security list (80/443 only, no SSH),
                   subnet; launch the VM if missing (RESTORE_INSTANCE recovery), start if stopped,
                   SOFTRESET if /health is unreachable; fail the run if a source is in error
  boot.sh          first boot: swap, open iptables 80/443, Node 24 + Caddy + git, DuckDNS cron,
                   clone + build + systemd unit, restore/backup Caddy certificates via the bucket PAR
.github/workflows/
  watchdog.yml     every 30 min runs ensure.sh; manual run with "recreate" rebuilds the VM;
                   monthly heartbeat commit
```

No Terraform: the script needs no state file of its own, and Oracle resources are found by name.
App updates need no deploy step: the VM checks `main` every 5 minutes and rebuilds itself.
The state bucket is created once by hand, so no script can delete it.

## Build order

1. `infra/` + `watchdog.yml`; deploy a hello-world page over HTTPS.
2. Twitch adapter + connect flow.
3. YouTube adapter (first: test `streamList` with only an API key).
4. Hub, feed page, issue popup, pins.
5. Record real events once; replay them in dev.

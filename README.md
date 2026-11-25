# chaat-mix

**One live chat for a streamer who is live on YouTube and Twitch at the same time, on their phone, in real time, with no hosting bill.**

Streamers who broadcast to two platforms end up juggling two chat windows. chaat-mix merges both into one feed, in the order the messages were sent: chat, Super Chats, memberships, subs, gifted subs, bits and raids. The streamer can reply to either platform from the same screen.

It runs in production for one streamer (about 50 viewers, up to 12 hours a day), on Oracle's Always Free tier, for **₹0 a month**.

## What it does

- **Merged, ordered feed.** Events from both platforms are held for 2 seconds and sorted by the platform's own timestamp, so a YouTube message and a Twitch message sent a second apart show up in the right order.
- **Paid events stand out:** Super Chats, memberships, subs, gifts, bits and raids show as highlighted cards.
- **Reply on both platforms** from one compose bar (Twitch threaded replies, YouTube `@mentions`).
- **Pin messages** to come back to later.
- **Built for a phone on a stand:** an installable web app, the screen stays awake, text size is adjustable, and timers update live.
- **Self-explaining problems:** when something breaks (a revoked login, a dropped connection), a small popup says what happened, with a one-tap fix where there is one.

## How it works

```
YouTube ──gRPC push stream──┐
                            ├──► hub: dedupe + 2 s reorder buffer ──► SSE ──► phone (SvelteKit PWA)
Twitch ───EventSub WebSocket┘                                         ▲
                                                     replies: Helix / YouTube Data API
```

| Layer | Choice | Why |
|---|---|---|
| App | SvelteKit (Svelte 5), Node 24 | One codebase for the UI and the server |
| YouTube chat | `liveChatMessages.streamList` over **gRPC**, falls back to polling | Push instead of polling: about 2 s lag and far less API quota |
| Twitch chat | EventSub WebSocket | Official, real-time, includes subs, bits and raids |
| To the phone | Server-Sent Events with `Last-Event-ID` replay | Survives flaky mobile networks with no missed messages |
| State | Oracle Object Storage via a pre-authenticated URL | No database to run; tokens and pins survive a VM rebuild |
| Hosting | Oracle Always Free VM, Caddy (auto HTTPS), DuckDNS | Zero cost |

More detail is in [ARCHITECTURE.md](ARCHITECTURE.md) and [PRODUCT.md](PRODUCT.md).

## Engineering highlights

- **Fully automated infrastructure, no SSH.** A GitHub Actions watchdog runs every 30 minutes. It creates the network and VM if they are missing, starts the VM if Oracle has stopped it, and reboots it if the app stops answering ([infra/ensure.sh](infra/ensure.sh)). Inbound SSH is closed; the VM sets itself up from a first-boot script ([infra/boot.sh](infra/boot.sh)).
- **Safe continuous deployment.** Every push is type-checked, tested and built in CI. Only passing commits reach the `deploy` branch. The VM builds each new version beside the running one, **never restarts during a live stream**, switches over atomically, and rolls back if the new version does not come up ([infra/update.sh](infra/update.sh)).
- **Staying inside free quotas.** YouTube gives 10,000 API units a day. Live detection costs 2 units, the push stream costs 5 units per connection, and daily usage is tracked across restarts.
- **Security:**
  - the dashboard sits behind a secret path that is checked against the matched route, which closes encoded-path bypasses;
  - OAuth `state` is single-use and bound to the browser by a cookie (RFC 9700);
  - only ports 80 and 443 are open;
  - root never runs code the app's own user can change;
  - in CI, the push token exists only in the release job.
- **Reviewed and tested:** unit tests cover ordering, deduplication, bad timestamps, OAuth state, event mapping, Twitch reconnect logic, and a state save that recovers after a failure.

## Run it locally

```bash
cd app
npm install
DEMO=1 ACCESS_SECRET=a-local-secret-of-24-chars npm run dev
# open http://localhost:5173/s/a-local-secret-of-24-chars/
```

`DEMO=1` feeds sample chat from both platforms, so no API keys are needed. Copy [.env.example](.env.example) to `app/.env` to connect real accounts.

```bash
npm test        # unit tests (Vitest)
npm run check   # type check (svelte-check)
```

## Repository layout

```
app/                     SvelteKit app
  src/lib/server/        hub, YouTube, Twitch, OAuth, state, quota
  src/routes/s/[secret]/ dashboard, SSE stream, replies, pins
  proto/                 YouTube streamList gRPC definition
infra/                   ensure.sh (watchdog), boot.sh (first boot), update.sh (deploys)
.github/workflows/       ci.yml (test, release), watchdog.yml (keep the VM alive)
```

## Author

Built by **Avanish Wankhede**.

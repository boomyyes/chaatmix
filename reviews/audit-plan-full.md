# Full Spectrum Audit: chaat-mix repo health

**Date**: 2026-11-27
**Mode**: Repo Health
**Source**: `main` at `8cd563b` (app, infra, workflows, docs)
**Lenses Run**: 10/10
**Lenses Skipped**: none. The Backend lens is written for Rust/Tauri; it was applied to the Node server (hub, YouTube, Twitch, OAuth, state), which is this project's backend.

Load assumed: one streamer, one phone (sometimes two), about 50 viewers, YouTube + Twitch live up to 12 h/day, one 1 GB Oracle VM.

---

## Master Verdict: APPROVE WITH CHANGES

The core is sound: a small, well-tested server, a secret-gated phone page, and self-healing infra with tested deploys and rollback. Three things can still take the streamer's chat away without anyone touching anything: the phone shows duplicate messages after a server restart (the keyed list can break), the bucket link (PAR) has an expiry date nobody tracks, and every VM rebuild changes the IP address, which caused a real outage on 2026-11-25. Each fix is small.

## Verdict by Lens

| # | Lens | Verdict | Critical | Recommendations |
|---|------|---------|----------|-----------------|
| 1 | Design Engineer | APPROVE WITH CHANGES | 0 | 3 |
| 2 | UX Engineer | APPROVE WITH CHANGES | 1 | 4 |
| 3 | Frontend Engineer | APPROVE WITH CHANGES | 1 | 3 |
| 4 | Backend Engineer (Node) | APPROVE WITH CHANGES | 1 | 4 |
| 5 | Structural Engineer | APPROVE | 0 | 2 |
| 6 | Repo Maintainer | APPROVE WITH CHANGES | 0 | 4 |
| 7 | Production Readiness | APPROVE WITH CHANGES | 2 | 4 |
| 8 | DX Engineer | APPROVE WITH CHANGES | 0 | 3 |
| 9 | Performance Engineer | APPROVE | 0 | 3 |
| 10 | Accessibility Engineer | APPROVE WITH CHANGES | 1 | 3 |

## All Critical Issues (Must Fix)

| # | Issue | Lens(es) | File(s) | Impact | Fix |
|---|-------|----------|---------|--------|-----|
| C1 | **Fixed.** Phone has no de-duplication. After a server restart (every update, reboot or crash) the hub's `seen` set is empty and YouTube's fresh `streamList` connection re-sends recent messages with new `seq` numbers. The open phone appends them again, so the same key appears twice in the keyed `{#each}`. | Frontend, Backend, UX | `app/src/routes/s/[secret]/+page.svelte` (`add`), `app/src/lib/server/hub.ts` | Messages are shown twice. Svelte reports a duplicate key, which throws in dev and can leave the list inconsistent. This happens after every deploy. | In `add()`: `if (messages.some((m) => key(m) === key(e))) return;` (cheap: last 500 items), or keep a `Set` of keys. |
| C2 | **Resolved 2026-11-27: the owner set the PAR to expire in 2090.** Original finding: the state bucket's PAR link has an expiry date set when it was created, and nothing tracks or checks it. When it expires, `load()` gets a 404/401: a 404 starts the app with empty state (tokens and pins silently gone), and any other code throws, so state never loads. | Production, Backend | `app/src/lib/server/state.ts`, `.env.example` | One day, with no warning, Twitch and YouTube logins vanish and pins reset. Certificate backup and restore also stop. | Record the PAR's expiry date in `PRODUCT.md`. Have the watchdog check `curl -I $STATE_PAR_URL/state.json`, which turns the run red (and emails you) before it lapses. Treat a 404 on an existing deployment as an error, not as "empty". |
| C3 | **Fixed (reserved IP).** Every VM rebuild gets a new public IP. DuckDNS follows within 5 minutes, but phones, routers and ISP resolvers keep the old IP cached, so the site looks dead. This happened on 2026-11-25. | Production, UX | `infra/ensure.sh` | After any automatic rebuild (Oracle reclaim, recreate), the streamer's phone can't reach the app for minutes to hours. | Use Oracle's free reserved public IP: create it once in `ensure.sh` and attach it at launch. The address then never changes. (Check the current free reserved-IP limit first.) |
| C4 | **Fixed.** The pins sheet is announced as a `dialog`, but focus doesn't move into it when it opens or return to the pins button when it closes. | Accessibility | `+page.svelte` (sheet) | Keyboard and screen-reader users open the sheet and stay on the feed behind it. The `inert` attribute is correct only for the closed state. | On open: focus the sheet's close button. On close: focus the pins button. Add `aria-modal="true"` and make the feed `inert` while the sheet is open. |
| C5 | **Fixed (3 s undo).** The ♡ thank-you button posts publicly with one tap, with no confirmation and no undo. It sits 44 px from the pin button. | UX | `+page.svelte` (`thank`) | A mis-tap while pinning sends "thank you ❤️" to the whole chat, and on YouTube it spends 20 units. | Send after a 3-second "Sending… Undo" state (cancel the timer on undo), or show the button only after a long press. |

## Cross-Cutting Concerns

| Concern | Flagged By | Root Cause | Unified Fix |
|---------|-----------|------------|-------------|
| Restarts are not invisible | Frontend, Backend, UX, Production | Hub state (`seen`, `seq`, ring) lives only in memory, and deploys now restart the app routinely | Phone-side de-dup (C1). Optionally start `seq` at `Date.now()` so a phone's Last-Event-ID never points past the new ring. |
| External dates nobody watches | Production, DX | PAR expiry, YouTube quota reset, and Google's unverified-app status are all time-based | One watchdog step that checks the PAR and prints quota use (it already reads `/health`). |
| Docs drifted from the code | Repo, DX, Structural | `ARCHITECTURE.md` still says polling is "Now" and that the VM "checks `main`" | Update the stack table and the infra section: gRPC streamList, the `deploy` branch, update.sh, `[deploy-now]`. |
| The page component holds everything | Structural, Frontend, Repo | `+page.svelte` is about 900 lines: feed, compose, sheet, popup, styles | Split out `PinsSheet.svelte` and `Compose.svelte` when the next feature lands, not before. |
| Pinned items lose emotes | UX, Design, Frontend | The pins route copies fields one by one and leaves out `parts` | Add `parts` to the copied fields in `pins/+server.ts`. |

## All Recommendations

| # | Recommendation | Lens | File(s) | Fix |
|---|---------------|------|---------|-----|
| R1 | Validate the pins POST body | Backend | `pins/+server.ts` | Reject unless `platform` is one of the two and `id`/`author`/`text` are strings under 2,000 chars. Today any JSON is stored, so `state.json` can grow without bound. |
| R2 | A bad JSON body on the reply route returns a 500 page instead of a 400 | Backend, DX | `reply/+server.ts` | `await request.json().catch(() => error(400, 'Bad request'))` |
| R3 | OAuth `pending` lives in memory | Backend | `oauth.ts` | A restart in the 10-minute login window gives "This login link expired". Acceptable; document it in the error text ("…or the app restarted"). |
| R4 | Watchdog email noise | Production | `infra/ensure.sh` | A quota-exhausted day turns every 30-minute run red (about 26 emails). Treat the quota error as a warning (exit 0) and keep exit 1 for real breakage. |
| R5 | A YouTube message that arrives more than 2 s late lands after newer Twitch ones | Backend, Performance | `hub.ts` | The measured push lag is about 2.1 s, right at `HOLD_MS`. Raise `HOLD_MS` to 3000, or accept it: the phone already re-sorts late items. |
| R6 | ARCHITECTURE.md is stale | Repo, DX | `ARCHITECTURE.md` | See the cross-cutting concerns. |
| R7 | Template leftovers | Repo | `app/src/lib/index.ts`, `app/.vscode/` | Delete them; nothing imports `index.ts`. |
| R8 | README dev command is bash-only | DX | `README.md` | Add the PowerShell form: `$env:DEMO=1; $env:ACCESS_SECRET='…'; npm run dev`. |
| R9 | Document `[deploy-now]` | DX | `README.md` / `ARCHITECTURE.md` | One line under "Safe continuous deployment". |
| R10 | Shadow colours are hard-coded `rgb()` values repeated in about 10 places | Design | `+page.svelte` | Add `--glow-accent`, `--glow-pop` and `--glow-warn` tokens next to the palette. |
| R11 | The paid "flash" animates `box-shadow` | Design, Performance | `+page.svelte` | Animate an `opacity` pseudo-element instead (GPU-friendly), or keep it: it's one card at a time. |
| R12 | Every message is a `<button>` | Accessibility, UX | `+page.svelte` | With 500 tab stops, a keyboard user can't get past the feed. Make the feed one tab stop with arrow-key roving focus, or move reply to a per-message button that appears on focus. |
| R13 | 1-second clock re-renders every age label | Performance | `+page.svelte` | Fine at 500 items. If the phone heats up, tick only labels under 60 s every second and the rest every 30 s. |
| R14 | `youtube.ts` holds two jobs (reading chat, plus Google login and replies) | Structural | `youtube.ts` | Split `google.ts` (OAuth + reply) when it next changes. |
| R15 | Sheet drag works only on the top bar | UX | `+page.svelte` | Expected. Add a one-time hint under the grabber, "Drag to resize". |
| R16 | No signal to the streamer that the app just updated | UX, Production | `update.sh` / page | Optional: a short "Updated" toast when the SSE reconnects to a new build (compare `version.json`). |

---

# Lens Reports

---

## 1. Design Engineer

**Verdict**: APPROVE WITH CHANGES

**Summary**: A single dark "mint chutney" retro theme scoped to `.screen`, with JetBrains Mono for labels, Atkinson Hyperlegible for chat, a magenta pop for paid events and amber for problems.

### Files Reviewed
| File | Visual Role | Risk |
|------|-------------|------|
| `app/src/routes/s/[secret]/+page.svelte` | Entire phone UI and styles | Medium |
| `app/src/routes/+page.svelte`, `privacy`, `terms` | Public pages | Low |

### Critical Issues
None.

### Recommendations
| # | Issue | File(s) | Why | Fix |
|---|-------|---------|-----|-----|
| 1 | Glow colours are repeated raw `rgb(...)` values | `+page.svelte` | Palette changes need edits in about 10 places | `--glow-*` tokens (R10) |
| 2 | Pinned Twitch messages lose their emotes | `pins/+server.ts` | Same message, two looks | Store `parts` |
| 3 | The flash animates `box-shadow` | `+page.svelte` | Not transform/opacity | Pseudo-element opacity (R11) |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | `font-variant-numeric: tabular-nums` on `.age` | Ticking seconds stop jiggling |
| 2 | Animated emotes: cap height at 28 px | Large animated emotes stretch line height |

### Design System Compliance
Tokens are defined once on `.screen` and used throughout. Hex values are used instead of oklch. That's fine for this repo, which has no globals.css or oklch convention. Border radius is 0 everywhere, so it's consistent. Light mode doesn't exist by design (a dark retro streaming screen), so dark-mode parity isn't applicable.

### Visual State Coverage
| Component/Element | Hover | Focus | Active | Disabled | Loading | Empty | Error | Dark Mode |
|-------------------|-------|-------|--------|----------|---------|-------|-------|-----------|
| Status chips | n/a | n/a | n/a | n/a | WAITING | n/a | ERROR/OFF amber | ✓ |
| Feed message | – (phone) | ✓ outline | – | n/a | n/a | waiting screen | n/a | ✓ |
| Paid card | – | ✓ | heart scale | thanked = filled | n/a | n/a | compose error | ✓ |
| Compose | – | ✓ | – | send disabled | "…" | n/a | `.reply-error` | ✓ |
| Pins sheet | – | ✓ | dragging | n/a | n/a | ✓ empty text | n/a | ✓ |
| Issue popup | – | ✓ | – | n/a | n/a | n/a | ✓ | ✓ |

### Verdict Details
- Design Token Fidelity: CONCERNS (repeated glow values)
- Visual State Coverage: PASS
- Dark Mode Parity: PASS (dark-only by design)
- Animation Quality: PASS (transform/opacity, at most 0.32 s, reduced motion covered; flash is the exception)
- Visual Consistency: CONCERNS (pinned emotes)

---

## 2. UX Engineer

**Verdict**: APPROVE WITH CHANGES

**Summary**: The streamer opens one link and sees both chats merged. They can pin, reply, thank, and fix connections from a popup.

### User Journey Map
1. Opens link or home-screen icon → waiting screen with each platform's status. **OK**
2. Goes live → chips turn LIVE and chat flows in, with auto-scroll and a "N NEW ↓" pill when scrolled up. **OK**
3. Paid event → magenta card that flashes and is announced to screen readers. **OK**
4. Taps a message → compose bar opens with "@author" prefilled (YouTube). **OK**
5. Taps ♡ → posts at once, with no undo. **WARN** (C5)
6. Pins a message → the counter updates; the sheet slides, drags and closes with ✕ or Esc. **OK**
7. Login revoked or quota out → amber popup with a reason and RECONNECT where it applies. **OK**
8. App updates or restarts during a stream → feed shows duplicates (C1). **FAIL**
9. VM rebuilt → site unreachable until DNS caches clear (C3). **FAIL**

### Critical Issues
| # | Issue | Step | Impact on User | Fix |
|---|-------|------|----------------|-----|
| 1 | One-tap public thanks with no undo | 5 | Accidental public message | 3-second undo (C5) |

### Recommendations
| # | Issue | Impact | Fix |
|---|-------|--------|-----|
| 1 | Duplicates after restart | Confusing feed | C1 |
| 2 | No hint that the sheet can be dragged | Feature stays hidden | R15 |
| 3 | YouTube quota popup offers no action | Streamer doesn't know if they should do something | Add "Nothing to do. Chat resumes at 13:30 IST" (local time) |
| 4 | Reply cap reached is shown only after typing | Wasted effort | Show "75/75 replies used" in the compose header when the cap is reached |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Undo for "CLEAR ALL" pins instead of `confirm()` | `confirm()` is jarring on phones |

### Interaction Consistency Check
Tap-to-reply works on both messages and paid cards. The pin and thanks icons are consistent. The sheet now follows the platform bottom-sheet pattern. Tapping outside doesn't close the sheet, as the user asked; Esc and ✕ do.

### Verdict Details
- Discoverability: CONCERNS (drag, tap-to-reply have no hint)
- Flow Completeness: PASS
- Error Recovery: CONCERNS (C5)
- Feedback & Status: PASS
- Consistency: PASS

---

## 3. Frontend Engineer

**Verdict**: APPROVE WITH CHANGES

**Summary**: SvelteKit 3 with Svelte 5 runes (not React/Zustand; the lens was applied to Svelte equivalents). One page component holds `$state` for messages, statuses and pins, with a single EventSource.

### Files Reviewed
| File | Frontend Role | Risk |
|------|--------------|------|
| `s/[secret]/+page.svelte` | All UI state and rendering | Medium |
| `s/[secret]/+page.server.ts` | Initial pins and reply-login flag | Low |
| `lib/types.ts` | Shared event types | Low |

### Critical Issues
| # | Issue | File(s) | Why It Breaks | Code Fix |
|---|-------|---------|---------------|----------|
| 1 | Keyed `{#each messages as e (key(e))}` with no de-dup in `add()` | `+page.svelte` | Re-sent events after a server restart create duplicate keys | `if (messages.some((m) => key(m) === key(e))) return;` at the top of `add` |

### Recommendations
| # | Issue | File(s) | Why | Fix |
|---|-------|---------|-----|-----|
| 1 | `thanked = new Set(thanked)` reassign pattern | `+page.svelte` | Verbose | `SvelteSet` from `svelte/reactivity` |
| 2 | The EventSource reconnect doesn't clear `newCount` or the status cache when the server changes | `+page.svelte` | Stale UI after a deploy | Reset on `onopen` if `version.json` changed (R16) |
| 3 | `res.json()` on a failed thanks may not be JSON (a proxy error page) | `+page.svelte` | Already caught with `.catch`, so fine | Keep |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Split `PinsSheet.svelte` | 900-line component |

### Render Path Analysis
Triggers are SSE `chat` (push to `messages`; trimmed at 500; sorted only when an event arrives out of order), SSE `status`, the 1 s `now` tick, and pin responses. The `now` tick re-evaluates `age()` for every rendered row. Svelte's fine-grained updates touch only text nodes, so the cost is small. `pinned` is `$derived` from `pins`, and `paidCard` re-evaluates `pinned.has` per card. No unnecessary component remounts, because keys are stable (apart from C1).

### Type Safety Assessment
`ChatEvent` is shared between server and client, and `svelte-check` passes with 0 errors and 0 warnings. Twitch and YouTube payloads are typed `any` at the mapping boundary (`toChatEvent`), so a renamed field in either API would show as `undefined` text, not a crash. That's acceptable for external API data at this scale.

### Verdict Details
- Component Architecture: CONCERNS (one large component)
- State Management: PASS
- Type Safety: PASS
- Rendering Performance: PASS
- Bundle Impact: PASS (no client dependencies beyond Svelte)

---

## 4. Backend Engineer (applied to Node)

**Verdict**: APPROVE WITH CHANGES

**Summary**: A long-running Node process: Twitch EventSub WebSocket, YouTube gRPC push stream with polling fallback, an in-memory hub with SSE to the phone, and state written through to an Oracle bucket.

### Files Reviewed
| File | Backend Role | Risk |
|------|-------------|------|
| `lib/server/hub.ts` | Merge, dedupe, ring, SSE fan-out | Medium |
| `lib/server/youtube.ts` | Live detection, push stream, replies, pacing | Medium |
| `lib/server/twitch.ts` | EventSub, Helix, token refresh | Medium |
| `lib/server/state.ts` | Bucket + file persistence | High |
| `lib/server/quota.ts` | Unit accounting, reply cap | Low |
| `lib/server/oauth.ts` | State/nonce, constant-time compare | Low |
| `routes/**/+server.ts` | HTTP surface | Low |

### Critical Issues
| # | Issue | File(s) | Failure Mode | Code Fix |
|---|-------|---------|-------------|----------|
| 1 | PAR expiry is invisible, and a 404 means "fresh install" | `state.ts` | An expired link wipes tokens and pins without warning | C2: watchdog check, and on 404 fall back to the local file (it's already read) before assuming empty |

### Recommendations
| # | Issue | File(s) | Why | Fix |
|---|-------|---------|-----|-----|
| 1 | Pins body unvalidated | `pins/+server.ts` | Unbounded state growth | R1 |
| 2 | Bad JSON gives a 500 | `reply/+server.ts`, `pins/+server.ts` | Unclear error | R2 |
| 3 | Quota count saved only every 5 minutes | `quota.ts` | A crash forgets up to 5 minutes of spend, so pacing runs slightly ahead | Acceptable: pacing re-derives from the remaining budget |
| 4 | `HOLD_MS` = 2000 vs measured 2.1 s YouTube lag | `hub.ts` | Edge-case ordering | R5 |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Seed `seq` from `Date.now()` | Last-Event-ID stays meaningful across restarts |

### Error Path Analysis
- **Twitch:** socket close → `shouldRestart` → `start()` after 5 s. A revocation message → `needsReconnect` → popup. A Helix 401 → a single refresh, then reconnect popup. Clean.
- **YouTube:** quota error → status "limit used up" and a 10-minute retry. A refused push stream → polling fallback. Other errors → 30 s retry, with pacing to protect the budget. Errors are logged with `console.error` (journald). Clean.
- **State:** a bucket read error throws, so the app never starts empty after an outage. Good. A bucket write error is caught per save, so later saves still run; the error reaches the caller (pins route → 500). A failed pin shows nothing on the phone (`togglePin` ignores `!res.ok`). Minor.
- **Replies:** errors are returned as JSON `{error}` and shown in the compose bar. Clean.

### Resource Lifecycle Audit
| Resource | Allocated In | Cleaned Up In | Error Path Cleanup | Risk |
|----------|-------------|---------------|-------------------|------|
| Twitch WebSocket | `twitch.open` | `onclose` / previous `.close()` | ✓ `shouldRestart` | Low |
| gRPC stream call | `streamChat` | `cancel` on offline / end | ✓ promise rejects | Low |
| SSE stream + ping timer | `events/+server.ts` | `cancel` / enqueue failure | ✓ | Low |
| `seen` set | `hub.publish` | capped at 5,000 | n/a | Low |
| OAuth `pending` map | `issueState` | swept on issue, deleted on use | ✓ | Low |
| `/run/chaat-update.lock` | `update.sh` | fd closes on exit | ✓ | Low |

### Verdict Details
- Error Handling: PASS
- Concurrency Safety: PASS (save chain serialized; single process)
- Resource Management: PASS
- IPC Correctness: PASS (SSE format; types shared)
- File System Safety: PASS (temp file + rename)

---

## 5. Structural Engineer

**Verdict**: APPROVE

**Summary**: Layers are routes → `lib/server/*` → external APIs, with `lib/types.ts` shared with the client. Infra is separate (`infra/*.sh` + workflows).

### Files Reviewed
| File | Structural Role | Layer | Risk |
|------|----------------|-------|------|
| `hooks.server.ts` | Boot + access gate | Edge | Low |
| `lib/server/hub.ts` | Event bus | Core | Low |
| `lib/server/state.ts` | Persistence | Core | Low |
| `lib/server/youtube.ts` / `twitch.ts` | Source adapters | Adapters | Medium |
| `infra/ensure.sh`, `boot.sh`, `update.sh` | Ops | Infra | Medium |

### Critical Issues
None.

### Recommendations
| # | Issue | Why | Fix |
|---|-------|-----|-----|
| 1 | `youtube.ts` mixes chat ingestion with Google OAuth and replies | Two reasons to change | Split later (R14) |
| 2 | `quota.ts` loads state at import time (side effect) | Import order matters in tests | Acceptable; tests skip the bucket via `VITEST` |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Split `+page.svelte` | Cohesion |

### Dependency Map
```
phone (+page.svelte) ──SSE/fetch──► routes/s/[secret]/{events,pins,reply,connect}
                                         │
hooks.server.ts ──start──► twitch.ts ─┐  ▼
                          youtube.ts ─┼► hub.ts (publish/flush/subscribe)
                                      │
            quota.ts ◄── youtube.ts   └► state.ts ◄── pins, oauth tokens, quota
                                             │
                                      Oracle bucket (PAR) + local file
infra: watchdog.yml → ensure.sh → (VM) boot.sh → cron → update.sh (deploy branch)
```
No cycles. Adapters depend on the hub and state, never the reverse.

### Boundary Crossing Analysis
| Crossing | From -> To | Clean? | Notes |
|----------|-----------|--------|-------|
| Client ↔ server | page → routes | ✓ | JSON + SSE, shared `ChatEvent` type |
| Server ↔ YouTube | youtube.ts → REST/gRPC | ✓ | All calls go through `yt()`/`spend()` |
| Server ↔ Twitch | twitch.ts → Helix/EventSub | ✓ | Through `helix()` |
| App ↔ storage | state.ts → PAR | ✓ | Single module |
| CI ↔ VM | ci.yml → `deploy` branch ← update.sh | ✓ | Git is the only contract |

### Verdict Details
- Dependency Direction: PASS
- Module Coupling: PASS
- Cohesion: CONCERNS (youtube.ts, page)
- Layer Boundaries: PASS
- Change Propagation: PASS

---

## 6. Repo Maintainer

**Verdict**: APPROVE WITH CHANGES

**Summary**: Small, readable repo. Conventions: `#lib/...ts` imports, tabs, a one-line "why" comment on each non-obvious line, and commits in the owner's name.

### Files Reviewed
| File | Convention Status | Risk |
|------|------------------|------|
| `app/src/lib/index.ts` | Template leftover | Low |
| `app/.vscode/extensions.json` | Template leftover | Low |
| `ARCHITECTURE.md` | Stale | Medium |
| `reviews/audit-plan-full.md` | This file (replaces the plan audit) | Low |
| `app/src/lib/server/server.test.ts` | All tests in one file | Low |

### Critical Issues
None.

### Recommendations
| # | Issue | Why | Fix |
|---|-------|-----|-----|
| 1 | Stale ARCHITECTURE.md | Misleads readers and reviewers | R6 |
| 2 | Template leftovers | Noise | R7 |
| 3 | Imports mix `./quota` (in tests) and `#lib/server/quota.ts` | Two styles | Use `#lib/...ts` everywhere |
| 4 | `console.error` / `console.warn` | No structured logger | Fine for journald on one VM; keep |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | CI badge in README | Shows tests pass |

### Convention Compliance Checklist
| Convention | Status | Notes |
|-----------|--------|-------|
| File placement | ✓ | SvelteKit routes + `lib/server` |
| Naming conventions | ✓ | |
| Barrel exports | n/a | Template `index.ts` unused |
| Import ordering | ✓ | |
| Type imports separated | ✓ | `import type` used |
| Path aliases used | ~ | Tests use relative imports |
| No dead code left | ~ | Template leftovers |
| Structured logging | ✗ | `console.*` (acceptable here) |
| No lint suppressions | ~ | One justified `svelte-ignore` with its reason |
| CLAUDE.md present | ✗ | Not needed for this repo's size |

### Reuse Opportunities
`paceMs()` is now shared by streaming and polling. Twitch and YouTube reply share one route. No duplication found.

### Verdict Details
- File Organization: PASS
- Naming Consistency: PASS
- Import Hygiene: CONCERNS (minor)
- Code Reuse: PASS
- Lint Compliance: PASS

---

## 7. Production Readiness

**Verdict**: APPROVE WITH CHANGES

**Summary**: One Oracle Always Free VM, self-provisioned. A watchdog runs every 30 minutes. CI-gated `deploy` branch, build-then-switch with rollback, no restart while live (unless `[deploy-now]`), bucket-backed state and certificates.

### Files Reviewed
| File | Production Role | Risk |
|------|----------------|------|
| `infra/ensure.sh` | Create, start, reboot | Medium |
| `infra/boot.sh` | First boot | Medium |
| `infra/update.sh` | Deploys + rollback | Medium |
| `.github/workflows/watchdog.yml`, `ci.yml` | Automation | Low |
| `lib/server/state.ts` | Persistence | High |

### Critical Issues
| # | Issue | File(s) | Production Failure Mode | Fix |
|---|-------|---------|------------------------|-----|
| 1 | PAR expiry untracked | `state.ts`, watchdog | Tokens, pins and certificate backup lost on the expiry day | C2 |
| 2 | Public IP changes on rebuild | `ensure.sh` | Hours of "site down" from DNS caching (seen 2026-11-25) | Reserved IP (C3) |

### Recommendations
| # | Issue | Why | Fix |
|---|-------|-----|-----|
| 1 | Quota days spam watchdog failures | Alert fatigue hides real failures | R4 |
| 2 | App logs live only in journald on a VM without SSH | Can't debug app crashes | Upload `journalctl -u chaat-mix -n 300` to the bucket from `update.sh` and on watchdog failure |
| 3 | `update.log` grows without limit locally | Disk slowly fills over months | `logrotate` rule, or truncate to 1,000 lines in `update.sh` |
| 4 | Let's Encrypt rate limit on repeated recreates | 5 duplicate certificates per 7 days | Already mitigated by the certificate backup; don't recreate more than about 4 times a week |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Watchdog prints the YouTube quota every run | Early warning |

### Failure Mode Analysis
| Scenario | What Fails | User Impact | Recovery | Handled? |
|----------|-----------|-------------|----------|----------|
| Oracle stops idle VM | Whole app | Down ≤30 min | Watchdog START | ✓ |
| Oracle reclaims VM | Whole app | Down ~30 min + DNS cache | Watchdog relaunch | ~ (C3) |
| App crashes | App | ~3 s | systemd restart | ✓ (phone dupes C1) |
| Bad commit | Deploy | none | CI blocks; rollback on health fail | ✓ |
| Build fails (npm down) | Deploy | none | Retry every 5 min | ✓ |
| YouTube quota exhausted | YouTube chat | Until 13:30 IST | Pacing prevents it; popup explains | ✓ |
| Twitch token revoked | Twitch chat | Until reconnect | Popup + RECONNECT | ✓ |
| Bucket outage at boot | State load | App can't load state | Throws, retried | ✓ |
| PAR expires | State | Silent data loss | none | ✗ (C2) |
| GitHub disables schedules | Watchdog | No self-heal | Monthly heartbeat commit | ✓ |
| Disk full from logs | VM | Builds fail | none | ~ (R3) |

### Environment Checklist
| Concern | Dev | Prod | Gap? |
|---------|-----|------|------|
| File paths | `state.json` in app | `/var/lib/chaat-mix/state.json` | No |
| Network | localhost:5173 | Caddy :443 → 127.0.0.1:3000 | No |
| Permissions | user | `chaat` user; root-owned source and releases | No |
| Config | `app/.env` | `/etc/chaat-mix.env` (600) from Actions secrets | No |
| Build output | vite dev | `node build` from `/opt/chaat-mix-current` | No |

### Verdict Details
- E2E Flow: PASS
- Error Recovery: PASS
- Data Integrity: CONCERNS (C2)
- Environment Parity: PASS
- Observability: CONCERNS (app logs not reachable)

---

## 8. DX Engineer

**Verdict**: APPROVE WITH CHANGES

**Summary**: Developers are the repo owner and reviewers. There are three paths: run locally (demo), change and push (CI → VM), and operate (watchdog, logs).

### Files Reviewed
| File | DX Role | Risk |
|------|---------|------|
| `README.md` | Onboarding | Low |
| `.env.example` | Config docs | Low |
| `infra/*.sh` | Ops messages | Low |

### Critical Issues
None.

### Recommendations
| # | Issue | Why | Fix |
|---|-------|-----|-----|
| 1 | Bash-only dev command on a Windows-first setup | The first run fails in PowerShell | R8 |
| 2 | `[deploy-now]` not documented | Hidden power path | R9 |
| 3 | No way to see app logs | Debugging needs SSH, which is closed | Upload the journal (Production R2) |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | `npm run demo` script | One command, cross-platform |

### Error Message Audit
| Error Scenario | Current Message | What Developer Needs | Suggested Message |
|---------------|----------------|---------------------|-------------------|
| Missing secret | "ACCESS_SECRET must be set (24+ random characters)." | ✓ | keep |
| Bad watchdog key | Describes the paste shape without printing it | ✓ | keep |
| Missing app var on launch | "Missing secret: X" | ✓ | keep |
| OAuth state lost on restart | "This login link expired. Open chaat-mix and try again." | Why | "…expired or the app restarted. Open chaat-mix and tap Reconnect again." |
| Reply bad JSON | 500 HTML | 400 with reason | "Bad request." |
| ensure.sh failure | "ensure.sh failed (exit N) at line L: cmd" | ✓ | keep |

### Developer Journey
- **First use:** clone → README → `DEMO=1` run (bash) → demo feed. Friction: PowerShell syntax.
- **Daily use:** push → CI → auto-deploy after the stream. Visible in Actions and `update.log`.
- **Power use:** `[deploy-now]`, watchdog "recreate". Friction: app logs are unreachable.

### Verdict Details
- Error Quality: PASS
- Defaults & Config: PASS
- Keyboard Experience: n/a
- Discoverability: CONCERNS (deploy-now, logs)
- Workflow Integration: PASS

---

## 9. Performance Engineer

**Verdict**: APPROVE

**Summary**: Long sessions run on both sides: a phone open for 12 hours, and a 1 GB VM running continuously.

### Files Reviewed
| File | Performance Role | Risk |
|------|-----------------|------|
| `+page.svelte` | Phone render loop | Low |
| `hub.ts` | Server hot path | Low |
| `youtube.ts` | Quota pacing | Low |
| `update.sh` | Build on a 1 GB VM | Medium |

### Critical Issues
None.

### Recommendations
| # | Issue | File(s) | Why | Fix |
|---|-------|---------|-----|-----|
| 1 | 1 s tick over all rows | `+page.svelte` | Small battery cost over 12 h | R13 (only if needed) |
| 2 | `flush` filters `pending` twice every 250 ms | `hub.ts` | Trivial at this volume | keep |
| 3 | A build during a live stream (with `[deploy-now]`) competes for 1 GB RAM | `update.sh` | Chat may lag during the build | Use `nice -n 10` for npm ci and the build |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Pause the scanlines overlay | Full-screen gradient layer; negligible on modern phones |

### Resource Budget
| Resource | Current | Concern? |
|----------|---------|----------|
| Phone memory | ≤500 messages + ≤200 replay | No (bounded) |
| Server memory | ring 200, `seen` 5,000, pending ≤2 s | No (bounded) |
| Timers | 1 s clock, 250 ms flush, 25 s SSE ping each | No (cleared on close) |
| YouTube units | Paced to (10,000 − 1,500 reserve) over 12 h | No (fixed `47b3a7a`) |
| Bucket writes | Pins + quota at most every 5 minutes | No |
| Startup | Bucket read + 2 API calls | No |

### Hot Path Analysis
Per chat message: `publish` (set lookup, push) → `flush` (filter, sort a handful) → SSE enqueue per phone → phone `push`, maybe sort, `trim` (O(n) findIndex) → one DOM row with a CSS entry animation. All O(n) with n ≤ 500. Fine.

### Verdict Details
- Memory Management: PASS
- IPC Efficiency: PASS
- I/O Patterns: PASS
- Startup Impact: PASS
- Long-Session Stability: PASS

---

## 10. Accessibility Engineer

**Verdict**: APPROVE WITH CHANGES

**Summary**: A phone UI with a `role="log"` feed, a polite live region for paid events and problems, icon buttons with labels, and a dialog sheet.

### Files Reviewed
| File | A11y Role | Risk |
|------|----------|------|
| `+page.svelte` | All interactive UI | Medium |

### Critical Issues
| # | Issue | WCAG Criterion | File(s) | Impact | Fix |
|---|-------|---------------|---------|--------|-----|
| 1 | Sheet dialog has no focus management | 2.4.3 Focus Order | `+page.svelte` | Keyboard and screen-reader users are lost behind the sheet | C4 |

### Recommendations
| # | Issue | WCAG Criterion | Fix |
|---|-------|---------------|-----|
| 1 | Every message is a tab stop | 2.1.1 / 2.4.1 | Roving focus (R12) |
| 2 | Drag is the only way to expand the sheet | 2.5.7 Dragging Movements | Add an expand/collapse button next to ✕ |
| 3 | The "thanked" state is shown only by a red fill | 1.4.1 Use of Color | `aria-pressed` is set ✓. Also change the label to "Thanked {author}". |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Announce "Thank-you sent" in the live region | Confirmation for screen readers |

### Keyboard Navigation Walkthrough
| Step | Action | Expected Focus | Expected Announcement | Handled? |
|------|--------|---------------|----------------------|----------|
| 1 | Tab from top | Aa button | "Text size, button" | ✓ |
| 2 | Tab | Pins button | "Pinned messages, 1, collapsed" | ✓ |
| 3 | Enter | Sheet close button | "Pinned messages, dialog" | ✗ stays on the button (C4) |
| 4 | Esc | Pins button | "expanded false" | ~ closes, focus not restored |
| 5 | Tab into feed | First message | "Reply to X: text, button" | ✓ but 500 stops (R12) |
| 6 | Enter on message | Compose input (autofocus) | "Reply message, edit" | ✓ |
| 7 | Tab | SEND | "SEND, button" | ✓ |

### ARIA Checklist
| Element | Role | Label | States | Keyboard | Notes |
|---------|------|-------|--------|----------|-------|
| Feed | log | "Chat" | aria-live off | scroll | ✓ (polite region announces paid) |
| Message | button | "Reply to {a}: {t}" | – | Enter | ✓ |
| Emote | img | alt = emote name | – | – | ✓ |
| Pin | button | "Pin/Unpin message from {a}" | aria-pressed | Enter | ✓ |
| Thank | button | "Thank {a}" | aria-pressed, disabled | Enter | ✓ |
| Pins button | button | "Pinned messages, N" | aria-expanded | Enter | ✓ |
| Sheet | dialog | "Pinned messages" | inert when closed | Esc | ✗ focus (C4) |
| Popup | status | – | – | RECONNECT link | ✓ |

Contrast (measured): text `#b8ffb0` on `#020a04` ≈ 17:1; muted `#5e9e66` ≈ 6.2:1; pop `#ff2bd6` on `#1f0619` ≈ 6:1; warn on warn-bg passes. All meet AA.

### Verdict Details
- Screen Reader Compatibility: PASS
- Keyboard Navigation: CONCERNS (R12)
- Focus Management: CONCERNS (C4)
- Color Contrast: PASS
- Motion Sensitivity: PASS (all animations off under reduced motion)

# Full Spectrum Audit: chaat-mix product plan

**Date**: 2026-11-24
**Mode**: Plan
**Source**: `PRODUCT.md` (plus the architecture agreed in conversation: Oracle Always Free VM, Terraform + cloud-init, GitHub Actions watchdog, DuckDNS + Caddy, YouTube `streamList` with API key, Twitch EventSub, SvelteKit phone page)
**Lenses Run**: 7/10
**Lenses Skipped**: Design Engineer (no visual design exists yet), Frontend Engineer (no Svelte code yet), Backend Engineer (lens targets Rust/Tauri; not this stack)

---

## Master Verdict: APPROVE WITH CHANGES

The plan is sound for one streamer at near-zero load, and the core risks (quota, cost, auth) were checked against live docs and a real API call. Three issues would break the promise "the streamer does nothing" in practice: the watchdog can rebuild-loop itself into a week-long HTTPS outage, the home-screen app on iOS can lose its access secret, and a dead platform connection is invisible to the streamer. All three are cheap to fix in the plan before code exists.

## Verdict by Lens

| # | Lens | Verdict | Critical | Recommendations |
|---|------|---------|----------|-----------------|
| 1 | Design Engineer | Skipped | – | – |
| 2 | UX Engineer | APPROVE WITH CHANGES | 2 | 4 |
| 3 | Frontend Engineer | Skipped | – | – |
| 4 | Backend Engineer | Skipped | – | – |
| 5 | Structural Engineer | APPROVE WITH CHANGES | 0 | 3 |
| 6 | Repo Maintainer | APPROVE WITH CHANGES | 1 | 2 |
| 7 | Production Readiness | APPROVE WITH CHANGES | 2 | 4 |
| 8 | DX Engineer | APPROVE WITH CHANGES | 0 | 3 |
| 9 | Performance Engineer | APPROVE WITH CHANGES | 1 | 2 |
| 10 | Accessibility Engineer | APPROVE WITH CHANGES | 1 | 3 |

## All Critical Issues (Must Fix)

| # | Issue | Lens(es) | File(s) | Impact | Fix |
|---|-------|----------|---------|--------|-----|
| C1 | Watchdog rebuilds the VM whenever `/health` fails, even when the VM is fine and only DNS/HTTPS/app is broken | Prod Readiness | infra (planned watchdog) | Each rebuild requests a new Let's Encrypt certificate; Let's Encrypt allows 5 duplicate certificates per week, so a loop leaves the site without HTTPS for days | Rebuild only when the OCI API says the instance is missing/terminated; start it if stopped; for a running-but-unhealthy VM, restart the app service. Back up Caddy's certificate folder to the bucket |
| C2 | A dead platform connection is invisible | UX, Prod Readiness, DX | PRODUCT.md (Capabilities) | If the Twitch token is revoked or YouTube quota runs out, the feed silently shows only one platform; the streamer misses messages, breaking principle 2 | Per-platform status in the feed header (live / offline / not connected / error) and in `/health`; watchdog fails the job (GitHub emails the developer) when a source is in error |
| C3 | iOS home-screen web apps don't share cookies with Safari | UX | PRODUCT.md (Private access) | Streamer opens the secret link in Safari, adds to home screen, opens the icon: no cookie, access denied | Keep the secret in the path (`/s/<secret>/`) and make the manifest `start_url` relative, so the installed icon carries it |
| C4 | Public repo with no `.gitignore` yet | Repo Maintainer | repo root | First commit could publish `.env`, `*.tfvars`, Terraform state or the OCI API key | Add `.gitignore` (`.env*`, `*.tfvars`, `*.tfstate*`, `.terraform/`, `*.pem`) before the first commit |
| C5 | Feed grows unbounded over a 12-hour stream | Performance | phone page (planned) | Thousands of DOM nodes on a phone: scroll jank, battery drain, possible tab reload by the OS (which loses scroll position) | Keep the last ~500 messages in the DOM; pinned and paid events are kept separately so they never drop off |
| C6 | Platform and paid status shown by colour alone | Accessibility | phone page (planned) | Colour-blind readers can't tell YouTube from Twitch or spot a Super Chat at a glance (WCAG 1.4.1) | Platform icon/label on every message; paid events carry a text label and amount ("Super Chat ₹200", "100 bits") |

## Cross-Cutting Concerns

| Concern | Flagged By | Root Cause | Unified Fix |
|---------|-----------|------------|-------------|
| Silent failure | UX, Prod Readiness, DX | "Recover silently" was written as "show nothing"; but some failures need a human (revoked token, quota) | Recover silently when the system can; when it can't, show a status to the streamer and alert the developer. One status model feeds the header, `/health` and the watchdog |
| What survives a rebuild | Structural, Prod Readiness | State lives in two places (VM disk, bucket) with no rule for which wins | Bucket is the source of truth; write-through on every change (token refresh, pin, Caddy certs); VM disk is cache only |
| Secrets in a public repo | Repo Maintainer, DX | Public repo chosen for free unlimited Actions minutes | `.gitignore` first, `.env.example` listing every secret by name, all values in Actions secrets |

## All Recommendations

| # | Recommendation | Lens | File(s) | Fix |
|---|---------------|------|---------|-----|
| R1 | Reading older messages while new ones arrive | UX | phone page | Auto-scroll only when at the bottom; otherwise show "N new ↓" and stop moving |
| R2 | Not-streaming state undefined | UX | phone page | Show "Waiting for YouTube / Twitch to go live" per platform instead of a blank feed |
| R3 | Pins can't be removed | UX | PRODUCT.md | Unpin on the same control; "Clear all pins" behind a specific confirmation ("Clear 7 pins?") |
| R4 | Reconnect prompt for Twitch | UX, DX | phone page | When the token is invalid, the header shows a single "Reconnect Twitch" button, nothing else |
| R5 | Two servers implied (Node + SvelteKit) | Structural | PRODUCT.md (Stack) | One process: SvelteKit with `adapter-node`; ingestion starts in `hooks.server` |
| R6 | No shared event shape | Structural | PRODUCT.md | Define one type: `{id, platform, kind, author, text, amount?, currency?, ts}` used by ingestion, storage and UI |
| R7 | Bucket write rule undefined | Structural | PRODUCT.md | Write-through on change; restore on boot; VM disk never authoritative |
| R8 | Vendored skill folders (`.agent/`, `.opencode/`, `.claude/skills/`) | Repo Maintainer | repo root | Decide before first commit whether they go into the public repo |
| R9 | No README / SETUP | Repo Maintainer, DX | repo root | `SETUP.md`: the developer's one-time account steps in order |
| R10 | Handle Twitch `session_reconnect` and YouTube stream end | Prod Readiness | ingestion | Follow Twitch's reconnect URL without dropping subscriptions; on YouTube chat end, return to live-detection |
| R11 | Logs vanish on rebuild | Prod Readiness | infra | Accept it (journald) but log each reconnect/quota event so `/health` can show last error |
| R12 | Quota running out mid-stream | Prod Readiness | ingestion | Track units used today; show it in `/health`; back off reconnects before hitting 10,000 |
| R13 | Secret inventory undefined | DX | `.env.example` | List: OCI keys, DuckDNS token, Twitch client id/secret, YouTube key, YouTube channel id, access secret |
| R14 | No way to develop without a live stream | DX | app | Record real events to a JSON file once; `npm run dev` replays them |
| R15 | Reconnect replay buffer | Performance | server | Keep the last ~200 events in memory for phones reconnecting; drop older |
| R16 | Screen-reader flooding | Accessibility | phone page | Feed is `role="log"` with `aria-live="off"`; announce only paid events via a separate polite region |
| R17 | Touch targets and text size | Accessibility | phone page | Pin control ≥ 44px; a text-size setting stored locally for arm's-length reading |
| R18 | Motion | Accessibility | phone page | New-message and paid-event animations off under `prefers-reduced-motion` |

---

# Lens Reports

---

## 1. Design Engineer

**Skipped**: no visual design, tokens or components exist yet. Run after `/impeccable shape`.

---

## 2. UX Engineer

**Verdict**: APPROVE WITH CHANGES

### Plan Summary
The streamer opens one link on their phone, connects Twitch once, and from then on reads a single merged feed and can pin messages.

### User Journey Map
| Step | Trigger → Action → Feedback → Outcome | Status |
|------|---------------------------------------|--------|
| 1 | Developer sends secret link → streamer opens it on phone → page loads | OK |
| 2 | Page shows Connect Twitch → streamer taps, approves on Twitch → returns to feed, Twitch shows connected | WARN: return state and "connected" feedback not specified |
| 3 | Streamer adds to home screen → opens icon | FAIL on iOS: secret cookie not shared with installed app (C3) |
| 4 | Streamer not live → opens app | FAIL: empty state undefined (R2) |
| 5 | Streams go live → messages appear in time order | OK |
| 6 | Streamer scrolls up to reread → new messages arrive | WARN: scroll behaviour undefined (R1) |
| 7 | Super Chat / sub arrives → stands out | WARN: "impossible to overlook" stated, mechanism not yet designed |
| 8 | Streamer pins a message → finds it later | WARN: no unpin, no pin list location (R3) |
| 9 | Twitch token revoked / quota out → one platform stops | FAIL: no status shown (C2) |
| 10 | Phone loses network → returns | OK: silent reconnect specified |

### Critical Issues (Must Fix)
| # | Issue | Step in Journey | Impact on User | Fix |
|---|-------|----------------|----------------|-----|
| 1 | Dead platform invisible | 9 | Misses all messages from one platform without knowing | Per-platform status in header (C2) |
| 2 | iOS installed app loses secret | 3 | Locked out of their own app | Secret in path + relative `start_url` (C3) |

### Recommendations
| # | Issue | Impact | Fix |
|---|-------|--------|-----|
| 1 | Scroll fights reading | Loses their place mid-read | R1 |
| 2 | Blank screen when offline | Thinks app is broken | R2 |
| 3 | Pins only grow | Pin list becomes useless | R3 |
| 4 | Reconnect path | Doesn't know what to tap | R4 |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Tap a paid event to mark it "read aloud" | Matches the real job: thanking supporters on stream |
| 2 | Show age ("2m") instead of clock time | Faster to judge at a glance |

### Interaction Consistency Check
No existing app to be consistent with. Follow platform-chat conventions the streamer already knows: newest at the bottom, auto-scroll pinned to bottom, "new messages" pill.

### Verdict Details
- Discoverability: PASS (one screen, one action)
- Flow Completeness: CONCERNS (empty state, unpin)
- Error Recovery: CONCERNS (revoked token, quota)
- Feedback & Status: CONCERNS (no connection status)
- Consistency: PASS

---

## 3. Frontend Engineer

**Skipped**: no Svelte code yet.

---

## 4. Backend Engineer

**Skipped**: lens is written for Rust/Tauri; server here is Node. Backend concerns are covered under Production Readiness and Structural.

---

## 5. Structural Engineer

**Verdict**: APPROVE WITH CHANGES

### Plan Summary
Three runtime parts (ingestion, phone page, storage) plus an out-of-band operator (GitHub Actions watchdog).

### Files Reviewed
| File | Structural Role | Layer | Risk |
|------|----------------|-------|------|
| PRODUCT.md | Product contract | Spec | Low |

### Critical Issues (Must Fix)
None.

### Recommendations
| # | Issue | Why | Fix |
|---|-------|-----|-----|
| 1 | "Node server" and "SvelteKit" read as two servers | Two processes to deploy, restart and health-check for one user | R5 |
| 2 | No shared event type | Each platform adapter and the UI will invent their own fields; Super Chat vs bits amounts diverge | R6 |
| 3 | Two homes for state | Rebuild could restore stale pins/token | R7 |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | One adapter file per platform, same interface (`start`, `stop`, emits events) | Adding Streamlabs later touches one file |

### Dependency Map
```
YouTube streamList ─┐
Twitch EventSub ────┼─► ingestion (adapters) ─► merge buffer (sort by ts) ─► WebSocket ─► phone page
                    │                              │
                    │                              └─► bucket (token, pins, certs)  ◄── restore on boot
GitHub Actions watchdog ─► OCI API (start / rebuild) ─► VM
```
No cycles. The watchdog depends on the app only through `/health`.

### Boundary Crossing Analysis
| Crossing | From → To | Clean? | Notes |
|----------|-----------|--------|-------|
| Platforms → app | external → ingestion | Yes, if adapters share one event type | R6 |
| App → phone | server → browser | Yes, one WebSocket | Must carry secret |
| App ↔ bucket | VM → OCI | Yes, instance principal | Write rule R7 |
| Watchdog → VM | GitHub → OCI | Yes | Decision logic C1 |

### Verdict Details
- Dependency Direction: PASS
- Module Coupling: PASS
- Cohesion: CONCERNS (state split)
- Layer Boundaries: PASS
- Change Propagation: CONCERNS (no shared event type)

---

## 6. Repo Maintainer

**Verdict**: APPROVE WITH CHANGES

### Plan Summary
Greenfield; no git repo yet. Plan commits to a public GitHub repo.

### Files Reviewed
| File | Convention Status | Risk |
|------|------------------|------|
| PRODUCT.md | OK | Low |
| `.agent/`, `.opencode/`, `.claude/skills/` | Vendored tool files, ~212 markdown files | Medium (public) |

### Critical Issues (Must Fix)
| # | Issue | File(s) | Convention Violated | Fix |
|---|-------|---------|-------------------|-----|
| 1 | No `.gitignore` before a public first commit | repo root | Secrets never committed | C4 |

### Recommendations
| # | Issue | Why | Fix |
|---|-------|-----|-----|
| 1 | Vendored skill folders | Would be published; noise in the repo | R8 |
| 2 | No README/SETUP | Future you can't redo setup | R9 |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | `infra/`, `app/`, `.github/workflows/` top-level split | Matches the agreed layout |

### Convention Compliance Checklist
| Convention | Status | Notes |
|-----------|--------|-------|
| File placement | N/A | No code yet |
| Naming conventions | N/A | |
| Barrel exports | N/A | Not used in SvelteKit by default |
| Import ordering | N/A | |
| Type imports separated | N/A | |
| Path aliases used | N/A | SvelteKit `$lib` when code exists |
| No dead code left | PASS | |
| Structured logging | Open | Decide before code |
| No lint suppressions | N/A | |
| CLAUDE.md present | Missing | Optional; PRODUCT.md covers product intent |

### Reuse Opportunities
Social Stream Ninja's source (open) handles many chat-format edge cases; read before writing adapters.

### Verdict Details
- File Organization: PASS
- Naming Consistency: N/A
- Import Hygiene: N/A
- Code Reuse: PASS
- Lint Compliance: N/A

---

## 7. Production Readiness

**Verdict**: APPROVE WITH CHANGES

### Plan Summary
Ships an always-on VM with auto-recovery. Most likely failures: recovery itself misfiring, and platform credentials going bad.

### Files Reviewed
| File | Production Role | Risk |
|------|----------------|------|
| PRODUCT.md | Defines hosting and recovery | Medium |

### Critical Issues (Must Fix)
| # | Issue | File(s) | Production Failure Mode | Fix |
|---|-------|---------|------------------------|-----|
| 1 | Rebuild on any health failure | watchdog | Rebuild loop exhausts Let's Encrypt limit; HTTPS down for days | C1 |
| 2 | No signal when a source dies | ingestion, `/health` | Silent half-feed for whole streams | C2 |

### Recommendations
| # | Issue | Why | Fix |
|---|-------|-----|-----|
| 1 | Reconnect handling | Twitch periodically asks clients to move to a new URL | R10 |
| 2 | Logs lost on rebuild | Can't debug last night's failure | R11 |
| 3 | Quota exhaustion | YouTube stops until midnight Pacific | R12 |
| 4 | Cert reuse | Avoids rate limits on legitimate rebuilds | Part of C1 |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Watchdog posts a one-line summary to a private channel/email on any action | Know when the system healed itself |

### Failure Mode Analysis
| Scenario | What Fails | User Impact | Recovery | Plan Handles It? |
|----------|-----------|-------------|----------|-------------------|
| Oracle stops idle VM | Everything | Feed offline | Watchdog starts VM | Yes |
| Oracle deletes VM | Everything | Offline ≤30 min | Terraform rebuild + restore | Yes |
| App crashes | Feed | Offline ≤30 min | systemd restart should catch it first | Partly (add systemd `Restart=always`) |
| DuckDNS/HTTPS fails, VM fine | Access | Offline | Should not rebuild | No (C1) |
| Twitch token revoked | Twitch half | Missed messages | Streamer reconnects | No (C2, R4) |
| YouTube quota out | YouTube half | Missed messages | Waits till reset | No (C2, R12) |
| Phone network drop | Phone | Brief gap | Reconnect + replay | Yes (R15 sizes it) |
| Free AMD shape unavailable | Rebuild | Offline until capacity | Retry next run / A1 fallback | Yes |
| Bucket deleted | Token, pins | Streamer must reconnect | None | Accepted (bucket outside Terraform) |

### Environment Checklist
| Concern | Dev | Prod | Gap? |
|---------|-----|------|------|
| File paths | local | VM disk + bucket | Yes: R7 |
| Network | localhost | DuckDNS HTTPS | Twitch redirect URI differs per env |
| Permissions | dev keys | instance principal | Test bucket policy before first deploy |
| Config | `.env` | Actions secrets | R13 |
| Build output | Vite dev | `adapter-node` build | Use the build in CI, not dev mode |

### Verdict Details
- E2E Flow: PASS
- Error Recovery: CONCERNS (C1)
- Data Integrity: CONCERNS (R7)
- Environment Parity: CONCERNS (redirect URIs, config)
- Observability: CONCERNS (C2, R11)

---

## 8. DX Engineer

**Verdict**: APPROVE WITH CHANGES

### Plan Summary
The "developer" is the person operating this for the streamer. Their experience is one-time setup, then rare fixes.

### Files Reviewed
| File | DX Role | Risk |
|------|---------|------|
| PRODUCT.md | Only setup reference | Medium |

### Critical Issues (Must Fix)
None.

### Recommendations
| # | Issue | Why | Fix |
|---|-------|-----|-----|
| 1 | Secrets not listed | Setup fails one missing variable at a time | R13 |
| 2 | Can't test without a live stream | Every change waits for the streamer to go live | R14 |
| 3 | Generic failure emails | "Workflow failed" doesn't say what | Watchdog prints which source/step failed |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | `npm run check-setup` that verifies every secret works | Catch a bad key before deploying |

### Error Message Audit
| Error Scenario | Current Message | What Developer Needs | Suggested Message |
|---------------|----------------|---------------------|-------------------|
| Missing env var | Undefined | Which one, where to get it | `YOUTUBE_API_KEY is not set. Create one in Google Cloud → Credentials, then add it to .env` |
| Twitch token revoked | Undefined | That streamer must reconnect | `Twitch: token rejected (401). Streamer must tap Reconnect Twitch.` |
| Quota exhausted | Undefined | When it resets | `YouTube quota used up (10,000/10,000). Resets at midnight Pacific.` |
| Watchdog rebuilt VM | Undefined | Why | `Instance <id> was TERMINATED; rebuilt at <time>.` |

### Developer Journey
First use: many accounts (Oracle, Google Cloud, Twitch dev, DuckDNS, GitHub), friction is ordering → SETUP.md. Daily use: none expected. Fix use: needs status and readable errors → C2, error table above.

### Verdict Details
- Error Quality: CONCERNS
- Defaults & Config: CONCERNS (R13)
- Keyboard Experience: N/A (phone-only)
- Discoverability: PASS
- Workflow Integration: PASS (GitHub Actions)

---

## 9. Performance Engineer

**Verdict**: APPROVE WITH CHANGES

### Plan Summary
Load is tiny server-side (two inbound connections, one phone). The real constraint is a phone page running for 12 hours.

### Files Reviewed
| File | Performance Role | Risk |
|------|-----------------|------|
| PRODUCT.md | Defines session length | Medium |

### Critical Issues (Must Fix)
| # | Issue | File(s) | Impact | Fix |
|---|-------|---------|--------|-----|
| 1 | Unbounded feed on phone | phone page | Jank, battery, OS tab kill | C5 |

### Recommendations
| # | Issue | File(s) | Why | Fix |
|---|-------|---------|-----|-----|
| 1 | Replay buffer size | server | Must be bounded | R15 |
| 2 | Wake lock + 12h WebSocket | phone | Battery | Note in SETUP: phone should be charging |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Batch DOM inserts per animation frame | Bursty chat (raids) won't stutter |

### Resource Budget
| Resource | Current | After Plan | Concern? |
|----------|---------|-----------|----------|
| Network calls per message | – | 0 extra (push) | No |
| Event listeners added | – | 1 WebSocket, 1 scroll, 1 visibility | No |
| Memory growth per hour | – | Unbounded as written | Yes (C5) |
| Startup time impact | – | One page | No |
| Bundle size impact | – | Small SvelteKit page | No |

### Hot Path Analysis
Per message: server sorts into a short time buffer (insert into a small sorted list, cheap) → one WebSocket send → one DOM insert. Fine at chat rates for ~50 viewers. Only accumulation (C5) is a concern.

### Verdict Details
- Memory Management: CONCERNS (C5)
- IPC Efficiency: PASS
- I/O Patterns: PASS
- Startup Impact: PASS
- Long-Session Stability: CONCERNS (C5)

---

## 10. Accessibility Engineer

**Verdict**: APPROVE WITH CHANGES

### Plan Summary
A live, glanceable feed with paid-event highlighting and a pin action, read on a phone.

### Files Reviewed
| File | A11y Role | Risk |
|------|----------|------|
| PRODUCT.md | Sets "glanceable" and "never miss paid" goals | Medium |

### Critical Issues (Must Fix)
| # | Issue | WCAG Criterion | File(s) | Impact | Fix |
|---|-------|---------------|---------|--------|-----|
| 1 | Colour as the only signal for platform and paid events | 1.4.1 Use of Color | phone page | Colour-blind streamer can't spot paid events | C6 |

### Recommendations
| # | Issue | WCAG Criterion | Fix |
|---|-------|---------------|-----|
| 1 | Live feed floods screen readers | 4.1.3 Status Messages | R16 |
| 2 | Small pin control, fixed text size | 2.5.8 Target Size, 1.4.4 Resize Text | R17 |
| 3 | Motion on every message | 2.3.3 Animation from Interactions | R18 |

### Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | High-contrast mode default | Arm's-length reading under stream lighting |

### Keyboard Navigation Walkthrough
| Step | Action | Expected Focus | Expected Announcement | Plan Handles? |
|------|--------|---------------|----------------------|---------------|
| 1 | Open app | Feed | "Chat log" | Not yet specified |
| 2 | Tab | Connect/Reconnect Twitch (when shown) | "Reconnect Twitch, button" | Not yet specified |
| 3 | Tab into feed item | Pin button | "Pin message from <author>, button" | Not yet specified |
| 4 | Enter | Pin toggles | "Pinned" | Not yet specified |
| 5 | Tab | "N new messages" pill (when shown) | "12 new messages, button" | Not yet specified |

### ARIA Checklist
| Element | Role | Label | States | Keyboard | Notes |
|---------|------|-------|--------|----------|-------|
| Feed | `log` | "Chat" | – | Scrollable | `aria-live="off"` |
| Paid-event announcer | `status` | – | – | – | Polite, paid events only |
| Pin button | `button` | "Pin message from …" | `aria-pressed` | Enter/Space | ≥44px |
| Platform status | `status` | "Twitch connected" etc. | – | – | Text, not colour only |
| New-messages pill | `button` | "N new messages" | – | Enter scrolls to bottom | |

### Verdict Details
- Screen Reader Compatibility: CONCERNS (R16)
- Keyboard Navigation: PASS (plan-level; verify in code)
- Focus Management: PASS (no modals except clear-pins confirm)
- Color Contrast: CONCERNS (C6, to verify with real palette)
- Motion Sensitivity: CONCERNS (R18)

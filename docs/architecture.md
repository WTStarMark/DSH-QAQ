# QAQ Architecture Overview

This is the entry point for understanding QAQ (DeepSeek Harness Launch Resilience Guard). Read this first, then dig into the topic-specific documents.

- [Guard Lifecycle](guard-lifecycle.md) — one supervised boot, end to end
- [State & Rollback](state-and-rollback.md) — state.json / snapshots / anti-loop fence
- [UI Detection & CDP](ui-detection.md) — headless Chrome + real-DOM criteria
- [Lazy Launcher Console & Environment Discovery](console-and-env.md) — interactive menu / preflight / plugin mounting
- [Logging](logging.md) — structured multi-file rotating logs
- [Testing & Real Integration](testing.md) — unit-test matrix / smoke / real-DSH integration

---

## 1. What this project is

QAQ is an **external supervising process**: it takes over the launch of `dsh web` and detects two failure modes that DSH cannot self-heal:

| Failure mode | Symptom | Why ordinary monitoring misses it |
|--------------|---------|------------------------------------|
| **Host crash** | `dsh web` exits / port never opens / startup error | Needs dedicated process liveness tracking |
| **UI red screen** | Host alive and port reachable, but the browser renders `Failed to load plugins` | `curl` only gets an empty `<div id="root">` — the HTML is filled by React at runtime; the structural CSS classes are unstable hashes across builds |

QAQ's detection line (L3) is the only reliable **non-invasive** probe: drive a headless Chrome over CDP, open the page, and read the real DOM text.

**Non-invasive promise**: QAQ never edits DSH source; the backup plugin only reads configuration and never changes behavior.

---

## 2. Module map

| Module | File | Responsibility | Key exports |
|--------|------|----------------|-------------|
| Command line | `src/cli.ts` | command surface, `dsh web` supervision entry | `main()` |
| Guard orchestration | `src/guard.ts` | one boot: spawn → probe → count → rollback | `superviseBoot()`, `GuardOptions`, `BootVerdict` |
| Child supervision | `src/spawn-dsh.ts` | spawn `dsh web`, readiness/exit tracking, output capture | `spawnDsh()`, `DshSupervisor` |
| CDP client | `src/cdp.ts` | dependency-free headless-Chrome driver (WebSocket) | `launchSession()`, `findBrowser()` |
| UI detection | `src/detector-ui.ts` | L3 text criteria, DOM polling | `detectUi()`, `classifyDom()`, `FAILED_MARKER` |
| State store | `src/store.ts` | atomic state.json I/O, snapshot management, guard lock | `readState()`, `writeState()`, `acquireLock()` |
| Rollback engine | `src/rollback.ts` | threshold, broken-config backup, anti-loop, success bookkeeping | `maybeRollback()`, `recordSuccess()` |
| Environment discovery | `src/env.ts` | dsh/browser/port auto-discovery + pre-launch self-check | `preflight()`, `resolveCommand()` |
| Command surface | `src/cli.ts` | subcommand parsing + command handlers (status/backup/restore/reset/watch/dsh…) | `parseCli()` |
| Real DSH context | `src/dsh-context.ts` | resolve the real DSH install (home/profile/checkout) + process/plugin connection state | `resolveDshContext()`, `findDshPackages()` |
| Interactive console | `src/console.ts` | lazy launcher CMD menu GUI | `openConsole()` |
| Plugin mounting | `src/install-plugin.ts` | install the dsh-qaq plugin into a DSH profile (bundle mechanism) | `installPlugin()` |
| Full-screen dashboard | `src/tui.ts` | raw-mode TTY dashboard: live state, hotkeys, lang toggle | `runTui()` |
| Setup | `src/setup.ts` | one-command install deps + build | `runSetup()` |
| Path helpers | `src/paths.ts` | `$DSH_HOME` / `.qaq` / profile path derivation | `resolveDshHome()`, `qaqDir()`, `profileDir()` |
| Logging | `src/log.ts` | structured multi-file rotating logger | `Logger` |
| Plugin↔CLI shared channel | `src/shared-io.ts` | JSON heartbeat / health state / `events.jsonl` between the plugin and the guard | `readPluginHeartbeat()`, `pushEvent()` |
| External-guard attach | `src/watch.ts` | `qaq watch`: watch a DSH the CLI did not spawn (discover by heartbeat), count + rollback | `watchOnce()`, `resolveWatchTarget()` |
| Version update (Beta) | `src/update.ts` | local/remote version parse+compare, GitHub check, source-archive download | `checkForUpdate()`, `downloadUpdateSource()`, `compareVersions()` |
| Webhook delivery | `src/webhook.ts` | dependency-free outgoing POSTs for boot-failure / rollback events | `deliverWebhooks()` |
| DSH backup plugin | `packages/dsh-qaq/` | runs inside DSH host, snapshots config after settle + writes heartbeat/events to the shared channel | `apply()`, `name` |

---

## 3. One supervised boot, end to end

```
User (qaq console → [1], or qaq dsh web)
  │
  ▼
preflight()                     ── environment self-check (dsh command / browser / port)
  │  fatal errors → refuse to start, print actionable hints
  ▼
acquireLock(home)               ── PID-aware guard lock (no double instances; stale lock auto-reclaimed)
  ▼
superviseBoot(GuardOptions)     ── orchestration (up to retries+1 attempts)
  │  ┌──────────────────────────────────────────┐
  │  │ bootAttempt():                           │
  │  │   spawnDsh → ready (port up) → detectUi  │
  │  └──────────────────────────────────────────┘
  │  ├─ ok → confirmStable (stability window + re-probe) → recordSuccess → hand child to caller
  │  └─ failed → classify host / ui / unknown
  │         ├─ unknown: not counted, reported
  │         └─ host / ui: incrementFailure → threshold → maybeRollback
  ▼
verdict (BootHealthy | BootFailure)
  ├─ healthy: cli keeps the child running (the visible window is the GUI), waits for exit
  ├─ rolled back: boots once more (inside the anti-loop fence), keeps supervising if healthy
  └─ failed: points the user at rolled-back/
```

---

## 4. Per-profile state machine

```
               ┌──────────────┐
               │ healthy (supervised) │◄────────────┐
               └──────┬───────┘             │
                  │ confirmation window       recordSuccess
                  │ recordSuccess            (clear counters / fence / snapshot)
                  ▼                          │
           ┌──────────────┐                  │
           │ failed (count +1) │             │
           └──────┬───────┘                  │
                  │                          │
         count < threshold (default 3)      │
         or no last-good snapshot           │
                  ▼                          │
           ┌──────────────┐   trigger rollback  ┌──────────────┐
           │ report, exit │───────────────────►│ rollback + restart once │
           └──────────────┘  (or user declines) └──────┬───────┘
                                                       │ restart still fails within 5 min
                                                       ▼ (anti-loop fence)
                                                 ┌──────────────┐
                                                 │ stop, guide manual fix │
                                                 └──────────────┘
```

---

## 5. Data flow (config → snapshot → rollback)

```
$DSH_HOME/profiles/web/
  package.json        ── declares dsh.profile.bundles (plugin layer list)
  cordis.patch.yml    ── user patch layer (QAQ never modifies it)

         │ on confirmed health (guard) / a real user conversation (dsh-qaq plugin)
         ▼
$DSH_HOME/.qaq/
  state.json          ── counters / lastSuccess / lastGoodSnapshot / rolledBackAt
  latest-good/        ── last confirmed-healthy config copy (package.json + cordis.patch.yml + manifest.json)
  history/auto/<ts>/  ── auto backups (guard confirm / plugin real conversation; independent 10 quota)
  history/manual/<ts>/── manual backups (qaq backup / TUI; independent 3 quota)
  rolled-back/<ts>/   ── broken config preserved before a rollback (manual recovery)
  log/                ── qaq.log / error.log / access.log / host.log
  .guard.lock         ── PID-aware guard lock

         │ failures reach the threshold
         ▼
maybeRollback → back up the broken config to rolled-back → overwrite the profile config → restart
```

**Snapshot principle**: only launch-relevant config is snapshotted (`package.json` + `cordis.patch.yml`). Credentials, sessions, storages, and mcp-servers are **never** included.

---

## 6. Key design decisions

| Decision | Rationale |
|----------|-----------|
| Text-based UI criteria (`Failed to load plugins` / `<textarea>`) | Red-screen structural classes are CSS-Module hashes, unstable across builds |
| Hand-rolled CDP instead of Playwright/Puppeteer | Runtime dependency is only `ws`; small and controllable |
| Atomic writes (temp + rename) | A crash never leaves a half-written state or snapshot |
| Transient retry (`retries=1`) killing the child first | Windows flake (e.g. EBUSY) is not counted; a failed boot never leaks a process holding the port |
| Confirmation-window re-probe | A boot that degrades right after first health is never recorded as last-good |
| Diff preview + Y/N before rollback | User consent; no rollback behind the user's back |
| 5-minute anti-loop fence after a rollback | No cascading auto-restarts when the restart still fails |
| install-plugin only adds the bundle, never touches the user patch | DSH auto-loads the plugin's patch from its bundle declaration; a duplicate user-layer row would crash the boot with "duplicate loader entry id" |

---

## 7. Repository layout

```
src/                        # main program (ESM; tsx or esbuild → dist/qaq.mjs)
packages/dsh-qaq/           # DSH backup plugin (standalone package; lib/index.js is the build output)
bin/                        # CLI entry: qaq.cmd (ASCII dev wrapper) + qaq.mjs (dist/tsx bootstrap)
qaq-test-plugins/           # integration fixture (dsh-broken-theme → deterministic red screen)
tools/                      # smoke.mjs / rollback-test.ps1 / loop-test.ps1
test/                       # vitest unit tests (27 spec files)
docs/                       # this documentation set (en = *.md, zh = *.zh.md)
```

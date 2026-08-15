# QAQ — DeepSeek Harness Launch Resilience Guard

[中文说明](./README.zh-CN.md)

QAQ is a **launch resilience guard** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). When a disrupted profile configuration prevents DSH from starting normally — a crashed host **or** a red-screened Web UI — QAQ automatically restores the configuration snapshot from the last successful boot and restarts, while preserving the broken config for manual recovery.

**Non-invasive**: QAQ never edits DSH source. The guard is a standalone executable that supervises the `dsh web` process and reads the browser's real DOM over CDP; the backup plugin only reads configuration and never changes behavior.

## What it solves

DSH's Web surface has a failure mode where the **host is alive but the UI red-screens**: the host process runs, the port responds, yet the browser renders `Failed to load plugins`. Such failures are invisible to host-process monitoring and cannot be detected by `curl` (the server-side HTML ships an empty `<div id="root">`, rendered client-side). The only reliable non-invasive probe is to open the page in a headless browser and read the actual DOM. QAQ's UI-detection line is exactly that.

## Requirements

- Node.js >= 22
- A Chrome/Chromium/Edge binary on the machine (used headlessly via CDP; no Playwright/Puppeteer dependency)
- The `dsh` command on `PATH`, or an explicit `QAQ_DSH_CMD` / `--cwd`

## Install / Quick start

```bash
pnpm install
pnpm build   # emits a single-file executable at dist/qaq.mjs
```

Take over `dsh web` from a visible CMD window:

```cmd
bin\qaq-web.cmd [--port 3080] [--yes]
```

or directly:

```bash
qaq dsh web --port 3080 --yes
```

> **Which `dsh` runs?** The guard defaults to `dsh web` (`PATH` resolution). To run from the DSH source tree instead:
> ```bash
> QAQ_DSH_CMD="node --import tsx/esm apps/cli/src/bin.ts web" qaq dsh web --cwd /path/to/dsh-checkout
> ```

## Commands

| Command | Purpose |
|---------|---------|
| `qaq dsh web [--port N] [--yes]` | supervised startup: detect host/UI failure -> count -> roll back when triggered -> restart (with anti-loop) |
| `qaq status` | print a summary of `~/.dsh/.qaq/state.json` |
| `qaq backup [--profile web]` | snapshot the current profile as last-good |
| `qaq restore --to <snapDir> [--profile web]` | restore a profile from a snapshot directory |
| `qaq reset --profile web` | zero the failure counters |

Global: `--yes` auto-confirms rollbacks.

## Supervised `dsh web` options

| Option | Meaning | Default |
|--------|---------|---------|
| `--confirm-ms <ms>` | stable-healthy confirmation window before snapshotting | `20000` |
| `--ui-timeout <ms>` | max wait for the UI to settle during the L3 probe | `25000` |
| `--threshold <n>` | consecutive same-kind failures that trigger a rollback | `3` |
| `--cwd <dir>` | working directory for the supervised `dsh` (set to the checkout for source launch) | process cwd |

## Detection criteria (L3, empirically verified)

- **UI failure**: `document.body.innerText` contains the pinned text `Failed to load plugins` (stable across builds). The failure detail even names the missing plugin/service (e.g. `web boot: 1 entry did not activate dsh-x: pending (waiting for service: s)`).
- **Success**: a composer business container (`<textarea>`) is present and the failure marker is absent, stable for >= `--confirm-ms`.
- **No CSS class selectors**: the red-screen structural classes are CSS-Module hashes (`_boot_<hash>`) that change between builds.

## State & storage (`~/.dsh/.qaq/`)

- `state.json` — `hostFailures`, `uiFailures`, `lastSuccess`, `lastFailure`, `lastGoodSnapshot`, `rolledBackAt`
- `latest-good/` — the last confirmed-good profile config (`package.json` + `cordis.patch.yml` + `manifest.json`)
- `history/<ts>/` — up to 5 timestamped historical snapshots
- `rolled-back/<ts>/` — the broken config saved before a rollback (for manual recovery)
- `log/qaq.log`

**Never snapshotted**: credentials, sessions, storages, mcp-servers.

## Trigger & anti-loop

- **3** consecutive failures of the same kind (host or UI) trigger a rollback.
- Confirmation is required by default (`Y/N`); `--yes` makes it fully automatic.
- **Declining the confirmation stops the guard without auto-restart**: the broken config is left in place (preserved under `rolled-back/` too) for manual recovery — the guard never restarts with an auto-confirmed rollback behind your back.
- After a rollback a **5-minute anti-loop fence** stops repeated auto-restarts if the restart still fails; the user is pointed at `rolled-back/`.

## Reliability features

- **Transient-failure retry** (`retries=1`): suspected one-off flakes (host not ready, a client bundle that transiently fails to load) are retried once and not counted, so a Windows EBUSY does not corrupt the strike counter. Every retried attempt kills its child first, so a failed boot never leaks a process that would hold the port or hang the guard.
- **Confirmation-window re-probe**: after the first healthy DOM probe, the boot must stay stable for `--confirm-ms`, then the real DOM is probed once more before a last-good snapshot is written — a boot that degrades right after first health is never recorded as good.
- **PID-aware guard lock**: a stale lock left by a crashed guard is auto-reclaimed on the next run.
- **Rollback diff preview**: prints the config diff (current vs. last-good) before `Y/N`.
- **Deterministic history retention**: snapshots sort by their ISO-timestamp names, stable across restarts.
- **Fast host-failure reporting**: a child that exits before its port opens (or a spawn failure such as a missing command) is reported immediately instead of waiting out the full port timeout.

## Testing

```bash
pnpm test      # vitest unit tests (store / rollback / detector-ui criteria)
pnpm smoke     # one-shot regression: unit tests + seed/broken/detect in an isolated home
```

`pnpm smoke` performs a real-DSH integration segment only when a checkout is available (set `QAQ_SMOKE_DSH_HOME`).

Integration fixture: `qaq-test-plugins/dsh-broken-theme` (injects a service that never arrives -> deterministic red screen), used with `tools/rollback-test.ps1` to exercise the full fail->count->rollback->recover loop on a real DSH instance.

## Repository layout

```
src/
  cli.ts            command surface + supervised loop
  guard.ts          superviseBoot orchestration (host ready -> UI detect -> count/rollback)
  spawn-dsh.ts      spawn dsh web, inherit env, readiness/exit tracking
  cdp.ts            minimal CDP client (headless Chrome, no Playwright)
  detector-ui.ts    L3 text criteria
  store.ts          atomic ~/.dsh/.qaq read/write + snapshot management + lock
  rollback.ts       rollback + broken-config backup + anti-loop + success bookkeeping
  paths.ts / log.ts
packages/dsh-qaq/  DSH backup plugin (snapshots after host boot settles; backup-only)
bin/               qaq / qaq-web.cmd launchers
tools/  test/  docs/
```

## License

MIT

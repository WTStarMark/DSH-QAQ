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

**One-click (Windows, 傻瓜式)**: double-click `bin\qaq-install.cmd` (installs deps + builds), then double-click `bin\qaq-web.cmd` to open the interactive guard console — no commands to remember.

Or manually:

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

> **Pre-launch self-check**: `qaq dsh web` (and the console) auto-discover the `dsh` command — `QAQ_DSH_CMD` → `--cwd` → a nearby DSH checkout (ancestors of the current directory, plus a sibling checkout sitting next to it, e.g. QAQ and `deepseek-harness` side by side) → `PATH` — pick a Chrome/Chromium/Edge binary for the UI probe, and verify the target port is free. Problems are reported with actionable Chinese hints before anything is spawned.

## Commands

| Command | Purpose |
|---------|---------|
| `qaq dsh web [--port N] [--yes]` | supervised startup: detect host/UI failure -> count -> roll back when triggered -> restart (with anti-loop) |
| `qaq status` | print a summary of `~/.dsh/.qaq/state.json` |
| `qaq backup [--profile web]` | snapshot the current profile as last-good |
| `qaq restore --to <snapDir> [--profile web]` | restore a profile from a snapshot directory |
| `qaq reset --profile web` | zero the failure counters |
| `qaq console` | open the interactive menu (傻瓜式, same as `bin\qaq-web.cmd`) |
| `qaq install-plugin [--profile web]` | auto-mount the `dsh-qaq` backup plugin into a profile |

Global: `--yes` auto-confirms rollbacks.

## One-click console (`qaq console` / `bin\qaq-web.cmd`)

A Chinese-language menu in a visible CMD window:

```
[1] 一键启动守卫（接管 dsh web）    — supervised launch (fresh preflight each time)
[2] 查看状态                        — current counters / last success / last snapshot
[3] 手动备份当前配置为 last-good
[4] 手动回滚到 last-good
[5] 重置失败计数
[6] 自动挂载 dsh-qaq 备份插件        — idempotent, rollback-safe (never breaks a boot)
[7] 查看日志（error / access / host）
[q] 退出
```

While a supervised `dsh web` is running, the guard lock is held until it exits (a second launch is refused and a stale port check can never misfire); Ctrl+C kills the supervised child so no process is left holding the port.

## Operations guide (操作指南)

### First-time setup (Windows)

1. **Install** — double-click `bin\qaq-install.cmd`. It checks Node.js >= 22, installs dependencies (pnpm, with an npx fallback), and builds `dist/qaq.mjs`.
2. **Mount the backup plugin (recommended)** — run `bin\qaq-web.cmd`, pick **[6] 自动挂载 dsh-qaq 备份插件**. This adds `dsh-qaq` to the profile's bundle list and links the module into the profile's `node_modules`. From then on, the plugin snapshots the config every time a clean host boot settles (backup-only; it never changes DSH behavior). The profile's own `cordis.patch.yml` is intentionally left untouched — DSH auto-loads the plugin's patch from its bundle declaration.
3. **Launch** — pick **[1] 一键启动守卫**. The console re-runs the pre-launch self-check (dsh command, browser, port), then supervises `dsh web`. Once the UI has been healthy for the confirmation window, the config is recorded as last-good and the guard keeps monitoring in the background (return to the menu anytime; the guard keeps running).
4. **Verify** — pick **[2] 查看状态** (or run `qaq status`): `hostFailures` / `uiFailures` should be 0 and `lastSuccess` / `lastGoodSnapshot` present.

### Everyday use

- Start DSH the same way every time: `bin\qaq-web.cmd` → **[1]**. Prefer not to start `dsh web` directly anymore — the guard owns the supervised process and is the only one that can detect a red screen.
- If the UI red-screens (or the host crashes) **3 times in a row**, QAQ offers a rollback to the last-good config with a diff preview. Accept it — the broken config is preserved under `~/.dsh/.qaq/rolled-back/` for later inspection, and the guard restarts once automatically.
- After a successful rollback + restart, the counters are zeroed and the anti-loop fence is cleared; the restored profile is the one you had before it broke.

### Troubleshooting

| Symptom | What to do |
|---------|-----------|
| `启动前自检未通过` — dsh not found | Put `dsh` on `PATH`, set `QAQ_DSH_CMD`, or pass `--cwd <dir>` pointing at the DSH checkout |
| `端口已被占用` — port busy | Stop the other process, or pick another port: `--port N` |
| UI red-screens again after a rollback | Inspect the logs and the preserved bad config: `qaq console` → **[7]**, or read `~/.dsh/.qaq/log/` (`error.log`, `access.log`, `host.log`) |
| Guard says `anti-loop fence is active` | A rollback already happened within the last 5 minutes. Fix the config manually (see `rolled-back/`), then `qaq reset --profile web` to clear the counters |
| Want to undo a rollback | `qaq restore --to <snapDir> --profile web` with any directory under `~/.dsh/.qaq/history/` (or `rolled-back/`) |
| dsh-qaq not snapshotting | The plugin only writes on a **clean host settle**; it does not write on a failed boot. Confirm it is listed in the profile bundles (`qaq console` → **[2]** shows the last snapshot) and that `install-plugin` reported success |

### Data locations

- Guard state, snapshots, and logs: `~/.dsh/.qaq/` (or `$DSH_HOME/.qaq/`)
- Profile configs: `$DSH_HOME/profiles/<name>/` (`package.json` + `cordis.patch.yml`)
- `qaq status` prints the exact paths for your environment.

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
- `log/` — structured multi-file logs (see below)

**Never snapshotted**: credentials, sessions, storages, mcp-servers.

## Logging (for developer troubleshooting)

Every record is one JSON line (`{ ts, level, cat, phase?, msg, ...meta }`) so the trail is machine-parseable, split across four files under `log/`, each rotating by size (256 KB → `.1.log`, keeping 5 copies):

| File | Content |
|------|---------|
| `qaq.log` | everything (info + warn + error), the canonical record |
| `error.log` | warn/error only — grep for trouble fast |
| `access.log` | crash-audit trail: boot verdicts, snapshots, rollbacks, resets, plugin mounts, manual restore |
| `host.log` | raw supervised `dsh` stdout/stderr (mirrored to the visible window) |

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
pnpm test      # vitest unit tests (store / rollback / detector-ui / guard / spawn-dsh / env / install-plugin / log)
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
  env.ts            auto-discovery + pre-launch self-check (dsh/browser/port)
  console.ts        interactive menu GUI (傻瓜式, CMD window)
  install-plugin.ts auto-mount the dsh-qaq backup plugin (rollback-safe)
  paths.ts / log.ts  (log.ts: structured multi-file rotating logger)
packages/dsh-qaq/  DSH backup plugin (snapshots after host boot settles; backup-only)
bin/               qaq / qaq-web.cmd / qaq-install.cmd launchers
tools/  test/  docs/
```

## License

MIT

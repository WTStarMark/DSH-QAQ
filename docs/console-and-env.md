# Lazy Launcher Console & Environment Discovery (console.ts / env.ts / install-plugin.ts / bin/)

This document dissects the user-facing launcher layer: environment auto-discovery and the pre-launch self-check, the interactive CMD menu, automatic backup-plugin mounting, and the CLI entry (`bin/`).

Related: [Architecture Overview](architecture.md) · [Guard Lifecycle](guard-lifecycle.md)

---

## 1. Environment auto-discovery (src/env.ts)

### 1.1 dsh command resolution (`resolveCommand`) — priority

```
1. $QAQ_DSH_CMD                 → use the split command directly (relative paths need --cwd to land in the checkout)
2. --cwd <dir>                  → dir contains apps/cli → ['node','--import','tsx/esm',<cli>,'web']
3. findAutoCheckout() scan      → see below
4. a dsh executable on PATH     → [<exe>,'web']; if absent, source='none' (preflight error)
```

### 1.2 `findAutoCheckout` scan scope

1. **Ancestor chain**: walk up to 5 levels from `process.cwd()`, checking `apps/cli/src/bin.ts` / `index.ts` / `dist/index.js`.
2. **Sibling scan** (key for launching from within the repo): scan **every direct child** of the cwd's parent directory; any child containing `apps/cli` wins — this covers the typical layout where QAQ and `deepseek-harness` sit side by side (the cwd is QAQ, the checkout is the sibling).

> PATH separator is chosen per platform: `;` on Windows, `:` on POSIX (drive letters like `C:\` make a blanket `/[;:]/` split unsafe).

### 1.3 `preflight` self-check

| Check | Level | Failure hint (localized `en`/`zh` via `--lang` / `$QAQ_LANG`) |
|-------|-------|---------------------------|
| dsh command exists (source != 'none') | error | dsh not found / no source dir → install dsh / --cwd / QAQ_DSH_CMD |
| Chrome/Chromium/Edge exists | error | install Chrome or Edge (required for UI detection) |
| port free (`isPortFree`, 2.5s timeout) | error | port busy → stop the old process or --port |
| incomplete checkout (has checkout but no CLI entry) | warn | deps/structure may be incomplete |

`preflight` returns an `EnvReport` (command/cwd/home/browser/port/problems); `cli.ts` treats only `error`-level problems as fatal.

---

## 2. Interactive console (src/console.ts)

### 2.0 Language (src/i18n.ts)

The whole user-facing surface (TUI dashboard, preflight problems, install-plugin results, CLI usage/fatal hints) is localized via a small dictionary (`en` / `zh`, keys like `console.menu.1`, `env.PORT_BUSY.msg`, `plugin.mountedResult`; `{var}` interpolation). Resolution order: `--lang en|zh` → `$QAQ_LANG` → default `zh` (the original behavior); inside the TUI you can also press `l` to toggle en/zh live. New strings must be added to **both** dictionaries or they fall back to the key itself.

### 2.1 Menu

```
[1] Start the guard (take over dsh web)   [5] Reset failure counters
[2] View status                           [6] Mount the dsh-qaq backup plugin
[3] Back up current config as last-good   [7] View logs (error / access / host)
[4] Roll back to last-good                [q] Quit
```

### 2.2 Input mechanism: the line-queue asker (`createAsker`)

> Why not `readline.question`: piped/redirected input arrives and closes during `preflight` (~2.5s); `question()` registers its listener too late → input is lost and the process exits silently (a pending promise does not hold the event loop).

- The interface listens for `line` immediately at creation and **queues** every line; a prompt consumes the queue.
- EOF (stdin closed) → resolves an in-flight prompt as `q`, or enqueues `q` if no waiter — redirected runs still exit cleanly.

### 2.3 Screen management

- `clearScreen()` before every menu render (TTY-only ANSI `\x1b[2J\x1b[3J\x1b[H`) — the window always shows one screen.
- Persistent header: title box + launch summary + problem warnings, re-printed each screen.
- Result line: quick actions (backup / rollback / reset / mount) keep a `✔ <lastNotice>` above the menu instead of flashing past.
- Detail views (status / logs) pause with an Enter-to-return prompt.

### 2.4 Guard-lock lifetime (critical)

- Once the supervised child is healthy, the lock is **held until the child exits** (`watchSupervisor` releases on exit). While held:
  - the menu shows "🛡 supervising" and a second [1] is refused (wait for it to exit).
  - every launch re-runs `preflight` (fresh); a stale port check can never misfire.
- Ctrl+C (SIGINT): kills the supervised child first, then exits — no leftover process holding the port.
- Closing the window: Windows broadcasts `CTRL_CLOSE_EVENT` to every console-attached process; the guard and the child terminate together; the leftover lock is reclaimed by the PID liveness check.

---

## 3. Backup-plugin mounting (src/install-plugin.ts)

### 3.1 Why only the bundle list, never the user patch

DSH resolves each `dsh.profile.bundles` entry in order, reads its `dsh.bundle.patch` from package.json, and loads it as a **plugin layer**. So mounting is exactly two steps:

1. add `dsh-qaq` to `dsh.profile.bundles`;
2. create a junction at `profiles/<name>/node_modules/dsh-qaq` → `packages/dsh-qaq`.

**Never touch `cordis.patch.yml` (the user layer)**: inserting another `id: dsh-qaq` row would duplicate the plugin-layer entry → `duplicate loader entry id` boot crash (a real bug caught by integration testing). A stale manual insert row from an older QAQ is only warned about.

### 3.2 Atomicity & idempotency

- The original package.json is kept before writing; a failed link rolls back every write and reports an error (never manufactures a boot failure).
- Already mounted (bundle already listed) → idempotent skip; existing junction → not rebuilt.

### 3.3 Plugin behavior

`dsh-qaq` runs inside the DSH host: it awaits `ctx.get('loader')?.await?.()` for the loader tree to settle, then only reports **presence** (heartbeat / inventory / state) — it no longer snapshots last-good on settle. The real last-good backup happens **only after a real user conversation**: `ctx.on('session/event')` delivering a `user/message` whose `source.kind === 'user'` (a direct human prompt; plugin-injected `kind === 'plugin'` and model/tool messages do not count). Because only a human actually sending a message proves the boot is usable, a host that settles but renders a web red screen — where the user can never talk — is **never** recorded as last-good. A failed boot (settle rejection) is likewise never snapshotted (`.catch(() => {})`).

---

## 4. `.cmd` launchers (bin/)

| File | Purpose |
|------|---------|
| `qaq.cmd` | pass-through wrapper (`qaq <args>`) |
| `qaq.mjs` | Node entry: uses dist when present, otherwise runs the source via tsx (`import.meta.url`-relative) |
| `qaq setup` | one-command install: check Node >= 22 → pnpm deps (npx fallback) → esbuild build + plugin lib → verify the artifact |
| `qaq tui` / `qaq console` | full-screen live dashboard (TTY) or a compact menu otherwise |

**Encoding note**: no GBK batch files remain in `bin/` — `qaq.cmd` is pure ASCII (maintain as UTF-8, LF). One-click install/build lives in the `qaq setup` command (`src/setup.ts`), which enforces pnpm >= 11 (falling back to `npx pnpm@11` when the local pnpm is missing or too old — see the `allowBuilds` key in `pnpm-workspace.yaml`).

---

## 5. Modification guide

- New menu item → edit the `runConsole` switch and the menu print (both localized via `i18n.ts`); result-style actions use `lastNotice`, detail-style actions end with an Enter-to-return prompt.
- New/changed user-facing string → add the key to **both** `en` and `zh` in `src/i18n.ts`; `test/i18n.spec.ts` covers `--lang` precedence, `$QAQ_LANG`, and interpolation.
- Discovery changes → touch only `env.ts`; `test/env.spec.ts` covers QAQ_DSH_CMD / --cwd / the sibling scan.
- Plugin mounting → `install-plugin.ts` + `test/install-plugin.spec.ts` (idempotency + "user patch untouched" assertions).

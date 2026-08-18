# Testing & Real Integration (test/ · tools/ · qaq-test-plugins/)

This document dissects the quality-assurance system: the unit-test matrix, the smoke regression, the real-DSH integration loop, the fault-injection fixture, and how to add tests for new features.

Related: [Architecture Overview](architecture.md)

---

## 1. Test commands

```bash
pnpm test      # vitest run — 27 spec files
pnpm smoke     # one-shot regression: unit tests + seed/broken/detect in an isolated home
pnpm lint      # dependency-free style gate (trailing whitespace, tabs, TODO markers, final newline)
pnpm typecheck # tsc --noEmit (root src/+test/) AND packages/dsh-qaq via its own tsconfig
pnpm build      # bundle dist/qaq.mjs AND regenerate packages/dsh-qaq/lib
```

> **Plugin build & typecheck gating.** The dsh-qaq plugin's `lib/` is a generated
> artifact (not committed). `pnpm build` regenerates it; `pnpm typecheck` also checks
> the plugin source through `packages/dsh-qaq/tsconfig.json`. CI additionally runs
> `pnpm check:plugin-lib`, which rebuilds the lib into a throwaway dir and asserts it
> is byte-identical — catching a stale (silently-degrading `qaq watch`) plugin.

---

## 2. Unit-test matrix (test/)

| File | Coverage | Key cases |
|------|----------|-----------|
| `store.spec.ts` | state I/O, atomicity, snapshots, backup sets, lock | corrupt state falls back to default; prune keeps 5; manifest records the real profile name (regression); lock exclusion/release; stale-lock reclaim (dead PID) + garbage lock; **`readSnapshotKind` (auto default on corrupt/missing), independent auto/manual quotas (`10`/`3`) + `listBackups` empty-set and per-kind separation** |
| `paths.spec.ts` | pure path helpers | `resolveDshHome` default vs explicit DSH_HOME (blank/trimmed); `qaqDir`; `profileDir`; `profilesNodeModules` (platform-independent separators) |
| `cli.spec.ts` | command-surface parsing | `parseCli` maps every subcommand/mode, `--yes`/`--profile`, watch `--attach` falls back to `--port`, numeric tuning flags (and a non-numeric guarded), repeatable `--webhook`, restore `--to`; the CLI is importable without auto-running `main()` |
| `dsh-context.spec.ts` | real-DSH discovery | isolated `DSH_HOME` (per-worker); idle profile resolution; foreign running DSH reported via a fresh plugin heartbeat (pid/port, connected state); `profileBasename`; `describeDsh` |
| `rollback.spec.ts` | rollback engine | no trigger below threshold; backup + restore on trigger; fence blocks a second rollback; no trigger without a snapshot; decline does not overwrite; recordSuccess clears counters + fence + snapshots; **isInAntiLoop window math; malformed rolledBackAt is not fatal; diffConfig alignment/truncation; manualBackup writes only to the MANUAL set without touching counters; auto vs manual independent quotas (10 auto / 3 manual)** |
| `guard.spec.ts` | orchestration (mocked spawn/detect) | an un-settled UI must kill the child (leak regression); a degraded confirmation is never recorded as last-good; **a host crashing after binding is host, not unknown (classification regression)**; retriesExhausted semantics; **deterministic UI red screen rolls back on first hit (effective threshold 1)** |
| `spawn-dsh.spec.ts` | real child readiness tracking | an early exit before the port opens rejects `ready` immediately with the real code; a missing command rejects without waiting out the timeout |
| `detector-ui.spec.ts` | L3 criteria | red-screen text → failed with detail/failedEntries; healthy composer → ok; boot page → loading; **0ms timeout still probes at least once (confirm-ms 0 regression)**; **"waiting for service" red screen → definitive** |
| `env.spec.ts` | environment discovery | findCheckoutCli / QAQ_DSH_CMD / --cwd checkout / **sibling auto-discovery (checkout beside the cwd)** / isPortFree |
| `install-plugin.spec.ts` | plugin mounting | graceful failure on an uninitialized profile; real mount is idempotent + **user patch untouched**; plugin-dir resolution; **stale-insert warning; failed-link undoes the manifest write; bad-JSON profile** |
| `log.spec.ts` | logging | JSON line format, error double-write, access channel, `.in()` category, size-based rotation |
| `i18n.spec.ts` | bilingual strings | en/zh dictionary resolution, `{var}` interpolation |
| `tui.spec.ts` | dashboard frame + modes + plugin panel + backup panel | width-overflow guards; no-flicker clear; menu/logs/plugin ordering; **log-viewer + `computeLogWindow`; launcher/sideload/idle mode lines; real dsh-qaq connection status (connected/connecting/disconnected); cursor↔action alignment (no status-row offset — the select-precise-cache-hits-qaq regression)**; paginated plugin panel + short-name (no dsh- prefix / no glyphs) rows + pager header; scan-pick + inline-input modes; **backup panel renders auto/manual sections with an empty "(none)" placeholder and a flat cursor that spans both groups**; non-TTY fallback |
| `plugin-manager.spec.ts` | **real-DSH** plugin lifecycle | discovers DSH `packages/` (scoped `@deepseek-ai/dsh-*` bundles with `dsh.bundle.patch`); list (installed/enabled/source/orphan) across the profile node_modules **and** the shared `profiles/node_modules` pool, **overlaying the LIVE loader enabled/phase while keeping disabled plugins visible (the disable-then-vanish regression)**; **a `cordis.patch.yml` INSERT counts as enabled; disable/uninstall of a patch-insert + pool-located plugin (the dsh-precise-cache shape); client plugins (dsh.client) install/enable via the patch insert; a corrupted double-top-level patch is collapsed into ONE valid document (the DSH end-of-stream boot regression)**; enable/disable; **refuses to enable a non-plugin/dependency (cosmokit)**; uninstall sanitizes a corrupted bundle list; source discovery + row text |
| `plugin.spec.ts` | dsh-qaq in-process plugin | heartbeat freshness expiry regression; **pushes the authoritative plugin inventory from the Cordis loader (groups skipped, enabled/phase real); periodically refreshes the inventory alongside the heartbeat (keeps the external "connected" state from degrading to "connecting"); TRUE BACKUP: isUserConversation gates last-good on a real user/message (source.kind==='user'), a plain settle never writes last-good, a real conversation does** |
| `shared-io.spec.ts` | plugin↔CLI channel | heartbeat read freshness, atomic JSON writes, `events.jsonl` append + cursor read |
| `watch.spec.ts` | external-guard attach | `--attach` / heartbeat target resolution; webhook URL merge + dedupe (no real Chrome) |
| `watch-once.spec.ts` | `watchOnce` decision paths | healthy→recordSuccess; red-screen→count+rollback+webhook; **deterministic red-screen→rollback with effective threshold 1**; unreachable→host count; loading→uncounted; no-target safety |
| `webhook.spec.ts` | webhooks delivery | best-effort no-op without targets; live HTTP POST to all URLs; unsupported protocol never throws; `webhooks.json` single/array/corrupt; `defaultWebhookHome` fallback |
| `update.spec.ts` | version check (Beta) | version triple parse/compare (0.0.3→0.1.3→…→0.4.4 chain); local version read; `checkForUpdate` with a stubbed fetch (newer/equal/older/HTTP error/bad payload/network error); `downloadUpdateSource` writes `qaq-<version>.zip` |
| `cdp.spec.ts` | browser discovery | deterministic `findBrowser` through env override (Chrome/Edge fallback, null, empty env) |
| `cdp-retry.spec.ts` | UI-probe retry loop | port-collision retry with a fresh random port; no-retry on missing browser / explicit port (mocked `launchSession`, no real Chrome) |
| `width.spec.ts` | terminal width math | CJK/fullwidth=2 cols, ANSI = 0 cols, `padEnd/Start`, ANSI-safe `truncate` |
| `color.spec.ts` | banner/colour helpers | `lerp` clamp+round, truecolor SGR, gradient keeps gaps uncoloured, `hasColor` depth gating |

Test-infrastructure notes:
- `guard.spec.ts` swaps `spawn-dsh` / `detector-ui` via `vi.hoisted` + `vi.mock` and asserts `killMock` calls.
- Real-child tests (`spawn-dsh`) use `node -e 'process.exit(3)'` to simulate an early exit.
- All Logger construction happens in `beforeAll` (after the home is ready) so an empty home never pollutes the repo directory.

---

## 3. Smoke one-shot regression (tools/smoke.mjs)

Flow:

1. `npx vitest run` (full unit suite).
2. Isolated home (`tools/.smoke-home`): seed a healthy profile → `qaq backup` to write last-good → break the user patch (insert a non-existent package).
3. Run the guard once (`qaq dsh web --yes`, `QAQ_DSH_CMD` + `--cwd` pointing at a real checkout) → it should detect a host failure and exit.
4. Clean up the temp home.

> - The real-DSH segment only runs when a checkout is provided: `$env:QAQ_SMOKE_DSH_HOME = <checkout path>`.
> - All smoke paths are `import.meta.url`-relative (on Windows the spawn needs `shell: true` so `npx.cmd` resolves).

---

## 4. Real-DSH integration loop (tools/*.ps1)

| Script | Scenario |
|--------|----------|
| `rollback-test.ps1` | seed healthy → `qaq backup` → inject dsh-broken-theme to break the profile → run the guard 3× → the 3rd run triggers a rollback → verify the restored profile, state, and rolled-back contents |
| `loop-test.ps1` | healthy boot snapshot → break → 3 guarded runs → rollback loop (anti-loop path) |

- Fully location-independent: paths derive from `$PSScriptRoot`; the checkout comes from `$env:QAQ_SMOKE_DSH_HOME` (falling back to a sibling `deepseek-harness`).
- Breaking the profile: add the `dsh-broken-theme` bundle to package.json + a `link:` dependency + a junction to `qaq-test-plugins/dsh-broken-theme`. **Write files without a BOM** (DSH's YAML parser chokes on BOM).

---

## 5. Fault-injection fixture (qaq-test-plugins/dsh-broken-theme)

- Host half: `apply()` is empty (keeps the entry resolvable).
- Client half: declares `dsh.client.inject: ["theme"]` but **never provides that service** → deterministic red screen `web boot: 1 entry did not activate dsh-broken-theme: pending (waiting for service: ...)`.
- Purpose: make the guard's UI-failure line reproducibly trigger on a real DSH instance.
- Its `lib/` (index.js + client.js + sourcemap) is **intentionally committed** (unlike the shipped
  dsh-qaq plugin's `lib/`, which is generated): the real-DSH harness loads this fixture directly from
  the checkout with no build step, so prebuilt output must be present. Rebuild with
  `node qaq-test-plugins/dsh-broken-theme/scripts/build.mjs` after editing the fixture source.

---

## 6. A complete real-DSH verification pass

```
1. Isolated home, seed a healthy profile (bundles = base + web-app, patch = [])
2. qaq install-plugin --profile web    # mount dsh-qaq (verify the bundle layer loads)
3. qaq dsh web --yes --port <N>        # healthy boot: expect lastSuccess + snapshot on disk
4. inject dsh-broken-theme → 3 boots   # expect uiFailures 1→2→3 → rollback → healthy restart
5. verify state.json / latest-good / history / rolled-back / access.log
```

---

## 7. Adding tests

- **Criteria / pure functions** → `detector-ui.spec.ts` / `store.spec.ts` (direct assertions).
- **Filesystem-scoped side effects** → `plugin-manager.spec.ts` (junction modules + manifest edits in an isolated temp home; no process spawned, nothing outside the home).
- **UI layout (pure, no TTY)** → `tui.spec.ts` (`buildFrame` + `computeLogWindow`). Keep the fiddly scroll/slice math in a pure exported helper so it stays unit-testable.
- **Orchestration / timing** → `guard.spec.ts` (mock dependencies; assert classification + kill + state side effects).
- **Filesystem side effects** → isolate the home with `mkdtempSync`, clean up in `beforeAll/afterAll`.
- **Browser/CDP paths without a real browser** → `cdp-retry.spec.ts` / `watch-once.spec.ts` (mock `launchSession` / `detectUi`; assert retry budgets and decision paths).
- **Real processes** → the `spawn-dsh.spec.ts` pattern (short-lived child + real exit-code assertions); `webhook.spec.ts` spins up a throwaway `node:http` server for true delivery.
- **End to end** → extend `smoke.mjs` (isolated-home flow) or `rollback-test.ps1` (real DSH).

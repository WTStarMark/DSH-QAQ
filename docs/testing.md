# Testing & Real Integration (test/ · tools/ · qaq-test-plugins/)

This document dissects the quality-assurance system: the unit-test matrix, the smoke regression, the real-DSH integration loop, the fault-injection fixture, and how to add tests for new features.

Related: [Architecture Overview](architecture.md)

---

## 1. Test commands

```bash
pnpm test      # vitest run — 8 spec files, 42 cases
pnpm smoke     # one-shot regression: unit tests + seed/broken/detect in an isolated home
pnpm typecheck # tsc --noEmit
```

---

## 2. Unit-test matrix (test/)

| File | Coverage | Key cases |
|------|----------|-----------|
| `store.spec.ts` | state I/O, atomicity, snapshots, lock | corrupt state falls back to default; prune keeps 5; manifest records the real profile name (regression); lock exclusion and release |
| `rollback.spec.ts` | rollback engine | no trigger below threshold; backup + restore on trigger; fence blocks a second rollback; no trigger without a snapshot; decline does not overwrite; recordSuccess clears counters + fence + snapshots |
| `guard.spec.ts` | orchestration (mocked spawn/detect) | an un-settled UI must kill the child (leak regression); a degraded confirmation is never recorded as last-good; **a host crashing after binding is host, not unknown (classification regression)**; retriesExhausted semantics |
| `spawn-dsh.spec.ts` | real child readiness tracking | an early exit before the port opens rejects `ready` immediately with the real code; a missing command rejects without waiting out the timeout |
| `detector-ui.spec.ts` | L3 criteria | red-screen text → failed with detail/failedEntries; healthy composer → ok; boot page → loading; **0ms timeout still probes at least once (confirm-ms 0 regression)** |
| `env.spec.ts` | environment discovery | findCheckoutCli / QAQ_DSH_CMD / --cwd checkout / **sibling auto-discovery (qaq-web.cmd layout)** / isPortFree |
| `install-plugin.spec.ts` | plugin mounting | graceful failure on an uninitialized profile; real mount is idempotent + **user patch untouched**; plugin-dir resolution |
| `log.spec.ts` | logging | JSON line format, error double-write, access channel, `.in()` category, size-based rotation |

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
- **Orchestration / timing** → `guard.spec.ts` (mock dependencies; assert classification + kill + state side effects).
- **Filesystem side effects** → isolate the home with `mkdtempSync`, clean up in `beforeAll/afterAll`.
- **Real processes** → the `spawn-dsh.spec.ts` pattern (short-lived child + real exit-code assertions).
- **End to end** → extend `smoke.mjs` (isolated-home flow) or `rollback-test.ps1` (real DSH).

# Guard Lifecycle (guard.ts)

This document dissects the orchestration in `src/guard.ts`: the full path of one supervised `dsh web` boot, from spawn to confirmed health / counted failure.

Related: [Architecture Overview](architecture.md) · [State & Rollback](state-and-rollback.md) · [UI Detection](ui-detection.md)

---

## 1. Core types

```ts
interface GuardOptions {
  home?: string          // DSH home (default resolveDshHome())
  profile?: string       // profile name (default 'web')
  command: string[]      // dsh launch command, e.g. ['dsh','web']
  cwd: string            // child working directory (checkout root)
  port?: number          // port (default 3080)
  dshEnv?: Record<string, string | undefined>
  autoConfirm?: boolean  // skip rollback confirmation
  uiTimeoutMs?: number   // UI probe budget (default 25000)
  portTimeoutMs?: number // port-readiness budget (default 30000)
  confirmGoodMs?: number // stable-healthy confirmation window (default 20000)
  retries?: number       // transient-failure tolerance retries (CLI sets 1)
  threshold?: number     // same-kind failures that trigger a rollback (default 3)
}

type BootVerdict =
  | { ok: true; supervisor: DshSupervisor; url: string }          // healthy; child still running
  | { ok: false; failureKind: 'host' | 'ui' | 'unknown';
      error?: string; rolledBack: boolean;
      rollbackCancelled?: boolean; retriesExhausted: boolean }    // failed
```

---

## 2. `bootAttempt()` — a single attempt

One attempt returns a raw verdict without counting or rolling back:

```
spawnDsh({ command, cwd, env: {...dshEnv, DSH_HOME}, port })
  │
  ├─ ready rejected (port timeout / spawn failure / exited before port opened)
  │     → wait up to 1.5s for an exit code → kill the child → { kind: 'host', error: ... }
  │
  ├─ detectUi(url, uiTimeoutMs)
  │     ├─ throws               → kill → { kind: 'unknown', error: 'UI detector failed' }
  │     ├─ kind === 'failed'    → kill → { kind: 'ui', error: failureDetail }
  │     ├─ kind !== 'ok' and the child died / emitted a fail-loud marker
  │                             → kill → { kind: 'host', error: 'host exited during UI probe' }
  │     └─ kind !== 'ok'        → kill → { kind: 'unknown', error: 'UI did not settle' }
  │
  └─ kind === 'ok' → { kind: 'ok', supervisor } (child kept, handed to the caller)
```

### Classification edge cases (found through real-DSH integration)

- **Crash before the port opens**: `ready` rejects → `kind: 'host'` (correct).
- **Crash after binding the port** (boot-stage error, e.g. the user patch references a missing package): `ready` already resolved, but the UI probe never sees a healthy page. You must check `supervision.child.exitCode !== null || supervision.hasHostFailureMarker()` here — otherwise it is misclassified as `unknown` (never counted, never rolled back). This was a real bug caught by integration testing and is pinned by a regression test.

---

## 3. Transient retry (`isTransient`)

```ts
function isTransient(attempt): boolean {
  if (attempt.kind === 'host') return true      // host-not-ready / early exit is usually retriable
  if (attempt.kind === 'unknown') return true   // UI not settled is retriable
  // Only bundle-load flakes among UI failures count as transient
  return /bundle script .* failed to load/.test(e) || /import failed/.test(e)
}
```

- Before every retry, the previous failed child has **already been killed** inside `bootAttempt` — a failed boot never leaks a process that holds the port.
- Loop: `for (attempt = 0; attempt <= retries; attempt++)`; breaks when retries run out or a non-transient failure occurs.
- `retriesExhausted` semantics: **true only when the tolerance retries were actually used up** (a genuine red screen is non-transient, so an early exit leaves it false).

---

## 4. Confirmation window (`confirmStable`)

The "trust before snapshotting" gate that prevents recording a boot that turned bad right after first health:

1. `sleep(confirmGoodMs)` (default 20s)
2. If `supervisor.child.exitCode !== null` → the host exited during the window → host failure
3. Probe the real DOM once more with `detectUi(url, min(confirmGoodMs, 15000))`:
   - `ok` → confirmed
   - `failed` → ui failure
   - anything else / throws → unknown

> Edge case `--confirm-ms 0`: the probe budget is clamped to at least 1ms, and `pollUi` uses a do-while that **always probes at least once** — otherwise a 0ms budget would immediately return an error and misjudge a healthy boot (fixed and tested).

---

## 5. `superviseBoot()` — the orchestrator

```ts
for (attempt = 0; attempt <= retries; attempt++) {
  last = await bootAttempt(opts)
  if (last.kind === 'ok') {
    confirmed = await confirmStable(...)
    if (confirmed.ok) {
      recordSuccess(...)            // clear counters, clear fence, write latest-good + history
      return { ok: true, supervisor, url }
    }
    kill(); last = failed verdict
  }
  if (attempt < retries && isTransient(last)) continue
  break
}

// Wrap-up: count and decide rollback
if (kind === 'host' || kind === 'ui') {
  incrementFailure(...)             // same-kind +1, other kind reset; writes lastFailure
  rolled = await maybeRollback(...) // see state-and-rollback.md
  return { ok: false, ..., rolledBack, rollbackCancelled, retriesExhausted }
}
return { ok: false, failureKind: 'unknown', ... }   // unknown is not counted
```

---

## 6. Misc

- **`ensurePortFlag`**: respects an existing `--port <value>` in the command; completes a bare trailing `--port`; otherwise appends `--port <port>`.
- **Child output**: with `attachStdio: false`, output flows through `onOutput` into `host.log` and is mirrored to the visible window; `hasHostFailureMarker` matches the fail-loud keywords `plugin tree failed to load` / `failed to load plugin` / `cannot get property` / `unhandled exception` (case-insensitive).
- **Ownership contract**: on health the child is handed to the caller (`cli.ts` awaits `supervisor.exit` to keep the process alive and wait for exit); every failure path has already killed the child inside `bootAttempt`.

---

## 7. Modification guide

- New failure shape → extend the classification in `bootAttempt` and add a `guard.spec.ts` regression test (mock `spawnDsh` / `detectUi`, assert the classification and the kill behavior).
- Retry policy changes → touch only `isTransient` and the `retries` argument; `guard.spec.ts`'s "non-transient failure stops the loop early" case pins the semantics.

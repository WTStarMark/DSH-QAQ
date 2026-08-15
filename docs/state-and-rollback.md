# State Storage & Rollback Engine (store.ts / rollback.ts)

This document dissects the persistence design: the `~/.dsh/.qaq/` directory, atomic writes, the PID-aware lock, snapshot management, and the complete decision chain of the rollback engine.

Related: [Architecture Overview](architecture.md) · [Guard Lifecycle](guard-lifecycle.md)

---

## 1. Directory & files

```
$DSH_HOME/.qaq/                  # qaqDir(home)
├── state.json                   # guard state (atomic write)
├── .guard.lock                  # PID-aware guard lock
├── latest-good/                 # last confirmed-healthy config copy
│   ├── package.json
│   ├── cordis.patch.yml
│   └── manifest.json            # { profile, ts }
├── history/<ts>/                # timestamped history snapshots (keeps at most 5, each with a manifest)
├── rolled-back/<ts>/            # broken config preserved before a rollback (with a manifest note)
└── log/                         # see logging.md
```

`$DSH_HOME` resolution: the `$DSH_HOME` env var → fallback `~/.dsh` (`src/paths.ts`).

---

## 2. state.json structure

```jsonc
{
  "version": 1,
  "profiles": {
    "web": {
      "hostFailures": 0,           // consecutive host failures
      "uiFailures": 0,             // consecutive ui failures (same kind +1, other kind reset)
      "lastSuccess": "ISO-8601",
      "lastFailure": { "kind": "host|ui", "ts": "...", "error": "..." },
      "lastGoodSnapshot": "history/<ts>",   // this profile's last-good snapshot reference
      "rolledBackAt": "ISO-8601"   // anti-loop fence marker; cleared on a successful boot
    }
  },
  "config": { "autoConfirm": false }
}
```

- **Atomic write**: write `<path>.tmp` first, then `renameSync` over it — a crash never leaves a half-written state.
- **Read tolerance**: missing / corrupt / schema-mismatched file → returns the default empty state (never throws).
- Counter semantics: `incrementFailure` does **same kind +1, other kind reset**, so "consecutive same-kind failures" stays meaningful.

---

## 3. Guard lock (`acquireLock`)

- The lock file holds the owner's PID.
- On acquire, if the lock exists: check whether the recorded PID is alive (`process.kill(pid, 0)`, ESRCH = dead):
  - alive → throw "another guard instance is running";
  - dead (crash leftover) → treat as stale, remove, and take over — **automatic recovery after a crash**.
- Returns a release function, called on the normal exit path. A force kill (window close) leaves the lock, but the next run reclaims it via the PID liveness check.

---

## 4. Snapshot management (store.ts)

| Function | Behavior |
|----------|----------|
| `writeSnapshot` | copies `package.json` (+ `cordis.patch.yml`) into a snapshot dir, writes `manifest.json` |
| `listSnapshots` | lists subdirectories **that contain `manifest.json`** (valid snapshots), sorted by ISO timestamp name (lexicographic == chronological, deterministic across restarts) |
| `pruneSnapshots` | keeps the newest N, removes the rest |
| `restoreSnapshot` | copies the snapshot's `package.json` / `cordis.patch.yml` back into the profile dir |
| `isUsableSnapshot` | has a `package.json` → usable |

> Note: **restore only overwrites files; it does not delete files the broken config added** (a deliberate, acceptable trade-off).

---

## 5. Rollback engine (rollback.ts)

### 5.1 `maybeRollback(ctx)` decision chain

```
threshold: same-kind count < threshold (default 3) → do not trigger
anti-loop fence: rolledBackAt within the last 5 minutes → do not trigger (guide manual fix)
last-good resolution:
  prefer state.lastGoodSnapshot (history/<ts>)
  else latest-good/ (only when its manifest.profile matches the current profile, to prevent cross-profile misuse)
  neither → do not trigger (advise booting successfully once first)
back up the broken config: copy the current profile config to rolled-back/<ts>/ (+ a manifest note)
confirmation (unless autoConfirm):
  print an LCS line diff (current vs last-good) for preview
  Y/N → declining returns cancelled (no overwrite, no restart)
apply: restoreSnapshot → write rolledBackAt → access.log → return restored
```

### 5.2 Anti-loop fence

- `ANTI_LOOP_MS = 5 * 60 * 1000`.
- After a rollback, if the restart still fails, the fence blocks another rollback for 5 minutes (no cascading rollback/restart).
- **A successful boot clears the fence** (`recordSuccess` deletes `rolledBackAt`) — a real success stands the guard down.
- Edge: a malformed `rolledBackAt` makes `Date.parse` return NaN, and the fence is treated as inactive (a corrupt datum must not silently disable the fence; the operator repairs state.json).

### 5.3 `recordSuccess`

Zero both counters → update `lastSuccess` → clear the fence → write `latest-good/` + `history/<ts>/` (each with a manifest) → update `lastGoodSnapshot` → keep 5 history copies → access.log.

---

## 6. Manual commands (cli.ts)

| Command | Behavior |
|---------|----------|
| `qaq backup` | snapshots the current profile config as last-good (reuses `recordSuccess`) |
| `qaq restore --to <snapDir>` | restores the profile from any snapshot dir (`manualRestore`) |
| `qaq reset` | zeroes the counters, removes `lastFailure` (access.log) |
| `qaq status` | prints the state summary as JSON |

---

## 7. Modification guide

- Snapshot content changes → update `store.ts writeSnapshot`, `packages/dsh-qaq/src/index.ts`, and the manifest validation together.
- Rollback trigger policy → touch only the `maybeRollback` decision chain; `test/rollback.spec.ts` covers threshold, fence, missing snapshot, user decline, and success bookkeeping.
- New fields → sync the `QaqState` / `ProfileState` types and the `readState` schema check so old state files never break the reader.

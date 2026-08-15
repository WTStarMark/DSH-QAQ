# Logging System (src/log.ts)

This document dissects the structured logger: the record format, the four file channels, size-based rotation, and how developers use it during troubleshooting.

Related: [Architecture Overview](architecture.md)

---

## 1. Record format

One JSON line per record:

```jsonc
{ "ts": "2026-08-15T02:18:12.645Z", "level": "info", "cat": "qaq",
  "phase": "boot", "msg": "host + UI healthy; confirming for 20000ms",
  "profile": "web", ...meta }
```

- `ts`: ISO-8601 UTC; `level`: info / warn / error;
- `cat`: log category (qaq / rollback / ...); `phase`: optional stage (boot / confirm / rollback / restart);
- extra meta key-values (profile, kind, action, snapDir, ...) are attached by the caller; `undefined` values are dropped.
- Single-line JSON is easy to machine-parse with `Select-String` / `jq`.

---

## 2. The four file channels (`$DSH_HOME/.qaq/log/`)

| File | Content | Use |
|------|---------|-----|
| `qaq.log` | everything (info + warn + error) | canonical record |
| `error.log` | warn/error only | fast problem grep |
| `access.log` | crash-audit trail | boot verdicts, snapshots, rollbacks, resets, plugin mounts, manual restores — the only complete trail of state changes |
| `host.log` | raw supervised dsh stdout/stderr | inspecting dsh's own output; line format `level ts content` |

Write policy:
- `info/warn/error`: writes `qaq.log`; warn/error also write `error.log`; `access()` additionally writes `access.log` and mirrors to stdout.
- `host()`: child output is timestamped per line into `host.log` and mirrored to the visible window (error → stderr, rest → stdout).

---

## 3. Rotation (size-based)

- Threshold `ROTATE_BYTES = 256 KB`; keeps `KEEP_FILES = 5` copies.
- Sequence: `qaq.log → qaq.1.log → qaq.2.log …`; copies beyond 5 are deleted.
- Implementation: `sizes`/`lastCheck` do incremental byte tracking (stat roughly every 64 KB); `rotateFile` shifts with `renameSync` and prunes with a regex over the directory.
- **Rotation is best-effort**: any exception is swallowed and never affects the business.

---

## 4. Logger entry conventions

```ts
const log = new Logger(home)          // empty/whitespace home falls back to resolveDshHome()
log.info('...') / log.warn('...') / log.error('...', meta)
log.access('state change', { profile, action })   // audit trail
log.host(chunk, 'stdout' | 'stderr')          // raw child output
log.in('rollback') / log.at('rollback')       // derived category/stage loggers
```

> **Empty-home fallback** is a hard guard: `new Logger('')` would resolve `.qaq` relative to the cwd and pollute the working directory (`rollback.spec.ts` used to trigger this via a module-level constructor; fixed and commented).

---

## 5. Troubleshooting guide

| Scenario | Where to look |
|----------|---------------|
| Boot verdict / whether a rollback happened | `access.log` |
| Errors and warnings | `error.log` |
| dsh's own behavior / output before a red screen | `host.log` |
| Full timeline | `qaq.log` (with the `phase` field) |
| Inside the console | `qaq console` → [7] |

Example (PowerShell):

```powershell
# recent rollbacks
Select-String -Path "$HOME\.dsh\.qaq\log\access.log" -Pattern 'rolled back' | Select-Object -Last 5

# the full trail of one boot (filter by phase)
Get-Content "$HOME\.dsh\.qaq\log\qaq.log" | ConvertFrom-Json | Where-Object { $_.phase -eq 'boot' }
```

---

## 6. Modification guide

- New channel → extend `LogChannel` and `filePathFor`, and update the channel table above.
- Rotation tuning → touch only the `ROTATE_BYTES` / `KEEP_FILES` constants.
- New fields → the `LogRecord` index signature already accepts arbitrary meta; callers just pass them.
- Tests: `test/log.spec.ts` covers the structured format, error double-write, the access channel, `.in()` categories, and rotation.

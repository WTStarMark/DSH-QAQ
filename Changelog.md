# Changelog

QAQ — DeepSeek Harness launch resilience guard. All notable changes are documented here, derived from the git history.

Format follows [Keep a Changelog](https://keepachangelog.com/) — each release is grouped into **Added / Fixed / Changed / Removed**.

## [0.5.5] — 2026-08-21 · Web GUI, DSH source-level update & version alignment

### Added
- **DSH version detection** (`src/dsh-version.ts`): resolve the managed DeepSeek Harness version from the source checkout manifest (or an optional `dsh --version` exec for PATH/npm installs); new `qaq dsh-version` command.
- **Full semver comparison incl. prerelease** (`src/update.ts` `parseSemver`/`compareSemver`): `0.1.0-rc.10 > 0.1.0-rc.9`, prerelease < release — mirrors DSH's own release-tooling rules (the old triple-only comparison could miss rc-level updates).
- **Source-level DSH update machine** (`src/dsh-update.ts`): plan (read-only preflight + lossless snapshot) → apply (switch → `pnpm install --frozen-lockfile` → `pnpm build` → version verify) with automatic rollback (`git checkout --force` to the recorded commit) on any failure; refuses while DSH is running (heartbeat/busy port); never runs `git clean`, never touches untracked/ignored data (node_modules, `.env`, `.sessions`, `.storages`); local tracked modifications are archived as diffs under `~/.dsh/.qaq/update/backup-<ts>/` before switching.
- **Remote tag check**: `fetchDshLatestTag`/`checkDshUpdate` via the public GitHub tags API (injectable fetch, offline-safe).
- **CLI**: `qaq dsh-update --check|--apply [--tag dsh-vX] [--cwd] [--yes]`.
- **TUI**: menu [11] now checks BOTH QAQ and the managed DSH; the header shows the DSH version; a second press applies the DSH source-level update in-place (staged progress), or downloads QAQ's source archive as before.
- **Web GUI (`qaq web` / `qaq serve`)**: a local HTTP + WebSocket console (`src/web.ts`) that reuses all existing modules — status overview, launch/stop the guard, backup/restore, reset counters, mount dsh-qaq, plugin management (enable/disable/install/uninstall), log viewer (error/access/host/qaq), sideload watch, hot-update channels, version check (QAQ + DSH). The frontend (`public/web/`) **strictly reuses DSH's `--dsw-*` design tokens, font stack, easing and the `body[data-ds-dark-theme]` light/dark theme** (light/dark/system) for a unified look with the DSH web GUI; binds `127.0.0.1:3090` by default, owns the guard lock + supervised child (the `qaq tui` role), and releases the lock + stops the supervised child on Ctrl+C.

### Changed
- `qaq tui` header: `QAQ vX · DSH vY`.
- **Version alignment**: folded the unreleased `0.4.6`; `package.json` and `packages/dsh-qaq/package.json` unified at `0.5.5`.

### Tests
- `test/dsh-version.spec.ts`, `test/dsh-update.spec.ts` (plan refusals, lossless snapshot archive, apply success / stash-before-switch / verify-mismatch rollback / install-failure rollback / frozen-install conservatism); `test/update.spec.ts` gains full-semver ordering cases.

## [0.4.5] — 2026-08-21 · guard double safeguard: loaded-config fingerprint gate & anti-loop walk-back rollback

### Added
- **last-good config-fingerprint gate**: `recordSuccess` only blesses a config as last-good when the fingerprint of what the RUNNING DSH actually loaded equals the fingerprint of the on-disk config being snapshotted. The dsh-qaq plugin reports, once at boot, the fingerprint of the profile config it consumed (`loadedFingerprint` in plugin-state.json), closing the exact pollution bug that recorded `dsh-broken-theme` as last-good while the live process was still healthy on the OLD config. A mismatch refuses the blessing and pushes a `config-not-verified` event.
- **anti-loop walk-back rollback**: when the restored last-good is itself the failure source (still red-screening after restore), the anti-loop fence no longer hard-blocks: the guard walks back to OLDER valid snapshots step by step (`rollbackEscalation` offset, capped by `MAX_ESCALATION_STEPS`) until a bootable config is found or no older snapshot exists (then the fence holds). Wired into both the launcher `cmdDsh` restart loop and the sideload `watch` path.

### Changed
- `ProfileState` gains `rollbackEscalation` (store.ts); `maybeRollback` supports `allowEscalation` and offset-based selection from an ordered VALID snapshot list; `recordSuccess` gains an optional verifier gate (both guard and watch call sites pass `liveBootMatches`).
- New `src/verify-config.ts` (CLI-side fingerprint + three-way match); `PluginState` gains `loadedFingerprint` (shared-io.ts).
- Versions aligned to `0.4.5` (`package.json` / `packages/dsh-qaq/package.json`).

### Tests
- Added `verify-config.spec.ts` (fingerprint algorithm, `liveBootMatches` three states, `recordSuccess` gate refuse/allow) and `escalation.spec.ts` (walk-back to older snapshot, fence intact without opt-in, stop with no older snapshot, success clears walk-back); `plugin.spec.ts` gains a plugin-CLI fingerprint parity case.

---
## [0.4.4] — 2026-08-18 · version update check (Beta) & version alignment

### Added
- Version update check (Beta): the TUI shows the local version in the header, gains a "Check for updates (Beta)" menu item, and shows "- new update vX.X.X" in the status area when a newer release exists on GitHub (<https://github.com/WTStarMark/DSH-QAQ>).
- Confirmed-update flow: pressing the item again after an update is found downloads the latest master source archive into `~/.dsh/.qaq/update/` and prints the upgrade steps (`qaq setup`).

### Changed
- Version alignment: `package.json` and `packages/dsh-qaq/package.json` bumped from `0.1.0` to `0.4.4`.

---

## [0.4.3] — 2026-08-18 · docs restructure & hardening

### Changed
- Renamed READMEs: `README.zh.md` → `README.md` (default, Chinese), `README.md` → `README.EN.md` (English); cross-links updated.
- `qaq tui` is now the recommended daily driver in both READMEs (all-in-one dashboard: launch, logs, plugins, hot update, sideload watch).
- `qaq setup` now enforces pnpm >= 11 (falls back to `npx pnpm@11` when the local pnpm is missing or older) — an older pnpm would ignore the `allowBuilds` key and break esbuild's postinstall.
- Stale docs corrected (deleted launcher scripts, GBK encoding note, test counts, `qaq-web.cmd` references).

### Added
- Bilingual changelog (`Changelog.md` / `Changelog.zh.md`) curated from the git history, grouped by Added / Fixed / Changed / Removed.
- Dependency-free style gate: `pnpm lint` (`scripts/check-style.mjs`), `.editorconfig`, and a CI style-check step.
- Browser discovery: `QAQ_CHROME` / `CHROME_PATH` env overrides and a `$PATH` scan fallback in `findBrowser`.
- i18n guard test: `en` / `zh` dictionaries must stay key-for-key in sync.

### Fixed
- Guard-lock TOCTOU race: the lock is now created atomically with the `wx` (O_EXCL) flag, so racing guard instances serialize; stale-lock reclaim uses the same atomic create.
- `README.md` broken nested code fence (swallowed text rendered as one block).
- 17 source files missing a final newline.

### Removed
- `github-repo-stats` traffic-report workflow (`.github/workflows/github-repo-stats.yml`).

---

## [0.3.3] — 2026-08-17 · guard hardening

### Added
- Snapshot validation before every rollback — a corrupt snapshot is never restored; a broken state pointer falls back to the newest valid auto snapshot (`f44d726`).
- Environment/dependency failures (`EPERM`, `ERR_MODULE_NOT_FOUND`, unsupported engine…) classified as `env`: never counted, never rolled back, actionable hint instead (`f44d726`).
- Non-red-screen degradation signals: enabled plugins whose fiber ended in `failed` state, and console errors sampled during the probe, raise a `ui-degraded` advisory (never counted) (`f44d726`).
- CI: `github-repo-stats` traffic report workflow (read-only token, report as artifact) (`b0c5f24`, `b917bb0`).

---

## [0.2.3] — 2026-08-17 · plugin hot-update

### Added
- Plugin hot-update, three channels, all off by default (`a23f560`):
  - **client bundle live-reload watch** — hot-swaps `lib/client.js` via DSH client-HMR, with CDP re-probe verification and file-level rollback (snapshots under `~/.dsh/.qaq/hot-snapshots/`);
  - **bundle-list change auto-restart** — profile bundle changes trigger a supervised restart;
  - **web dist change auto-restart** — rebuilt `apps/web/dist` triggers a supervised restart.
- dsh-qaq auto-mount when the TUI opens, plus a manual re-mount/overwrite entry (junction-target validation, orphan-link repair, user-data protection) (`a23f560`).

---

## [0.1.3] — 2026-08-17 · backup policy & rollback hardening

### Added
- TUI backup manager: auto vs manual backup groups with independent retention (10 auto / 3 manual) (`65e06af`).
- Bilingual UI screenshots (en/zh) in the READMEs (`548e41d`).

### Changed
- Backup policy hardened: auto backups (guard-confirmed health / plugin real-conversation) and manual backups (`qaq backup` / TUI `[3]`) kept in separate sets with independent quotas (`65e06af`).
- Deterministic UI red screens (`did not activate … waiting for service`) now roll back on the first hit instead of waiting out the threshold (`65e06af`).

---

## [0.0.3] — 2026-08-15 · publish prep

### Added
- Bilingual README + LICENSE, repository tidied for GitHub (`b648fe7`).
- `.nvmrc` pin and cross-OS CI workflow (ubuntu + windows × Node 22/24, frozen lockfile) (`f8404ba`).
- Bilingual developer docs: English at default names, Chinese kept at `*.zh.md` (`9dac589`); 7 deep-dive docs (architecture / guard-lifecycle / state-and-rollback / ui-detection / console-and-env / logging / testing) indexed from the README (`823ae4f`).

### Fixed
- `dist` ESM bundle crashed on startup; dsh-qaq plugin made zero-runtime-dependency (no `@deepseek-ai` import at runtime) (`12a9dcf`, PR #1).

### Changed
- Project attributed to WTStarMark (LICENSE, package metadata, README) (`5224e0d`).
- 「傻瓜式」 renamed to 「懒人脚本」 (`c1edf42`); repo layout rendered as a table, stale docs section dropped (`11124a5`).
- Bilingual launchers split into en + zh variants; zh-CN docs renamed to `.zh` (`5336773`).

### Removed
- Prototype/duplicate copy of the project (6 files, 1414 lines) (`e5a19a0`).
- 3 planning documents (design/plan drafts) replaced by the developer deep-dives (`823ae4f`).

---

## [0.0.2] — 2026-08-15 · refinement & bug fixes

### Added
- Transient-failure retry (`retries=1`) so one-off Windows flakes don't advance the failure counters (`7a0a262`).
- Rollback diff preview before the Y/N confirmation; tunable `--confirm-ms` / `--ui-timeout` / `--threshold` (`7a0a262`).
- One-click console, environment auto-discovery, plugin installer, structured logs (`aed6a8d`).
- Edge browser candidates for the UI probe (`ba81d11`).
- Auto-discovery of a sibling DSH checkout next to the cwd (`645e59a`).

### Fixed
- Guard leaks/hangs: unsettled children now killed, robust readiness, DOM re-probe before snapshotting (`3426faf`).
- Rollback correctness: snapshot manifest records the real profile; a declined rollback is honoured (`1b2bd48`).
- Launcher encoding: `.cmd` files saved as GBK/CP936 so the Chinese banner renders on zh-CN cmd (`4604068`).
- Console clears the screen before every menu render; redundant banner removed (`94d3cc7`).
- Logger hardened against an empty home; integration scripts made location-independent (`7e9f585`).
- Loop-test profile written without a BOM (`7ee6219`).

### Changed
- READMEs document the new guard behavior (`e26b0ec`).

---

## [0.0.1] — 2026-08-15 · Initial release

### Added
- Launch resilience guard core (M1–M6): supervised `dsh web` startup, host + UI failure detection via headless Chrome/CDP reading the real DOM, failure counting, rollback to last-good, anti-loop fence (`797aa53`).
- `dsh-qaq` backup plugin: writes the last-good snapshot only after a real user conversation; presence heartbeat (`797aa53`).
- Interactive console (lazy-script CMD menu), structured multi-file rotating logs (qaq / error / access / host), state store with atomic writes and snapshot management (`797aa53`).

---

[English](./Changelog.md) · [简体中文](./Changelog.zh.md)

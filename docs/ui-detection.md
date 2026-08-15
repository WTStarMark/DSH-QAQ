# UI Detection & CDP (cdp.ts / detector-ui.ts)

This document dissects the L3 UI-detection line: why the real DOM is read, the dependency-free CDP client, the text criteria, the probe timing, and browser discovery.

Related: [Architecture Overview](architecture.md) · [Guard Lifecycle](guard-lifecycle.md)

---

## 1. Why read the real DOM

DSH Web has a "host alive, UI red-screened" failure mode: the process is up, the port responds, `curl` returns HTML — yet the browser renders `Failed to load plugins`. Reason: the server-side HTML ships an empty `<div id="root">` that React fills at runtime, and the red-screen structural classes are CSS-Module hashes (`_boot_<hash>`) that are unstable across builds.

**Conclusion**: the only reliable, non-invasive probe is to open the page in a headless browser and read `document.body.innerText`.

---

## 2. Dependency-free CDP client (src/cdp.ts)

Zero Playwright/Puppeteer; the only runtime dependency is `ws`:

```
launchSession({ debugPort })
  ├─ findBrowser(): walk a candidate list for Chrome/Chromium/Edge
  │    (Windows ProgramFiles/LOCALAPPDATA + POSIX /usr/bin + macOS /Applications),
  │    each candidate verified with existsSync
  ├─ spawn a dedicated headless Chrome:
  │     --headless=new --remote-debugging-port=<port> --remote-allow-origins=*
  │     --user-data-dir=<temp dir> --no-first-run --disable-gpu about:blank
  ├─ poll GET /json until a page target's webSocketDebuggerUrl is available (15s cap)
  └─ return a CdpSession (evaluate/close)
```

- `evaluate(expr)`: `Runtime.evaluate` + `returnByValue`; exceptions/errors return `null` (defensive).
- `close()`: `Browser.close` → close WS → kill the browser process → remove the temp user-data dir (the caller must close).
- **Debug-port collision**: random ports in 9000–9899; on a collision `detectUi` retries with another port (up to 3 times); an explicitly given port is never retried.

---

## 3. DOM probe & text criteria (src/detector-ui.ts)

### 3.1 Probe script (injected per evaluate)

```js
const bodyText = document.body ? document.body.innerText : '';
hasComposer = root.querySelector('textarea') !== null;   // hallmark of a settled healthy UI
isBootPage  = bodyText.includes('HARNESS') && !hasComposer; // boot card (wordmark, no composer)
return { bodyText: bodyText.slice(0, 1200), hasComposer, isBootPage };
```

### 3.2 Classification priority (`classifyDom`)

```
1. bodyText contains "Failed to load plugins" (FAILED_MARKER) → kind='failed' (red screen, wins)
2. hasComposer                                        → kind='ok' (healthy)
3. isBootPage                                         → kind='loading' (still booting)
4. anything else (assets not loaded yet)               → kind='loading'
```

### 3.3 Failure-detail extraction

- `extractFailureDetail`: regex-grabs the `web boot:...` line (e.g. `web boot: 1 entry did not activate dsh-x: pending (waiting for service: y)`).
- `parseFailedEntries`: parses the missing plugin/service names (Format A inline single-entry + Format B per-line sweeper report, deduplicated).

---

## 4. Probe timing (pollUi / detectUi)

```
detectUi(url, timeoutMs, port=0)
  ├─ pick the debug port (random by default; retry ≤3 times on collision)
  ├─ launchSession → pollUi
  │     pollUi: evaluate("window.location.href = <url>")  → navigate to the target
  │             do { probeOnce(); return immediately on failed/ok; sleep(500) }
  │             while (elapsed < timeoutMs)
  │             → on timeout, return the last verdict (or error)
  └─ finally close the session
```

- **Probe at least once** (do-while): a 0ms budget (`--confirm-ms 0`) must still yield one real DOM read, or it would be misjudged as an error.
- `probeOnce` reuses the same browser session (no repeated Chrome launches); timeouts/exceptions always go through `session.close` cleanup.

---

## 5. Criteria maintenance points

| Point | Note |
|-------|------|
| `FAILED_MARKER` | Pinned red-screen text, stable across builds (DSH AppRoot.tsx). If DSH changes the copy, this is the single place to sync |
| `<textarea>` as health | Empirically the web profile's composer container; if the UI drops the textarea, swap in an equivalent business-container criterion |
| No CSS class selectors | Structural classes are hashes, unstable across builds (design red line) |
| bodyText truncation | 1200-char budget — plenty for the failure detail (`web boot:` + 400 chars) without shipping huge DOMs |

---

## 6. Modification guide

- New criteria → change `DOM_PROBE` + `classifyDom`, add `test/detector-ui.spec.ts` cases (including the 0ms-probe regression).
- Different browser binary → touch only the `cdp.ts findBrowser` candidate list (keep the existence-probe pattern; never hardcode one path).
- CDP protocol upgrades → encapsulated in `CdpsSessionImpl.cmd()`; the business layer only touches `evaluate/close`.

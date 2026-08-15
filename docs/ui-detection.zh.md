# UI 检测与 CDP（cdp.ts / detector-ui.ts）

本文件解析 L3 UI 检测线：为什么需要真实 DOM、无依赖 CDP 客户端、文本判据、探测时序与浏览器发现。

相关文档：[架构总览](architecture.zh.md) · [守卫生命周期](guard-lifecycle.zh.md)

---

## 1. 为什么是"读真实 DOM"

DSH Web 存在"宿主活、UI 红屏"的失败形态：进程在、端口通、`curl` 拿得到 HTML，但浏览器渲染出
`Failed to load plugins`。原因：服务端 HTML 里 `<div id="root">` 是空的，由 React 运行时填充；
而红屏的结构类名是 CSS-Module hash（`_boot_<hash>`），跨构建不稳定。

**结论**：唯一可靠且非侵入的探测 = 用 headless 浏览器打开页面、读取 `document.body.innerText`。

---

## 2. 无依赖 CDP 客户端（src/cdp.ts）

零 Playwright/Puppeteer，运行时只依赖 `ws`：

```
launchSession({ debugPort })
  ├─ findBrowser()：按候选清单找 Chrome/Chromium/Edge（Windows ProgramFiles/LOCALAPPDATA
  │    + POSIX /usr/bin + macOS /Applications），每个候选 existsSync 验证
  ├─ spawn 专用 headless Chrome：
  │     --headless=new --remote-debugging-port=<port> --remote-allow-origins=*
  │     --user-data-dir=<临时目录> --no-first-run --disable-gpu about:blank
  ├─ 轮询 GET /json 直到拿到 page target 的 webSocketDebuggerUrl（上限 15s）
  └─ 返回 CdpSession（evaluate/close）
```

- `evaluate(expr)`：`Runtime.evaluate` + `returnByValue`；异常/错误返回 `null`（防御式）。
- `close()`：`Browser.close` → 关 WS → kill 浏览器进程 → 清理临时 user-data 目录（调用方必须 close）。
- **调试端口冲突**：随机端口范围 9000-9899；冲突时 `detectUi` 换端口重试（最多 3 次），
  显式指定端口则不重试。

---

## 3. DOM 探测与文本判据（src/detector-ui.ts）

### 3.1 探测脚本（每次 evaluate 注入）

```js
const bodyText = document.body ? document.body.innerText : '';
hasComposer = root.querySelector('textarea') !== null;   // 健康 UI 的标志（composer 业务容器）
isBootPage  = bodyText.includes('HARNESS') && !hasComposer; // 启动页（wordmark，无 composer）
return { bodyText: bodyText.slice(0, 1200), hasComposer, isBootPage };
```

### 3.2 分类优先级（`classifyDom`）

```
1. bodyText 含 "Failed to load plugins"（FAILED_MARKER） → kind='failed'（红屏，优先生效）
2. hasComposer                                        → kind='ok'（健康）
3. isBootPage                                         → kind='loading'（仍在启动）
4. 其它（资源未加载完）                                 → kind='loading'
```

### 3.3 失败详情提取

- `extractFailureDetail`：正则抓取 `web boot:...` 行（如 `web boot: 1 entry did not activate dsh-x: pending (waiting for service: y)`）。
- `parseFailedEntries`：解析缺失的插件/服务名（Format A 单行内联 + Format B 逐行 sweeper 报告，去重）。

---

## 4. 探测时序（pollUi / detectUi）

```
detectUi(url, timeoutMs, port=0)
  ├─ 选定调试端口（默认随机，冲突自动换端口重试 ≤3 次）
  ├─ launchSession → pollUi
  │     pollUi: evaluate("window.location.href = <url>")  → 导航到目标页
  │             do { probeOnce(); 若 failed/ok 立即返回; sleep(500) }
  │             while (耗时 < timeoutMs)
  │             → 超时返回最后一次判定（或 error）
  └─ finally close session
```

- **至少探测一次**（do-while）：`--confirm-ms 0` 等 0ms 场景也要有一次真实 DOM 读取，否则被误判 error。
- `probeOnce` 复用同一浏览器会话（不重复起 Chrome），超时/异常统一走 session.close 清理。

---

## 5. 判据的维护要点

| 点 | 说明 |
|----|------|
| `FAILED_MARKER` | 红屏固定文本，跨构建稳定（DSH AppRoot.tsx 钉死）。若 DSH 改文案，这里是唯一需要同步的位置 |
| `<textarea>` 判健康 | 实测 web profile 的 composer 容器；若 UI 改版去掉 textarea，需替换为等价业务容器判据 |
| 不依赖 CSS 类名 | 结构类是 hash，跨构建不稳定（设计红线） |
| bodyText 截断 | 1200 字符预算，足够容纳失败详情（`web boot:` + 400 字符）且避免传大 DOM |

---

## 6. 修改指南

- 加判据 → 改 `DOM_PROBE` + `classifyDom`，补 `test/detector-ui.spec.ts` 用例（含 0ms 探测回归）。
- 换浏览器二进制 → 只改 `cdp.ts findBrowser` 候选清单（保持"存在性探测"模式，不要硬编码单一路径）。
- CDP 协议升级 → 封装在 `CdpsSessionImpl.cmd()`，业务层只接触 `evaluate/close`。

# 守卫生命周期（guard.ts）

本文件解析 `src/guard.ts` 的编排逻辑：一次受监督 `dsh web` 启动从 spawn 到健康确认 / 失败计数的完整过程。

相关文档：[架构总览](architecture.zh.md) · [状态存储与回滚](state-and-rollback.zh.md) · [UI 检测](ui-detection.zh.md)

---

## 1. 核心类型

```ts
interface GuardOptions {
  home?: string          // DSH home（默认 resolveDshHome()）
  profile?: string       // profile 名（默认 'web'）
  command: string[]      // dsh 启动命令，如 ['dsh','web']
  cwd: string            // 子进程工作目录（checkout 根）
  port?: number          // 端口（默认 3080）
  dshEnv?: Record<string, string | undefined>
  autoConfirm?: boolean  // 回滚是否免确认
  uiTimeoutMs?: number   // UI 探测上限（默认 25000）
  portTimeoutMs?: number // 端口就绪上限（默认 30000）
  confirmGoodMs?: number // 稳定健康确认窗口（默认 20000）
  retries?: number       // 瞬态失败容忍重试数（CLI 设 1）
  threshold?: number     // 同类失败触发回滚的阈值（默认 3）
}

type BootVerdict =
  | { ok: true; supervisor: DshSupervisor; url: string }          // 健康，子进程仍在运行
  | { ok: false; failureKind: 'host' | 'ui' | 'unknown';
      error?: string; rolledBack: boolean;
      rollbackCancelled?: boolean; retriesExhausted: boolean }    // 失败
```

---

## 2. `bootAttempt()` — 单次尝试

一次尝试不计数、不回滚，只返回原始判定：

```
spawnDsh({ command, cwd, env: {...dshEnv, DSH_HOME}, port })
  │
  ├─ ready 拒绝（端口超时 / spawn 失败 / 端口开启前退出）
  │     → 等至多 1.5s 取退出码 → kill 子进程 → 返回 { kind: 'host', error: ... }
  │
  ├─ detectUi(url, uiTimeoutMs)
  │     ├─ 抛异常            → kill → { kind: 'unknown', error: 'UI detector failed' }
  │     ├─ kind === 'failed' → kill → { kind: 'ui', error: failureDetail }
  │     ├─ kind !== 'ok' 且子进程已死 / 输出含 fail-loud 标记
  │                         → kill → { kind: 'host', error: 'host exited during UI probe' }
  │     └─ kind !== 'ok'     → kill → { kind: 'unknown', error: 'UI did not settle' }
  │
  └─ kind === 'ok' → 返回 { kind: 'ok', supervisor }（子进程保留，交给调用方）
```

### 失败分类的坑（真实集成发现的边界）

- **端口开启前崩溃**：`ready` 拒绝 → `kind: 'host'`（正确）
- **绑定端口后才崩溃**（boot-stage 错误，如 user patch 引用了不存在的包）：`ready` 已解析，
  但 UI 探测拿不到健康页面。此时必须检查 `supervision.child.exitCode !== null ||
  supervision.hasHostFailureMarker()`——否则会被误判为 `unknown`（不计分、永不回滚）。
  这是真实 DSH 联调抓到的缺陷，已有回归测试固定。

---

## 3. 瞬态重试（`isTransient`）

```ts
function isTransient(attempt): boolean {
  if (attempt.kind === 'host') return true      // host 未就绪/早退通常可重试
  if (attempt.kind === 'unknown') return true   // UI 未落定也可重试
  // UI 失败里只有 bundle 加载类 flake 算瞬态
  return /bundle script .* failed to load/.test(e) || /import failed/.test(e)
}
```

- 每次重试前，上一次失败的子进程**必被杀掉**（bootAttempt 内已 kill）——失败启动绝不泄漏进程占住端口。
- 重试计数逻辑：`for (attempt = 0; attempt <= retries; attempt++)`，`retries` 用尽或遇到非瞬态失败即退出循环。
- `retriesExhausted` 语义：**仅当实际用尽了容忍重试次数**才为 true（真实红屏是"非瞬态"，提前退出时该值为 false）。

---

## 4. 确认窗口（`confirmStable`）

健康后的"信任前验证"，防止把"刚健康就劣化"的启动记为 last-good：

1. `sleep(confirmGoodMs)`（默认 20s）
2. 检查 `supervisor.child.exitCode !== null` → 宿主在窗口内退出了，判 host 失败
3. 用 `detectUi(url, min(confirmGoodMs, 15000))` 再探测一次真实 DOM：
   - `ok` → 确认通过
   - `failed` → 判 ui 失败
   - 其它 / 抛异常 → 判 unknown

> `--confirm-ms 0` 的边界：探测超时被钳制为至少 1ms，且 `pollUi` 采用 do-while **至少探测一次**，
> 否则 0ms 会直接返回 error 把健康启动误判为失败（已修复并测试）。

---

## 5. `superviseBoot()` — 编排主体

```ts
for (attempt = 0; attempt <= retries; attempt++) {
  last = await bootAttempt(opts)
  if (last.kind === 'ok') {
    confirmed = await confirmStable(...)
    if (confirmed.ok) {
      recordSuccess(...)            // 清零计数、清围栏、写 latest-good + history 快照
      return { ok: true, supervisor, url }
    }
    kill(); last = 失败判定
  }
  if (attempt < retries && isTransient(last)) continue
  break
}

// 收尾：计数 + 决定回滚
if (kind === 'host' || kind === 'ui') {
  incrementFailure(...)             // 同类计数 +1，异类清零；写 lastFailure
  rolled = await maybeRollback(...) // 见 state-and-rollback.md
  return { ok: false, ..., rolledBack, rollbackCancelled, retriesExhausted }
}
return { ok: false, failureKind: 'unknown', ... }   // unknown 不计分
```

---

## 6. 其它

- **`ensurePortFlag`**：命令里已带 `--port <值>` 则尊重；裸 `--port`（无值）会补齐；否则追加 `--port <port>`。
- **子进程输出**：`attachStdio: false` 时通过 `onOutput` 写入 `host.log` 并镜像到可见窗口；
  `hasHostFailureMarker` 匹配的 fail-loud 关键字：`plugin tree failed to load` /
  `failed to load plugin` / `cannot get property` / `unhandled exception`（大小写不敏感）。
- **回调约定**：健康时子进程由调用方持有（`cli.ts` 里 `await supervisor.exit` 保持进程存活并等待退出）；
  任何失败路径子进程都已在 bootAttempt 内 kill，不会残留。

---

## 7. 修改指南

- 新增失败形态 → 在 `bootAttempt` 的分类处扩展，并补 `guard.spec.ts` 回归测试
  （mock `spawnDsh` / `detectUi`，断言分类与 kill 行为）。
- 调整重试策略 → 只改 `isTransient` 与 `retries` 传参，测试用 `guard.spec.ts` 的
  "non-transient failure stops the loop early" 用例验证语义。

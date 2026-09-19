# Cachified 执行时序分析

本文分析 `cachified` 在缓存命中、schema 验证、fresh/stale 窗口、loader、后台刷新、soft purge、batch 与 reporter 之间的先后关系。所有断言均标注依据：

- 形如 `src/cachified.ts:50` 的引用可直接对照源码行号核对。
- 标注 `（测试：<用例名>）` 的事件数组由 `src/analysis.spec.ts` 中的新增用例逐条断言，可用 `npm test -- --runInBand` 复现。
- 标注 **【推测】** 的内容是源码无法单独确认的推断，不作为既定事实。

## 关键事实速查

- 入口 `cachified` 先读缓存，命中且通过检查时立即返回（`src/cachified.ts:47`、`src/cachified.ts:50-53`）；stale 条目也是这条路径返回的，后台刷新只是“顺手”通过 `waitUntil` 排进事件循环（`src/getCachedValue.ts:80-90`）。
- 去重状态存在模块级 `WeakMap<Cache, Map<string, any>>` 里（`src/cachified.ts:16`、`src/cachified.ts:42`），按 cache 对象与 key 隔离，不读源码无法从外部观察。
- stale 后台刷新是一次**新的嵌套 `cachified` 调用**，且没有传 reporter，因此它内部的 `getFreshValueStart`/`writeFreshValueSuccess` 等事件不会上报；外层只能收到包装后的 `refreshValueStart` / `refreshValueSuccess` / `refreshValueError`（`src/getCachedValue.ts:55-89`、`src/getCachedValue.ts:82`）。
- 错误分流：loader 拒绝、fresh 值校验失败、`cache.get`/`delete` 失败会向调用方 reject；后台刷新失败与 `cache.set` 失败只进 reporter（`src/getFreshValue.ts:23-43`、`src/getFreshValue.ts:73-75`、`src/getCachedValue.ts:83-88`）。
- 过期判定完全由 `Date.now()` 与 entry 的 `createdTime/ttl/swr` 决定：`now <= ttl 结束` 为 fresh，`ttl 结束 < now <= ttl+swr` 为 stale，再之后为 expired；`ttl === null` 永不过期（`src/isExpired.ts:11-32`）。

时间线记号：`adapter` 表示外部传入的 cache 适配器调用；事件名与 `src/reporter.ts:94-115` 中 `CacheEvent` 的 `name` 完全一致（测试断言使用同一组字符串）。

## 1. Fresh hit

前提：entry 存在、`isExpired(metadata) === false`（`src/isExpired.ts:21-24`），无 `forceFresh`。

| 顺序 | 动作 | 位置 |
| --- | --- | --- |
| 1 | reporter `getCachedValueStart` | `src/getCachedValue.ts:14` |
| 2 | `adapter.get(key)` await | `src/getCachedValue.ts:15` |
| 3 | reporter `getCachedValueRead`（带 entry） | `src/getCachedValue.ts:16` |
| 4 | `assertCacheEntry` 结构校验 | `src/getCachedValue.ts:18`、`src/assertCacheEntry.ts:7-37` |
| 5 | `checkValue`（含 schema）await | `src/getCachedValue.ts:93` |
| 6 | reporter `getCachedValueSuccess`（含 migrated 标记） | `src/getCachedValue.ts:95-99` |
| 7 | 返回缓存值，reporter `done` | `src/cachified.ts:50-53` |

- 不调用 loader，不调用 `set`/`delete`；batch 场景下通过 `getFreshValue[HANDLE]?.()` 通知 batch 该请求由缓存消化（`src/getCachedValue.ts:100-103`、`src/createBatch.ts:127-133`）。
- 事件数组（测试：`fresh hit: reads cache, validates, returns without loader or set`）：
  `getCachedValueStart → getCachedValueRead → getCachedValueSuccess → done`，适配器操作仅 `['get']`。

## 2. Stale hit（含并发刷新去重）

前提：entry 存在、`isExpired` 返回 `'stale'`（`src/isExpired.ts:26-28`），或在 `swr === Infinity` 时返回 `true` 也按 stale 处理（`src/getCachedValue.ts:47-49`）。

单次调用的同步排布（注意第 3 步发生在调用方 promise settle 之前）：

| 顺序 | 动作 | 位置 |
| --- | --- | --- |
| 1 | `adapter.get` → `getCachedValueRead` | `src/getCachedValue.ts:15-16` |
| 2 | 构造嵌套刷新选项（`forceFresh: true, fallbackToCache: false`），其 loader 先 `await sleep(staleRefreshTimeout)` 再发 `refreshValueStart` | `src/getCachedValue.ts:56-74` |
| 3 | `waitUntil(cachified(staleRefreshOptions).then/.catch)` 排队后台任务；此时嵌套调用同步开始，但其 loader 要等 0ms 定时器 | `src/getCachedValue.ts:81-89` |
| 4 | `checkValue` 通过 → `getCachedValueSuccess` | `src/getCachedValue.ts:92-99` |
| 5 | 外层返回 stale 值，reporter `done` | `src/cachified.ts:50-53` |
| 6 | （后续宏任务）reporter `refreshValueStart` → 嵌套调用执行 loader（`background: true`） | `src/getCachedValue.ts:65-70` |
| 7 | 嵌套调用内部 `cache.set`（事件不外放） | `src/getFreshValue.ts:61-72` |
| 8 | 每个排队的外层调用各收到一次 `refreshValueSuccess` 或 `refreshValueError` | `src/getCachedValue.ts:83-88` |

并发共用刷新的判定（源码可核对）：

- 两个外层调用各自排一个嵌套 `cachified`（因此 `waitUntil` 收到 2 个 promise）；第一个嵌套调用在 pending map 中登记（`src/cachified.ts:87-92`），第二个嵌套调用因为 `forceFresh` 跳过读缓存后发现 pending 存在，且其 `metadata` 未过期，于是走 pending hook：`getFreshValueHookPending`（嵌套 reporter 是 noop，不可见）并 `await pendingRefreshValue`，**不启动第二个 loader**（`src/cachified.ts:55-66`）。
- 结论：loader 只执行一次，但 `refreshValueSuccess`/`refreshValueError` 按外层调用数各上报一次。`staleRefreshTimeout` 固定为 0（`src/common.ts:284`），即“立刻排队、下一个宏任务才真正取数”，这保证了去重在任何刷新开始前就完成（`src/getCachedValue.ts:59-65` 的注释也说明此意图）。
- 事件数组（测试：`returns the stale value first and starts the background refresh exactly once`，两次并发调用，loader 手动 resolve 为 `'N'`）：
  settle 前：`getCachedValueStart ×2 → getCachedValueRead ×2 → getCachedValueSuccess ×2 → done ×2`；刷新后追加 `refreshValueStart → refreshValueSuccess → refreshValueSuccess`。适配器操作：`get, get, set:N`，loader 调用次数为 1。

## 3. Expired miss（ttl 与 swr 均已过）

前提：entry 存在、`isExpired === true` 且 `swr !== Infinity`（`src/isExpired.ts:30-31`、`src/getCachedValue.ts:47-49`）。

| 顺序 | 动作 | 位置 |
| --- | --- | --- |
| 1 | `adapter.get` → `getCachedValueRead` | `src/getCachedValue.ts:15-16` |
| 2 | reporter `getCachedValueOutdated`（带 value 与 metadata） | `src/getCachedValue.ts:51-53` |
| 3 | **不检查 value、不 delete**，直接返回 `CACHE_EMPTY` | `src/getCachedValue.ts:92`（条件 `!expired || staleRefresh` 为假） |
| 4 | reporter `getFreshValueStart` → 调用 loader | `src/getFreshValue.ts:16-17` |
| 5a | loader 成功：`getFreshValueSuccess` → 若期间总 TTL 未到则 `adapter.set`，再 `writeFreshValueSuccess` | `src/getFreshValue.ts:22`、`src/getFreshValue.ts:61-72` |
| 5b | loader 拒绝：`getFreshValueError` 后重新抛出 | `src/getFreshValue.ts:23-43` |
| 6 | 成功路径 `done`；失败路径调用方 promise reject（无 `done`） | `src/cachified.ts:94-96` |

- **过期 entry 不会被删除**：`getCachedValue` 对 fully expired 条目既不调用 `checkValue` 也不调用 `cache.delete`（`src/getCachedValue.ts:92`）；loader 失败后旧值仍留在适配器中。
- 事件数组（测试：`expired miss: loader rejection propagates, expired entry is not deleted`，时钟 100、entry 为 ttl 5 + swr 5、loader 抛 `loader boom`）：
  `getCachedValueStart → getCachedValueRead → getCachedValueOutdated → getFreshValueStart → getFreshValueError(loader boom)`；适配器操作仅 `['get']`，调用方收到同一个 rejection。

## 4. Invalid schema（缓存值校验失败）

前提：entry 新鲜或 stale（所以会进入 `checkValue`），`checkValue` 返回失败。

| 顺序 | 动作 | 位置 |
| --- | --- | --- |
| 1 | `adapter.get` → `getCachedValueRead` | `src/getCachedValue.ts:15-16` |
| 2 | `checkValue` 内部 `try/catch` 把 schema 抛出的 issues、validator 返回的字符串等统一收敛成 `{ success: false, reason }` | `src/checkValue.ts:11-46`；Standard Schema 包装在 `src/common.ts:234-258` |
| 3 | reporter `checkCachedValueErrorObj`（原始 reason）紧跟 `checkCachedValueError`（字符串化 reason） | `src/getCachedValue.ts:133-141` |
| 4 | `await adapter.delete(key)`（第一个删除点） | `src/getCachedValue.ts:143` |
| 5 | 返回 `CACHE_EMPTY`，外层走 loader：`getFreshValueStart → getFreshValueSuccess` | `src/cachified.ts:47-53`、`src/getFreshValue.ts:16-22` |
| 6 | fresh 值再过一次 `checkValue`；通过后 `adapter.set` 与 `writeFreshValueSuccess`，最后 `done` | `src/getFreshValue.ts:45-77` |

- 校验错误本身**不向调用方传播**，只进 reporter；传播给调用方的只有随后 loader/fresh 校验抛出的错误。
- 事件数组（测试：`invalid cached schema: deletes entry and loads fresh value`，缓存 `'BAD'`、fresh 值 `'GOOD'`）：
  `getCachedValueStart → getCachedValueRead → checkCachedValueErrorObj → checkCachedValueError → getFreshValueStart → getFreshValueSuccess → writeFreshValueSuccess → done`；适配器操作 `get → delete → set:GOOD`。
- 注意 `assertCacheEntry` 结构损坏走的是另一条路：异常被 `src/getCachedValue.ts:146-150` 捕获，发 `getCachedValueError` 后再 `delete` 一次（第二个删除点）。

## 5. Loader reject

前提：空缓存、`forceFresh` 或 fully expired miss，且 loader 抛错/返回 rejected promise。

| 顺序 | 动作 | 位置 |
| --- | --- | --- |
| 1 | 空缓存：`getCachedValueStart → adapter.get → getCachedValueRead → getCachedValueEmpty` | `src/getCachedValue.ts:14-21`、`src/getCachedValue.ts:41-44` |
| 2 | reporter `getFreshValueStart`，loader 拒绝 | `src/getFreshValue.ts:16-17` |
| 3 | reporter `getFreshValueError` | `src/getFreshValue.ts:23-24` |
| 4a | 非 forceFresh 或 `fallbackToCache === 0`：重新抛出原始错误 | `src/getFreshValue.ts:38-42` |
| 4b | forceFresh 且允许回退：再做一次 `adapter.get`，entry 太旧或不存在仍抛原错；否则发 `getFreshValueCacheFallback` 用缓存值继续 | `src/getFreshValue.ts:28-37` |
| 5 | pending 记录在 `.finally` 中移除，调用方 promise reject，无 `done` 事件 | `src/cachified.ts:77-79`、`src/cachified.ts:94` |

- 不发生 `set`；fully expired 路径也不发生 `delete`（见第 3 条）。
- 空缓存事件数组（测试：`loader reject on empty cache propagates the loader error`）：
  `getCachedValueStart → getCachedValueRead → getCachedValueEmpty → getFreshValueStart → getFreshValueError(down)`，调用方收到原错；适配器操作 `['get']`。
- 对比：**后台刷新（stale 路径）的 loader 拒绝不向调用方传播**，只发一次 `refreshValueError`（`src/getCachedValue.ts:86-88`），调用方仍拿到 stale 值（测试：`R1: stale value is returned while background refresh errors only reach the reporter`）。

## 6. Soft purge

`softPurge` 独立于 `cachified`，自己调用 `getCacheEntry`（`src/softPurge.ts:24`），因此也会产生 `getCachedValueStart` / `getCachedValueRead` 两个 reporter 事件——但它传入的 reporter 是 `() => {}`（`src/softPurge.ts:24`），外部不可见。

| 顺序 | 动作 | 位置 |
| --- | --- | --- |
| 1 | `adapter.get(key)`；空值或已过期（含 stale）直接 return，无 set | `src/softPurge.ts:24-28` |
| 2 | 计算新 metadata：`ttl: 0`，默认 `swr = 原 ttl + 原 swr`；显式传 `swr` 时为 `swr + (now - createdTime)`；保留原 `createdTime` | `src/softPurge.ts:30-41` |
| 3 | `adapter.set` 写回 | `src/softPurge.ts:34-41` |

- 后果：下一次 `cachified` 读取时 entry 恰好处于 stale（`validUntil = createdTime`），stale 值照常返回，同时触发一次后台刷新；刷新失败只产生 `refreshValueError`。
- 事件与操作（测试：`softPurge: rewrites a live entry with ttl 0 and remaining lifetime as swr`，entry `ttl:1000, swr:50, createdTime:0`，时钟 20）：softPurge 适配器操作 `get → set:V`，新 entry 为 `ttl:0, swr:1050, createdTime:0`；随后读缓存的事件为
  `getCachedValueStart → getCachedValueRead → getCachedValueSuccess → done → refreshValueStart → refreshValueError(refresh down)`。
- 结构损坏的 entry 会让 `softPurge` 直接 reject（`assertCacheEntry` 抛出发生在 `src/softPurge.ts:24` 的 await 内，无内部 catch），与既有测试 `src/softPurge.spec.ts:29-39` 一致。

## 7. Batch partial failure

batch 由 `createBatch` 实现：每个 `add(param, onValue)` 返回的 loader 被调用时把 `[param, resolve, reject, metadata]` 推入 `requests`，并在首次调用结束时自动 `submit`（`src/createBatch.ts:103-124`、`src/createBatch.ts:60-91`）。

混合场景（部分 key 命中缓存、其余进入同一个 batch loader，loader 整体 reject）：

| 顺序 | 动作 | 位置 |
| --- | --- | --- |
| 1 | 各 `cachified` 调用并发 `adapter.get` 自己的 key | `src/getCachedValue.ts:15` |
| 2 | 命中缓存的 key：`getCachedValueSuccess → done`，并通过 `HANDLE` 减少 batch 计数；`onValue` 不会被调用 | `src/getCachedValue.ts:100-103`、`src/createBatch.ts:127-133`；既有用例 `src/cachified.spec.ts:1606-1624` |
| 3 | 未命中的 key 各自发 `getCachedValueEmpty → getFreshValueStart`，其 loader 向同一 batch 注册 | `src/getFreshValue.ts:16`、`src/createBatch.ts:109-119` |
| 4 | 未命中数归零时 submit：`getFreshValues(params, metadatas)` | `src/createBatch.ts:73-79` |
| 5a | loader throw / reject：`catch` 中对**所有**注册请求 `rej(err)` | `src/createBatch.ts:87-90` |
| 5b | 返回数组长度不符：先抛“same length”错误，同样全量 reject | `src/createBatch.ts:80-90`；既有用例 `src/cachified.spec.ts:1775-1822` |
| 6 | 每个未命中调用在 `getFreshValue` 捕获并发 `getFreshValueError`，随后 reject 给调用方；不写缓存 | `src/getFreshValue.ts:23-43` |

- “partial” 的含义：缓存命中者正常 fulfill，进入 batch 者**全部** reject 同一个错误（`createBatch` 没有逐项错误通道，`requests` 里每项只有一个共享 `rej`，`src/createBatch.ts:43-48`）。
- 事件数组（测试：`batch partial failure: cached keys resolve while uncached keys all reject`，key `a` 有缓存、`b`/`boom` 无缓存、loader 见 `boom` 即抛）：
  key `a`：`getCachedValueStart → getCachedValueRead → getCachedValueSuccess → done`；
  key `b` 与 `boom`：`getCachedValueStart → getCachedValueRead → getCachedValueEmpty → getFreshValueStart → getFreshValueError(batch boom)`，二者 promise 均 reject；
  适配器只有三次 `get`，没有 `set`。

## 错误传播对照表

| 错误来源 | reporter 事件 | 调用方 promise | 适配器副作用 | 依据 |
| --- | --- | --- | --- | --- |
| `cache.get` 拒绝 / entry 结构损坏 | `getCachedValueError` | reject（同一个错误） | 再 `delete` 一次 | `src/getCachedValue.ts:146-150` |
| 缓存值 checkValue 失败 | `checkCachedValueErrorObj` + `checkCachedValueError` | 不传播；转去 loader | `delete` | `src/getCachedValue.ts:133-144` |
| loader 拒绝（前台） | `getFreshValueError` | reject（原错） | 无 set | `src/getFreshValue.ts:23-43` |
| fresh 值 checkValue 失败 | `checkFreshValueErrorObj` + `checkFreshValueError` | reject 一个**新的包装 Error**（`cause` 为原 reason） | 无 set | `src/getFreshValue.ts:45-59` |
| `cache.set` 拒绝 | `writeFreshValueError` | **不传播**，照常返回 fresh 值 | 写入失败 | `src/getFreshValue.ts:61-77` |
| 后台刷新 loader 拒绝 | `refreshValueError` | **不传播**，调用方早已拿到 stale 值 | 无 | `src/getCachedValue.ts:81-89` |
| stale 刷新期间 `cache.set` 拒绝 | 不外放（嵌套 reporter 为 noop），最终体现为 `refreshValueError` | 不传播 | 写入失败 | `src/getCachedValue.ts:82` + `src/getFreshValue.ts:73-75` |
| 校验失败后的 `delete` 也拒绝 | 先两条 check 事件，再 `getCachedValueError` | reject（delete 的错误），**loader 不会被调用** | 两次 `delete` 尝试 | `src/getCachedValue.ts:143-150` |
| batch loader 拒绝 / 长度不符 | 每个未命中调用各一条 `getFreshValueError` | 进入 batch 的调用全部 reject；缓存命中者 fulfill | 无 set | `src/createBatch.ts:80-90`、`src/getFreshValue.ts:23-43` |
| `softPurge` 读到坏 entry | 无（内部 noop reporter） | reject | 无 | `src/softPurge.ts:24` |

## 并发调用能否共用刷新

pending 表按 **cache 对象**（WeakMap）与 **key**（Map）分桶（`src/cachified.ts:16-26`）。

- **并发 expired/empty miss（前台取数）**：后到的调用在自己的 `cache.get` resolve 后检查 pending，若 pending 的 `metadata` 未过期则发一个（不可见的）`getFreshValueHookPending` 并 await 同一个 promise，不启动第二个 loader（`src/cachified.ts:55-66`）。既有快照见 `src/cachified.spec.ts:933-979`。
- **并发 stale hit（后台刷新）**：同样共用，但排队发生在 0ms 定时器之前，所以 loader 严格只跑一次；每个外层调用仍各收到一条 `refreshValueSuccess/Error`（见第 2 条与确定性测试）。
- **pending 的 metadata 已过期时不共用**：`isExpired(metadata)` 不为 `false`（即 `true` 或 `'stale'`）时跳过 hook，后到调用启动自己的 loader；不过更快的后到响应会通过 `resolveFromFuture` 反向“赢走”先到调用的结果（`src/cachified.ts:58`、`src/cachified.ts:68-92`）。该路径既有测试覆盖：`src/cachified.spec.ts:981-1005`、`src/cachified.spec.ts:1093-1127`。
- 不同 cache 对象、不同 key 不共用；`forceFresh` 只跳过自己的读缓存，不影响 pending 去重（`src/cachified.ts:47-49`）。

## 五个风险点

每个风险点给出 fake clock 时间、初始 entry、调用序列与预期事件数组；括号中的名称对应 `src/analysis.spec.ts` 里可运行的用例。

### R1. Stale 已返回，后台刷新错误静默（测试：`R1: stale value is returned while background refresh errors only reach the reporter`）

- fake clock：读时 `now = 15`。
- 初始 entry：`{ value: 'S', metadata: { createdTime: 0, ttl: 10, swr: 50 } }`。
- 调用序列：一次 `cachified({ ttl: 10, swr: 50, waitUntil 收集后台任务, getFreshValue: () => { throw 'refresh boom' } })`，先取返回值，再 `await` 后台任务。
- 预期：调用方得到 `'S'`；适配器操作 `['get']`，entry 仍为 `'S'`。
- 预期事件：`getCachedValueStart, getCachedValueRead, getCachedValueSuccess, done, refreshValueStart, refreshValueError(refresh boom)`。
- 风险：只看返回值会以为系统健康；必须消费 reporter 或 `waitUntil` 的 promise 才能发现持续刷新失败。

### R2. Loader 失败后 fully expired 条目残留在适配器（测试：`R2: expired entry stays in the adapter when the loader rejects`）

- fake clock：`now = 100`。
- 初始 entry：`{ value: 'OLD', metadata: { createdTime: 0, ttl: 5, swr: 5 } }`（60 起 expired）。
- 调用序列：`cachified({ ttl: 5, swr: 5, getFreshValue: () => { throw 'loader boom' } })`。
- 预期：promise reject `loader boom`；适配器操作只有 `['get']`，`store.get('k').value` 仍是 `'OLD'`（`src/getCachedValue.ts:92` 跳过删除，`src/getFreshValue.ts:41` 直接重抛）。
- 预期事件：`getCachedValueStart, getCachedValueRead, getCachedValueOutdated, getFreshValueStart, getFreshValueError(loader boom)`（无 `done`）。
- 风险：外部存储（Redis 等）里的过期值不会被主动清理；下次读取仍会反复走 miss + loader。

### R3. Fresh 值校验失败抛的是包装错误，且不写缓存（测试：`R3: a fresh value failing checkValue rejects with a wrapping error and is not cached`）

- fake clock：任意（空缓存）。
- 初始 entry：无。
- 调用序列：`cachified({ checkValue: () => 'not what we want', getFreshValue: () => 'X' })`。
- 预期：reject 的错误消息是 `check failed for fresh value of k`，原始 reason 在 `error.cause`（`src/getFreshValue.ts:56-58`）；缓存保持为空，适配器操作 `['get']`。
- 预期事件：`getCachedValueStart, getCachedValueRead, getCachedValueEmpty, getFreshValueStart, getFreshValueSuccess, checkFreshValueErrorObj, checkFreshValueError`。
- 风险：调用方拿不到 loader 返回值本身，且成功取数却没有任何缓存写入，重试会再次打源。

### R4. `cache.set` 失败被吞掉（测试：`R4: cache.set errors are swallowed and only emitted as writeFreshValueError`）

- fake clock：`now = 0`。
- 初始 entry：无。
- 调用序列：适配器 `set` 抛 `set boom`；`cachified({ ttl: 5, getFreshValue: () => 'V' })`。
- 预期：调用方正常得到 `'V'`，缓存为空；适配器操作 `['get', 'set:V']`。
- 预期事件：`getCachedValueStart, getCachedValueRead, getCachedValueEmpty, getFreshValueStart, getFreshValueSuccess, writeFreshValueError(set boom), done`。
- 风险：与 R1 同源的“成功返回但没有缓存”，只看返回值无法察觉每次请求都在回源。

### R5. 删除坏 entry 失败会升级为调用方错误并跳过 loader（测试：`R5: a failing delete after invalid cached value turns into getCachedValueError and skips the loader`）

- fake clock：`now = 0`，entry 为永久（`ttl: null`）。
- 初始 entry：`{ value: 'BAD', metadata: { createdTime: 0, ttl: null, swr: 0 } }`；适配器 `delete` 抛 `delete boom`。
- 调用序列：`cachified({ checkValue: () => false, getFreshValue: jest.fn() })`。
- 预期：promise reject `delete boom`（而非进入 loader）；loader 调用次数 0；entry 仍是 `'BAD'`；适配器操作 `['get', 'delete', 'delete']`（`src/getCachedValue.ts:143` 与 catch 内 `src/getCachedValue.ts:149` 各一次）。
- 预期事件：`getCachedValueStart, getCachedValueRead, checkCachedValueErrorObj, checkCachedValueError, getCachedValueError(delete boom)`。
- 风险：本来可自愈的“坏值 + 回源”路径，在 delete 权限/网络故障时变成硬失败，且坏值不会被清掉。

## 确定性测试：stale 先返回、后台 refresh 只启动一次

用例 `returns the stale value first and starts the background refresh exactly once`（`src/analysis.spec.ts`，describe `ANALYSIS.md deterministic refresh de-duplication`）满足题目全部约束：

- fake clock：`jest.spyOn(Date, 'now')` 驱动 `currentTime`，并 `jest.useFakeTimers({ doNotFake: ['Date'] })` 接管 `staleRefreshTimeout` 的 0ms 定时器（`src/getCachedValue.ts:155-157` 的 `sleep`）。
- 手动控制 promise：loader 返回 `new Deferred<string>()`（`src/createBatch.ts:139-153` 已导出该工具），测试自己决定何时 `resolve('N')`；没有任何 `sleep`/`delay` 等待真实时间。
- 不读私有 map：全程只通过返回值、`jest.fn()` 调用次数、适配器 `ops`、reporter 事件与 `waitUntil` 收集到的 promise 观察行为。
- 关键断言顺序：两次调用先 `Promise.all` 出 `['S','S']`，此时 loader 调用次数为 0；`jest.advanceTimersByTimeAsync(0)` 后 loader 恰好 1 次且收到 `{ background: true }`，`waitUntil` 收到 2 个任务；resolve 后两次 `refreshValueSuccess`、适配器仅一次 `set:N`。

## 最小可运行复现

仓库根目录的 `analysis-reproduce.mjs` 是下文同一份代码的落盘副本；先构建（`npm ci` 会自动执行 `prepare` 构建，见 `package.json` 的 `scripts.prepare`），然后：

```bash
node analysis-reproduce.mjs
```

代码中 reporter 记录的事件名与上文及 `src/analysis.spec.ts` 的断言字符串完全一致：

```js
// Minimal reproduction for ANALYSIS.md. Run from the repo root:
//   node analysis-reproduce.mjs
// Requires a build first (npm ci runs the "prepare" build script automatically).
import { cachified, createCacheEntry } from './dist/index.mjs';

let now = 0;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  static now() {
    return now;
  }
};

const store = new Map();
const ops = [];
const cache = {
  name: 'demo',
  async get(key) {
    ops.push(`get ${key}`);
    return store.get(key);
  },
  async set(key, entry) {
    ops.push(`set ${key}=${entry.value}`);
    store.set(key, entry);
  },
  async delete(key) {
    ops.push(`delete ${key}`);
    store.delete(key);
  },
};

const events = [];
const reporter = () => (event) => events.push(event.name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let loaderCount = 0;
function makeOptions(waitUntil = () => {}) {
  return {
    cache,
    key: 'k',
    ttl: 10,
    swr: 50,
    waitUntil,
    getFreshValue: ({ background }) => {
      const value = `v${loaderCount++}`;
      console.log(`  -> loader runs (background=${background}), returns ${value}`);
      return value;
    },
  };
}

// 1) expired miss: adapter get, loader, adapter set
events.length = 0;
const first = await cachified(makeOptions(), reporter);
console.log('miss settles with:', first);
console.log('adapter ops:', ops);
console.log('events:', events);

// 2) two concurrent stale hits (10 < now <= 60): both return v0 immediately,
//    one shared background refresh is queued
events.length = 0;
ops.length = 0;
now = 15;
const background = [];
const waitUntil = (p) => background.push(p);
const [a, b] = await Promise.all([
  cachified(makeOptions(waitUntil), reporter),
  cachified(makeOptions(waitUntil), reporter),
]);
console.log('\nstale calls settle with:', a, b);
console.log('events before refresh starts:', events);

// let the 0ms staleRefreshTimeout timer fire, then await the background work
await sleep(20);
await Promise.all(background);
console.log('adapter ops:', ops);
console.log('events after background refresh:', events);
console.log('cache now holds:', store.get('k')?.value);

// 3) refresh failure never reaches the caller: still stale, error is only reported
events.length = 0;
ops.length = 0;
now = 30; // v1 was created at 15 with ttl 10 + swr 50, so 30 is stale
const failedBackground = [];
const value = await cachified(
  {
    ...makeOptions((p) => failedBackground.push(p)),
    getFreshValue: () => {
      throw new Error('boom');
    },
  },
  reporter,
);
await sleep(20);
await Promise.all(failedBackground);
console.log('\nstale call after failed refresh settles with:', value);
console.log('adapter ops:', ops);
console.log('events:', events);
```

实测输出的事件序列（第 2 段）与确定性测试一致：两个调用先各拿到 `v0`，事件停在两个 `done`；随后只有一次 `refreshValueStart`，loader 打印一次 `background=true`，最后出现两次 `refreshValueSuccess`。第 3 段输出 `refreshValueError` 而调用方仍拿到 stale 值。

## 无法由源码或新测试单独确认的事项（推测）

- **【推测】** `staleRefreshTimeout` 选项虽在类型中保留（`src/common.ts:181-191`），但 `createContext` 把它硬编码为 0（`src/common.ts:284`），文档化的“可配置延迟”事实上不可用；源码能确认行为，但是否属于有意的弃用中间态只能从注释与 `@deprecated` 推断。
- **【推测】** `swr: Infinity` 且 `now` 也为 `Infinity` 时，`isExpired` 因 `Infinity - Infinity = NaN` 落入 expired 分支，而 `staleWhileRevalidate === Infinity` 又让它按 stale 处理（`src/getCachedValue.ts:47-49`）；实测时钟 `now = Infinity` 下 stale 值仍返回并触发刷新（脚本验证），但这条路径是否被官方支持无法从注释确认。
- **【推测】** migrate 写回的后台 `waitUntil` 任务里所有错误都被空 catch 吞掉（`src/getCachedValue.ts:106-129`），且没有任何 reporter 事件；“迁移值写回失败对外不可见”是从代码结构推断的运行时效果，仓库中没有针对该失败路径的测试。
- **【推测】** 嵌套后台刷新调用没有继承外层 reporter（`src/getCachedValue.ts:82` 未传第二参），因此其内部 `writeFreshValueError`、`getFreshValueError` 只会被压缩成 `refreshValueError`；这是从调用点直接读到的行为，但“为何不合并 reporter”属于设计动机推测。

## 验收

新增测试全部位于 `src/analysis.spec.ts`（12 个用例：7 条时间线相关用例、5 个风险点用例，其中确定性 stale 去重用例在独立 describe 内）。仓库根目录直接运行：

```bash
npm test -- --runInBand
```

应看到测试套件 `src/analysis.spec.ts` 及用例名 `ANALYSIS.md deterministic refresh de-duplication > returns the stale value first and starts the background refresh exactly once` 等输出，总计 80 个测试通过（原 68 + 新增 12），退出码为 0。无需外部服务、公网或手工环境变量；仅依赖 `npm ci` 产出的 `dist/` 构建（测试在非 Node v20 环境下按仓库既有约定运行构建产物，见 `src/cachified.spec.ts:21-29` 的同一 mock 约定）。

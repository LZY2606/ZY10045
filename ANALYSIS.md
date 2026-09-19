# Cachified 时序分析

本文描述当前源码（工作区版本）在七种场景下的执行顺序、错误传播路径与并发去重行为。所有结论均可由源码行号或 `src/analysis.spec.ts` 中的新增测试逐条核对；无法从源码/测试直接确认的内容统一放在文末「推测与未验证项」中。

事件名全部来自 `src/reporter.ts:3`–`src/reporter.ts:115` 的联合类型，测试断言使用同一组名字。

## 可运行的最小复现环境

下面的 adapter 与 reporter 即 `src/analysis.spec.ts:27`–`src/analysis.spec.ts:101` 使用的实现（为便于阅读做了精简，行为等价）：

```ts
import { cachified } from './src/index';

const store = new Map<string, { metadata: any; value: unknown }>();
// get 返回 Promise：制造一个微任务边界，使“并发调用”共享同一 pending 条目
// （同步 adapter 的竞态见文末「推测与未验证项」第 3 条）。
const cache = {
  name: 'memory',
  get: (key: string) => Promise.resolve(store.get(key)),
  set: (key: string, entry: unknown) => {
    store.set(key, entry as never);
  },
  delete: (key: string) => {
    store.delete(key);
  },
};

const events: string[] = [];
const reporter = () => (event: { name: string }) => {
  events.push(event.name);
};

await cachified({ cache, key: 'k', getFreshValue: () => 'v1' }, reporter);
console.log(events);
// ['getCachedValueStart','getCachedValueRead','getCachedValueEmpty',
//  'getFreshValueStart','getFreshValueSuccess','writeFreshValueSuccess','done']
```

该输出与既有快照 `src/cachified.spec.ts:49`–`src/cachified.spec.ts:90` 一致（既有 helper 在最前面多合成了一个测试专用的 `init` 事件，库本身不产生该事件，见 `src/cachified.spec.ts:1829`）。

## 共享机制速查

- pending 表是 `WeakMap<Cache, Map<string, Promise>>`，键为 cache 对象与 key：`src/cachified.ts:16`、`src/cachified.ts:21`。因此只在**同一个 cache 对象 + 同一个 key** 内去重；不同 cache、不同 key 不共享。
- 外部调用先读缓存：`src/cachified.ts:47`–`src/cachified.ts:49`；命中有效/stale 值直接在 `src/cachified.ts:51`–`src/cachified.ts:52` 返回，不再进入 pending 逻辑。
- 缓存未给值时，若 pending 条目存在且其 metadata **尚未过期**，第二个调用发 `getFreshValueHookPending`（`src/cachified.ts:61`）并 await 同一个 promise（`src/cachified.ts:62`）；pending 已过期则不走此分支。
- 否则创建/接管 pending 条目：`src/cachified.ts:69`–`src/cachified.ts:92`；settle 后在 `.finally` 中删除条目：`src/cachified.ts:77`–`src/cachified.ts:79`。
- 早启动的调用会被晚启动且更快的调用 resolve：`src/cachified.ts:82`–`src/cachified.ts:85`（见风险点 R4）。

图中记号：`G/S/D` = adapter 的 get/set/delete；`L` = 用户 loader（`getFreshValue`）；`R` = reporter 事件；`fulfill/reject` = `cachified()` 返回 promise 的 settle。

## 1. Fresh hit（TTL 内）

时间判定：`now <= createdTime + ttl` 时 `isExpired` 返回 `false`（`src/isExpired.ts:22`–`src/isExpired.ts:23`；`ttl === null` 永不过期，`src/isExpired.ts:13`–`src/isExpired.ts:14`）。

```
调用方      adapter            cachified/getCachedValue                      reporter
──────────────────────────────────────────────────────────────────────────────────────
cachified(opts)
  │
  ├─ G(key) ───────────────▶ getCacheEntry: src/getCachedValue.ts:14 R getCachedValueStart
  │                            await cache.get ...............:15
  │ ◀─────────────────────── R getCachedValueRead(entry) .......:16
  │                            assertCacheEntry ................ assertCacheEntry.ts:7
  │                            isExpired() === false
  │                            checkValue 通过
  │                          R getCachedValueSuccess ........... getCachedValue.ts:95
  │                          (无 staleRefresh，不调用 batch HANDLE) getCachedValue.ts:100-103
  │ ◀── return value
  R done（在 cachified.ts:51） ................................. cachified.ts:51
  fulfill(value)
  │
  └─ 无 loader、无 set、无后台任务
```

要点：fresh hit 全程不调用 `L`/`S`/`D`；返回 promise 在 `done` 之后才 fulfill（事件同步发出，调用方的 `await` 恢复在下一个微任务）。

## 2. Stale hit（TTL 外、SWR 窗口内）+ 后台刷新

`isExpired` 返回 `'stale'`（`src/isExpired.ts:26`–`src/isExpired.ts:27`）。注意：stale 分支**不发** `getCachedValueOutdated`（该事件只在 `expired === true` 时发，`src/getCachedValue.ts:51`–`src/getCachedValue.ts:53`）。

```
调用方 A                    adapter / 内部递归
────────────────────────────────────────────────────────────────────────────────
A: G(key)  R getCachedValueStart → getCachedValueRead
   isExpired === 'stale'
   组装 staleRefreshOptions（forceFresh:true, fallbackToCache:false）
     ─ getCachedValue.ts:56-74
   waitUntil( 内部 cachified(...) ) ............................ getCachedValue.ts:81
     │  （内部调用只是被排队；loader 尚未运行：
     │   内部 loader 先 await sleep(staleRefreshTimeout)，
     │   staleRefreshTimeout 在 createContext 中被硬编码为 0
     │   src/common.ts:284；setTimeout(0) 是宏任务）
     │     ┌─ 微任务阶段 ─────────────────────────────────────┐
     │     │ 内部 cachified 同步执行到 pending 注册并 await   │
     │     │ （cachified.ts:87-92）；sleep(0) 的 await 挂起   │
     │     └──────────────────────────────────────────────────┘
   checkValue 通过 → R getCachedValueSuccess
 A ◀── stale 值；R done（cachified.ts:51）；fulfill(stale)   ← 返回先发生
──────────────────────────────── 宏任务：setTimeout(0) 到期 ────────────────────────
     内部: R refreshValueStart ................................ :66
     L({background:true}) 被调用（外部 reporter 看到此事件）... :67-70
     R getFreshValueStart/Success（内部调用不接收 reporter 参数，
       这些事件无人接收，见下）
     S(key, entry) ............................................ getFreshValue.ts:65
     R writeFreshValueSuccess（同样无人接收）
     内部 R done（无人接收）
     waitUntil 的 promise.then → R refreshValueSuccess ........ getCachedValue.ts:84
     若 L reject：.catch → R refreshValueError ................ :86-88
```

要点与错误传播：

- 调用方拿到的是 **stale 值**，且返回发生在 `S`、`refreshValueStart/Success` 之前。这是题目所说“返回发生在某些副作用之前”的主要来源。确定性证明见 `src/analysis.spec.ts:105`（`returns the stale value first and starts the background refresh exactly once`）：在只 flush 微任务、不推进任何定时器时，两个并发调用都已 fulfill 为 stale 值，且 loader 调用次数为 0。
- 后台刷新的成功/失败**只进 reporter**：成功发 `refreshValueSuccess`，失败发 `refreshValueError`（`src/getCachedValue.ts:83`–`src/getCachedValue.ts:88`），不会 reject 调用方的 promise。
- 内部递归 `cachified(staleRefreshOptions)` 调用时没有传第二个 reporter 参数（`src/getCachedValue.ts:82`），其内部事件（`getFreshValueStart`、`writeFreshValueSuccess`、内部的 `done` 等）没有接收者；外部 reporter 只能观察到 `refreshValueStart/Success/Error`。
- 刷新失败时**不删除** stale 条目（失败路径在 `getFreshValue.ts:23`–`src/getFreshValue.ts:42` 重新 throw，被 `.catch` 吞进 reporter；没有任何 delete 调用）。已由 `src/analysis.spec.ts:262` R1 断言：事件序列以 `refreshValueError` 结束，且 adapter 中条目仍在。

**并发调用能否共用刷新：能，但去重发生在内部递归层。** 两个并发的外部 stale 调用各自先读缓存、各自拿到 stale 值并各发一次 `getCachedValueSuccess/done`（外部 reporter 上看不到 `getFreshValueHookPending`）；它们排队的两个内部 `forceFresh` 递归共用同一条 pending 记录——第一个内部调用注册 pending，第二个进入 `src/cachified.ts:55`–`src/cachified.ts:65` 分支发 `getFreshValueHookPending` 并 await 同一 promise。净效果：后台 loader 只运行一次，两个 waitUntil promise 都成功。证明：`src/analysis.spec.ts:105` 断言 background loader 调用次数恰为 1、`refreshValueStart` 恰为 1 次、两个调用各自收到一次 `refreshValueSuccess`。既有测试 `src/cachified.spec.ts:610`（`de-duplicates stale refreshes`，断言 `log === ['1','2']`）是同一行为的另一佐证。

## 3. Expired miss（超过 TTL+SWR）

`isExpired` 返回 `true`（`src/isExpired.ts:31`）；`now > createdTime + ttl + swr`。

```
调用方                    adapter/getFreshValue
────────────────────────────────────────────────────────────────────────────────
G(key)  R getCachedValueStart → getCachedValueRead
  R getCachedValueOutdated {value, metadata} .................. :52（含条目快照）
  staleRefresh = false（普通 swr） ............................. :47-49
  checkValue 仍会执行；通过则返回旧值? ─ 否：:92 条件 !expired || staleRefresh 均为假
  → getCachedValue 返回 CACHE_EMPTY（不删除条目，不发 delete）
cachified.ts:55 pending 分支：无 pending / pending 已过期则跳过
R getFreshValueStart .......................................... getFreshValue.ts:16
L({background:false})
  成功 → R getFreshValueSuccess ................................. :22
       S(key, entry) ........................................... :65（见下注）
       R writeFreshValueSuccess {written} ...................... :67-72
  失败 → R getFreshValueError .................................. :24
       非 forceFresh（fallbackToCache 无效）→ throw ............ :38-41
R done（成功）; fulfill(value) / reject(error)
```

注：`write` 的判定基于**新条目的 metadata** 在 loader 返回时是否已彻底过期（`src/getFreshValue.ts:63`），与缓存里的旧条目无关。正常 TTL 配置下会调用一次 `S` 覆盖旧条目；loader 失败则不调用 `S` 也不调用 `D`——旧的过期条目原样留在 adapter 中。由 `src/analysis.spec.ts:314` R2 验证：loader reject 时调用方收到同一个 error，事件止于 `getFreshValueError`，adapter 操作只有一次 `get`，旧值仍在。

## 4. Invalid schema（缓存值校验失败）

```
调用方                    adapter/getCachedValue
────────────────────────────────────────────────────────────────────────────────
G(key) → R getCachedValueStart / getCachedValueRead
assertCacheEntry 抛错（形状非法）:
  R getCachedValueError {error} ............................... :147
  D(key) ..................................................... :149
  → CACHE_EMPTY，随后进入正常 loader 流程
形状合法但 checkValue 失败（schema throw / 返回 false 或字符串）:
  R checkCachedValueErrorObj {reason} ......................... :134
  R checkCachedValueError {reason:string} ..................... :135-141
  D(key) ..................................................... :143
  → CACHE_EMPTY，随后进入正常 loader 流程
loader 成功则 S + done + fulfill；loader 也失败则 error 传播给调用方
```

错误传播：校验本身的错误**不向调用方传播**（被 `try/catch` 转成两个 reporter 事件，`src/getCachedValue.ts:146`–`src/getCachedValue.ts:150`）；它的唯一副作用是 `D(key)`，随后“缓存为空”照常走 loader。调用方只有在后续 loader/新值校验也失败时才会收到 rejection。

补充：`D(key)` 自身若 reject，错误会跳过“走 loader”直接传播给调用方，且 loader 不会被调用——见风险点 R3。形状非法时的 reporter 行为有既有测试覆盖：`src/cachified.spec.ts:1638`（`does not use faulty cache entries`）。

## 5. Loader reject（前台取新值失败）

```
调用方                    getFreshValue
────────────────────────────────────────────────────────────────────────────────
R getFreshValueStart
L() 同步 throw / 返回 rejected promise
R getFreshValueError {error} ................................. :24
forceFresh 且 fallbackToCache > 0 ?
  是: 再 G(key)（R getCachedValueStart/Read），条目存在且年龄
      ≤ fallbackToCache → R getFreshValueCacheFallback，返回缓存值 .... :29-37
  否: throw error（同一 error 对象） .......................... :41
      → getFreshValue 无 write 阶段（写缓存 try 块在 :61 之后）
cachified.ts:94 的 await 直接 reject；R done 不发出；调用方 rejection
```

错误传播：`getFreshValueError` 进 reporter；原始 error 继续向调用方传播（`forceFresh:false` 时没有缓存回退分支，因为回退只对 forced 请求开放，`src/getFreshValue.ts:28`）。由 `src/analysis.spec.ts:314` R2 验证（reject 与抛出的是同一个 Error 引用）。

新值 checkValue 失败是相邻但不同的路径：发 `checkFreshValueErrorObj` + `checkFreshValueError`（`src/getFreshValue.ts:47`–`src/getFreshValue.ts:54`），随后抛出的是一个**新包装的** `Error('check failed for fresh value of <key>')`（cause 为原 reason，`src/getFreshValue.ts:56`–`src/getFreshValue.ts:58`），同样不写缓存、向调用方传播。

## 6. Soft purge

`softPurge` 不经过 `cachified()`，没有 reporter、不产生任何 reporter 事件；它只做一次 `G` 与至多一次 `S`（`src/softPurge.ts:24`、`src/softPurge.ts:34`）。

```
调用方                adapter
────────────────────────────────────────────────────────────────────────────────
softPurge({cache, key})
 G(key)（经 getCacheEntry；传的是 no-op reporter，src/softPurge.ts:24）
 条目不存在 / assertCacheEntry 抛错 / isExpired 非 false → 直接 return（无 S）
 仍 fresh：
   S(key, { value: 旧值, metadata: {
       createdTime: 旧 createdTime,                 src/softPurge.ts:39
       ttl: 0,                                     :37
       swr: 未给覆盖值 ? 旧ttl + 旧swr : 覆盖值 + (now-createdTime)  :38
   }})
 此后任何 cachified 读该 key：isExpired 立即返回 'stale' → 走第 2 节流程
```

即 soft purge 把剩余 TTL 折叠进 stale 窗口，下一次读返回旧值并触发后台刷新。覆盖 swr 的语义与示例由既有测试覆盖：`src/softPurge.spec.ts:41`、`src/softPurge.spec.ts:77`、`src/softPurge.spec.ts:92`。已过期/空条目直接 no-op：`src/softPurge.spec.ts:11`、`src/softPurge.spec.ts:23`；非法条目的 assert 错误会向 `softPurge` 调用方传播：`src/softPurge.spec.ts:29`。

## 7. Batch partial failure

`createBatch` 把每个 `batch.add(param)` 返回的 loader 收集到数组，首次微任务调度后一次性调用批量函数（`src/createBatch.ts:74`–`src/createBatch.ts:79`；去重计数在 `:93`–`:99`）。

7a. **批量函数整体 reject / 返回长度不符**（`src/createBatch.ts:80`–`src/createBatch.ts:90`）：
```
批量函数 throw 或 reject → catch 中对每个等待者调同一个 rej(err) :88
长度不符 → 构造长度错误后同样进入 catch 全量 reject   :80-84, 88
每个 cachified 调用：R getFreshValueError 后按第 5 节传播；
没有一个 key 被 set；所有调用方拿到同一个 error 引用
```

7b. **批量函数成功，但其中单个值 checkValue 失败**（逐项独立，`src/createBatch.ts:85`）：
```
结果数组逐项 resolve 各 loader promise ............... :85
  成功项: getFreshValueSuccess → 校验通过 → S(key) → writeFreshValueSuccess → done
  失败项: getFreshValueSuccess（原始值仍上报）
          → checkFreshValueErrorObj → checkFreshValueError
          → throw 包装 Error（getFreshValue.ts:56）
          → 无 S；仅这一项的调用方 reject；其他项不受影响
```

错误传播：7a 是“全挂”，错误原样广播给全部调用方（既有测试 `src/cachified.spec.ts:1460`）；长度错误同样全挂（既有测试 `src/cachified.spec.ts:1767` 附近的 `rejects all values when batch loader returns wrong array length`）。7b 是“逐项隔离”，只有校验失败的 key reject，同批其他 key 正常写缓存并 fulfill——由新增 `src/analysis.spec.ts:452` R5 验证：三个 key 中 `k2` reject（message 为 `check failed for fresh value of k2`），`k1/k3` fulfill 且各自 adapter 中有值，`k2` 从未被 set；同测试下半段验证 7a：批量函数 throw 时三个 promise 以同一个 error reject。

## 五个风险点

每个风险点给出 fake clock 时间、初始条目、调用序列、预期事件数组。五条均由 `src/analysis.spec.ts` 中的同名测试（R1–R5）机器校验；reporter 只收集事件 `name`，时间用 `jest.setSystemTime` 手动推进，loader 用手动控制的 deferred，不使用 sleep。

### R1 — 后台刷新失败只进 reporter，stale 条目保留，调用方无感知

- 时间：播种于 t=0；调用时 t=15。
- 初始条目：`{metadata:{createdTime:0, ttl:10, swr:50}, value:'v1'}`（15 落在 stale 窗口）。
- 调用序列：一次 `cachified`（`ttl:10, swr:50`，loader 返回一个挂起的 deferred，`waitUntil` 收集后台 promise）→ 调用方 fulfill 为 `'v1'`（此时 loader 尚未被调用）→ 手动推进 0ms 定时器，loader 恰好启动一次 → `deferred.reject(new Error('boom-refresh'))` → 等待后台 promise。
- 预期事件数组（外部 reporter，测试 `src/analysis.spec.ts:262`）：

```
['getCachedValueStart','getCachedValueRead','getCachedValueSuccess','done',
 'refreshValueStart','refreshValueError']
```

- 风险含义：调用方在 `done` 后已经拿到值并继续执行，刷新失败永远不会以 rejection 形式出现；监控只看 promise 的调用方会漏掉这次失败。条目也不被删除，下一次读仍是同一 stale 值并再次尝试刷新。

### R2 — 彻底过期 + loader 失败：错误传播给调用方，但过期条目不被清理

- 时间：播种于 t=0；调用时 t=100。
- 初始条目：`{metadata:{createdTime:0, ttl:10, swr:5}, value:'old'}`（100 > 15，彻底过期）。
- 调用序列：一次 `cachified`（loader 返回 rejected promise）。
- 预期：调用方以**同一个 error** reject；事件数组（测试 `src/analysis.spec.ts:314`）：

```
['getCachedValueStart','getCachedValueRead','getCachedValueOutdated',
 'getFreshValueStart','getFreshValueError']
```

- adapter 操作序列仅为 `['get:k']`；`'old'` 仍在缓存中。
- 风险含义：与 R1 相反，这里错误是硬失败；但“过期条目不删除”意味着下一次调用还会先付出一次 `get` 与 `getCachedValueOutdated` 的代价。若 adapter 的 `get` 对过期条目有自己的清理策略，行为会与该基线不同（取决于 adapter，不在库保证范围内——见推测项）。

### R3 — 清理坏条目时 `cache.delete` 失败：真正的错误被遮蔽，loader 根本不运行

- 时间：t=0（时间无关）。
- 初始条目：adapter 中 key `k` 存的是字符串 `'not-an-entry'`；adapter 被安排为下一次 `delete` reject（`Error('boom-delete')`）。
- 调用序列：一次 `cachified`（loader 正常返回 `'v'`）。
- 预期：调用方以 `boom-delete` reject；loader 调用 0 次；事件数组（测试 `src/analysis.spec.ts:351`）：

```
['getCachedValueStart','getCachedValueRead','getCachedValueError']
```

- 风险含义：按设计，坏条目本应“删除后走 loader 兜底”（`src/getCachedValue.ts:143` 与 `:149`），但 `await cache.delete(key)` 的失败直接跳出整个流程，调用方看到的是存储层错误而不是“条目损坏”，且一次本来可以成功的取数被放弃。`checkCachedValueError*` 分支有同样的 `await cache.delete(key)` 暴露面（`:143`）。

### R4 — pending 条目过期后不共享：晚到的调用重复打 loader，并用自己的结果“反向 resolve”早到的调用

- 时间：t=0 调用 1 的 loader 挂起；t=200（超过其 ttl=100）时发出调用 2。
- 初始条目：无。
- 调用序列（测试 `src/analysis.spec.ts:383`，两个手动 deferred）：
  1. 调用 1（`ttl:100`）→ flush 微任务 → loader-1 已启动（`loaderLog === ['loader-1']`）；
  2. t→200；调用 2 同 key → flush 微任务 → loader-2 也启动（`['loader-1','loader-2']`）；
  3. `d2.resolve('B')`：调用 2 fulfill `'B'`；
  4. `d1.resolve('A')`：调用 1 **fulfill 的也是 `'B'`**（`src/cachified.ts:82`–`:85` 的 future-wins 联动）。
- 预期事件数组：

```
调用 2 的 reporter:
['getCachedValueStart','getCachedValueRead','getCachedValueEmpty',
 'getFreshValueStart','getFreshValueSuccess','writeFreshValueSuccess','done']
（writeFreshValueSuccess.payload.written === true，缓存最终为 'B'）

调用 1 的 reporter（关键部分）:
含 'getFreshValueSuccess'（其 payload 为它自己 loader 的 'A'），
其 writeFreshValueSuccess.payload.written === false
（src/getFreshValue.ts:63：等它的 promise settle 时 metadata 已彻底过期），
且 'done' 发生在它自己 loader 返回之前（值已被调用 2 反向喂入）。
```

- 风险含义：去重以 pending 条目的 metadata 是否过期为准（`src/cachified.ts:58` 调 `isExpired`）。loader 慢到超过自身 TTL 时，并发保护失效——两个 loader 都会真正执行；并且调用 1 的返回值与“它自己 loader 的结果”脱钩：调用方 1 拿到 `'B'`，但它的 reporter 里记录的 fresh 值是 `'A'`，排查时容易误判。

### R5 — batch 部分失败：逐项校验失败只拒绝单项；批量函数失败则全项同错

- 时间：t=0（时间无关）。
- 初始条目：无（三个 key `k1/k2/k3`）。
- 调用序列（测试 `src/analysis.spec.ts:455`）：一个 `createBatch`，批量函数对 `[1,2,3]` 返回 `['v1','bad','v3']`；每个调用带 `checkValue`，值为 `'bad'` 时返回字符串原因 `'bad-value-reason'`。三个 `cachified` 经 `Promise.allSettled` 并发。
- 预期：
  - settle 状态：`['fulfilled','rejected','fulfilled']`，值分别为 `'v1'`、reject（message `check failed for fresh value of k2`）、`'v3'`；
  - adapter：`k1='v1'`、`k2` 不存在、`k3='v3'`；
  - 失败项事件数组（k2 reporter）：

```
['getCachedValueStart','getCachedValueRead','getCachedValueEmpty',
 'getFreshValueStart','getFreshValueSuccess',
 'checkFreshValueErrorObj','checkFreshValueError']
```

  - 成功项事件数组（k1 reporter，k3 同构）：

```
['getCachedValueStart','getCachedValueRead','getCachedValueEmpty',
 'getFreshValueStart','getFreshValueSuccess','writeFreshValueSuccess','done']
```

- 同测试后半段（7a 全挂模式）：批量函数直接 `throw new Error('batch-down')` 时，三个 promise 全部 reject 且 reason 为**同一个** error 引用。
- 风险含义：批量语义不是事务——逐项结果之间没有隔离回滚（成功的 key 已落缓存），调用方必须用 `allSettled` 式处理；而批量函数自身失败时错误被广播给全部等待者（`src/createBatch.ts:88`），两种失败的爆炸半径完全不同。另注意长度不符被当作“批量函数失败”处理（`src/createBatch.ts:80`–`:84`）。

## 错误传播总表

| 错误来源 | 向调用方传播？ | reporter 事件 | adapter 副作用 |
|---|---|---|---|
| fresh/stale 值的 checkValue 失败 | 否（转走 loader） | `checkCachedValueErrorObj` + `checkCachedValueError` | `delete(key)`（`src/getCachedValue.ts:143`） |
| 缓存条目形状非法 / `cache.get` 抛错 | 否（转走 loader） | `getCachedValueError` | `delete(key)`（`:149`） |
| 上述 `delete` 自身失败 | **是**（中断，loader 不运行，R3） | 已发出的错误事件 + 无后续 | delete 失败 |
| 前台 loader reject | **是**（同一 error，`:41`） | `getFreshValueError` | 无 |
| forceFresh 时 loader reject 且允许回退 | 否（用缓存值） | `getFreshValueError` + `getFreshValueCacheFallback` | 无（`src/getFreshValue.ts:28`–`:37`） |
| 新值 checkValue 失败 | **是**（包装后的新 Error，`src/getFreshValue.ts:56`） | `checkFreshValueErrorObj` + `checkFreshValueError` | 无 set |
| `cache.set` 写缓存失败 | 否 | `writeFreshValueError`（`src/getFreshValue.ts:74`） | set 失败；值仍返回 |
| 后台（stale）刷新任何失败 | 否 | `refreshValueError`（外部 reporter） | 无（不删条目，R1） |
| softPurge 遇非法条目 | **是**（assert 抛出） | 无 reporter | 无 |
| batch 批量函数 reject / 长度不符 | **是**，全部等待者同错 | 各调用上的 `getFreshValueError` | 无 set（R5/7a） |
| batch 单项值校验失败 | **仅该项** reject | 该项 `checkFreshValueErrorObj` + `checkFreshValueError` | 其他成功项照常 set（R5/7b） |

## 并发共用刷新一览

| 情形 | 是否共用一次 loader | 依据 |
|---|---|---|
| 同 cache、同 key 的并发 miss（pending 未过期） | 是；后者发 `getFreshValueHookPending` | `src/cachified.ts:55`–`:65`；新增测试 `src/analysis.spec.ts:211` |
| 同 key 的并发 stale 读 | 外部读不共用（各返回 stale）；内部 forceFresh 刷新共用，loader 一次 | `src/getCachedValue.ts:81`、`src/cachified.ts:55`；测试 `src/analysis.spec.ts:105` |
| pending 已过期（loader 耗时超过 TTL） | **否**，第二个调用再起一个 loader（R4） | `src/cachified.ts:58` |
| 不同 cache 对象 | 否 | WeakMap 以 cache 为键，`src/cachified.ts:16` |
| 不同 key | 否 | 内层 Map 以 key 为键，`src/cachified.ts:16` |
| `forceFresh: true` 的调用与普通 pending | 内部刷新为独立 forceFresh 递归；过期 miss 不会复用过期 pending | `src/getCachedValue.ts:72`、`src/cachified.ts:58` |

## 确定性测试说明（无 sleep、无私有 map 读取）

- 文件：`src/analysis.spec.ts`。全部用例使用 `jest.useFakeTimers()` + `jest.setSystemTime(t)` 手工拨钟；loader 由文件内 `Deferred`（`src/analysis.spec.ts:83`）手动 resolve/reject；没有任何 `setTimeout` 等待或真实 sleep，也不读取 `getPendingValuesCache` / 任何私有 Map。
- 关键用例 `returns the stale value first and starts the background refresh exactly once`（`src/analysis.spec.ts:105`）证明顺序：
  1. 两个并发调用在**不推进任何定时器**时就 fulfill 为 stale 值，且 loader 计数为 0；
  2. `advanceTimersByTimeAsync(0)` 后 background loader 恰好启动一次（`contexts` 中 `background:true` 恰一条）；
  3. 后台 promise 全部 settle 后：`refreshValueStart` 恰一次、两个外部 reporter 各收一次 `refreshValueSuccess`、缓存中是新值。
- 并发 miss 去重用例 `shares one pending foreground load and reports getFreshValueHookPending once`（`src/analysis.spec.ts:211`）给出可直接核对的完整事件数组（含一次 `getFreshValueHookPending`）。
- 复现 adapter 的 `get` 返回 Promise（一个微任务边界）；这与既有 stale 去重测试的前提一致（`src/cachified.spec.ts:610` 的 Map adapter 本身是同步的，但调用间通过 await 交错；本文件统一采用异步 get 消除交错歧义）。

## 推测与未验证项

以下内容不能仅由当前源码静态确认，未作为既定结论写入时间线；如需定论应另加测试：

1. **真实事件环（macrotask）延迟下的去重窗口大小**：后台刷新被 `sleep(staleRefreshTimeout)`（固定 0ms）推迟。本文只在 fake timer 下证明了“stale 返回先于 loader 启动”与“loader 只启动一次”；真实 Node 环境中 setTimeout(0) 的最小延迟、以及 `waitUntil` 不被 await 时的服务器关停行为未验证。
2. **adapter 的 `set/delete/get` 返回 thenable 时的交错**：源码对这些调用全部 `await`（如 `src/getFreshValue.ts:65`、`src/getCachedValue.ts:143`/`:149`），慢 adapter 会扩大“返回与副作用之间”的窗口；本文未对慢 `set` 做测试。
3. **完全同步的 `cache.get` 下两个并发 stale 调用**：编写测试时观察到，当 `get` 同步返回时，第二个外部调用可能在第一个调用的内部刷新递归注册 pending 之前就完成 pending 检查（微任务调度顺序不同）。既有测试 `src/cachified.spec.ts:610` 的 Map 是同步的但仍去重成功，差异来自调用间的 await 交错。同步 adapter 是否在所有调度顺序下都保证去重，本文未给出证明；最小复现代码与新增测试统一使用异步 `get`。
4. **`staleRefreshTimeout` 选项的用户传值**：`createContext` 将其硬编码为 0（`src/common.ts:284`），`CachifiedOptions.staleWhileRevalidate` 之外的 `staleRefreshTimeout` 声明为 deprecated（`src/common.ts:181`–`:191`）。用户即使在 options 中传入也会被覆盖，这一行为由代码可读但未新增测试。
5. **无限 SWR + 彻底过期判定**：`staleRefresh` 在 `expired === true && staleWhileRevalidate === Infinity` 时也为真（`src/getCachedValue.ts:47`–`:49`）；但 `isExpired` 对 swr=Infinity（序列化为 `null`）实际上返回不了 `true`（`src/isExpired.ts:18`、`src/common.ts:331`）。该分支是否在任何 metadata 组合下可达，未验证。

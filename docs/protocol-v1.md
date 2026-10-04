# Memory service protocol v1

> The host half (`src/index.ts`) provides one service named `memory`. This document freezes its surface so a
> third party can depend on it. It is the English twin of [protocol-v1.zh.md](protocol-v1.zh.md); the two are
> kept section by section, and `tests/protocol.test.ts` asserts every promise below against the shipped
> `lib/index.js`.
>
> Everything here was read off the implementation, not off intent. Where the implementation and this document
> disagree today, the disagreement is listed in §8 and left for the Lead to rule on — it is not silently patched.

## 1. Protocol version and stability promise

This is **v1**. Within v1 the service only grows:

- method names, argument meaning, the keys of every return shape, the error codes in §3.4, and the three
  payload rules in §4.4 are frozen;
- new **methods** may be added, and **optional** fields may be added to `MemoryRecord` / `MemoryRecallHit`
  (existing consumers must ignore unknown keys — do not exhaustively check shapes);
- new **optional** input keys may be added to `write` / `recall` / `list`.

Anything that breaks the above — renaming or removing a method, changing what a field means, making an
optional field required, changing which inputs feed the dedup fingerprint — is a **breaking change**: it must
bump the protocol version (`v2`), land in its own release, and be described in `CHANGELOG.md`. Plugin versions
still advance by one patch (`0.5.16 → 0.5.17`); the protocol version and the package version are independent.

A method that is going away keeps working for the whole of v1 and is marked deprecated in this document first.

The revision you are reading is **v1.3**. v1.1 was a **pure addition** on top of v1.0: `list()` gained optional
`status` / `branch` / `limit`, `recall()` two optional filters, `write()` the `persisted` field, and the service's
`protocolVersion` moved from `'1.0'` to `'1.1'` (§9). v1.2 is again a **pure addition**, this time on top of v1.1:
`list()` / `recall()` accept a **branch array**, `stats()` gained the `writes` counters, every `write()` **success**
shape gained `refs`, and the service's `protocolVersion` moved from `'1.1'` to `'1.2'` (§10). Nothing a `'1.0'` or
`'1.1'` consumer relied on changed — every no-argument call is byte for byte what 0.5.18 returned (§3.1, §3.3).
v1.3 is again a **pure addition**, this time on top of v1.2: the host may **inject an embedder** through the service
surface (`setEmbedder`), `capabilities()` / `lastRecall()` are new read-only methods, `stats()` gained the
`embedder` diagnostics, and `recall()` gained an optional `mode` (§11). The service's `protocolVersion` moved from
`'1.2'` to `'1.3'`. Nothing a `'1.0'`, `'1.1'` or `'1.2'` consumer relied on changed — with no embedder registered
every call is byte for byte what 0.5.19 returned, and `recall({ mode: 'lexical' })` (the default) makes **zero**
embedding calls (§3.3, §11).

Today the service object **does** carry `protocolVersion` (`'1.3'`); read it first and degrade readably on an
unknown version rather than assuming. Decide compatibility with a `'1.x'` predicate (`/^1\./u`), **not** string
equality: v1.1 already asked for this, v1.2 kept it and v1.3 still does — a consumer that compared
`protocolVersion === '1.2'` would lock itself out of `'1.3'`, so compare on the prefix / major–minor only. §9, §10
and §11 have minimal snippets that do exactly that.

## 2. Locating the service, and what to do when it is absent

The service is registered exactly once, inside `apply()`:

```ts
ctx.provide('memory', { protocolVersion, list, stats, recall, write, consolidate, setEmbedder, capabilities, lastRecall })
```

`setEmbedder` / `capabilities` / `lastRecall` are the v1.3 additions (§3.6, §11); a `'1.2'` service simply does not
have them.

### 2.1 Wiring the host half up (read this off the implementation)

The plugin is a DSH/Cordis plugin: its entry point is `apply(ctx, config)`, and everything it touches comes through
`ctx`. **The required seams are exactly these** (declared by `export const inject` in `src/index.ts`):

```ts
export const inject = ['agents', 'systemPrompt', 'storageDomain', 'tools', 'commands']
```

A minimal `apply` for an embedder-registering host looks like this — no import of the plugin's internals, only the
seams below:

```ts
export function apply(ctx: MyHostContext, config: Record<string, unknown>): void {
  // 1) The only required seam for the service surface: `provide` (optional — §2's table).
  ctx.provide('memory', { /* the host may expose its own sibling service here */ })

  // 2) Own the lifetime of anything you add: `ctx.effect(setup)` returns the disposer and DSH runs it on unload.
  ctx.effect(() => {
    const stop = startSomething(ctx)
    return () => stop()
  })

  // 3) Scope an optional service: the callback never runs (and never blocks the fiber) while it is absent.
  ctx.inject(['settings'], (scope) => { scope.effect(() => () => teardown()) })

  // 4) Consume the memory service — feature-detect, never assume (§2's rules below).
  const memory = ctx.get('memory') as { setEmbedder?: (e: unknown) => unknown } | undefined
  if (memory?.setEmbedder) memory.setEmbedder(myEmbedder)

  // 5) The surfaces the plugin itself registers into: systemPrompt, tools.register, commands.register, and the
  //    event bus (`ctx.on('session/event', …)`, `ctx.on('agent/pre-step', …)`, `ctx.on('agent/turn-stopping', …)`).
}
```

The seams, **as the implementation uses them** (this is the list to code against; anything not listed here is
internal and may change between patches, §2 rule 3):

| seam | how the plugin uses it | required? |
|---|---|---|
| `ctx.provide(name, service)` | publishes the `memory` service (§2). Wrapped in `try/catch`: a host without it keeps the plugin working, `ctx.get('memory')` is simply always `undefined` | optional |
| `ctx.inject([...])` | scoped injection — used for the optional `settings` service so an absent service never blocks the plugin's fiber | optional |
| `ctx.effect(fn, label?)` | lifetime + teardown: the returned callback is what closes the storage domain on unload (see *Unload* below) | required in practice (persistence and clean-up hang off it) |
| `ctx.on(event, handler)` | `session/event` (sequence tracking, capture, compaction summaries), `agent/pre-step` (per-turn recall), `agent/turn-stopping` (turn-end capture) | required for capture/injection |
| `ctx.systemPrompt.section(...)` / `ctx.systemPrompt.context(...)` | the two resident injection channels | required for resident blocks |
| `ctx.tools.register(tool)` | the seven `memory_*` tools | optional |
| `ctx.commands.register(command)` | `/memory …` and `/sleep` | optional |
| `ctx.get('storageDomain')` / `ctx.get('sessionQuery')` / `ctx.get('settings')` | optional services, feature-detected | optional |
| `ctx.get('memory')` | how a **third party** consumes the service (§2) | — |

### 2.2 The storage handle `ctx.storageDomain.open()` must return

The plugin calls `open()` once and keeps the handle for its lifetime. It only uses two shapes, so a host domain has
to provide at least these:

```ts
const domain = await ctx.storageDomain.open({
  name: cfg.domainName,          // the domain name (also the on-disk directory name)
  version: 1,
  layout: 'per-record',
  tables: { memories: { valueSchema: passthroughSchema } },
  global: { schema: passthroughSchema, initial: { schemaVersion: 1, collectionVersion: 0 } },
})

// the two things the plugin needs from the handle:
await domain.global.get()               // the watermark object ({ schemaVersion, collectionVersion, … }) — awaited
await domain.global.set(meta)           // written back on durable state changes
for (const entry of domain.table('memories').entries()) { /* … */ }   // load-all: [key, value] or value
await domain.table('memories').put(record.id, record)                 // persist one record
await domain.table('memories').delete(record.id)                      // remove one record
await domain.close()                    // called on unload (see below)
```

- `global.get()` is **asynchronous in the shipped runtime** and must be awaited — storing the raw thenable leaves the
  watermark unreadable (the plugin's own comment on this is in `src/index.ts`).
- `table('memories')` must answer `entries()` (an iterable of `[key, value]` pairs or plain values; the loader accepts
  both), `put(key, value)` and `delete(key)`.
- `open()` rejecting (or `storageDomain` being absent) is not fatal: `stats().opened` stays `false`, writes report
  `persisted: false`, and the plugin keeps serving from memory (§8 gap 3).

### 2.3 Unload and clean-up

- **There is a dispose path, and the plugin owns it.** Registration in `ctx.effect(() => …)` hands DSH a teardown
  callback; the plugin uses it to flush accumulated usage, drop its domain reference and then call `domain.close()`.
  Nothing of this is exposed on the service surface — an embedder registered through `setEmbedder` is released simply
  because the plugin instance goes away with it.
- **There is no `dispose()` on the `memory` service object**, so a third party cannot ask the plugin to shut down;
  **drop your reference on reload** and re-acquire, as §2's table says. The service keeps working until the host
  unloads the plugin.
- **Close order matters** and is the host's problem to mirror if it opens its own domains: flush first, then close —
  closing before the flush makes the last usage update fail silently.

### 2.4 Locating the service from a third party

Locate it with:

```ts
const memory = ctx.get('memory')
```

`ctx.get('memory')` is `undefined` in all of these cases, and a caller must handle every one of them:

| case | why |
|---|---|
| the plugin is not installed or not enabled in this profile | nothing ever called `provide` |
| the host has no `provide` seam | registration is wrapped in `try/catch`; the plugin keeps working without it |
| the plugin instance was unloaded | the host does not revoke references, so drop yours and re-acquire on reload |

Rules for callers:

1. **Feature-detect, never assume.** `const memory = ctx.get('memory') as MemoryService | undefined; if (!memory) return`
   — degrade silently; a missing optional service is not an error.
2. **Do not import a type for it.** The package exports `apply` / `Config` / `name` / `inject`, not the service
   type; declare your own minimal interface from §3 (that is what this document is for).
3. **Only this document is a seam.** The tool registrations, `/memory` + `/sleep` command output, the dev
   report file, the settings form and the storage domain layout are internal and may change between patches.
4. **Do not cache the reference across a plugin reload**, and do not mutate records returned by `list()` /
   `recall()` expecting persistence: they are the live in-memory objects (see §8 gap 5).
5. **`recall()` may hand you a Promise**: the default / `'lexical'` is a plain array, and so is
   `'semantic'` / `'hybrid'` while **no embedder is registered** (a synchronous lexical fallback); with an embedder
   registered, `'semantic'` / `'hybrid'` returns a Promise (§3.3). When in doubt, `await` once.

## 3. Methods

The service object, as signatures (the bodies are internal; §3.1–§3.6 fix the semantics):

```ts
interface MemoryService {
  protocolVersion: string            // '1.3'
  list(options?: ListOptions): MemoryRecord[]
  stats(): {
    records: number
    version: number
    opened: boolean
    /** 新增：本进程内累计的写入落盘结果（v1.2）。 */
    writes: { persisted: number; unpersisted: number }
    /** 新增（v1.3）：嵌入器运行状况；没注册 / 没用过时 id 为 null、计数全 0。 */
    embedder: {
      id: string | null
      dimensions: number | null
      /** 嵌入调用次数（批量算一次）。 */
      calls: number
      /** 失败的调用次数（抛出 / reject / 形状或维度不对 / 超时）。 */
      errors: number
      /** 向量缓存命中 / 未命中（未命中＝真的调了 embed）。 */
      hits: number
      misses: number
      /** 因超时被放弃的次数（含在 errors 里）。 */
      timeouts: number
    }
  }
  recall(options: RecallOptions): Array<{ record: MemoryRecord; match: number; score: number }>
  write(input: WriteMemoryInput): Promise<WriteMemoryResult>
  consolidate(reason?: string): Promise<void>
  /** 新增（v1.3）：注册 / 替换 / 清除宿主注入的嵌入器；传 `null` 清除。插件只调用它，绝不自己联网或带模型。 */
  setEmbedder(embedder: Embedder | null): { ok: true; id: string | null } | { ok: false; error: string }
  /** 新增（v1.3）：能力探测 —— 调用方据此决定用不用语义，不要靠猜。 */
  capabilities(): {
    protocolVersion: string
    lexical: true
    /** 是否已注册可用的嵌入器。 */
    embedder: boolean
    /** 已注册的 id（未注册为 null）。 */
    embedderId: string | null
  }
  /** 新增（v1.3）：上一次 `recall()` 的诊断；一次都没调用过时为 `null`。 */
  lastRecall(): {
    mode: 'lexical' | 'semantic' | 'hybrid'
    used: boolean
    fallback: 'no-embedder' | 'embed-error' | 'timeout' | null
    candidates: number
    vectors: number
  } | null
}
```

### 3.1 `list()`

- **Arguments:** optional `options`; the signature is frozen verbatim as:

```ts
list(options?: {
  /** 只看某个状态；`'all'` ＝ 不过滤（与今天一致）。缺省 = 'all'（**保持向后兼容**）。 */
  status?: 'active' | 'pending' | 'invalid' | 'archived' | 'all'
  /**
   * 分支过滤：
   *   `'current'`（字符串字面量）= 用**与注入完全相同的** `branchVisible` 口径过滤当前 cwd 的分支；
   *   其它字符串 = 只保留 `branchOf(record)` 等于该值的记录（外加无标签记录？**不**：只保留等于该值的）；
   *   数组（v1.2）= 只保留 `branchOf(record)` **落在数组里**的记录（无标签记录**不**算命中 —— 与单个字符串一致）；
   *   **空数组 ⇒ 空结果**（不是"不过滤"）；数组里的 `'current'` 按当前分支解析（等价于把当前分支名放进数组）；
   *   `null` = 不过滤。缺省 = 不过滤（向后兼容）。
   */
  branch?: 'current' | string | readonly string[] | null
  /** 最多返回几条（>=1；非法值忽略）。缺省 = 不限。 */
  limit?: number
}): MemoryRecord[]
```

| key | default | meaning |
|---|---|---|
| `status` | `'all'` | `'all'` = no filter (exactly today's behaviour). Any other value keeps only the rows whose §4.3 status is that value; `'active'` therefore never includes `pending`. |
| `branch` | unset | unset / `null` = no filter (today's behaviour). `'current'` applies the **exact same** `branchVisible` rule injection uses, for the current cwd. Any other string keeps only the records whose `branchOf(record)` equals that value — records with no branch tag are **not** added. **v1.2:** an **array** keeps only the records whose `branchOf(record)` is **in** the array, with the same "no tag is not a hit" rule; an **empty array yields an empty result** (it is *not* "no filter"); a `'current'` element is resolved against the current branch (the same as putting the current branch name into the array). |
| `limit` | unset | at most that many records (`>= 1`; an invalid value is ignored). |

- **Returns:** a fresh array of the records that survive the filters, in **insertion order** (load order, then
  write order). Called with **no argument** it is **every** record in the in-memory store, byte for byte what
  0.5.17 returned: same order, same contents, same live objects — no sorting and no filtering.
- **Effects:** filtering changes only the **returned set**; it never changes any record's state. A no-argument
  `list()` is still the raw, unfiltered view that sees `pending` / `invalid` / `archived` (an explicit
  `recall({ status: … })` is now the second audit door — §3.3).
- **Errors:** none (array allocation + a filter only).

### 3.2 `stats()`

- **Arguments:** none.
- **Returns:** `{ records: number; version: number; opened: boolean; writes: { persisted: number; unpersisted: number }; embedder: { … } }`
  — the three v1.0 keys, the v1.2 `writes` counters and the v1.3 `embedder` block (§3.6, §11).

| field | meaning |
|---|---|
| `records` | records held in memory (all statuses, same set as `list()`) |
| `version` | collection version, **read off the implementation** (§8 item 8): it is incremented as soon as a **put begins** — before `put` is awaited — so a `put` that then **throws still bumps it** (`persist()` bumps, then `catch`es the failure). A `delete` bumps it **only on success**; when `delete` throws the in-memory row is rolled back and `version` stays put. Use it as a "something was attempted / changed" signal, not as a durability proof (that is `opened` / `writes.persisted`). **Not** a storage schema version |
| `opened` | whether `ctx.storageDomain.open()` succeeded. `false` means writes are not reaching disk (see §8 gap 3) |
| `writes` *(new in v1.2)* | this process's running count of write-persistence outcomes. `persisted`: how often `persist()` returned true (the write really reached disk); `unpersisted`: how often the write was `ok: true` but did not reach disk (domain not open, or `put` threw). The counters only grow, they are per-process and reset on restart (the same nature as `version`). Rejections (`ok: false`) are **not** counted — they were never a write. They sit alongside the internal `state.writes` counters and do not reuse them (those have a different meaning). |
| `embedder` *(new in v1.3)* | embedder diagnostics: `id` / `dimensions` (`null` while none is registered), `calls` (a batch counts once), `errors` (throw / reject / wrong shape or mismatched dimensions / timeout), `hits` / `misses` (the vector cache; a miss means `embed` was really called) and `timeouts` (also included in `errors`). With no embedder registered every counter stays `0` and `id` / `dimensions` are `null`, so the stats line is exactly what 0.5.19 produced. Registration and semantics: §3.6, §11. |

- **Errors:** none.

### 3.3 `recall(options)`

- **Arguments:** `RecallOptions`; v1.1 adds two optional keys and v1.3 adds `mode`, frozen verbatim as:

```ts
interface RecallOptions {
  // …既有字段不变
  /** 状态过滤；缺省 = 今天的行为（active，`includeArchived: true` 时再含 archived）。 */
  status?: 'active' | 'pending' | 'invalid' | 'archived' | 'all'
  /** 分支过滤，语义与 `list` 的 `branch` 完全一致（v1.2 起同样接受数组；**空数组 ⇒ 空结果**）。缺省 = 不过滤（今天的行为）。 */
  branch?: 'current' | string | readonly string[] | null
  /** new in v1.3: the ranking channel. The default `'lexical'` is byte for byte 0.5.19, with zero embedding calls. */
  mode?: 'query' | 'memory' | 'lexical' | 'semantic' | 'hybrid'
}
```

| key | type | default | meaning |
|---|---|---|---|
| `query` | `string` | `''` | relevance query; empty/absent = no relevance filter |
| `kind` | `MemoryKind` | — | filter by kind |
| `scopeLevel` | `'profile' \| 'workspace' \| 'session'` | — | filter by scope level |
| `tag` | `string` | — | filter by exact tag |
| `limit` | `number` | `8` | clamped to 1…50 |
| `minLexical` | `number` | `0.34` | threshold for the **`'query'` lexical posture** (see `mode` below) |
| `minMatch` | `number` | `0.4` | threshold for the **`'memory'` lexical posture** |
| `minHits` | `number` | `2` | minimum informative-token hits for the **`'memory'` posture** |
| `includeArchived` | `boolean` | `false` | also consider `archived` records |
| `status` | `'active' \| 'pending' \| 'invalid' \| 'archived' \| 'all'` | absent = today's pool | which §4.3 statuses may be returned. Absent = today's behaviour (`active`, plus `archived` when `includeArchived === true`); `'all'` = active + pending + invalid + archived, order unchanged; `'pending'` is allowed — an explicit management/audit query (§9) |
| `branch` | `'current' \| string \| readonly string[] \| null` | unset = no filter | exactly `list`'s `branch` (§3.1): `'current'` = the injection's own `branchVisible` rule for the current cwd; any other string keeps only records whose `branchOf(record)` equals it; **v1.2:** an array keeps only the records whose `branchOf(record)` is in the array (no tag = not a hit) and an **empty array returns an empty result**; `null` / unset = no filter |
| `mode` | `'query' \| 'memory' \| 'lexical' \| 'semantic' \| 'hybrid'` | `'query'` | **one key, two separate vocabularies** — merged table below. The *lexical posture* decides **how the query side is scored**; the *ranking channel* decides **which side of the ranking the hits come from**. |

**`mode`: one key, two vocabularies (the §3.3 table used to disagree with §11 — this is the merged version).**

| value | vocabulary | semantics | default |
|---|---|---|---|
| `'query'` | lexical posture | the query is a **short query**: matching runs against the whole record text, threshold `minLexical` (0.34). Exactly the v1.0 behaviour | ✅ (when `mode` is absent) |
| `'memory'` | lexical posture | the query is a **whole-turn user message**: it runs the memory-side coverage test, thresholds `minMatch` (0.4) / `minHits` (2). v1.0 behaviour | — |
| `'lexical'` *(new in v1.3)* | ranking channel | "use the lexical channel" — **byte for byte the default**: identical to omitting `mode`, **zero** embedding calls | — (equivalent to the default) |
| `'semantic'` *(new in v1.3)* | ranking channel | order by embedding similarity; lexical only as the fallback when embeddings are unavailable | — |
| `'hybrid'` *(new in v1.3)* | ranking channel | `score = (1 - w) * lexical + w * semantic`, `w = cfg.embedderWeight` (default `0.5`) | — |

- **Do not read `mode` with a single union check.** `'query'` / `'memory'` and
  `'lexical'` / `'semantic'` / `'hybrid'` are the same key with **two disjoint meanings**: the first two select the
  lexical *posture* (how the query side is scored), the last three select the *ranking channel* (where the hits come
  from). Omitting `mode` is `'query'` **and** the lexical channel, so an existing caller that passes no `mode`, or
  only `'memory'`, keeps the exact v1.0 behaviour.
- **`'query'` / `'memory'` do not mean "no embeddings".** They are postures, not channels: `recall({ mode: 'memory' })`
  ranks lexically, but it is the *posture* that matters to it — the channel is lexical because nothing selects
  semantic. A caller that wants "whole-turn message + semantic ranking" passes `mode: 'semantic'` with the
  whole-turn text as `query`; the two vocabularies cannot be combined in one call.
- **Invalid values are not an error, and not a guess.** Any `mode` that is not one of the five strings is treated as
  **absent**: the call behaves as the default (`'query'` posture, lexical channel), no embedding happens, and
  `lastRecall().mode` reports `'lexical'` (§3.6). An invalid value never falls back to `'semantic'` and never throws.
  `recall()` therefore accepts any option shape — see *Errors* below.
- **What the two aren't:** `'lexical'` / `'semantic'` / `'hybrid'` are **not** `'query'` / `'memory'` synonyms, and
  their metadata is reported separately: `lastRecall()` only ever reports the **channel**
  (`'lexical' | 'semantic' | 'hybrid'`), never the posture.

- **Returns:** `Array<{ record: MemoryRecord; match: number; score: number }>`, sorted by `score` descending and
  then by the deterministic record order (§4.1), truncated to `limit`.
  - `match` is the relevance value (0…1) under the chosen channel; `score` is the ordering score (lexical + importance
    + recency).
  - Candidate pool: with `status` absent it is exactly today's pool — `status === 'active'` always, plus `archived`
    when `includeArchived === true`. **Without an explicit `status`, `pending` and `invalid` are never returned,
    whatever the other options say.** An explicit `status: 'pending' | 'invalid' | 'all'` is the only door that can
    return them — an audit query, never an injection path (injection passes no `status`).
- **Errors:** none for any option shape (absent options are tolerated at runtime).
- **Return type: synchronous unless it really embeds (v1.3).** The declared type is
  `RecallHit[] | Promise<RecallHit[]>`, and which one you get is decided by the call, not by a guess:
  - **default / `'lexical'` / an invalid `mode` value ⇒ a plain array.** No `await` needed, and no embedding call is
    made.
  - **`'semantic'` / `'hybrid'` with no embedder registered ⇒ a plain array too.** There is nothing to embed, so the
    call falls back to lexical **synchronously** and reports `lastRecall().fallback === 'no-embedder'` (§3.6) — it is
    still a lexical result, never a fake semantic one.
  - **`'semantic'` / `'hybrid'` with an embedder registered ⇒ a `Promise`** (the embedding call is asynchronous by
    contract). It resolves to the same `RecallHit[]` shape.
  - `await` works on both shapes (awaiting a non-promise is a no-op), which is what the examples in §6/§11 do.
  - Compatibility is unchanged: before v1.3 `recall` was synchronous, and a caller that passes no `mode` — i.e. every
    pre-v1.3 caller — still gets a plain array and behaves exactly as before.
- **Embedder fallback is reported, never hidden (v1.3).** With no embedder registered, `mode: 'semantic'` still
  returns a lexical result, and `lastRecall().fallback === 'no-embedder'`. An embedder that throws / rejects /
  times out / returns a wrong shape or mismatched dimensions is counted in `stats().embedder.errors` and reported
  as `'embed-error'` / `'timeout'` through `lastRecall()` (§3.6). Such a failure never rejects the call, never
  loses a record and never fails a turn; `mode: 'lexical'` is untouched by all of it and calls nothing.

### 3.4 `write(input)`

- **Arguments:** `WriteMemoryInput`. The service validates minimally since 0.5.17: `kind` must be one of the six
  enum values and `text` a non-empty string, otherwise the call returns
  `{ ok: false, error: 'rejected_invalid: …' }` without writing (§8).

| key | type | default | meaning |
|---|---|---|---|
| `kind` | `MemoryKind` | — | **pass it**: `user_profile` / `agent_self` / `project_gist` / `episodic` / `semantic` / `procedural`; also picks the default scope (§4.1) |
| `text` | `unknown` | `''` | coerced with `String(...)`; empty after `trim()` ⇒ `rejected_invalid` |
| `precision` | `'exact' \| 'gist'` | `'exact'` | |
| `origin` | `MemoryOrigin` | `'model_proposed'` | `user_explicit` / `user_correction` / `model_proposed` / `observed`; drives the write gate and the self-portrait quota |
| `scope` | `{ level, key }` | from `kind` | |
| `subject` / `field` / `value` | `string \| null` | `null` | normalized topic key / structured key / structured value |
| `tags` | `string[]` | `[]` | |
| `source` | `MemorySource \| null` | `null` | `{ sessionId, seqStart, seqEnd }` for rule-captured records |
| `confidence` / `importance` | `number` | `0.6` / `0.5` | 0…1 |
| `pinned` | `boolean` | `false` | pinned records sort first |
| `sessionId` | `string` | — | feeds `reinforcement.sessions` and the "mentioned again" boost |
| `facet` | `'persona' \| 'work'` | — | only meaningful for `agent_self`; **only when explicitly given** does the write run self-portrait convergence |
| `refVia` | see §4.2 | — | derive this write's reference from the tracked sequence |
| `refs` | `MemoryRef[]` | — | explicit references; takes precedence over `refVia` |
| `branch` | `string` | — | branch tag; omitted = applies to every branch. Changing it **changes the fingerprint** (§4.4) |

- **Returns:** a `WriteMemoryResult` object; success and rejection are both structured results (v1.1 adds
  `persisted` and v1.2 adds `refs` to every success shape, frozen verbatim as):

```ts
type WriteMemoryResult =
  | { ok: true; status: 'created' | 'merged'; id: string; record: MemoryRecord; boosted?: number; /** 新增 */ persisted: boolean; /** 新增（v1.2） */ refs: string[] }
  | { ok: true; pending: true; id: string; text: string; /** 新增 */ persisted: boolean; /** 新增（v1.2） */ refs: string[] }
  | { ok: false; error: string }
```

| shape | when |
|---|---|
| `{ ok: true, status: 'created', id, record, persisted, refs }` | a new record was applied; `persisted` says whether it reached the domain; `refs` carries its machine-readable references |
| `{ ok: true, status: 'merged', id, record, boosted?, persisted, refs }` | an `active` record with the same fingerprint already existed; it was updated in place |
| `{ ok: true, pending: true, id, text, persisted, refs }` | `writePolicy: 'ask'` queued a `model_proposed` write; **no `status` key**, nothing took effect |
| `{ ok: false, error: '<code>: <message>' }` | rejected; **no `persisted` key and no `refs` key**; `portrait` is added when self-portrait convergence produced a decision |

  `record` is the full record as stored (all required fields of §4.1). `portrait` is an internal convergence
  decision whose shape is **not** frozen in v1 — ignore it unless you are diagnosing self-portrait writes.
- **`persisted` (new in v1.1).** Whether **this write really reached the storage domain** (`persist()` succeeded).
  Domain not open, or `put` threw ⇒ `false`, while `ok` stays `true`. The `ok` meaning — "passed the gates and was
  applied to (or queued in) the in-memory store" — is **unchanged**; `persisted` just stops it being ambiguous.
  The rejection shape (`ok: false`) does **not** carry the field. Callers that ignore it are unaffected.
- **`refs` (new in v1.2).** The **machine-readable reference strings** the record carries after this write —
  `refsToString(refsOf(record))`, and `[]` when it has none. The caller no longer has to read `record` to get the
  provenance, and the `pending` path, which never had a `record` at all, now has provenance too. Rejections
  (`ok: false`) do **not** carry the field. Callers that ignore it are unaffected.
- **Error codes** (`error` always starts with the code, then `": "`):

| code | trigger |
|---|---|
| `rejected_sensitive` | hard secret (API key, private key, password, ID/card number) in `text` |
| `rejected_echo` | `origin: 'model_proposed'` and `text` is too similar to what was just injected |
| `rejected_write_policy` | `origin: 'model_proposed'` while `writePolicy === 'off'` |
| `rejected_by_user` | fingerprint was registered by `/memory reject` / `/memory reject-pending` |
| `pending_queue_full` | `pending` count reached `pendingMax` |
| `rejected_invalid` | `text` is empty after `trim()` |
| `portrait_skipped` | `agent_self` + `facet`: convergence decided not to apply this write |

  Match on the code prefix only. **The message after the code is Chinese in v1** — `language` switches
  model-visible tool text, not these strings, and the message text may be reworded in a patch release.
- **Errors:** the documented rejection paths never throw; they return the shapes above. A rejected promise means
  a fault outside those paths (e.g. a host-supplied object throwing) — treat it as a host failure, not a policy
  rejection.
- **`ok` does not mean "durable".** It means "passed the gates and was applied to (or queued in) the in-memory
  store". On v1.1 read `persisted` for durability (above); against a `'1.0'` service, check `stats().opened` and
  whether the row appears in `list()` before telling anyone the memory is safe (see §8 gap 3).

### 3.5 `consolidate(reason?)`

- **Arguments:** `reason?: string`, default `'manual'` (used in the report/summary only).
- **Returns:** `Promise<void>`, resolving to `undefined`.
- **Behaviour:** idempotent-ish housekeeping — merge near-duplicate items on the same subject, mark conflicting
  items `invalid`, archive by decay, recompute gists, summarize, flush usage. Re-entrant calls while a run is in
  flight are skipped; when the domain is not open it returns immediately.
- **Errors:** internal failures are recorded (`state.consolidate.last`, the report), not thrown; the call does
  not reject in practice.

### 3.6 `setEmbedder(embedder)` / `capabilities()` / `lastRecall()` (new in v1.3)

- **`setEmbedder(embedder | null)`** registers, replaces or (with `null`) clears the host-injected embedder. It is
  the **only** way an embedder reaches the plugin: the plugin itself never calls the network and never ships or
  runs a model of its own (§11). Validation is synchronous and total — `id` must be a non-empty string, `embed` a
  function, and `dimensions`, when given, a finite integer `>= 1`; anything else returns
  `{ ok: false, error: 'rejected_invalid: …' }` and **leaves the current registration untouched**. Success returns
  `{ ok: true, id }` (`id: null` after a clear).
- **`capabilities()`** is the feature probe: `{ protocolVersion, lexical: true, embedder, embedderId }`. `embedder`
  is `false` and `embedderId` `null` until something is registered; decide "can I use semantic scoring" from this
  (`typeof memory.setEmbedder === 'function'` first, for a `'1.2'` service), never from a guess or from the config
  alone — the config may ask for hybrid ranking while no embedder exists.
- **`lastRecall()`** describes the **last** `recall()` call, or `null` when none has happened: the requested
  `mode`, whether the embedder actually took part (`used`), the fallback reason
  (`'no-embedder' | 'embed-error' | 'timeout' | null`), how many candidates were considered and how many vectors
  were available. It is how a caller learns "you asked for semantic and got lexical, because …" without reading
  internals, and it is what keeps §0 rule 5 ("never pretend") checkable from outside.

## 4. Data model

### 4.1 `MemoryRecord`

All keys below are always present unless marked optional. Callers must ignore unknown keys (§1).

| field | type | meaning |
|---|---|---|
| `id` | `string` | unique id, also the storage key |
| `kind` | `MemoryKind` | `user_profile` / `agent_self` / `project_gist` / `episodic` / `semantic` / `procedural` |
| `precision` | `'exact' \| 'gist'` | exact wording vs. gist |
| `origin` | `MemoryOrigin` | `user_explicit` / `user_correction` / `model_proposed` / `observed` |
| `scope` | `{ level: 'profile' \| 'workspace' \| 'session'; key: string }` | default: `user_profile`/`agent_self` → `profile`; everything else → `workspace` with key `'*'`. `session` scope never reaches the resident block |
| `subject` | `string \| null` | normalized topic key (self-portrait writes use `self.<facet>.<key>`; the key falls back to `general`) |
| `field` / `value` | `string \| null` | optional structured pair; `null` unless the caller supplies them |
| `text` | `string` | one-line body (flattened by `clampText` before injection) |
| `tags` | `string[]` | `[]` by default; the tag `summary` keeps a record out of the resident block |
| `source` | `MemorySource \| null` | `{ sessionId, seqStart, seqEnd }` of the rule capture that produced it |
| `confidence` | `number` | 0…1 |
| `importance` | `number` | 0…1; main sort key |
| `pinned` | `boolean` | pinned records sort first |
| `status` | `MemoryStatus` | §4.3 |
| `invalidAt` | `number \| null` | when it became `invalid`; reset to `null` on restore |
| `branch` *(optional)* | `string \| null` | `null`/absent = applies to every branch. **Feeds the fingerprint** |
| `supersedes` | `string[]` | ids this record replaces |
| `facet` *(optional)* | `'persona' \| 'work'` | self-portrait facet; absent is read as `'work'` |
| `supersededBy` *(optional)* | `string` | id that replaced this record |
| `refs` *(optional)* | `MemoryRef[]` | verifiable source references. **Never feeds the fingerprint** |
| `observedAt` | `number` | when the plugin observed it |
| `eventTime` | `number \| null` | event time, when known |
| `lastUsedAt` | `number \| null` | last injection/use |
| `useCount` | `number` | injection/use count |
| `reinforcement` | `{ sessions: string[]; count: number }` | cross-session repeat count |
| `hash` | `string` | dedup fingerprint (see §4.4) |

Deterministic order (used as the tie-break everywhere): `pinned` → `importance` → `confidence` → `id`.

### 4.2 `MemoryRef`

```ts
interface MemoryRef {
  sessionId: string
  from?: number          // inclusive start event sequence
  to?: number            // inclusive end; omitted for a single point
  via?: 'live' | 'sleep' | 'tool' | 'command' | 'solidify' | 'import'
}
```

At most `refsMax` (default 5) references per record; duplicates (same `sessionId + from + to`) are collapsed.
**The order is the writer's**: `withRef` puts a newly added reference first, and the read paths render the array as
given — nothing sorts it, so "newest first" holds only because `withRef` made it so. `via` names the write path:
`live` = turn-end rule capture, `tool` = `memory_write`, `command` = user command, `solidify` = compaction summary,
`sleep` = `/sleep` backfill, `import` = import path. Explicit `input.refs` win over `refVia`; with
`refsEnabled: false` no reference is attached at all.

**String syntax (as rendered by `refsToString`, and as it appears in `write()`'s `refs` field):**

| form | example | when |
|---|---|---|
| range | `session-84a547da-5727-4ffc-adf0-26d02e749e13#120-180` | `from` and `to` are both given **and differ** |
| single point | `session-…-…#93` | only `from` (or `from === to`) |
| end only | `session-…-…#180` | only `to` |
| no sequence | `session-…-…` | neither is known |
| several | `session-A#120-180;session-B#93` | the reference list is joined with **`;`** |

The separator is a bare `;` (the display helper `formatRefs` uses `'; '` with a space — the machine-readable string
does not). The rendering is per-reference and does **not** deduplicate, sort or truncate; dedup, the `refsMax` cap and
field validation happen in the write path. An entry that fails validation is dropped, so a render can be a shorter
string than the array — or the empty string when nothing survives. `formatRefs` does **not** shorten session ids
unless you pass `{ short: true }`.

### 4.3 `status`

| value | meaning |
|---|---|
| `active` | the only status that participates in injection and recall |
| `pending` | queued by the write gate (`writePolicy: 'ask'`); **waiting for the user**. Not injected, not recalled, not listed by the tools **unless you explicitly ask** (`list({ status: 'pending' })`, `recall({ status: 'pending' })` — audit queries, §3.1/§3.3). **`/memory approve` is the only thing that can make it `active`** — `/memory confirm` does **not** (it upgrades `origin` to `user_explicit` and raises `confidence`, and it never touches `status`; on a `pending` row it would just rewrite the provisional row's origin) |
| `invalid` | conflict loser / rejected pending write. Not recalled by default, not even with `includeArchived`; only an explicit `status: 'invalid'` (or `'all'`) query returns it; recoverable with `/memory restore` |
| `archived` | not injected, but still searchable with `includeArchived: true` (decay archiving and consolidation merges land here) |

### 4.4 Three payload-level rules

These three are the reason this document exists; each one has a dedicated assertion in
`tests/protocol.test.ts`.

1. **`pending` never enters an injection path.** Not the resident block (`section` + `context` channels), not
   turn-level recall, and not `recall()` either — unless the caller explicitly passes
   `status: 'pending' | 'invalid' | 'all'` (§3.3), which is an audit query no injection path ever issues (`list()`
   joined that group in v1.1). `list()`, `recall({ status: … })` and the pending view in `memory_explain` are
   diagnostic and do see it. Implemented by filtering on `status === 'active'` in every read path — no exception is
   allowed for "the model's own proposal".
2. **`refs` never feeds the fingerprint.** Two writes with the same kind/scope/subject/text and different
   references are **one** record (`status: 'merged'` on the second call); the references of the two writes are
   merged into it. Otherwise one memory would look like two and dedup/idempotency would break.
3. **`branch` feeds the fingerprint**, but only when the record actually carries a non-empty branch tag
   (`...(branch ? [branch] : [])`). So "a convention that holds everywhere" and "a temporary convention on
   `feature/x`" are two records, while records without a tag keep the fingerprints they had before the feature
   existed. Making `branch` unconditional would rewrite every fingerprint in the store and break dedup,
   `/sleep` idempotency and idempotent `write` calls at once.

The fingerprint itself is a FNV-1a hash of
`kind | scope.level | scope.key | subject | normalizedText [| branch]`. It is **not** a documented stable
format: compare fingerprints for equality only, never parse one, and never persist one as an id.

## 5. Configuration surface

Two doors, and the difference matters: only keys declared `volatile()` in the config schema are projected into
the DSH settings page and can be changed there (hot-applied); everything else is reached only through the
profile's `cordis.patch.yml` (or the plugin's config row) and needs a reload.

**Volatile (`volatile()`, 30 keys, settings page):**

```text
domainName, maxInjectedTokens, maxItemTokens, selfPortraitMaxTokens, selfPortraitEnabled,
selfPersonaMaxTokens, selfPortraitMergeThreshold, selfReflectEnabled, selfReflectEveryTurns,
selfReflectMinTurn, selfReflectMaxPerSession, selfIntroEnabled, selfIntroMinTurn, selfIntroMaxAsks,
sleepEnabled, sleepSessions, sleepMaxBackfill, refsEnabled, refsMax, branchAware, recallMode,
recallTopK, captureMode, captureMaxPerTurn, consolidateEnabled, consolidateIntervalMinutes,
writePolicy, pendingMax, language, auditMax
```

**Patch-only** — everything else in `DEFAULTS` (`sleepMaxCharsPerSession`, `sleepMaxCharsTotal`,
`sleepAssistantContext`, `sleepMaxGists`, `reportPath`, `seed`, `piiPolicy`, `captureMinConfidence`,
`capturePerHour`, `captureTimeoutMs`, `echoThreshold`, `gistBudgetRatio`, `charsPerToken`, `sectionOrder`,
`contextOrder`, `trustToolWrites`, `autoRecall`, `recallMin*`, `recallCooldownTurns`, `recallBudgetMs`,
`mergeSimilarity`, `archiveAfterDays`, `archiveBelowImportance`, `summarizeAbove`,
`solidificationMaxPerCompaction`, `selfPortraitMaxItems`, `selfPortraitMaxSelfObserved`,
`selfPortraitMinConfidence`, `selfPortraitModelMinConfidence`, `selfPortraitPromoteSessions`,
`consolidateMaxRecords`, `repeatMentionBoost`, `gistMinMarkers`, …), plus the keys that are not in the schema at
all: `exportDir`, `simulateCaptureError`, `simulateAuditError`, `revision`.

Runtime detail that leaks into the service surface: volatile values arrive from the host as accessor objects
(`{ get(): T }`) and the plugin unwraps them before use. A service caller never sees this — it just means
"changing a volatile key in the settings page changes behaviour without a reload".

Defaults are the `DEFAULTS` table in `src/lib.ts`; `writePolicy: 'auto'`, `recallMode: 'inject'`,
`language: 'zh'`, `branchAware: true` and `seed: false` are the shipped ones.

## 6. Minimal working example

The service type is not exported, so declare the slice you use:

```ts
/** The part of protocol v1 this caller needs; see docs/protocol-v1.md §3–§4. */
interface MemoryService {
  recall(options: { query?: string; kind?: string; limit?: number }):
    Array<{ record: { id: string; text: string; status: string; importance: number }; match: number; score: number }>
  write(input: { kind: string; text: string; subject?: string; importance?: number }):
    Promise<{ ok: boolean; status?: 'created' | 'merged'; id?: string; pending?: boolean; error?: string }>
  stats(): { records: number; version: number; opened: boolean }
}

export function injectProjectConventions(ctx: { get(name: string): unknown }, cwd: string | null): string {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) return ''                       // optional service: degrade silently
  const hits = memory.recall({ query: 'build tooling', kind: 'semantic', limit: 3 })
  if (hits.length === 0) return ''
  return ['## Project conventions', ...hits.map((hit) => `- ${hit.record.text}`)].join('\n')
}

export async function remember(ctx: { get(name: string): unknown }, text: string): Promise<boolean> {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) return false
  const result = await memory.write({ kind: 'semantic', text, subject: 'build.tool' })
  // ok:true with pending:true means "proposed, waiting for the user" — not "remembered".
  // ok:true alone is not durability either: read result.persisted (v1.1, §3.4) or memory.stats().opened.
  return result.ok === true && result.pending !== true
}

/** v1.3: the same call has two possible shapes — await unconditionally, it is harmless either way (§3.3). */
export async function rankSemantically(ctx: { get(name: string): unknown }, query: string): Promise<string[]> {
  const memory = ctx.get('memory') as {
    recall(options: { query: string; mode?: 'lexical' | 'semantic' | 'hybrid' }):
      Array<{ record: { text: string } }> | Promise<Array<{ record: { text: string } }>>
  } | undefined
  if (!memory) return []
  const hits = await memory.recall({ query, mode: 'semantic' })   // array when nothing embeds, Promise once it does
  return hits.map((hit) => hit.record.text)
}
```

Call `ctx.get('memory')` inside a step / effect (where services are live) and re-acquire after a reload.

## 7. Compatibility matrix

| requirement | status | notes |
|---|---|---|
| Node.js | `>= 22` (package `engines`) | 22.18+ runs the `.ts` sources directly via native type stripping; earlier 22.x needs `--experimental-strip-types`. The shipped `lib/*.js` runs on any of them |
| DSH host | the empirically verified seam only | `inject = ['agents', 'systemPrompt', 'storageDomain', 'tools', 'commands']`; `commands`/`agents` absent degrades registration, it does not throw |
| `ctx.storageDomain` | **strongly recommended** | without it the plugin loads and the service answers, but `stats().opened === false` and nothing is persisted (§8 gap 3) |
| `ctx.provide` seam | optional | absent ⇒ `ctx.get('memory')` is always `undefined` (§2) |
| `ctx.get('sessionQuery')` | optional | only `/sleep` and reference verification need it; their paths degrade with an explanation instead of throwing |
| client half (`dsh.client` / `lib/client.js`) | optional | settings form + previews only; the host half and the whole service surface work without it |
| `@deepseek-ai/schemastery` | optional peer | when unavailable the `Config` schema is dropped (or built without `volatile`); the service surface is unchanged |
| runtime dependencies | **none** | `dependencies` is empty; the published package ships `lib/`, not `src/` |
| external embedder (`setEmbedder`) | **optional** | nothing is injected by default: with no embedder registered every call stays byte for byte 0.5.19 and the recall path makes **zero** embedding calls. The plugin never calls the network and never ships a model; whether memory text is sent to an external service, where, and whether it is logged is the host's / user's decision, not the plugin's (§3.6, §11) |
| protocol version field | present: `'1.3'` | §1, §9, §10, §11; test it with a `'1.x'` predicate (`/^1\./u`), never string equality. A `'1.2'` service simply lacks the v1.3 keys (embedder injection, `capabilities()`, `lastRecall()`, `stats().embedder`, `recall`'s `mode`); a `'1.1'` one lacks the v1.2 keys (array `branch`, `stats().writes`, `write`'s `refs`) as well, and a `'1.0'` one lacks the v1.1 keys too |

## 8. Known gaps (awaiting a ruling)

Read off the implementation on 2026-10-03; none of these is asserted as "correct" by `tests/protocol.test.ts`,
and none is worked around in `src/` here.

**Fixed while integrating (3)**:
- ~~1. No `protocolVersion` on the service~~ → **added** `protocolVersion` (additive; §1 unchanged); it reads
  `'1.1'` since the v1.1 additions (§9).
- ~~4. `write` does not validate its arguments~~ → **the service now validates minimally**: `kind` must be one of
  the six enum values and `text` a non-empty string, otherwise it returns
  `{ ok: false, error: 'rejected_invalid: …' }` and writes nothing. The tool had a JSON Schema; the service did
  not, so a third party could write a record with `kind: undefined`.
- ~~7. The protocol documents are not in the published package~~ → `package.json` `files` now ships the **whole
  `docs/`** directory (in v1.0 it listed only the two protocol documents; §9).

**Kept as declared behaviour (not defects, but callers must know)**:

2. **`list()` and `recall()` are an unfiltered raw view by default.** Both read `state.records.values()` directly,
   while every injection path goes through `branchVisible(...)`. With `branchAware: true` a third party can
   therefore see records tagged for another branch through `ctx.memory` even though those records are correctly
   withheld from the prompt. **Decision: keep the default raw** (the service is the admin/audit view; filtering by
   default would stop a third party from auditing the whole store). v1.1 adds the opt-in instead of changing the
   default: no argument is still the raw view, while `list({ status })` / `recall({ status })` filter by §4.3
   status, `list({ limit })` caps the array, and `list({ branch: 'current' })` / `recall({ branch: 'current' })`
   use **the injection's own** `branchVisible` rule. For any view other than `'current'`, filter with
   `branchOf(record)` yourself.
3. **`write` reports `ok: true` when nothing was persisted.** If the domain is not open, `persist()` returns
   `false` **before** inserting into the in-memory store: the result is still
   `{ ok: true, status: 'created', id, record, persisted: false }` while `list()` is empty and `stats().opened` is
   `false`. If the `put` itself throws, the record stays in memory but not on disk, again with `ok: true`. `ok`
   therefore means "applied in memory", not "durable". **Decision: keep the `ok` meaning — now stated in the
   contract and no longer ambiguous**: v1.1's `persisted` (§3.4) says whether this write reached the domain, while
   `stats().opened` and `version` remain the way to see the domain's own state.
5. **Records returned by `list()` / `recall()` are the live objects.** They are the same references the plugin
   mutates (`useCount`, `lastUsedAt`, merge results). Reading is safe; writing into them is undefined behaviour
   and does not persist on its own.
6. **`list()` is not sorted and — with no argument — not filtered.** Insertion order only; a no-argument call
   includes `pending`/`invalid`/`archived` rows. v1.1 adds the opt-in `status` / `branch` / `limit` filters (§3.1)
   without changing that default. Anyone who wants the injected view must reproduce §4.3 + §4.4 themselves, or ask
   for `branch: 'current'`, which is the injection's own branch rule.
8. **`version` bumps even when the write did not land** (read off `src/index.ts`: `persist()` increments
   `state.collectionVersion` **before** awaiting `put`, and its `catch` does not undo it, while `delete` increments
   only on success and rolls the row back when `delete` throws). So `version` means "the collection was **touched**",
   not "the collection changed on disk". **Decision: keep the implementation as it is and document it** (§3.2) — the
   counters that do answer "did it reach the domain" are `stats().opened` and `stats().writes.persisted`; this entry
   exists so nobody reads `version` as a durability proof.

## 9. What v1.1 adds

v1.1 is a **pure addition** inside v1: the service's `protocolVersion` went `'1.0' → '1.1'`, and every call that
worked in 0.5.17 keeps its exact behaviour (a no-argument `list()` is byte for byte identical). Three surface
additions and one packaging change:

| # | addition | where |
|---|---|---|
| 1 | `list(options?)` — optional `status` / `branch` / `limit`; no argument = the v1.0 raw view | §3.1 |
| 2 | `recall(options)` — optional `status` / `branch`. `status: 'pending'` is the explicit audit door; injection passes no `status`, so its behaviour is unchanged | §3.3 |
| 3 | `write(input)` — every **success** shape now carries `persisted: boolean`. `ok: true` still means "applied in memory"; `persisted` is the one that means "reached the storage domain". The rejection shape has no such key | §3.4 |
| 4 | packaging — `package.json` `files` now ships the **whole `docs/`** directory (refs / self-portrait / sleep / write-policy / audit / branch / i18n / trace / semantic / dsh-mechanisms and the two protocol documents) instead of only the two protocol documents | §8 item 7 |

**Check the version with a `'1.x'` predicate, never string equality** — a later `1.2` must not lock you out (v1.2 has
landed, and this predicate is what keeps you working against it), and a service that still says `'1.0'` simply lacks
the three optional keys:

```ts
/** The slice this caller uses; the service type is not exported (see §6). */
interface MemoryService {
  protocolVersion?: string
  list(options?: { status?: string; branch?: string | null; limit?: number }): Array<{ id: string }>
  recall(options?: { query?: string; status?: string; branch?: string | null }): Array<{ record: { id: string } }>
  write(input: { kind: string; text: string }): Promise<
    { ok: true; pending?: boolean; persisted?: boolean } | { ok: false; error: string }
  >
}

export function memoryService(ctx: { get(name: string): unknown }): MemoryService | null {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) return null                                  // optional service: degrade silently (§2)
  const version = memory.protocolVersion
  // '1.0', '1.1' and every later '1.x' pass; an unknown major is refused, not guessed.
  if (version !== undefined && !/^1\./u.test(version)) return null
  return memory
}

export async function remember(ctx: { get(name: string): unknown }, text: string): Promise<boolean> {
  const memory = memoryService(ctx)
  if (!memory) return false
  const v11 = memory.protocolVersion !== undefined && memory.protocolVersion !== '1.0'
  if (v11) {
    // v1.1-only options: usable once the version check passed (ignore unknown keys elsewhere).
    const active = memory.list({ status: 'active', limit: 20 })
    if (active.length === 0) return false
  }
  const result = await memory.write({ kind: 'semantic', text })
  // ok = "in memory"; persisted (v1.1) = "on disk". A pre-v1.1 service simply omits persisted.
  return result.ok === true && result.persisted !== false
}
```

Everything else in this document — §2's optionality, §4's data model and the three payload rules, §5's
configuration surface — is v1.0 material and unchanged by v1.1.

## 10. What v1.2 adds

v1.2 is a **pure addition** inside v1: the service's `protocolVersion` went `'1.1' → '1.2'`, and every call that
worked in 0.5.18 keeps its exact behaviour (a no-argument `list()` is byte for byte identical). Three surface
additions:

| # | addition | where |
|---|---|---|
| 1 | `list(options?)` / `recall(options)` — `branch` now also accepts a **readonly array** of branch names (`'current' \| string \| readonly string[] \| null`). A string is exactly v1.1; an array keeps the records whose `branchOf(record)` is **in** it (a record with no tag is **not** a hit); an **empty array ⇒ an empty result** — that is *not* "no filter"; `null` / unset = no filter (unchanged); a `'current'` element is resolved against the current branch | §3.1, §3.3 |
| 2 | `stats()` — new `writes: { persisted: number; unpersisted: number }`: the per-process running count of write-persistence outcomes. `persisted` = `persist()` returned true; `unpersisted` = `ok: true` but nothing reached disk. Counters only grow, reset on restart, and rejections (`ok: false`) are not counted | §3.2 |
| 3 | `write(input)` — every **success** shape now carries `refs: string[]`, the record's machine-readable reference strings (`[]` when it has none), including on the `pending` path. `ok: true` still means "applied in memory"; `persisted` still means "reached the storage domain". The rejection shape has neither key | §3.4 |

**Check the version with a `'1.x'` predicate, never string equality** (§1) — a later `1.3` must not lock you out,
and a service that still says `'1.1'` simply lacks the v1.2 keys:

```ts
/** The slice this caller uses; the service type is not exported (see §6). */
interface MemoryService {
  protocolVersion?: string
  list(options?: { branch?: 'current' | string | readonly string[] | null; limit?: number }):
    Array<{ id: string; text: string }>
  write(input: { kind: string; text: string }): Promise<
    { ok: true; pending?: boolean; persisted?: boolean; refs?: string[] } | { ok: false; error: string }
  >
  stats(): { records: number; version: number; opened: boolean; writes?: { persisted: number; unpersisted: number } }
}

export function memoryService(ctx: { get(name: string): unknown }): MemoryService | null {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) return null                                  // optional service: degrade silently (§2)
  const version = memory.protocolVersion
  // '1.x' predicate, never `version === '1.2'`: a later minor must not lock this caller out.
  if (version !== undefined && !/^1\./u.test(version)) return null
  return memory
}

/** An empty branch list deliberately returns nothing — it is *not* "all branches" (§3.1, §10). */
export function listOnBranches(ctx: { get(name: string): unknown }, branches: readonly string[]): number {
  const memory = memoryService(ctx)
  return memory ? memory.list({ branch: branches }).length : 0
}

export async function rememberAndProve(ctx: { get(name: string): unknown }, text: string): Promise<boolean> {
  const memory = memoryService(ctx)
  if (!memory) return false
  // v1.2: stats().writes is the only *proof* that a write really reached the disk. `ok: true`
  // still only means "applied in memory" (§3.4), so compare the counter across the call.
  const before = memory.stats().writes?.persisted
  const result = await memory.write({ kind: 'semantic', text })
  if (result.ok !== true) return false                      // rejected_* ⇒ nothing was written
  const after = memory.stats().writes?.persisted
  if (before !== undefined && after !== undefined) return after > before   // v1.2 service
  return result.persisted !== false                         // '1.1' fallback: persisted field
}
```

Everything else in this document — §2's optionality, §4's data model and the three payload rules, §5's
configuration surface, §6's example — is v1.0 / v1.1 material and unchanged by v1.2, and no v1.1 default moved:
`list()` with no argument is still the raw view, and `stats().records` / `version` / `opened` keep their meaning.

## 11. What v1.3 adds

v1.3 is a **pure addition** inside v1: the service's `protocolVersion` went `'1.2' → '1.3'`, and every call that
worked in 0.5.19 keeps its exact behaviour — with no embedder registered a no-argument `list()` is byte for byte
identical, and `recall({ mode: 'lexical' })`, the default, makes **zero** embedding calls. **Five** surface additions:

| # | addition | where |
|---|---|---|
| 1 | `setEmbedder(embedder \| null)` — register / replace / clear the embedder the **host injects**. A bad object is rejected (`rejected_invalid: …`) without changing the current registration | §3.6 |
| 2 | `capabilities()` — `{ protocolVersion, lexical: true, embedder: boolean, embedderId: string \| null }`; the only correct way to decide whether semantic scoring is available | §3.6 |
| 3 | `lastRecall()` — the **last** `recall()`: `{ mode, used, fallback, candidates, vectors }`, or `null` when no call has happened | §3.6 |
| 4 | `stats().embedder` — `{ id, dimensions, calls, errors, hits, misses, timeouts }`; all zero / `null` while no embedder is registered | §3.2 |
| 5 | `recall({ mode })` — `'lexical'` (the default, unchanged) / `'semantic'` / `'hybrid'` | §3.3, §3.6 |

(The count is five because `capabilities()` and `lastRecall()` are two independent methods on the surface — the text
here said "four" while listing `lastRecall()` as part of item 4; `tests/protocol.test.ts` pins the surface, not the
count.)

The embedder contract itself — the shape the host implements and injects:

```ts
/** The host-injected embedder (v1.3). The plugin only calls it; it does not care what is behind it. */
export interface Embedder {
  /** Non-empty identifier, for stats and diagnostics (e.g. 'local-minilm' / 'openai:text-embedding-3-small'). */
  id: string
  /** Vector dimension (optional): when given it is used for a fast check instead of a full compare. */
  dimensions?: number
  /** Batch embed: N texts in, N vectors out (same length, same order). */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}
```

Four configuration keys (`MemoryConfig`, defaults from `DEFAULTS` in `src/lib.ts`; they reach the plugin through
the same config doors as every other key — patch row or plugin config row — and do not change the meaning of any
existing key):

| key | type | default | meaning |
|---|---|---|---|
| `embedderRecallMode` | `'off' \| 'recall'` | `'off'` | whether per-turn recall may rank with hybrid scoring (requires a registered embedder) |
| `embedderWeight` | number | `0.5` | semantic weight in hybrid mode (0…1; an invalid value falls back to the default) |
| `embedderTimeoutMs` | number | `200` | timeout for one embedding call |
| `embedderCacheMax` | number | `2000` | vector cache capacity (LRU; `0` = no cache) |

The five rules this addition is not allowed to break (the frozen contract's §0, restated here without weakening):

1. **The plugin never calls a network or a model itself.** It only calls the injected `embed` function; whether
   memory text is sent to an external service is the **host's / user's** decision, and this document says so to the
   user.
2. **With no embedder injected, everything is byte for byte 0.5.19** — injection paths, recall ordering and the
   stats lines included.
3. **No one gets it by default:** `embedderRecallMode` defaults to `'off'`; hybrid scoring happens only when the
   host explicitly turns it on **and** an embedder is really registered.
4. **Failures never bubble:** an embedder that throws / rejects / times out / returns a wrong shape or mismatched
   dimensions is recorded as an error and **falls back to lexical** — never thrown into the turn, never corrupting
   a record. No embedding failure may ever lose a memory or fail a turn.
5. **Never pretend:** `recall({ mode: 'semantic' })` without an embedder returns a lexical result and says so in
   `lastRecall()` (`fallback: 'no-embedder'`) instead of letting the caller believe semantic scoring happened.

> **Privacy.** The plugin **itself never goes online and never ships or runs a model of its own**; it only calls
> the `embed` function the host injected. Whether memory text is sent to an external service, **where** it is sent,
> and whether any of it is logged is **decided by the host and the user** — the plugin does not make that decision
> and cannot make it on their behalf.

Everything else in this document — §2's optionality, §4's data model and the three payload rules, §5's
configuration surface, §6's example — is v1.0 / v1.1 / v1.2 material and unchanged by v1.3, and no earlier default
moved: `list()` with no argument is still the raw view, and `stats().records` / `version` / `opened` / `writes`
keep their meaning.

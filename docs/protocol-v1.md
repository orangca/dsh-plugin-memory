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

The revision you are reading is **v1.2**. v1.1 was a **pure addition** on top of v1.0: `list()` gained optional
`status` / `branch` / `limit`, `recall()` two optional filters, `write()` the `persisted` field, and the service's
`protocolVersion` moved from `'1.0'` to `'1.1'` (§9). v1.2 is again a **pure addition**, this time on top of v1.1:
`list()` / `recall()` accept a **branch array**, `stats()` gained the `writes` counters, every `write()` **success**
shape gained `refs`, and the service's `protocolVersion` moved from `'1.1'` to `'1.2'` (§10). Nothing a `'1.0'` or
`'1.1'` consumer relied on changed — every no-argument call is byte for byte what 0.5.18 returned (§3.1, §3.3).

Today the service object **does** carry `protocolVersion` (`'1.2'`); read it first and degrade readably on an
unknown version rather than assuming. Decide compatibility with a `'1.x'` predicate (`/^1\./u`), **not** string
equality: v1.1 already asked for this and v1.2 keeps it — a consumer that compared `protocolVersion === '1.1'`
would lock itself out of `'1.2'`, so compare on the prefix / major–minor only. §9 and §10 have minimal snippets
that do exactly that.

## 2. Locating the service, and what to do when it is absent

The service is registered exactly once, inside `apply()`:

```ts
ctx.provide('memory', { protocolVersion, list, stats, recall, write, consolidate })
```

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

## 3. Methods

The service object, as signatures (the bodies are internal; §3.1–§3.5 fix the semantics):

```ts
interface MemoryService {
  protocolVersion: string            // '1.2'
  list(options?: ListOptions): MemoryRecord[]
  stats(): {
    records: number
    version: number
    opened: boolean
    /** 新增：本进程内累计的写入落盘结果（v1.2）。 */
    writes: { persisted: number; unpersisted: number }
  }
  recall(options: RecallOptions): Array<{ record: MemoryRecord; match: number; score: number }>
  write(input: WriteMemoryInput): Promise<WriteMemoryResult>
  consolidate(reason?: string): Promise<void>
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
- **Returns:** `{ records: number; version: number; opened: boolean; writes: { persisted: number; unpersisted: number } }`
  — the three v1.0 keys plus the v1.2 `writes` counters.

| field | meaning |
|---|---|
| `records` | records held in memory (all statuses, same set as `list()`) |
| `version` | collection version, incremented on every successful put/delete; use it to detect change. **Not** a storage schema version |
| `opened` | whether `ctx.storageDomain.open()` succeeded. `false` means writes are not reaching disk (see §8 gap 3) |
| `writes` *(new in v1.2)* | this process's running count of write-persistence outcomes. `persisted`: how often `persist()` returned true (the write really reached disk); `unpersisted`: how often the write was `ok: true` but did not reach disk (domain not open, or `put` threw). The counters only grow, they are per-process and reset on restart (the same nature as `version`). Rejections (`ok: false`) are **not** counted — they were never a write. They sit alongside the internal `state.writes` counters and do not reuse them (those have a different meaning). |

- **Errors:** none.

### 3.3 `recall(options)`

- **Arguments:** `RecallOptions`; v1.1 adds two optional keys, frozen verbatim as:

```ts
interface RecallOptions {
  // …既有字段不变
  /** 状态过滤；缺省 = 今天的行为（active，`includeArchived: true` 时再含 archived）。 */
  status?: 'active' | 'pending' | 'invalid' | 'archived' | 'all'
  /** 分支过滤，语义与 `list` 的 `branch` 完全一致（v1.2 起同样接受数组；**空数组 ⇒ 空结果**）。缺省 = 不过滤（今天的行为）。 */
  branch?: 'current' | string | readonly string[] | null
}
```

| key | type | default | meaning |
|---|---|---|---|
| `query` | `string` | `''` | relevance query; empty/absent = no relevance filter |
| `kind` | `MemoryKind` | — | filter by kind |
| `scopeLevel` | `'profile' \| 'workspace' \| 'session'` | — | filter by scope level |
| `tag` | `string` | — | filter by exact tag |
| `limit` | `number` | `8` | clamped to 1…50 |
| `mode` | `'query' \| 'memory'` | `'query'` | short query vs. whole-turn message |
| `minLexical` | `number` | `0.34` | `mode: 'query'` threshold |
| `minMatch` | `number` | `0.4` | `mode: 'memory'` threshold |
| `minHits` | `number` | `2` | `mode: 'memory'` minimum informative token hits |
| `includeArchived` | `boolean` | `false` | also consider `archived` records |
| `status` | `'active' \| 'pending' \| 'invalid' \| 'archived' \| 'all'` | absent = today's pool | which §4.3 statuses may be returned. Absent = today's behaviour (`active`, plus `archived` when `includeArchived === true`); `'all'` = active + pending + invalid + archived, order unchanged; `'pending'` is allowed — an explicit management/audit query (§9) |
| `branch` | `'current' \| string \| readonly string[] \| null` | unset = no filter | exactly `list`'s `branch` (§3.1): `'current'` = the injection's own `branchVisible` rule for the current cwd; any other string keeps only records whose `branchOf(record)` equals it; **v1.2:** an array keeps only the records whose `branchOf(record)` is in the array (no tag = not a hit) and an **empty array returns an empty result**; `null` / unset = no filter |

- **Returns:** `Array<{ record: MemoryRecord; match: number; score: number }>`, sorted by `score` descending and
  then by the deterministic record order (§4.1), truncated to `limit`.
  - `match` is the relevance value (0…1) for the chosen mode; `score` is the ordering score (lexical + importance
    + recency).
  - Candidate pool: with `status` absent it is exactly today's pool — `status === 'active'` always, plus `archived`
    when `includeArchived === true`. **Without an explicit `status`, `pending` and `invalid` are never returned,
    whatever the other options say.** An explicit `status: 'pending' | 'invalid' | 'all'` is the only door that can
    return them — an audit query, never an injection path (injection passes no `status`).
- **Errors:** none for any option shape (absent options are tolerated at runtime).

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

At most `refsMax` (default 5) references per record, newest first; duplicates (same `sessionId + from + to`) are
collapsed. `via` names the write path: `live` = turn-end rule capture, `tool` = `memory_write`, `command` = user
command, `solidify` = compaction summary, `sleep` = `/sleep` backfill, `import` = import path. Explicit
`input.refs` win over `refVia`; with `refsEnabled: false` no reference is attached at all.

### 4.3 `status`

| value | meaning |
|---|---|
| `active` | the only status that participates in injection and recall |
| `pending` | queued by the write gate (`writePolicy: 'ask'`); **waiting for the user**. Not injected, not recalled, not listed by the tools **unless you explicitly ask** (`list({ status: 'pending' })`, `recall({ status: 'pending' })` — audit queries, §3.1/§3.3); only a user command (`/memory approve`, `/memory confirm`) can make it `active` |
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
| protocol version field | present: `'1.2'` | §1, §9, §10; test it with a `'1.x'` predicate (`/^1\./u`), never string equality. A `'1.1'` service simply lacks the v1.2 keys (array `branch`, `stats().writes`, `write`'s `refs`); a `'1.0'` one lacks the v1.1 keys as well |

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

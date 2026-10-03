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
- new **optional** input keys may be added to `write` / `recall`.

Anything that breaks the above — renaming or removing a method, changing what a field means, making an
optional field required, changing which inputs feed the dedup fingerprint — is a **breaking change**: it must
bump the protocol version (`v2`), land in its own release, and be described in `CHANGELOG.md`. Plugin versions
still advance by one patch (`0.5.16 → 0.5.17`); the protocol version and the package version are independent.

A method that is going away keeps working for the whole of v1 and is marked deprecated in this document first.

Today the service object **does** carry `protocolVersion` (`'1.0'`); read it first and degrade readably on an
unknown version rather than assuming.

## 2. Locating the service, and what to do when it is absent

The service is registered exactly once, inside `apply()`:

```ts
ctx.provide('memory', { list, stats, recall, write, consolidate })
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

The registered object, verbatim from `src/index.ts`:

```ts
ctx.provide('memory', {
  list:        (): MemoryRecord[] => [...state.records.values()],
  stats:       (): { records: number; version: number; opened: boolean } =>
                 ({ records: state.records.size, version: state.collectionVersion, opened: state.opened }),
  recall:      (options: RecallOptions) => recallRecords(state.records.values(), options),
  write:       (input: WriteMemoryInput) => writeMemory(input),
  consolidate: (reason?: string) => consolidate(reason ?? 'manual'),
})
```

### 3.1 `list()`

- **Arguments:** none.
- **Returns:** a fresh array of **every** record in the in-memory store, in **insertion order** (load order,
  then write order). No sorting, no `status` filter, no branch filter. This is the only method that can see
  `pending` / `invalid` / `archived` rows.
- **Errors:** none (array allocation only).

### 3.2 `stats()`

- **Arguments:** none.
- **Returns:** `{ records: number; version: number; opened: boolean }` — exactly these three keys.

| field | meaning |
|---|---|
| `records` | records held in memory (all statuses, same set as `list()`) |
| `version` | collection version, incremented on every successful put/delete; use it to detect change. **Not** a storage schema version |
| `opened` | whether `ctx.storageDomain.open()` succeeded. `false` means writes are not reaching disk (see §8 gap 3) |

- **Errors:** none.

### 3.3 `recall(options)`

- **Arguments:** `RecallOptions` (optional keys):

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

- **Returns:** `Array<{ record: MemoryRecord; match: number; score: number }>`, sorted by `score` descending and
  then by the deterministic record order (§4.1), truncated to `limit`.
  - `match` is the relevance value (0…1) for the chosen mode; `score` is the ordering score (lexical + importance
    + recency).
  - Candidate pool: `status === 'active'` always, plus `archived` when `includeArchived === true`.
    **`pending` and `invalid` are never returned, under any option combination.**
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

- **Returns:** a `WriteMemoryResult` object; success and rejection are both structured results:

| shape | when |
|---|---|
| `{ ok: true, status: 'created', id, record }` | a new record was applied |
| `{ ok: true, status: 'merged', id, record, boosted? }` | an `active` record with the same fingerprint already existed; it was updated in place |
| `{ ok: true, pending: true, id, text }` | `writePolicy: 'ask'` queued a `model_proposed` write; **no `status` key**, nothing took effect |
| `{ ok: false, error: '<code>: <message>' }` | rejected; `portrait` is added when self-portrait convergence produced a decision |

  `record` is the full record as stored (all required fields of §4.1). `portrait` is an internal convergence
  decision whose shape is **not** frozen in v1 — ignore it unless you are diagnosing self-portrait writes.
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
  store". Check `stats().opened` and whether the row appears in `list()` before telling anyone the memory is
  safe (see §8 gap 3).

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
| `pending` | queued by the write gate (`writePolicy: 'ask'`); **waiting for the user**. Not injected, not recalled, not listed by the tools; only a user command (`/memory approve`, `/memory confirm`) can make it `active` |
| `invalid` | conflict loser / rejected pending write. Never recalled, not even with `includeArchived`; recoverable with `/memory restore` |
| `archived` | not injected, but still searchable with `includeArchived: true` (decay archiving and consolidation merges land here) |

### 4.4 Three payload-level rules

These three are the reason this document exists; each one has a dedicated assertion in
`tests/protocol.test.ts`.

1. **`pending` never enters an injection path.** Not the resident block (`section` + `context` channels), not
   turn-level recall, not `recall()`. `list()` and the pending view in `memory_explain` are diagnostic and do
   see it. Implemented by filtering on `status === 'active'` in every read path — no exception is allowed for
   "the model's own proposal".
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
  // ok:true alone is not durability either: check memory.stats().opened.
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
| protocol version field | absent in v1 | see §8 gap 1; version detection is by method set + shape today |

## 8. Known gaps (awaiting a ruling)

Read off the implementation on 2026-10-03; none of these is asserted as "correct" by `tests/protocol.test.ts`,
and none is worked around in `src/` here.

**Fixed while integrating (3)**:
- ~~1. No `protocolVersion` on the service~~ → **added** `protocolVersion: '1.0'` (additive; §1 unchanged).
- ~~4. `write` does not validate its arguments~~ → **the service now validates minimally**: `kind` must be one of
  the six enum values and `text` a non-empty string, otherwise it returns
  `{ ok: false, error: 'rejected_invalid: …' }` and writes nothing. The tool had a JSON Schema; the service did
  not, so a third party could write a record with `kind: undefined`.
- ~~7. The protocol documents are not in the published package~~ → `package.json` `files` now includes
  `docs/protocol-v1.md` and `docs/protocol-v1.zh.md`.

**Kept as declared behaviour (not defects, but callers must know)**:

2. **`list()` and `recall()` are an unfiltered raw view.** Both read `state.records.values()` directly, while
   every injection path goes through `branchVisible(...)`. With `branchAware: true` a third party can therefore
   see records tagged for another branch through `ctx.memory` even though those records are correctly withheld
   from the prompt. **Decision: keep it raw** (the service is the admin/audit view; filtering would stop a third
   party from auditing the whole store). Filter with `branchOf(record)` yourself if you need the same view.
3. **`write` reports `ok: true` when nothing was persisted.** If the domain is not open, `persist()` returns
   `false` **before** inserting into the in-memory store: the result is still
   `{ ok: true, status: 'created', id, record }` while `list()` is empty and `stats().opened` is `false`. If the
   `put` itself throws, the record stays in memory but not on disk, again with `ok: true`. `ok` therefore means
   "applied in memory", not "durable". **Decision: keep the wording and state it in the contract** — read
   `stats().opened` and `version` when durability matters.
5. **Records returned by `list()` / `recall()` are the live objects.** They are the same references the plugin
   mutates (`useCount`, `lastUsedAt`, merge results). Reading is safe; writing into them is undefined behaviour
   and does not persist on its own.
6. **`list()` is not sorted and not filtered.** Insertion order only; `pending`/`invalid`/`archived` rows are
   included. Anyone who wants the injected view must reproduce §4.3 + §4.4 themselves.

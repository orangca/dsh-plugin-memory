# Changelog

Version numbers advance by one patch (`0.5.0 → 0.5.1`). This file covers the public history; the repository's first
public commit was `0.4.2`.

## 0.5.24 — 2026-10-04

Four tracks at once: the mutation testing that found the last two rounds' blind spots became a standing tool, the
release process that tripped us three times became written rules, and two more mutation rounds went after the areas
nobody had aimed at.

### Added

- **`pnpm mutate`** — mutation testing as a repeatable check (`tools/mutate.ts`, zero dependencies). It breaks the
  implementation in a small plausible way, runs the whole suite in a scratch copy, and reports what survived:
  `killed` means the suite noticed, `survived` means a blind spot. A curated 29-entry catalogue, deterministic
  sampling (`--limit` / `--seed`), `--only <id>` to re-check a single mutation, `--keep` to inspect the copy, and
  exit codes that mean something (0 = everything killed, 1 = survivors, 2 = environment problem). `pnpm mutate:full`
  runs the whole catalogue in ~67 s.
- **`CONTRIBUTING.md` now documents the release checklist** — patch-only version bumps, the six gates, verifying
  `lib/` is in sync with `src/`, **creating the tag locally before pushing anything**, and finishing by checking
  three-way consistency (main's local/remote SHA, the tag's target, the installed profile version).
- **A table of the three push failures we actually hit**, because the first two looked identical and were not:
  a reset can be GitHub's push protection rejecting the commit (surfaced by forcing HTTP/1.1), a 443 timeout is a
  real network outage, and `src refspec does not match any` means the tag was never created locally. It also records
  that this repository pins `http.version=HTTP/1.1`, precisely so a rejection cannot hide behind a transport error.
- **The mutation tool found two real blind spots in its first run**, and both are now closed:
  - `pickMergeGroups` fell back to a hard-coded `0.85` while `DEFAULTS.mergeSimilarity` is `0.7` — changing one to
    the other changed behaviour with nothing objecting. The fallback now uses `DEFAULTS` (internal callers always
    pass a complete config, so nothing user-visible changes) and a test pins it.
  - **No test asserted the `Config` schema's default values at all.** There is now a systemic check that every key
    the schema exposes has a default equal to `DEFAULTS`, which kills a whole class of drift rather than the one
    instance — plus a pin on the schema's key count, so silently dropping a key fails too. Both former escapees are
    in the catalogue and are killed.

### Changed (tests only, apart from the fallback above)

- Third mutation round, pure layer: 40 breaks tried, 16 killed by existing tests, **23 survivors → 23 killed** with
  14 new cases (lib 228 → 243). Targets: which fields feed the search token set (`subject`/`tags` in, `field`/`value`
  out, separators required), the capture-signal matrix (all seven rows, every wording, priority order, quota
  ordering), `deriveOriginFromMessages` refusing to trust structurally broken input, `defaultScopeFor`'s full enum,
  and `makeRecord`'s structural defaults.
- Third mutation round, host: 41 breaks tried, 40 killed — **28 of them by 10 new cases** (host 149 → 159).
  Targets: the consolidation trio's interactions (merge leader aggregation and write-back, the conflict gate that
  must not let the model overturn user-side rows, rule-based summaries, idempotency, the re-entrancy lock, the
  budget fallback), `/memory import`'s whitelist end to end (forged origins downgraded, numbers clamped, invalid
  rows skipped and counted, fingerprint dedupe), and the startup/interval paths.
- One survivor is documented rather than papered over: an unconditional counter increment in the summary step is
  equivalent on any reachable input, because every failure branch that could make it differ is gated on
  `model_proposed` and summaries are `observed`. The reasoning is in the test file.

Suite: **467 → 498**.

## 0.5.23 — 2026-10-04

**Mutation testing, round two** — aimed at the four large functions round one deliberately skipped because their
assertions are expensive: `recallRecords` (thresholds, IDF weighting, ranking, caches), the `/sleep` planning cluster
(`transcriptOf`, `buildSleepPlan`, `formatSleepPlan`), the self-portrait revision chain, and the renderers. Same
method, same rule: no production code changed, only tests.

| Track | Breaks tried | Killed by existing tests | Survived | Now killed by new tests |
|---|---|---|---|---|
| Retrieval + self-portrait (`tests/lib.test.ts`) | 38 | 15 | **23** | 23 (lib 206 → 228) |
| `/sleep` + audit paths, end to end (`tests/host.test.ts`) | 30 | 18 | **12**, 10 worth pinning | 10 (host 139 → 149) |

Suite: **435 → 467**.

### What the second round found

- **`recallRecords`' `mode: 'memory'` had no pure-layer coverage at all.** Its default threshold, its df injection
  and its IDF weighting could each be broken without a single failure — the mode was only exercised through the host
  and protocol suites. It now has direct cases, including one asserting that a *rare* hit beats a common one.
- **Endpoints and totality**, again: the `limit` clamp's low and high ends, the tie-break that keeps ranking
  deterministic, the closed interval on a coverage threshold, `passes` being `>=` rather than `>`, `score_max`
  counting query tokens that did *not* match, and a cache eviction that must evict rather than clear the whole table.
- **Rendering details nobody asserted**: the audit timestamp's month offset and zero padding, the dictionary-order
  fallback when branch and `via` counts tie, the single-line display budget for rejection reasons, the five-row
  archive sample, and the `(no subject)` placeholder for a merge group.
- **`/sleep` end to end**: an in-plan duplicate that must be dropped and counted, the plan-level `agent_self` gate,
  a per-session budget that must still fit a message when it lands exactly on the boundary, both compatible read
  paths for assistant event bodies, the merge leader chosen by `compareRecords`, the truncated-row line appearing
  only when something was actually truncated, and `/memory verify` treating a `to`-only reference as a closed
  interval.
- **`/memory audit --verify` must survive a failing log read** and report the gap; a removed `try/catch` turned an
  honest gap into a command error, which a test now prevents.

### Two survivors documented rather than papered over

- One is **unreachable under the contract**: a workspace-level backfill candidate cannot exist, because the only
  `user_explicit` capture signals resolve to `user_profile`/`agent_self`, both of which land at profile scope. The
  agent first wrote a test for it, watched it fail, and only then proved the branch unreachable — that test was
  deleted rather than kept as decoration.
- One is **equivalent**: a candidate that reaches `writeMemory` has already passed two same-origin fingerprint
  gates, so the simplified counter cannot differ.

### Notes

- One new case pins a **compatibility read path** (assistant event `data` attached directly rather than under
  `message`) that `docs/sleep.md` does not declare. It is reachable code — deleting the fallback silently loses echo
  context — so the test is the proof it exists; whoever removes the fallback must remove the test too.
- The lib suite now takes roughly a second longer because the new cache case exercises a realistic library size.

## 0.5.22 — 2026-10-04

**Test hardening driven by mutation testing.** The adversarial audit's last useful gift was the observation that a
green suite and a correct implementation are different things. So instead of guessing which tests were missing, two
agents did this: break the implementation in a small, plausible way, run the whole suite, and record every break that
**nothing noticed**. Those breaks are the blind spots. Then each surviving break got a test that kills it — verified
both ways in a scratch copy (red against the mutated build, green against the real one). No production code changed.

### Numbers

| Track | Breaks tried | Killed by existing tests | Survived (blind spots) | Now killed by new tests |
|---|---|---|---|---|
| Pure layer (`src/lib.ts`) | 64 | 31 | **30** | 30 (lib suite 176 → 206) |
| Host (`src/index.ts`) | 100 | 50 | **50**, of which 8 were worth pinning | 8 (host suite 131 → 139) |

Suite: **397 → 435**.

### What the blind spots actually were

- **Thresholds that are closed intervals and were only ever tested on the loose side.** Similarity exactly equal to
  the echo threshold, containment exactly equal to `mergeSimilarity`, an age exactly at `archiveAfterDays`, a
  confidence exactly at `selfPortraitMinConfidence`, a text exactly at the clamp length, a candidate count exactly
  at the quota: flipping `>=` to `>` (or `<` to `<=`) changed behaviour and no test objected. Each of those now has
  a case that sits exactly on the boundary.
- **`memoryMatch`'s notion of an "informative" hit had no direct coverage at all** — the default `minHits`, the
  two-character token floor and the "not purely numeric" rule could each be relaxed without a single failure. That
  combination is what keeps version numbers and list indices from dragging unrelated memories into a recall, so it
  is now pinned three ways.
- **Fallback directions.** `minHits ?? 1` becoming `?? 0`, a denominator cap of 4 becoming 3, a token cache keyed by
  an empty fingerprint, an eight-character sentence losing its length floor, an empty record scoring 1 instead of 0,
  a NaN budget no longer failing closed.
- **Host paths that nothing asserted end-to-end**: `/memory list --archived` actually listing archived rows (an
  early return could be deleted unnoticed), the export path excluding `deleted` rows, the audit's verbatim-match
  rule including `system/message`, `/memory verify`'s informative-token floor and its exact coverage threshold,
  the tagged-branch counter counting tagged rows rather than untagged ones, and the reason for a failed persist
  reaching the stats and the command output rather than dying in a swallowed error.
- **Two survivors are documented as unreachable rather than papered over.** One guard is the first of three
  independent layers enforcing the same rule, so removing it alone is unobservable; the other sits behind a
  fallback that the real `/sleep` path cannot reach. Both are written into the test file with the evidence, because
  "we could not kill this" is a finding, not a gap to hide.

### Notes

- The suites now also encode a habit worth keeping: new cases assert exact values at exact boundaries (0.75, 67%,
  eight characters) rather than "at least" shapes, since a loose assertion is what let the mutations live.
- One incident from the session is recorded for honesty: an agent wrote placeholder text into `src/index.ts` while
  probing sandbox permissions and restored it with `git checkout`. The integration check confirmed `src/`, `lib/`,
  `docs/`, `tools/` and `package.json` are untouched against HEAD, and the only modified files are the two test
  suites.

## 0.5.21 — 2026-10-04

Fixes from an **independent adversarial audit**: five agents were told to falsify the plugin rather than confirm it,
each from a different angle (contract-vs-reality, break-it probes, release surface and privacy, a documentation-only
consumer, and mutation testing of the suite itself). They found real holes. This release closes them.

### Security

- **`memory_explain({ apply: true })` bypassed the write-policy gate and forged provenance.** With `writePolicy:
  'off'` a `memory_write` was correctly refused, yet applying the same text through `memory_explain` wrote it with
  `origin: 'user_explicit'` — and the text reached the context. The cause was letting the model-controlled capture
  signal choose the origin. Both tool paths now derive the origin the same way (`deriveOriginFromMessages`, with the
  explicit `trustToolWrites` override), so refusal, PII masking, echo rejection, the pending queue and `persisted`
  behave identically on both.
- **Zero-width characters defeated the secret scan while the injector stripped them.** `scanSensitive` accepted
  `sk-\u200babcdef…` (an obfuscated key), and because `clampText` removes zero-width and bidi characters before
  injection, the plugin itself restored the **plaintext** key into the system prompt. Judgement now runs on a
  render-equivalent normalisation (NFKC plus zero-width/format stripping), so what is judged is what is shown. The
  earlier full-width-hardening fix still holds.
- **`maskPii` was quadratic on long character runs**: one 200 KB `memory_write` blocked the single-threaded host for
  **12.6 seconds**. The pathological backtracking is gone.

### Fixed

- Governance commands (`approve`, `pin`, `archive`, `confirm`, `refresh`, `reject-pending`) silently reported
  success when `persist()` failed — after a restart the change was gone while the text had claimed it took effect.
  They now check the result and answer with an honest error ("not on disk; it will revert after a restart").
- `ask` mode queued duplicates by fingerprint, so approving both produced **two active rows with the same hash**,
  contradicting the protocol's own rule. Queueing and approval now deduplicate the same way the default path does:
  an existing active row is reported as already present, an existing pending row is not queued twice, and approval
  merges instead of creating a second row.
- Non-finite `maxInjectedTokens` / `charsPerToken` (NaN, Infinity, 0, negatives) disabled the injection budget
  entirely — 60 of 60 rows injected, or nothing at all. They now fall back to their defaults like the existing
  per-item guard.
- `setEmbedder`, `capabilities()` and `stats()` threw when a host object exposed a throwing accessor for `id` or
  `dimensions`, violating the frozen contract. External properties are read defensively; unreadable ones count as
  invalid (registration state untouched).
- `recall({ mode: 'semantic' | 'hybrid' })` returned a Promise even with no embedder registered, contradicting the
  frozen synchronous signature. It is asynchronous only when embeddings are actually used; the lexical path and the
  no-embedder fallback are synchronous again.
- The release-privacy gate missed forward-slash drive paths, POSIX home paths written without a trailing slash,
  `file://` URLs that embed a drive path, UNC paths, `~` shorthand and the Windows user-profile environment
  variable — and scanned for **no credential shapes at all**. It now covers those and detects common key shapes (the
  usual provider prefixes, PEM private-key headers, JWTs) with counter-examples pinned so the patterns stay narrow. Because its username and
  `$DSH_HOME` needles are host-local, the check now **says so** and reports a skip instead of "clean" when identity
  judging is unavailable — which is exactly the situation in CI, the only automated gate.

### Documentation

- `SECURITY.md` claimed "no embedding service" while protocol v1.3 hands record text to a host-injected embedder.
  It now states that the plugin itself never makes network calls, and that injecting a remote embedder sends memory
  text off the machine — the host's and the user's decision, with its consequences spelled out.
- The protocol documents gained what a stranger actually needs: how to load the host half and which `ctx` seams are
  required (`effect`, `inject`, `on`, `systemPrompt`, `tools.register`, `commands.register`, `provide`), the required
  shape of the `storageDomain` handle (a plausible-looking wrong one silently yields healthy-looking writes that
  never persist), how to unload, the `refs` string grammar, and a corrected `mode` table (the key carries two
  vocabularies, and the documented table's values were silently ignored). `version` semantics, the `/memory confirm`
  claim and the missing `lastRecall()` entry were corrected against the implementation — 0.5.18's §11 said four
  surface additions when there were five.

### Notes

- One audit finding was **rejected as a false positive**: a claim that the CHANGELOG described a drive-letter fix
  "that exists in no document". The CHANGELOG describes an implementation decision in
  `tools/verify-self-contained.ts`, which does contain that lookbehind — the claim was about the wrong artifact.
- Mutation testing of the suite is reported alongside the fixes; the blind spots it exposed are listed in the
  integration notes rather than silently dropped.

## 0.5.20 — 2026-10-04

**Protocol v1.3: an externally injected embedder.** The user's call was the third option — the plugin does not
bundle a model and does not go online; a host may hand it an embedding function, and without one retrieval stays
exactly as it was. Purely additive again (`protocolVersion` `'1.2'` → `'1.3'`).

### Added

- `setEmbedder(embedder | null)`: register, replace or clear an embedder. Invalid input is rejected with
  `rejected_invalid` **without disturbing the current registration**.
- `capabilities()` — ask instead of guess: protocol version, `lexical: true`, whether an embedder is registered and
  its id.
- `recall({ mode: 'lexical' | 'semantic' | 'hybrid' })`, default `'lexical'` which is byte-for-byte the old path and
  makes **zero** embedding calls. `'hybrid'` blends `(1-w) * lexical + w * semantic` with `w = embedderWeight`.
- `lastRecall()` — what actually happened on the last recall: mode, whether embeddings were really used, the
  fallback reason (`no-embedder` / `embed-error` / `timeout`), candidate and vector counts.
- `stats().embedder` — id, dimensions, calls, errors, hits, misses, timeouts. Vectors are cached per content key
  (LRU, `embedderCacheMax`), the query and all candidates go out in **one batch call**, and every embed call is
  bounded by `embedderTimeoutMs`.
- `embedderRecallMode` (default `'off'`) decides whether the per-turn injection path may use hybrid scoring. Off by
  default means the injection path is byte-for-byte 0.5.19 unless a host opts in *and* registers an embedder.
- Config: `embedderRecallMode` `'off'`, `embedderWeight` `0.5`, `embedderTimeoutMs` `200`, `embedderCacheMax` `2000`
  — all patch-row knobs.

### Safety rules this release is built around

- **The plugin never goes online and never bundles a model.** It only calls the injected `embed`. Whether memory
  text leaves the machine, where it goes and whether it is logged is the host's and the user's decision; the plugin
  is not in a position to make it, and the protocol and README say so in as many words.
- **No silent pretending.** With no embedder registered, `mode: 'semantic'` falls back to lexical **and says so**
  through `lastRecall().fallback === 'no-embedder'`.
- **Failures never bubble.** A throwing, rejecting, malformed, dimension-mismatched or timed-out embedder is counted
  and falls back to lexical — it cannot fail a turn or lose a memory.

### Notes

- One deliberate lib choice: a vector containing `NaN`/`Infinity` normalises to all zeros rather than treating the
  bad components as zero, so `cosineSimilarity` returns `null` and the semantic leg drops out instead of scoring
  with a nonsense direction.
- `types.ts` gained an `Embedder` type and the three new `RecallOptions.mode` values, so third-party TypeScript
  callers can actually write `mode: 'semantic'` (the host had been narrowing locally).
- Integration also caught three lint findings and one gap the agents reported rather than hid; the fixes are in this
  release, not deferred.

## 0.5.19 — 2026-10-04

**Protocol v1.2** (again purely additive — `protocolVersion` `'1.1'` → `'1.2'`) plus the engineering debt that
shipping the whole `docs/` directory created.

### Added

- **`branch` accepts an array** in both `list()` and `recall()`: keep records whose tag is in the set, with
  `'current'` inside the array resolved to the current branch. **An empty array means an empty result**, not "no
  filter" — that subtlety is pinned by its own test, because getting it backwards would silently widen a query.
- **`stats().writes: { persisted, unpersisted }`** — cumulative, in-process counts of writes that did and did not
  reach the storage domain. This is the counter that 0.5.18's `persisted` flag made observable per call; now a
  consumer can watch the rate without instrumenting every write. Rejections (`ok: false`) count as neither.
- **`write()` success results carry `refs: string[]`** — the machine-readable sources of the row just written, `[]`
  when there are none. The pending path gains it too (it never returned a `record` before, so it previously offered
  no provenance at all). Rejection paths still carry no such field.
- **`verify:self-contained` now scans release privacy**: every file `npm pack` would publish is checked for the
  machine's username (read from `os.userInfo()`, never hardcoded), drive-letter and POSIX home absolute paths, and
  the real `$DSH_HOME`. Hits name the file and line without echoing the content; binary and oversized files are
  skipped with a reason and the output says outright that a skip is not a pass, and that an unavailable pack listing
  means "not verified".

### Notes

- The privacy scan found a genuine leak on its first run — the v1.2 contract document quoted an example absolute
  path, and that document ships. The example was rewritten to a placeholder; the checker is now the thing that
  keeps this from recurring, which is exactly why it was worth automating instead of eyeballing.
- Two existing assertions had to change, both acknowledged rather than worked around: the `stats()` key list (which
  v1.2 deliberately extends) and the `protocolVersion` literal. The record shape itself is untouched — the write
  *result* now reports `refs: []`, and there is an added assertion that the stored record still carries no `refs`
  key at all.
- One filtering detail worth stating: the drive-letter pattern requires that the letter not follow an identifier
  character, otherwise generated code such as `gitdir:\s*` in `lib/` would trip it — a false positive that no source
  change could fix.

## 0.5.18 — 2026-10-03

**Protocol v1.1.** The three gaps 0.5.17 left open were all additive, and the protocol's own §1 promises that v1
only ever grows — so this is a minor protocol bump (`protocolVersion` `'1.0'` → `'1.1'`), not a v2. Callers should
test for `'1.x'`, never for equality.

### Added

- **`list(options?)`** takes `{ status, branch, limit }`. No-arg behaviour is byte-for-byte what 0.5.17 returned
  (insertion order, every status, the live objects) — the raw view is still the default. `status: 'active'` never
  includes pending rows; `branch: 'current'` applies exactly the `branchVisible` filter the injection paths use, so
  a consumer can finally ask for "what the model actually sees" without reimplementing it.
- **`recall(options)`** gains the same `status` and `branch`. `status: 'pending'` is deliberately allowed for
  admin/audit queries — and deliberately *not* passed by any injection path, which is what keeps the M10 rule
  ("pending never reaches the context") intact. There is a test that hammers fifteen parameter combinations and
  asserts the resident and per-turn blocks are unchanged.
- **`write()` results carry `persisted`.** `ok: true` has always meant "applied in memory"; now the result also
  says whether the write actually reached the storage domain, taken straight from `persist()` rather than inferred
  from `ok`. Multi-step paths (portrait supersede) report `true` only when every step persisted. Rejection paths
  do not carry the field.
- **The whole `docs/` directory now ships** in the package instead of just the two protocol files, so installing
  from npm gets the contracts for refs, sleep, write-policy, audit, branch, i18n, trace and retrieval too.

### Notes

- `tests/protocol.test.ts` grew from 11 to 20 cases, all pinned to the built `lib/index.js`: version, no-arg
  equivalence, each `status` bucket, `limit` edge cases (0 / negative / NaN ignored), `branch: 'current'` agreeing
  with both injection channels, explicit-branch and unknown-branch behaviour, `persisted` on each success path and
  its absence on rejections, and the packaged file list.
- One consequence worth stating plainly: the explicit `status` path narrows the candidate set in the host before
  handing a query view to the pure layer, because the pure layer's pool intentionally admits only active/archived
  rows. Default and injection paths are untouched, but an explicit `{ status: 'all' }` query does not re-apply the
  pure layer's lexical floor. That is a deliberate trade — the pool rule is load-bearing, the floor is a
  recall-quality heuristic.

## 0.5.17 — 2026-10-03

Three tracks in one release, all from the "what is still missing" list rather than the competitor survey.

### Added

- **`/memory trace <sessionId prefix> [#<seq>]`** — the reverse of provenance. 0.5.9 gave each memory a source,
  0.5.14 let the user verify one row; this answers "what did that conversation leave behind": every record whose
  reference points into that session, optionally narrowed to the ones whose range covers a given event seq.
  Read-only (proven: records, counters, audit ring and disk writes all unchanged), branch-filtered, and it never
  shows pending rows. Command only — deliberately no eighth tool, so the tool contract stays where the M11 tests
  pinned it.
- **Zero-dependency retrieval quality.** The README's known-limitations section used to say search was purely
  lexical; now lexical search is as good as it gets without embeddings: Chinese bigrams with single-character
  fallback, light English suffix folding, IDF weighting instead of equal-weight hit counting, and length
  normalisation so a short precise row beats a long padded one. `memory_explain` reports which tokens matched and
  how much each contributed. Measured on this machine's real store: Top1 **85.7% → 100%**, Top3 flat at 100%,
  trigger rate unchanged; recall p50 at 2000 rows 1.42 ms against a 10 ms budget (~1.4x the old cost, the price of
  exact df statistics per call). Three switches (`searchStemming`, `searchBigram`, `searchLengthPenalty`) ride the
  patch row.
- **`ctx.memory` frozen as protocol v1** (`docs/protocol-v1.md`, `docs/protocol-v1.zh.md`, both now shipped in the
  package) plus `tests/protocol.test.ts`, an 11-case conformance suite pinning every documented promise to the
  built `lib/index.js` — including the three load-bearing rules: pending never injects, `refs` stays out of the
  fingerprint, `branch` goes in.

### Fixed

- **The service face could write garbage.** The `memory_write` tool has a JSON Schema; `ctx.memory.write` had
  nothing, so a third-party caller could create a record with `kind: undefined`. The service now validates `kind`
  and `text` and returns `rejected_invalid` without writing.
- The service now exposes `protocolVersion: '1.0'`, and the protocol documents ship with the package.
- Retrieval switches were read from `RecallOptions` while living on `MemoryConfig`: every in-plugin recall path and
  the service method now pass `cfg`, so the knobs actually apply.

### Decisions recorded rather than silently changed

- The recall *gate* still uses the pre-existing `match`/`minLexical` values, not the new normalised score: feeding
  the new score into `recallMinMatch` (0.4) would zero out recall entirely (measured ~0.16 for real R2 queries).
  `explainMatch().passes` implements the contract's literal rule for anyone asking per-row.
- Ranking keeps the existing 0.6/0.3/0.1 shape and only swaps the lexical term; sorting purely by the new score
  made two near-identical rows (0.1617 vs 0.1636) invert an importance-0.9 row, breaking host#13 for no gain.
- `list()` / `recall()` remain the unfiltered raw view of the store, and `write` reporting `ok: true` means
  "applied in memory" rather than "durable" — both are now stated in the protocol instead of being left implicit.

## 0.5.16 — 2026-10-03

The last item from the competitor-survey queue: 0.5.9 gave every memory a verifiable source, 0.5.14 let the *user*
check it (`/memory verify`), and this lets the **model** see it where it actually reads — recall and list output.

### Added

- `memory_recall` and `memory_list` items now carry a machine-readable `refs` field (`sessionId#from-to`, several
  joined with `;`). Records written before 0.5.9, or without an observable sequence range, get `''` rather than a
  missing key: the tool output keeps one shape, so the model never has to handle two, and the host still refuses to
  invent a range it never saw.
- README tool tables (both languages) say so.

### Notes

- Deliberately no change to the seven tool *descriptions*: those are model-visible text pinned byte-for-byte by the
  M11 contract tests, and the field is self-describing in the output. Changing them would be its own acknowledged
  release, not a silent rider on this one.

## 0.5.15 — 2026-10-03

Engineering hardening. No behaviour change: the only source edits are lint findings, and the regex rewrite was
verified equivalent over every Unicode code point.

### Added

- **`pnpm lint`** — oxlint (correctness rules only, `lib/` excluded). 20 findings on the first run: 12 fixed, plus one
  narrow override for `src/client.ts`'s deliberate triple-slash reference (importing `shims.d.ts` instead would make
  `tsc` emit a runtime `require('./shims.js')` into the client bundle — verified: removing the line breaks the
  single-file compile with three TS2307s).
- **`pnpm check:readmes`** — zh/en README structure check: section count and order, balanced code fences, the set of
  backticked table keys, the settings-field count, and the set of `/memory` + `/sleep` commands. Drift names the
  offending item and exits non-zero. It already earned its keep: the English README was missing the `/memory verify`
  line the Chinese one had. `pnpm test` now runs it.
- **`pnpm verify:self-contained`** — asserts `dependencies` stays empty, that no runtime bare import comes from
  outside the allowlist (devDependencies, builtins, or the client-side injected modules), and that `npm pack`
  contains the entries a `dsh plugin add` install needs.
- **`pnpm coverage` + `pnpm coverage:check`** — line-coverage gate with thresholds 97/83 (lib/lib.js, lib/index.js)
  derived from a measured 99.06%/85.55%.

### Fixed

- `eslint/no-control-regex`: two control-character classes rewritten as `\p{Cc}`; equivalence checked against all
  1,114,112 code points.
- Twelve correctness findings (unused imports and symbols, useless spreads) — the spread change in the usage-flush
  loop keeps a named snapshot on purpose: iterating the live Set would observe ids marked dirty mid-await.
- **The coverage report was silently measuring nothing.** Node's default test-coverage exclusion glob matches the
  whole absolute path, and this workspace happens to sit under a directory named `test`, so `lib/**` was excluded
  entirely and the report printed a cheerful `all files 100.00` — which meant "zero lines measured". The collect
  command now passes an explicit exclusion, and the gate has a witnessed failure mode: running a single test file
  reports 31.25% / 4.76% and exits 1.

### Notes

- The two coverage numbers are not interchangeable: Node's report maps back through sourcemaps (99.06% / 85.55%),
  while the tool's own generated-line computation gives 100.00% / 96.76%. Thresholds are selected per input mode. The
  first CI wiring applied the tool's numbers to the report path and failed for real — recorded in the tool, not
  papered over.
- CI now runs lint, check:readmes, verify:self-contained and the coverage gate on Node 22.x and 24.x.

## 0.5.14 — 2026-10-03

**Write audit and injection verification: "the model can see it" ⟺ "it was recorded".** The fifth competitive
direction. `/memory audit` shows two views of the same history without keeping a second copy of it: successful
writes, merges, invalidations, archives and pending rows are **derived from the records themselves** (so they survive
a restart), while the attempts that never landed — rejected writes (sensitive / echo / write policy / queue full),
queued, approved and rejected-pending — go into a new **bounded in-memory ring**. `--verify` checks this session's
injected lines against the session log with a literal `includes` test, and any gap (no `sessionQuery`, unknown session
id, unreadable log, no `user/message` events) is **stated**, never rendered as success. Contract: `docs/audit.md`.

### Added

- `auditMax` (`number`, default `50`): the capacity of the in-memory attempt ring; `0` = record no attempts. It is the
  **30th** field of the settings form (**29 → 30**), labelled in both languages, and the ring is **cleared on
  restart** (the output says so).
- `/memory audit [--limit N] [--verify]` (read-only): without flags it renders the recent attempts (id prefix ·
  action · via · origin · kind · time · reason), the per-action and per-via counts, and the in-store summary
  (active / pending / archived / invalid, plus the share of rows carrying refs). `--limit` selects how many recent
  attempts to show (default `20`, capped at `200`; `--limit=N` is accepted, a missing or non-positive value falls back
  to the default). `--verify` compares the lines injected this session with the session log using **verbatim
  `includes`** and reports `checked` / `matched` / `missing` plus one unmatched sample.
- `/memory stats` and `memory_stats` gained a one-line audit summary (recent attempts · store rows · verification
  misses); the detail stays in `/memory audit`.
- Both READMEs gained a "`/memory audit`" section with the two-source table (record-derived = persistent, in-memory
  ring = attempts including rejections), the `--limit` / `--verify` usage, the verbatim rule, the gap-is-stated rule,
  the read-only / never-blocks note and the no-extra-storage design note, plus the new configuration row.

### Changed

- **The default changes nothing, byte for byte.** `auditMax: 50` only fills an in-memory ring: no stored record, no
  read path and no file format changes, and a restart clears the ring either way. The audit adds **no storage** — the
  successful-write view is derived from the records that already exist.
- **The audit is read-only and cannot block anything.** `/memory audit` and `--verify` modify no record, no state and
  no counter — reading the audit does not push an audit event of its own (otherwise one `--verify` would change the
  next one's input). Every push, render and comparison is wrapped in `try/catch`: an audit failure never affects a
  write or an injection.
- **A gap is never a pass.** Without `sessionQuery`, with an unknown session id, when the session log cannot be read,
  or when the log contains no `user/message` event, the output says that it cannot verify and why; without `--verify`
  it says that no check was run. "Not checked" is never rendered as "checked and consistent".

## 0.5.13 — 2026-10-03

**Branch-aware project memory: feature-branch decisions stay on their branch.** The fourth competitive direction — a
memory can now carry an optional `branch` tag, and injection/recall filter tagged rows by the branch you are actually
on, so a convention that holds only on `feat/x` does not keep steering the model after you switch back to `main`.
Contract: `docs/branch.md`.

### Added

- `branchAware` (`boolean`, default `true`): filter branch-tagged rows by the current git branch; `false` ignores tags
  entirely. It is the **29th** field of the settings form (**28 → 29**), an English/Chinese-labelled `0` / `1` toggle
  that writes back a real boolean.
- `memory_write` gained an optional `branch` parameter: `true` = the current branch, a string = that branch, omitted =
  no tag (applies on every branch). A row's `branch` **participates in `recordHash`**, because it changes the row's
  scope of applicability rather than merely its provenance; branch names are normalized (trimmed, `refs/heads/`
  dropped, capped at 100 characters, illegal → no tag).
- `/memory branch [--all]`: the current branch, the number of tagged rows and the per-branch groups; `--all` also
  lists rows tagged for other branches. `/memory stats` and `memory_stats` gained a
  `分支：<current or unknown>｜带标签 N 条（branchAware=…）` line, and `memory_explain` shows which rows branch
  filtering blocked and why.
- Both READMEs gained a "branch-aware project memory" section with the four-case filter table, the fail-closed
  rationale, the explicit-tag-only rule, the `memory_write` parameter, the command and the zero-shell note, plus the
  new configuration row.

### Changed

- **The default changes nothing, byte for byte.** `branchAware: true` is the default, but no existing row carries a
  tag, so resident injection, per-turn recall, listing and search are identical to 0.5.12. Untagged rows are injected
  in every case — fail-closed only ever applies to explicitly tagged rows.
- **Branch resolution is read-only and shell-free**: only `.git/HEAD` (plus the `gitdir:` pointer when `.git` is a
  file, for worktrees/submodules) is read, behind a 5-second cache; no git command is ever executed. Any read failure
  means "branch unknown", in which case tagged rows are **not** injected (fail-closed) and a `branch: true` write is
  stored untagged with an explanatory tool result rather than mislabelled.

## 0.5.12 — 2026-10-02

Immediate follow-up to 0.5.11, found by rendering the new English texts for real rather than only asserting on them.

### Fixed

- **The English persona section rendered as nothing at default budgets.** `charsPerToken` (2.5) is a deliberate
  Chinese/English compromise, but English really costs ~4 characters per token, so the *same* block chrome costs
  ~2.5x more: measured in tokens, the persona header+footer is 31 in Chinese and **67** in English against a default
  `selfPersonaMaxTokens` of 80 — leaving 13 tokens, too little for one ordinary English row, so the whole section
  silently vanished. English now gets an explicit `EN_BLOCK_HEADROOM = 48` added to `selfPersonaMaxTokens` and
  `selfPortraitMaxTokens`; Chinese output is byte-for-byte unchanged because the headroom only applies to `en`.
- `maxInjectedTokens` is deliberately **not** inflated: that cap is the user's own, and a language switch should not
  quietly raise it. English users who want more resident rows raise it themselves (documented in both READMEs).

### Added

- A regression test that renders with `language: 'en'` at default budgets and asserts both the persona and work
  sections contain their rows, plus content-room floors (≥ 25 / ≥ 40 tokens) so verbose block chrome cannot eat the
  allowance again. Contract notes in `docs/i18n.md` §3.2.

## 0.5.11 — 2026-10-02

**English for the model, Chinese for you.** The half of the plugin the model reads — the injected blocks and their
headers/footers, the reflection and first-run prompts, the per-turn recall block and the seven tool descriptions —
was Chinese-only, so an English-speaking user's model read Chinese instructions every turn. `language` now switches
that half to English while command output stays Chinese, exactly as before.

### Added

- `language` (`'zh' | 'en'`, default `'zh'`): the language of **model-visible text only**. The English table is a
  complete counterpart of the Chinese one — the same footers (a description rather than an instruction; judge by
  facts and feasibility; do not agree just to please) and the same four hard requirements in the reflection and
  first-run prompts — and contains no mixed Chinese.
- Settings form: `language` is editable as an enum field, **27 → 28 fields**; both READMEs gained a "model-visible
  text language" section with the coverage table (what is localized and what is not) and the new configuration row.
- `/memory stats` prints the effective `language` (that line, like every other command output, stays Chinese), so
  "why is the model still reading Chinese?" has a visible answer.

### Changed

- **Default `'zh'` is 0.5.10 behaviour, byte for byte**: with `language` unset, missing or invalid, every injected
  byte is unchanged — the English table is an addition, not a rewrite of the Chinese one.
- **The tool contract does not move with the language**: tool names, parameter names, required fields and schema
  structure are identical in both languages; only the human-readable descriptions are translated, so a learned call
  pattern never breaks when the switch is flipped.
- **Command output stays Chinese** (`/memory …`, the `/sleep` preview, `stats`, …): localizing it is explicitly out
  of scope for this release.

## 0.5.10 — 2026-10-02

**An optional write approval gate: the model only proposes — you decide.** The two leading memory plugins in the
community directory both make this their safety story ("the approval gate cannot be bypassed", "AI-authored memories
land in a pending queue"); ours wrote model-origin rows straight to the store. Model writes can now wait for a user
decision — while the default keeps the old behaviour exactly.

### Added

- `writePolicy` (`'auto' | 'ask' | 'off'`, default `'auto'`): model-origin writes apply immediately, wait in a
  pending queue, or are rejected outright with a readable reason. Rule capture (`observed`), explicit user asks and
  user corrections are **never** gated — they are the user's own words, and queuing them would only drown them.
- `pendingMax` (default `50`): cap for the pending queue. A full queue **rejects** the new write with a structured
  error (`pending_queue_full: …`) instead of silently dropping it; `0` = unlimited. Pending rows are persisted like
  any other row and a `rejected` write never touches the disk.
- `/memory pending` (read-only listing), `/memory approve <id prefix>` (the only path that turns `pending` into
  `active`; a self-portrait row converges at that moment, not when it is queued) and
  `/memory reject-pending <id prefix>` (sets `invalid` and keeps the row for audit). No model tool can change a
  `pending` status, so **the model cannot approve itself**.
- Settings form: both keys are editable, **25 → 27 fields**; both READMEs gained a "write approval gate" section
  with the three-tier table, the queue commands and the two new configuration rows.

### Changed

- Default `auto` is 0.5.9 behaviour, byte for byte: model writes still apply immediately and never enter the queue.
- **Pending never reaches context.** The resident block, per-turn recall, the self-portrait, project gists, search,
  consolidation and `/sleep` all skip it; `/memory pending` and the `memory_explain` diagnostics are the only two
  windows that show it. `/memory stats` and `memory_stats` report the pending count together with the policy.
- The gate sits **after** the existing safety checks: in `ask` mode secrets are still refused before a row is
  queued, so the queue is not a masking back door.

## 0.5.9 — 2026-10-02

**Verifiable references.** Two independent memory plugins in the community directory lead with provenance
("verifiable citations", "facts carry sessionId/eventRange"), and our rows did not even record which session they
came from. Every memory can now say where it came from.

### Added

- `MemoryRecord.refs`: a list of `{ sessionId, from?, to?, via? }`, capped by `refsMax` (default 5, newest first).
  Collection is free — the sequence numbers come from the `session/event` callback the plugin already subscribes to.
- Every write path attaches a reference: turn-end capture stores the `turnStart..last` range; model tools, user
  commands and compaction solidification store the single point `last`; `/sleep` backfill stores the sequence of the
  **user message it came from**. Merges add the new reference and keep the old ones.
- `/memory verify <id>`: read-only. Walks back to the cited events and compares them with the row's text using
  informative-token coverage, reporting `✅ hit (coverage x)` / `⚠️ miss` / `⚠️ session or events missing`, and says
  plainly when a row has no references (written before 0.5.9) or the host has no `sessionQuery`.
- `/memory show <id>` prints a `source:` line; `memory_explain` exposes `refs`; `/memory stats` and `memory_stats`
  report how many rows carry references.
- Config: `refsEnabled` (default `true`) and `refsMax` (default `5`), both in the settings form (25 fields now).

### Notes

- **`refs` deliberately does not join `recordHash`** — otherwise the same memory would count twice just because it
  came from somewhere else, which would break deduplication and make `/sleep` non-idempotent. There is a test for it.
- Backward compatible: rows written earlier have no `refs` and every read path tolerates that.

## 0.5.8 — 2026-10-02

Found while building `/sleep`: DSH session logs are streams of **independent zstd frames**, one JSONL line each,
and Node's decompressor (sync or streaming) stops after the first one.

### Fixed

- `tools/read-session-log.ts` had always used a single-frame decode, so it printed "共 1 行" (just the `session`
  header) for logs holding thousands of events — measured on a real 8 MB log: **1 line before, 9008 events after**.
  It now decodes every frame, accepts a sessions *directory* as well as a file, and prints the session id and cwd.

### Changed

- Session-log reading is now one shared module, `tools/session-log.ts` (`decompressAllFrames`, `readSessionEvents`,
  `listSessionLogs`, `sessionHeaderOf`, `isRealUserMessage`, `textOfMessageContent`) instead of three near-copies
  that had already drifted. `inspect-session-header.ts`, `inspect-message-shape.ts` and `eval-recall.ts` all use it;
  `listSessionLogs` sorts newest-first with a deterministic path tiebreak.
- `docs/dsh-mechanisms.md` documents the frame format; both READMEs list `tools/session-log.ts`.

### Added

- `tests/tools.test.ts` (4 cases): a synthetic multi-frame log proves every frame is decoded, contrasts it with the
  single-frame hazard that caused the bug, and covers filtering, ordering and malformed lines.

## 0.5.7 — 2026-10-02

**Idle review: `/sleep` re-reads the recent sessions and re-sorts the store.** A new independent command (not a
`/memory` subcommand) replays the **complete event logs** of the most recent sessions through the memory pipeline,
backfills what was missed at the time, then re-runs merge / conflict / archive / gist over the whole store — as a
preview by default, writing nothing until asked.

### Added

- **`/sleep [--sessions=N] [--all] [--apply]`**, registered as its own command next to `/memory`. Session logs are
  read through the host's `sessionQuery` service (on-disk logs are concatenated zstd frames, so exact reads are the
  only reliable route); when that service is absent the command degrades with a readable message.
- **Preview is the default and writes nothing.** The plan reports what *would* change: rows to backfill, merge
  groups, conflicts to invalidate, rows to archive and project gists to recompute; an empty plan says "nothing to
  do" instead of printing nothing.
- **`--apply` backs up first.** The run exports every record to `sleep-backup-<ISO timestamp>.json` before touching
  the store, and a failed export aborts the whole apply.
- **Backfill only recognises what the user explicitly asked to remember**, reusing the automatic-capture rule
  extractor, so small talk never turns into memory; candidates already present by fingerprint are skipped, which
  makes a second run a no-op.
- **Seven new keys** in `DEFAULTS`: `sleepEnabled` (`true`), `sleepSessions` (`3`), `sleepMaxCharsPerSession`
  (`120000`), `sleepMaxCharsTotal` (`300000`), `sleepMaxBackfill` (`20`), `sleepAssistantContext` (`3`) and
  `sleepMaxGists` (`8`). Run counters live in `state.sleep` and the watermark in `MemoryMeta.lastSleepAt`; both
  `/memory stats` and `memory_stats` gained a sleep line.

### Changed

- **The self-portrait is out of scope.** Persona and work tendencies are the model's cognition about itself, so the
  rules do not draw conclusions for it: `/sleep` never produces an `agent_self` write.
- **User-owned rows are out of scope too.** Merges leave `pinned` alone, and a conflict plan that would invalidate
  a user-side row is skipped and flagged in the notes rather than executed.
- **Injected context is not user speech.** Only `source.kind === 'user'` events count as user messages (the
  plugin's own `runtime-context` injections are excluded) and `origin: 'subagent'` sessions are skipped, so the
  review cannot feed on its own output.
- The settings form grows from 20 to 23 fields — `sleepEnabled` (entered as `0`/`1`, still written as a **real
  boolean**), `sleepSessions` and `sleepMaxBackfill`; the other four sleep knobs stay patch-row only. Both READMEs
  gain a `/sleep` chapter plus the command line and the configuration rows.

## 0.5.6 — 2026-10-02

**First-run naming: the model asks how the two of you address each other.** A self-portrait starts with names, and
that is not something the plugin should guess — so `agent/pre-step` gains a one-off introduction channel next to
per-turn recall and the reflection prompt. It is one-off, refusable, and can be settled by hand.

### Added

- **First-run naming prompt** (section `dsh-memory:self-intro`, text from `INTRO_NOTICE`). From session turn
  `selfIntroMinTurn` (default 2), at most once per session and at most `selfIntroMaxAsks` times **in total across
  sessions** (default 2), the model is asked to put the question in **one sentence**: what name should the user
  give it, and how should it address the user. When the user leaves the choice to the model, it proposes a name
  and confirms it.
- **Three naming subjects**, stored as ordinary persona rows: `self.persona.name` (my name),
  `self.persona.address_user` (how I address the user) and `self.persona.address_self` (how the user addresses me).
  Declining counts too: "no need / whatever" is recorded as a "keep the default address" row.
- **Three new keys** in `DEFAULTS`: `selfIntroEnabled` (default `true`), `selfIntroMinTurn` (default `2`) and
  `selfIntroMaxAsks` (default `2`, counted across sessions).
- `namingSettled` treats **any** past naming row as settled — active **or** archived — so superseding a name does
  not restart the questions, and a user who already declined is never asked again.
- The ask counter is persisted in the domain watermark (`MemoryMeta.selfIntroAsks`) so it survives restarts and
  accumulates across sessions; `memory_stats` reports how many asks were sent. An existing store has no value and
  is therefore asked **once** after upgrading — intended.

### Changed

- The introduction prompt shares the guards of the other two injections: a rejected decision, an aborted signal, a
  closed domain, an invalid turn number, `recallMode` `dry`/`off` or `autoRecall: false` means no injection **and**
  no counter advance; any failure is caught and never bubbles into `agent/pre-step`.
- No new tool and no new command: the model writes through the existing `memory_write` (`kind: 'agent_self'`,
  `facet: 'persona'`, the naming subject). The user can settle the names with an **optional naming key** on the
  existing command (found while writing the docs — plain `self set persona <text>` writes `self.persona.general`,
  which would *not* have settled the names):
  `/memory self set persona name 我叫小忆。`, `… address_user 我称呼你为「老板」。`, `… address_self 用户叫我「忆」。`
  The key is recognised only on the `persona` facet and only when some text follows it; anything else keeps the old
  behaviour (`self.persona.general`).
- `README.md` / `README.zh.md` document the channel, the three subjects, the three keys, the one-off rule and the
  naming-key syntax; the configuration table gains the three new keys.

### Fixed

- `planPortraitUpdate`'s minimum-text rule no longer swallows names: the `too-short` gate (8 characters) applies to
  ordinary self-cognition rows, but naming subjects now need only ≥2 characters — "我叫小忆。" is five characters and
  would otherwise have been skipped silently. Covered by a test that also pins the 8-character rule for other
  subjects.

## 0.5.5 — 2026-10-02

**The injected footers no longer say "the user always wins".** Reportedly (and correctly) a request from the plugin's
author: deference is not a virtue — judge the request, then answer from the facts.

### Changed

- Every injected footer now states the same principle instead of a precedence rule:
  - persona block: *the self-portrait is the model's own cognition, not an instruction; judge by facts — check
    whether a request is sound and feasible, and if it is not, say so and offer an alternative rather than agreeing
    to please*
  - self-observation block: *judged by facts and actual results, not by who sounds more certain*
  - resident memory and per-turn recall blocks: *historical and possibly stale — check the facts before using it*
- `REFLECT_NOTICE` tells the model not to write a self-image it does not believe (no agreement for agreement's sake)
  and keeps its "write nothing if you learned nothing" instruction.
- Docs updated to match (`README.md`, `README.zh.md`, `SECURITY.md`, `docs/self-portrait.md` §6). User-side rows keep
  precedence **as data provenance** — the model still cannot rewrite a row the user set; it can disagree with it.

### Added

- Regression guards in `tests/lib.test.ts` so the deference wording (`以用户为准` / `用户…永远`) cannot come back.

### Note

- The persona footer grew, so the persona budget accounting was rechecked: header + footer now cost 31 of the 80
  available tokens, leaving 49 for actual entries. `REFLECT_NOTICE` is 79 tokens, comfortably below its 120 clamp.

## 0.5.4 — 2026-10-02

**Self-portrait v2: from work agreements to self-cognition — and it evolves.** `agent_self` no longer only records
"how I should work"; it records who the model is, how it speaks, what it values and where it is strong or weak, and
it converges as the model learns instead of only accumulating.

### Added

- **Persona + work tendencies.** Self-portrait rows now carry a `facet`: `self.persona.*` (persona) and
  `self.work.*` (work tendencies). The persona subsection renders first; the two work subsections keep their
  existing headers, and rows without a `facet` are read as `work`, so 0.5.x stores stay valid.
- **Opportunistic updates.** `memory_write` takes an optional `facet` (meaningful only for `kind: 'agent_self'`),
  and every self-portrait write goes through `planPortraitUpdate`, which decides add / reinforce / refine /
  supersede / skip instead of blindly appending. `state.self` counters (`added`, `refined`, `superseded`,
  `skipped`) are surfaced by `memory_stats`.
- **Low-frequency reflection prompt.** From turn `selfReflectMinTurn` (default 4), at most every
  `selfReflectEveryTurns` turns (default 12) and at most `selfReflectMaxPerSession` times per session (default 3),
  the `agent/pre-step` hook appends one `runtime-context` message (`dsh-memory:self-reflect`) inviting the model to
  reconsider its self-portrait — and telling it to write nothing when there is nothing new. With `recallMode` set to
  `dry` or `off` it is never injected and the counters do not advance.
- **`/memory self` commands**: `self` (list both subsections with id, origin and confidence), `set <persona|work>
  <text>` (writes a user-side, pinned, confidence-1 row), `history [subject]` (the revision chain, old → new) and
  `reset [persona|work]` (archive, never delete). `/memory help` and the usage line document them.
- **Seven new tunable fields**, all `volatile()` and exposed in the settings form: `selfPortraitEnabled`,
  `selfPersonaMaxTokens`, `selfPortraitMergeThreshold`, `selfReflectEnabled`, `selfReflectEveryTurns`,
  `selfReflectMinTurn`, `selfReflectMaxPerSession`.
- `memory_explain` shows `facet` and (when present) `supersededBy`.

### Changed

- **Conflicts converge, with a paper trail.** A same-subject insight at or above `selfPortraitMergeThreshold`
  (default 0.6) is merged (`refine`) or, when the texts already overlap, reinforced; below the threshold the model
  changed its mind, so the old row is archived with `supersededBy` pointing at its replacement. The revision chain
  stays readable through `portraitHistory` and `/memory self history`.
- **User-owned self-portrait rows are protected.** A candidate that does not itself come from the user side can no
  longer refine or supersede a row that is `user_explicit` / `user_correction` or `pinned` — the decision degrades
  to `skip` (`user-owned`). The model can only rewrite what it wrote itself.
- **The persona subsection has its own budget** (`selfPersonaMaxTokens`, default 80) while the two work
  subsections keep sharing `selfPortraitMaxTokens`; inside the persona subsection, user-side rows render before
  model self-observations.
- The settings form grows from 10 to 17 fields. The two boolean keys (`selfPortraitEnabled`, `selfReflectEnabled`)
  are entered as `0`/`1` in the form but are still written as **real booleans** — the settings service validates
  JSON shape only, so a number would reach the profile patch and then fail the `Schema.boolean()` re-parse.
- Both READMEs rewrite the self-portrait chapter: persona + work, opportunistic updates, the reflection prompt, the
  revision/archival semantics, the user-ownership guarantee, the priority rule (*the user's in-the-moment
  instruction beats the self-portrait*) and the new commands and keys.

## 0.5.3 — 2026-10-02

Performance pass on the hot paths, driven by a new benchmark (`pnpm bench`).

### Fixed

- **Per-turn recall silently stopped working on a large store.** The recall scan took 23 ms at 2000 memories while
  `recallBudgetMs` is 10 ms, and the budget check runs *after* the scan — so the work was done and then thrown away.
  Two causes, both fixed: every record was re-tokenised on every scan (now cached per record fingerprint, with
  oldest-first eviction rather than a full clear, so a store larger than the cache no longer thrashes), and the query
  text was re-tokenised **per record** (now computed once per scan and passed down).

  | Records | recall (per turn) | recall (search) |
  |---|---|---|
  | 200 | 2.11 ms → **0.13 ms** | 0.84 ms → **0.05 ms** |
  | 2000 | 23.03 ms → **0.91 ms** | 8.45 ms → **0.55 ms** |
  | 5000 | 56.16 ms → **2.33 ms** | 21.01 ms → **1.56 ms** |

  The public functions (`lexicalMatch`, `memoryMatch`, `scoreRecord`) keep their signatures and semantics; only the
  internals changed, and two tests pin the cache down (cold/warm results must be identical, cache size stays bounded).

### Added

- `tools/bench.ts` (`pnpm bench`): per-turn recall, per-step render and consolidation timings across store sizes, so
  budget claims like the 10 ms recall target can be checked instead of assumed. The consolidation path measures
  1.1 ms / 10.0 ms / 26.3 ms at 200 / 2000 / 5000 records — linear and low-frequency, so it needs no work.

## 0.5.2 — 2026-10-02

Follow-up to 0.5.1: the host-half test suite landed in full, and reviewing it surfaced one more behavioural bug.

### Fixed

- **Recall could return nothing while relevant memories existed.** The per-turn recall path asked the index for
  exactly `recallTopK` candidates and applied the cooldown filter *afterwards*. Because injected memories get a
  recency boost, the row injected last turn sorted first, was then removed by its cooldown, and took the whole
  candidate pool with it. The pool is now four times the requested size (capped at 50) and the cooldown filter runs
  **before** the top-K slice. Regression test `host#13` fails against the previous behaviour (verified by mutation).

### Added

- `tests/host.test.ts` grew to 14 cases (55 → 56 tests overall); every 0.5.1 fix is covered by a case that turns red
  when the fix is reverted.

### Documented

- `/memory clear` now documents that `--all` is mutually exclusive with `--kind=` / `--scope=` and that filters
  combine with AND; `/memory import` documents the field validation, clamping, forced `pinned: false` and the
  `observed` downgrade (so re-importing your own export loses the pin on purpose).

## 0.5.1 — 2026-10-02

Hardening pass driven by two independent audits (code correctness/security, and repository engineering).

### Security

- **Injected lines are flattened.** `clampText` collapses newlines/control characters to spaces and strips
  zero-width and bidi characters, so stored text can no longer forge block headers, footers or `[system]`-looking
  lines (a memory containing `\n` previously made the block footer appear twice).
- **Sensitive scanning is width-aware.** `scanSensitive` / `maskPii` fold full-width and compatibility forms (NFKC)
  before matching. Previously a full-width national ID or card number passed the half-width patterns, was stored
  raw, and was then normalised back to a readable number on injection.
- **`/memory import` validates and downgrades.** Imported rows are field-checked against the `kind` / `scope.level`
  whitelists, numeric fields are clamped, `pinned` is forced off, and `origin` is downgraded to `observed` — an
  imported file can no longer mint `user_explicit` rows that conflicts never override.

### Fixed

- Capture has a re-entrancy guard: a capture that overruns its timeout can no longer keep writing to the same record
  set while the next turn's capture runs.
- `domain.global.get()` is awaited, so a thenable watermark no longer causes a full consolidation on every start.
- Recall cooldown pruning is reachable again (the cutoff no longer depends on a field nobody writes), so the map
  cannot grow across sessions.
- `/memory clear` validates `--kind=` / `--scope=` against the enums and combines conditions with AND instead of OR.
- Tool results truncate by entry count and serialise as whole JSON — previously a byte-wise `slice` could hand the
  model a broken document.
- `remove()` reports failure when the delete itself failed, so `/memory forget` and `clear` no longer claim success
  for rows that will reappear after a restart.
- The self-portrait budget is shared: user-confirmed rules are allocated first and model self-observations get what
  is left, so the two blocks together stay within `selfPortraitMaxTokens`.
- `clampText` tolerates a non-finite `maxItemTokens` (a patch row could set `Infinity`, which disabled truncation
  and let one long memory crowd out the rest of the block).

### Added

- GitHub Actions CI: typecheck, tests and build-output-sync check on Node 22.x and 24.x, plus a package-contents
  assertion.
- `tests/host.test.ts`: the host half is now covered with a fake `ctx` (registration contract, volatile config
  unwrapping, write rejection, `agent/pre-step` injection shape, unload safety).
- `SECURITY.md`, `CONTRIBUTING.md`, this changelog.

### Changed

- Removed the unused `gistMaxPerWorkspace` config key: the per-workspace project gist is a single row that gets
  refreshed in place, so the "max N per workspace" cap never had anything to cap.
- pnpm-specific settings moved from `.npmrc` to `pnpm-workspace.yaml` (pnpm 10+ no longer reads them from
  `.npmrc`), which fixes a lockfile that still auto-installed the outdated peer packages.
- Dev tools converted to TypeScript and the PowerShell deploy script replaced by `tools/deploy-dev.ts`;
  `lib/` plus `node_modules` are the only JavaScript left in the tree.

## 0.5.0

- **Rewritten in TypeScript**, built with `tsc`, managed with pnpm. `src/{index,lib,client,types,shims}`.
- `lib/` is committed so `dsh plugin add github:…` still needs no build step and no `allowBuilds` authorization.
- Fixed: editing `domainName` in the settings form threw a `TypeError` (the text field ran the enum branch); now
  uses the framework's `settingsTextField`, with a regression test.

## 0.4.3

- Manifest and both READMEs point at the published repository; versioning note added and later moved to
  long-term memory only.

## 0.4.2

- First public commit: host half (storage, rule-based capture, dual-channel injection, consolidation, 7 tools,
  16 `/memory` commands), browser half (settings form on the plugin's row page), 34 unit tests.

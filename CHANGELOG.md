# Changelog

Version numbers advance by one patch (`0.5.0 → 0.5.1`). This file covers the public history; the repository's first
public commit was `0.4.2`.

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

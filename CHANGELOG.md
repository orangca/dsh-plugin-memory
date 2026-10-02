# Changelog

Version numbers advance by one patch (`0.5.0 → 0.5.1`). This file covers the public history; the repository's first
public commit was `0.4.2`.

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

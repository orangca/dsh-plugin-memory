# dsh-plugin-memory

Personalized long-term memory for DSH (DeepSeek Harness): local-first, automatic capture, dual-channel injection,
explainable and deletable.

[中文说明](README.zh.md) | English

- **Local** — all data lives under `$DSH_HOME/storages/<domainName>/`. No network calls, no embedding service.
- **Automatic** — at turn end a rule engine extracts what is worth remembering from *real user messages only*,
  with zero extra model calls.
- **Budgeted** — every injection has a hard token cap; overflow is truncated by priority.
- **Explainable** — each memory carries its origin (session + seq range), confidence and timeline.
- **Deletable** — delete one, clear all, export the whole store; deletions take effect in the same process.

---

## The four memory layers

| Layer | Content | Scope | Injection |
|---|---|---|---|
| User profile | Preferences, environment, prohibitions | profile | Resident (user-role snapshot) |
| Agent self-portrait | "How I should work": rules the user set, user corrections, model self-observations | profile | Resident (system-prompt section) |
| Project gist | Coarse impression of one workspace (stack / build / layout) | workspace | Resident, explicitly labelled *fuzzy and possibly stale* |
| Episodic / semantic / procedural | Conclusions, facts, procedures | workspace | Retrieved on demand |

## Three paths

1. **Write** — rule extraction at turn end (the default path, zero model calls) plus the `memory_write` tool.
   Hard secrets (API keys, private keys, passwords, national IDs, bank cards) are **always rejected**; there is no
   force flag. Email addresses and phone numbers are **masked before storage** (`a***@b.com`, `138****5678`)
   according to `piiPolicy`. When the same fact is mentioned again in a **new session**, its importance is raised
   (`repeatMentionBoost`) instead of adding a duplicate row.
2. **Recall** —
   - *R1 resident*: profile facts, the self-portrait, and the current workspace's project gist;
   - *R2 per turn*: matches the current turn's user message against the memory side and injects only what is
     genuinely related, with a per-id cooldown.
3. **Consolidate** — every 30 minutes by default, plus a catch-up run at startup. Merges duplicates, marks
   contradictions invalid (recoverable), decays/archives by per-kind half-life, and summarizes subjects that
   accumulate too many rows.

## Guarding against memory pollution / self-reinforcement

- Capture reads **real user messages only** — the plugin's own injected context does not count.
- A model self-observation that merely restates freshly injected memory is dropped as an **echo**.
- A model self-observation reaches the system-prompt channel only after it **recurs across ≥2 sessions**, and it
  is capped at 4 of 12 self-portrait rows.
- **Non-user origins can never override user-side rows**; on conflict, the user wins.
- User-side origins do not decay and can only be revoked by the user.

---

## Requirements

- DSH Desktop or the `dsh` CLI with a profile (the plugin installs as a **bundle**: it contributes one patch layer).
- Node.js ≥ 22 for running the tests and tools.
- Plain JavaScript, **no build step** — what you clone is what runs.

## Install

```sh
# from a tarball (recommended for release artifacts)
dsh plugin --profile desktop add ./dsh-plugin-memory-0.5.0.tgz

# straight from GitHub (works because this package needs no build step)
dsh plugin --profile desktop add github:orangca/dsh-plugin-memory

# from npm, once published
dsh plugin --profile desktop add dsh-plugin-memory
```

Uninstall (memory data is **not** deleted):

```sh
dsh plugin --profile desktop remove dsh-plugin-memory
```

To erase the store, use `/memory clear --all --yes` or delete `$DSH_HOME/storages/<domainName>/`.

### Manual route (no plugin manager)

Add this package to the profile's `dependencies`, append `dsh-plugin-memory` to
`dsh.profile.bundles`, and (optionally) add a user-level row so the plugin's settings appear in the GUI:

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: dsh-memory
  config:
    domainName: dsh_memory
```

## The settings form

The plugin exports a schemastery `Config` whose 10 tunable fields are declared `volatile()`, and ships a small
browser half (`src/client.ts`, built to `lib/client.js`) that renders them as a form. Find it under **Plugins → `dsh-plugin-memory` →
row `dsh-memory`** (the list card also shows a one-line summary).

Under the hood the client half registers into the keyed `plugins.row.config` slot with
`key: 'dsh-plugin-memory#dsh-memory'`, using DSH's shared `SettingsFormModel` / `SettingsForm`. Saving validates the
whole Config through the settings service and persists it into the profile patch — no restart needed.

## Commands

```
/memory list [--kind=agent_self] [--archived]   list memories (--archived includes archived rows)
/memory search <keywords>                        lexical search (includes archived, never invalid)
/memory show <id prefix>                         full record with origin and timeline
/memory forget <id prefix>                       permanently delete one memory
/memory restore <id prefix>                      revive an invalid/archived row (and undo its superseders)
/memory pin <id prefix>                          pin (never decays, never auto-archives)
/memory archive <id prefix>                      archive (no resident injection, still searchable)
/memory refresh <id prefix>                      refresh (restart the decay clock)
/memory confirm <id prefix>                      promote a model self-observation to user-confirmed
/memory reject <id prefix>                       reject a self-observation (that kind is never re-created)
/memory export [path]                            export JSON
/memory import <path>                            import JSON (deduplicated by fingerprint)
/memory clear --all --yes                        permanently clear (also --kind= / --scope=)
/memory consolidate                              consolidate right now
/memory stats                                    runtime observability: counts, writes, render time
/memory help
```

## Model tools

| Tool | Purpose |
|---|---|
| `memory_write` | Structured write (`kind` + `text`, optional `subject` / `field` / `value` / `scopeLevel`). **The origin is decided by the plugin — the model cannot claim "the user asked for this"** |
| `memory_recall` | Search by query / kind / scope / tag |
| `memory_list` | List in deterministic order |
| `memory_forget` | Delete by id; deleting by query needs `confirm: true` (stricter preview threshold) |
| `memory_maintain` | Trigger consolidation manually (merge / invalidate / archive / summarize) |
| `memory_stats` | Runtime observability: row counts, write/reject counters, injected lines, render time |
| `memory_explain` | Diagnose which signal a text hits, which rule excludes it, and what would be written |

## Configuration

Set `config` on the patch row; the full default set lives in `DEFAULTS` in `src/lib.ts`. The ten fields exposed in
the settings form:

| Field | Default | Meaning |
|---|---|---|
| `domainName` | `dsh_memory` | Store name (also the on-disk directory) |
| `maxInjectedTokens` | `300` | Hard token cap for resident injection |
| `maxItemTokens` | `60` | Truncation length for one injected memory |
| `selfPortraitMaxTokens` | `120` | Budget for the self-portrait block |
| `recallMode` | `inject` | `off` / `dry` (compute but do not inject) / `inject` |
| `recallTopK` | `8` | Max memories recalled per turn |
| `captureMode` | `rule` | `off` / `rule` |
| `captureMaxPerTurn` | `3` | Max automatic writes per turn |
| `consolidateEnabled` | `true` | Scheduled consolidation |
| `consolidateIntervalMinutes` | `30` | Consolidation interval |

Additional knobs available only through the patch row (with their defaults): `maxItemTokens` neighbours such as
`selfPortraitMaxItems` 12 / `selfPortraitMaxSelfObserved` 4, capture tuning (`capturePerHour` 20,
`captureMinConfidence` 0.6, `echoThreshold` 0.9, `gistMinMarkers` 2), self-portrait admission
(`selfPortraitPromoteSessions` 2, `selfPortraitModelMinConfidence` 0.85), consolidation
(`mergeSimilarity` 0.7, `archiveAfterDays` 180, `archiveBelowImportance` 0.15, `summarizeAbove` 5),
recall detail (`recallMinQueryChars` 12, `recallMinHits` 2, `recallMinMatch` 0.4, `recallCooldownTurns` 3,
`recallBudgetMs` 10), privacy (`piiPolicy` `mask`), `repeatMentionBoost` 0.1, `reportPath` (optional JSON
self-report for development) and `seed` (dev-only demo data, **off** by default).

## Data and privacy

```
$DSH_HOME/storages/dsh_memory/
├── global.json            # watermark: schema version, collectionVersion, last consolidation time
└── memories/<id>.json     # one file per memory, shaped { version, record }
```

- The storage root is **home-level**: every profile on the machine shares one store by default, which is usually
  what you want for personal memory.
- Nothing leaves the machine. There is no telemetry, no embedding service and no history upload.
- Sensitive content is rejected before it reaches a file; PII is masked. Both behaviours are covered by tests.
- DSH does not migrate domain versions automatically: bumping `version` requires declaring `compatibleVersions`.

## Development

Written in TypeScript, built with `tsc`, managed with pnpm.

```sh
pnpm install                                    # devDependencies: typescript, @types/node, schemastery types
pnpm build                                      # src/*.ts -> lib/*.js (+ the client half's lazy-CJS wrapper)
pnpm test                                       # builds, then runs the unit tests on the built output
pnpm typecheck                                  # host half and client half, no emit
node tools/eval-recall.mjs                      # offline recall eval over real session logs
pwsh -File tools/deploy-dev.ps1                 # mount lib/ as a new dev revision (run pnpm build first)
pwsh -File tools/deploy-dev.ps1 -Set "recallMode='dry';maxInjectedTokens=200"
node tools/extract-asar.cjs                     # extract DSH client bundles (UI debugging)
node tools/scan-asar.cjs settingsNumberField    # find where a symbol lives in app.asar
```

Layout:

| Path | Role |
|---|---|
| `src/index.ts` | Host half: storage, capture, injection, consolidation, tools, commands |
| `src/lib.ts` | Pure functions (no `ctx`) — the entire unit-test surface |
| `src/client.ts` | Browser half: the settings form (compiled to CommonJS, then wrapped) |
| `src/types.ts`, `src/shims.d.ts` | Domain types plus the DSH seam subset this plugin relies on |
| `lib/` | Build output — **committed on purpose** (see below), shipped in the package (`files`) |
| `tools/build-client.mjs` | Wraps the compiled client into `window.__ModuleLoader__.load({ id, factory })` |

Why the build output is committed: `dsh plugin add github:<owner>/<repo>` fetches **source, not artifacts** and
runs no build script. If `lib/` were gitignored, a GitHub install would end up with a `main` pointing at a file that
does not exist. Committing it keeps the install a no-op — no build step, and no `allowBuilds` authorization for a
`prepare` script that would otherwise execute code on the user's machine.

Three development notes that cost real debugging time and are worth knowing:

- DSH resolves configuration from the profile patch, and a plugin row may need to be **locatable in that file** for
  the settings service to project its form — a bundle-layer-only row may not appear.
- `deploy-dev.ps1` never reuses a revision number, because Node's ESM cache is keyed by resolved path: reusing a
  path hands you the previously cached module.
- The `@deepseek-ai/*` packages on npm are **older than the DSH you are running** — the published
  `dsh-client-ui-primitives` does not even export the settings API. Type against the empirically verified subset in
  `src/types.ts` / `src/shims.d.ts` instead of importing mismatched types.

See [`docs/dsh-mechanisms.md`](docs/dsh-mechanisms.md) for the DSH seams, slot semantics and environment facts this
plugin is built on — written for plugin authors, with no environment-specific details.

### Versioning

Releases bump the **patch digit only**: `0.5.0` → `0.5.1` → `0.5.2`. Do not jump minor or major versions.

```sh
pnpm version patch --no-git-tag-version   # 0.5.0 -> 0.5.1
```

## Known limitations

- **Consolidation of compaction summaries depends on the deployment.** The code path listens to
  `compaction/summary`; a profile without a mounted compaction plugin simply never produces them.
- **Full-text session search is usually unavailable** — the session query index ships as `openAt: never`, so the
  plugin keeps its own lexical index and only uses exact reads for history back-references.
- **Retrieval is lexical** — CJK bigrams plus Latin stemming and memory-side coverage. Paraphrase-level recall
  needs vector retrieval and is future work.
- **No graphical memory browser.** The GUI exposes configuration only; browsing, deleting and pinning memories go
  through the 16 commands and 7 tools above.
- **Two design items are explicit degradations**: (1) the self-portrait is not de-duplicated against the
  deployment's persona text, and (2) if the deployment registers a `complete` persona section that displaces other
  prompt sections, the self-portrait section disappears with it — the plugin does not silently fall back to the
  `context()` channel.
- **End-to-end gain (memory vs. full context) is not automated.** The offline eval measures the recall path itself;
  the Δ measurement is a documented manual procedure (answer a fixed question set with `recallMode: 'off'`, with
  this plugin, and with the full history pasted in, then compare accuracy and token cost).

## License

MIT — see [LICENSE](LICENSE).

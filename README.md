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
| Agent self-portrait | **Who I am, how I speak, how I work**: persona plus work tendencies | profile | Resident (system-prompt section) |
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

## The self-portrait: persona + work tendencies

The self-portrait (`agent_self`) is **the model's cognition about itself**. It is injected resident into the system
prompt as two subsections:

| Section | Content | Subject |
|---|---|---|
| Persona | Who I am, how I speak, what I value | `self.persona.*` |
| Work tendencies | What I am good at and bad at, rules the user set, user corrections, model self-observations | `self.work.*` |

- **Updated opportunistically**: the model writes as it goes — `memory_write` with `kind: 'agent_self'` may pass a
  `facet` (`'persona'` / `'work'`, default `'work'`, meaningful only for that kind); users can set it directly with
  `/memory self set`.
- **Low-frequency reflection prompt**: every `selfReflectEveryTurns` turns (default 12) the plugin injects one
  prompt (it says "write nothing if you learned nothing new"), at most `selfReflectMaxPerSession` times per session
  (default 3) and never before turn `selfReflectMinTurn` (default 4). `selfReflectEnabled` turns it off entirely;
  with `recallMode` set to `dry`/`off` it is not injected either, matching per-turn recall.
- **Evolution, not accumulation**: a new insight on the same subject is merged into the existing row when
  similarity is ≥ `selfPortraitMergeThreshold` (default 0.6); below it the model changed its mind — the old row is
  **archived for the record** (`status: 'archived'` plus `supersededBy` pointing at the new row), and the revision
  chain stays visible through `/memory self history`.
- **User-owned rows are protected**: rows the user set or confirmed (`origin: 'user_explicit'` or `pinned: true`)
  **cannot be overwritten by the model** — only a user-side write may supersede them.
- **Priority**: the self-portrait is a **description, not an instruction** — but neither is it an excuse for
  deference. The injected footers say the same thing the plugin's author asked for: **judge by facts**. A request is
  first checked for whether it is sound and feasible; if it is not, say so and offer an alternative rather than
  agreeing for the sake of agreement.

### Getting your names settled (first run, one-off)

A self-portrait starts with how the two of you address each other, and the plugin does not guess it — the **model
asks**. From session turn `selfIntroMinTurn` (default 2), at most once per session and at most `selfIntroMaxAsks`
times **in total across sessions** (default 2), `agent/pre-step` injects one prompt (`dsh-memory:self-intro`)
telling the model to put the question in **a single sentence**: what name would you like to give me, and how
should I address you. When you leave the choice to it, it proposes a name and confirms it. The answer is stored as
ordinary persona rows under three subjects:

| Subject | Meaning |
|---|---|
| `self.persona.name` | my own name / how I refer to myself |
| `self.persona.address_user` | how I address the user |
| `self.persona.address_self` | how the user addresses me |

- **Declining settles it too.** If you say you don't need one (or "whatever"), the model records a "keep the
  default address" row instead — and the question is never asked again.
- **One-off.** As soon as *any* naming subject has ever been recorded — active **or** archived — the matter counts
  as settled: an archived name still means "we talked about this", and asking again is worse than an imperfect
  name. You can settle it by hand too (**no new command**: `/memory self set` simply gained an optional naming key):

  ```sh
  /memory self set persona name 我叫小忆。                   # -> self.persona.name
  /memory self set persona address_user 我称呼你为「老板」。   # -> self.persona.address_user
  /memory self set persona address_self 用户叫我「忆」。       # -> self.persona.address_self
  /memory self set persona 我重视把事实和推测分开说。           # no key: still self.persona.general
  ```

  The naming keys are only recognised on the `persona` facet; anything else (or the `work` facet) is treated as
  ordinary text.
- `selfIntroEnabled` (default `true`) turns the channel off; with `recallMode` `dry`/`off` or `autoRecall: false`
  the prompt is not injected and the ask counter does not advance. `memory_stats` reports how many asks were sent.

```
/memory self                             list the persona and work subsections (id, origin, confidence each)
/memory self set <persona|work> [name|address_user|address_self] <text>   set/override (user-side, pinned, confidence 1); a naming key on persona settles the names
/memory self history [subject]           revision chain, old → new (with archival time)
/memory self reset [persona|work]        archive the current self-portrait (history is kept, nothing is deleted)
```

## Guarding against memory pollution / self-reinforcement

- Capture reads **real user messages only** — the plugin's own injected context does not count.
- A model self-observation that merely restates freshly injected memory is dropped as an **echo**.
- A model self-observation reaches the system-prompt channel only after it **recurs across ≥2 sessions**, and it
  is capped at 4 of 12 self-portrait rows.
- **Non-user origins can never override user-side rows**; in a conflict over a row's own content, the user-side row
  keeps precedence (this is about data provenance, not about a user request outranking a fact).
- Portrait convergence never touches user-side rows either: the model **cannot** overwrite a `user_explicit` /
  `pinned` self-portrait row, only rows it wrote itself.
- User-side origins do not decay and can only be revoked by the user.

---

## Requirements

- DSH Desktop or the `dsh` CLI with a profile (the plugin installs as a **bundle**: it contributes one patch layer).
- **Installing** needs nothing else: the package ships prebuilt `lib/` output, so `dsh plugin add` runs no build step
  and needs no `allowBuilds` authorization.
- **Contributing** needs Node.js ≥ 22.18 (native TypeScript type stripping; earlier 22.x needs
  `--experimental-strip-types`) and pnpm (the version in `packageManager`).

## Install

```sh
# from a tarball (recommended for release artifacts)
dsh plugin --profile desktop add ./dsh-plugin-memory-<version>.tgz

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

The plugin exports a schemastery `Config` whose 20 tunable fields are declared `volatile()`, and ships a small
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
/memory self                                     self-portrait: list the persona and work subsections
/memory self set <persona|work> [name|address_user|address_self] <text>            set/override it directly (user-side, pinned, confidence 1); a naming key on persona settles the names
/memory self history [subject]                   self-portrait revision chain (old → new, with archival time)
/memory self reset [persona|work]                archive the current self-portrait (history kept, nothing deleted)
/memory export [path]                            export JSON
/memory import <path>                            import JSON (deduplicated by fingerprint; every field is validated, numbers are clamped, `pinned` is forced off and the origin is downgraded to `observed`)
/memory clear --all --yes                        permanently clear everything (`--all` is mutually exclusive with the filters below)
/memory clear --kind=<kind> --scope=<level> --yes   clear a subset; conditions combine with AND and values are validated against the enums
/memory consolidate                              consolidate right now
/memory stats                                    runtime observability: counts, writes, render time
/memory help
```

## Model tools

| Tool | Purpose |
|---|---|
| `memory_write` | Structured write (`kind` + `text`, optional `subject` / `field` / `value` / `scopeLevel`; with `kind='agent_self'` also an optional `facet: 'persona' \| 'work'`). **The origin is decided by the plugin — the model cannot claim "the user asked for this"** |
| `memory_recall` | Search by query / kind / scope / tag |
| `memory_list` | List in deterministic order |
| `memory_forget` | Delete by id; deleting by query needs `confirm: true` (stricter preview threshold) |
| `memory_maintain` | Trigger consolidation manually (merge / invalidate / archive / summarize) |
| `memory_stats` | Runtime observability: row counts, write/reject counters, injected lines, render time |
| `memory_explain` | Diagnose which signal a text hits, which rule excludes it, and what would be written (self-portrait rows also show `facet` and `supersededBy`) |

## Configuration

Set `config` on the patch row; the full default set lives in `DEFAULTS` in `src/lib.ts`. The 20 fields exposed in
the settings form:

| Field | Default | Meaning |
|---|---|---|
| `domainName` | `dsh_memory` | Store name (also the on-disk directory) |
| `maxInjectedTokens` | `300` | Hard token cap for resident injection |
| `maxItemTokens` | `60` | Truncation length for one injected memory |
| `selfPortraitMaxTokens` | `120` | Budget shared by the two work subsections |
| `selfPortraitEnabled` | `true` | Switch for resident self-portrait injection (persona + work); in the form `0` = off, `1` = on |
| `selfPersonaMaxTokens` | `80` | Separate budget for the persona subsection |
| `selfPortraitMergeThreshold` | `0.6` | Similarity at or above which a new insight is merged into the existing row (below it the old row is archived and superseded) |
| `selfReflectEnabled` | `true` | Low-frequency reflection prompt switch; in the form `0` = off, `1` = on |
| `selfReflectEveryTurns` | `12` | Minimum turns between two reflection prompts |
| `selfReflectMinTurn` | `4` | Earliest session turn (too early means nothing to reflect on) |
| `selfReflectMaxPerSession` | `3` | Maximum reflection prompts per session |
| `selfIntroEnabled` | `true` | First-run naming channel (the one-off "how do we address each other" prompt); in the form `0` = off, `1` = on |
| `selfIntroMinTurn` | `2` | Earliest session turn for the naming question (no interrogation on turn 1) |
| `selfIntroMaxAsks` | `2` | Naming questions allowed **across sessions**, cumulatively; once used up it never asks again |
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

Written in TypeScript, built with `tsc`, managed with pnpm. The dev tools are TypeScript too — Node 22.6+ (24 by
default) strips types natively, so `node tools/<name>.ts` runs them without a build step.

```sh
pnpm install                                      # devDependencies: typescript, @types/node, schemastery types
pnpm build                                        # src/*.ts -> lib/*.js (+ the client half's lazy-CJS wrapper)
pnpm test                                         # builds, then runs the unit tests on the built output
pnpm typecheck                                    # host half, client half and tools — no emit
node tools/eval-recall.ts                         # offline recall eval over real session logs
node tools/bench.ts                               # hot-path benchmark (per-turn recall, per-step render, consolidation)
node tools/deploy-dev.ts                          # mount lib/ as a new dev revision (run pnpm build first)
node tools/deploy-dev.ts --set "recallMode='dry';maxInjectedTokens=200"
node tools/extract-asar.ts                        # extract DSH client bundles (UI debugging)
node tools/scan-asar.ts settingsNumberField       # find where a symbol lives in app.asar
```

Layout:

| Path | Role |
|---|---|
| `src/index.ts` | Host half: storage, capture, injection, consolidation, tools, commands |
| `src/lib.ts` | Pure functions (no `ctx`) — the entire unit-test surface |
| `src/client.ts` | Browser half: the settings form (compiled to CommonJS, then wrapped) |
| `src/types.ts`, `src/shims.d.ts` | Domain types plus the DSH seam subset this plugin relies on |
| `lib/` | Build output — **committed on purpose** (see below), shipped in the package (`files`) |
| `tools/build-client.ts` | Wraps the compiled client into `window.__ModuleLoader__.load({ id, factory })` |
| `tools/deploy-dev.ts` | Copies `lib/` into a fresh dev revision and rewrites the profile patch |

Why the build output is committed: `dsh plugin add github:<owner>/<repo>` fetches **source, not artifacts** and
runs no build script. If `lib/` were gitignored, a GitHub install would end up with a `main` pointing at a file that
does not exist. Committing it keeps the install a no-op — no build step, and no `allowBuilds` authorization for a
`prepare` script that would otherwise execute code on the user's machine.

Three development notes that cost real debugging time and are worth knowing:

- DSH resolves configuration from the profile patch, and a plugin row may need to be **locatable in that file** for
  the settings service to project its form — a bundle-layer-only row may not appear.
- `deploy-dev.ts` never reuses a revision number, because Node's ESM cache is keyed by resolved path: reusing a
  path hands you the previously cached module.
- The `@deepseek-ai/*` packages on npm are **older than the DSH you are running** — the published
  `dsh-client-ui-primitives` does not even export the settings API. Type against the empirically verified subset in
  `src/types.ts` / `src/shims.d.ts` instead of importing mismatched types.

See [`docs/dsh-mechanisms.md`](docs/dsh-mechanisms.md) for the DSH seams, slot semantics and environment facts this
plugin is built on — written for plugin authors, with no environment-specific details.

## Known limitations

- **Consolidation of compaction summaries depends on the deployment.** The code path listens to
  `compaction/summary`; a profile without a mounted compaction plugin simply never produces them.
- **Full-text session search is usually unavailable** — the session query index ships as `openAt: never`, so the
  plugin keeps its own lexical index and only uses exact reads for history back-references.
- **Retrieval is lexical** — CJK bigrams plus Latin stemming and memory-side coverage. Paraphrase-level recall
  needs vector retrieval and is future work.
- **No graphical memory browser.** The GUI exposes configuration only; browsing, deleting and pinning memories go
  through the `/memory` commands listed above and the 7 tools.
- **Two design items are explicit degradations**: (1) the self-portrait is not de-duplicated against the
  deployment's persona text, and (2) if the deployment registers a `complete` persona section that displaces other
  prompt sections, the self-portrait section disappears with it — the plugin does not silently fall back to the
  `context()` channel.
- **End-to-end gain (memory vs. full context) is not automated.** The offline eval measures the recall path itself;
  the Δ measurement is a documented manual procedure (answer a fixed question set with `recallMode: 'off'`, with
  this plugin, and with the full history pasted in, then compare accuracy and token cost).

## License

MIT — see [LICENSE](LICENSE).

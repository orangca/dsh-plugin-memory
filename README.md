# dsh-plugin-memory

Personalized long-term memory for DSH (DeepSeek Harness): local-first, automatic capture, dual-channel injection,
explainable and deletable.

[中文说明](README.zh.md) | English

- **Local** — all data lives under `$DSH_HOME/storages/<domainName>/`. The plugin makes **no network call of its own**
  and ships no embedding service or model: retrieval is lexical by default, and the optional external embedder
  described below is something **the host** injects. With nothing injected nothing leaves the machine; if the host
  injects a **remote** embedder, memory text does leave it — see
  [External embedder (optional)](#external-embedder-host-injected-and-off-by-default).
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
   accumulate too many rows. A separate cross-session pass, `/sleep`, is triggered explicitly by the user (see
   below).
4. **Score (optional)** — the host may inject an `embed` function into the service surface (§3.6 of the protocol).
   That is what makes `recall({ mode })` able to rank by embedding similarity, and it is **off by default**: with no
   embedder registered, `recall({ mode: 'semantic' | 'hybrid' })` **falls back to lexical** and says so through
   `lastRecall()`. See [External embedder (optional)](#external-embedder-host-injected-and-off-by-default).

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
  /memory self set persona 我重视把事实和推测分开说。           # -> self.persona.general (the name/address keys are optional)
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
/memory admin verify <id prefix>         walk back to the cited events and check where this memory came from (read-only)
```

## `/sleep`: idle review

`/memory admin consolidate` only does **governance inside the store** (merge / invalidate / archive / summarize).
`/sleep` is an **independent command** (not a `/memory` subcommand) that works **across the store and across
sessions**: it replays the **complete event logs** of the most recent sessions through the memory pipeline to pick
up what was missed at the time, then reorders the whole store.

```
/sleep [--sessions=N] [--all] [--apply]
```

- **Preview by default**: read-only, compute-only. It prints a plan of what it *would* do — how many rows to
  backfill, how many groups to merge, how many rows to invalidate, how many to archive, which project gists to
  recompute. **It writes nothing.**
- **Only `--apply` writes**, and its first step is an **automatic backup** (a `sleep-backup-<ISO timestamp>.json` in
  the export directory, reusing the `/memory admin export` implementation): if the backup fails, the run stops. There
  is no "write first, back up later".
- `--sessions=N` reviews the last N sessions (default `sleepSessions`, capped at 20). Without `--all` the list is
  filtered by the cwd of the current / most recent session, so another project's business does not leak in.
- Session logs are read through the host's `sessionQuery` service. Where that service is unavailable, the command
  says so and points out that `/memory admin consolidate` still works.
- **Real user messages only**: only messages whose `source.kind === 'user'` count — context the plugin injected
  itself does not (self-reinforcement guard) — and `origin: 'subagent'` sessions are skipped by default.
- Every budget that is hit (per-session `sleepMaxCharsPerSession`, total `sleepMaxCharsTotal`, backfill
  `sleepMaxBackfill`) is reported in the plan's notes.

**Three lines it does not cross:**

- **It backfills only what you explicitly asked to remember.** It runs the same rule extraction as automatic
  capture, so small talk that hits no explicit imperative never becomes a memory, and candidates whose fingerprint
  is already in the store are skipped — running it again does not re-add rows.
- **It does not touch the self-portrait.** Persona and work tendencies are the model's cognition about itself, and
  the rules do not draw conclusions on its behalf: `/sleep` produces no `agent_self` write at all.
- **It does not touch user-owned rows.** Merges never touch `pinned`, and conflict detection never marks a row you
  set or confirmed as invalid — those are skipped and flagged in the plan's notes.

With `sleepEnabled` (default `true`) off, the command only explains that it is disabled and does nothing. `/sleep`
is a maintenance action the user triggers explicitly, so it is **not** affected by `recallMode` / `autoRecall`. The
run counters and the watermark (`lastSleepAt`) are visible in `/memory stats` and `memory_stats`.

## Verifiable references: every memory can say where it came from

Each memory records its **source**: which session, and which event-sequence range.

- **Free to collect**: the sequence numbers come from the `session/event` callback we already subscribe to — no
  extra reads, no extra model calls.
- **Every write path is covered**: turn-end capture stores the `turnStart..last` range; model tools, user commands
  and compaction solidification store the single point `last`; `/sleep` backfill stores the sequence of **the user
  message it came from**. On a merge (reinforce/refine) the new reference is added to the existing row and old ones
  are kept.
- **Checkable**: `/memory admin verify <id>` walks back to the cited events and compares them with the row's text using
  informative-token coverage, printing `✅ hit (coverage x)` / `⚠️ miss` / `⚠️ session or events missing`. Read-only.
- **Visible**: `/memory admin show <id>` gains a `source:` line, and `memory_explain` exposes `refs` too.
- **Machine-readable form**: a reference is written `sessionId#from-to`, a single point is just `sessionId#from`
  (a reference with no sequence numbers is the bare `sessionId`), and several references are joined with `;` —
  `session-84a547da-5727-4ffc-adf0-26d02e749e13#120-180;session-…-…#93` (the `…-…-…` are elided id segments, not
  literal text). The **storage** form always keeps the full session id;
  the short form (`ses-84a547da#120-180`) exists only for display, and `formatRefs` does **not** shorten by default.
- **Never part of the fingerprint**: `recordHash` ignores `refs` — otherwise the same memory would count as two rows
  just because it came from somewhere else, breaking deduplication and idempotency. Rows written before 0.5.9 have no
  references; every read path tolerates that (`/memory admin verify` says so explicitly).

`refsEnabled` (default `true`) turns collection off for new rows (existing references stay); `refsMax` (default `5`)
caps how many references one row keeps.

## Write approval gate (`writePolicy`): the model proposes, you decide

`memory_write` rows are **the model's own proposals**. By default they take effect immediately (the 0.5.9
behaviour); to separate "the model proposed it" from "you settled it", set `writePolicy` to `ask` or `off`:

| `writePolicy` | Model-origin writes | Every other origin (rule capture / user commands / `/sleep` / import) |
|---|---|---|
| `auto` (**default**) | applied immediately (= current behaviour) | applied immediately |
| `ask` | queued for confirmation (`status: 'pending'`) until you approve | applied immediately |
| `off` | rejected outright with a readable reason | applied immediately |

- **The default `auto` changes nothing**: after upgrading you should notice no difference — model writes still
  take effect immediately and never enter the queue.
- **Only rows the model proposed are gated.** Rule capture (`observed`), explicit user asks (`user_explicit`)
  and user corrections (`user_correction`) are **never** gated: they are your own words, and queuing them would
  only drown them.
- **The model cannot approve itself.** No model tool can change a `pending` status; only your `/memory admin approve`
  can.

Using the pending queue (0.5.27 collects these under `admin`; the old spellings still work):

```
/memory admin pending                     list pending writes (id · kind/facet · origin · time · refs · text preview)
/memory admin approve <id prefix>         approve → takes effect immediately (a self-portrait row converges at this point)
/memory admin reject-pending <id prefix>  reject → set to invalid (kept for audit, never physically deleted)
```

- **Pending never enters context.** The resident block (R1), per-turn recall (R2), the self-portrait, project
  gists, search and consolidation never see it — an unapproved model guess reaching the system prompt is this
  feature's worst failure mode, and every read path is pinned by a test. Only two windows show it on purpose:
  `/memory admin pending` and the diagnostic output of `memory_explain`.
- **Bounded and honest.** `pendingMax` (default `50`) caps the queue. When it is full, a new write is **rejected
  with a structured error** — never silently dropped, never auto-compacted; process a few rows through
  `/memory admin pending` first. `0` = unlimited.
- **Approval does not bypass the safety gate.** In `ask` mode sensitive content is still rejected *before* the row
  is queued; the queue is not a masking back door.
- **Rejection leaves a trace.** `reject-pending` sets `invalid` rather than deleting, so audit and
  `/memory admin verify` can still see that the row existed.
- Pending rows are persisted like any other row (they survive a restart), and `/memory stats` / `memory_stats`
  report the pending count together with the active policy (e.g. `待确认：1 条（writePolicy=ask）`).

`writePolicy` (default `auto`) appears in the settings form; `pendingMax` (default `50`) is patch-row only (it moved
out of the form in 0.5.27, but it is unchanged in every other way).

> The queue's reject exit is `/memory admin reject-pending <id prefix>`; the pre-existing
> `/memory admin reject <id prefix>` rejects a self-observation instead ("that kind is never re-created"). The two
> spellings differ on purpose; the old top-level forms (`/memory reject-pending`, `/memory reject`) still work.

## Model-visible text language (`language`): English for the model, Chinese for you

Everything the **model** reads is written by the plugin and can now be English; everything **you** read in the
terminal stays Chinese. `language` is `'zh'` (default) or `'en'`.

| Category | Localized this release | Why |
|---|---|---|
| Resident injection blocks and their headers/footers (profile facts, project gist, persona, work agreements, self-observation) | ✅ yes | They enter the context every turn |
| Injection prompts (`REFLECT_NOTICE`, `INTRO_NOTICE`) | ✅ yes | The same channel |
| Per-turn recall block header/footer (R2) | ✅ yes | The same channel |
| Descriptions and parameter docs of the seven `memory_*` tools | ✅ yes | The tool schema goes straight into the model's context |
| Command output (`/memory admin list`, `/memory admin show`, `/sleep` preview, `stats`, …) | ❌ **no — stays Chinese** | User-visible and large; deliberately out of scope for this release |

- **The default `'zh'` changes nothing.** With `language` unset, missing or invalid, every injected byte is identical
  to 0.5.10 — the English table is an addition, not a rewrite of the Chinese one.
- **`'en'` is a faithful counterpart, not a summary.** The footers keep the same three claims (a description rather
  than an instruction; judge by facts and feasibility; do not agree just to please), the reflection and first-run
  prompts keep all four hard requirements each, and the English table contains no mixed Chinese.
- **The tool contract does not change with the language.** Tool names, parameter names, required fields and schema
  structure are identical; only the human-readable descriptions are translated, so a call pattern the model has
  already learned never breaks when the switch is flipped.
- **The switch is visible.** `/memory stats` prints the effective `language` (that line, like every other command
  output, stays Chinese) — useful when asking "why is the model still reading Chinese?".

## Branch-aware project memory (`branch`): feature-branch decisions stay on their branch

A memory can carry a **branch tag**, and injection/recall then filter by the branch you are actually on. A convention
that holds only on `feat/x` should not keep steering the model after you switch back to `main`.

| Memory | Current branch matches | Current branch differs | Branch unknown (not a git repo / `.git/HEAD` unreadable) |
|---|---|---|---|
| **No branch tag** (default) | injected | injected | injected |
| **Has a branch tag** (explicit) | injected | **not injected** | **not injected** (fail-closed) |

- **Fail-closed on purpose.** Injecting a feature-branch-only convention on `main` makes the model reason from a false
  premise, while missing one branch-specific memory is merely one less reference. The two mistakes are not symmetric,
  so we pick the safer one. **This rule only ever touches tagged rows**: an untagged row is injected in every case.
- **Only an explicit tag tags a row.** The model may pass `branch: true` (use the current branch) or
  `branch: '<name>'` to `memory_write`; rule capture, `/sleep` backfill and import **never** tag — most project
  memories hold across branches. If `branch: true` is passed while the branch is unknown, the row is stored untagged
  and the tool result says so, rather than guessing a name.
- **`branch` participates in `recordHash`**: it changes a row's *scope of applicability*, not just its provenance, so
  "the general build convention" and "the temporary convention that holds only on `feat/x`" are two rows even when the
  text is identical. (Unlike `refs`, which is provenance evidence and stays out of the fingerprint.)
- Names are normalized: trimmed, a leading `refs/heads/` is dropped and the name is capped at 100 characters; an
  illegal name (empty or containing control characters) is treated as **no tag**.
- **Visible and debuggable.** `/memory admin branch` prints the current branch, how many tagged rows exist and the
  groups; `/memory admin branch --all` also lists rows tagged for other branches. `/memory stats` and `memory_stats`
  carry a `分支：…（branchAware=…）` line, and `memory_explain` shows a row that branch filtering blocked and why.
- **Zero shell.** The plugin only reads `.git/HEAD` (and a `.git` *file*'s `gitdir:` pointer for
  worktrees/submodules), with a short 5-second cache. It **never runs a git command**; anything it cannot read is
  simply "branch unknown".
- **The default is a no-op.** `branchAware` defaults to `true`, but no existing row is tagged, so resident injection,
  per-turn recall, listing and search are **byte-for-byte identical** to 0.5.12. Turning `branchAware` off ignores
  tags altogether: every row is injected again.

`branchAware` (default `true`) appears in the settings form as a `0` / `1` toggle.

## External embedder (optional): host-injected, and off by default

The plugin **does not ship a model and does not go online**. Semantic ranking is possible only because the host may
**inject an `embed` function** into the service surface (protocol v1.3, `ctx.memory.setEmbedder`, contract
`docs/embedder.md`, protocol §3.6/§11). With nothing injected, retrieval is the same lexical path as 0.5.19 —
**byte for byte, and with zero embedding calls**.

Registering one (host-side code, e.g. another plugin's `apply()` or a small adapter):

```ts
/** A host-side embedder: the plugin only calls this function; it never calls the network itself. */
const embedder = {
  id: 'local-minilm',                                     // non-empty; shown in stats and diagnostics
  dimensions: 384,                                        // optional: enables a fast check
  async embed(texts: readonly string[]): Promise<number[][]> { return await myLocalModel(texts) },
}

const memory = ctx.get('memory') as {
  setEmbedder?: (embedder: typeof embedder | null) => { ok: boolean; id?: string | null; error?: string }
} | undefined
if (memory?.setEmbedder) {                                 // absent on a '1.2' service — feature-detect first
  const result = memory.setEmbedder(embedder)
  if (!result.ok) console.warn('embedder rejected:', result.error)
}
```

What changes once one is registered:

| Key | Default | Meaning |
|---|---|---|
| `embedderRecallMode` | `'off'` | whether **per-turn** recall ranks with hybrid scoring (needs a registered embedder; `'recall'` turns it on) |
| `embedderWeight` | `0.5` | semantic weight in hybrid mode, `score = (1 - w) * lexical + w * semantic` (0…1; an invalid value falls back to the default) |
| `embedderTimeoutMs` | `200` | timeout for one embedding call; a timeout counts as a failure and falls back to lexical |
| `embedderCacheMax` | `2000` | vector cache capacity (LRU; `0` = no cache) |

- **Off by default, and quiet about it.** The four keys are all patch-row (advanced tuning); `'off'` means per-turn
  recall never looks at the embedder, so upgrade behaviour is identical to 0.5.19. `recall({ mode: 'lexical' })`,
  which is the default, also makes **zero** embedding calls and returns exactly what 0.5.19 returned.
- **Explicit modes.** `recall({ mode: 'semantic' })` orders by embedding similarity; `'hybrid'` blends lexical and
  semantic with `embedderWeight`. `capabilities()` answers "is an embedder registered" and `stats().embedder` shows
  `calls` / `errors` / `hits` / `misses` / `timeouts` — check rather than guess. **The same call has two possible
  shapes**: with nothing registered (or with `'lexical'`) it returns the array synchronously, and once a registered
  embedder is really going to be called it returns a Promise — so `await` it, which is safe for both.
- **A failure falls back to lexical, and `lastRecall()` says so.** An embedder that throws, rejects, times out or
  returns a wrong shape or mismatched dimensions is counted as an error and the call falls back to lexical scoring:
  the recall never rejects, no memory is lost and no turn fails. `lastRecall()` reports the requested `mode`,
  whether the embedder was actually used (`used`), the fallback reason (`'no-embedder'` / `'embed-error'` /
  `'timeout'` / `null`) and how many candidates and vectors were involved — so you are never told "semantic" when
  what you got was lexical.
- **The plugin is not the one making the privacy call.** The plugin **itself never goes online and never ships or
  runs a model of its own**; it only calls the `embed` function the host injected. **That function is what memory
  text is handed to** — the plugin passes the record text to `embedder.embed(...)`, so where that text ends up is a
  property of the embedder, not of the plugin. Whether memory text is sent to an external service, **where** it is
  sent, and whether any of it is logged is **decided by the host and the user** — the plugin does not make that
  decision and cannot make it on their behalf. If you do not inject an embedder, nothing is sent anywhere; if you
  inject an embedder that calls a remote API (for example one whose `id` reads
  `openai:text-embedding-3-small`), **memory bodies leave the machine**.

## `/memory admin audit`: write audit and injection verification

Not every write leaves a row behind: a **rejected** write leaves nothing at all, so "why is this not in memory?" had
no answer. `/memory admin audit` shows both views side by side without keeping a second copy of the truth:

| Source | Covers | Persistence |
|---|---|---|
| **Derived from the records** (`observedAt` / `origin` / `refs.via` / `status` / `invalidAt` / `supersededBy`) | successful writes, merges, invalidations, archives, pending rows | **naturally persistent** — it is the store itself, so it survives a restart |
| **In-memory attempt ring** (new, bounded) | attempts that never landed: rejected writes (sensitive / echo / write policy / queue full), queued, approved, rejected-pending | **process-local** — cleared on restart, and the output says so |

That is why the audit adds **no storage**: successful write events are derived from the rows, and only the "attempts"
view — including everything that was rejected — lives in the bounded ring.

```
/memory admin audit [--limit N] [--verify]
```

- **`--limit N`** shows at most `N` recent attempts (default `20`, capped at `200`; `--limit=N` is accepted too, and a
  missing or non-positive value falls back to the default). Unknown arguments are ignored, as in every other
  subcommand.
- **`--verify`** checks **this session's own injection** against the session log: every line recorded in the injected
  snapshot is compared with the session events with a literal `includes` test. **Verbatim means verbatim** — no token
  similarity, no fuzzy matching; the output reports `checked` / `matched` / `missing` and one sample line that did not
  match.
- **A gap is stated, never hidden.** Without a `sessionQuery` service, with an unknown session id, when the log cannot
  be read, or when the log contains no `user/message` event at all, the command says that it **cannot verify, and
  why**. With no `--verify` at all it says that no check was run. "Not checked" is never rendered as "checked and
  consistent" — otherwise "the model can see it ⟺ it was recorded" would mean nothing.
- **Read-only, and it never gets in the way.** `/memory admin audit` and `--verify` modify no record, no state and no
  counter — reading the audit does not push an audit event of its own (otherwise one `--verify` would change the next
  one's input). Every push, render and comparison runs inside `try/catch`: an audit failure never blocks a write or an
  injection.
- `auditMax` (default `50`) caps the ring; `0` = record no attempts (the command still works and still shows the
  store-derived summary). `/memory stats` and `memory_stats` carry a one-line summary (recent attempts · store rows ·
  verification misses); the detail is here.

`auditMax` (default `50`) is patch-row only (it left the settings form in 0.5.27; the default and the behaviour are
unchanged).

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

To erase the store, use `/memory admin clear --all --yes` or delete `$DSH_HOME/storages/<domainName>/`.

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

The plugin exports a schemastery `Config` whose fields are all declared `volatile()` (hot-applied when edited). The
form shows **8 fields** — `domainName`, `captureMode`, `recallMode`, `writePolicy`, `language`,
`selfPortraitEnabled`, `branchAware`, `sleepEnabled` — in 4 groups, and **the other 22 keys are patch-row only**:
they are still just as usable and still hot-apply, they are simply not rendered (the schema is unchanged: all 30 keys
stay `volatile()`, so a patch-row edit takes effect without a restart, exactly as before). The 22 are
`maxInjectedTokens`, `maxItemTokens`, `recallTopK`, `captureMaxPerTurn`, `consolidateEnabled`,
`consolidateIntervalMinutes`, `selfPortraitMaxTokens`, `selfPersonaMaxTokens`, `selfPortraitMergeThreshold`,
`selfReflectEnabled`, `selfReflectEveryTurns`, `selfReflectMinTurn`, `selfReflectMaxPerSession`, `selfIntroEnabled`,
`selfIntroMinTurn`, `selfIntroMaxAsks`, `sleepSessions`, `sleepMaxBackfill`, `refsEnabled`, `refsMax`, `pendingMax`,
`auditMax` — all of them are listed with their defaults and meanings in [Configuration](#configuration) below. It
ships a small browser half (`src/client.ts`, built to `lib/client.js`) that renders those 8 fields as a form. Find it
under **Plugins → `dsh-plugin-memory` → row `dsh-memory`** (the list card also shows a one-line summary).

Under the hood the client half registers into the keyed `plugins.row.config` slot with
`key: 'dsh-plugin-memory#dsh-memory'`, using DSH's shared `SettingsFormModel` / `SettingsForm`. Saving validates the
whole Config through the settings service and persists it into the profile patch — no restart needed.

## Commands

Daily use is these 6 commands (0.5.27; `/memory help` lists the same set). Every other subcommand is still there —
it just lives under `/memory admin <subcommand>`:

```
/memory                                          overview: store name, row count, pending count, a one-line self-portrait summary and the language
/memory search <query>                           lexical search (includes archived, never invalid)
/memory forget <id prefix>                       permanently delete one memory
/memory self [set|history|reset]                 self-portrait: view / set directly (naming keys included) / revision chain / archive
/memory help                                     list these commands plus the `/memory admin` line
/sleep [--sessions=N] [--all] [--apply]          idle review (independent command, not a /memory subcommand): preview only by default; --apply backs up first
```

- `/memory` with **no argument is the overview** (store name, row count, pending count, self-portrait, language) and
  points at the commands above.
- `/memory admin <subcommand>` holds the 20 governance and diagnostic subcommands: `list`, `show`, `stats`,
  `pending`, `approve`, `reject-pending`, `export`, `import`, `clear`, `consolidate`, `branch`, `trace`, `verify`,
  `audit`, `pin`, `archive`, `restore`, `confirm`, `reject`, `refresh`. `/memory admin` with no subcommand lists them
  all with a one-line description each, and **every parameter keeps exactly its old semantics** (for example
  `audit --verify`, `branch --all`, `trace <prefix>#<seq>`).
- The old spellings are **unchanged in behaviour** (`/memory pending`, `/memory approve <id>`, `/memory trace …`,
  `/memory audit --verify`, …) — they are simply no longer listed anywhere. Nothing was removed.

## Model tools

| Tool | Purpose |
|---|---|
| `memory_write` | Structured write (`kind` + `text`, optional `subject` / `field` / `value` / `scopeLevel`; with `kind='agent_self'` also an optional `facet: 'persona' \| 'work'`; and an optional `branch`: `true` = the current git branch, a string = that branch, omitted = no tag, which applies on every branch). **The origin is decided by the plugin — the model cannot claim "the user asked for this"** |
| `memory_recall` | Search by query / kind / scope / tag; each hit carries `refs` (session + event range), so the model can cite or re-check where a memory came from |
| `memory_list` | List in deterministic order (same `refs` field) |
| `memory_forget` | Delete by id; deleting by query needs `confirm: true` (stricter preview threshold) |
| `memory_maintain` | Trigger consolidation manually (merge / invalidate / archive / summarize) |
| `memory_stats` | Runtime observability: row counts, write/reject counters, injected lines, render time |
| `memory_explain` | Diagnose which signal a text hits, which rule excludes it, and what would be written (self-portrait rows also show `facet` and `supersededBy`) |

## Configuration

Set `config` on the patch row; the full default set lives in `DEFAULTS` in `src/lib.ts`. The **8 fields** exposed in
the settings form (in form order) are `domainName`, `captureMode`, `recallMode`, `writePolicy`, `language`,
`selfPortraitEnabled`, `branchAware` and `sleepEnabled`. The table lists all 30 `volatile` keys: those 8 save from
the form, and the other 22 go through the patch row (same defaults, same hot-apply semantics).

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
| `sleepEnabled` | `true` | Idle review (`/sleep`) switch; in the form `0` = off, `1` = on. When off, the command only explains itself and does nothing |
| `sleepSessions` | `3` | Sessions reviewed by default when `--sessions=N` is omitted (capped at 20) |
| `sleepMaxBackfill` | `20` | Maximum rows one `/sleep --apply` may backfill (only things you explicitly asked to remember) |
| `refsEnabled` | `true` | Record where each memory came from (session + event seq range); in the form `0` = off, `1` = on. Off only affects new rows |
| `refsMax` | `5` | How many source references one row keeps (newest first — that order is the **writer's** convention, kept as given); `0` = none, `Infinity` = unlimited |
| `writePolicy` | `auto` | Approval gate for model-origin writes: `auto` (apply immediately, default) / `ask` (queue for confirmation) / `off` (reject outright); rule capture, user commands and `/sleep` are never gated |
| `pendingMax` | `50` | Cap for the pending queue; when full a new write is rejected with a structured error, never silently dropped; `0` = unlimited |
| `language` | `zh` | Language of the **model-visible** text (`zh` / `en`): injection blocks and their headers/footers, injection prompts, the per-turn recall block and the tool descriptions. Command output stays Chinese either way; the default `zh` is byte-for-byte identical to 0.5.10 |
| `branchAware` | `true` | Filter branch-tagged rows by the current git branch; in the form `0` = off, `1` = on. Off ignores tags entirely; the default `true` is byte-for-byte identical to 0.5.12 because no existing row is tagged |
| `auditMax` | `50` | Capacity of the **in-memory audit attempt ring**: it records only attempts that never landed (rejected / queued / approved / rejected-pending). Successful write events are derived from the records themselves, so the audit adds no storage; `0` = record nothing (the command still works); the ring is cleared on restart |

Additional knobs available only through the patch row (with their defaults): `maxItemTokens` neighbours such as
`selfPortraitMaxItems` 12 / `selfPortraitMaxSelfObserved` 4, capture tuning (`capturePerHour` 20,
`captureMinConfidence` 0.6, `echoThreshold` 0.9, `gistMinMarkers` 2), **retrieval quality** (`searchStemming` true,
`searchBigram` true, `searchLengthPenalty` 0.3 — English stemming / Chinese bigrams / length normalisation),
self-portrait admission
(`selfPortraitPromoteSessions` 2, `selfPortraitModelMinConfidence` 0.85), consolidation
(`mergeSimilarity` 0.7, `archiveAfterDays` 180, `archiveBelowImportance` 0.15, `summarizeAbove` 5),
recall detail (`recallMinQueryChars` 12, `recallMinHits` 2, `recallMinMatch` 0.4, `recallCooldownTurns` 3,
`recallBudgetMs` 10), privacy (`piiPolicy` `mask`), `repeatMentionBoost` 0.1, `reportPath` (optional JSON
self-report for development) and `seed` (dev-only demo data, **off** by default).

`/sleep`'s remaining knobs are not in the form either and go through the patch row (with their defaults):
per-session character budget `sleepMaxCharsPerSession` 120000, total character budget `sleepMaxCharsTotal`
300000, assistant texts kept ahead of each user message `sleepAssistantContext` 3 (used for echo detection), and
the maximum number of project gists recomputed `sleepMaxGists` 8.

The optional external embedder's four keys (`embedderRecallMode` `off`, `embedderWeight` 0.5,
`embedderTimeoutMs` 200, `embedderCacheMax` 2000) are also patch-row only, and are described in
[External embedder (optional)](#external-embedder-host-injected-and-off-by-default).

## Data and privacy

```
$DSH_HOME/storages/dsh_memory/
├── global.json            # watermark: schema version, collectionVersion, last consolidation time
└── memories/<id>.json     # one file per memory, shaped { version, record }
```

- The storage root is **home-level**: every profile on the machine shares one store by default, which is usually
  what you want for personal memory.
- Nothing leaves the machine unless the host hands it out. There is no telemetry, and no embedding service of its
  own: retrieval is lexical unless **you** inject an external embedder through `ctx.memory.setEmbedder`, and that is
  optional, off by default and entirely the host's decision to make. Be explicit about the consequence: the plugin
  gives **memory text** (the record bodies it ranks) to `embedder.embed(...)`, so an embedder that talks to a remote
  service **sends memory text off the machine** — pick a local embedder if that matters, and check what the injected
  one does before registering it (see
  [External embedder (optional)](#external-embedder-host-injected-and-off-by-default)).
- Sensitive content is rejected before it reaches a file; PII is masked. Both behaviours are covered by tests.
- DSH does not migrate domain versions automatically: bumping `version` requires declaring `compatibleVersions`.

## Development

Written in TypeScript, built with `tsc`, managed with pnpm. The dev tools are TypeScript too — Node 22.6+ (24 by
default) strips types natively, so `node tools/<name>.ts` runs them without a build step.

```sh
pnpm install                                      # devDependencies: typescript, @types/node, schemastery types, oxlint
pnpm build                                        # src/*.ts -> lib/*.js (+ the client half's lazy-CJS wrapper)
pnpm test                                         # builds, runs the unit tests on the built output, then checks the READMEs agree
pnpm typecheck                                    # host half, client half, tools and tests — no emit
pnpm lint                                         # oxlint (correctness rules only)
pnpm check:readmes                                # README zh/en consistency on its own (names the drifting item)
pnpm verify:self-contained                        # assert zero runtime deps + a complete package (what `dsh plugin add` needs)
pnpm coverage                                     # collect coverage (the node_modules exclusion must be explicit, or lib/ is dropped)
pnpm coverage:check                               # enforce the gate (thresholds differ per input mode, see tools/coverage-check.ts)
pnpm mutate                                       # mutation check (deterministic sample of 8, zero deps): break the impl in a scratch copy, see what the suite misses
pnpm mutate:full                                  # same, over the whole 92-entry catalogue (~6 min) — the pre-release run
pnpm mutate:ci                                    # the sampled 8-mutation run CI uses (~20 s), machine-readable (--json)
node tools/eval-recall.ts                         # offline recall eval over real session logs
node tools/bench.ts                               # hot-path benchmark (per-turn recall, per-step render, consolidation)
node tools/deploy-dev.ts                          # mount lib/ as a new dev revision (run pnpm build first)
node tools/deploy-dev.ts --set "recallMode='dry';maxInjectedTokens=200"
node tools/extract-asar.ts                        # extract DSH client bundles (UI debugging)
node tools/scan-asar.ts settingsNumberField       # find where a symbol lives in app.asar
```

The mutation check is a standing tool, not a release gate: it rewrites one plausible-looking detail at a time in a
**scratch copy** (your `src/`, `lib/` and `tests/` are never touched), rebuilds, runs the whole suite and reports what
survived. Exit code `0` = every break was caught, `1` = a survivor (a blind spot), `2` = an environment problem.
`pnpm mutate --only <id>` re-checks one entry, `--keep` preserves the copy, `--seed <n>` makes the sample
reproducible.

Layout:

| Path | Role |
|---|---|
| `src/index.ts` | Host half: storage, capture, injection, consolidation, tools, commands |
| `src/lib.ts` | Pure functions (no `ctx`) — the entire unit-test surface |
| `src/client.ts` | Browser half: the settings form (compiled to CommonJS, then wrapped) |
| `src/types.ts`, `src/shims.d.ts` | Domain types plus the DSH seam subset this plugin relies on |
| `lib/` | Build output — **committed on purpose** (see below), shipped in the package (`files`) |
| `tools/build-client.ts` | Wraps the compiled client into `window.__ModuleLoader__.load({ id, factory })` |
| `tools/check-readmes.ts` | Structural zh/en check for the two READMEs: section count and shared-anchor order, code fences, table first-column keys, form field count, the `/memory` + `/sleep` command set, and the mutual top links |
| `tools/deploy-dev.ts` | Copies `lib/` into a fresh dev revision and rewrites the profile patch |
| `tools/session-log.ts` | Shared reader for session logs: DSH appends **one zstd frame per JSONL line**, so decoding must walk the zstd magic — a single-frame decode returns only the header |
| `tools/mutate.ts` | The mutation-check catalogue and runner behind `pnpm mutate` / `:full` / `:ci` (zero deps; runs in a scratch copy) |

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

A one-page **delivery overview** — capabilities with the version each landed in, the architecture diagram, the
protocol summary, the engineering gates, the quality evidence and the known limitations — is in
[`docs/delivery.md`](docs/delivery.md) (written in Chinese).

See [`docs/dsh-mechanisms.md`](docs/dsh-mechanisms.md) for the DSH seams, slot semantics and environment facts this
plugin is built on — written for plugin authors, with no environment-specific details.

## Known limitations

- **Consolidation of compaction summaries depends on the deployment.** The code path listens to
  `compaction/summary`; a profile without a mounted compaction plugin simply never produces them.
- **Full-text session search is usually unavailable** — the session query index ships as `openAt: never`, so the
  plugin keeps its own lexical index and only uses exact reads for history back-references.
- **Retrieval is lexical by default** — CJK bigrams plus Latin stemming and memory-side coverage. Vector retrieval
  is an **opt-in**: inject an `embed` function through the service surface and per-turn recall can rank with hybrid
  scoring ([External embedder (optional)](#external-embedder-host-injected-and-off-by-default)). The plugin still
  ships no model and calls no network itself, and with nothing injected recall stays lexical.
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

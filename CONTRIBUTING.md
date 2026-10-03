# Contributing

Thanks for taking a look. This is a small, dependency-light plugin; the bar for a change is: **tests and typecheck
stay green, the build output stays in sync, and both READMEs stay true.**

## Setup

```sh
pnpm install          # devDependencies only (typescript, @types/node, schemastery types)
pnpm build            # src/*.ts -> lib/*.js (+ the client half's lazy-CJS wrapper)
pnpm test             # builds, then runs the unit tests on the built output
pnpm typecheck        # host half, client half and tools
```

Node ≥ 22.18 runs the `.ts` sources directly (native type stripping); earlier 22.x needs
`--experimental-strip-types`.

## Ground rules

1. **`lib/` is committed on purpose.** `dsh plugin add github:<owner>/<repo>` fetches source and runs no build
   script, so a gitignored `lib/` would ship a `main` pointing at nothing. Run `pnpm build` and include the rebuilt
   output in the same commit — CI verifies this with `pnpm build && git diff --exit-code -- lib`.
2. **Keep both READMEs in step.** `README.md` (English) and `README.zh.md` are parallel documents; a change to one
   belongs in the other.
3. **Version numbers advance by one patch** (`0.5.0 → 0.5.1`). Docs-only commits do not bump; a release with a fix
   or feature does.
4. **Sensitive data never lands on disk.** New storage paths must run through `scanSensitive` / `maskPii`, and new
   rendering paths must go through `clampText` (which flattens to one line — see below).
5. **Rendering and tool paths must never throw.** The plugin renders on every step and runs capture at turn end;
   an exception there would break the user's turn. Wrap new work accordingly and record failures in state.

## Things that cost real debugging time

- **Never reuse a development revision path.** Node's ESM cache is keyed by resolved real path, and DSH does not
  cache-bust third-party code — reusing `dev/revN` hands you the previously loaded module. `tools/deploy-dev.ts`
  keeps a monotonic counter for exactly this reason.
- **The `@deepseek-ai/*` packages on npm are older than the DSH you are running.** The published
  `dsh-client-ui-primitives`, for example, does not export the settings API this plugin uses. Type against the
  empirically verified subset in `src/types.ts` / `src/shims.d.ts` instead of importing packaged types.
- **A plugin row must be locatable in the profile patch** for the settings service to project its form; a
  bundle-layer-only row may not appear. See `docs/dsh-mechanisms.md` for the whole list of seam notes.
- **One memory = one line.** Stored text can contain newlines (model writes, imports, compaction summaries), and an
  injected block is header + `- …` lines + footer. `clampText` flattens and strips control/zero-width characters so
  text cannot forge structure.

## Consuming the `ctx.memory` seam

Other plugins may depend on the host half's `memory` service. That surface is frozen as **protocol v1**:
[`docs/protocol-v1.md`](docs/protocol-v1.md) (English) and [`docs/protocol-v1.zh.md`](docs/protocol-v1.zh.md)
(Chinese, section by section). Read §2 before using it: the service is optional (`ctx.get('memory')` can be
`undefined`) and §8 lists the known gaps that are still awaiting a ruling. v1 is additive-only — a breaking
change bumps the protocol version and needs a CHANGELOG entry.

The conformance suite pins the documented promises against the shipped output:

```sh
pnpm build                              # tests import lib/index.js, so build first
node --test tests/protocol.test.ts      # or just list it in the test script and run pnpm test
```

`tests/protocol.test.ts` is a suite, not a duplicate of `tests/host.test.ts`: change the documented surface and
it goes red by design. When you touch the service object in `src/index.ts`, update both protocol documents and
this suite in the same change.

## Reporting bugs

Include the plugin version, the DSH build (`memory_stats` prints both the domain and the runtime counters), and a
minimal reproduction. Security issues: see [SECURITY.md](SECURITY.md).

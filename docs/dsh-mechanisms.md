# DSH mechanisms this plugin relies on

Notes for plugin authors, distilled from building `dsh-plugin-memory` against a running DSH desktop install.
Everything here was verified empirically on DSH Desktop (Electron 44 / Node 24); nothing is quoted from an
internal source tree. Environment-specific details (machine paths, session ids) are deliberately omitted.

## 1. Bundles, patch rows and peer resolution

- A distributable plugin is a **bundle**: an npm package whose `package.json` declares
  `dsh.bundle.patch` pointing at a `cordis.patch.yml` that inserts rows **by package name**:
  ```yaml
  - insert:
      - id: dsh-memory
        name: dsh-plugin-memory
        config: { domainName: dsh_memory }
  ```
- `@deepseek-ai/*` packages that must share an instance with the host belong in `peerDependencies`, not
  `dependencies`. Marking them `optional` (via `peerDependenciesMeta`) keeps installs quiet when a package is
  resolved by the running DSH rather than by pnpm.
- Resolution order, for reference: bundle patches in `dsh.profile.bundles` order → the profile's own
  `cordis.patch.yml` → the home-level patch → `--patch` overlays. A later layer replaces the **whole** `config`
  value of a row rather than deep-merging it.

## 2. `volatile()` config changes the shape the host hands you

Declaring a field `volatile()` in an exported schemastery `Config` makes it editable from the settings UI — and
makes the host deliver it as an **accessor object**, not a scalar:

```js
// config.domainName is { get(), ... } for volatile fields, and a plain value for ordinary ones
const get = (value) => (value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)
const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(config).map(([k, v]) => [k, get(v)])) }
```

Ignoring this produces spectacular downstream failures (we hit `malformed-medium: invalid unit name
'[object Object]'` because an accessor was used as a storage domain name). Guard the import too: if
`@deepseek-ai/schemastery` cannot be resolved, degrade to *no* `Config` rather than failing to load.

## 3. Configuration edits and hot reload

- Editing a patch file by hand does **not** hot-apply: the loader is never notified.
- Writes that go through the settings service (the settings form, `SettingsForm.mutate`) are validated and
  persisted into the profile patch and applied through volatile HMR — no restart required.
- DSH does not cache-bust third-party module code. Node's ESM cache is keyed by the **resolved real path**, so a
  development loop that reuses a directory hands you the previously loaded module. Give every revision a fresh,
  monotonically increasing path.

## 4. Seams worth knowing

| Seam | Use |
|---|---|
| `ctx.systemPrompt.section({ name, order, text })` | Resident system-prompt block |
| `ctx.systemPrompt.context({ name, order, text })` | Resident user-role snapshot (re-materialized only when the rendered text changes) |
| `agent/pre-step` | Waterfall: `await next()`, then inject into the step |
| `agent/turn-stopping` | Awaited at turn end — the right place for work that must not race the turn |
| `session/event` | Observe events such as compaction summaries |
| `ctx.storageDomain.open(spec)` | Per-profile storage; **the caller owns `close()`** — an unclosed handle keeps the domain `already-open` for every later instance |
| `ctx.tools.register()` | Raw JSON Schema tools; an `output` schema is mandatory |
| `ctx.commands.register()` | Slash commands |
| `ctx.settings.configure({ auto })` | Registers the calling instance's settings-page policy |

Services that may be absent (`ctx.compaction`, `ctx.sessionQuery`, …) must never appear in a plugin's top-level
`inject`: a missing dependency leaves the fiber `PENDING` forever instead of failing loudly. Probe with `ctx.get()`
or scope the dependency with `ctx.inject([...], cb)`.

## 5. Where a plugin's settings page comes from

There is **no generic "render this Config as a form" component**. Exporting `Config` and calling
`ctx.settings.configure({ auto: true })` makes the settings service *project a descriptor* (visible through the
`Config` inspect provider), but the UI comes from the plugin's own browser half:

```js
// client half, lazily loaded
const inject = ['slots', 'locale', 'configForms']
const card = new MemoryCardController(ctx.configForms.get('dsh-memory'))   // SettingsFormModel
ctx.effect(() => ctx.configForms.whileServed(['dsh-memory'], () => ctx.slots.inject('plugins.row.config', () =>
  ctx.slots.register({
    name: 'plugins.row.config',
    key: 'dsh-plugin-memory#dsh-memory',   // `${bundle}#${rowId}`
    locale: DICT,
    inject: () => card.inject(),
  }, Card))))
```

Slot semantics that matter:

- `plugins.item` is a **list** slot; its entries are grouped under the built-in features in the Plugins page.
- `plugins.bundle.config` / `plugins.row.config` are **keyed** slots: `key` is the bundle package name, or
  `` `${bundle}#${rowId}` `` for a row. They render inside the `data-plugin-config` section of that page.
- `plugins.detail.actions` / `.badge` / `.section` are list slots for contributions *about* someone else's page.
- A row or bundle needs to be locatable in the profile patch for its form to be projected; a
  bundle-layer-only row may not appear.
- A package's browser half is only mounted for the row whose specifier is exactly the bare package name, so keep
  the client half on the root row.

## 6. Environment facts to design around

- Storage domains validate their name against `^[a-z][a-z0-9_]*$`, and per-record JSON keys against a
  filesystem-safe pattern — the key becomes the file name.
- The storage root is **home-level**, shared by every profile on the machine.
- Full-text session search ships disabled (`openAt: 'never'`), so `searchSessions`/`searchEvents` can be
  unavailable; exact session reads still work.
- Compaction is a deployment choice: without a mounted compaction plugin there is no `compaction/summary` event.

## 7. Reading DSH's own browser code

Undocumented client APIs (slot kinds, prop shapes) can be read straight out of the installed client bundles.
`tools/extract-asar.cjs` unpacks `app.asar` entries and `tools/scan-asar.cjs` finds where a symbol appears and
maps it back to its owning file:

```sh
node tools/extract-asar.cjs                     # extracts every lib/client.js
node tools/scan-asar.cjs settingsNumberField    # which bundle defines it, plus surrounding context
```

This is how the slot kinds and the `SettingsFormModel` contract used by this plugin were confirmed rather than
guessed.

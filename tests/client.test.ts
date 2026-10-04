// 客户端半边的回归测试：直接加载**构建产物** lib/client.js，用假的 loader/require/ctx 驱动它。
//
// 覆盖三点：
//   1. lazy-CJS 包装与导出契约（NS / inject / apply）；
//   2. 插槽注册：必须是 keyed 的 `plugins.row.config` + `dsh-plugin-memory#dsh-memory`
//      （用 list 插槽 `plugins.item` 会让卡片跑到「官方插件」分组里去 —— 踩过）；
//   3. 字段转换规格：尤其 `domainName`（文本字段）解析非空草稿**不得抛异常**
//      —— 这是 0.4.x 的真实缺陷：文本字段曾走 enum 分支去读 `field.options.includes`。

import { test } from 'node:test'
import assert from 'node:assert/strict'

interface CapturedSpec {
  field: string
  format: (value: unknown) => string
  parse: (text: string) => unknown
}

interface CapturedSlot {
  options: Record<string, unknown>
}

/** 假 loader：捕获客户端包装登记的 entry。 */
interface LoaderEntry {
  id: string
  factory: (require: (specifier: string) => unknown) => unknown
}

/** 假的 SettingsFormModel：只记录传入的 specs，用于检查字段转换规格。 */
class FakeSettingsFormModel {
  static lastSpecs: CapturedSpec[] = []
  constructor(_scope: unknown, specs: CapturedSpec[]) {
    FakeSettingsFormModel.lastSpecs = specs
  }
  bind<T>(project: () => T): { getSnapshot(): T; subscribe(): () => void } {
    return { getSnapshot: project, subscribe: () => () => {} }
  }
  shell(): Record<string, unknown> {
    return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
  }
  field(name: string): Record<string, unknown> {
    return { text: '', overridden: false, invalid: false, name }
  }
  actions(): Record<string, unknown> {
    return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} }
  }
  dispose(): void {}
}

/** 假的 primitives：字段规格按运行版语义实现（空草稿 = clear）。 */
const fakePrimitives = {
  SettingsFormModel: FakeSettingsFormModel,
  SettingsForm: () => null,
  SettingsValueField: () => null,
  settingsNumberField: (field: string): CapturedSpec => ({
    field,
    format: (value: unknown) => (typeof value === 'number' ? String(value) : ''),
    parse: (text: string) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return Number.isFinite(Number(trimmed)) ? { kind: 'set', value: Number(trimmed) } : undefined
    },
  }),
  settingsTextField: (field: string): CapturedSpec => ({
    field,
    format: (value: unknown) => (typeof value === 'string' ? value : ''),
    parse: (text: string) => (text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() }),
  }),
}

/**
 * 导入**一次**构建产物并捕获它登记的 entry。
 *
 * 注意：Node 的 ESM 缓存按解析后的真实路径命中（本项目的 `docs/dsh-mechanisms.md` 专门记过这条），
 * 所以第二次 `import('../lib/client.js')` 不会重新执行模块体、更不会再次调用 loader；
 * 因此这里在模块顶层只导入一次，后续测试复用同一个 entry。
 */
let entry: LoaderEntry | undefined
{
  const globalWindow = globalThis as unknown as { window?: unknown }
  globalWindow.window = { __ModuleLoader__: { load: (value: LoaderEntry) => { entry = value } } }
  try {
    await import('../lib/client.js')
  } finally {
    delete globalWindow.window
  }
}

/** 用捕获到的 entry 构造模块（每个测试拿到独立的模块实例）。 */
function loadClientModule(): { NS: string; inject: string[]; apply: (ctx: unknown) => void } {
  assert.ok(entry, 'lib/client.js 必须调用 window.__ModuleLoader__.load')
  const require = (specifier: string): unknown => {
    if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: {} }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives
    throw new Error(`未预期的 require: ${specifier}`)
  }
  return entry.factory(require) as { NS: string; inject: string[]; apply: (ctx: unknown) => void }
}

// ---------------------------------------------------------------- 记录型夹具（补覆盖用）
//
// 上面那组用例只验证了「有规格、能解析」，字段目录、双语字典、分组渲染与写回形状都没有断言，
// 于是 src/client.ts 里绝大部分单点改动都能溜过去。下面这些夹具把客户端真正用到的东西记下来：
//   · locale.register 收到的两份字典；configForms.get 收到的命名空间；
//   · slots.register 收到的卡片组件；jsx/jsxs 的调用（把渲染结果变成可断言的树）；
//   · SettingsFormModel 收到的 scope/specs，以及控件视图、actions 与 dispose 次数。

/** 一个字段的控件视图（与 primitives 的 SettingsFieldView 同形）。 */
interface RecordedView {
  text: string
  overridden: boolean
  invalid: boolean
}

/** 渲染记录的伪元素：type 是标签名或组件函数，props 原样保留。 */
interface RecordedElement {
  type: unknown
  props: Record<string, unknown>
}

/** locale.register 收到的一次字典注册。 */
interface RecordedDictionary {
  namespace: string
  dictionaries: { zh: Record<string, string>; en: Record<string, string> }
}

/** 记录型 SettingsFormModel：比假模型多记 scope / 视图 / actions / dispose。 */
class RecordingSettingsFormModel {
  static last: RecordingSettingsFormModel | undefined
  readonly scope: unknown
  readonly specs: CapturedSpec[]
  readonly shellState: Record<string, unknown> = {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
  }
  readonly views = new Map<string, RecordedView>()
  readonly edits: Array<[string, string]> = []
  readonly resets: string[] = []
  disposed = 0

  constructor(scope: unknown, specs: CapturedSpec[]) {
    this.scope = scope
    this.specs = specs
    RecordingSettingsFormModel.last = this
    for (const spec of specs) this.views.set(spec.field, { text: '', overridden: false, invalid: false })
  }
  bind<T>(project: () => T): { getSnapshot(): T; subscribe(): () => void } {
    return { getSnapshot: () => project(), subscribe: () => () => {} }
  }
  shell(): Record<string, unknown> {
    return { ...this.shellState }
  }
  field(name: string): RecordedView {
    return this.views.get(name) ?? { text: '', overridden: false, invalid: false }
  }
  actions(): Record<string, unknown> {
    return {
      edit: (field: string, text: string): void => { this.edits.push([field, text]) },
      resetField: (field: string): void => { this.resets.push(field) },
      save: (): void => {},
      discard: (): void => {},
    }
  }
  dispose(): void { this.disposed += 1 }
}

/** 把 jsx/jsxs 的每次调用记成元素树；渲染组件本身不执行（返回 null 的桩即可）。 */
function makeJsxRecorder(): { runtime: Record<string, unknown>; elements: RecordedElement[] } {
  const elements: RecordedElement[] = []
  const record = (type: unknown, props: unknown): RecordedElement => {
    const element: RecordedElement = { type, props: (props ?? {}) as Record<string, unknown> }
    elements.push(element)
    return element
  }
  return { runtime: { jsx: record, jsxs: record, Fragment: {} }, elements }
}

/** 记录型 primitives：原语的字段规格沿用 fakePrimitives 的运行版语义。 */
function makeRecordingPrimitives(): Record<string, unknown> {
  return {
    SettingsFormModel: RecordingSettingsFormModel,
    SettingsForm: function SettingsFormStub(): unknown { return null },
    SettingsValueField: function SettingsValueFieldStub(): unknown { return null },
    settingsNumberField: fakePrimitives.settingsNumberField,
    settingsTextField: fakePrimitives.settingsTextField,
  }
}

/** 用捕获到的 entry 构造模块，但自行提供 require 的返回值（记录型 primitives / jsx）。 */
function loadClientModuleWith(
  primitives: unknown,
  jsxRuntime: unknown,
): { NS: string; inject: string[]; apply: (ctx: unknown) => void } {
  assert.ok(entry, 'lib/client.js 必须调用 window.__ModuleLoader__.load')
  const require = (specifier: string): unknown => {
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`未预期的 require: ${specifier}`)
  }
  return entry.factory(require) as { NS: string; inject: string[]; apply: (ctx: unknown) => void }
}

interface ClientHarness {
  ctx: Record<string, unknown>
  slots: Array<{ options: Record<string, unknown>; component: (props: Record<string, unknown>) => unknown }>
  locales: RecordedDictionary[]
  scopes: unknown[]
  cleanups: Array<() => void>
  whileServed: string[][]
}

/** 记录型 ctx：除了跑通注册，还把字典/命名空间/组件/清理函数都留下来。 */
function makeClientHarness(): ClientHarness {
  const slots: ClientHarness['slots'] = []
  const locales: RecordedDictionary[] = []
  const scopes: unknown[] = []
  const cleanups: Array<() => void> = []
  const whileServed: string[][] = []
  const ctx: Record<string, unknown> = {
    locale: {
      register: (namespace: string, dictionaries: RecordedDictionary['dictionaries']): void => {
        locales.push({ namespace, dictionaries })
      },
      bind: (): ((key: string) => string) => (key: string) => key,
    },
    configForms: {
      get: (namespace: string): Record<string, unknown> => {
        scopes.push(namespace)
        return { namespace }
      },
      whileServed: (namespaces: string[], register: () => unknown): (() => void) => {
        whileServed.push(namespaces)
        register()
        return () => {}
      },
    },
    slots: {
      inject: (_slot: string, register: () => unknown): (() => void) => {
        register()
        return () => {}
      },
      register: (options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown): (() => void) => {
        slots.push({ options, component })
        return () => {}
      },
    },
    effect: (callback: () => unknown): (() => void) => {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
      return () => {}
    },
  }
  return { ctx, slots, locales, scopes, cleanups, whileServed }
}

interface RecordedSection {
  group: string
  heading: string
  fields: RecordedElement[]
  element: RecordedElement
}

/** 卡片根元素的 children = 各分组 section；section 的第一个孩子是分组标题 h4。 */
function sectionEntries(root: RecordedElement): RecordedSection[] {
  const sections = (root.props.children ?? []) as RecordedElement[]
  return sections.map((element) => {
    const children = (element.props.children ?? []) as RecordedElement[]
    const group = String(children[0]?.props.children ?? '')
    return { group, heading: group, fields: children.slice(1), element }
  })
}

/** 布尔/枚举字段外面包了一层 row() 的 div，控件在它的 children 上。 */
function unwrapControl(element: RecordedElement): RecordedElement {
  if (element.type === 'div') {
    const child = element.props.children
    if (child && typeof child === 'object' && !Array.isArray(child)) return child as RecordedElement
  }
  return element
}

/** 从渲染结果认出字段名：数字/文本看 id，布尔/枚举看 label 里的 span 文案（t 为恒等函数）。 */
function fieldNameOf(element: RecordedElement, primitives: Record<string, unknown>): string {
  const control = unwrapControl(element)
  if (control.type === primitives.SettingsValueField) {
    return String(control.props.id ?? '').replace(/^dsh-memory-/u, '')
  }
  for (const child of (control.props.children ?? []) as RecordedElement[]) {
    if (child && typeof child === 'object' && child.type === 'span') return String(child.props.children)
  }
  throw new Error('无法从渲染结果识别字段名')
}

/** 渲染结果 → 字段名 → 控件元素。 */
function collectControls(root: RecordedElement, primitives: Record<string, unknown>): Map<string, RecordedElement> {
  const controls = new Map<string, RecordedElement>()
  for (const section of sectionEntries(root)) {
    for (const element of section.fields) controls.set(fieldNameOf(element, primitives), unwrapControl(element))
  }
  return controls
}

interface ClientFixture {
  mod: { NS: string; inject: string[]; apply: (ctx: unknown) => void }
  harness: ClientHarness
  model: RecordingSettingsFormModel
  primitives: Record<string, unknown>
  specs: CapturedSpec[]
  specByName(name: string): CapturedSpec
  injected: Record<string, unknown> & {
    hooks: { memoryCard: { getSnapshot(): Record<string, unknown>; subscribe(listener?: () => void): () => void } }
  }
  dictionary(): RecordedDictionary
  render(overrides?: { view?: string; state?: Record<string, unknown> }): unknown
  controls(state?: Record<string, unknown>): Map<string, RecordedElement>
  /** 渲染过程中 t() 被请求过的文案键（顺序保留）。 */
  requested: string[]
}

/** 装配一次完整客户端：apply → 卡片组件 → 投影 → 渲染。 */
function makeClientFixture(): ClientFixture {
  const primitives = makeRecordingPrimitives()
  const recorder = makeJsxRecorder()
  const mod = loadClientModuleWith(primitives, recorder.runtime)
  const harness = makeClientHarness()
  mod.apply(harness.ctx)
  const model = RecordingSettingsFormModel.last
  assert.ok(model, '客户端必须用 SettingsFormModel 建表单')
  const slot = harness.slots[0]
  assert.ok(slot, '客户端必须注册设置卡片')
  const injector = slot.options.inject
  assert.equal(typeof injector, 'function', '插槽必须带 inject 工厂')
  const injected = (injector as () => ClientFixture['injected'])()
  const requested: string[] = []
  const render = (overrides: { view?: string; state?: Record<string, unknown> } = {}): unknown => {
    const state = overrides.state ?? injected.hooks.memoryCard.getSnapshot()
    return slot.component({
      view: overrides.view ?? 'detail',
      t: (key: string): string => {
        requested.push(key)
        return key
      },
      useMemoryCard: (selector: (snapshot: Record<string, unknown>) => unknown): unknown => selector(state),
      save: (): void => {},
      discard: (): void => {},
      ...injected,
    })
  }
  return {
    mod,
    harness,
    model,
    primitives,
    specs: model.specs,
    specByName: (name: string): CapturedSpec => {
      const found = model.specs.find((spec) => spec.field === name)
      assert.ok(found, `缺少字段规格: ${name}`)
      return found
    },
    injected,
    dictionary: (): RecordedDictionary => {
      const record = harness.locales[0]
      assert.ok(record, 'apply 必须注册文案字典')
      return record
    },
    render,
    controls: (state?: Record<string, unknown>): Map<string, RecordedElement> =>
      collectControls(render({ state }) as RecordedElement, primitives),
    requested,
  }
}

// ---------------------------------------------------------------- 界面契约的字面量表
//
// 这些是**客户端半边自己的契约**（不是从被测代码推出来的），所以能真正钉住字段目录、
// 分组归属与 options；Schema 一侧再用 lib/index.js 的 Config.dict 交叉核对（不可解析时退化为字面量断言）。

/** 客户端字段的界面顺序（src/client.ts 的 FIELDS；精简后 8 个，见 docs/simplify.md §1）。 */
const CLIENT_FIELD_ORDER: readonly string[] = [
  'domainName',
  'captureMode',
  'recallMode',
  'writePolicy',
  'language',
  'selfPortraitEnabled',
  'branchAware',
  'sleepEnabled',
]

/** 每个字段归属的分组（与 FIELDS 逐条对应；分组收敛到 4 组）。 */
const CLIENT_FIELD_GROUPS: Record<string, string> = {
  domainName: 'groupStore',
  captureMode: 'groupStore',
  recallMode: 'groupStore',
  writePolicy: 'groupWrite',
  language: 'groupLanguage',
  selfPortraitEnabled: 'groupLanguage',
  branchAware: 'groupOther',
  sleepEnabled: 'groupOther',
}

/** 分组在卡片里的出现顺序（按 FIELDS 首次出现；同组只渲染一次）。 */
const CLIENT_GROUP_ORDER: readonly string[] = [
  'groupStore',
  'groupWrite',
  'groupLanguage',
  'groupOther',
]

/** 枚举字段的界面 options：必须与 Host Schema 的 union 逐项一致。 */
const CLIENT_ENUM_OPTIONS: Record<string, readonly string[]> = {
  recallMode: ['off', 'dry', 'inject'],
  captureMode: ['off', 'rule'],
  writePolicy: ['auto', 'ask', 'off'],
  language: ['zh', 'en'],
}

/** 字段的界面种类：text / number / 0-1 表达的布尔 / 复选框布尔 / 枚举。 */
type FieldKind = 'text' | 'number' | 'bool01' | 'boolean' | 'enum'

/** 每个字段的界面种类（与 FIELDS 的 kind + bool01 对应；精简后只剩这 8 个）。 */
const CLIENT_FIELD_KINDS: Record<string, FieldKind> = {
  domainName: 'text',
  captureMode: 'enum',
  recallMode: 'enum',
  writePolicy: 'enum',
  language: 'enum',
  selfPortraitEnabled: 'bool01',
  branchAware: 'bool01',
  sleepEnabled: 'bool01',
}

/** 每种界面种类在 Host Schema 里对应的类型。 */
const SCHEMA_TYPE_OF_KIND: Record<FieldKind, string> = {
  text: 'string',
  number: 'number',
  bool01: 'boolean',
  boolean: 'boolean',
  enum: 'union',
}

/** 判定字段界面种类：靠草稿探针（不依赖 FIELDS 是否导出）。 */
function fieldKindOf(spec: CapturedSpec): FieldKind {
  const one = spec.parse('1') as { kind?: string; value?: unknown } | undefined
  if (one?.kind === 'set' && one.value === true) return 'bool01'
  if (one?.kind === 'set' && one.value === 1) return 'number'
  if (one?.kind === 'set' && one.value === '1') return 'text'
  const truthy = spec.parse('true') as { kind?: string; value?: unknown } | undefined
  if (truthy?.kind === 'set' && truthy.value === true) return 'boolean'
  return 'enum'
}

/** 每个字段一份合法草稿、期望写回值、format 结果与一份非法草稿（文本字段没有非法草稿）。 */
function legalDraft(name: string): { text: string; value: unknown; formatted: string; bogus?: string } {
  const kind = CLIENT_FIELD_KINDS[name]
  if (kind === 'text') return { text: 'dsh_memory_v2', value: 'dsh_memory_v2', formatted: 'dsh_memory_v2' }
  if (kind === 'bool01') return { text: '1', value: true, formatted: '1', bogus: '2' }
  if (kind === 'boolean') return { text: 'true', value: true, formatted: 'true', bogus: 'yes' }
  if (kind === 'number') return { text: '7', value: 7, formatted: '7', bogus: 'abc' }
  const option = (CLIENT_ENUM_OPTIONS[name] ?? [''])[0] as string
  return { text: option, value: option, formatted: option, bogus: '__not_an_option__' }
}

/** 假 ctx：记录插槽注册与 configForms 门控，并执行门控回调以便触发注册。 */
function makeFakeContext(): { ctx: Record<string, unknown>; slots: CapturedSlot[]; whileServed: string[][] } {
  const slots: CapturedSlot[] = []
  const whileServed: string[][] = []
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    configForms: {
      get: () => ({}),
      whileServed: (namespaces: string[], register: () => unknown) => {
        whileServed.push(namespaces)
        register()
        return () => {}
      },
    },
    slots: {
      inject: (_slot: string, register: () => unknown) => {
        register()
        return () => {}
      },
      register: (options: Record<string, unknown>) => {
        slots.push({ options })
        return () => {}
      },
    },
    effect: (callback: () => unknown) => callback(),
  }
  return { ctx, slots, whileServed }
}

test('客户端半边：包装形状与导出契约', async () => {
  const mod = await loadClientModule()
  assert.equal(mod.NS, 'dsh-memory')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'configForms'])
})

test('客户端半边：注册进 keyed 的行级配置插槽（不是 plugins.item）', async () => {
  const mod = await loadClientModule()
  const { ctx, slots, whileServed } = makeFakeContext()
  mod.apply(ctx)
  assert.deepEqual(whileServed, [['dsh-memory']], '只在 Host 服务该命名空间期间注册')
  assert.equal(slots.length, 1)
  const options = slots[0]?.options ?? {}
  assert.equal(options.name, 'plugins.row.config', '必须用 keyed 配置插槽，否则卡片会被归入官方插件分组')
  assert.equal(options.key, 'dsh-plugin-memory#dsh-memory', 'key 必须等于 rowConfigKey(bundle, rowId)')
  assert.equal(options.locale, 'dsh-memory.settings')
  assert.equal(typeof options.inject, 'function', '控件需要 inject 提供 hooks 与 actions')
})

test('字段转换规格：domainName 是文本字段，解析非空草稿不得抛异常（0.4.x 缺陷回归）', async () => {
  const mod = await loadClientModule()
  const { ctx } = makeFakeContext()
  mod.apply(ctx)
  const specs = FakeSettingsFormModel.lastSpecs
  const byName = (name: string): CapturedSpec => {
    const found = specs.find((spec) => spec.field === name)
    assert.ok(found, `缺少字段规格: ${name}`)
    return found
  }

  // 回归点：文本字段曾经走 enum 分支读 field.options.includes → TypeError
  assert.doesNotThrow(() => byName('domainName').parse('dsh_memory_v2'))
  assert.deepEqual(byName('domainName').parse('dsh_memory_v2'), { kind: 'set', value: 'dsh_memory_v2' })
  assert.deepEqual(byName('domainName').parse('   '), { kind: 'clear' })

  // 枚举字段：仅接受白名单值
  assert.deepEqual(byName('recallMode').parse('dry'), { kind: 'set', value: 'dry' })
  assert.equal(byName('recallMode').parse('bogus'), undefined)

  // 保留的 3 个布尔字段在 Host 侧是 boolean：界面用 0/1，但**写回的必须是真布尔**
  // （schemastery 的 Schema.boolean() 对 0/1 数字会抛 `expected boolean but got 0`）
  for (const name of ['selfPortraitEnabled', 'branchAware', 'sleepEnabled'] as const) {
    assert.deepEqual(byName(name).parse('1'), { kind: 'set', value: true }, `${name}: 1 = 开`)
    assert.deepEqual(byName(name).parse('0'), { kind: 'set', value: false }, `${name}: 0 = 关`)
    assert.equal(byName(name).parse('2'), undefined, `${name}: 只接受 0/1`)
    assert.equal(byName(name).parse('abc'), undefined, `${name}: 非数字为 invalid`)
    assert.deepEqual(byName(name).parse(''), { kind: 'clear' }, `${name}: 空草稿 = 清除覆盖`)
    assert.equal(byName(name).format(true), '1')
    assert.equal(byName(name).format(false), '0')
    assert.equal(byName(name).format(undefined), '')
  }

  // M10：写入审批门 —— 枚举字段只认三档
  assert.deepEqual(byName('writePolicy').parse('ask'), { kind: 'set', value: 'ask' })
  assert.deepEqual(byName('writePolicy').parse('off'), { kind: 'set', value: 'off' })
  assert.deepEqual(byName('writePolicy').parse('auto'), { kind: 'set', value: 'auto' })
  assert.equal(byName('writePolicy').parse('bogus'), undefined, 'writePolicy 只认 auto/ask/off')
  assert.deepEqual(byName('writePolicy').parse(''), { kind: 'clear' })

  // M11：模型可见文本语言 —— 枚举只认 zh/en
  assert.deepEqual(byName('language').parse('en'), { kind: 'set', value: 'en' })
  assert.deepEqual(byName('language').parse('zh'), { kind: 'set', value: 'zh' })
  assert.equal(byName('language').parse('english'), undefined, 'language 只认 zh/en')
  assert.deepEqual(byName('language').parse(''), { kind: 'clear' })

  // 精简（docs/simplify.md §1）：表单恰好这 8 个字段，顺序见字面量表；
  // 被移出表单的 22 个键不再有规格（它们仍 volatile、仍可 patch 行设置）。
  assert.equal(specs.length, 8)
  assert.deepEqual(specs.map((spec) => spec.field), [...CLIENT_FIELD_ORDER], '字段目录与界面顺序')
})

// ---------------------------------------------------------------- 变异驱动补测
//
// 每条用例都对得上一次「改 src/client.ts 一处 → 重建 → 跑本文件 → 改回」的体检；
// 下面的断言就是为了让这些单点改动由绿变红（原生中文文案与上面保持一致）。

test('客户端字段目录：恰好 8 个字段、顺序与分组固定，且都落在 Host volatile 集合里（子集）', async () => {
  const fx = makeClientFixture()
  const names = fx.specs.map((spec) => spec.field)
  assert.equal(names.length, 8, '设置页恰好 8 个字段（docs/simplify.md §1）')
  assert.equal(new Set(names).size, names.length, '字段名不得重复')
  assert.deepEqual(names, [...CLIENT_FIELD_ORDER], '字段顺序是界面契约，不得重排')

  const root = fx.render() as RecordedElement
  const sections = sectionEntries(root)
  assert.deepEqual(sections.map((section) => section.group), [...CLIENT_GROUP_ORDER], '分组顺序固定，且同组只渲染一次')
  assert.equal(sections.length, 4, '分组收敛到 4 组')
  for (const section of sections) {
    assert.equal(section.element.type, 'section')
    assert.equal(section.element.props.key, section.group)
    assert.equal(section.heading, section.group, 'h4 的文案键必须是分组 id')
    assert.deepEqual(
      section.fields.map((element) => fieldNameOf(element, fx.primitives)),
      names.filter((name) => CLIENT_FIELD_GROUPS[name] === section.group),
      `${section.group} 的字段归属`,
    )
  }
  for (const name of names) {
    assert.ok(CLIENT_GROUP_ORDER.includes(CLIENT_FIELD_GROUPS[name] ?? ''), `${name} 的期望分组未知`)
  }

  // 与 Host 侧 volatile 集合的关系是**子集**（不再是相等）：被移出表单的 22 个键仍然
  // volatile、仍可 patch 行热生效；但表单字段必须都在里面，否则表单改了存不进去。
  // （schemastery 不可解析时只跑上面的字面量断言）
  const host = (await import('../lib/index.js')) as { Config?: unknown }
  const dict = (host.Config as { dict?: Record<string, { meta?: { volatile?: boolean } }> } | undefined)?.dict
  if (dict) {
    const volatile = Object.keys(dict).filter((key) => dict[key]?.meta?.volatile === true)
    const volatileSet = new Set(volatile)
    for (const name of names) {
      assert.ok(volatileSet.has(name), `表单字段 ${name} 必须仍在 Host 侧 volatile 集合里（子集关系）`)
    }
    assert.ok(volatile.length >= names.length, 'volatile 集合不得小于表单字段数（精简只动暴露面）')
  }
})

test('双语字典：zh/en 键集合完全一致，每个字段都有 label 与 hint<Name>', async () => {
  const fx = makeClientFixture()
  const record = fx.dictionary()
  assert.equal(record.namespace, 'dsh-memory.settings', '字典命名空间必须与插槽 locale 一致')
  assert.equal(String(fx.harness.slots[0]?.options.locale), record.namespace)
  const { zh, en } = record.dictionaries
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '两组字典的键集合必须完全一致，不得中英缺漏')
  const capitalize = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`
  for (const name of CLIENT_FIELD_ORDER) {
    for (const [tag, table] of [['zh', zh], ['en', en]] as const) {
      assert.equal(typeof table[name], 'string', `${tag} 缺 ${name} 的 label`)
      assert.ok((table[name] ?? '').length > 0, `${tag} 的 ${name} label 不得为空`)
      const hint = table[`hint${capitalize(name)}`]
      assert.equal(typeof hint, 'string', `${tag} 缺 hint${capitalize(name)}`)
      assert.ok((hint ?? '').length > 0, `${tag} 的 hint${capitalize(name)} 不得为空`)
    }
  }
  for (const group of CLIENT_GROUP_ORDER) {
    assert.ok(zh[group] && en[group], `分组标题 ${group} 必须在两份字典里`)
  }
  // 英文表不能是中文表的副本
  assert.equal(zh.title, '长期记忆')
  assert.equal(en.title, 'Long-term memory')
  assert.notEqual(zh.description, en.description)

  const root = fx.render() as RecordedElement
  assert.ok(root)
  for (const key of new Set(fx.requested)) {
    assert.ok(zh[key] && en[key], `渲染请求的文案键 ${key} 在两份字典里都必须存在`)
  }
})

test('枚举字段：界面 options 与 Host Schema 的 union 完全一致（含顺序）', async () => {
  const fx = makeClientFixture()
  const rendered = new Map<string, string[]>()
  for (const [name, element] of fx.controls()) {
    const select = ((element.props.children ?? []) as RecordedElement[]).find((child) => child.type === 'select')
    if (select) {
      rendered.set(
        name,
        ((select.props.children ?? []) as RecordedElement[]).map((option) => String(option.props.value)),
      )
    }
  }
  assert.deepEqual([...rendered.keys()].sort(), Object.keys(CLIENT_ENUM_OPTIONS).sort(), '客户端枚举字段集合')
  for (const [name, options] of Object.entries(CLIENT_ENUM_OPTIONS)) {
    assert.deepEqual(rendered.get(name), [...options], `${name} 的界面 options`)
  }

  const host = (await import('../lib/index.js')) as { Config?: unknown }
  const dict = (host.Config as { dict?: Record<string, { type?: string; list?: Array<{ value?: unknown }> }> } | undefined)?.dict
  if (dict) {
    for (const name of Object.keys(CLIENT_ENUM_OPTIONS)) {
      assert.equal(dict[name]?.type, 'union', `${name} 在 Host 侧必须是 union`)
      assert.deepEqual(
        (dict[name]?.list ?? []).map((item) => item.value),
        rendered.get(name),
        `${name} 的 options 必须与 Schema 一致`,
      )
    }
  }
})

test('字段种类：文本/0-1 布尔/枚举归属固定，且与 Host Schema 类型一致（表单里不再有普通数字与复选框字段）', async () => {
  const fx = makeClientFixture()
  for (const name of CLIENT_FIELD_ORDER) {
    assert.equal(fieldKindOf(fx.specByName(name)), CLIENT_FIELD_KINDS[name], `${name} 的界面种类`)
  }
  const kinds = Object.values(CLIENT_FIELD_KINDS)
  assert.equal(kinds.filter((kind) => kind === 'text').length, 1)
  assert.equal(kinds.filter((kind) => kind === 'number').length, 0)
  assert.equal(kinds.filter((kind) => kind === 'bool01').length, 3)
  assert.equal(kinds.filter((kind) => kind === 'boolean').length, 0)
  assert.equal(kinds.filter((kind) => kind === 'enum').length, 4)

  const host = (await import('../lib/index.js')) as { Config?: unknown }
  const dict = (host.Config as { dict?: Record<string, { type?: string }> } | undefined)?.dict
  if (dict) {
    for (const name of CLIENT_FIELD_ORDER) {
      assert.equal(dict[name]?.type, SCHEMA_TYPE_OF_KIND[CLIENT_FIELD_KINDS[name]], `${name} 的 Host Schema 类型`)
    }
  }
})

test('全字段 parse/format：空草稿=清除、非法草稿=undefined、set 形状只有 kind/value', () => {
  const fx = makeClientFixture()
  for (const name of CLIENT_FIELD_ORDER) {
    const spec = fx.specByName(name)
    assert.deepEqual(spec.parse(''), { kind: 'clear' }, `${name}: 空草稿必须清除覆盖`)
    assert.deepEqual(spec.parse('   '), { kind: 'clear' }, `${name}: 纯空白同空草稿`)
    assert.equal(spec.format(undefined), '', `${name}: format(undefined) 必须是空串`)
    assert.equal(spec.format(null), '', `${name}: format(null) 必须是空串`)
    const draft = legalDraft(name)
    const parsed = spec.parse(draft.text) as { kind?: string; value?: unknown } | undefined
    assert.equal(parsed?.kind, 'set', `${name}: 合法草稿 ${JSON.stringify(draft.text)} 必须可写回`)
    assert.deepEqual(parsed?.value, draft.value, `${name}: 写回值`)
    assert.deepEqual(Object.keys(parsed ?? {}).sort(), ['kind', 'value'], `${name}: set 结果只能有 kind/value`)
    assert.equal(spec.format(draft.value), draft.formatted, `${name}: format 往返`)
    if (draft.bogus !== undefined) {
      assert.equal(spec.parse(draft.bogus), undefined, `${name}: 非法草稿 ${JSON.stringify(draft.bogus)} 必须是 undefined`)
      assert.notDeepEqual(spec.parse(draft.bogus), { kind: 'clear' }, `${name}: 非法草稿不得被当成清除`)
    }
  }
})

test('类型边界：bool01 只认 0/1、枚举大小写敏感、文本字段去空白', () => {
  const fx = makeClientFixture()
  const bool01Fields = CLIENT_FIELD_ORDER.filter((name) => CLIENT_FIELD_KINDS[name] === 'bool01')
  assert.equal(bool01Fields.length, 3)
  for (const name of bool01Fields) {
    const spec = fx.specByName(name)
    for (const draft of ['0', '1', '2', '-1', '1.5', 'true', 'yes']) {
      const expected = draft === '0' ? { kind: 'set', value: false } : draft === '1' ? { kind: 'set', value: true } : undefined
      assert.deepEqual(spec.parse(draft), expected, `${name}: 草稿 ${JSON.stringify(draft)}`)
    }
    assert.equal(typeof (spec.parse('1') as { value: unknown }).value, 'boolean', `${name}: 落盘必须是真布尔`)
  }

  assert.deepEqual(fx.specByName('domainName').parse('  dsh_memory_v2  '), { kind: 'set', value: 'dsh_memory_v2' })

  for (const name of Object.keys(CLIENT_ENUM_OPTIONS)) {
    const spec = fx.specByName(name)
    for (const option of CLIENT_ENUM_OPTIONS[name] ?? []) {
      assert.deepEqual(spec.parse(option), { kind: 'set', value: option }, `${name}: 白名单值 ${option}`)
    }
    assert.equal(spec.parse('AUTO'), undefined, `${name}: 枚举大小写敏感`)
  }
})

test('bool01 的 format：只有真布尔才给 0/1，数字 1/0 与其它值都是空串', () => {
  const fx = makeClientFixture()
  for (const name of CLIENT_FIELD_ORDER.filter((item) => CLIENT_FIELD_KINDS[item] === 'bool01')) {
    const spec = fx.specByName(name)
    assert.equal(spec.format(true), '1')
    assert.equal(spec.format(false), '0')
    assert.equal(spec.format(undefined), '')
    assert.equal(spec.format(null), '')
    assert.equal(spec.format(1), '', '数字 1 不是真布尔，不得显示成 "1"')
    assert.equal(spec.format(0), '')
    assert.equal(spec.format('1'), '', '字符串 "1" 不是真布尔')
  }
})

test('渲染：数字/文本控件的 label/hint/numeric/invalidLabel/id 与视图透传', () => {
  const fx = makeClientFixture()
  const primitiveFields = CLIENT_FIELD_ORDER.filter((name) => {
    const kind = CLIENT_FIELD_KINDS[name]
    return kind === 'text' || kind === 'number' || kind === 'bool01'
  })
  const collected = fx.controls()
  for (const name of primitiveFields) {
    const control = collected.get(name)
    assert.ok(control, `${name} 必须有控件`)
    assert.equal(control.type, fx.primitives.SettingsValueField, `${name} 必须走 SettingsValueField`)
    assert.equal(control.props.id, `dsh-memory-${name}`)
    assert.equal(control.props.label, name)
    assert.equal(control.props.hint, `hint${name.charAt(0).toUpperCase()}${name.slice(1)}`)
    assert.equal(control.props.overriddenLabel, 'overridden')
    assert.equal(control.props.resetLabel, 'reset')
    const kind = CLIENT_FIELD_KINDS[name]
    assert.equal(control.props.numeric, kind !== 'text', `${name} 的 numeric`)
    assert.equal(
      control.props.invalidLabel,
      kind === 'text' ? 'invalidValue' : kind === 'bool01' ? 'invalidToggle' : 'invalidNumber',
      `${name} 的非法文案`,
    )
    assert.equal(control.props.disabled, false)
  }

  const name = 'domainName'
  fx.model.views.set(name, { text: '9', overridden: true, invalid: true })
  const control = fx.controls().get(name)
  assert.ok(control)
  assert.equal(control.props.text, '9')
  assert.equal(control.props.overridden, true)
  assert.equal(control.props.invalid, true)
  ;(control.props.onEdit as (text: string) => void)('42')
  assert.deepEqual(fx.model.edits.at(-1), [name, '42'])
  ;(control.props.onReset as () => void)()
  assert.equal(fx.model.resets.at(-1), name)

  fx.model.shellState.writable = false
  assert.equal(fx.controls().get(name)?.props.disabled, true, '只读时控件必须禁用')
  fx.model.shellState.writable = true
})

test('渲染：state 里缺某个字段视图时按空视图兜底，不继承别的字段', () => {
  const fx = makeClientFixture()
  const sparse: Record<string, unknown> = { ...fx.injected.hooks.memoryCard.getSnapshot() }
  delete sparse['domainName']
  const control = fx.controls(sparse).get('domainName')
  assert.ok(control)
  assert.equal(control.props.text, '')
  assert.equal(control.props.overridden, false)
  assert.equal(control.props.invalid, false)
})

test('渲染：表单里不再有复选框字段（kind=boolean 已全部移出），布尔键一律走 0/1 数字控件', () => {
  const fx = makeClientFixture()
  // 精简（docs/simplify.md §1）后 8 个字段里没有 kind:'boolean'：三个布尔键都按契约用 0/1 表达，
  // 因此整棵渲染树里不得出现 <input type="checkbox"> —— 这是字段种类表在渲染层的钉子。
  const inputs: string[] = []
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const element = node as RecordedElement
    if (element.type === 'input') {
      assert.notEqual(element.props.type, 'checkbox', '表单里不得再渲染复选框：乐观布尔字段已移出表单')
      inputs.push(String(element.props.type))
    }
    walk(element.props.children)
  }
  walk(fx.render())
  assert.deepEqual(inputs, [], '精简后没有任何原生 input：布尔键都走 SettingsValueField 的 0/1 输入')

  for (const name of CLIENT_FIELD_ORDER.filter((item) => CLIENT_FIELD_KINDS[item] === 'bool01')) {
    assert.equal(fx.controls().get(name)?.type, fx.primitives.SettingsValueField, `${name} 必须走 SettingsValueField`)
  }
})

test('渲染：枚举字段的 select 值与草稿一致，onChange 写回所选值', () => {
  const fx = makeClientFixture()
  for (const name of Object.keys(CLIENT_ENUM_OPTIONS)) {
    const options = [...(CLIENT_ENUM_OPTIONS[name] ?? [])]
    const chosen = options[1] as string
    fx.model.views.set(name, { text: chosen, overridden: false, invalid: false })
    const control = fx.controls().get(name)
    assert.ok(control, `${name} 必须有控件`)
    const children = (control.props.children ?? []) as RecordedElement[]
    assert.equal(String(children[0]?.props.children), name, 'select 前的 span 必须是字段 label')
    const select = children.find((child) => child.type === 'select')
    assert.ok(select, `${name} 必须渲染 select`)
    assert.equal(select.props.value, chosen)
    assert.deepEqual(((select.props.children ?? []) as RecordedElement[]).map((option) => option.props.value), options)
    assert.deepEqual(((select.props.children ?? []) as RecordedElement[]).map((option) => option.props.children), options)
    ;(select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: options[0] as string } })
    assert.deepEqual(fx.model.edits.at(-1), [name, options[0]])
  }
})

test('渲染：列表摘要用 description，详情用整张表单', () => {
  const fx = makeClientFixture()
  assert.equal(fx.render({ view: 'summary' }), 'description')
  const detail = fx.render() as RecordedElement
  assert.equal(detail.type, fx.primitives.SettingsForm)
  assert.deepEqual(detail.props.labels, {
    unavailable: 'unavailable',
    readOnly: 'readOnly',
    saveFailed: 'saveFailed',
    save: 'save',
    saving: 'saving',
  })
  assert.equal(typeof detail.props.onSave, 'function')
  assert.equal(typeof detail.props.onDiscard, 'function')
})

test('装配：scope=NS、投影含全部字段、inject 暴露 hooks.memoryCard，清理时 dispose', () => {
  const fx = makeClientFixture()
  assert.equal(fx.mod.NS, 'dsh-memory')
  assert.deepEqual(fx.harness.scopes, ['dsh-memory'], 'SettingsFormModel 必须拿到本插件的 settings 命名空间')
  assert.deepEqual(fx.model.scope, { namespace: 'dsh-memory' }, '模型拿到的必须是 configForms.get(NS) 的返回值')

  const store = fx.injected.hooks.memoryCard
  assert.equal(typeof store.getSnapshot, 'function')
  assert.equal(typeof store.subscribe, 'function')
  for (const action of ['edit', 'resetField', 'save', 'discard']) {
    assert.equal(typeof fx.injected[action], 'function', `inject 必须暴露 ${action}`)
  }
  assert.equal(typeof store.subscribe(() => {}), 'function', 'subscribe 必须返回退订函数')

  const snapshot = store.getSnapshot()
  assert.equal(Object.keys(snapshot).length, Object.keys(fx.model.shell()).length + 8, '投影 = shell 字段 + 8 个控件视图')
  for (const name of CLIENT_FIELD_ORDER) {
    assert.ok(Object.hasOwn(snapshot, name), `投影缺少 ${name}`)
    assert.deepEqual(snapshot[name], fx.model.field(name))
  }

  for (const cleanup of fx.harness.cleanups) cleanup()
  assert.equal(fx.model.disposed, 1, '卸载清理必须 dispose 表单模型')
})

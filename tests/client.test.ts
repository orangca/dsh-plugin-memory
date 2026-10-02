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

  // 数字字段：非法草稿标为 invalid，空草稿清除覆盖
  assert.deepEqual(byName('maxInjectedTokens').parse('200'), { kind: 'set', value: 200 })
  assert.equal(byName('maxInjectedTokens').parse('abc'), undefined)
  assert.deepEqual(byName('maxInjectedTokens').parse(''), { kind: 'clear' })

  // 枚举字段：仅接受白名单值
  assert.deepEqual(byName('recallMode').parse('dry'), { kind: 'set', value: 'dry' })
  assert.equal(byName('recallMode').parse('bogus'), undefined)

  // 布尔字段：只接受 true/false
  assert.deepEqual(byName('consolidateEnabled').parse('true'), { kind: 'set', value: true })
  assert.equal(byName('consolidateEnabled').parse('yes'), undefined)

  // 自画像 v2（0.5.4）：契约 3.1 的 7 个新键逐个都要有规格
  const portraitV2Fields = [
    'selfPortraitEnabled',
    'selfPersonaMaxTokens',
    'selfPortraitMergeThreshold',
    'selfReflectEnabled',
    'selfReflectEveryTurns',
    'selfReflectMinTurn',
    'selfReflectMaxPerSession',
  ] as const
  for (const name of portraitV2Fields) {
    assert.ok(specs.some((spec) => spec.field === name), `缺少自画像 v2 字段规格: ${name}`)
  }

  // 其中两个开关在 Host 侧是 boolean：界面用 0/1，但**写回的必须是真布尔**
  // （schemastery 的 Schema.boolean() 对 0/1 数字会抛 `expected boolean but got 0`）
  for (const name of ['selfPortraitEnabled', 'selfReflectEnabled'] as const) {
    assert.deepEqual(byName(name).parse('1'), { kind: 'set', value: true }, `${name}: 1 = 开`)
    assert.deepEqual(byName(name).parse('0'), { kind: 'set', value: false }, `${name}: 0 = 关`)
    assert.equal(byName(name).parse('2'), undefined, `${name}: 只接受 0/1`)
    assert.equal(byName(name).parse('abc'), undefined, `${name}: 非数字为 invalid`)
    assert.deepEqual(byName(name).parse(''), { kind: 'clear' }, `${name}: 空草稿 = 清除覆盖`)
    assert.equal(byName(name).format(true), '1')
    assert.equal(byName(name).format(false), '0')
    assert.equal(byName(name).format(undefined), '')
  }

  // M7 新增：初次设定的布尔键同样按 0/1 表达、写回真布尔
  assert.deepEqual(byName('selfIntroEnabled').parse('1'), { kind: 'set', value: true })
  assert.deepEqual(byName('selfIntroEnabled').parse('0'), { kind: 'set', value: false })
  assert.equal(byName('selfIntroEnabled').parse('2'), undefined)
  assert.deepEqual(byName('selfIntroEnabled').parse(''), { kind: 'clear' })
  assert.equal(byName('selfIntroEnabled').format(true), '1')
  assert.equal(byName('selfIntroEnabled').format(undefined), '')

  // M8：/sleep 的布尔键同样按 0/1 表达、写回真布尔
  assert.deepEqual(byName('sleepEnabled').parse('1'), { kind: 'set', value: true })
  assert.deepEqual(byName('sleepEnabled').parse('0'), { kind: 'set', value: false })
  assert.equal(byName('sleepEnabled').parse('2'), undefined)
  assert.deepEqual(byName('sleepEnabled').parse(''), { kind: 'clear' })
  assert.equal(byName('sleepEnabled').format(true), '1')
  assert.equal(byName('sleepEnabled').format(undefined), '')

  // 其余 5 个键是普通数字字段（默认值见契约 3.1：80 / 0.6 / 12 / 4 / 3）
  for (const name of [
    'selfPersonaMaxTokens',
    'selfPortraitMergeThreshold',
    'selfReflectEveryTurns',
    'selfReflectMinTurn',
    'selfReflectMaxPerSession',
    'selfIntroMinTurn',
    'selfIntroMaxAsks',
    'sleepSessions',
    'sleepMaxBackfill',
  ] as const) {
    assert.deepEqual(byName(name).parse('7'), { kind: 'set', value: 7 }, `${name} 应为数字字段`)
    assert.equal(byName(name).parse('abc'), undefined, `${name}: 非法草稿应为 invalid`)
    assert.deepEqual(byName(name).parse(''), { kind: 'clear' }, `${name}: 空草稿 = 清除覆盖`)
  }

  // 23 个字段都要有规格，且与 Host 侧 volatile 字段一一对应
  assert.equal(specs.length, 23)
  for (const name of ['selfIntroEnabled', 'selfIntroMinTurn', 'selfIntroMaxAsks', 'sleepEnabled', 'sleepSessions', 'sleepMaxBackfill'] as const) {
    assert.ok(specs.some((spec) => spec.field === name), `设置页缺少 ${name}`)
  }
})

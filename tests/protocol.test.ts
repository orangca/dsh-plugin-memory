// `ctx.memory` 服务协议 v1 的一致性套件：把 docs/protocol-v1.md（英文）与 docs/protocol-v1.zh.md（中文）
// 承诺的东西**逐条钉在真实实现上**。
//
// 与 host.test.ts 同一套路：导入构建产物 `lib/index.js`，用假 ctx 驱动，不依赖真实宿主。
// 与 host.test.ts 的分工：这里只断言**协议文档 §2–§5** 的内容，不重复功能回归。
// 「文档说了但实现没做到」一律红在这里 —— 不改 src 去迎合，也不把断言写松。
//
// 已知缺口（协议文档 §8 有同一份清单，交 Lead 裁决；本套件对缺口只做**不断言**处理）：
//   · 服务面没有 `protocolVersion` 字段（用例 #10 conditional 断言 + diagnostic）；
//   · `list()` / `recall()` 不经过分支过滤（协议文档据实记录）；
//   · 领域未打开时 `write` 仍返回 `ok: true`（用例 #3 只断言「不抛」与 `stats().opened`）；
//   · `write` 不校验入参（用例 #3 只断言「畸形入参不抛」）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { apply as applyRaw } from '../lib/index.js'

/** 假 ctx 只实现本插件实际用到的那一块；测试里不假装它是完整宿主类型。 */
const apply = applyRaw as unknown as (ctx: Record<string, unknown>, config?: Record<string, unknown>) => void

type Json = Record<string, unknown>

/** 运行版把 volatile 字段以访问器对象（`.get()`）下发。 */
const volatile = (value: unknown): { get: () => unknown } => ({ get: () => value })

/** 协议 v1 冻结的 5 个方法名（docs/protocol-v1.md §3）。 */
const PROTOCOL_METHODS = ['list', 'stats', 'recall', 'write', 'consolidate'] as const

/** `MemoryRecord` 的**必填**字段（docs/protocol-v1.md §4）：缺一个都算破坏协议。 */
const REQUIRED_RECORD_KEYS = [
  'id', 'kind', 'precision', 'origin', 'scope', 'subject', 'field', 'value', 'text', 'tags', 'source',
  'confidence', 'importance', 'pinned', 'status', 'invalidAt', 'supersedes', 'observedAt', 'eventTime',
  'lastUsedAt', 'useCount', 'reinforcement', 'hash',
] as const

/** 可选字段：**缺失时不写键**（§3/§4）——给出这些键才算多，缺了不算少。 */
const OPTIONAL_RECORD_KEYS = ['branch', 'facet', 'refs', 'supersededBy'] as const

interface MemoryService {
  list(): Json[]
  stats(): { records: number; version: number; opened: boolean }
  recall(options: Json): Array<{ record: Json; match: number; score: number }>
  write(input: Json): Promise<Json>
  consolidate(reason?: string): Promise<void>
}

interface PromptRegistration {
  name?: string
  order?: number
  text: (...args: unknown[]) => unknown
}

interface HarnessOptions {
  config?: Json
  /** false = 宿主没有 `ctx.provide`（协议 §2 的可选性）。 */
  withProvide?: boolean
  /** false = 宿主没有 `ctx.storageDomain`（领域打不开）。 */
  withStorage?: boolean
}

interface Harness {
  ctx: Json
  provided: Map<string, unknown>
  sections: PromptRegistration[]
  contexts: PromptRegistration[]
  effects: Array<() => unknown>
  /** 假领域的落盘记录（key = 记录 id）。 */
  rows: Map<string, Json>
  puts: string[]
  service(): MemoryService
  settle(ticks?: number): Promise<void>
  /** 两条常驻注入通道的真实渲染文本（section + context，cwd 按 null）。 */
  resident(): string
  dispose(): Promise<void>
}

/** 一套假 ctx：只记录协议套件需要的注册，并让 effect 能被真正卸载。 */
function makeHarness(options: HarnessOptions = {}): Harness {
  const provided = new Map<string, unknown>()
  const rows = new Map<string, Json>()
  const puts: string[] = []
  const sections: PromptRegistration[] = []
  const contexts: PromptRegistration[] = []
  const effects: Array<() => unknown> = []
  const listenerMap = new Map<string, Array<(...args: unknown[]) => unknown>>()

  const table = {
    entries: (): Array<[string, Json]> => [...rows.entries()],
    get: (key: string): Json | undefined => rows.get(key),
    put: (key: string, value: Json): Promise<void> => {
      puts.push(key)
      rows.set(key, value)
      return Promise.resolve()
    },
    delete: (key: string): Promise<void> => {
      rows.delete(key)
      return Promise.resolve()
    },
  }

  const domain: Json = {
    table: (_name: string) => table,
    global: { get: (): unknown => null, set: (): void => {} },
    close: (): Promise<void> => Promise.resolve(),
  }

  const settings = { configure: (): (() => void) => () => {}, describe: (): Json[] => [] }

  /** ctx.effect：立刻执行回调，并保留它返回的清理函数（卸载时按逆序调用）。 */
  const registerEffect = (callback: () => unknown, _label = ''): (() => void) => {
    const cleanup = callback()
    effects.push(typeof cleanup === 'function' ? (cleanup as () => unknown) : () => {})
    return () => {}
  }

  const services: Record<string, unknown> = {
    tokenMeter: { estimateMessage: (): number => 42 },
    settings,
  }
  if (options.withStorage !== false) {
    services.storageDomain = { open: (): Promise<Json> => Promise.resolve(domain) }
  }
  // 故意不提供 sessionQuery（协议 §7：没有它时核心功能照常）。

  const ctx: Json = {
    get: (service: string): unknown => services[service],
    systemPrompt: {
      section: (registration: PromptRegistration): (() => void) => { sections.push(registration); return () => {} },
      context: (registration: PromptRegistration): (() => void) => { contexts.push(registration); return () => {} },
    },
    tools: { register: (): (() => void) => () => {} },
    commands: { register: (): (() => void) => () => {} },
    agents: { roots: (): unknown[] => [] },
    on: (event: string, listener: (...args: unknown[]) => unknown): (() => void) => {
      const list = listenerMap.get(event) ?? []
      list.push(listener)
      listenerMap.set(event, list)
      return () => {}
    },
    effect: registerEffect,
    inject: (_serviceNames: string[], callback: (scope: unknown) => void): (() => void) => {
      callback({ effect: registerEffect, settings })
      return () => {}
    },
  }
  if (options.withProvide !== false) {
    ctx.provide = (name: string, service: unknown): void => { provided.set(name, service) }
  }

  apply(ctx, options.config ?? {})

  const service = (): MemoryService => {
    const found = provided.get('memory')
    assert.ok(found, 'apply 必须 provide("memory") 服务')
    return found as MemoryService
  }

  const settle = async (ticks = 8): Promise<void> => {
    for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  const resident = (): string => [
    sections[0]?.text(),
    contexts[0]?.text({ agent: { session: { header: { cwd: null } } } }),
  ].map((value) => String(value ?? '')).join('\n')

  const dispose = async (): Promise<void> => {
    // 逆序释放：定时器也要清掉，否则 node --test 会挂在未关闭的 interval 上。
    for (const cleanup of [...effects].reverse()) {
      try {
        await cleanup()
      } catch { /* 卸载失败不影响测试结论 */ }
    }
  }

  return { ctx, provided, sections, contexts, effects, rows, puts, service, settle, resident, dispose }
}

// ---------------------------------------------------------------- 1. 服务面冻结

test('protocol#1 服务可获取：provide("memory") 一次，5 个方法都在（§2/§3）', (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  const names = [...harness.provided.keys()]
  assert.ok(names.includes('memory'), `服务定位名必须是 memory，实际提供了：${names.join(', ') || '（无）'}`)
  t.diagnostic(`apply 提供的服务名：${names.join(', ') || '（无）'}`)

  const surface = harness.service() as unknown as Record<string, unknown>
  for (const method of PROTOCOL_METHODS) {
    assert.equal(typeof surface[method], 'function', `协议 v1 承诺的方法必须存在且可调用：${method}`)
  }
  // §1「只做加法」：v1 内允许新增成员，但新增成员只能是方法（或 protocolVersion 字符串）。
  for (const [key, value] of Object.entries(surface)) {
    if (key === 'protocolVersion') continue
    assert.equal(typeof value, 'function', `服务面的新增成员必须是方法：${key}`)
  }

  assert.equal(harness.sections.length, 1, '常驻注入 section 通道必须注册一次')
  assert.equal(harness.contexts.length, 1, '常驻注入 context 通道必须注册一次')
})

// ---------------------------------------------------------------- 2. 签名与返回结构

test('protocol#2 每个方法的签名与返回结构（§3）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()
  const service = harness.service()

  // list()：数组，空库为空数组
  assert.ok(Array.isArray(service.list()), 'list() 返回数组')
  assert.equal(service.list().length, 0)

  // stats()：恰好三个字段
  const stats0 = service.stats()
  assert.deepEqual(Object.keys(stats0).sort(), ['opened', 'records', 'version'])
  assert.equal(stats0.records, 0)
  assert.equal(typeof stats0.version, 'number')
  assert.equal(stats0.opened, true, 'storageDomain 可用且 open 成功时 opened 必须是 true')

  // write()：成功面 { ok, status, id, record }
  const text = '协议自检：构建流程统一用 pnpm'
  const created = await service.write({ kind: 'semantic', text, origin: 'observed', subject: 'build.tool' })
  assert.equal(created.ok, true, 'write 成功必须 ok:true')
  assert.equal(created.status, 'created')
  assert.equal(typeof created.id, 'string')
  const record = created.record as Json
  assert.ok(record && typeof record === 'object', 'write 成功必须带完整 record')
  for (const key of REQUIRED_RECORD_KEYS) {
    assert.ok(key in record, `MemoryRecord 必填字段缺失：${key}`)
  }
  assert.equal(record.kind, 'semantic')
  assert.equal(record.status, 'active')
  assert.equal(record.text, text)
  assert.deepEqual(record.scope, { level: 'workspace', key: '*' })
  assert.deepEqual(record.tags, [])
  assert.equal(typeof record.hash, 'string')
  assert.ok(String(record.hash).length > 0, 'hash 不得为空')

  // list() / stats() 反映同一次写入
  const rows = service.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, created.id)
  const stats1 = service.stats()
  assert.equal(stats1.records, 1)
  assert.ok(stats1.version > stats0.version, 'version 是落盘版本号：一次写入后必须增长')

  // recall()：{ record, match, score }
  const hits = service.recall({ query: 'pnpm' })
  assert.ok(Array.isArray(hits))
  assert.equal(hits.length, 1, 'recall 必须命中刚写入的条目')
  const hit = hits[0]!
  assert.deepEqual(Object.keys(hit).sort(), ['match', 'record', 'score'])
  assert.equal(typeof hit.match, 'number')
  assert.equal(typeof hit.score, 'number')
  assert.equal(hit.record.id, created.id)
  assert.equal(service.recall({}).length, 1, '空查询 = 不按相关性过滤（返回全部 active）')

  // consolidate()：Promise<void>
  const consolidating = service.consolidate('protocol-test')
  assert.ok(consolidating && typeof (consolidating as Promise<void>).then === 'function', 'consolidate 返回 Promise')
  assert.equal(await consolidating, undefined, 'consolidate 成功时不返回载荷')
  assert.equal(service.stats().records, 1, 'consolidate 不得凭空增删记录')
})

// ---------------------------------------------------------------- 3. 错误形状

test('protocol#3 错误路径给结构化结果而不是抛（§3）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()
  const service = harness.service()

  // 空正文 → rejected_invalid
  const invalid = await service.write({ kind: 'semantic', text: '' })
  assert.equal(invalid.ok, false)
  assert.match(String(invalid.error), /^rejected_invalid: /u, `错误形状必须是「错误码: 说明」：${String(invalid.error)}`)

  // 敏感信息 → rejected_sensitive（硬秘密一律拒写）
  const sensitive = await service.write({ kind: 'user_profile', text: '数据库密码：hunter2xyz' })
  assert.equal(sensitive.ok, false)
  assert.match(String(sensitive.error), /^rejected_sensitive: /u)

  // origin=model_proposed 的"模型可见写入" → 服务面不吞异常、按结构化结果回报
  const malformed = await service.write({ text: '缺 kind 的一条正文' })
  assert.equal(typeof malformed.ok, 'boolean', '畸形入参要给结构化结果，不能抛')
  t.diagnostic(`缺 kind 的写入：ok=${String(malformed.ok)}，status=${String(malformed.status)}`)

  // 没有 storageDomain 的宿主：不抛；opened=false 是调用方判断"没落盘"的唯一手段（缺口见 §8）
  const bare = makeHarness({ withStorage: false })
  t.after(() => bare.dispose())
  await bare.settle()
  const noDomain = await bare.service().write({ kind: 'semantic', text: '领域未打开时的一条写入' })
  assert.equal(typeof noDomain.ok, 'boolean', '领域缺失时 write 不得抛')
  assert.equal(bare.service().stats().opened, false)
  t.diagnostic(`领域未打开：write.ok=${String(noDomain.ok)}，list=${bare.service().list().length}，落盘次数=${bare.puts.length}（§8 缺口 3）`)

  // 空库上的 recall / consolidate 同样不抛
  const fresh = makeHarness()
  t.after(() => fresh.dispose())
  await fresh.settle()
  assert.deepEqual(fresh.service().recall({ query: 'anything' }), [])
  await fresh.service().consolidate('protocol-empty')
})

// ---------------------------------------------------------------- 4. §4 载荷约定一：pending 不进注入

test('protocol#4 pending 绝不进注入路径（§4）', async (t) => {
  const harness = makeHarness({ config: { writePolicy: 'ask' } })
  t.after(() => harness.dispose())
  await harness.settle()
  const service = harness.service()

  const PENDING = '待确认的模型猜想：构建流程改用 bun 输出到 build 目录'
  const queued = await service.write({ kind: 'user_profile', text: PENDING, subject: 'build.tool' })
  assert.equal(queued.ok, true, '入队不是失败：调用方要能区分「已提议」与「被拒绝」')
  assert.equal(queued.pending, true)
  assert.equal(queued.status, undefined, 'pending 不是 created/merged：没有生效')
  assert.equal(typeof queued.id, 'string')

  // 反面证据：pending 确实在库里（`list()` 不过滤状态），所以下面的「看不到」不是假阴性
  const stored = service.list().filter((row) => row.id === queued.id)
  assert.equal(stored.length, 1)
  assert.equal(stored[0]!.status, 'pending')
  assert.ok(harness.puts.includes(String(queued.id)), 'pending 照常落盘')

  // 对照：同 scope 的 active 条目必须能渲染，否则「看不到 pending」可能只是因为块是空的
  const control = await service.write({ kind: 'user_profile', origin: 'observed', text: '对照记录：这个项目的构建与产物目录约定' })
  assert.equal(control.ok, true)

  assert.equal(harness.sections.length, 1, '常驻注入 section 通道必须注册一次')
  assert.equal(harness.contexts.length, 1, '常驻注入 context 通道必须注册一次')
  const resident = harness.resident()
  assert.ok(resident.includes('对照记录'), `常驻块必须能渲染 active 条目：${resident}`)
  assert.ok(!resident.includes('待确认的模型猜想'), `常驻块不得出现 pending：${resident}`)

  // 服务面自己的召回路径同样不得命中 pending
  assert.equal(service.recall({ query: 'bun' }).length, 0, 'recall 不得命中 pending')
  assert.equal(service.recall({}).filter((entry) => entry.record.status === 'pending').length, 0, 'recall 只返回 active')
})

// ---------------------------------------------------------------- 5. §4 载荷约定二：refs 不进指纹

test('protocol#5 refs 不改指纹：正文相同 + 引用不同 → 同一条（§4）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()
  const service = harness.service()

  const text = '同一条正文只应存在一次（引用不参与指纹）'
  const first = await service.write({
    kind: 'semantic', text, subject: 'refs.probe', refs: [{ sessionId: 'session-a', from: 1 }],
  })
  assert.equal(first.ok, true)
  assert.equal(first.status, 'created')
  const refs1 = (first.record as Json).refs as Json[]
  assert.equal(refs1.length, 1, '引用必须真的附着，否则本用例是空的')
  assert.equal(refs1[0]!.sessionId, 'session-a')

  const second = await service.write({
    kind: 'semantic', text, subject: 'refs.probe', refs: [{ sessionId: 'session-b', from: 9 }],
  })
  assert.equal(second.ok, true)
  assert.equal(second.status, 'merged', '正文相同、只有引用不同 → 合并成同一条，不是两条')
  assert.equal(second.id, first.id)
  assert.equal(service.list().length, 1, '库里仍然只有一条')
  const refs2 = (second.record as Json).refs as Json[]
  assert.equal(refs2.length, 2, '合并时新引用并入既有条目、旧引用保留')
  assert.equal(refs2[0]!.sessionId, 'session-b', '新引用在前')
  assert.equal((first.record as Json).hash, (second.record as Json).hash, '指纹不因引用而改变')
})

// ---------------------------------------------------------------- 6. §4 载荷约定三：branch 进指纹

test('protocol#6 branch 改指纹：正文相同 + 分支不同 → 两条（§4）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()
  const service = harness.service()

  const text = '只在某个分支成立的临时约定正文'
  const a = await service.write({ kind: 'semantic', text, subject: 'branch.probe', branch: 'feature/a' })
  const b = await service.write({ kind: 'semantic', text, subject: 'branch.probe', branch: 'feature/b' })
  assert.equal(a.status, 'created')
  assert.equal(b.status, 'created', '分支不同 → 不是同一条（branch 参与指纹）')
  assert.notEqual(a.id, b.id)
  assert.notEqual((a.record as Json).hash, (b.record as Json).hash, '两条的指纹必须不同')
  assert.equal((a.record as Json).branch, 'feature/a')
  assert.equal(service.list().length, 2)

  // 对照：不打标签的同一正文不与带标签的两条合并（三者的指纹互不相同）
  const plain = await service.write({ kind: 'semantic', text, subject: 'branch.probe' })
  assert.equal(plain.status, 'created')
  assert.equal(service.list().length, 3)
  assert.ok(!('branch' in (plain.record as Json)), '未打标签的记录不得出现 branch 键（§3「缺失时不写键」）')
})

// ---------------------------------------------------------------- 7. §2 可选性

test('protocol#7 宿主没有 provide 时 apply 照常工作，调用方必须处理缺席（§2）', async (t) => {
  const harness = makeHarness({ withProvide: false })
  t.after(() => harness.dispose())
  await harness.settle()

  assert.equal(harness.provided.size, 0, '没有 provide 的宿主上不该凭空出现服务')
  const getService = harness.ctx.get as (name: string) => unknown
  assert.equal(getService('memory'), undefined, "调用方的正确姿势：`ctx.get('memory')` 可能是 undefined")
  assert.equal(harness.sections.length, 1, '服务面缺席不影响注入通道注册')
  assert.equal(harness.contexts.length, 1)
})

// ---------------------------------------------------------------- 8. §5 配置面

test('protocol#8 volatile 配置以访问器下发，服务读到的必须是解包后的标量（§5）', async (t) => {
  const harness = makeHarness({ config: { writePolicy: volatile('off') } })
  t.after(() => harness.dispose())
  await harness.settle()

  // 若解包失败，writePolicy 会是对象 → decideModelWrite 回落到 'apply'，这条断言就会红。
  const result = await harness.service().write({ kind: 'semantic', text: '模型来源的一条写入' })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /^rejected_write_policy: /u)
})

// ---------------------------------------------------------------- 9. 可选字段形状

test('protocol#9 可选字段「缺失时不写键」，显式给出才出现（§3/§4）', async (t) => {
  const harness = makeHarness({ config: { writePolicy: 'ask' } })
  t.after(() => harness.dispose())
  await harness.settle()
  const service = harness.service()

  // 走队列路径：不跑自画像收敛，记录形状直接可见
  const bare = await service.write({ kind: 'semantic', text: '可选字段形状探针的一条正文', subject: 'shape.probe' })
  assert.equal(bare.pending, true)
  const bareRow = service.list().find((row) => row.id === bare.id)!
  assert.ok(bareRow, 'pending 记录必须在库里可见')
  for (const key of OPTIONAL_RECORD_KEYS) {
    assert.ok(!(key in bareRow), `未显式提供的可选字段不得出现在记录里：${key}`)
  }

  const withFacet = await service.write({ kind: 'agent_self', facet: 'work', text: '我在动手改代码前会先跑通最小验证路径。' })
  assert.equal(withFacet.pending, true)
  const facetRow = service.list().find((row) => row.id === withFacet.id)!
  assert.equal(facetRow.facet, 'work', '显式给出的 facet 必须落键')
})

// ---------------------------------------------------------------- 10. §1 版本标识

test('protocol#10 §1 版本标识：服务面当前没有 protocolVersion（缺口见报告）', (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  const surface = harness.service() as unknown as Record<string, unknown>
  const version = surface.protocolVersion
  if (version === undefined) {
    t.diagnostic('服务面未暴露 protocolVersion —— v1 目前只能靠方法名 + 记录形状识别（§8 缺口 1）')
  } else {
    assert.equal(typeof version, 'string', 'protocolVersion 必须是字符串')
    assert.match(String(version), /^1\./u, "protocolVersion 必须形如 '1.x'")
  }
  // 无论有没有版本字段，第三方定位服务的唯一方式都必须是可用的
  assert.equal(typeof surface.list, 'function')
})

// ---------------------------------------------------------------- 11. 文档与实现一致

test('protocol#11 两份协议文档逐节对齐，并点名 5 个方法（§1）', () => {
  const en = readFileSync(new URL('../docs/protocol-v1.md', import.meta.url), 'utf8')
  const zh = readFileSync(new URL('../docs/protocol-v1.zh.md', import.meta.url), 'utf8')
  const headingsOf = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('## '))

  assert.equal(
    headingsOf(zh).length,
    headingsOf(en).length,
    `中英两份文档必须逐节对齐（## 数量）：en=${headingsOf(en).length}，zh=${headingsOf(zh).length}`,
  )
  for (const doc of [en, zh]) {
    for (const method of PROTOCOL_METHODS) assert.ok(doc.includes(method), `文档必须点名方法：${method}`)
    assert.ok(doc.includes("ctx.get('memory')"), "文档必须写清服务定位方式：ctx.get('memory')")
  }
  // 本机绝对路径（`<盘符>:\…`）：协议文档是公开的，不得混进任何人的机器路径。
  assert.doesNotMatch(en + zh, /\b[A-Za-z]:\\/u, '文档不得出现本机绝对路径')
})

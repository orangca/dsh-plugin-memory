// `ctx.memory` 服务协议 v1（自 0.5.18 起为 **v1.1**）的一致性套件：把 docs/protocol-v1.md（英文）与
// docs/protocol-v1.zh.md（中文）承诺的东西**逐条钉在真实实现上**。
//
// 与 host.test.ts 同一套路：导入构建产物 `lib/index.js`，用假 ctx 驱动，不依赖真实宿主。
// 与 host.test.ts 的分工：这里只断言**协议文档 §2–§5** 的内容，不重复功能回归。
// 「文档说了但实现没做到」一律红在这里 —— 不改 src 去迎合，也不把断言写松。
//
// 历史缺口（协议文档 §8 有完整清单，含处置结论）：
//   · 服务面没有 `protocolVersion` → **已修**（v1.1 用例 #12 直接断言 `'1.1'`）；
//   · `write` 不校验入参 → **已修**（服务面补最小校验，拒绝返回 `rejected_invalid`）；
//   · `list()` / `recall()` 默认仍是未过滤的原始视图 → **保留为已声明行为**，
//     但 v1.1 起可传 `status` / `branch` 显式过滤（用例 #14–#17）；
//   · 领域未打开时 `write` 仍返回 `ok: true` → **保留该语义**，v1.1 起用 `persisted` 如实区分
//     （用例 #19）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { apply as applyRaw } from '../lib/index.js'
// 仅 v1.1 用例使用：假 git 目录（`<dir>/.git/HEAD`，零 shell）与发布集清单。
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  /** M17（协议 v1.2 §2）：三个既有字段之上追加 `writes`（#2 已同步为新字段清单）。 */
  stats(): { records: number; version: number; opened: boolean; writes: { persisted: number; unpersisted: number } }
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

  // stats()：v1.2 起是四个字段（v1.1 的三个 + writes）。v1.3 §2 再追加 `embedder`，因此本清单同步为
  // 五个键（见本节末尾「既有断言同步」说明）—— 既有四个字段的名字与语义仍一字不改。
  const stats0 = service.stats()
  assert.deepEqual(
    Object.keys(stats0).sort(),
    ['embedder', 'opened', 'records', 'version', 'writes'],
    'protocol v1.3 §2：stats() 在既有四个字段之上追加 embedder（既有字段本身由 #19/#23 钉住）',
  )
  assert.deepEqual(stats0.writes, { persisted: 0, unpersisted: 0 }, '空库、零写入时两个计数都必须是 0（不是缺键）')
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

// ================================================================ v1.1：契约 docs/protocol-v1.1-changes.md §1–§5
//
// 本节**纯追加**：上面 11 项一字未改。文件顶部「已知缺口」里的前两条由 v1.1 关闭 ——
//   · 服务面已有 `protocolVersion`（#10 的条件断言保持原样，硬断言落在 #12）；
//   · `list()` / `recall()` 支持显式 `status` / `branch`（`list` 还有 `limit`）（#13–#18）。
// 三条纪律：
//   ① 无参调用必须与 0.5.17 逐字节相同（顺序 / 内容 / **活对象**）—— #13 先把缺省面钉死；
//   ② 新参数只影响显式调用；两条注入通道（常驻自画像块 + 按轮召回块）一字不变 —— #16/#18；
//   ③ archived / invalid 由**真实** `consolidate()` 产生（近似正文合并 → 归档；同 subject+field 冲突 → 失效），
//      不手改状态字段，好让断言钉在真实实现上。

/** v1.1 服务面：v1 的 5 个方法之上补 `protocolVersion` 与可选过滤参数（契约 §1/§2）。 */
interface V11Service {
  protocolVersion?: unknown
  /** v1.2 §1 起 `branch` 还接受字符串数组；这里是 v1.1 视图，写法仍按字符串/null。 */
  list(options?: { status?: string; branch?: string | readonly string[] | null; limit?: number }): Json[]
  /** v1.2 §2 起 stats() 带 `writes` —— 本视图同步，避免测试类型落后于契约。 */
  stats(): { records: number; version: number; opened: boolean; writes: { persisted: number; unpersisted: number } }
  recall(options?: Json): Array<{ record: Json; match: number; score: number }>
  write(input: Json): Promise<Json>
  consolidate(reason?: string): Promise<void>
}

interface V11HarnessOptions {
  config?: Json
  /** false = 宿主没有 `ctx.storageDomain`（领域打不开 ⇒ `persisted` 必须是 false）。 */
  withStorage?: boolean
  /** true = 领域打开但 `put` 直接抛错（契约 §3 的第二种「没落盘」）。 */
  putFails?: boolean
}

interface V11Harness {
  provided: Map<string, unknown>
  sections: PromptRegistration[]
  contexts: PromptRegistration[]
  effects: Array<() => unknown>
  /** 假领域的落盘记录（key = 记录 id；值是**库内活对象本身**）。 */
  rows: Map<string, Json>
  puts: string[]
  service(): V11Service
  settle(ticks?: number): Promise<void>
  /** 触发宿主事件：本套件只需要 `session/event` 把 cwd 灌进 `state.lastSession`。 */
  emit(event: string, session: unknown, payload: unknown): void
  /** 常驻自画像块（section 通道）的真实渲染文本。 */
  selfBlock(): string
  /** 按轮召回块（context 通道）的真实渲染文本；cwd 只作装配上下文回落。 */
  contextBlock(cwd: string | null): string
  dispose(): Promise<void>
}

/**
 * v1.1 用例专用假 ctx：与 `makeHarness` 同构，另加两件事 ——
 *   · `emit()`：把 `session/event` 真正派发给 apply 注册的监听器（#16 要靠它设当前 cwd）；
 *   · `putFails`：让存储 `put` 抛错（契约 §3 的「put 抛错 ⇒ persisted:false 而 ok 仍 true」）。
 */
function makeV11Harness(options: V11HarnessOptions = {}): V11Harness {
  const provided = new Map<string, unknown>()
  const rows = new Map<string, Json>()
  const puts: string[] = []
  const sections: PromptRegistration[] = []
  const contexts: PromptRegistration[] = []
  const effects: Array<() => unknown> = []
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()

  const table = {
    entries: (): Array<[string, Json]> => [...rows.entries()],
    get: (key: string): Json | undefined => rows.get(key),
    put: (key: string, value: Json): Promise<void> => {
      if (options.putFails === true) return Promise.reject(new Error('put failed (fault injection)'))
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
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect: registerEffect,
    inject: (_serviceNames: string[], callback: (scope: unknown) => void): (() => void) => {
      callback({ effect: registerEffect, settings })
      return () => {}
    },
    provide: (name: string, service: unknown): void => { provided.set(name, service) },
  }

  apply(ctx, options.config ?? {})

  const service = (): V11Service => {
    const found = provided.get('memory')
    assert.ok(found, 'apply 必须 provide("memory") 服务')
    return found as V11Service
  }
  const settle = async (ticks = 8): Promise<void> => {
    for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  const emit = (event: string, session: unknown, payload: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(session, payload)
  }
  const selfBlock = (): string => String(sections[0]?.text() ?? '')
  const contextBlock = (cwd: string | null): string =>
    String(contexts[0]?.text({ agent: { session: { header: { cwd } } } }) ?? '')
  const dispose = async (): Promise<void> => {
    for (const cleanup of [...effects].reverse()) {
      try {
        await cleanup()
      } catch { /* 卸载失败不影响测试结论 */ }
    }
  }

  return { provided, sections, contexts, effects, rows, puts, service, settle, emit, selfBlock, contextBlock, dispose }
}

/** 记录 id 列表（按给定顺序）。 */
const idsOf = (rows: readonly Json[]): string[] => rows.map((row) => String(row.id))

/** 召回命中的记录 id 列表（`RecallHit` 的形状是 `{ record, match, score }`）。 */
const hitIds = (hits: ReadonlyArray<{ record: Json }>): string[] => hits.map((hit) => String(hit.record.id))

/** 当前分支探针：`<dir>/.git/HEAD` 指向它。临时目录在运行期生成，源码里不出现任何机器路径。 */
const V11_BRANCH = 'protocol/v11-probe'
const V11_OTHER_BRANCH = 'protocol/v11-other'

/** 探针正文：每条都在断言里被点名，改文案必须同步改断言。 */
const V11_TEXT = {
  untaggedProfile: '无分支标签的画像记录：作答先给结论、再补理由。',
  matchedProfile: '当前分支下的画像记录：构建产物统一输出到 build 目录。',
  otherProfile: '其它分支下的画像记录：构建产物统一输出到 dist 目录。',
  matchedPortrait: '动手改代码之前先跑通一条最小验证路径。',
  otherPortrait: '提交之前重读一遍自己改过的每一行。',
  pending: '待确认的模型猜想：测试也许应该换成 bun 运行。',
  mergedLead: '构建流程统一使用 pnpm 作为包管理器。',
  mergedDup: '构建流程统一使用 pnpm 作为包管理器，不要用 npm。',
  conflictLead: '包管理器这一项的取值是 pnpm。',
  conflictDup: '产物目录另有约定，放在仓库根的 build 下。',
} as const

/** 假 git 仓库：只写一份 `.git/HEAD`（插件零 shell，按文件内容解析分支）。 */
function makeBranchDir(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-v11-'))
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  return dir
}

interface V11Library {
  /** 写入顺序：无参 `list()` 必须与它逐条同序。 */
  all: string[]
  untaggedProfile: string
  matchedProfile: string
  otherProfile: string
  matchedPortrait: string
  otherPortrait: string
  pending: string
  /** 真实合并对：`consolidate()` 后**恰有一条**变 archived。 */
  merged: string[]
  /** 真实冲突对：`consolidate()` 后**恰有一条**变 invalid。 */
  conflict: string[]
}

/**
 * 造一座「四态齐全」的库，全部经真实写路径 + 一次真实 `consolidate()`：
 *   · active：无标签 / 当前分支 / 其它分支的画像各一条 + 当前分支 / 其它分支的自画像各一条
 *     （前两条供按轮召回块，后两条供常驻自画像块，好让「注入不受新参数影响」不是空断言）；
 *   · pending：`writePolicy: 'ask'` 下模型来源（服务面默认 origin）写入入队；
 *   · archived：同 subject + 近似正文两条 → 合并时被归档（不删除）；
 *   · invalid：同 subject + 同 field、value 不同两条 → 冲突时被置失效（可恢复）。
 * 分支标签与 cwd 的对照由调用方决定（先 `emit('session/event', …)` 再建库即可）。
 */
async function buildV11Library(harness: V11Harness): Promise<V11Library> {
  const write = (input: Json): Promise<Json> => harness.service().write(input)
  const profileScope = { level: 'profile', key: '*' }

  const untaggedProfile = await write({ kind: 'user_profile', origin: 'observed', scope: profileScope, confidence: 0.9, importance: 0.95, subject: 'v11.profile.untagged', text: V11_TEXT.untaggedProfile })
  const matchedProfile = await write({ kind: 'user_profile', origin: 'observed', scope: profileScope, confidence: 0.9, importance: 0.9, subject: 'v11.profile.matched', branch: V11_BRANCH, text: V11_TEXT.matchedProfile })
  const otherProfile = await write({ kind: 'user_profile', origin: 'observed', scope: profileScope, confidence: 0.9, importance: 0.9, subject: 'v11.profile.other', branch: V11_OTHER_BRANCH, text: V11_TEXT.otherProfile })
  const matchedPortrait = await write({ kind: 'agent_self', facet: 'work', origin: 'user_explicit', confidence: 0.95, importance: 0.95, subject: 'v11.self.matched', branch: V11_BRANCH, text: V11_TEXT.matchedPortrait })
  const otherPortrait = await write({ kind: 'agent_self', facet: 'work', origin: 'user_explicit', confidence: 0.95, importance: 0.95, subject: 'v11.self.other', branch: V11_OTHER_BRANCH, text: V11_TEXT.otherPortrait })
  const pending = await write({ kind: 'semantic', subject: 'v11.pending', text: V11_TEXT.pending })
  assert.equal(pending.pending, true, '前置条件：writePolicy=ask 时模型来源写入必须入队（否则库里没有 pending）')
  const mergedA = await write({ kind: 'semantic', origin: 'observed', subject: 'v11.merge', text: V11_TEXT.mergedLead })
  const mergedB = await write({ kind: 'semantic', origin: 'observed', subject: 'v11.merge', text: V11_TEXT.mergedDup })
  const conflictA = await write({ kind: 'semantic', origin: 'observed', subject: 'v11.conflict', field: 'manager', value: 'pnpm', text: V11_TEXT.conflictLead })
  const conflictB = await write({ kind: 'semantic', origin: 'observed', subject: 'v11.conflict', field: 'manager', value: 'yarn', text: V11_TEXT.conflictDup })

  const all = [untaggedProfile, matchedProfile, otherProfile, matchedPortrait, otherPortrait, pending, mergedA, mergedB, conflictA, conflictB]
    .map((result) => String(result.id))
  assert.equal(harness.service().stats().opened, true, '前置条件：库必须真的打开（否则 archived/invalid 无从产生）')
  await harness.service().consolidate('protocol-v1.1-probe')

  return {
    all,
    untaggedProfile: String(untaggedProfile.id),
    matchedProfile: String(matchedProfile.id),
    otherProfile: String(otherProfile.id),
    matchedPortrait: String(matchedPortrait.id),
    otherPortrait: String(otherPortrait.id),
    pending: String(pending.id),
    merged: [String(mergedA.id), String(mergedB.id)],
    conflict: [String(conflictA.id), String(conflictB.id)],
  }
}

// ---------------------------------------------------------------- 12. §1 协议版本

test('protocol#12 服务面 protocolVersion === \'1.3\'（契约 §1；调用方按 1.x 判断）', async (t) => {
  const harness = makeV11Harness({ config: { consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  const version = harness.service().protocolVersion
  // v1.3 把字面量从 '1.2' 推到 '1.3'（契约 docs/embedder.md 抬头；docs/protocol-v1.md §11 亦如此声明）。
  assert.equal(version, '1.3', "v1 之内只做加法 ⇒ 1.0 → 1.1 → 1.2 → 1.3（docs/protocol-v1.md §11）")
  assert.match(String(version), /^1\.[0-9]+$/u, "protocolVersion 必须形如 '1.x'，第三方据此判断可用面")
})

// ---------------------------------------------------------------- 13. §1 无参向后兼容

test('protocol#13 list() 无参与 0.5.17 等价：顺序/内容/活对象，含 pending/invalid/archived 原始视图（§1）', async (t) => {
  const harness = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  const library = await buildV11Library(harness)
  const service = harness.service()

  // 落盘视图（`put` 收到的是库内活对象本身）＝无参返回值的独立对照。
  const persisted = [...harness.rows.values()]
  const rows = service.list()
  assert.equal(rows.length, harness.rows.size, '无参必须返回库内全部记录（一条都不许吞）')
  assert.deepEqual(idsOf(rows), library.all, '无参必须保持插入顺序（0.5.17 的 [...records.values()]）')
  for (let index = 0; index < persisted.length; index += 1) {
    assert.equal(rows[index], persisted[index], `无参第 ${index} 条必须是库内活对象本身，不是快照副本`)
  }
  const statuses = rows.map((row) => String(row.status))
  for (const status of ['active', 'pending', 'invalid', 'archived']) {
    assert.ok(statuses.includes(status), `无参的原始视图必须含 ${status}（0.5.17 不过滤任何状态）`)
  }
  assert.equal(rows.length, library.all.length)

  // 「三个参数都不生效」的写法必须与无参逐字节相同（元素还得是同一批活对象）。
  const noopOptions: Array<[string, { status?: string; branch?: string | null; limit?: number }]> = [
    ['空对象', {}],
    ['status: all', { status: 'all' }],
    ['branch: null', { branch: null }],
    ['非法 limit: 0', { limit: 0 }],
    ['非法 limit: -3', { limit: -3 }],
    ['非法 limit: NaN', { limit: Number.NaN }],
  ]
  for (const [label, options] of noopOptions) {
    const same = service.list(options)
    assert.equal(same.length, rows.length, `${label} 必须与无参同长度`)
    for (let index = 0; index < rows.length; index += 1) {
      assert.equal(same[index], rows[index], `${label} 第 ${index} 条必须与无参同对象`)
    }
    assert.equal(JSON.stringify(same), JSON.stringify(rows), `${label} 必须与无参逐字节相同`)
  }
})

// ---------------------------------------------------------------- 14. §1 status 各档

test('protocol#14 list({status}) 四档互斥且并集＝无参；active 不含 pending；all 与无参同序同对象（§1/§4.3）', async (t) => {
  const harness = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  const library = await buildV11Library(harness)
  const service = harness.service()

  const all = service.list()
  const putsBefore = harness.puts.length
  const tiers = {
    active: service.list({ status: 'active' }),
    pending: service.list({ status: 'pending' }),
    invalid: service.list({ status: 'invalid' }),
    archived: service.list({ status: 'archived' }),
  }

  for (const [status, tier] of Object.entries(tiers)) {
    assert.ok(tier.length > 0, `${status} 档必须非空，否则这条用例是空的`)
    for (const row of tier) assert.equal(row.status, status, `${status} 档只能含 ${status}，实际含 ${String(row.status)}`)
    assert.deepEqual(
      idsOf(tier),
      idsOf(all.filter((row) => row.status === status)),
      `${status} 档必须保持无参顺序（过滤只影响返回集合）`,
    )
  }

  // 四档互斥，并集恰好是无参视图 —— 既不多也不少。
  const seen = new Set<string>()
  for (const tier of Object.values(tiers)) {
    for (const row of tier) {
      const id = String(row.id)
      assert.ok(!seen.has(id), `状态档之间不得重叠：${id}`)
      seen.add(id)
    }
  }
  assert.deepEqual([...seen].sort(), idsOf(all).sort(), '四档并集必须恰好等于无参视图')

  // §4.3 的载荷约定：active 不得含 pending；pending 只在显式查询里出现。
  assert.equal(tiers.active.some((row) => row.status === 'pending'), false, 'active 不得含 pending（§4.3）')
  assert.ok(idsOf(tiers.pending).includes(library.pending), 'pending 档必须含待确认记录')
  assert.equal(tiers.pending.length, 1, '本库里 pending 只有一条')
  assert.equal(
    idsOf(tiers.active).includes(library.pending), false,
    'pending 记录不得混进 active 档（不得因为「只是过滤」就顺手放行）',
  )

  // archived / invalid 由真实 consolidate() 产生：合并对恰一条归档、冲突对恰一条失效。
  const archivedIds = idsOf(tiers.archived)
  const invalidIds = idsOf(tiers.invalid)
  assert.equal(library.merged.filter((id) => archivedIds.includes(id)).length, 1, '真实合并对被归档的恰有一条')
  assert.equal(library.conflict.filter((id) => invalidIds.includes(id)).length, 1, '真实冲突对被失效的恰有一条')

  // all 与无参同集合、同顺序、同对象。
  const allTier = service.list({ status: 'all' })
  assert.deepEqual(idsOf(allTier), idsOf(all), 'status:all 与无参同顺序')
  for (let index = 0; index < all.length; index += 1) {
    assert.equal(allTier[index], all[index], 'status:all 与无参必须是同一批活对象')
  }
  assert.deepEqual(service.list().map((row) => row.status), all.map((row) => row.status), '过滤不得改任何状态')
  assert.equal(harness.puts.length, putsBefore, '显式过滤不得产生任何额外落盘（过滤只是读）')
})

// ---------------------------------------------------------------- 15. §1 limit

test('protocol#15 list({limit})：>=1 按当前顺序截断，0/负数/NaN 忽略；与 status 组合时先过滤再截断（§1）', async (t) => {
  const harness = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  await buildV11Library(harness)
  const service = harness.service()

  const all = service.list()
  assert.ok(all.length >= 3, '前置条件：库里至少三条，limit 断言才有意义')
  assert.deepEqual(idsOf(service.list({ limit: 1 })), idsOf(all.slice(0, 1)), 'limit=1 取当前顺序第一条')
  assert.deepEqual(idsOf(service.list({ limit: 2 })), idsOf(all.slice(0, 2)), 'limit=2 取前两条')
  assert.deepEqual(idsOf(service.list({ limit: 3 })), idsOf(all.slice(0, 3)), 'limit=3 取前三条')
  assert.deepEqual(idsOf(service.list({ limit: 99 })), idsOf(all), 'limit 超过条数＝全部（不是补空）')

  for (const [label, options] of [
    ['limit: 0', { limit: 0 }],
    ['limit: -3', { limit: -3 }],
    ['limit: NaN', { limit: Number.NaN }],
  ] as Array<[string, { limit: number }]>) {
    const same = service.list(options)
    assert.equal(same.length, all.length, `${label} 是非法值 ⇒ 忽略（不是返回空）`)
    for (let index = 0; index < all.length; index += 1) {
      assert.equal(same[index], all[index], `${label} 第 ${index} 条必须与无参同对象`)
    }
  }

  // 组合：先按 status 过滤，再截断（顺序仍是无参顺序里的相对顺序）。
  const active = service.list({ status: 'active' })
  assert.deepEqual(idsOf(service.list({ status: 'active', limit: 1 })), idsOf(active.slice(0, 1)), '先过滤再截断')
  assert.deepEqual(idsOf(service.list({ status: 'pending', limit: 1 })), idsOf(service.list({ status: 'pending' })), 'pending 档只有一条，limit 不改变它')
})

// ---------------------------------------------------------------- 16. §1 branch

test("protocol#16 list({branch})：'current' 走 branchVisible 与注入同口径，显式分支只保留 branchOf 相等（§1）", async (t) => {
  const dir = makeBranchDir(V11_BRANCH)
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // A：宿主已把 cwd 灌进来（session/event）——`'current'` 与两条注入通道看的是同一个分支。
  const harness = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  harness.emit('session/event', { id: 'session-v11', header: { cwd: dir } }, { type: 'session/start', seq: 1 })
  const library = await buildV11Library(harness)
  const service = harness.service()

  const expectCurrent = library.all.filter((id) => id !== library.otherProfile && id !== library.otherPortrait)
  assert.deepEqual(
    idsOf(service.list({ branch: 'current' })),
    expectCurrent,
    "list({branch:'current'}) = 无标签记录 + 当前分支记录（分支过滤不看状态：pending/invalid/archived 也在）",
  )
  assert.deepEqual(
    idsOf(service.list({ branch: V11_BRANCH })),
    [library.matchedProfile, library.matchedPortrait],
    '显式分支名只保留 branchOf 恰好相等的记录（无标签的不算）',
  )
  assert.deepEqual(
    idsOf(service.list({ branch: V11_OTHER_BRANCH })),
    [library.otherProfile, library.otherPortrait],
    '显式分支名不得混入其它分支或无标签记录',
  )
  assert.deepEqual(idsOf(service.list({ branch: null })), idsOf(service.list()), 'branch:null ＝ 不过滤（0.5.17 行为）')

  // 与两条注入通道同口径：当前分支的条目必须出现，其它分支的一条都不许出现。
  const self = harness.selfBlock()
  assert.ok(self.includes(V11_TEXT.matchedPortrait), `常驻自画像块必须渲染当前分支的合规条目：${self}`)
  assert.equal(self.includes(V11_TEXT.otherPortrait), false, '常驻自画像块不得渲染其它分支的条目')
  const context = harness.contextBlock(null)
  assert.ok(context.includes(V11_TEXT.matchedProfile), `按轮召回块必须渲染当前分支的画像条目：${context}`)
  assert.ok(context.includes(V11_TEXT.untaggedProfile), '无标签记录在任何分支下都照常注入')
  assert.equal(context.includes(V11_TEXT.otherProfile), false, '按轮召回块不得渲染其它分支的条目')

  // B：分支未知（宿主从未报过 cwd）——fail-closed：带标签的记录一条都不保留。
  const bare = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => bare.dispose())
  await bare.settle()
  const bareLibrary = await buildV11Library(bare)
  const bareService = bare.service()
  assert.deepEqual(
    idsOf(bareService.list({ branch: 'current' })),
    bareLibrary.all.filter((id) => id !== bareLibrary.matchedProfile && id !== bareLibrary.otherProfile
      && id !== bareLibrary.matchedPortrait && id !== bareLibrary.otherPortrait),
    '分支未知 ⇒ current 只保留无标签记录（fail-closed，与 section 通道口径一致）',
  )
  assert.equal(bare.selfBlock().includes(V11_TEXT.matchedPortrait), false, '分支未知时自画像块同样不注入带标签条目')
  // context 通道自己带 cwd ⇒ 仍能解析当前分支，与显式分支名同口径。
  const bareContext = bare.contextBlock(dir)
  assert.ok(bareContext.includes(V11_TEXT.matchedProfile), 'context 通道带 cwd 时必须按 branchVisible 解析当前分支')
  assert.equal(bareContext.includes(V11_TEXT.otherProfile), false, 'context 通道不得渲染其它分支的条目')
})

// ---------------------------------------------------------------- 17. §2 recall 新参数

test("protocol#17 recall({status})/recall({branch}) 生效：能取到 pending，branch 与 list 同口径（§2）", async (t) => {
  const dir = makeBranchDir(V11_BRANCH)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const harness = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  harness.emit('session/event', { id: 'session-v11', header: { cwd: dir } }, { type: 'session/start', seq: 1 })
  const library = await buildV11Library(harness)
  const service = harness.service()
  const scoped = (options: Json): Array<{ record: Json; match: number; score: number }> => service.recall({ limit: 50, ...options })

  // 缺省（不传 status/branch）＝ 0.5.17 行为：只收 active。
  const plain = service.recall({ query: '', limit: 50 })
  assert.equal(plain.some((hit) => hit.record.status !== 'active'), false, '缺省召回只返回 active（0.5.17 行为不变）')
  assert.deepEqual(hitIds(scoped({ query: '' })).sort(), hitIds(scoped({ query: '', status: 'active' })).sort(), 'status:active 与缺省同集合')

  // 显式 pending：这是允许的管理/审计查询，必须能取到待确认记录本身（活对象）。
  const pendingHits = scoped({ query: '', status: 'pending' })
  assert.equal(pendingHits.length, 1, 'pending 档必须恰好取到那条待确认记录')
  assert.deepEqual(hitIds(pendingHits), [library.pending], 'pending 档取到的必须是待确认记录')
  assert.equal(pendingHits[0].record.status, 'pending', '返回的必须是库里的活对象（status 不被改写）')
  assert.equal(pendingHits[0].record, harness.rows.get(library.pending), '必须是库内活对象本身，不是副本')
  assert.equal(pendingHits[0].record.text, V11_TEXT.pending)

  // status 各档与 list 同集合；all ＝ 四态全收但排序口径不变。
  const activeHits = scoped({ query: '', status: 'active' })
  assert.equal(activeHits.some((hit) => hit.record.status !== 'active'), false, 'active 档不得混入其它状态')
  assert.equal(hitIds(activeHits).includes(library.pending), false, 'active 档不得含 pending')
  assert.deepEqual(
    hitIds(scoped({ query: '', status: 'all' })).sort(),
    idsOf(service.list()).sort(),
    "status:'all' = active + pending + invalid + archived 全收（排序口径不变，只比集合）",
  )
  assert.deepEqual(
    hitIds(scoped({ query: '', status: 'invalid' })).sort(),
    idsOf(service.list({ status: 'invalid' })).sort(),
    'invalid 档与 list 同集合',
  )

  // branch：与 list 的 branch 完全一致；缺省 status 仍只收 active。
  const currentHits = scoped({ query: '', branch: 'current' })
  assert.deepEqual(
    hitIds(currentHits).sort(),
    idsOf(service.list({ status: 'active', branch: 'current' })).sort(),
    "recall({branch:'current'}) 的候选池 = list({branch:'current'}) 里的 active 子集（同口径 + 缺省只收 active）",
  )
  assert.ok(hitIds(currentHits).includes(library.matchedProfile), '当前分支的画像必须能召回到')
  assert.equal(hitIds(currentHits).includes(library.otherProfile), false, '其它分支的记录不得被召回')
  assert.deepEqual(
    hitIds(scoped({ query: '', branch: V11_OTHER_BRANCH })).sort(),
    [library.otherProfile, library.otherPortrait].sort(),
    '显式分支名只保留 branchOf 恰好相等的记录',
  )
  assert.deepEqual(hitIds(scoped({ query: '', branch: null })).sort(), hitIds(activeHits).sort(), 'branch:null ＝ 不过滤')
  assert.deepEqual(
    hitIds(scoped({ query: '', branch: 'current', status: 'pending' })).sort(),
    [library.pending].sort(),
    'branch 与 status 可组合（无标签的 pending 在当前分支下可见）',
  )
})

// ---------------------------------------------------------------- 18. §2 注入路径不受影响

test('protocol#18 注入路径不受新参数影响：常驻自画像块与按轮召回块逐字节不变（§2 硬约束）', async (t) => {
  const dir = makeBranchDir(V11_BRANCH)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const harness = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  harness.emit('session/event', { id: 'session-v11', header: { cwd: dir } }, { type: 'session/start', seq: 1 })
  await buildV11Library(harness)
  const service = harness.service()

  const plainBefore = hitIds(service.recall({ query: '', limit: 50 })).sort()
  const selfBefore = harness.selfBlock()
  const contextBefore = harness.contextBlock(null)
  assert.ok(selfBefore.includes(V11_TEXT.matchedPortrait), `前置条件：自画像块必须非空（否则断言是空的）：${selfBefore}`)
  assert.ok(contextBefore.includes(V11_TEXT.matchedProfile), `前置条件：召回块必须非空（否则断言是空的）：${contextBefore}`)
  assert.equal(contextBefore.includes(V11_TEXT.pending), false, 'pending 绝不进注入（§4.3）')
  assert.equal(selfBefore.includes(V11_TEXT.pending), false, 'pending 绝不进自画像块')
  assert.equal(contextBefore.includes(V11_TEXT.otherProfile), false, '其它分支的条目不得进注入')
  assert.equal(selfBefore.includes(V11_TEXT.otherPortrait), false, '其它分支的自画像不得进注入')

  // 把所有新参数路径都敲一遍：注入路径根本不传它们，所以两条通道必须逐字节不变。
  const probes: Array<[string, () => unknown]> = [
    ['list()', () => service.list()],
    ['list({status:all})', () => service.list({ status: 'all' })],
    ['list({status:active})', () => service.list({ status: 'active' })],
    ['list({status:pending})', () => service.list({ status: 'pending' })],
    ['list({status:invalid})', () => service.list({ status: 'invalid' })],
    ['list({status:archived})', () => service.list({ status: 'archived' })],
    ["list({branch:'current'})", () => service.list({ branch: 'current' })],
    ['list({branch:other})', () => service.list({ branch: V11_OTHER_BRANCH })],
    ['list({limit:1})', () => service.list({ limit: 1 })],
    ['recall({})', () => service.recall({ query: '' })],
    ["recall({status:'all'})", () => service.recall({ query: '', status: 'all', limit: 50 })],
    ["recall({status:'pending'})", () => service.recall({ query: '', status: 'pending', limit: 50 })],
    ["recall({status:'invalid'})", () => service.recall({ query: '', status: 'invalid', limit: 50 })],
    ["recall({branch:'current'})", () => service.recall({ query: '', branch: 'current', limit: 50 })],
    ['recall({branch:other})', () => service.recall({ query: '', branch: V11_OTHER_BRANCH, limit: 50 })],
  ]
  for (const [label, probe] of probes) {
    probe()
    assert.equal(harness.selfBlock(), selfBefore, `敲过 ${label} 之后，常驻自画像块必须逐字节不变`)
    assert.equal(harness.contextBlock(null), contextBefore, `敲过 ${label} 之后，按轮召回块必须逐字节不变`)
  }

  assert.deepEqual(
    hitIds(service.recall({ query: '', limit: 50 })).sort(),
    plainBefore,
    '无参 recall 的结果集合也必须与敲新参数之前一致',
  )
})

// ---------------------------------------------------------------- 19. §3 persisted

test('protocol#19 write 成功路径带 persisted（打开 true／未打开或 put 抛错 false，ok 仍 true）；拒绝路径没有该字段（§3）', async (t) => {
  // 领域打开：created / merged / pending 三条成功路径都必须带 persisted:true。
  const open = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => open.dispose())
  await open.settle()
  const service = open.service()

  const created = await service.write({ kind: 'semantic', origin: 'observed', subject: 'v11.persisted', text: V11_TEXT.mergedLead })
  assert.equal(created.ok, true, '前置条件：成功写入')
  assert.equal(created.status, 'created')
  assert.ok('persisted' in created, '成功路径必须带 persisted 字段')
  assert.equal(typeof created.persisted, 'boolean', 'persisted 必须是布尔')
  assert.equal(created.persisted, true, '领域打开且 put 成功 ⇒ persisted 必须为 true')

  const merged = await service.write({ kind: 'semantic', origin: 'observed', subject: 'v11.persisted', text: V11_TEXT.mergedLead })
  assert.equal(merged.ok, true)
  assert.equal(merged.status, 'merged', '前置条件：同 subject + 同正文 ⇒ 合并路径')
  assert.equal(merged.persisted, true, '合并路径也必须如实带出 persisted（0.5.17 是「合并成功」）')

  const queued = await service.write({ kind: 'semantic', subject: 'v11.persisted.pending', text: V11_TEXT.pending })
  assert.equal(queued.pending, true, '前置条件：writePolicy=ask 的模型来源写入入队')
  assert.ok('persisted' in queued, 'pending 成功路径同样必须带 persisted')
  assert.equal(queued.persisted, true, '待确认记录照常落盘 ⇒ persisted 为 true')

  // 领域未打开：ok 仍 true（「已在内存里生效」的语义不变），persisted 必须是 false。
  const bare = makeV11Harness({ withStorage: false, config: { consolidateEnabled: false } })
  t.after(() => bare.dispose())
  await bare.settle()
  assert.equal(bare.service().stats().opened, false, '前置条件：这个宿主没有存储领域')
  const noDomain = await bare.service().write({ kind: 'semantic', origin: 'observed', subject: 'v11.bare', text: '领域未打开时的一条写入。' })
  assert.equal(noDomain.ok, true, '领域缺失不是写入失败（ok 的语义不变）')
  assert.equal(noDomain.status, 'created')
  assert.ok('persisted' in noDomain)
  assert.equal(noDomain.persisted, false, '领域没打开 ⇒ 没落盘，persisted 必须为 false')
  assert.equal(bare.puts.length, 0, '领域没打开 ⇒ 一次 put 都不该发生')

  // put 抛错：同样 ok:true 且 persisted:false（契约 §3 明写的第二种情形）。
  const broken = makeV11Harness({ putFails: true, config: { consolidateEnabled: false } })
  t.after(() => broken.dispose())
  await broken.settle()
  const failedPut = await broken.service().write({ kind: 'semantic', origin: 'observed', subject: 'v11.broken', text: 'put 抛错时的一条写入。' })
  assert.equal(failedPut.ok, true, 'put 抛错不是写入失败（内存里已生效）')
  assert.equal(failedPut.status, 'created')
  assert.equal(failedPut.persisted, false, 'put 抛错 ⇒ 没落盘，persisted 必须为 false')
  assert.equal(broken.service().stats().opened, true, '前置条件：领域本身是打开的')
  assert.equal(broken.service().list().length, 1, '内存里已经生效 —— 这正是 ok:true 的含义')

  // 拒绝路径（ok:false）**不加**该字段：键必须不存在，而不是 false。
  const policy = makeV11Harness({ config: { writePolicy: 'off', consolidateEnabled: false } })
  t.after(() => policy.dispose())
  await policy.settle()
  const rejected: Array<[string, Json]> = [
    ['rejected_invalid', await service.write({ kind: 'semantic', text: '' })],
    ['rejected_sensitive', await service.write({ kind: 'user_profile', text: '数据库密码：hunter2xyz' })],
    ['rejected_write_policy', await policy.service().write({ kind: 'semantic', text: '模型来源的一条写入，策略为 off。' })],
  ]
  for (const [label, result] of rejected) {
    assert.equal(result.ok, false, `前置条件：${label} 必须走拒绝路径`)
    assert.ok(!('persisted' in result), `拒绝路径不得出现 persisted 键：${label} → ${JSON.stringify(result)}`)
  }
})

// ---------------------------------------------------------------- 20. §4 发布集

test('protocol#20 package.json 的 files 发全量 docs/（契约 §4）', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files?: unknown }
  assert.ok(Array.isArray(manifest.files), 'package.json 必须有 files 数组')
  const files = (manifest.files as unknown[]).map((entry) => String(entry))
  assert.ok(files.includes('lib'), `发布集必须仍含 lib；实际：${files.join(', ')}`)
  assert.ok(
    files.includes('docs') || files.includes('docs/'),
    `files 必须含 docs（整个目录），而不是只列两份协议文档；实际：${files.join(', ')}`,
  )
  // 不是空承诺：docs/ 确实在仓库里，且两份协议文档就在其中。
  const docs = readdirSync(new URL('../docs', import.meta.url)).map((entry) => String(entry))
  for (const name of ['protocol-v1.md', 'protocol-v1.zh.md']) {
    assert.ok(docs.includes(name), `docs/ 里必须有 ${name}，实际：${docs.join(', ')}`)
  }
})

// ================================================================ v1.2：契约 docs/protocol-v1.2-changes.md §1–§3
//
// 本节**纯追加**：上面 20 项只改动了两处随契约同步的既有断言
//   · #2 的 `stats()` 字段清单（v1.2 §2 明写要新增 `writes`）；
//   · #12 的 `protocolVersion`（v1.2 §1 明写要升到 `'1.2'`）。
// 三条纪律与 v1.1 一节相同：① 缺省面仍与 0.5.18 逐字节相同；② 新写法只影响显式调用；
// ③ 库与分支都用**真实写路径 + 真实临时 git 仓库**造，不手改状态字段。

interface V12Service {
  protocolVersion?: unknown
  /** v1.2 §1：`branch` 还接受字符串数组（空数组 ⇒ 空结果）。 */
  list(options?: Json): Json[]
  stats(): { records: number; version: number; opened: boolean; writes: { persisted: number; unpersisted: number } }
  recall(options?: Json): Array<{ record: Json; match: number; score: number }>
  write(input: Json): Promise<Json>
  consolidate(reason?: string): Promise<void>
}

/** v1.2 服务面：v1.1 的五个成员之上只多出「数组写法 / writes / refs」三件事。 */
const v12 = (harness: V11Harness): V12Service => harness.service() as unknown as V12Service

test("protocol#21 list({branch:[…]})：数组命中/不命中/空数组、含 'current'、与 status/limit 叠加（§1）", async (t) => {
  const dir = makeBranchDir(V11_BRANCH)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const harness = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  harness.emit('session/event', { id: 'session-v12', header: { cwd: dir } }, { type: 'session/start', seq: 1 })
  const library = await buildV11Library(harness)
  const service = v12(harness)

  // 字符串写法仍是 v1.1 的那个表达式（数组是**新增**写法，不是替换）
  assert.deepEqual(idsOf(service.list({ branch: V11_BRANCH })), [library.matchedProfile, library.matchedPortrait], '字符串写法一字不变')
  const unsorted = service.list()

  // 命中：branchOf 落在数组里；无标签记录**不**算命中（与单个字符串同语义）
  const pair = service.list({ branch: [V11_BRANCH, V11_OTHER_BRANCH] })
  assert.ok(pair.length > 0, '前置条件：两个分支上都有记录，数组用例才不是空的')
  for (const row of pair) {
    assert.ok(
      [V11_BRANCH, V11_OTHER_BRANCH].includes(String(row.branch)),
      `数组命中必须只含数组里的分支标签，实际：${String(row.branch)}`,
    )
  }
  assert.deepEqual(
    idsOf(service.list({ branch: [V11_OTHER_BRANCH] })),
    [library.otherProfile, library.otherPortrait],
    '单元素数组与字符串写法同结果',
  )
  assert.equal(
    idsOf(service.list({ branch: [V11_BRANCH, V11_OTHER_BRANCH] })).includes(library.untaggedProfile), false,
    '无标签记录不属于任何分支 ⇒ 数组写法不命中',
  )
  assert.deepEqual(idsOf(service.list({ branch: [V11_BRANCH, V11_OTHER_BRANCH] })), idsOf(pair), '数组过滤是纯读取')

  // 不命中 / 空数组
  assert.deepEqual(idsOf(service.list({ branch: ['protocol/absent'] })), [], '数组里没有的标签 ⇒ 空结果')
  assert.deepEqual(service.list({ branch: [] }), [], '空数组 ⇒ 空结果（不是「不过滤」）')
  assert.notEqual(service.list({ branch: [] }).length, unsorted.length, '空数组必须区别于缺省/ null')

  // 数组里的 'current' 先解析成当前分支名（当前分支＝V11_BRANCH）
  assert.deepEqual(
    idsOf(service.list({ branch: ['current'] })),
    [library.matchedProfile, library.matchedPortrait],
    "['current'] ＝ 把当前分支名放进数组（无标签仍不算命中）",
  )
  assert.deepEqual(
    idsOf(service.list({ branch: ['current', V11_OTHER_BRANCH] })).sort(),
    idsOf([...service.list({ branch: V11_BRANCH }), ...service.list({ branch: V11_OTHER_BRANCH })]).sort(),
    "['current', 其它分支] 就是两个分支的并集",
  )
  // 与 v1.1 的 'current'（branchVisible，含无标签）**不是**一回事 —— 数组写法更严格
  assert.notDeepEqual(
    idsOf(service.list({ branch: ['current'] })),
    idsOf(service.list({ branch: 'current' })),
    "数组里的 'current' 是「当前分支名」，不等于字符串 'current' 的 branchVisible 口径（后者含无标签记录）",
  )

  // 与 status / limit 叠加：顺序始终是无参视图的相对顺序
  const order = idsOf(unsorted)
  const pairIds = new Set(idsOf(pair))
  assert.deepEqual(
    idsOf(service.list({ branch: [V11_BRANCH, V11_OTHER_BRANCH], status: 'active' })),
    order.filter((id) => pairIds.has(id) && service.list().find((row) => String(row.id) === id)!.status === 'active'),
    '数组与 status 叠加（先分支后状态，顺序不变）',
  )
  assert.deepEqual(
    idsOf(service.list({ branch: [V11_BRANCH, V11_OTHER_BRANCH], limit: 1 })),
    order.filter((id) => pairIds.has(id)).slice(0, 1),
    '数组与 limit 叠加（先过滤再截断）',
  )
  assert.deepEqual(service.list({ branch: [], status: 'all', limit: 3 }), [], '空数组叠加任何参数仍是空结果')
})

test("protocol#22 recall({branch:[…]})：数组命中/不命中/空数组、含 'current'，与 list 同口径（§1）", async (t) => {
  const dir = makeBranchDir(V11_BRANCH)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const harness = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  harness.emit('session/event', { id: 'session-v12', header: { cwd: dir } }, { type: 'session/start', seq: 1 })
  const library = await buildV11Library(harness)
  const service = v12(harness)
  const scoped = (branch: unknown): Array<{ record: Json }> => service.recall({ query: '', branch, limit: 50 }) as Array<{ record: Json }>

  // 数组命中：只留标签在数组里的记录（缺省仍只收 active）
  assert.deepEqual(
    hitIds(scoped([V11_OTHER_BRANCH])).sort(),
    [library.otherProfile, library.otherPortrait].sort(),
    '单元素数组与字符串写法同结果',
  )
  assert.equal(hitIds(scoped([V11_BRANCH, V11_OTHER_BRANCH])).includes(library.untaggedProfile), false, '无标签记录不算命中')
  assert.deepEqual(
    hitIds(scoped([V11_BRANCH, V11_OTHER_BRANCH])).sort(),
    idsOf(service.list({ branch: [V11_BRANCH, V11_OTHER_BRANCH], status: 'active' })).sort(),
    'recall 的数组写法与 list 同口径（同一候选池 + 缺省只收 active）',
  )

  // 不命中 / 空数组 ⇒ 空结果
  assert.deepEqual(scoped(['protocol/absent']), [], '数组里没有的标签 ⇒ 空结果')
  assert.deepEqual(scoped([]), [], '空数组 ⇒ 空结果（不是不过滤）')
  assert.ok(hitIds(scoped(null)).length > 0, '对照：branch:null 仍不过滤')

  // 数组里的 'current'
  assert.deepEqual(
    hitIds(scoped(['current'])).sort(),
    [library.matchedProfile, library.matchedPortrait].sort(),
    "['current'] ＝ 把当前分支名放进数组（先解析再匹配）",
  )
  assert.deepEqual(
    hitIds(scoped(['current', V11_OTHER_BRANCH])).sort(),
    [library.matchedProfile, library.matchedPortrait, library.otherProfile, library.otherPortrait].sort(),
    "['current', 其它分支] ＝ 两个分支的并集",
  )
  assert.deepEqual(
    hitIds(scoped(['current', V11_OTHER_BRANCH, ' '])).sort(),
    [library.matchedProfile, library.matchedPortrait, library.otherProfile, library.otherPortrait].sort(),
    '数组里的空白项不匹配任何标签（不抛，也不放宽）',
  )
})

test('protocol#23 stats().writes：落盘成功 +1 / ok:true 未落盘 +1；拒绝路径不计入；与既有字段并列（§2）', async (t) => {
  // a) 领域打开：created / merged / pending 三条成功路径各落盘一次
  const open = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => open.dispose())
  await open.settle()
  const service = v12(open)

  const stats0 = service.stats()
  // v1.3 §2 追加 `embedder` ⇒ 清单同步为五个键（见本节末尾「既有断言同步」说明）；既有四个仍一字不改。
  assert.deepEqual(Object.keys(stats0).sort(), ['embedder', 'opened', 'records', 'version', 'writes'], '§2：在既有四个字段之上追加 embedder')
  assert.deepEqual(stats0.writes, { persisted: 0, unpersisted: 0 }, '零写入 ⇒ 两个计数都是 0（缺键不算通过）')

  await service.write({ kind: 'semantic', origin: 'observed', subject: 'v12.writes', text: V11_TEXT.mergedLead })
  assert.deepEqual(service.stats().writes, { persisted: 1, unpersisted: 0 }, 'created 成功路径 ⇒ persisted +1')
  await service.write({ kind: 'semantic', origin: 'observed', subject: 'v12.writes', text: V11_TEXT.mergedLead })
  assert.deepEqual(service.stats().writes, { persisted: 2, unpersisted: 0 }, 'merged 成功路径 ⇒ persisted +1')
  const queued = await service.write({ kind: 'semantic', subject: 'v12.writes.pending', text: V11_TEXT.pending })
  assert.equal(queued.pending, true)
  assert.deepEqual(service.stats().writes, { persisted: 3, unpersisted: 0 }, 'pending 成功路径（入队也要落盘）⇒ persisted +1')
  assert.equal(open.puts.length, 3, '计数与真实 put 一一对应')

  // b) 拒绝路径（ok:false）不计入 —— 那是「没写」，不是「写入未落盘」
  const before = { ...service.stats().writes }
  const putsBefore = open.puts.length
  const invalid = await service.write({ kind: 'semantic', text: '' })
  assert.equal(invalid.ok, false, '前置条件：空正文走拒绝路径')
  const sensitive = await service.write({ kind: 'user_profile', text: '数据库密码：hunter2xyz' })
  assert.equal(sensitive.ok, false, '前置条件：敏感文本走拒绝路径')
  assert.deepEqual(service.stats().writes, before, '拒绝路径不得让两个计数动一下')
  assert.equal(open.puts.length, putsBefore, '拒绝路径一次 put 都不该发生')

  // c) 域未打开 / put 抛错：ok:true 但没落盘 ⇒ unpersisted +1
  const bare = makeV11Harness({ withStorage: false, config: { consolidateEnabled: false } })
  t.after(() => bare.dispose())
  await bare.settle()
  assert.equal(bare.service().stats().opened, false, '前置条件：这个宿主没有存储领域')
  await bare.service().write({ kind: 'semantic', origin: 'observed', subject: 'v12.bare', text: '领域未打开时的一条写入。' })
  assert.deepEqual(v12(bare).stats().writes, { persisted: 0, unpersisted: 1 }, '域未打开 ⇒ unpersisted +1（不是 persisted）')

  const broken = makeV11Harness({ putFails: true, config: { consolidateEnabled: false } })
  t.after(() => broken.dispose())
  await broken.settle()
  await broken.service().write({ kind: 'semantic', origin: 'observed', subject: 'v12.broken', text: 'put 抛错时的一条写入。' })
  assert.equal(broken.service().stats().opened, true, '前置条件：领域本身是打开的')
  assert.deepEqual(v12(broken).stats().writes, { persisted: 0, unpersisted: 1 }, 'put 抛错 ⇒ unpersisted +1')
  await broken.service().write({ kind: 'semantic', origin: 'observed', subject: 'v12.broken.2', text: 'put 抛错时的第二条写入。' })
  assert.deepEqual(v12(broken).stats().writes, { persisted: 0, unpersisted: 2 }, '只加不减：第二次失败继续累加')

  // d) 计数不影响既有字段（records / version / opened 语义一字不改）
  const after = service.stats()
  assert.equal(after.records, 2, '三条成功写入里，前两条是同一条（第二写合并），库内共 2 条')
  assert.equal(after.opened, true)
  assert.ok(after.version > stats0.version, 'version 仍是落盘版本号，随写入增长')
})

test('protocol#24 write 两条成功路径带 refs（无引用为 []）；拒绝路径没有该字段（§3）', async (t) => {
  // 先灌一条带 seq 的事件：宿主按 `state.seq` 推导这次写入的出处（无 sessionQuery 也不影响）。
  const open = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => open.dispose())
  await open.settle()
  open.emit('session/event', { id: 'session-v12', seq: 9, header: { cwd: null } }, {
    type: 'user/message', seq: 9, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记住：构建流程统一用 pnpm。' }] },
  })
  const service = v12(open)
  const expected = 'session-v12#9'

  // a) created：单点引用
  const created = await service.write({ kind: 'semantic', origin: 'observed', subject: 'v12.refs', text: V11_TEXT.mergedLead, refVia: 'tool' })
  assert.equal(created.status, 'created')
  assert.ok(Array.isArray(created.refs), '成功路径必须带 refs 数组')
  assert.deepEqual(created.refs, [expected], 'refs 是本条记录携带的机器可读引用串（sessionId#from）')

  // b) merged：同正文再写一次 → 合并，仍带 refs
  const merged = await service.write({ kind: 'semantic', origin: 'observed', subject: 'v12.refs', text: V11_TEXT.mergedLead, refVia: 'tool' })
  assert.equal(merged.status, 'merged', '前置条件：同 subject + 同正文 ⇒ 合并路径')
  assert.deepEqual(merged.refs, [expected], '合并路径同样给出处（同一区间不重复，引用串保持一条）')

  // c) pending：此前连 record 都没有，现在也要给出处
  const queued = await service.write({ kind: 'semantic', subject: 'v12.refs.pending', text: V11_TEXT.pending, refVia: 'tool' })
  assert.equal(queued.pending, true, '前置条件：writePolicy=ask 的模型来源写入入队')
  assert.ok(Array.isArray(queued.refs), 'pending 成功路径也必须带 refs')
  assert.deepEqual(queued.refs, [expected], 'pending 路径的出处来自入队记录本身')

  // d) 无引用（没见过带 seq 的事件）⇒ 空数组，而不是 undefined / 缺键
  const bare = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => bare.dispose())
  await bare.settle()
  const noRefs = await v12(bare).write({ kind: 'semantic', origin: 'observed', subject: 'v12.norefs', text: '没有 session/event 时的一条写入。' })
  assert.equal(noRefs.ok, true)
  assert.equal('refs' in noRefs, true, '无引用时键仍存在（值为 []），不是缺键')
  assert.deepEqual(noRefs.refs, [], '无引用必须空数组（契约 §3 明写）')

  // e) 拒绝路径（ok:false）**不加**该字段
  const rejected: Array<[string, Json]> = [
    ['rejected_invalid', await service.write({ kind: 'semantic', text: '' })],
    ['rejected_sensitive', await service.write({ kind: 'user_profile', text: '数据库密码：hunter2xyz' })],
  ]
  for (const [label, result] of rejected) {
    assert.equal(result.ok, false, `前置条件：${label} 必须走拒绝路径`)
    assert.ok(!('refs' in result), `拒绝路径不得出现 refs 键：${label} → ${JSON.stringify(result)}`)
  }
})

// ================================================================ v1.3：契约 docs/embedder.md §2/§3/§6
//
// M18 的**宿主半边**：宿主通过服务面注入 `embed` 函数，插件**不自带模型、不联网**
// （§0.1 —— 是否把记忆正文送去外部服务是宿主/用户的决定），没注入就回落词面检索（§0.2）。
//
// 本节同样**纯追加**。上面 24 项里只有两处随契约同步（理由逐条写在报告里，不静默改）：
//   · #2 / #23 的 `stats()` 键清单 —— v1.3 §2 明写要追加 `embedder`；
//   · #12 的 `protocolVersion` —— v1.3 明写要升到 `'1.3'`（`docs/protocol-v1.md` §11 同时承认该字面量）。
// 三条纪律与上面两节相同：
//   ① 没注册 embedder 时缺省面仍与 0.5.19 逐字节相同 —— #25/#29 各自**只跑词面**，并在末尾断言零嵌入调用；
//   ② 语义只影响**显式** `mode`；`embedderRecallMode` 默认 `'off'`（#31 钉死注入路径不动）；
//   ③ 失败绝不冒泡、绝不假装（§0.4/§0.5）—— 回落必须**真的**是词面结果，且诊断如实标注原因。
//
// 与 host.test.ts 的分工不变：那边跑功能用例，这里只钉**协议文档承诺的形状与语义**。

/** v1.3 的三种检索模式（契约 §3）。 */
type V13Mode = 'lexical' | 'semantic' | 'hybrid'

/** `lastRecall()` 的形状（契约 §3，签名冻结）。 */
interface V13RecallDiag {
  mode: V13Mode
  used: boolean
  fallback: 'no-embedder' | 'embed-error' | 'timeout' | null
  candidates: number
  vectors: number
}

/** `stats().embedder` 的形状（契约 §2）。 */
interface V13EmbedderStats {
  id: string | null
  dimensions: number | null
  calls: number
  errors: number
  hits: number
  misses: number
  timeouts: number
}

/** 服务面 v1.3：v1.2 的成员之上追加 setEmbedder / capabilities / lastRecall，`recall` 接受 `mode`。 */
interface V13Service {
  protocolVersion?: unknown
  list(options?: Json): Json[]
  /** §2：既有四个字段之上追加 `embedder`（未注册时 id/dimensions 为 null、六个计数为 0）。 */
  stats(): { records: number; version: number; opened: boolean; writes: { persisted: number; unpersisted: number } } & { embedder: V13EmbedderStats }
  capabilities(): { protocolVersion: string; lexical: true; embedder: boolean; embedderId: string | null }
  /** §2：非法入参返回 `{ ok: false, error: 'rejected_invalid: …' }`，且**不改变**当前注册状态。 */
  setEmbedder(embedder: unknown): { ok: true; id: string | null } | { ok: false; error: string }
  lastRecall(): V13RecallDiag | null
  /** §3：`'semantic'` / `'hybrid'` 需要嵌入 ⇒ 异步；词面模式仍是同步数组。 */
  recall(options?: Json): Array<{ record: Json; match: number; score: number }> | Promise<Array<{ record: Json; match: number; score: number }>>
  write(input: Json): Promise<Json>
  consolidate(reason?: string): Promise<void>
}

/** v1.3 的计数对：`calls` = 真的调了 embed 的次数，`hits`/`misses` = 向量缓存命中/未命中（§2）。 */
interface V13Counts {
  calls: number
  errors: number
  hits: number
  misses: number
  timeouts: number
}

/** `embed` 收到过的每一批文本（按调用顺序），用于「零嵌入调用」与「每次调用送了什么」两类断言。 */
interface V13Recorder {
  /** 每次调用当作一批记下来（批量算一次 `calls`，所以用二维数组而不是拍平）。 */
  batches: string[][]
  /** 拍平后的全部文本（只看「送没送、送了几段」时够用）。 */
  sent: string[]
  /** 调用次数（＝ batches.length）。 */
  calls(): number
}

/**
 * 确定性假 embedder（契约 §6）：**不联网、不加载模型**，只把文本摊成固定维度的有限数向量。
 * 同一个字符串永远得到同一个向量（因此缓存命中是可复现的，`hits`/`misses` 才有确定性）。
 */
function makeV13Embedder(options: {
  id: string
  dimensions?: unknown
  /** 覆盖 embed 主体，用来注入抛错 / 形状错 / 维度错 / 挂起不返回。 */
  embed?: (texts: readonly string[], recorder: V13Recorder) => unknown
}): { embedder: Json; recorder: V13Recorder } {
  const batches: string[][] = []
  const recorder: V13Recorder = {
    batches,
    sent: batches.flat(),
    calls: (): number => batches.length,
  }
  const deterministicVector = (text: string): number[] => [
    text.length,
    [...text].reduce((sum, char) => sum + char.codePointAt(0)!, 0),
    1,
  ]
  const embed = (texts: readonly string[]): unknown => {
    batches.push([...texts])
    recorder.sent = batches.flat()
    return options.embed === undefined ? texts.map(deterministicVector) : options.embed(texts, recorder)
  }
  const embedder: Json = options.dimensions === undefined
    ? { id: options.id, embed }
    : { id: options.id, dimensions: options.dimensions, embed }
  return { embedder, recorder }
}

/** v1.3 服务面视图：`makeV11Harness` 造出来的仍然是同一个服务对象，只是形状更宽。 */
const v13 = (harness: V11Harness): V13Service => harness.service() as unknown as V13Service

/** 复刻 `capabilities()` 的语义（只用到语义检索的套件用它做对照，省掉一个假 embedder）。 */
const semanticOnlyService = (service: V13Service): V13Service =>
  new Proxy(service, {
    get: (target, key) => (key === 'capabilities'
      ? () => ({ protocolVersion: String(target.protocolVersion), lexical: true as const, embedder: false, embedderId: null })
      : (target as unknown as Record<string | symbol, unknown>)[key]),
  }) as unknown as V13Service

/** 嵌入计数器快照（`stats().embedder` 去掉 id/dimensions，只留六个计数）。 */
const countsOf = (service: V13Service): V13Counts => {
  const { calls, errors, hits, misses, timeouts } = service.stats().embedder
  return { calls, errors, hits, misses, timeouts }
}

/** 词面召回永远是同步数组：这里同时断言「没退化成 Promise」——那是 §0.2 的一部分。 */
const lexicalHits = (service: V13Service, options?: Json): Array<{ record: Json }> => {
  const value = service.recall({ limit: 50, ...options })
  assert.equal(typeof (value as Promise<unknown>).then, 'undefined', '词面召回必须是同步数组（0.5.19 的返回类型不变）')
  return value as Array<{ record: Json }>
}

/** 一份可复现的语义探针库：两条正文**词面上毫不相干**，所以语义排序不是词面排序的巧合。 */
const V13_TEXT = {
  pnpm: '构建流程统一使用 pnpm 作为包管理器。',
  unrelated: '雨天出门记得带一把折叠伞。',
  /** 查询与第二条同文 ⇒ 词面必然命中它，而假 embedder 对「完全相同文本」给完全相同的向量。 */
  hit: '构建流程统一使用 pnpm 作为包管理器。',
} as const

// ---------------------------------------------------------------- 25. §0.2 零嵌入调用

test('protocol#25 没注册 embedder：lexical/缺省召回与 0.5.19 等价，且**零嵌入调用**（§0.2/§3）', async (t) => {
  const harness = makeV11Harness({ config: { consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  const service = v13(harness)

  await service.write({ kind: 'semantic', origin: 'observed', subject: 'v13.baseline', text: V13_TEXT.pnpm })
  await service.write({ kind: 'semantic', origin: 'observed', subject: 'v13.unrelated', text: V13_TEXT.unrelated })
  assert.equal(service.stats().records, 2, '前置条件：库里有两条可召回的记录')

  // 先拿「既有行为」的对照，再逐条敲新写法 —— 对照不是快照，而是同一次运行的词面结果。
  const baseline = lexicalHits(service, { query: 'pnpm' })
  const baselineIds = hitIds(baseline)
  assert.ok(baselineIds.length > 0, `前置条件：词面召回必须命中（否则本用例是空的）：${JSON.stringify(baselineIds)}`)

  for (const [label, options] of [
    ['缺省（不传 mode）', { query: 'pnpm' }],
    ["mode: 'lexical'", { query: 'pnpm', mode: 'lexical' }],
    ["mode: 'query'（既有词面口径）", { query: 'pnpm', mode: 'query' }],
    ['mode: 未知值', { query: 'pnpm', mode: 'semantic-ish' }],
    ['mode: 非字符串', { query: 'pnpm', mode: 42 }],
  ] as Array<[string, Json]>) {
    const hits = lexicalHits(service, options)
    assert.deepEqual(hitIds(hits), baselineIds, `${label} 必须与既有词面召回同结果同序（0.5.19 逐字节行为）`)
    assert.equal(typeof service.lastRecall()?.used, 'boolean', `${label} 必须给出 lastRecall 诊断（可观测，不是静默）`)
  }

  // `'memory'` 是**既有**的词面口径（长查询按记忆侧覆盖率、minMatch 0.4），实现必须原样保留它、
  // 不能把它当成 v1.3 的模式键：短查询下它的门槛比默认严，因此照旧可能给空结果。
  const memoryMode = lexicalHits(service, { query: 'pnpm', mode: 'memory' })
  assert.deepEqual(memoryMode, [], "mode:'memory' 是既有词面口径 ⇒ 短查询下按覆盖率门槛给空结果（不是回落到缺省口径）")
  assert.notDeepEqual(hitIds(memoryMode), baselineIds, "对照：mode:'memory' 不得被当成 v1.3 的模式键而回落成缺省词面")

  // 硬约束：以上路径**一次 embed 都不该发生** —— 未注册时干脆没有 embedder 可调，
  // 但这条断言在本用例里还承担「未来的实现别把词面路径接上嵌入器」的盯防作用。
  assert.deepEqual(countsOf(service), { calls: 0, errors: 0, hits: 0, misses: 0, timeouts: 0 }, '词面路径必须零嵌入调用（§0.2）')
  assert.equal(service.lastRecall()?.mode, 'lexical', "缺省模式就是 'lexical'（§3）")
  assert.equal(service.lastRecall()?.fallback, null, '词面是主路径，不是回落 ⇒ fallback 为 null')
  assert.equal(service.lastRecall()?.used, false, '词面排序没有用到嵌入 ⇒ used:false（绝不假装）')
  assert.equal(service.stats().embedder.id, null, '未注册 ⇒ id 为 null')
  assert.equal(service.stats().embedder.dimensions, null, '未注册 ⇒ dimensions 为 null')
})

// ---------------------------------------------------------------- 26. §0.1 未注册时绝不外发

test("protocol#26 未注册时 recall({mode:'semantic'}) 回落词面，并如实标记 fallback:'no-embedder'（§0.5）", async (t) => {
  const harness = makeV11Harness({ config: { consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  const service = v13(harness)

  await service.write({ kind: 'semantic', origin: 'observed', subject: 'v13.fallback', text: V13_TEXT.pnpm })
  await service.write({ kind: 'semantic', origin: 'observed', subject: 'v13.fallback.2', text: V13_TEXT.unrelated })

  const lexical = lexicalHits(service, { query: 'pnpm' })
  const semantic = await (service.recall({ query: 'pnpm', mode: 'semantic', limit: 50 }) as Promise<Array<{ record: Json; match: number; score: number }>>)
  assert.ok(Array.isArray(semantic), 'semantic 模式返回数组（异步，但形状不变）')
  // 回落必须**真的**是词面结果：同集合、同顺序、同分数 —— 不是「看起来像召回结果」就算数。
  assert.deepEqual(hitIds(semantic), hitIds(lexical), '未注册 ⇒ 语义结果必须与词面结果逐条同序（回落是真的）')
  for (let index = 0; index < lexical.length; index += 1) {
    const semanticHit = semantic.find((hit) => hit.record.id === lexical[index]!.record.id)!
    // 分数含时间衰减，两次召回的时刻不同 ⇒ 末几位必然有浮点差；用容差比，既保住「不是 0/NaN」的本意，
    // 又不会因为毫秒级时刻差而假红。`match` 是覆盖率，不带时间项，可以精确比。
    assert.ok(
      Math.abs(semanticHit.score - (lexical[index] as unknown as { score: number }).score) < 1e-9,
      `回落时分数也必须是词面分（含同样的时间衰减量级），不是 0/NaN：${semanticHit.score} vs ${(lexical[index] as unknown as { score: number }).score}`,
    )
    assert.equal(semanticHit.match, (lexical[index] as unknown as { match: number }).match, '回落时 match 也保持不变')
  }

  const diag = service.lastRecall()
  assert.ok(diag, 'lastRecall() 必须非 null（本次召回刚发生过）')
  assert.equal(diag.mode, 'semantic', '诊断必须记下调用方**请求**的模式，而不是回落后的模式')
  assert.equal(diag.used, false, '没用到嵌入 ⇒ used:false')
  assert.equal(diag.fallback, 'no-embedder', "§0.5 冻结的字面量：fallback === 'no-embedder'")
  assert.equal(diag.vectors, 0, '没拿到任何向量 ⇒ vectors:0')

  // §0.1 的隐私面：未注册时既没有可调用的 embed，也就没有任何正文被送出去。
  assert.deepEqual(countsOf(service), { calls: 0, errors: 0, hits: 0, misses: 0, timeouts: 0 }, '未注册 ⇒ 零嵌入调用（插件绝不自己联网/调模型）')

  // hybrid 同一条纪律：回落 + 如实标记（不是「hybrid 就默认当词面用」）。
  await (service.recall({ query: 'pnpm', mode: 'hybrid', limit: 50 }) as Promise<unknown>)
  assert.equal(service.lastRecall()?.mode, 'hybrid', 'hybrid 的诊断也要如实记下模式')
  assert.equal(service.lastRecall()?.fallback, 'no-embedder', "hybrid 未注册时同样标 'no-embedder'")
  assert.deepEqual(countsOf(service), { calls: 0, errors: 0, hits: 0, misses: 0, timeouts: 0 }, 'hybrid 回落同样零嵌入调用')

  // 对照：`setEmbedder(null)` 是**幂等**的清除 —— 没注册过也能清，且不改变「未注册」这件事。
  assert.deepEqual(service.setEmbedder(null), { ok: true, id: null }, '清除不是失败：传 null 恒为 ok:true')
  assert.deepEqual(service.capabilities(), { protocolVersion: '1.3', lexical: true, embedder: false, embedderId: null }, '清除后仍是未注册')
})

// ---------------------------------------------------------------- 27. §2 能力探测

test('protocol#27 capabilities() 形状冻结：lexical 恒 true、未注入时 embedder===false / embedderId===null（§2）', async (t) => {
  const harness = makeV11Harness({ config: { consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  const service = v13(harness)

  const fresh = service.capabilities()
  assert.deepEqual(
    Object.keys(fresh).sort(),
    ['embedder', 'embedderId', 'lexical', 'protocolVersion'],
    '§2 冻结的四个键，一个不多一个不少（调用方据此决定用不用语义，不要靠猜）',
  )
  assert.equal(fresh.protocolVersion, '1.3', 'capabilities 里的版本必须与服务面字段同源')
  assert.equal(service.protocolVersion, '1.3', "v1 内只做加法 ⇒ 1.0 → 1.1 → 1.2 → 1.3（docs/protocol-v1.md §11）")
  assert.deepEqual(
    service.capabilities(),
    { protocolVersion: '1.3', lexical: true, embedder: false, embedderId: null },
    '未注入时的完整形状（§6：未注入时 embedder === false）',
  )
  assert.equal(fresh.lexical, true, '词面检索永远可用 ⇒ lexical 恒为 true（不是布尔值的字符串）')
  assert.equal(fresh.embedder, false, '未注入 ⇒ 明确的 false（不是 undefined / 缺键）')
  assert.equal(fresh.embedderId, null, '未注入 ⇒ 明确的 null')

  // 卸载后仍成立：能力探测读的是**当前**注册，不是启动时的快照。
  const { embedder } = makeV13Embedder({ id: 'probe-only' })
  assert.deepEqual(service.setEmbedder(embedder), { ok: true, id: 'probe-only' })
  assert.deepEqual(service.capabilities(), { protocolVersion: '1.3', lexical: true, embedder: true, embedderId: 'probe-only' })
  assert.equal(service.stats().embedder.id, 'probe-only', 'stats 与 capabilities 必须同源')
  service.setEmbedder(null)
  assert.deepEqual(service.capabilities(), { protocolVersion: '1.3', lexical: true, embedder: false, embedderId: null }, '清除后回到未注入形状')
})

// ---------------------------------------------------------------- 28. §2 setEmbedder 校验

test('protocol#28 setEmbedder 拒绝路径返回 rejected_invalid，且**不改变**当前注册状态（§2）', async (t) => {
  const harness = makeV11Harness({ config: { consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  const service = v13(harness)

  const noop = (): readonly number[][] => [[1, 2, 3]]
  /** 非法入参表：每一条都必须被拒 —— 形状用 `unknown` 传，因为服务面本来就接受任意输入。 */
  const invalid: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null 之外的假值', 0],
    ['字符串', 'local-minilm'],
    ['数组（对象但不是 embedder）', [{ id: 'x', embed: noop }]],
    ['缺 id', { embed: noop }],
    ['id 非字符串', { id: 42, embed: noop }],
    ['id 空串', { id: '', embed: noop }],
    ['id 全空白', { id: '   ', embed: noop }],
    ['缺 embed', { id: 'x' }],
    ['embed 非函数', { id: 'x', embed: 'not-a-function' }],
    ['embed 是异步函数形状但传了非函数', { id: 'x', embed: { call: noop } }],
    ['dimensions: 0', { id: 'x', embed: noop, dimensions: 0 }],
    ['dimensions 负数', { id: 'x', embed: noop, dimensions: -3 }],
    ['dimensions 非整数', { id: 'x', embed: noop, dimensions: 3.5 }],
    ['dimensions NaN', { id: 'x', embed: noop, dimensions: Number.NaN }],
    ['dimensions Infinity', { id: 'x', embed: noop, dimensions: Number.POSITIVE_INFINITY }],
    ['dimensions 非数', { id: 'x', embed: noop, dimensions: '384' }],
  ]

  // a) 未注册状态下逐条拒绝：拒绝之后必须**仍然**是未注册（不能半途改状态）。
  for (const [label, value] of invalid) {
    const result = service.setEmbedder(value)
    assert.equal(result.ok, false, `非法入参必须被拒：${label}`)
    assert.match(String(result.error), /^rejected_invalid: /u, `错误形状必须是「错误码: 说明」：${label} → ${String(result.error)}`)
    assert.deepEqual(service.capabilities(), { protocolVersion: '1.3', lexical: true, embedder: false, embedderId: null }, `被拒之后仍必须是未注册：${label}`)
    assert.equal(service.stats().embedder.id, null, `被拒不得留下痕迹（stats.embedder.id）：${label}`)
  }

  // b) 已注册状态下逐条拒绝：必须**保住**原来那个嵌入器（这是「不改变当前注册状态」的硬含义）。
  const { embedder } = makeV13Embedder({ id: 'kept-embedder', dimensions: 3 })
  assert.deepEqual(service.setEmbedder(embedder), { ok: true, id: 'kept-embedder' })
  for (const [label, value] of invalid) {
    const result = service.setEmbedder(value)
    assert.equal(result.ok, false, `已注册时非法入参同样必须被拒：${label}`)
    assert.deepEqual(
      service.capabilities(),
      { protocolVersion: '1.3', lexical: true, embedder: true, embedderId: 'kept-embedder' },
      `被拒之后必须保住原来那个嵌入器：${label}`,
    )
    assert.equal(service.stats().embedder.id, 'kept-embedder', `stats 也不得被半途改写：${label}`)
    assert.equal(service.stats().embedder.dimensions, 3, `已注册的 dimensions 也不得被改写：${label}`)
  }

  // c) 合法入参必须被接受（否则上面那些「被拒」可能只是因为什么都注册不上）。
  const okResult = service.setEmbedder({ id: 'accepted', embed: noop })
  assert.deepEqual(okResult, { ok: true, id: 'accepted' }, '合法 embedder（无 dimensions）必须注册成功')
  assert.equal(service.capabilities().embedder, true, '注册成功后 capabilities().embedder 必须为 true')
  // dimensions 明确传 null 视作「未给」（§2 只规定「若给」，null 不是「给了个非法的数」）。
  assert.deepEqual(service.setEmbedder({ id: 'accepted-null-dim', embed: noop, dimensions: null }), { ok: true, id: 'accepted-null-dim' }, 'dimensions:null ＝ 未给')
  assert.equal(service.stats().embedder.dimensions, null, 'dimensions:null 注册后 stats 里是 null（不是 NaN/0）')
  // 替换：注册新 id 必须覆盖旧的，返回值如实给出新 id。
  assert.deepEqual(service.setEmbedder({ id: 'replaced', embed: noop, dimensions: 4 }), { ok: true, id: 'replaced' }, '允许替换')
  assert.deepEqual(service.capabilities().embedderId, 'replaced', '替换后 capabilities 读到的必须是新的')

  // d) 拒绝是**纯函数式**的：敲完全部非法入参，计数器与注册状态都不许动。
  assert.equal(service.stats().embedder.calls, 0, '注册/拒绝都不调用 embed ⇒ calls 必须还是 0')
})

// ---------------------------------------------------------------- 29. §2/§3 注册后生效 + 计数方向

test("protocol#29 注册后 semantic 生效、lexical 零调用；stats().embedder 的 calls/hits/misses 变化方向正确（§2/§3）", async (t) => {
  const harness = makeV11Harness({ config: { consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  const service = v13(harness)
  const { embedder, recorder } = makeV13Embedder({ id: 'local-probe', dimensions: 3 })
  assert.deepEqual(service.setEmbedder(embedder), { ok: true, id: 'local-probe' }, '前置条件：注册假 embedder')

  // 能力探测先于一切调用：注册只说明「已注册」，这一刻还一次都没调过（`calls` 仍是 0）。
  assert.deepEqual(service.capabilities(), { protocolVersion: '1.3', lexical: true, embedder: true, embedderId: 'local-probe' }, '§6：注册后 capabilities().embedder === true')
  assert.deepEqual(countsOf(service), { calls: 0, errors: 0, hits: 0, misses: 0, timeouts: 0 }, '注册本身不调用 embed')

  const first = await service.write({ kind: 'semantic', origin: 'observed', subject: 'v13.wanted', text: V13_TEXT.pnpm })
  const second = await service.write({ kind: 'semantic', origin: 'observed', subject: 'v13.unrelated', text: V13_TEXT.unrelated })
  assert.equal(first.status, 'created')
  assert.equal(second.status, 'created')

  // ---- 词面：注册之后也**零嵌入调用**（注册不该改变既有路径的代价） ----
  const lexical = lexicalHits(service, { query: 'pnpm' })
  assert.ok(hitIds(lexical).includes(String(first.id)), '词面召回仍要能命中')
  assert.deepEqual(countsOf(service), { calls: 0, errors: 0, hits: 0, misses: 0, timeouts: 0 }, "显式 mode:'lexical' 必须零嵌入调用（§3）")

  // ---- 语义第一发：查询 + 2 条候选 = 一批 3 段 ⇒ calls +1，三段全部未命中 ⇒ misses +3 ----
  const semantic = await (service.recall({ query: V13_TEXT.hit, mode: 'semantic', limit: 50 }) as Promise<Array<{ record: Json; match: number; score: number }>>)
  const afterFirst = countsOf(service)
  assert.equal(afterFirst.calls, 1, '一次召回只批量调一次 embed（批量算一次 calls），不是逐条调')
  assert.equal(afterFirst.misses, 3, '查询 + 2 条候选全部首次见到 ⇒ misses +3')
  assert.equal(afterFirst.hits, 0, '第一次没有缓存可命中 ⇒ hits 仍是 0')
  assert.equal(afterFirst.errors, 0, '正常路径不得计错')
  assert.deepEqual(recorder.batches[0], [V13_TEXT.hit, V13_TEXT.pnpm, V13_TEXT.unrelated], '送出去的是「查询 + 候选池」，顺序即候选池顺序')
  assert.deepEqual(service.lastRecall(), { mode: 'semantic', used: true, fallback: null, candidates: 2, vectors: 2 }, '语义真的用上了：used:true、无回落、两个候选都拿到向量')

  // 语义排序生效：与查询**同文**的那条必须排在毫不相干的那条前面（假 embedder 对同文给同向量）。
  assert.equal(hitIds(semantic)[0], String(first.id), '与查询同文的记录必须排在语义第一位（排序真的用了向量）')
  assert.deepEqual(hitIds(semantic).sort(), [String(first.id), String(second.id)].sort(), '语义模式仍返回同一候选池，只是换了排序')
  assert.ok(semantic[0]!.score > semantic[1]!.score, '语义分必须真的拉开（不是两条同为 0）')
  assert.notDeepEqual(
    hitIds(semantic),
    hitIds(lexical).filter((id) => id === String(first.id) || id === String(second.id)),
    '对照：语义排序不是词面排序的复印件（否则「生效」无从谈起）',
  )

  // ---- 语义第二发（同一个查询）：查询与两条候选都进了缓存 ⇒ 一次 embed 都不再调 ----
  const again = await (service.recall({ query: V13_TEXT.hit, mode: 'semantic', limit: 50 }) as Promise<Array<{ record: Json }>>)
  const afterSecond = countsOf(service)
  assert.equal(afterSecond.calls, afterFirst.calls, '全部命中缓存 ⇒ 第二次召回不得再调 embed（calls 不动）')
  assert.equal(afterSecond.hits, 3, '三段都命中缓存 ⇒ hits +3')
  assert.equal(afterSecond.misses, afterFirst.misses, '全命中 ⇒ misses 不再增长')
  assert.deepEqual(service.lastRecall(), { mode: 'semantic', used: true, fallback: null, candidates: 2, vectors: 2 }, '缓存命中同样是「用上了嵌入」')
  assert.deepEqual(hitIds(again), hitIds(semantic), '同一查询 + 同一库 ⇒ 缓存不改变结果')

  // ---- 方向性总结：缓存只让 hits 涨、calls 停；全部为单调不减 ----
  for (const key of ['calls', 'errors', 'hits', 'misses', 'timeouts'] as const) {
    assert.ok(afterSecond[key] >= afterFirst[key], `计数只加不减：${key}`)
  }
  assert.ok(afterSecond.calls > 0 && afterSecond.misses > 0 && afterSecond.hits > 0, '三个计数都必须被真实地推动过（否则断言是空的）')

  // ---- 清除后回到起点：语义请求再次回落词面并如实标记 ----
  assert.deepEqual(service.setEmbedder(null), { ok: true, id: null })
  const afterClear = countsOf(service)
  const cleared = await (service.recall({ query: V13_TEXT.hit, mode: 'semantic', limit: 50 }) as Promise<Array<{ record: Json }>>)
  assert.deepEqual(hitIds(cleared), hitIds(lexical), '清除后语义回落词面（集合）')
  assert.equal(service.lastRecall()?.fallback, 'no-embedder', '清除后必须如实标 no-embedder')
  assert.deepEqual(countsOf(service), afterClear, '未注册时一次 embed 都不该发生（回落不是「再试一次」）')
})

// ---------------------------------------------------------------- 30. §0.4 失败绝不冒泡

test('protocol#30 embedder 抛错/形状错/维度错/超时：服务面不抛、计 errors、回落词面（§0.4）', async (t) => {
  const harness = makeV11Harness({ config: { consolidateEnabled: false, embedderTimeoutMs: 40 } })
  t.after(() => harness.dispose())
  await harness.settle()
  const service = v13(harness)
  const write = async (subject: string, text: string): Promise<string> =>
    String((await service.write({ kind: 'semantic', origin: 'observed', subject, text })).id)
  const wanted = await write('v13.fault.wanted', V13_TEXT.pnpm)
  await write('v13.fault.other', V13_TEXT.unrelated)

  const lexical = lexicalHits(service, { query: 'pnpm' })
  const expectedIds = hitIds(lexical)

  /** 每个假 embedder 都注册 → 跑一次语义 → 断言「不抛 + 计 errors + 回落词面 + 诊断如实」。 */
  const faults: Array<[string, (texts: readonly string[]) => unknown, V13RecallDiag['fallback']]> = [
    ['同步抛错', (_texts: readonly string[]) => { throw new Error('embedder exploded (fault injection)') }, 'embed-error'],
    ['返回 reject', (_texts) => Promise.reject(new Error('embedder rejected (fault injection)')), 'embed-error'],
    ['形状不对：非数组', () => 'not-an-array', 'embed-error'],
    ['形状不对：长度与输入不符', () => [[1, 2, 3]], 'embed-error'],
    ['形状不对：向量长度不等', (texts) => texts.map((_text, index) => (index === 0 ? [1, 2, 3] : [1, 2])), 'embed-error'],
    ['形状不对：含 NaN', (texts) => texts.map(() => [1, Number.NaN, 3]), 'embed-error'],
    ['形状不对：含非数', (texts) => texts.map(() => [1, '2', 3]), 'embed-error'],
    ['维度与声明不一致', (texts) => texts.map(() => [1, 2]), 'embed-error'],
    ['永不 settle（超时）', () => new Promise(() => {}), 'timeout'],
  ]

  for (const [label, embedOverride, expectedFallback] of faults) {
    const { embedder } = makeV13Embedder({ id: `faulty-${encodeURIComponent(label)}`, dimensions: label === '维度与声明不一致' ? 3 : undefined, embed: (texts) => embedOverride(texts) })
    assert.deepEqual(service.setEmbedder(embedder), { ok: true, id: `faulty-${encodeURIComponent(label)}` }, `前置条件：注册故障 embedder：${label}`)
    const before = countsOf(service)

    // 关键断言：**不抛**。任何 embedding 失败都不许冒泡到回合（§0.4）。
    let hits: Array<{ record: Json }> = []
    await assert.doesNotReject(
      async () => { hits = (await (service.recall({ query: 'pnpm', mode: 'semantic', limit: 50 }) as Promise<Array<{ record: Json }>>)) },
      `嵌入失败绝不允许抛给调用方：${label}`,
    )

    assert.deepEqual(hitIds(hits), expectedIds, `失败后必须回落词面（同集合同序）：${label}`)
    const after = countsOf(service)
    assert.equal(after.errors, before.errors + 1, `失败必须计一次 errors：${label}`)
    assert.equal(after.calls, before.calls + 1, `失败的那次调用照样算 calls：${label}`)
    assert.equal(after.hits, before.hits, `失败的批次不得写缓存 ⇒ hits 不动：${label}`)
    const diag = service.lastRecall()
    assert.equal(diag?.used, false, `失败时绝不假装用了语义（used 必须 false）：${label}`)
    assert.equal(diag?.fallback, expectedFallback, `诊断必须如实给出回落原因：${label}`)
    assert.equal(diag?.vectors, 0, `失败时一个向量都没用上：${label}`)
    if (expectedFallback === 'timeout') {
      assert.equal(after.timeouts, before.timeouts + 1, `超时必须计 timeouts（§3）：${label}`)
    }
    // §0.4 的另一半：失败也不能写坏记录 —— 库里那两条一字不动。
    assert.equal(service.stats().records, 2, `嵌入失败不得增删记录：${label}`)
    assert.ok(service.list().some((row) => String(row.id) === wanted), `嵌入失败不得丢记忆：${label}`)
  }

  // 失败之后仍然可以正常注册一个好 embedder 并真的用上语义（故障不是终态）。
  const good = makeV13Embedder({ id: 'recovered', dimensions: 3 })
  assert.deepEqual(service.setEmbedder(good.embedder), { ok: true, id: 'recovered' })
  await (service.recall({ query: V13_TEXT.hit, mode: 'semantic', limit: 50 }) as Promise<unknown>)
  assert.deepEqual(service.lastRecall(), { mode: 'semantic', used: true, fallback: null, candidates: 2, vectors: 2 }, '换掉故障 embedder 后必须立即恢复语义（不是永久降级）')
})

// ---------------------------------------------------------------- 31. §0.3 注入路径

test("protocol#31 注入路径默认不用语义：embedderRecallMode 缺省 'off' ⇒ 两条注入通道逐字节不变（§0.3）", async (t) => {
  const dir = makeBranchDir(V11_BRANCH)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 刻意**不开** `embedderRecallMode`：这是 §0.3 的缺省，也是 0.5.19 的注入路径。
  const harness = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  harness.emit('session/event', { id: 'session-v13', header: { cwd: dir } }, { type: 'session/start', seq: 1 })
  await buildV11Library(harness)
  const service = v13(harness)
  const { embedder, recorder } = makeV13Embedder({ id: 'injected-but-off', dimensions: 3 })

  const selfBefore = harness.selfBlock()
  const contextBefore = harness.contextBlock(null)
  assert.ok(contextBefore.includes(V11_TEXT.matchedProfile), `前置条件：召回块必须非空（否则断言是空的）：${contextBefore}`)

  // 注册一个**可用**的 embedder，注入路径仍然必须一个字节都不变、一次 embed 都不调。
  assert.deepEqual(service.setEmbedder(embedder), { ok: true, id: 'injected-but-off' }, '前置条件：注册可用 embedder')
  assert.equal(service.capabilities().embedder, true, '前置条件：能力探测确实看到它')
  assert.equal(harness.selfBlock(), selfBefore, '注册 embedder 不得改变常驻自画像块')
  assert.equal(harness.contextBlock(null), contextBefore, '注册 embedder 不得改变按轮召回块')
  assert.equal(recorder.calls(), 0, "embedderRecallMode 缺省 'off' ⇒ 注入路径一次 embed 都不调（§0.3）")

  // 敲一圈服务面（含语义），注入路径仍不受影响。
  for (const [label, probe] of [
    ['list()', () => service.list()],
    ['stats()', () => service.stats()],
    ['capabilities()', () => service.capabilities()],
    ["recall({mode:'lexical'})", () => lexicalHits(service, { query: 'pnpm', mode: 'lexical' })],
    ["recall({mode:'semantic'})", () => service.recall({ query: 'pnpm', mode: 'semantic', limit: 50 })],
    ["recall({mode:'hybrid'})", () => service.recall({ query: 'pnpm', mode: 'hybrid', limit: 50 })],
  ] as Array<[string, () => unknown]>) {
    await probe()
    assert.equal(harness.selfBlock(), selfBefore, `敲过 ${label} 之后，常驻自画像块必须逐字节不变`)
    assert.equal(harness.contextBlock(null), contextBefore, `敲过 ${label} 之后，按轮召回块必须逐字节不变`)
  }

  // 显式打开 `embedderRecallMode: 'recall'` 才允许混合打分 —— 对照组：那时嵌入确实被调用。
  const onHarness = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false, embedderRecallMode: 'recall' } })
  t.after(() => onHarness.dispose())
  await onHarness.settle()
  onHarness.emit('session/event', { id: 'session-v13-on', header: { cwd: dir } }, { type: 'session/start', seq: 1 })
  await buildV11Library(onHarness)
  const onService = v13(onHarness)
  const onRecorder = makeV13Embedder({ id: 'injected-and-on', dimensions: 3 })
  assert.deepEqual(onService.setEmbedder(onRecorder.embedder), { ok: true, id: 'injected-and-on' })
  assert.equal(harness.contextBlock(null), contextBefore, '对照：另一个 harness 的开关不影响本 harness 的注入路径')
  // 显式打开后，按轮召回会异步重排 —— 只要求「不再与 off 时逐字节相同」这件事**可能**发生，
  // 不在这里重复 host.test.ts 的混合打分回归（本套件只钉协议面）。
  assert.equal(onService.capabilities().embedderId, 'injected-and-on', '对照组：开关打开且已注册')
})

// ---------------------------------------------------------------- 32. §6 文档一致性

test('protocol#32 两份协议文档 §11 已加 v1.3 的加法，且 `## ` 小节数相等（§6）', () => {
  const en = readFileSync(new URL('../docs/protocol-v1.md', import.meta.url), 'utf8')
  const zh = readFileSync(new URL('../docs/protocol-v1.zh.md', import.meta.url), 'utf8')
  const headingsOf = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('## '))

  const enSections = headingsOf(en)
  const zhSections = headingsOf(zh)
  assert.equal(zhSections.length, enSections.length, `中英两份文档必须逐节对齐（## 数量）：en=${enSections.length}，zh=${zhSections.length}`)
  assert.ok(enSections.length >= 11, `§6 要求两份文档都补上 §11：实际 en=${enSections.length}，zh=${zhSections.length}`)

  for (const doc of [en, zh]) {
    assert.ok(doc.includes('## 11.'), '§6：两份协议文档都必须有 §11（v1.3 的加法）')
    for (const method of ['setEmbedder', 'capabilities', 'lastRecall']) {
      assert.ok(doc.includes(method), `§11 必须点名 v1.3 的新方法/字段：${method}`)
    }
    assert.ok(doc.includes('stats') && doc.includes('embedder'), '§11 必须写明 stats() 追加 embedder')
    // 隐私说明（§0.1 + §6）：插件不联网、是否外发由宿主决定 —— 这句话必须写给用户看。
    assert.ok(
      /不联网|no network|never calls the network|not call the network/iu.test(doc),
      '§6：两份文档都必须写下「插件不联网」这句隐私说明',
    )
    assert.ok(
      /宿主|host/iu.test(doc),
      '§6：隐私说明必须讲清「是否把正文送去外部服务由宿主/用户决定」',
    )
  }
  // 文档是公开的：不得混进任何人的机器路径（与 #11 同一纪律，新增文档同样受约束）。
  assert.doesNotMatch(en + zh, /\b[A-Za-z]:\\/u, '文档不得出现本机绝对路径')
})

// ---------------------------------------------------------------- 33. §0.2 缺省面零成本

test('protocol#33 未注册 embedder：服务面缺省操作一次嵌入调用都不发生（§0.2 逐字节相同的代价面）', async (t) => {
  const harness = makeV11Harness({ config: { writePolicy: 'ask', consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  const semanticOnly = semanticOnlyService(v13(harness))
  await buildV11Library(harness as unknown as V11Harness)

  const stats0 = harness.service().stats()
  const { embedder } = makeV13Embedder({ id: 'cost-probe', dimensions: 3 })

  // 刻意**不注册**：整轮服务面操作下来，嵌入计数器必须一动不动。
  const before = countsOf(semanticOnly)
  await harness.service().consolidate('protocol-v1.3-probe')
  semanticOnly.list()
  semanticOnly.list({ status: 'active' })
  semanticOnly.stats()
  semanticOnly.capabilities()
  assert.deepEqual(countsOf(semanticOnly), before, '未注册 ⇒ 一切服务面操作零嵌入调用')
  assert.deepEqual(before, { calls: 0, errors: 0, hits: 0, misses: 0, timeouts: 0 }, '本进程里此前也一次都没调过')
  assert.equal(semanticOnly.lastRecall(), null, '本进程从未召回 ⇒ lastRecall() 是 null（不是「假装有一次」）')

  // 注册再清除：计数器**只加不减**（清除不清零，与 stats().writes 同性质）。
  semanticOnly.setEmbedder(embedder)
  await (semanticOnly.recall({ query: 'pnpm', mode: 'semantic', limit: 50 }) as Promise<unknown>)
  const afterUse = countsOf(semanticOnly)
  assert.ok(afterUse.calls > 0, '前置条件：注册并语义召回一次，计数器必须被推动')
  semanticOnly.setEmbedder(null)
  assert.deepEqual(countsOf(semanticOnly), afterUse, '清除 embedder 不得清零历史计数（只加不减）')
  assert.equal(typeof stats0.version, 'number', '既有 stats 字段不受 v1.3 影响')
})

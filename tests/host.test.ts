// 宿主半边（`src/index.ts` → 构建产物 `lib/index.js`）的回归测试：用假 ctx 驱动，不需要真实宿主。
//
// 为什么能用假 ctx：apply() 只触碰「实测运行契约」里那一小块成员
// （systemPrompt / storageDomain / tools / commands / agents / on / effect / get / inject / provide），
// 因此注册契约、配置解包、拒写、注入形状与卸载安全都能在这里钉死，不必起 DSH。
//
// 与 lib/client 两边一致：导入的是**构建产物**（`pnpm test` / 自检会先跑 tsc 构建）。
// 独立性：每个用例新建一套假 ctx + 假领域，自报告写到 os.tmpdir() 的临时目录，
// 绝不读写真实 $DSH_HOME。
//
// 用例 ↔ 审计优先级：
//   1. apply 注册契约（7 个工具 / memory 命令 / 两条注入通道 / 未知子命令回落 help）
//   2. volatile 配置解包（rev20 的 `[object Object]` 领域名回归）
//   3. 写入链路拒写敏感文本，且从未触碰领域表
//   4. agent/pre-step：dry 不注入、inject 的消息形状
//   5. 卸载安全：清理函数落盘用量 + 只释放本实例打开的域句柄
//   6. 启动水位 await（thenable 不再让每次启动重跑整轮整合）
//   7. 捕获重入锁（超时后在跑的捕获不会被下一个回合并发进入）
//   8. /memory clear 的枚举校验、AND 语义与 --all 互斥
//   9. /memory import 的逐字段白名单校验与降级
//  10. 工具结果按条目数截断（仍是完整 JSON）
//  11. 落盘失败的删除不得报成功（forget / clear / memory_forget）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as applyRaw } from '../lib/index.js'
import { workspaceKeyOf } from '../lib/lib.js'

/** 假 ctx 只实现本插件实际用到的那一块；测试里不假装它是完整宿主类型。 */
const apply = applyRaw as unknown as (ctx: Record<string, unknown>, config?: Record<string, unknown>) => void

type Json = Record<string, unknown>

/** 运行版把 volatile 字段以访问器对象（`.get()`）下发。 */
const volatile = (value: unknown): { get: () => unknown } => ({ get: () => value })

interface ToolCall {
  name: string
  description?: string
  parameters?: Json
  output?: unknown
  execute: (args: Json, exec?: unknown) => unknown
}

interface CommandRegistration {
  name: string
  description?: string
  handler: (invocation: { rawInput?: string }) => Promise<{ kind: string; text: string }> | { kind: string; text: string }
}

interface PromptRegistration {
  name?: string
  order?: number
  text: (...args: unknown[]) => unknown
}

interface EffectRecord {
  label: string
  cleanup: (() => unknown) | undefined
  called: boolean
}

interface MemoryService {
  list(): Json[]
  stats(): { records: number; version: number; opened: boolean }
  recall(options: Json): Array<{ record: Json; match: number; score: number }>
  write(input: Json): Promise<{ ok: boolean; status?: string; id?: string; error?: string }>
  consolidate(reason?: string): Promise<void>
}

interface DomainControl {
  rows: Map<string, Json>
  puts: Array<{ key: string; value: Json }>
  deletes: string[]
  closeCalls: number
  /** true 时 put 挂起（制造「捕获已超时、但仍在后台落盘」的场景）。 */
  gatePuts: boolean
  failDeletes: boolean
  releasePuts(): void
}

interface HarnessOptions {
  config?: Json
  /** domain.global.get() 的返回值。 */
  globalValue?: unknown
  /** 把 global.get() 包成 Promise —— 运行版就是这样。 */
  asyncGlobal?: boolean
  /** 不写自报告（大量写入的用例可以省掉每次 flush 的同步文件写）。 */
  noReport?: boolean
}

interface Harness {
  ctx: Json
  tools: ToolCall[]
  commands: CommandRegistration[]
  sections: PromptRegistration[]
  contexts: PromptRegistration[]
  effects: EffectRecord[]
  provided: Map<string, unknown>
  openSpecs: Json[]
  domain: DomainControl
  roots: unknown[]
  tempDir: string
  memory(): MemoryService
  tool(name: string): ToolCall
  command(): CommandRegistration
  runCommand(rawInput: string): Promise<{ kind: string; text: string }>
  emit(event: string, ...args: unknown[]): Promise<unknown[]>
  emitSync(event: string, ...args: unknown[]): void
  preStep(payload: unknown, next: () => Promise<unknown>): Promise<unknown>
  settle(ticks?: number): Promise<void>
  runEffect(label: string): Promise<void>
  report(): Json
  reportState(): Json
  dispose(): Promise<void>
}

/** 假领域：把「落盘」变成可观测、可注入故障的内存表。 */
function makeFakeDomain(options: HarnessOptions): { domain: Json; control: DomainControl } {
  const rows = new Map<string, Json>()
  const puts: Array<{ key: string; value: Json }> = []
  const deletes: string[] = []
  const pending: Array<() => void> = []
  let globalValue: unknown = options.globalValue ?? null

  const control: DomainControl = {
    rows,
    puts,
    deletes,
    closeCalls: 0,
    gatePuts: false,
    failDeletes: false,
    releasePuts: () => {
      control.gatePuts = false
      for (const resolve of pending.splice(0)) resolve()
    },
  }

  const table = {
    entries: (): Array<[string, Json]> => [...rows.entries()],
    get: (key: string): Json | undefined => rows.get(key),
    put: (key: string, value: Json): Promise<void> => {
      puts.push({ key, value })
      if (!control.gatePuts) {
        rows.set(key, value)
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        pending.push(() => {
          rows.set(key, value)
          resolve()
        })
      })
    },
    delete: (key: string): Promise<void> => {
      if (control.failDeletes) return Promise.reject(new Error('delete failed: disk full'))
      deletes.push(key)
      rows.delete(key)
      return Promise.resolve()
    },
  }

  const domain: Json = {
    table: (_name: string) => table,
    global: {
      get: (): unknown => (options.asyncGlobal ? Promise.resolve(globalValue) : globalValue),
      set: (value: unknown): void => { globalValue = value },
    },
    close: (): Promise<void> => {
      control.closeCalls += 1
      return Promise.resolve()
    },
  }
  return { domain, control }
}

/** 一套假 ctx：记录所有注册，并让 effect / on 能被测试真正驱动。 */
function makeHarness(options: HarnessOptions = {}): Harness {
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-memory-host-'))
  const { domain: fakeDomain, control } = makeFakeDomain(options)

  const tools: ToolCall[] = []
  const commands: CommandRegistration[] = []
  const sections: PromptRegistration[] = []
  const contexts: PromptRegistration[] = []
  const effects: EffectRecord[] = []
  const provided = new Map<string, unknown>()
  const openSpecs: Json[] = []
  const listenerMap = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const roots: unknown[] = []

  /** ctx.effect：立刻执行回调，并保留它返回的清理函数。 */
  const registerEffect = (callback: () => unknown, label = ''): (() => void) => {
    const result = callback()
    effects.push({ label, cleanup: typeof result === 'function' ? (result as () => unknown) : undefined, called: false })
    return () => {}
  }

  const settings = { configure: (): (() => void) => () => {}, describe: (): Json[] => [] }
  const services: Record<string, unknown> = {
    storageDomain: {
      open: (spec: Json): Promise<Json> => {
        openSpecs.push(spec)
        return Promise.resolve(fakeDomain)
      },
    },
    tokenMeter: { estimateMessage: (): number => 42 },
    settings,
  }

  const ctx: Json = {
    get: (service: string): unknown => services[service],
    systemPrompt: {
      section: (registration: PromptRegistration): (() => void) => { sections.push(registration); return () => {} },
      context: (registration: PromptRegistration): (() => void) => { contexts.push(registration); return () => {} },
    },
    tools: { register: (definition: ToolCall): (() => void) => { tools.push(definition); return () => {} } },
    commands: { register: (definition: CommandRegistration): (() => void) => { commands.push(definition); return () => {} } },
    agents: { roots: (): unknown[] => roots },
    on: (event: string, listener: (...args: unknown[]) => unknown): (() => void) => {
      const list = listenerMap.get(event) ?? []
      list.push(listener)
      listenerMap.set(event, list)
      return () => {}
    },
    effect: registerEffect,
    inject: (_serviceNames: string[], callback: (scope: unknown) => void): (() => void) => {
      // 作用域注入：服务已就绪 → 立刻执行回调，scope 上同样有 effect 与 settings。
      callback({ effect: registerEffect, settings })
      return () => {}
    },
    provide: (serviceName: string, service: unknown): void => { provided.set(serviceName, service) },
  }

  apply(ctx, { ...(options.noReport === true ? {} : { reportPath: join(tempDir, 'report.json') }), ...options.config })

  const memory = (): MemoryService => {
    const service = provided.get('memory')
    assert.ok(service, 'apply 必须 provide("memory") 服务')
    return service as MemoryService
  }

  const tool = (toolName: string): ToolCall => {
    const found = tools.find((entry) => entry.name === toolName)
    assert.ok(found, `缺少工具：${toolName}`)
    return found
  }

  const command = (): CommandRegistration => {
    assert.equal(commands.length, 1, 'commands.register 恰好一次')
    return commands[0]!
  }

  const settle = async (ticks = 8): Promise<void> => {
    for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  const emit = async (event: string, ...args: unknown[]): Promise<unknown[]> => {
    const results: unknown[] = []
    for (const listener of listenerMap.get(event) ?? []) results.push(await listener(...args))
    return results
  }

  const emitSync = (event: string, ...args: unknown[]): void => {
    for (const listener of listenerMap.get(event) ?? []) listener(...args)
  }

  const preStep = async (payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
    const list = listenerMap.get('agent/pre-step') ?? []
    assert.equal(list.length, 1, 'agent/pre-step 必须恰好注册一次')
    return await list[0]!(payload, next)
  }

  const runEffect = async (label: string): Promise<void> => {
    const effect = effects.find((entry) => entry.label === label)
    assert.ok(effect, `缺少 effect：${label}`)
    effect.called = true
    if (!effect.cleanup) return
    const result = effect.cleanup()
    if (result && typeof (result as { then?: unknown }).then === 'function') await (result as Promise<unknown>)
  }

  const report = (): Json => JSON.parse(readFileSync(join(tempDir, 'report.json'), 'utf8')) as Json
  const reportState = (): Json => (report().state ?? {}) as Json

  const dispose = async (): Promise<void> => {
    // 逆序释放：定时器也要清掉，否则 node --test 会挂在未关闭的 interval 上。
    for (const effect of [...effects].reverse()) {
      if (effect.called || !effect.cleanup) continue
      effect.called = true
      try {
        const result = effect.cleanup()
        if (result && typeof (result as { then?: unknown }).then === 'function') await (result as Promise<unknown>)
      } catch { /* 卸载失败不影响测试结论 */ }
    }
    rmSync(tempDir, { recursive: true, force: true })
  }

  return {
    ctx, tools, commands, sections, contexts, effects, provided, openSpecs, domain: control, roots, tempDir,
    memory, tool, command,
    runCommand: async (rawInput: string) => await command().handler({ rawInput }),
    emit, emitSync, preStep, settle, runEffect, report, reportState, dispose,
  }
}

/** 一个「根 agent」：捕获链路要求 ctx.agents.roots() 里能查到它。 */
const agentWith = (cwd: string): Json => ({ session: { id: 'session-1', seq: 5, header: { cwd } } })

// ---------------------------------------------------------------- 1. 注册契约

test('host#1 apply 注册契约：7 个工具（都带 output）、memory 命令、两条注入通道各 1 次', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())

  assert.equal(harness.tools.length, 7, 'ctx.tools.register 必须恰好收到 7 个工具')
  assert.deepEqual(
    harness.tools.map((entry) => entry.name).sort(),
    ['memory_explain', 'memory_forget', 'memory_list', 'memory_maintain', 'memory_recall', 'memory_stats', 'memory_write'],
  )
  for (const entry of harness.tools) {
    assert.ok(entry.output, `${entry.name} 必须带 output（宿主用它渲染结果）`)
    assert.equal(typeof entry.execute, 'function', `${entry.name}.execute 必须是函数`)
    assert.equal((entry.parameters as Json)?.type, 'object', `${entry.name}.parameters 必须是 JSON Schema 对象`)
  }

  assert.equal(harness.commands.length, 1)
  assert.equal(harness.commands[0]?.name, 'memory')

  assert.equal(harness.sections.length, 1, 'systemPrompt.section 恰好注册一次')
  assert.equal(harness.contexts.length, 1, 'systemPrompt.context 恰好注册一次')
  assert.equal(typeof harness.sections[0]?.text, 'function')
  assert.equal(typeof harness.contexts[0]?.text, 'function')

  // 未知子命令回落到 help，而不是抛错或静默成功
  const result = await harness.runCommand('definitely-not-a-subcommand')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /用法：\/memory list/)
})

// ---------------------------------------------------------------- 2. volatile 解包（rev20 回归）

test('host#2 volatile 配置解包：访问器对象不得被当成领域名（[object Object] 回归）', async (t) => {
  const harness = makeHarness({
    config: { domainName: volatile('dsh_check'), maxInjectedTokens: volatile(120) },
  })
  t.after(() => harness.dispose())
  await harness.settle()

  assert.equal(harness.openSpecs.length, 1, 'storageDomain.open 必须被调用一次')
  const spec = harness.openSpecs[0]!
  assert.equal(typeof spec.name, 'string', '领域名必须是字符串')
  assert.equal(spec.name, 'dsh_check', 'volatile 字段必须解包成它 .get() 的值')
  assert.notEqual(spec.name, '[object Object]', 'rev20 的真实缺陷：对象被当成了 unit 名')
  assert.equal(harness.memory().stats().opened, true, '解包正确时领域能正常打开')
})

// ---------------------------------------------------------------- 3. 写入链路拒写

test('host#3 写入链路拒写敏感文本：ok=false 且领域表从未被写过', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const secret = '这台机器的部署密钥是 sk-abcdefghijklmnop123456，请记住'
  const raw = await harness.tool('memory_write').execute({ kind: 'user_profile', text: secret })
  const payload = JSON.parse(String(raw)) as Json

  assert.equal(payload.ok, false)
  assert.match(String(payload.error), /rejected_sensitive/)
  assert.equal(harness.domain.puts.length, 0, '拒写路径不得触碰领域表（put 一次都不能发生）')
  assert.equal(harness.memory().list().length, 0)
})

// ---------------------------------------------------------------- 4. agent/pre-step

test('host#4a agent/pre-step：recallMode=dry 时原样返回 decision（不注入）', async (t) => {
  const harness = makeHarness({ config: { recallMode: 'dry' } })
  t.after(() => harness.dispose())
  await harness.settle()
  await harness.memory().write({ kind: 'user_profile', text: '构建流程统一用 pnpm，产物输出到 dist 目录' })

  const decision = {
    kind: 'continue',
    messages: [{ role: 'user', content: [{ type: 'text', text: '请继续按构建流程用 pnpm 输出 dist' }] }],
  }
  const result = await harness.preStep({ turn: 1, agent: agentWith('C:\\work\\demo') }, async () => decision)

  assert.equal(result, decision, 'dry 模式必须原样返回同一个 decision 对象')
  assert.equal((result as { messages: unknown[] }).messages.length, 1, '不得追加消息')
})

test('host#4b agent/pre-step：inject 模式的 runtime-context 消息形状正确', async (t) => {
  const harness = makeHarness({ config: { recallMode: 'inject' } })
  t.after(() => harness.dispose())
  await harness.settle()
  await harness.memory().write({ kind: 'user_profile', text: '构建流程统一用 pnpm，产物输出到 dist 目录' })

  const userMessage = { role: 'user', content: [{ type: 'text', text: '请继续按构建流程用 pnpm 输出 dist' }] }
  const decision = { kind: 'continue', marker: 'keep-me', messages: [userMessage] }
  const result = await harness.preStep({ turn: 3, agent: agentWith('C:\\work\\demo') }, async () => decision) as Json

  assert.equal(result.kind, 'continue')
  assert.equal(result.marker, 'keep-me', 'decision 的其它字段必须原样保留')
  const messages = result.messages as Json[]
  assert.equal(messages.length, 2, '只在末尾追加一条')
  assert.equal(messages[0], userMessage, '原有消息不得被改动')

  const injected = messages[1]!
  assert.equal(injected.role, 'user')
  assert.ok(typeof injected.id === 'string' && (injected.id as string).length > 0, 'id 必须是非空字符串')
  const source = injected.source as Json
  assert.equal(source.kind, 'runtime-context', '必须沿用宿主已注册的 source.kind')
  assert.equal(source.form, 'snapshot')
  assert.ok(Array.isArray(source.sections) && (source.sections as unknown[]).length > 0)
  const content = injected.content as Json[]
  assert.equal(content.length, 1)
  assert.equal(content[0]!.type, 'text')
  assert.match(String(content[0]!.text), /相关记忆/)
  assert.match(String(content[0]!.text), /pnpm/, '注入内容必须包含命中的记忆')
})

// ---------------------------------------------------------------- 5. 卸载安全

test('host#5 卸载安全：清理函数落盘用量，并只释放本实例打开的域句柄', async (t) => {
  // 关掉整合（含启动整合），这样「用量落盘」的唯一触发点就是卸载清理 —— 因果不含糊。
  const harness = makeHarness({ config: { consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  const write = await harness.memory().write({ kind: 'user_profile', text: '构建流程统一用 pnpm，产物输出到 dist 目录' })
  assert.equal(write.ok, true)
  const putsAfterWrite = harness.domain.puts.length

  // memory_recall 会 markUsed：只改内存 + 标脏，不落盘
  JSON.parse(String(await harness.tool('memory_recall').execute({ query: '构建流程 pnpm dist' })))
  assert.equal(harness.domain.puts.length, putsAfterWrite, '记用量不落盘（只在内存累加）')

  await harness.runEffect('dsh-memory.domain')

  const usagePuts = harness.domain.puts.slice(putsAfterWrite)
  assert.ok(
    usagePuts.some((put) => put.key === write.id && Number(put.value.useCount) >= 1),
    '卸载时必须把累加的用量落盘',
  )
  // 域句柄的归属权在本插件（storage.zh.md：Domain.close() 由 consumer 负责），
  // 所以卸载时释放它 —— 否则被替换的修订版会一直占着域，下一个实例只会拿到 already-open。
  assert.equal(harness.domain.closeCalls, 1, '只关闭本实例打开的句柄，且恰好一次')

  // 清理函数必须幂等：再跑一次不得二次关闭（domain 已被置空）
  await harness.runEffect('dsh-memory.domain')
  assert.equal(harness.domain.closeCalls, 1, '重复卸载不得二次 close')
})

// ---------------------------------------------------------------- 6. 启动水位 await

test('host#6 启动水位：domain.global.get() 返回 thenable 时必须 await', async (t) => {
  const fresh = Date.now() - 60_000 // 1 分钟前 → 远小于整合间隔
  const freshHarness = makeHarness({ asyncGlobal: true, globalValue: { schemaVersion: 1, lastConsolidatedAt: fresh } })
  const staleHarness = makeHarness({ asyncGlobal: true, globalValue: { schemaVersion: 1, lastConsolidatedAt: Date.now() - 3_600_000 } })
  t.after(() => freshHarness.dispose())
  t.after(() => staleHarness.dispose())
  await freshHarness.settle()
  await staleHarness.settle()

  const freshMeta = freshHarness.reportState().meta as Json
  assert.equal(Number(freshMeta.lastConsolidatedAt), fresh, '水位必须被 await 后再存进 state.meta')
  assert.equal(Number((freshHarness.reportState().consolidate as Json).runs), 0, '水位是新的 → 启动时不跑整合')

  // 反面对照：水位过期时确实会补跑一次 —— 证明上面的 0 不是因为「水位根本没被使用」。
  assert.equal(Number((staleHarness.reportState().consolidate as Json).runs), 1, '水位过期 → 启动补跑一次整合')
})

// ---------------------------------------------------------------- 7. 捕获重入锁

test('host#7 捕获重入锁：超时后仍在跑的捕获不会被下一个回合并发进入', async (t) => {
  const harness = makeHarness({ config: { captureTimeoutMs: 20 } })
  t.after(() => harness.dispose())
  await harness.settle()

  const agent = agentWith('C:\\work\\demo')
  harness.roots.push(agent)
  harness.emitSync('session/event', agent.session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记住：构建统一用 pnpm。' }] },
  })

  // 让第一次捕获卡在落盘上：Promise.race 会按时返回，但它仍在后台写库
  harness.domain.gatePuts = true
  await harness.emit('agent/turn-stopping', { agent })
  assert.equal(harness.domain.puts.length, 1, '第一次捕获已进入落盘（挂起态）')

  // 第二个回合：此时捕获仍在飞 —— 必须被重入锁挡下
  await harness.emit('agent/turn-stopping', { agent })

  harness.domain.releasePuts()
  await harness.settle()
  await harness.runCommand('consolidate') // 触发一次 flush，把最新状态写进自报告

  const capture = harness.reportState().capture as Json
  assert.equal(Number(capture.turns), 2, '两次回合都被计数')
  assert.equal(Number((capture.skipped as Json)['capture-in-flight']), 1, '重入的那次记为 skipped')
  assert.equal(Number(capture.written), 1, '重入的那次不得写入')
  assert.equal(harness.domain.puts.length, 1, '重入不得产生第二次写入')
})

// ---------------------------------------------------------------- 8. /memory clear

test('host#8 /memory clear：枚举校验、多条件 AND、--all 互斥', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()
  const memory = harness.memory()
  await memory.write({ kind: 'user_profile', text: '用户偏好中文回答与英文标识符' })
  await memory.write({ kind: 'semantic', text: '构建产物统一放在 dist 目录下' })

  const bogusKind = await harness.runCommand('clear --kind=user_profil --yes')
  assert.equal(bogusKind.kind, 'error')
  assert.match(bogusKind.text, /未知的 --kind=user_profil/)
  assert.deepEqual(harness.domain.deletes, [], '非法枚举不得删除任何条目')

  const bogusScope = await harness.runCommand('clear --scope=global --yes')
  assert.equal(bogusScope.kind, 'error')
  assert.match(bogusScope.text, /未知的 --scope=global/)
  assert.deepEqual(harness.domain.deletes, [])

  const mixed = await harness.runCommand('clear --all --kind=user_profile --yes')
  assert.equal(mixed.kind, 'error')
  assert.match(mixed.text, /--all 不能与 --kind\/--scope 同时使用/)
  assert.deepEqual(harness.domain.deletes, [])

  // AND：user_profile 且 workspace → 0 条（user_profile 是 profile 级）
  const andMiss = await harness.runCommand('clear --kind=user_profile --scope=workspace --yes')
  assert.equal(andMiss.kind, 'success')
  assert.match(andMiss.text, /没有匹配/)
  assert.deepEqual(harness.domain.deletes, [])

  // AND 命中：user_profile 且 profile → 恰好 1 条（旧实现是 OR，会连 semantic 一起删）
  const andHit = await harness.runCommand('clear --kind=user_profile --scope=profile --yes')
  assert.equal(andHit.kind, 'success')
  assert.match(andHit.text, /已永久删除 1 条/)
  assert.equal(harness.domain.deletes.length, 1)
  const left = memory.list()
  assert.equal(left.length, 1)
  assert.equal(left[0]!.kind, 'semantic')
})

// ---------------------------------------------------------------- 9. /memory import

test('host#9 /memory import：逐字段白名单校验与降级（伪造 user_explicit 不再生效）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const file = join(harness.tempDir, 'import.json')
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    items: [
      // 伪造用户身份 + pinned + 越界数值 + 非字符串 scope.key + 混合 tags
      {
        kind: 'user_profile',
        text: '用户偏好深色主题与中文回答',
        origin: 'user_explicit',
        pinned: true,
        confidence: 9,
        importance: -3,
        scope: { level: 'profile', key: 42 },
        tags: ['a', 7, 'b'],
      },
      // 缺 scope → 按 defaultScopeFor(kind) 补；字符串数值不夹取，走默认值
      { kind: 'semantic', text: '构建流程统一使用 pnpm 并且输出到 dist 目录', confidence: '0.99', importance: 0.7 },
      // 以下都应跳过并计数
      { kind: 'not_a_kind', text: '非法 kind' },
      { kind: 'semantic', text: '非法 scope.level', scope: { level: 'global', key: '*' } },
      { kind: 'semantic', text: '   ' },
      'not-an-object',
    ],
  }))

  const result = await harness.runCommand(`import ${file}`)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /新建 2 条/)
  assert.match(result.text, /非法条目 4 条/)
  assert.match(result.text, /observed/, '返回文案必须说明导入按 observed 处理')

  const rows = harness.memory().list()
  assert.equal(rows.length, 2)
  const profile = rows.find((row) => row.kind === 'user_profile')!
  assert.equal(profile.origin, 'observed', 'origin 一律降级：导入文件不能铸造用户侧身份')
  assert.equal(profile.pinned, false, 'pinned 强制关闭')
  assert.equal(profile.confidence, 1, 'confidence 夹到 [0,1]')
  assert.equal(profile.importance, 0, 'importance 夹到 [0,1]')
  assert.deepEqual(profile.tags, ['a', 'b'], 'tags 只保留字符串')
  assert.equal((profile.scope as Json).key, '*', '非字符串 scope.key 降级为 *')

  const semantic = rows.find((row) => row.kind === 'semantic')!
  assert.equal((semantic.scope as Json).level, 'workspace', '缺 scope 时按 defaultScopeFor(kind) 补')
  assert.equal(semantic.confidence, 0.6, '非数值 confidence 走 makeRecord 默认值')
  assert.equal(semantic.importance, 0.7)
})

// ---------------------------------------------------------------- 10. 工具结果截断

test('host#10 工具结果按条目数截断：仍是完整 JSON，并带 total / truncated', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const memory = harness.memory()
  for (let index = 0; index < 60; index += 1) {
    await memory.write({ kind: 'semantic', text: `第 ${index} 条用于截断验证的记忆文本`, subject: `bulk.${index}` })
  }

  const raw = String(await harness.tool('memory_list').execute({ limit: 100 }))
  const payload = JSON.parse(raw) as Json // 旧实现的 slice 会在这里抛错
  assert.equal(payload.total, 60)
  assert.equal(payload.count, 50)
  assert.equal(payload.truncated, true)
  assert.equal((payload.items as unknown[]).length, 50)

  // limit=5 → 工具自己只产出 5 条，没有触发线上限；`total` 是**本次结果被线上限截断前**的条目数
  const small = JSON.parse(String(await harness.tool('memory_list').execute({ limit: 5 }))) as Json
  assert.equal(small.count, 5)
  assert.equal(small.total, 5)
  assert.equal((small.items as unknown[]).length, 5)
  assert.equal(small.truncated, false, '没超上限时也要给出稳定的 truncated 字段')
})

// ---------------------------------------------------------------- 12. 冷却表 cutoff

test('host#12 冷却表 cutoff：跨会话的旧回合号会被清掉，条目不会被永久压制', async (t) => {
  // 冷却表的键是记录 id，值是该记录最近一次被注入的回合号；回合号按会话从 0 重新计数。
  // 旧实现用「从来没人写过的 state.consolidate.last.turn」算 cutoff（恒为 -200），
  // 于是超过 500 条之后这个表只增不减：上个会话的回合号会永久压制同名条目。
  const harness = makeHarness({
    noReport: true,
    config: {
      // 每回合放行 50 条、冷却 60 回合：11 个回合即可把冷却表推到 550 条（> 500 的收敛阈值）。
      recallTopK: 60,
      recallCooldownTurns: 60,
      maxInjectedTokens: 20_000,
      // 默认 10ms 的召回预算在 600 条记录上会被判成 over-budget（那是性能护栏，不是本用例的被测点）
      recallBudgetMs: 10_000,
    },
  })
  t.after(() => harness.dispose())
  await harness.settle()

  const memory = harness.memory()
  // 每 50 条一个批次，批次内共享 batchK、批次间不共享其它 token：
  // 这样第 K 个回合的查询只会命中第 K 批（记忆侧覆盖率要求 ≥2 个信息量 token）。
  for (let index = 0; index < 600; index += 1) {
    await memory.write({ kind: 'user_profile', text: `构建 batch${Math.floor(index / 50)} child${index}` })
  }

  /** 跑一个回合，返回本轮真正注入的行数（块头 + N 行 + 块尾）。 */
  const runTurn = async (turn: number, batch: number): Promise<number> => {
    const decision = {
      kind: 'continue',
      messages: [{ role: 'user', content: [{ type: 'text', text: `构建 batch${batch} 请继续处理这些内容` }] }],
    }
    const result = await harness.preStep({ turn, agent: agentWith('C:\\work\\demo') }, async () => decision) as { messages: Json[] }
    if (result.messages.length === 1) return 0
    const text = String((((result.messages[1]!.content as Json[])[0]!).text))
    return text.split('\n').length - 2
  }

  // 上一个会话：回合号从 1000 起，11 个回合各注入 50 条新记录 → 冷却表 550 条
  for (let batch = 0; batch < 11; batch += 1) {
    assert.equal(await runTurn(1000 + batch, batch), 50, '每个回合应恰好注入 50 条新记录')
  }

  // 新会话：回合号回到 1，此时 550 条冷却记录全部来自「未来」回合 —— 旧实现下它们会被永久压制
  assert.equal(await runTurn(1, 0), 0, '冷却表生效：新会话第一回合不该重复注入')
  // 触发整合 → 冷却表超过 500 条，cutoff 必须用**当前回合号**把它们收敛掉
  await harness.runCommand('consolidate')
  assert.equal(await runTurn(2, 0), 50, '跨会话的旧回合号必须被清掉，否则条目被永久压制')
})

// ---------------------------------------------------------------- 11. 删除落盘失败

test('host#11 落盘失败的删除不得报成功（memory_forget / forget / clear）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const write = await harness.memory().write({ kind: 'semantic', text: '构建产物统一放在 dist 目录下' })
  const id = String(write.id)
  harness.domain.failDeletes = true

  const tool = JSON.parse(String(await harness.tool('memory_forget').execute({ id }))) as Json
  assert.equal(tool.ok, false)
  assert.equal(tool.error, 'delete_failed')
  assert.equal(harness.memory().list().length, 1, '删除失败要回滚内存：条目仍在')

  const forget = await harness.runCommand(`forget ${id}`)
  assert.equal(forget.kind, 'error')
  assert.match(forget.text, /删除未落盘/)

  const clear = await harness.runCommand('clear --all --yes')
  assert.equal(clear.kind, 'error')
  assert.match(clear.text, /1 条落盘失败/)
  assert.equal(harness.memory().list().length, 1)

  // 恢复后删除成功
  harness.domain.failDeletes = false
  const ok = await harness.runCommand(`forget ${id}`)
  assert.equal(ok.kind, 'success')
  assert.match(ok.text, /已删除/)
  assert.equal(harness.memory().list().length, 0)
  assert.deepEqual(harness.domain.deletes, [id])
})

// ---------------------------------------------------------------- 13. 冷却过滤必须在 top-K 之前

test('host#13 pre-step：冷却过滤发生在 top-K 之前（刚注入过的条目不能把候选池挤空）', async (t) => {
  // recallTopK=1 时最容易暴露：旧实现从 recallRecords 只取 1 条候选，
  // 而刚注入过的条目因为 markUsed 的 recency 加成恰好排第一 → 被冷却过滤掉 → 该回合 0 命中。
  const harness = makeHarness({
    config: { recallMode: 'inject', recallTopK: 1, recallCooldownTurns: 3, consolidateEnabled: false },
    noReport: true,
  })
  t.after(() => harness.dispose())
  await harness.settle()

  const cwd = 'C:/proj/cooldown'
  const scopeKey = workspaceKeyOf(cwd)
  const query = '构建与发布流程都走 pnpm，产物放在哪个目录？'
  const at = (turn: number): unknown => ({ turn, agent: { session: { header: { cwd } } }, signal: { aborted: false } })
  const decision = (text: string): Json => ({ kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
  const injected = (result: unknown): string => {
    const messages = (result as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? []
    return String(messages.at(-1)?.content?.[0]?.text ?? '')
  }

  await harness.memory().write({
    kind: 'semantic',
    text: '构建流程用 pnpm build 跑，构建产物输出到 dist 目录。',
    scope: { level: 'workspace', key: scopeKey },
    importance: 0.9,
  })
  await harness.memory().write({
    kind: 'semantic',
    text: '发布流程用 pnpm publish 发到 npm，发布产物也在 dist。',
    scope: { level: 'workspace', key: scopeKey },
    importance: 0.5,
  })

  const first = await harness.preStep(at(1), async () => decision(query))
  assert.match(injected(first), /构建流程用 pnpm build/u, '第一回合应注入分数最高的那条')

  // 冷却期内的下一回合（turn 2：距上次注入仅 1 轮 < 冷却 3 轮）：
  // 排第一的那条被冷却挡掉，候选池里还必须剩下另一条
  const second = await harness.preStep(at(2), async () => decision(query))
  const text = injected(second)
  assert.match(text, /相关记忆 · 本轮召回/u, '冷却过滤不应把候选池挤空（旧实现这里 0 命中）')
  assert.doesNotMatch(text, /构建流程用 pnpm build/u, '被冷却的条目本轮不得重复注入')
  assert.match(text, /发布流程用 pnpm publish/u, '应改用候选池里的下一条')
})

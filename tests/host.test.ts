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
//  12–16. M6 自画像 v2（契约 docs/self-portrait.md 第 4/6 节）：
//    · memory_write 的 facet 可选（仅 agent_self 有意义）
//    · 写入收敛的 add / reinforce / refine / supersede / skip（含 too-short）
//    · 用户所有物保护：模型不能覆盖 user_explicit / pinned 的自画像
//    · /memory self 的四个子命令（list / set / history / reset）与 help 同步
//    · 反思提示：每会话次数上限、间隔与最小回合、dry/off 不注入也不推进计数、R2 之后单独一条
//  17–19. M10/M11/M12 的宿主半边（写入审批门、模型可见文本多语言、git 分支感知）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as applyRaw, Config } from '../lib/index.js'
import { INTRO_NOTICE, REFLECT_NOTICE, workspaceKeyOf } from '../lib/lib.js'

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
  /** 领域 global 的当前值（`/sleep` 的 lastSleepAt 水位断言用）。 */
  globalValue(): unknown
}

interface HarnessOptions {
  config?: Json
  /** domain.global.get() 的返回值。 */
  globalValue?: unknown
  /** 把 global.get() 包成 Promise —— 运行版就是这样。 */
  asyncGlobal?: boolean
  /** 不写自报告（大量写入的用例可以省掉每次 flush 的同步文件写）。 */
  noReport?: boolean
  /** `ctx.get('sessionQuery')` 的假实现（M8 `/sleep` 用例用）。 */
  sessionQuery?: unknown
  /** true 时领域打开失败（验证 `/sleep --apply` 在没有可写领域时中止）。 */
  failOpen?: boolean
  /**
   * M10：领域打开前预置的盘上数据 —— 模拟「上一个进程留下的库」。
   * 启动新实例时走的就是 `openDomain` 的加载分支，因此可以断言 pending 会随普通记录一起被加载。
   */
  seedDomainRows?: Map<string, Json>
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
  commandNamed(name: string): CommandRegistration
  runCommand(rawInput: string, commandName?: string): Promise<{ kind: string; text: string }>
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
  const rows = new Map<string, Json>(options.seedDomainRows ?? [])
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
    globalValue: () => globalValue,
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
        if (options.failOpen === true) return Promise.reject(new Error('domain open failed'))
        return Promise.resolve(fakeDomain)
      },
    },
    tokenMeter: { estimateMessage: (): number => 42 },
    settings,
  }
  // M8：/sleep 需要 ctx.get('sessionQuery')；不提供时正好验证降级路径。
  if (options.sessionQuery !== undefined) services.sessionQuery = options.sessionQuery

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

  const commandNamed = (commandName: string): CommandRegistration => {
    const found = commands.filter((entry) => entry.name === commandName)
    assert.equal(found.length, 1, `commands.register 必须恰好注册一次 ${commandName}`)
    return found[0]!
  }

  const command = (): CommandRegistration => commandNamed('memory')

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
    memory, tool, command, commandNamed,
    runCommand: async (rawInput: string, commandName = 'memory') => await commandNamed(commandName).handler({ rawInput }),
    emit, emitSync, preStep, settle, runEffect, report, reportState, dispose,
  }
}

/** 一个「根 agent」：捕获链路要求 ctx.agents.roots() 里能查到它。 */
const agentWith = (cwd: string): Json => ({ session: { id: 'session-1', seq: 5, header: { cwd } } })

// ---------------------------------------------------------------- 1. 注册契约

test('host#1 apply 注册契约：7 个工具（都带 output）、memory + sleep 两条命令、两条注入通道各 1 次', async (t) => {
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

  // 契约 §5.1：`/sleep` 是**独立命令**（不是 /memory 的子命令），两条命令各注册一次。
  assert.equal(harness.commands.length, 2, '/memory 与 /sleep 各注册一次')
  assert.deepEqual(harness.commands.map((entry) => entry.name).sort(), ['memory', 'sleep'])
  const sleepHint = String((harness.commandNamed('sleep') as unknown as { input?: { hint?: string } }).input?.hint ?? '')
  assert.equal(sleepHint, '[--apply] [--sessions=N] [--all]', 'sleep 的 input.hint 必须与契约 §5.1 一致')
  assert.match(String(harness.commandNamed('sleep').description ?? ''), /梳理/u)
  // 独立命令：/memory 的子命令表里不该多出 sleep（否则等于注册成子命令）
  const viaMemory = await harness.runCommand('sleep')
  assert.match(viaMemory.text, /用法：\/memory list/u, 'sleep 不是 /memory 的子命令')

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
  // 关掉同时段可能触发的其它通道（初次设定），让这一例只验证 R2 的形状
  const harness = makeHarness({ config: { recallMode: 'inject', selfIntroEnabled: false } })
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
    // 关掉初次设定：这一例只验证冷却过滤，别被同时段的其它通道干扰
    config: { recallMode: 'inject', recallTopK: 1, recallCooldownTurns: 3, consolidateEnabled: false, selfIntroEnabled: false },
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
    // 按 section 名挑出 R2 那条：pre-step 可能同时追加别的通道（如初次设定）
    const messages = (result as { messages?: Array<{ content?: Array<{ text?: string }>; source?: { sections?: Array<{ name?: string }> } }> }).messages ?? []
    const recall = messages.find((message) => message.source?.sections?.[0]?.name === 'dsh-memory:recall')
    return String((recall ?? messages.at(-1))?.content?.[0]?.text ?? '')
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

// ================================================================ M6 自画像 v2
// 契约：docs/self-portrait.md 第 4/6 节。以下用例全部走**构建产物**（../lib/*.js）。

/** 表格里的 facet 断言要读原始记录（`memory` 服务返回完整 MemoryRecord）。 */
const rowsOf = (harness: Harness): Json[] => harness.memory().list() as Json[]

const writeSelf = async (harness: Harness, args: Json): Promise<Json> =>
  JSON.parse(String(await harness.tool('memory_write').execute(args))) as Json

/** 一次 pre-step：返回追加在末尾的消息（R2 与/或反思提示）。 */
const stepTurn = async (
  harness: Harness,
  turn: number,
  query = `轮次 ${turn}`,
  sessionId = 'session-1',
): Promise<Json[]> => {
  const decision = { kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: query }] }] }
  const result = await harness.preStep(
    { turn, agent: { session: { id: sessionId, seq: turn, header: { cwd: 'C:\\work\\demo' } } }, signal: { aborted: false } },
    async () => decision,
  ) as Json
  const messages = (result.messages ?? []) as Json[]
  return messages.slice(1)
}

const sectionNameOf = (message: Json): string => {
  const sections = (message.source as Json).sections as Json[]
  return String(sections[0]!.name)
}

// ---------------------------------------------------------------- 14. 工具 schema

test('host#14 memory_write 的 facet 可选：enum 为 persona|work，且仅对 kind=agent_self 有意义', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())

  const parameters = harness.tool('memory_write').parameters as Json
  const facet = (parameters.properties as Json).facet as Json
  assert.ok(facet, 'memory_write 必须声明 facet')
  assert.equal(facet.type, 'string')
  assert.deepEqual(facet.enum, ['persona', 'work'])
  assert.match(String(facet.description), /agent_self/u, '描述必须写明仅 kind=agent_self 有意义')
  assert.deepEqual(parameters.required, ['kind', 'text'], 'facet 必须是可选参数（不得进 required）')

  // 非 agent_self 的写入不得被塞上 facet 字段（避免给普通记忆加无意义的自画像面）
  await harness.settle()
  await harness.memory().write({ kind: 'semantic', text: '构建产物统一放在 dist 目录下' })
  assert.equal(rowsOf(harness)[0]!.facet, undefined)
})

test('host#14b 配置 Schema：契约 3.1 的 7 个自画像键与默认值（无 schemastery 时跳过）', async () => {
  if (Config === undefined) {
    // 发布版 profile：schemastery 不可解析 → 没有设置页表单（模块级测试已覆盖这条降级路径）
    assert.equal(Config, undefined)
    return
  }
  const dict = (Config as { dict?: Record<string, { meta?: { default?: unknown } }> }).dict ?? {}
  const expected: Array<[string, unknown]> = [
    ['selfPortraitEnabled', true],
    ['selfPersonaMaxTokens', 80],
    ['selfPortraitMergeThreshold', 0.6],
    ['selfReflectEnabled', true],
    ['selfReflectEveryTurns', 12],
    ['selfReflectMinTurn', 4],
    ['selfReflectMaxPerSession', 3],
  ]
  for (const [key, value] of expected) {
    const entry = dict[key]
    assert.ok(entry, `Schema 必须声明 ${key}`)
    assert.deepEqual(entry.meta?.default, value, `${key} 的默认值必须与契约 3.1 一致`)
  }
})

// ---------------------------------------------------------------- 15. add / reinforce

test('host#15 自画像收敛：add 新建、reinforce 落在同一条上且不新建', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const text = '我在写代码时会先跑通最小可验证路径，再逐步扩展功能。'
  const first = await writeSelf(harness, { kind: 'agent_self', facet: 'work', subject: 'style', text })
  assert.equal(first.ok, true)
  assert.equal((first.portrait as Json).action, 'add')
  assert.equal((first.portrait as Json).facet, 'work')
  assert.equal((first.portrait as Json).subject, 'self.work.style', 'add 的 subject 必须来自 portraitSubjectFor')

  const putsAfterFirst = harness.domain.puts.length
  const second = await writeSelf(harness, { kind: 'agent_self', facet: 'work', subject: 'style', text })
  assert.equal(second.ok, true)
  assert.equal((second.portrait as Json).action, 'reinforce')
  assert.equal(second.status, 'merged')
  assert.equal(second.id, first.id, 'reinforce 必须更新既有条目')

  const rows = rowsOf(harness)
  assert.equal(rows.length, 1, 'reinforce 不得新建条目')
  assert.equal(rows[0]!.kind, 'agent_self')
  assert.equal(rows[0]!.facet, 'work')
  assert.equal(rows[0]!.subject, 'self.work.style')
  assert.equal(Number(rows[0]!.confidence), 0.65, 'reinforce 的 confidence 应在原值上 +0.05')
  assert.ok(harness.domain.puts.length > putsAfterFirst, 'reinforce 必须落盘')

  const self = harness.reportState().self as Json
  assert.equal(Number(self.added), 1)
  assert.equal(Number(self.refined), 1, 'reinforce 计入 refined（不新建条目）')
  assert.equal(Number(self.superseded), 0)
})

// ---------------------------------------------------------------- 16. supersede

test('host#16 supersede：旧条目 archived + supersededBy，新条目 facet/supersedes 正确（含 explain 与 stats）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const first = await writeSelf(harness, {
    kind: 'agent_self', facet: 'persona', subject: 'voice',
    text: '我在解释概念时会先给出结论，再补充理由。',
  })
  assert.equal((first.portrait as Json).action, 'add')

  const second = await writeSelf(harness, {
    kind: 'agent_self', facet: 'persona', subject: 'voice',
    text: '深夜工作时我会把屏幕亮度调到最低，并且反复检查缩进宽度。',
  })
  assert.equal((second.portrait as Json).action, 'supersede', '认知变化时必须取代而不是合并')

  const rows = rowsOf(harness)
  assert.equal(rows.length, 2, 'supersede 会新建一条')
  const old = rows.find((row) => row.id === first.id)!
  const fresh = rows.find((row) => row.id === second.id)!
  assert.equal(old.status, 'archived', '被取代的旧条目必须归档')
  assert.equal(old.supersededBy, second.id, '旧条目必须写明被谁取代')
  assert.equal(fresh.status, 'active')
  assert.equal(fresh.facet, 'persona', '新条目的 facet 必须保留')
  assert.equal(fresh.subject, 'self.persona.voice')
  assert.deepEqual(fresh.supersedes, [first.id], '新条目必须记录它取代了谁')

  // 计数：supersede 计 superseded，且创建计数仍然 +1
  const self = harness.reportState().self as Json
  assert.equal(Number(self.added), 1)
  assert.equal(Number(self.superseded), 1)

  const stats = await harness.runCommand('stats')
  assert.match(stats.text, /自画像：新增 1 \/ 更新 0 \/ 取代 1 \/ 跳过 0/)

  // memory_explain：输出带 facet 与（若有）supersededBy
  const explain = JSON.parse(String(await harness.tool('memory_explain').execute({ text: '我回答问题的风格是什么' }))) as Json
  const portrait = explain.portrait as Json
  const records = portrait.records as Json[]
  const archived = records.find((row) => row.status === 'archived')!
  assert.ok(archived, 'explain 必须列出归档的自画像条目')
  assert.equal(archived.facet, 'persona')
  assert.equal(archived.supersededBy, second.id)
  const active = records.find((row) => row.status === 'active')!
  assert.equal(active.facet, 'persona')
  assert.deepEqual(active.supersedes, [first.id])

  // 修订链：旧 → 新，含归档时间
  const history = await harness.runCommand('self history')
  assert.match(history.text, /self\.persona\.voice/u)
  assert.match(history.text, /archived/u)
  assert.match(history.text, /旧 → 新/u)
  // id 前缀只有 8 个字符（同一毫秒创建的两条会撞前缀），所以用正文片段定位链内顺序
  const positions = ['解释概念', '深夜工作'].map((needle) => history.text.indexOf(needle))
  assert.ok(positions[0]! >= 0 && positions[1]! >= 0, '两条都必须出现在修订链里')
  assert.ok(positions[0]! < positions[1]!, '链内顺序必须由旧到新')
  assert.match(history.text, /\[archived @ /u, '归档条目必须带归档时间')
})

// ---------------------------------------------------------------- 17. skip（用户所有物 + too-short）

test('host#17 自画像保护：模型不能覆盖用户设定（skip + 不写盘），过短正文同样 skip', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  // 用户显式设定：origin=user_explicit、pinned=true、confidence=1
  const set = await harness.runCommand('self set persona 我在回答时会先给结论再展开')
  assert.equal(set.kind, 'success', set.text)
  const userRow = rowsOf(harness)[0]!
  assert.equal(userRow.origin, 'user_explicit')
  assert.equal(userRow.pinned, true)
  assert.equal(userRow.confidence, 1)
  assert.equal(userRow.facet, 'persona')

  // 模型侧完全不同的自我认知 → refine/supersede 被用户所有物保护挡下
  const putsBefore = harness.domain.puts.length
  const blocked = await writeSelf(harness, {
    kind: 'agent_self', facet: 'persona',
    text: '我倾向于用很长的铺垫来回答问题，很少直接给结论。',
  })
  assert.equal(blocked.ok, false, '模型不得覆盖用户侧自画像')
  assert.match(String(blocked.error), /portrait_skipped/u)
  assert.match(String(blocked.error), /user-owned/u, '必须返回可读原因')
  assert.equal((blocked.portrait as Json).action, 'skip')
  assert.equal(harness.domain.puts.length, putsBefore, 'skip 不得写盘')
  assert.equal(rowsOf(harness).length, 1)
  assert.equal(rowsOf(harness)[0]!.status, 'active', '用户条目必须原样保留')

  // 过短正文：同样是 skip，且不写盘
  const short = await writeSelf(harness, { kind: 'agent_self', facet: 'work', text: '太短' })
  assert.equal(short.ok, false)
  assert.match(String(short.error), /too-short/u)
  assert.equal(harness.domain.puts.length, putsBefore, 'too-short 不得写盘')

  const self = harness.reportState().self as Json
  assert.equal(Number(self.skipped), 2, '两种 skip 都进 skipped 计数')
  assert.equal(Number(self.added), 1, '用户设定本身是 add')

  // 用户侧之间可以互相覆盖：同一 facet/subject、认知不同 → supersede
  const override = await harness.runCommand('self set persona 深夜写东西时我会反复确认缩进与空行是否一致')
  assert.equal(override.kind, 'success')
  assert.match(override.text, /supersede/u, '用户侧可以覆盖用户侧')
})

// ---------------------------------------------------------------- 17b. 用户正文不被改写

test('host#17b 端到端：模型无法用自己的措辞改写用户所有物的正文（包含关系也不行）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const original = '我在回答时会先给结论再展开'
  assert.equal((await harness.runCommand(`self set persona ${original}`)).kind, 'success')

  // 模型侧候选「包含」用户原话（规则 2a 本会判成 reinforce 并取更长的一条）：
  // lib 的规则 4 收紧后这必须是 skip —— 宿主如实执行，不写盘、不改写正文。
  const longer = `${original}，而且我还会补充三条以上的理由与边界条件`
  const blocked = await writeSelf(harness, { kind: 'agent_self', facet: 'persona', text: longer })
  assert.equal(blocked.ok, false, '模型不得把更长的话写进用户 pinned 的条目')
  assert.match(String(blocked.error), /user-owned/u)
  assert.equal((blocked.portrait as Json).action, 'skip')

  const row = rowsOf(harness)[0]!
  assert.equal(row.text, original, '用户原文必须逐字保留')
  assert.equal(row.pinned, true)
  assert.equal(row.origin, 'user_explicit', '来源不得被模型侧降级或改写')
  assert.equal(rowsOf(harness).length, 1, 'skip 不新建、也不改写')

  // 对照：模型侧条目之间仍按规则 2a 补长（保护只针对用户所有物）
  const firstModel = await writeSelf(harness, { kind: 'agent_self', facet: 'work', text: '我写代码时会先跑通最小路径' })
  assert.equal((firstModel.portrait as Json).action, 'add')
  const longerModel = await writeSelf(harness, { kind: 'agent_self', facet: 'work', text: '我写代码时会先跑通最小路径，然后再补测试与文档' })
  assert.equal((longerModel.portrait as Json).action, 'reinforce')
  const modelRow = rowsOf(harness).find((candidate) => candidate.facet === 'work')!
  assert.match(String(modelRow.text), /再补测试与文档/u, '模型侧条目仍按规则 2a 补长')
})

// ---------------------------------------------------------------- 18. /memory self 四个子命令

test('host#18 /memory self：list / set / history / reset 四个子命令与 help 同步', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const empty = await harness.runCommand('self')
  assert.equal(empty.kind, 'success')
  assert.match(empty.text, /自画像为空/u)

  // 参数校验
  const badFacet = await harness.runCommand('self set mood 我今天心情不错')
  assert.equal(badFacet.kind, 'error')
  assert.match(badFacet.text, /persona 或 work/u)
  const noText = await harness.runCommand('self set persona')
  assert.equal(noText.kind, 'error')
  assert.match(noText.text, /缺少正文/u)
  const unknown = await harness.runCommand('self wat')
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /未知的 self 子命令/u)

  // set：两小节各一条
  assert.equal((await harness.runCommand('self set persona 我在解释复杂概念时会先给出结论再展开细节')).kind, 'success')
  assert.equal((await harness.runCommand('self set work 我在动手改代码前会先跑通最小验证路径')).kind, 'success')
  const rows = rowsOf(harness)
  assert.equal(rows.length, 2)
  const persona = rows.find((row) => row.facet === 'persona')!
  const work = rows.find((row) => row.facet === 'work')!
  assert.equal(persona.origin, 'user_explicit')
  assert.equal(persona.pinned, true)
  assert.equal(persona.confidence, 1, 'set 的 confidence 固定为 1')
  assert.equal(persona.subject, 'self.persona.general')
  assert.equal(work.subject, 'self.work.general')
  assert.equal(work.confidence, 1)

  // list：两小节都列，带 id 前缀 / origin / confidence
  const list = await harness.runCommand('self')
  assert.match(list.text, /人格 · 模型对自身的认知/u)
  assert.match(list.text, /工作倾向/u)
  assert.match(list.text, /user_explicit/u)
  assert.match(list.text, /conf=1\.00/u)
  assert.match(list.text, new RegExp(String(persona.id).slice(0, 8), 'u'))

  // history：没有链长 ≥ 2 的修订 → 空
  assert.match((await harness.runCommand('self history')).text, /还没有修订记录/u)
  // 过滤参数：没有匹配的 subject
  assert.match((await harness.runCommand('self history definitely.absent')).text, /没有匹配/u)

  // 造一条修订链：同 subject 的新认知取代旧认知
  const again = await harness.runCommand('self set persona 深夜写东西时我会反复确认缩进与空行是否一致')
  assert.equal(again.kind, 'success')
  assert.match(again.text, /supersede/u)
  const history = await harness.runCommand('self history')
  assert.match(history.text, /self\.persona\.general/u)
  assert.match(history.text, /archived/u)
  assert.match(history.text, /旧 → 新/u)
  // 过滤到 work：只有 1 条 active，链长为 1，不算修订链
  assert.match((await harness.runCommand('self history self.work')).text, /没有匹配/u)

  // reset：归档不删除，历史保留
  const before = rowsOf(harness).length
  const reset = await harness.runCommand('self reset persona')
  assert.equal(reset.kind, 'success')
  assert.match(reset.text, /已重置（persona）/u)
  const after = rowsOf(harness)
  assert.equal(after.length, before, 'reset 只能归档，不得删除')
  assert.equal(after.filter((row) => row.facet === 'persona' && row.status === 'active').length, 0)
  assert.equal(after.filter((row) => row.facet === 'work' && row.status === 'active').length, 1, 'reset persona 不得影响 work')
  const resetBad = await harness.runCommand('self reset mood')
  assert.equal(resetBad.kind, 'error')
  assert.match(resetBad.text, /persona 或 work/u)
  // 重置后再 reset（同一 facet）→ 没有可重置的条目
  assert.match((await harness.runCommand('self reset persona')).text, /没有需要重置/u)

  // help 与用法串同步
  const help = await harness.runCommand('help')
  assert.match(help.text, /self \[list\]/u)
  assert.match(help.text, /self set <persona\|work> <正文>/u)
  assert.match(help.text, /self history \[subject\]/u)
  assert.match(help.text, /self reset \[persona\|work\]/u)
  const hint = String((harness.command() as unknown as { input?: { hint?: string } }).input?.hint ?? '')
  assert.match(hint, /self/u, '命令的 input.hint 也要提到 self')
})

// ---------------------------------------------------------------- 19. 反思提示：上限

test('host#19 反思提示：每会话次数上限（默认上限 3 时第 4 次起不再注入）', async (t) => {
  const harness = makeHarness({
    config: { selfReflectEveryTurns: 1, selfReflectMinTurn: 1, selfReflectMaxPerSession: 3 },
  })
  t.after(() => harness.dispose())
  await harness.settle()

  const injectedAt: number[] = []
  const firstMessages: Json[] = []
  for (let turn = 1; turn <= 6; turn += 1) {
    for (const message of await stepTurn(harness, turn)) {
      if (sectionNameOf(message) === 'dsh-memory:self-reflect') {
        injectedAt.push(turn)
        firstMessages.push(message)
      }
    }
  }
  assert.deepEqual(injectedAt, [1, 2, 3], '每会话最多 3 次反思提示')

  // 形状必须与 R2 完全一致（只有 sections[0].name 不同），正文用 REFLECT_NOTICE
  const message = firstMessages[0]!
  assert.equal(message.role, 'user')
  assert.ok(typeof message.id === 'string' && (message.id as string).length > 0)
  const source = message.source as Json
  assert.equal(source.kind, 'runtime-context')
  assert.equal(source.form, 'snapshot')
  const sections = source.sections as Json[]
  assert.equal(sections.length, 1)
  assert.equal(sections[0]!.name, 'dsh-memory:self-reflect')
  const content = message.content as Json[]
  assert.equal(content.length, 1)
  assert.equal(content[0]!.type, 'text')
  assert.equal(content[0]!.text, REFLECT_NOTICE, '注入正文必须是 REFLECT_NOTICE（过 clampText）')
  assert.equal(sections[0]!.text, content[0]!.text)
  assert.match(String(content[0]!.text), /没有新认识就不要写/u)
  assert.doesNotMatch(String(content[0]!.text), /\n/u, '注入正文必须折平单行')

  // 计数只在真正注入后推进
  const self = harness.reportState().self as Json
  assert.equal(Number(self.reflections), 3)
  assert.deepEqual(self.reflectTurns, [1, 2, 3])
  assert.equal(Number(self.lastReflectTurn), 3)

  // 上限是「每会话」而不是全局：换会话后配额重置
  for (const message of await stepTurn(harness, 1, '轮次 1', 'session-2')) {
    if (sectionNameOf(message) === 'dsh-memory:self-reflect') injectedAt.push(1001)
  }
  assert.deepEqual(injectedAt, [1, 2, 3, 1001], '新会话必须重新获得反思配额')
  const nextSession = harness.reportState().self as Json
  assert.equal(Number(nextSession.reflections), 1)
  assert.deepEqual(nextSession.reflectTurns, [1])
})

// ---------------------------------------------------------------- 20. 反思提示：间隔与最小回合

test('host#20 反思提示：最小回合与间隔闸门（minTurn=4、everyTurns=2）', async (t) => {
  const harness = makeHarness({
    config: { selfReflectEveryTurns: 2, selfReflectMinTurn: 4, selfReflectMaxPerSession: 10 },
  })
  t.after(() => harness.dispose())
  await harness.settle()

  const injectedAt: number[] = []
  for (let turn = 1; turn <= 6; turn += 1) {
    for (const message of await stepTurn(harness, turn)) {
      if (sectionNameOf(message) === 'dsh-memory:self-reflect') injectedAt.push(turn)
    }
  }
  assert.deepEqual(injectedAt, [4, 6], '过早（<4 回合）与间隔不足（<2 回合）都不提醒')
})

// ---------------------------------------------------------------- 21. 反思提示：dry/off/autoRecall=false

test('host#21 反思提示：dry / off / autoRecall=false 时不注入且不推进计数', async (t) => {
  const configs: Json[] = [{ recallMode: 'dry' }, { recallMode: 'off' }, { autoRecall: false }]
  for (const config of configs) {
    const harness = makeHarness({
      config: { ...config, selfReflectEveryTurns: 1, selfReflectMinTurn: 1, selfReflectMaxPerSession: 3 },
    })
    try {
      await harness.settle()
      for (let turn = 1; turn <= 4; turn += 1) {
        const decision = { kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: `轮次 ${turn}` }] }] }
        const result = await harness.preStep(
          { turn, agent: agentWith('C:\\work\\demo'), signal: { aborted: false } },
          async () => decision,
        )
        assert.equal(result, decision, `${JSON.stringify(config)} 下必须原样返回 decision（不注入）`)
      }
      const self = harness.reportState().self as Json
      assert.equal(Number(self.reflections), 0, `${JSON.stringify(config)} 不得推进反思计数`)
      assert.deepEqual(self.reflectTurns, [], `${JSON.stringify(config)} 不得记录已提醒回合`)
      assert.equal(self.lastReflectTurn, null, `${JSON.stringify(config)} 不得推进 lastReflectTurn`)
    } finally {
      await harness.dispose()
    }
  }
})

// ---------------------------------------------------------------- 22. 反思提示与 R2 的顺序

test('host#22 pre-step：R2 快照在前、反思提示在后，各自单独一条消息', async (t) => {
  const harness = makeHarness({
    config: { recallMode: 'inject', selfReflectEveryTurns: 1, selfReflectMinTurn: 1, selfReflectMaxPerSession: 3 },
  })
  t.after(() => harness.dispose())
  await harness.settle()
  await harness.memory().write({ kind: 'user_profile', text: '构建流程统一用 pnpm，产物输出到 dist 目录' })

  const extra = await stepTurn(harness, 1, '请继续按构建流程用 pnpm 输出 dist')
  assert.equal(extra.length, 2, 'R2 与反思提示必须各自单独追加一条')
  assert.equal(sectionNameOf(extra[0]!), 'dsh-memory:recall', 'R2 在前')
  assert.equal(sectionNameOf(extra[1]!), 'dsh-memory:self-reflect', '反思提示在后')
})

// ---------------------------------------------------------------- 26~29. M7 初次设定（称呼）

test('host#23 初次设定：未定称呼时只问一次，且正文/形状与 R2 同规格', async (t) => {
  const harness = makeHarness({ config: { selfIntroMinTurn: 1, selfIntroMaxAsks: 2 } })
  t.after(() => harness.dispose())
  await harness.settle()

  const hits: Array<{ turn: number; message: Json }> = []
  for (let turn = 1; turn <= 4; turn += 1) {
    for (const message of await stepTurn(harness, turn)) {
      if (sectionNameOf(message) === 'dsh-memory:self-intro') hits.push({ turn, message })
    }
  }
  assert.deepEqual(hits.map((hit) => hit.turn), [1], '同一会话只问一次，不追着问')

  const message = hits[0]!.message
  assert.equal(message.role, 'user')
  assert.ok(typeof message.id === 'string' && (message.id as string).length > 0)
  const source = message.source as Json
  assert.equal(source.kind, 'runtime-context')
  assert.equal(source.form, 'snapshot')
  const sections = source.sections as Json[]
  assert.equal(sections.length, 1)
  assert.equal(sections[0]!.name, 'dsh-memory:self-intro')
  const content = message.content as Json[]
  assert.equal(content[0]!.type, 'text')
  assert.equal(content[0]!.text, INTRO_NOTICE, '注入正文必须是 INTRO_NOTICE（过 clampText）')
  assert.doesNotMatch(String(content[0]!.text), /\n/u, '注入正文必须折平单行')
  assert.match(String(content[0]!.text), /不要再问/u)
  assert.match(String(content[0]!.text), /self\.persona\.name/u)

  assert.equal(Number((harness.reportState().self as Json).introAsks), 1)
})

test('host#24 初次设定：命名一旦有记录（含「保持默认称呼」）就永久停手', async (t) => {
  const harness = makeHarness({ config: { selfIntroMinTurn: 1, selfIntroMaxAsks: 3 } })
  t.after(() => harness.dispose())
  await harness.settle()
  // 用户说「不用」时，模型按 INTRO_NOTICE 的提示记下的那条
  const written = await harness.memory().write({
    kind: 'agent_self',
    facet: 'persona',
    subject: 'self.persona.name',
    text: '用户不想设定称呼，保持默认。',
  })
  assert.equal(written.ok, true)

  for (let turn = 1; turn <= 3; turn += 1) {
    for (const message of await stepTurn(harness, turn)) {
      assert.notEqual(sectionNameOf(message), 'dsh-memory:self-intro', '已确定称呼后不得再问')
    }
  }
  assert.equal(Number((harness.reportState().self as Json).introAsks), 0, '未注入就不该推进计数')
})

test('host#25 初次设定：上限是**跨会话累计**（换会话不重置）', async (t) => {
  const harness = makeHarness({ config: { selfIntroMinTurn: 1, selfIntroMaxAsks: 2 } })
  t.after(() => harness.dispose())
  await harness.settle()

  const asked: string[] = []
  for (const [sessionId, turn] of [['s1', 1], ['s1', 2], ['s2', 1], ['s3', 1], ['s3', 2]] as const) {
    for (const message of await stepTurn(harness, turn, `轮次 ${turn}`, sessionId)) {
      if (sectionNameOf(message) === 'dsh-memory:self-intro') asked.push(`${sessionId}#${turn}`)
    }
  }
  assert.deepEqual(asked, ['s1#1', 's2#1'], '每会话最多一次，且跨会话累计上限 2 次')
  assert.equal(Number((harness.reportState().self as Json).introAsks), 2)
})

test('host#26 初次设定：dry / off / autoRecall=false 都不注入、不推进计数', async (t) => {
  const cases = [
    { name: 'dry', config: { recallMode: 'dry' } },
    { name: 'off', config: { recallMode: 'off' } },
    { name: 'autoRecall=false', config: { autoRecall: false } },
  ] as const
  for (const item of cases) {
    const harness = makeHarness({ config: { selfIntroMinTurn: 1, ...item.config } })
    t.after(() => harness.dispose())
    await harness.settle()
    for (let turn = 1; turn <= 3; turn += 1) {
      for (const message of await stepTurn(harness, turn)) {
        assert.notEqual(sectionNameOf(message), 'dsh-memory:self-intro', `${item.name} 不应注入初次设定`)
      }
    }
    assert.equal(Number((harness.reportState().self as Json).introAsks), 0, `${item.name} 不应推进计数`)
  }
})

test('host#27 初次设定：用户用 /memory self set persona name … 直接定称呼也算已确定', async (t) => {
  const harness = makeHarness({ config: { selfIntroMinTurn: 1, selfIntroMaxAsks: 3 } })
  t.after(() => harness.dispose())
  await harness.settle()

  // 命名 key 形式：写 self.persona.name，并明确告知「不会再问」
  // 注意正文天生很短（「我叫小忆。」5 字），命名 subject 的 too-short 门槛已放宽到 ≥2 字符
  const named = await harness.runCommand('self set persona name 我叫小忆。')
  assert.equal(named.kind, 'success', named.text)
  assert.match(named.text, /称呼已定/u)
  const rows = harness.memory().list() as Json[]
  const record = rows.find((row) => row.subject === 'self.persona.name')
  assert.ok(record, '应写入 self.persona.name')
  assert.equal(record.text, '我叫小忆。')
  assert.equal(record.origin, 'user_explicit')
  assert.equal(record.pinned, true)

  for (let turn = 1; turn <= 3; turn += 1) {
    for (const message of await stepTurn(harness, turn)) {
      assert.notEqual(sectionNameOf(message), 'dsh-memory:self-intro', '用户已定称呼后不得再问')
    }
  }
  assert.equal(Number((harness.reportState().self as Json).introAsks), 0)

  // 向后兼容：不带 key 的正文仍写 self.persona.general，且**不**算定称呼
  const plain = await harness.runCommand('self set persona 我重视把事实和推测分开说。')
  assert.equal(plain.kind, 'success')
  assert.ok(
    (harness.memory().list() as Json[]).some((row) => row.subject === 'self.persona.general'),
    '不带命名 key 时仍写 general（老用法不许改语义）',
  )

  // work 面不识别命名 key：整段都算正文
  const work = await harness.runCommand('self set work name 只是正文的一部分。')
  assert.equal(work.kind, 'success')
  assert.ok((harness.memory().list() as Json[]).some((row) => row.subject === 'self.work.general'))
})

// ================================================================ M8 `/sleep`
// 契约：docs/sleep.md 第 5/6 节。宿主侧三个不可妥协项在这里逐条钉死：
//   ① 默认（无 --apply）**零写入**，连计数都不动；
//   ② `--apply` 的**第一件事**是导出备份，备份失败即中止；
//   ③ 无 sessionQuery 时优雅降级（可读文案、不抛），且不碰自画像 / 用户所有物。
//
// 假设的宿主服务按 src/types.ts 的 `DshSessionQuery` 构造：listSessions / filterSessions /
// readSession / listEvents，事件形状按契约 §3（user/message 只认 data.source.kind === 'user'）。

interface FakeSessionSpec {
  id: string
  cwd?: string
  createdAt: number
  origin?: 'subagent'
  parentSession?: string
  events: Json[]
}

interface FakeSessionQuery {
  /** 交给假 ctx 的 `sessionQuery` 服务。 */
  query: Json
  /** `readSession` 的调用顺序（断言「读了哪些会话」）。 */
  read: string[]
  /** `filterSessions` 收到的过滤器（断言默认按 cwd 过滤）。 */
  filterCalls: Json[][]
  listCalls(): number
}

function makeFakeSessionQuery(specs: readonly FakeSessionSpec[]): FakeSessionQuery {
  const byId = new Map(specs.map((spec) => [spec.id, spec]))
  const read: string[] = []
  const filterCalls: Json[][] = []
  let listCalls = 0

  const headerOf = (spec: FakeSessionSpec): Json => {
    const header: Json = { id: spec.id, createdAt: spec.createdAt }
    if (spec.cwd !== undefined) header.cwd = spec.cwd
    if (spec.origin !== undefined) header.origin = spec.origin
    if (spec.parentSession !== undefined) header.parentSession = spec.parentSession
    return header
  }
  const recordOf = (spec: FakeSessionSpec): Json => ({ header: headerOf(spec), live: false, persisted: true })

  const query: Json = {
    listSessions: async (): Promise<Json[]> => {
      listCalls += 1
      return specs.map(recordOf)
    },
    filterSessions: async (filters: readonly Json[]): Promise<Json[]> => {
      const copy = filters.map((filter) => ({ ...filter }))
      filterCalls.push(copy)
      return specs
        .filter((spec) => copy.every((filter) => {
          if (filter.kind === 'cwd') return ((filter.values as unknown[]) ?? []).includes(spec.cwd ?? null)
          return true
        }))
        .map(recordOf)
    },
    readSession: async (sessionId: string): Promise<Json> => {
      const spec = byId.get(sessionId)
      assert.ok(spec, `readSession 收到未知会话：${sessionId}`)
      read.push(sessionId)
      const session: Json = { id: spec.id, createdAt: spec.createdAt }
      if (spec.cwd !== undefined) session.cwd = spec.cwd
      return { session, inheritedEventCount: 0, events: spec.events }
    },
    listEvents: async (sessionId: string): Promise<Json[]> =>
      (byId.get(sessionId)?.events ?? []).map((event) => ({
        sessionId, seq: event.seq ?? 0, type: event.type, time: event.time ?? 0,
      })),
  }
  return { query, read, filterCalls, listCalls: () => listCalls }
}

/** 真实用户消息（`data.source.kind === 'user'`）。 */
const sleepUserEvent = (text: string, seq = 1): Json =>
  ({ type: 'user/message', seq, time: 1_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
/** 宿主注入的消息（`data.source.kind === 'model'`）——**不是**用户说的，不许补录。 */
const sleepInjectedEvent = (text: string, seq = 2): Json =>
  ({ type: 'user/message', seq, time: 1_001, data: { source: { kind: 'model' }, content: [{ type: 'text', text }] } })
/** assistant 消息（回声检测的上下文）。 */
const sleepAssistantEvent = (text: string, seq = 3): Json =>
  ({ type: 'assistant/message', seq, time: 1_002, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })

const SLEEP_CWD = 'C:\\work\\demo'
const SLEEP_OTHER_CWD = 'C:\\other\\proj'

/**
 * 固定夹具：一个别的项目的会话、两个本项目的会话、一个**最新**的子代理会话。
 * 子代理的 cwd（`C:\work\sub`）故意与用户工作目录不同：若宿主拿它当锚点，按 cwd 过滤就会读错会话。
 */
const sleepFixture = (): FakeSessionSpec[] => [
  {
    id: 'sess-other',
    cwd: SLEEP_OTHER_CWD,
    createdAt: 1_000,
    events: [sleepUserEvent('记住：别的项目的事不许混进来。')],
  },
  {
    id: 'sess-old',
    cwd: SLEEP_CWD,
    createdAt: 2_000,
    events: [sleepUserEvent('记住：提交信息用中文写，一次只做一件事。')],
  },
  {
    id: 'sess-new',
    cwd: SLEEP_CWD,
    createdAt: 3_000,
    events: [
      sleepUserEvent('记住：构建统一用 pnpm，产物输出到 dist 目录。', 1),
      sleepInjectedEvent('记住：这条是注入的，不许补录。', 2),
      sleepAssistantEvent('好的，我会按 pnpm 构建并把产物放到 dist。', 3),
    ],
  },
  {
    id: 'sess-sub',
    cwd: 'C:\\work\\sub',
    createdAt: 4_000,
    origin: 'subagent',
    parentSession: 'sess-new',
    events: [sleepUserEvent('记住：子代理的这条不许补录。')],
  },
]

const sleepHarness = (options: HarnessOptions = {}): { harness: Harness; fake: FakeSessionQuery } => {
  const fake = makeFakeSessionQuery(sleepFixture())
  return { harness: makeHarness({ ...options, sessionQuery: fake.query }), fake }
}

// ---------------------------------------------------------------- 28. 无 sessionQuery 降级

test('host#28 /sleep 无 sessionQuery：可读降级文案、绝不抛、零写入，且 /memory 仍可用', async (t) => {
  const harness = makeHarness() // 故意不提供 sessionQuery
  t.after(() => harness.dispose())
  await harness.settle()

  const result = await harness.runCommand('--apply', 'sleep')
  assert.equal(result.kind, 'error', '缺服务必须走 error 而不是抛异常')
  assert.match(result.text, /sessionQuery/u, '降级文案要点名缺的是哪个服务')
  assert.match(result.text, /仍可用/u, '必须告诉用户还有别的路可走')
  assert.match(result.text, /\/memory consolidate/u, '契约 §5.3：要说明 /memory consolidate 仍可用')

  assert.equal(harness.domain.puts.length, 0, '降级路径不得碰领域表')
  assert.equal(harness.memory().list().length, 0)
  assert.equal((await harness.runCommand('stats')).kind, 'success', '/memory 自身不受影响')
})

// ---------------------------------------------------------------- 29. 预览零写入

test('host#29 /sleep 预览：零写入、按 cwd 过滤（锚点跳过子代理会话）、--sessions=N 与 --all', async (t) => {
  const { harness, fake } = sleepHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const result = await harness.runCommand('', 'sleep')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /记忆梳理稿 · 预览/u, '默认必须只预览')
  assert.match(result.text, /未写入任何内容/u)
  // 回看规模来自契约 §4 的 plan.scanned：两个本项目会话（别的项目与会话外的子代理都没进来）
  assert.match(result.text, /回看 2 个会话 · \d+ 条消息 · \d+ 字符/u)

  // 两条真实用户消息都该成为补录候选；注入的 model 消息不算
  const backfill = Number(/补录 (\d+) 条/u.exec(result.text)?.[1] ?? '0')
  assert.ok(backfill >= 2, `两个会话的真实用户消息都应进入补录候选，实际 ${backfill}`)
  assert.doesNotMatch(result.text, /注入的/u, 'data.source.kind === "model" 的注入消息不是用户消息（防自激 §3）')
  assert.doesNotMatch(result.text, /子代理的/u, '子代理会话整体跳过')
  assert.doesNotMatch(result.text, /别的项目/u, '默认按 cwd 过滤，别的项目不参与')

  // 零写入：领域表一次 put 都没有，记录数不动，state.sleep 计数也不动
  assert.equal(harness.domain.puts.length, 0, '预览必须零写入')
  assert.equal(harness.memory().list().length, 0)
  assert.match((await harness.runCommand('stats')).text, /梳理（\/sleep）：运行 0 次/u, '预览不推进计数')

  // 读了哪些会话：cwd 锚点取「最近一个非 subagent 会话」（sess-new 的 demo），而不是最新的 sess-sub
  assert.deepEqual(fake.filterCalls[0], [{ kind: 'cwd', values: [SLEEP_CWD] }], '默认必须按 cwd 过滤')
  assert.deepEqual(fake.read, ['sess-new', 'sess-old'], '按 createdAt 降序读最近的非子代理会话')

  // --sessions=N：只回看最近的 N 个
  fake.read.length = 0
  assert.match((await harness.runCommand('--sessions=1', 'sleep')).text, /回看 1 个会话/u)
  assert.deepEqual(fake.read, ['sess-new'])

  // 上限 20：超限要在输出里写清（契约 §6「任何一项超限都要在 notes 里写清」）
  fake.read.length = 0
  assert.match((await harness.runCommand('--sessions=999', 'sleep')).text, /会话数上限 20/u)

  // --all：不按 cwd 过滤，但仍跳过子代理会话
  fake.read.length = 0
  const all = await harness.runCommand('--all', 'sleep')
  assert.equal(all.kind, 'success')
  assert.deepEqual(fake.read, ['sess-new', 'sess-old', 'sess-other'])
  assert.match(all.text, /回看 3 个会话/u)
  assert.match(all.text, /别的项目/u, '--all 时别的项目的会话要参与')
  assert.doesNotMatch(all.text, /子代理的/u, '--all 也不许把子代理会话当用户会话')
})

// ---------------------------------------------------------------- 30. apply：先备份后写

test('host#30 /sleep --apply：先导出备份再落盘（备份内容不含本次新增）、水位与统计', async (t) => {
  const { harness } = sleepHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  // 库里先有一条：备份文件里应当恰好只有它 —— 这就是「写入发生在备份之后」的证据
  const preexisting = await harness.memory().write({
    kind: 'user_profile',
    text: '用户偏好中文回答与英文标识符',
    subject: 'language.preference',
  })
  assert.equal(preexisting.ok, true)
  const before = harness.memory().list().length
  assert.equal(before, 1)

  const result = await harness.runCommand('--apply', 'sleep')
  assert.equal(result.kind, 'success', result.text)
  const added = Number(/补录 (\d+) 条/u.exec(result.text)?.[1] ?? '0')
  assert.ok(added >= 1, `--apply 应至少补录 1 条，实际 ${added}`)
  assert.match(result.text, /备份：/u)

  // 备份文件：命名、位置（exportDir=reportPath 所在目录）与内容都按契约 §5.2a
  const backups = readdirSync(harness.tempDir).filter((name) => name.startsWith('sleep-backup-'))
  assert.equal(backups.length, 1, `应恰好导出 1 份备份，实际 ${backups.join(', ')}`)
  assert.match(backups[0]!, /^sleep-backup-.*\.json$/u)
  const backup = JSON.parse(readFileSync(join(harness.tempDir, backups[0]!), 'utf8')) as { items: Json[] }
  assert.equal(backup.items.length, before, '备份必须只包含 apply 之前的库（证明先备份后写）')
  assert.ok(
    backup.items.every((item) => !String(item.text).includes('pnpm')),
    '本次补录的内容不得出现在备份里：否则说明写入发生在备份之前',
  )
  assert.ok(backup.items.some((item) => item.id === preexisting.id))

  // 补录落库：内容来自真实用户消息，注入消息与子代理消息都没进来
  const rows = harness.memory().list() as Json[]
  assert.ok(rows.length > before, '--apply 必须落盘')
  assert.ok(rows.some((row) => String(row.text).includes('pnpm')), '补录的正文应来自会话里的用户消息')
  assert.ok(rows.every((row) => !String(row.text).includes('注入的')), '注入消息不得补录')
  assert.ok(rows.every((row) => !String(row.text).includes('子代理的')), '子代理会话不得补录')
  assert.ok(rows.every((row) => row.kind !== 'agent_self'), '/sleep 不生成任何自画像写入（§6）')
  const backfilled = rows.find((row) => String(row.text).includes('pnpm'))!
  assert.equal(backfilled.origin, 'user_explicit', '补录来源用候选的来源')
  assert.equal(backfilled.status, 'active')

  // 水位：MemoryMeta.lastSleepAt 落进领域 global（契约 §5.2c）
  const meta = harness.domain.globalValue() as Json
  assert.equal(typeof meta.lastSleepAt, 'number', 'lastSleepAt 必须随水位落盘')
  assert.ok(Number(meta.lastSleepAt) > 0)

  // 统计：state.sleep 计数 + /memory stats 的 sleep 行
  const stats = await harness.runCommand('stats')
  assert.match(stats.text, /梳理（\/sleep）：运行 1 次/u)
  const counters = /运行 (\d+) 次（补录 (\d+) \/ 合并 (\d+) \/ 失效 (\d+) \/ 归档 (\d+) \/ 印象 (\d+) \/ 跳过 (\d+)）/u.exec(stats.text)
  assert.ok(counters, `stats 行格式异常：${stats.text}`)
  assert.equal(Number(counters[2]), added, 'stats 的补录计数要与本次回报一致')
  assert.match(stats.text, /最近 .*2 会话 \/ \d+ 消息 \/ \d+ 字符/u, '最近一次扫描的规模要写进 stats')
})

// ---------------------------------------------------------------- 30b/30c. 中止路径

test('host#30b 备份失败即中止 --apply：库一个字节都不改（没有备份就不改库）', async (t) => {
  // 用一个**文件**占住路径：exportDir 的父级不是目录 → mkdirSync/writeFileSync 必然失败。
  const blockerDir = mkdtempSync(join(tmpdir(), 'dsh-memory-blocker-'))
  const blocker = join(blockerDir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  t.after(() => rmSync(blockerDir, { recursive: true, force: true }))

  const fake = makeFakeSessionQuery(sleepFixture())
  const harness = makeHarness({ sessionQuery: fake.query, config: { exportDir: join(blocker, 'nested') } })
  t.after(() => harness.dispose())
  await harness.settle()

  await harness.memory().write({ kind: 'user_profile', text: '用户偏好中文回答与英文标识符', subject: 'language.preference' })
  const before = harness.memory().list() as Json[]

  const result = await harness.runCommand('--apply', 'sleep')
  assert.equal(result.kind, 'error', '备份失败必须中止')
  assert.match(result.text, /备份失败/u)
  assert.match(result.text, /中止/u)
  assert.match(result.text, /没有备份就不改库/u)

  const after = harness.memory().list() as Json[]
  assert.equal(after.length, before.length, '中止后记录数不得变化')
  assert.deepEqual(after.map((row) => row.id), before.map((row) => row.id))
  assert.ok(after.every((row) => !String(row.text).includes('pnpm')), '中止后不得有任何补录')
  assert.match((await harness.runCommand('stats')).text, /梳理（\/sleep）：运行 0 次/u, '中止的运行不计入 runs')
})

test('host#30c 领域未打开时 --apply 中止（预览仍可用）：不写盘、不报成功', async (t) => {
  const fake = makeFakeSessionQuery(sleepFixture())
  const harness = makeHarness({ sessionQuery: fake.query, failOpen: true })
  t.after(() => harness.dispose())
  await harness.settle()

  const applied = await harness.runCommand('--apply', 'sleep')
  assert.equal(applied.kind, 'error')
  assert.match(applied.text, /领域未打开/u)
  assert.equal(harness.domain.puts.length, 0, '没有可写领域时不得落盘，也不得假装成功')

  // 预览不依赖领域，仍要给出计划（只读性质不受影响）
  const preview = await harness.runCommand('', 'sleep')
  assert.equal(preview.kind, 'success')
  assert.match(preview.text, /记忆梳理稿 · 预览/u)
})

// ---------------------------------------------------------------- 31. 幂等

test('host#31 /sleep --apply 重复执行幂等：第二次不再新增', async (t) => {
  const { harness } = sleepHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  assert.equal((await harness.runCommand('--apply', 'sleep')).kind, 'success')
  const afterFirst = harness.memory().list() as Json[]
  assert.ok(afterFirst.length >= 2, '第一次应当补录进来')

  const second = await harness.runCommand('--apply', 'sleep')
  assert.equal(second.kind, 'success')
  assert.match(second.text, /补录 0 条/u, '第二次不得再补录（指纹已命中）')
  const afterSecond = harness.memory().list() as Json[]
  assert.equal(afterSecond.length, afterFirst.length, '记录数不得增长')
  assert.deepEqual(
    afterSecond.map((row) => row.id).sort(),
    afterFirst.map((row) => row.id).sort(),
    '不得新建任何条目',
  )
})

// ---------------------------------------------------------------- 32. 开关

test('host#32 sleepEnabled=false：拒绝执行且零写入（与 sessionQuery 是否可用无关）', async (t) => {
  const { harness } = sleepHarness({ config: { sleepEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  const result = await harness.runCommand('--apply', 'sleep')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /sleepEnabled=false/u)
  assert.match(result.text, /不做任何事/u)
  assert.equal(harness.domain.puts.length, 0, '关掉开关后一次写盘都不许发生')
  assert.equal(harness.memory().list().length, 0)
  assert.match((await harness.runCommand('stats')).text, /梳理（\/sleep）：运行 0 次/u)
})

// ---------------------------------------------------------------- 33. 与召回模式无关

test('host#33 /sleep 不受 recallMode / autoRecall 影响（契约 §5.5）', async (t) => {
  const { harness } = sleepHarness({ config: { recallMode: 'off', autoRecall: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  const preview = await harness.runCommand('', 'sleep')
  assert.equal(preview.kind, 'success', '关掉召回不等于关掉 /sleep')
  assert.match(preview.text, /补录 [1-9]\d* 条/u, '预览仍应给出补录计划')

  const applied = await harness.runCommand('--apply', 'sleep')
  assert.equal(applied.kind, 'success')
  assert.match(applied.text, /补录 [1-9]\d* 条/u)
  assert.ok(harness.memory().list().length > 0, '即使 recallMode=off 也要真的落盘')
})

// ---------------------------------------------------------------- 34. stats 行（命令 + 工具）

test('host#34 /memory stats 与 memory_stats 工具都暴露 sleep 行与结构化计数', async (t) => {
  const { harness } = sleepHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  // 未运行时也要有一行（不能等跑过才出现）
  assert.match((await harness.runCommand('stats')).text, /梳理（\/sleep）：运行 0 次.*尚未运行/u)

  assert.equal((await harness.runCommand('--apply', 'sleep')).kind, 'success')
  const raw = JSON.parse(String(await harness.tool('memory_stats').execute({}))) as Json
  const sleep = raw.sleep as Json
  assert.ok(sleep, 'memory_stats 必须带 sleep 字段')
  assert.equal(Number(sleep.runs), 1)
  assert.ok(Number(sleep.added) >= 1)
  assert.equal(Number(sleep.merged), 0)
  assert.equal((sleep.last as Json).sessions, 2, 'last 记录最近一次回看的会话数')
  assert.match(String(raw.text), /梳理（\/sleep）：运行 1 次/u, '工具文本与 /memory stats 同步')
})

// ---------------------------------------------------------------- 35. Schema（7 个 sleep 键）

test('host#35 配置 Schema：契约 §4.1 的 7 个 sleep 键与默认值（无 schemastery 时跳过）', async () => {
  if (Config === undefined) {
    // 发布版 profile：schemastery 不可解析 → 没有设置页表单（module.test.ts 覆盖这条降级路径）
    assert.equal(Config, undefined)
    return
  }
  const dict = (Config as { dict?: Record<string, { meta?: { default?: unknown } }> }).dict ?? {}
  const expected: Array<[string, unknown]> = [
    ['sleepEnabled', true],
    ['sleepSessions', 3],
    ['sleepMaxCharsPerSession', 120000],
    ['sleepMaxCharsTotal', 300000],
    ['sleepMaxBackfill', 20],
    ['sleepAssistantContext', 3],
    ['sleepMaxGists', 8],
  ]
  for (const [key, value] of expected) {
    const entry = dict[key]
    assert.ok(entry, `Schema 必须声明 ${key}`)
    assert.deepEqual(entry.meta?.default, value, `${key} 的默认值必须与契约 §4.1 一致`)
  }
})

// ---------------------------------------------------------------- 37. 配置不被宿主改写

test('host#37 sleepMaxBackfill=0：宿主不得把「不补录」悄悄改成默认 20', async (t) => {
  const { harness } = sleepHarness({ config: { sleepMaxBackfill: 0 } })
  t.after(() => harness.dispose())
  await harness.settle()

  const preview = await harness.runCommand('', 'sleep')
  assert.equal(preview.kind, 'success')
  assert.match(preview.text, /无需改动/u, '上限 0 时计划里不该有可补录的候选')
  assert.doesNotMatch(preview.text, /补录 \d+ 条（按时间升序）/u, '候选列表必须是空的')

  const applied = await harness.runCommand('--apply', 'sleep')
  assert.equal(applied.kind, 'success')
  assert.match(applied.text, /梳理完成（\/sleep --apply）：补录 0 条/u)
  assert.equal(harness.memory().list().length, 0, '配置说别写，就一条都不许写')
})

// ---------------------------------------------------------------- 38. agent_self 的第二道防线

test('host#38 agent_self 冲突目标：/sleep 不得动自画像（计划层已排除，宿主侧再挡一次）', async (t) => {
  const { harness } = sleepHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  // 用 import 造两条**同 subject/field、不同 value** 的 agent_self：import 不带 facet，
  // 因此绕过自画像收敛，能真的落下两条 active 记录 —— 这正好是 findConflicts 会配对的形状。
  const file = join(harness.tempDir, 'agent-self.json')
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    items: [
      { kind: 'agent_self', subject: 'self.work.style', field: 'verbosity', value: 'low', text: '我倾向用很短的回复，尽量少铺垫。' },
      { kind: 'agent_self', subject: 'self.work.style', field: 'verbosity', value: 'high', text: '我倾向把背景、选项与理由都展开说明。' },
    ],
  }))
  assert.equal((await harness.runCommand(`import ${file}`)).kind, 'success')
  const before = (harness.memory().list() as Json[]).filter((row) => row.kind === 'agent_self')
  assert.equal(before.length, 2, '前置条件：库里有两条同槽位的 agent_self')

  // 计划里就不该出现针对自画像的动作（契约 §4 步骤 8）：预览不能把 agent_self 列进
  // 补录/合并/失效/归档任何一节的**条目行**里（它只允许出现在「说明」中，例如「已跳过…」）。
  const preview = await harness.runCommand('', 'sleep')
  const lines = preview.text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]!
    if (!/^(补录|合并|失效|归档) /u.test(header)) continue
    const body: string[] = []
    for (let next = index + 1; next < lines.length && lines[next]!.startsWith('  '); next += 1) body.push(lines[next]!)
    assert.ok(body.length > 0, `「${header}」这一节应当有条目行`)
    assert.ok(body.every((line) => !line.includes('agent_self')), `自画像不得出现在「${header}」的条目里`)
  }

  const result = await harness.runCommand('--apply', 'sleep')
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /补录 [1-9]\d* 条/u, '这次 apply 确实执行了（不是整体空跑）')

  // 自画像一条都不能被 /sleep 改写（§6）：两条都必须还是 active、正文逐字不变
  const after = (harness.memory().list() as Json[]).filter((row) => row.kind === 'agent_self')
  assert.equal(after.length, 2, '不得新建 agent_self')
  for (const record of before) {
    const now = after.find((row) => row.id === record.id)!
    assert.ok(now, `${record.id} 不得消失`)
    assert.equal(now.status, 'active', 'agent_self 不得被 /sleep 置为 invalid/archived')
    assert.equal(now.text, record.text, 'agent_self 正文不得被改写')
    assert.equal(now.value, record.value)
  }
})

// ---------------------------------------------------------------- 36. 不碰自画像与用户所有物

test('host#36 /sleep --apply 不碰自画像与用户所有物：模型侧候选被挡、既有条目原样保留', async (t) => {
  // 会话里放一句命中 agent-self-directive 的指令（「以后你要…」）：这类候选绝不能被补录成自画像。
  const fake = makeFakeSessionQuery([
    {
      id: 'sess-self',
      cwd: SLEEP_CWD,
      createdAt: 5_000,
      events: [
        sleepUserEvent('记住：构建统一用 pnpm，产物输出到 dist 目录。', 1),
        sleepUserEvent('记住：以后你要先问我再动手，不要自己改公共接口。', 2),
      ],
    },
  ])
  const harness = makeHarness({ sessionQuery: fake.query })
  t.after(() => harness.dispose())
  await harness.settle()

  // 用户所有物：pinned 的用户记忆 + 用户侧自画像各一条
  const pinned = await harness.memory().write({
    kind: 'user_profile', text: '用户偏好中文回答与英文标识符', subject: 'language.preference', pinned: true,
  })
  const portrait = await harness.memory().write({
    kind: 'agent_self', facet: 'persona', subject: 'self.persona.general',
    text: '我在解释概念时会先给出结论，再补充理由。', origin: 'user_explicit', pinned: true,
  })
  assert.equal(pinned.ok, true)
  assert.equal(portrait.ok, true)
  const before = harness.memory().list() as Json[]

  const result = await harness.runCommand('--apply', 'sleep')
  assert.equal(result.kind, 'success', result.text)
  const rows = harness.memory().list() as Json[]

  // 自画像：一条都不许多（既有的那条必须逐字保留）
  const portraits = rows.filter((row) => row.kind === 'agent_self')
  assert.equal(portraits.length, 1, '/sleep 不得新建 agent_self 条目（§6）')
  assert.equal(portraits[0]!.id, portrait.id)
  assert.equal(portraits[0]!.text, before.find((row) => row.id === portrait.id)!.text, '自画像正文不得被改写')
  assert.equal(portraits[0]!.pinned, true)
  assert.equal(portraits[0]!.status, 'active')
  assert.ok(rows.every((row) => !String(row.text).includes('先问我再动手')), 'agent_self 候选不得被补录')

  // 用户所有物：pinned 条目原样保留（不合并、不归档、不改 pin）
  const kept = rows.find((row) => row.id === pinned.id)!
  assert.equal(kept.status, 'active')
  assert.equal(kept.pinned, true)
  assert.equal(kept.text, '用户偏好中文回答与英文标识符')

  // 对照：普通候选确实补录了（证明这次 apply 真的执行了，而不是整体跳过）
  assert.ok(rows.some((row) => String(row.text).includes('pnpm') && row.kind !== 'agent_self'))
})

// ================================================================ M9 可核验引用（refs）
// 契约：docs/refs.md 第 4/5 节。宿主侧负责三件事：零 I/O 的序号跟踪、所有写路径附着引用、
// `/memory verify` 的只读核对。这里用假 sessionQuery + 真实的事件回调把三条都钉死。

/** 一次带 seq 的会话事件（`state.seq` 的唯一来源）。 */
const emitSeqEvent = (harness: Harness, session: Json, event: Json): void => {
  harness.emitSync('session/event', session, event)
}

/** 假会话视图（id + cwd）：序号跟踪只看 `_session.id`。 */
const refsSession = (id = 'session-1'): Json => ({ id, header: { cwd: 'C:\\work\\demo' } })

/** 一条真实用户消息事件。 */
const seqUserEvent = (text: string, seq: number): Json =>
  ({ type: 'user/message', seq, time: 1_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

/** 一次 `memory_write` 工具调用。 */
const writeViaTool = async (harness: Harness, text: string): Promise<Json> =>
  JSON.parse(String(await harness.tool('memory_write').execute({ kind: 'semantic', text }))) as Json

/** refs 的 `via` 分布（断言用）。 */
const viasOf = (row: Json): string[] => ((row.refs as Json[] | undefined) ?? []).map((ref) => String(ref.via))

// ---------------------------------------------------------------- 39. live 区间

test('host#39 refs：live 捕获附着 turnStart..last 区间（via=live）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const agent = agentWith('C:\\work\\demo')
  harness.roots.push(agent)
  const session = refsSession()
  // 一个完整回合：turn/start(10) → 用户消息(11) → 助手回复(12) → 回合收尾
  emitSeqEvent(harness, session, { type: 'turn/start', seq: 10 })
  emitSeqEvent(harness, session, seqUserEvent('记住：构建统一用 pnpm，产物输出到 dist 目录。', 11))
  emitSeqEvent(harness, session, { type: 'assistant/message', seq: 12, data: { message: { content: [{ type: 'text', text: '好的，我会照做。' }] } } })
  await harness.emit('agent/turn-stopping', { agent })
  await harness.settle()

  const rows = harness.memory().list() as Json[]
  assert.equal(rows.length, 1, '本回合应捕获 1 条')
  assert.deepEqual(rows[0]!.refs, [{ sessionId: 'session-1', from: 10, to: 12, via: 'live' }],
    'live 引用必须是整个回合区间 [turnStart, lastSeq]')

  // 换会话后不得把上一个会话的 turnStart 带过来
  const other = refsSession('session-2')
  emitSeqEvent(harness, other, seqUserEvent('记住：发布统一走 npm publish。', 3))
  const agent2 = { session: { id: 'session-2', seq: 1, header: { cwd: 'C:\\work\\demo' } } }
  harness.roots.push(agent2)
  await harness.emit('agent/turn-stopping', { agent: agent2 })
  await harness.settle()
  const second = (harness.memory().list() as Json[]).find((row) => String(row.text).includes('发布'))
  assert.deepEqual(second!.refs, [{ sessionId: 'session-2', from: 3, to: 3, via: 'live' }],
    '换会话后 turnStart 必须清空：没有 turn/start 时区间退化成单点')
})

// ---------------------------------------------------------------- 40. tool 单点

test('host#40 refs：memory_write 工具附着单点引用（via=tool，省略 to）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  emitSeqEvent(harness, refsSession(), seqUserEvent('这句话只是用来推进 seq 的。', 42))
  const payload = await writeViaTool(harness, '构建产物统一放在 dist 目录下')
  assert.equal(payload.ok, true)

  const row = (harness.memory().list() as Json[])[0]!
  assert.deepEqual(row.refs, [{ sessionId: 'session-1', from: 42, via: 'tool' }], '工具路径是单点引用（无 to）')
  assert.equal('to' in ((row.refs as Json[])[0]!), false, '单点引用必须省略 to')
  // 返回值里也要能看到引用（模型/用户当场就能看到出处）
  assert.deepEqual((payload.record as Json).refs, row.refs)
})

// ---------------------------------------------------------------- 41. 合并并入引用

test('host#41 refs：重复提及（hash 合并）时新引用并入既有条目，旧引用保留', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const session = refsSession()
  emitSeqEvent(harness, session, seqUserEvent('先推进到 200。', 200))
  const first = await writeViaTool(harness, '构建产物统一放在 dist 目录下')
  emitSeqEvent(harness, session, seqUserEvent('再推进到 260。', 260))
  const second = await writeViaTool(harness, '构建产物统一放在 dist 目录下')

  assert.equal(second.status, 'merged', '同一指纹必须走合并而不是新建')
  assert.equal(second.id, first.id)
  const rows = harness.memory().list() as Json[]
  assert.equal(rows.length, 1, '合并不得新建条目')
  assert.deepEqual(rows[0]!.refs, [
    { sessionId: 'session-1', from: 260, via: 'tool' },
    { sessionId: 'session-1', from: 200, via: 'tool' },
  ], '新引用在前、旧引用保留')
})

// ---------------------------------------------------------------- 42. refsEnabled=false

test('host#42 refs：refsEnabled=false 时写路径完全不附着（live 与 tool 都不带）', async (t) => {
  const harness = makeHarness({ config: { refsEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  const agent = agentWith('C:\\work\\demo')
  harness.roots.push(agent)
  const session = refsSession()
  emitSeqEvent(harness, session, { type: 'turn/start', seq: 5 })
  emitSeqEvent(harness, session, seqUserEvent('记住：构建统一用 pnpm。', 6))
  await harness.emit('agent/turn-stopping', { agent })
  await harness.settle()
  await writeViaTool(harness, '构建产物统一放在 dist 目录下')

  const rows = harness.memory().list() as Json[]
  assert.equal(rows.length, 2, '捕获 + 工具各写一条')
  for (const row of rows) assert.equal(row.refs, undefined, `${String(row.text)} 不得带 refs`)
  const stats = await harness.runCommand('stats')
  assert.match(stats.text, /引用：已附着 0 次/u)
  assert.match(stats.text, /refsEnabled=false/u, 'stats 必须说明开关已关')
})

// ---------------------------------------------------------------- 43~46. /memory verify

test('host#43 /memory verify：命中（覆盖率 ≥ recallMinMatch），且只读', async (t) => {
  // 用户消息必须命中显式祈使（「记住」）才会被捕获；正文与事件文本同源，覆盖率才会上阈值。
  const text = '记住：构建统一用 pnpm，产物输出到 dist 目录。'
  const fake = makeFakeSessionQuery([{
    id: 'session-1',
    cwd: 'C:\\work\\demo',
    createdAt: 1_000,
    events: [
      { type: 'turn/start', seq: 10, time: 1, data: {} },
      seqUserEvent(text, 11),
    ],
  }])
  const harness = makeHarness({ sessionQuery: fake.query })
  t.after(() => harness.dispose())
  await harness.settle()

  const agent = agentWith('C:\\work\\demo')
  harness.roots.push(agent)
  const session = refsSession()
  emitSeqEvent(harness, session, { type: 'turn/start', seq: 10 })
  emitSeqEvent(harness, session, seqUserEvent(text, 11))
  await harness.emit('agent/turn-stopping', { agent })
  await harness.settle()

  const before = harness.memory().list() as Json[]
  const record = before.find((row) => String(row.text).includes('pnpm'))!
  assert.ok(record, '本回合应捕获 1 条记忆')
  assert.equal((record.refs as Json[])[0]!.from, 10)

  const result = await harness.runCommand(`verify ${String(record.id).slice(0, 8)}`)
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /✅ 命中（覆盖率 \d\.\d\d）/u)
  assert.match(result.text, /命中 1 \/ 未命中 0/u)

  // 只读：记录逐字不变（含 refs）
  assert.deepEqual(harness.memory().list(), before, 'verify 不得修改任何记录')
  assert.deepEqual(fake.read, ['session-1'], '必须按引用回读来源会话')
  assert.match((await harness.runCommand('stats')).text, /核对 命中 1 \/ 未命中 0/u)
})

test('host#44 /memory verify：未命中（正文不在引用区间里）与计数', async (t) => {
  // 会话里只有一句与记忆无关的话；工具写入记下的是这一点的单点引用
  const fake = makeFakeSessionQuery([{
    id: 'session-1',
    cwd: 'C:\\work\\demo',
    createdAt: 1_000,
    events: [seqUserEvent('今天天气不错，出去走走。', 50)],
  }])
  const harness = makeHarness({ sessionQuery: fake.query })
  t.after(() => harness.dispose())
  await harness.settle()

  emitSeqEvent(harness, refsSession(), seqUserEvent('今天天气不错，出去走走。', 50))
  const record = await writeViaTool(harness, '构建产物统一放在 dist 目录下')

  const result = await harness.runCommand(`verify ${String(record.id).slice(0, 8)}`)
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /⚠️ 未命中（覆盖率 \d\.\d\d/u)
  assert.match(result.text, /命中 0 \/ 未命中 1/u)
  assert.match((await harness.runCommand('stats')).text, /核对 命中 0 \/ 未命中 1/u)
})

test('host#44b /memory verify：会话或事件不存在（读取失败不抛）', async (t) => {
  // 假 sessionQuery 里没有 session-1：readSession 会抛，verify 必须如实降级
  const fake = makeFakeSessionQuery([{
    id: 'other-session',
    cwd: 'C:\\work\\demo',
    createdAt: 1_000,
    events: [seqUserEvent('无关内容。', 1)],
  }])
  const harness = makeHarness({ sessionQuery: fake.query })
  t.after(() => harness.dispose())
  await harness.settle()

  emitSeqEvent(harness, refsSession(), seqUserEvent('先推进 seq。', 9))
  const record = await writeViaTool(harness, '构建产物统一放在 dist 目录下')

  const result = await harness.runCommand(`verify ${String(record.id).slice(0, 8)}`)
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /⚠️ 会话或事件不存在/u)
  assert.match((await harness.runCommand('stats')).text, /核对 命中 0 \/ 未命中 1/u, '读不到的引用计入未命中')
})

test('host#45 /memory verify：无 sessionQuery 时返回 error 文案且不抛', async (t) => {
  const harness = makeHarness() // 故意不提供 sessionQuery
  t.after(() => harness.dispose())
  await harness.settle()

  emitSeqEvent(harness, refsSession(), seqUserEvent('先推进 seq。', 7))
  const record = await writeViaTool(harness, '构建产物统一放在 dist 目录下')

  const result = await harness.runCommand(`verify ${String(record.id).slice(0, 8)}`)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /sessionQuery/u)
  assert.match(result.text, /只读|不受影响/u, '要说明记忆本身不受影响')
  assert.equal(harness.domain.puts.length, 1, 'verify 不得写盘（这里只有那次 memory_write）')
})

test('host#46 /memory verify：无引用的记录（0.5.9 之前的存量）给明确说明', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  // 没有任何 session/event → state.seq 为空 → 写出来的记录不带引用
  const record = await writeViaTool(harness, '构建产物统一放在 dist 目录下')
  assert.equal(record.refs, undefined)

  const result = await harness.runCommand(`verify ${String(record.id).slice(0, 8)}`)
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /这条没有引用/u)
  assert.match(result.text, /0\.5\.9/u, '要说明可能是老版本写入的')
  // 用法错误与未找到也要有可读文案
  assert.match((await harness.runCommand('verify')).text, /用法：\/memory verify/u)
  assert.match((await harness.runCommand('verify definitely-absent')).text, /未找到/u)
})

// ---------------------------------------------------------------- 47~49. 展示

test('host#47 /memory stats 与 memory_stats 都暴露引用行与结构化计数', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  emitSeqEvent(harness, refsSession(), seqUserEvent('先推进 seq。', 8))
  await writeViaTool(harness, '构建产物统一放在 dist 目录下')

  const stats = await harness.runCommand('stats')
  assert.match(stats.text, /引用：已附着 1 次 \/ 无引用记录 0 条/u)
  assert.match(stats.text, /核对 命中 0 \/ 未命中 0/u)

  const raw = JSON.parse(String(await harness.tool('memory_stats').execute({}))) as Json
  const refs = raw.refs as Json
  assert.ok(refs, 'memory_stats 必须带 refs 字段')
  assert.equal(Number(refs.attached), 1)
  assert.equal(Number(refs.withoutRefs), 0)
  assert.equal(Number(refs.verified), 0)
  assert.equal(Number(refs.mismatched), 0)
  assert.match(String(raw.text), /引用：已附着 1 次/u, '工具文本与 /memory stats 同步')

  // 无引用记录数：新写入一条不带 seq 的记录（先清掉 seq 来源不可能，改用 import 造一条无引用的）
  const file = join(harness.tempDir, 'norefs.json')
  writeFileSync(file, JSON.stringify({ items: [{ kind: 'semantic', text: '导入的条目没有任何引用。' }] }))
  assert.equal((await harness.runCommand(`import ${file}`)).kind, 'success')
  const after = JSON.parse(String(await harness.tool('memory_stats').execute({}))) as Json
  assert.equal(Number((after.refs as Json).withoutRefs), 1, 'import 不附着引用（数据副本，不是用户当场说的）')
  assert.match((await harness.runCommand('stats')).text, /无引用记录 1 条/u)
})

test('host#48 /memory show：带「来源：」一行（有引用/无引用都明确）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  emitSeqEvent(harness, refsSession(), seqUserEvent('先推进 seq。', 5))
  const record = await writeViaTool(harness, '构建产物统一放在 dist 目录下')
  const shown = await harness.runCommand(`show ${String(record.id).slice(0, 8)}`)
  assert.equal(shown.kind, 'success', shown.text)
  assert.match(shown.text, /来源：session-1#5/u)

  // 无引用时不留空白行，而是明确说明
  const file = join(harness.tempDir, 'plain.json')
  writeFileSync(file, JSON.stringify({ items: [{ kind: 'semantic', text: '导入的条目没有任何引用。', subject: 'legacy.import' }] }))
  await harness.runCommand(`import ${file}`)
  const plain = (harness.memory().list() as Json[]).find((row) => String(row.text).includes('没有任何引用'))!
  // 用完整 id：同一毫秒创建的两条记录前 8 位会撞前缀（show 是按前缀找第一条）
  assert.match((await harness.runCommand(`show ${String(plain.id)}`)).text, /来源：（无引用/u)
  assert.match((await harness.runCommand('help')).text, /verify <id>/u, 'help 要提到新命令')
  const hint = String((harness.command() as unknown as { input?: { hint?: string } }).input?.hint ?? '')
  assert.match(hint, /verify/u, '命令的 input.hint 也要提到 verify')
})

test('host#49 memory_explain：记录视图带机器可读的 refs 串', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  emitSeqEvent(harness, refsSession(), seqUserEvent('先推进 seq。', 12))
  const written = await writeSelf(harness, {
    kind: 'agent_self', facet: 'persona', subject: 'voice',
    text: '我在解释概念时会先给出结论，再补充理由。',
  })
  assert.equal(written.ok, true)

  const explain = JSON.parse(String(await harness.tool('memory_explain').execute({ text: '我回答问题的风格是什么' }))) as Json
  const records = (explain.portrait as Json).records as Json[]
  const active = records.find((row) => row.status === 'active')!
  assert.equal(active.refs, 'session-1#12', 'refs 用 refsToString 的机器可读形式')
})

// ---------------------------------------------------------------- 50~51. /sleep 透传

test('host#50 refs：/sleep 预览与补录都带候选自带的引用（via=sleep）', async (t) => {
  const { harness } = sleepHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const preview = await harness.runCommand('', 'sleep')
  assert.match(preview.text, /sess-new#1/u, '预览的补录候选要能看出指回哪条消息')

  assert.equal((await harness.runCommand('--apply', 'sleep')).kind, 'success')
  const rows = harness.memory().list() as Json[]
  const backfilled = rows.find((row) => String(row.text).includes('pnpm'))!
  assert.deepEqual(backfilled.refs, [{ sessionId: 'sess-new', from: 1, via: 'sleep' }],
    '补录必须透传纯函数层算好的引用')
  assert.ok(Number((harness.reportState().refs as Json).attached) >= 1, '附着计数要落进自报告')
})

test('host#51 refs：refsEnabled=false 时 /sleep 补录也不带引用（连透传的也不落库）', async (t) => {
  const { harness } = sleepHarness({ config: { refsEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  assert.equal((await harness.runCommand('--apply', 'sleep')).kind, 'success')
  const rows = harness.memory().list() as Json[]
  assert.ok(rows.length > 0, '补录本身要照常发生')
  for (const row of rows) assert.equal(row.refs, undefined, `${String(row.text)} 不得带 refs`)
  assert.match((await harness.runCommand('stats')).text, /引用：已附着 0 次/u)
})

test('host#52 refs：用户命令路径附着单点引用（self set 与 pin 都算「出处」）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  emitSeqEvent(harness, refsSession(), seqUserEvent('先推进 seq。', 30))
  const set = await harness.runCommand('self set persona 我在解释概念时会先给出结论')
  assert.equal(set.kind, 'success', set.text)
  const row = (harness.memory().list() as Json[])[0]!
  assert.deepEqual(row.refs, [{ sessionId: 'session-1', from: 30, via: 'command' }], '/memory self set 是 command 单点引用')

  // pin 是既有条目上的用户命令：新引用并入（新在前），旧引用保留
  emitSeqEvent(harness, refsSession(), seqUserEvent('再推进 seq。', 44))
  assert.equal((await harness.runCommand(`pin ${String(row.id).slice(0, 8)}`)).kind, 'success')
  const pinned = (harness.memory().list() as Json[]).find((item) => item.id === row.id)!
  assert.deepEqual(pinned.refs, [
    { sessionId: 'session-1', from: 44, via: 'command' },
    { sessionId: 'session-1', from: 30, via: 'command' },
  ])
  assert.match((await harness.runCommand('stats')).text, /引用：已附着 2 次/u)
})

// ================================================================ M10 写入审批门（writePolicy）
// 契约：docs/write-policy.md 第 4/5/6 节。宿主侧三件事：`writeMemory` 的三分流、
// pending 记录**绝不进任何注入路径**、以及「只有用户命令能把 pending 变成 active」。
// 这里对读取路径一律做**真实渲染断言**（不是查 `list()`）：只读白名单漏一条，
// 未批准的模型猜想就会进系统提示 —— 那是本功能最严重的失效模式。

/** 一次返回结构化结果的 `memory_write` 工具调用（M10 要读 ok/pending/id）。 */
const writeTool = async (harness: Harness, args: Json): Promise<Json> =>
  JSON.parse(String(await harness.tool('memory_write').execute(args))) as Json

/**
 * 一次带会话上下文的 `memory_write` 工具调用。
 *
 * 为什么要带 `exec`：常驻块（context 通道）按 workspace 过滤，而 `semantic` 这类 kind 的默认
 * scope 是 `workspace`，其 key 由 cwd 的 hash 决定。不带 cwd 时 key 是 `'*'`，只有「没有 cwd 的
 * 装配上下文」才会渲染它 —— 带一个明确 cwd 才能写出「本条会话真的能看到」的那种条目。
 */
const writeToolInWorkspace = async (harness: Harness, args: Json, cwd = WORKSPACE_CWD): Promise<Json> =>
  JSON.parse(String(await harness.tool('memory_write').execute(args, {
    agent: { session: { id: 'session-1', seq: 5, header: { cwd } } },
  }))) as Json

/**
 * 常驻块（R1：section + context 两条注入通道）的真实渲染文本。
 *
 * `context` 通道按 workspace 过滤：只收 profile 级与「当前 workspace」级的条目，
 * 匹配用的 key 是 cwd 的 hash（`workspaceKeyOf`）。这里把**两种装配上下文都渲染一遍**
 * （无 cwd / 与 `writeToolInWorkspace` 相同的 cwd），只要任一路径把 pending 放进来就算泄漏 ——
 * 断言因此不会因为「查询的 workspace 恰好不匹配」而变成假阳性。
 */
const WORKSPACE_CWD = 'C:\\work\\demo'
const residentText = (harness: Harness): string =>
  [
    harness.sections[0]!.text(),
    harness.contexts[0]!.text({ agent: { session: { header: { cwd: null } } } }),
    harness.contexts[0]!.text({ agent: { session: { header: { cwd: WORKSPACE_CWD } } } }),
  ].map(String).join('\n')

/** 本插件追加进 decision 的 runtime-context 正文（R2 + 反思/初次设定提示）。 */
const appendedText = (appended: Json[]): string =>
  appended.map((message) => (message.content as Json[]).map((block) => String(block.text)).join('')).join('\n')

/** 库里的全部记录（含 pending / invalid / archived）——用 `service.list()` 是因为它不过滤状态。 */
const allRows = (harness: Harness): Json[] => rowsOf(harness)

// ---------------------------------------------------------------- 53. ask：工具写入落成 pending

test('host#53 ask 模式：工具写入落成 pending 且 ok:true，此刻不执行自画像收敛', async (t) => {
  const harness = makeHarness({ config: { writePolicy: 'ask' } })
  t.after(() => harness.dispose())
  await harness.settle()

  const result = await writeTool(harness, { kind: 'semantic', text: '构建流程统一用 pnpm，产物输出到 dist 目录' })
  assert.equal(result.ok, true, '入队不是失败：模型要能区分「已提议」与「被拒绝」')
  assert.equal(result.pending, true, '必须明确回报 pending:true')
  assert.ok(typeof result.id === 'string' && (result.id as string).length > 0, '要给出 id 供 /memory approve 使用')
  assert.equal(result.text, '构建流程统一用 pnpm，产物输出到 dist 目录')
  assert.match(String(result.notice), /\/memory approve/u, '必须告诉模型/用户怎么让它生效')
  assert.match(String(result.notice), /模型无法自我批准/u)
  assert.equal(result.status, undefined, 'pending 不是 created/merged：没有生效')

  // 落盘了（重启后还在），但状态是 pending、不进 active 集合
  const rows = allRows(harness)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, 'pending')
  assert.ok(harness.domain.puts.some((put) => put.key === result.id), 'pending 记录照常落盘')
  assert.equal(harness.memory().recall({ query: '构建流程 pnpm dist' }).length, 0, '待确认不进召回')

  // agent_self：入队时**不**跑收敛（收敛推迟到批准时）
  const selfWrite = await writeTool(harness, { kind: 'agent_self', facet: 'work', subject: 'style', text: '我在动手改代码前会先跑通最小验证路径。' })
  assert.equal(selfWrite.pending, true)
  assert.equal(selfWrite.portrait, undefined, '入队时不得产出收敛决策')
  const self = harness.reportState().self as Json
  assert.equal(Number(self.added), 0, '入队不计入 add')
  assert.equal(Number(self.refined), 0)
  assert.equal(Number(self.superseded), 0)
  assert.equal(Number(self.skipped), 0, '入队也不计 skip：收敛根本没发生')
})

// ---------------------------------------------------------------- 54. 关键安全测试：pending 不进常驻块与 R2

test('host#54 关键安全测试：pending 记录不出现在常驻块与 R2（真实渲染断言）', async (t) => {
  const harness = makeHarness({ config: { writePolicy: 'ask', selfIntroEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  const FACT = '未批准的模型猜想：构建流程统一改用 bun 并输出到 build 目录'
  const PORTRAIT = '未批准的自画像猜想：我会在深夜工作时反复确认缩进宽度是否统一'
  const queued = await writeToolInWorkspace(harness, { kind: 'semantic', text: FACT, subject: 'build.tool' })
  const queuedSelf = await writeTool(harness, { kind: 'agent_self', facet: 'work', subject: 'style', text: PORTRAIT })
  assert.equal(queued.pending, true)
  assert.equal(queuedSelf.pending, true)

  // 反面对照（先做）：写一条**立刻生效**的记录（origin=observed，不进队列），
  // 证明常驻块本身渲染正常 —— 否则「看不到 pending」可能只是因为块是空的，那是假阳性。
  const control = harness.memory().write({
    kind: 'semantic', text: '对照记录：这个项目的构建工具链与产物目录约定', origin: 'observed', subject: 'control',
    scope: { level: 'workspace', key: workspaceKeyOf(WORKSPACE_CWD) ?? '*' },
  })
  assert.equal((await control).ok, true)
  const resident = residentText(harness)
  assert.ok(resident.includes('对照记录'), `常驻块必须能渲染同 scope 的 active 条目：${resident}`)
  assert.ok(!resident.includes('未批准的模型猜想'), `常驻块不得出现 pending：${resident}`)
  assert.ok(!resident.includes('未批准的自画像猜想'), 'section 通道（自画像）同样不得出现 pending')

  // R2：走真实的 pre-step，查询词与正文高度重合（最容易被召回的情形）
  const recalled = appendedText(await stepTurn(harness, 3, '构建流程是不是改成了 bun 输出到 build 目录？'))
  assert.ok(!recalled.includes('未批准的模型猜想'), `R2 不得出现 pending：${recalled}`)
  assert.doesNotMatch(recalled, /bun/u, 'pending 的正文（含 bun）不得被召回')

  // 项目印象重算：带标记的回合不得让 pending 混进印象
  const agent = agentWith('C:\\work\\demo')
  harness.roots.push(agent)
  harness.emitSync('session/event', agent.session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记住：这个项目的构建统一用 pnpm 并且产物放在 dist。' }] },
  })
  await harness.emit('agent/turn-stopping', { agent })
  await harness.settle()
  assert.ok(!residentText(harness).includes('未批准的模型猜想'), '捕获刷新印象后依然不得出现 pending')

  // 整合（合并/冲突/归档/摘要/固化）：pending 一律不参与
  assert.equal((await harness.runCommand('consolidate')).kind, 'success')
  const pendingNow = allRows(harness).filter((row) => row.status === 'pending')
  assert.equal(pendingNow.length, 2, '整合不得改动 pending 的状态')
  assert.ok(!residentText(harness).includes('未批准的模型猜想'), '整合之后常驻块依然干净')

  // 其它只读/工具读取路径：一律看不到 pending
  assert.doesNotMatch(String((await harness.tool('memory_list').execute({ status: 'all' }))), /未批准的模型猜想/u,
    'memory_list --status=all 不得列出 pending')
  assert.doesNotMatch(String((await harness.tool('memory_list').execute({ kind: 'agent_self', status: 'all' }))), /未批准的自画像猜想/u)
  assert.doesNotMatch(String((await harness.tool('memory_recall').execute({ query: '未批准的模型猜想 bun build' }))), /未批准的模型猜想/u,
    'memory_recall 不得召回 pending')
  assert.doesNotMatch((await harness.runCommand('list --archived')).text, /未批准的模型猜想/u, '/memory list 不得列出 pending')
  // search 用 `includeArchived: true`（归档仍可检索），但 pending 不在「归档」语义里 —— 必须看不见
  const searchText = (await harness.runCommand('search 未批准的模型猜想')).text
  assert.doesNotMatch(searchText, /未批准的模型猜想：构建流程/u, `/memory search 不得命中 pending：${searchText}`)
  assert.doesNotMatch((await harness.runCommand('stats')).text, /未批准的模型猜想/u, 'stats 只报条数，不列正文')

  // 例外：诊断路径必须能**显式看到** pending（否则「为什么没生效」无法定位）
  const explain = String(await harness.tool('memory_explain').execute({ text: '我回答问题的风格是什么' }))
  assert.match(explain, /未批准的自画像猜想/u, 'memory_explain 的 pending 区必须能诊断到待确认的自画像写入')
  const pendingDiag = (JSON.parse(explain) as Json).portrait as Json
  assert.equal((pendingDiag.pending as Json[]).length, 2, '诊断输出要列出全部 pending')
  assert.match((await harness.runCommand('pending')).text, /未批准的模型猜想/u, '/memory pending 必须能列出')

  // 反面对照：批准之后，同一条记录立刻能进常驻块（证明上面的「看不到」不是因为渲染坏了）
  const queuedRow = allRows(harness).find((row) => String(row.text).startsWith('未批准的模型猜想'))!
  assert.equal((await harness.runCommand(`approve ${String(queuedRow.id)}`)).kind, 'success')
  assert.ok(residentText(harness).includes('未批准的模型猜想'), '批准后必须立刻出现在常驻块里')

  // /memory pending 的正文预览压成单行（不能伪造出独立的注入行）
  const queuedText = (await harness.runCommand('pending')).text
  assert.match(queuedText, /\[待确认写入/u)
  assert.match(queuedText, /上限 50/u)
})

// ---------------------------------------------------------------- 55. approve / reject

test('host#55 /memory approve：置 active 且随后能注入；agent_self 在批准时才收敛', async (t) => {
  const harness = makeHarness({ config: { writePolicy: 'ask', selfIntroEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  const text = '未批准的模型猜想：构建流程统一改用 bun 并输出到 build 目录'
  const queued = await writeToolInWorkspace(harness, { kind: 'semantic', text })
  const prefix = String(queued.id)

  // 前缀不唯一 / 找不到：都要明确报错，不得猜
  const tooShort = await harness.runCommand('approve zzzzzzzz')
  assert.equal(tooShort.kind, 'error')
  assert.match(tooShort.text, /没有匹配/u)
  assert.equal((await harness.runCommand('approve')).kind, 'error', '缺参数要走 error')
  assert.match((await harness.runCommand('approve')).text, /用法：\/memory approve/u)

  // 唯一性：同一前缀命中多条时必须报错并列出候选，而不是取第一条
  const twin = await writeTool(harness, { kind: 'semantic', text: '第二条用于前缀歧义的待确认内容' })
  const shared = String(queued.id).slice(0, 6)
  assert.ok(String(twin.id).startsWith(shared), '两条同一毫秒创建的记录共享 6 字符前缀（测试前提）')
  const ambiguous = await harness.runCommand(`approve ${shared}`)
  assert.equal(ambiguous.kind, 'error', '前缀不唯一必须报错')
  assert.match(ambiguous.text, /不唯一/u)
  assert.match(ambiguous.text, /命中 2 条/u)
  assert.match(ambiguous.text, new RegExp(shared, 'u'), '候选必须列出 id（长于前缀，便于复制）')
  assert.equal(allRows(harness).filter((row) => row.status === 'active').length, 0, '歧义时不得改动任何记录')
  assert.equal((await harness.runCommand(`reject-pending ${String(twin.id)}`)).kind, 'success', '清理第二条')

  // 入队时给出的 id（完整）必须直接可用于 approve：这是队列唯一的取用方式
  const approved = await harness.runCommand(`approve ${String(queued.id)}`)
  assert.equal(approved.kind, 'success', approved.text)
  assert.match(approved.text, /status → active/u)

  const row = allRows(harness).find((entry) => entry.id === queued.id)!
  assert.equal(row.status, 'active', '批准后必须是 active')
  assert.equal(String(prefix).length > 6, true, '队列行给出的是完整 id（不必猜前缀长度）')
  // R2 命中同一件事。**必须在渲染常驻块之前跑**：R2 会剔除「已经在常驻块里的条目」，
  // 先渲染就等于把它登记进 `state.injected`，这条断言会变成自我否定的假阴性。
  const afterApprove = appendedText(await stepTurn(harness, 3, '构建流程是不是改成了 bun 输出到 build 目录？'))
  assert.match(afterApprove, /bun/u, `批准后 R2 召回必须命中：${afterApprove}`)
  // 随后**能**常驻注入（R1 是稳定的：只要 active 就进块）
  assert.ok(residentText(harness).includes('未批准的模型猜想'), '批准后常驻块应当能看到它')
  // agent_self：入队不收敛，批准时**才**收敛（此时库状态已知）
  const selfText = '我在动手改代码前会先跑通最小验证路径，然后再逐步扩展。'
  const queuedSelf = await writeTool(harness, { kind: 'agent_self', facet: 'work', subject: 'style', text: selfText })
  assert.equal((harness.reportState().self as Json).added, 0, '入队时不得收敛')
  const selfApprove = await harness.runCommand(`approve ${String(queuedSelf.id)}`)
  assert.equal(selfApprove.kind, 'success', selfApprove.text)
  assert.match(selfApprove.text, /自画像已在批准时收敛/u)
  const selfRow = allRows(harness).find((entry) => entry.id === queuedSelf.id)!
  assert.equal(selfRow.status, 'active')
  assert.equal(selfRow.kind, 'agent_self')
  assert.equal(selfRow.subject, 'self.work.style', '批准时按 portraitSubjectFor 归一化 subject')
  const self = harness.reportState().self as Json
  assert.equal(Number(self.added), 1, '批准时收敛：库里没有同 subject 条目 → add')
  assert.equal(Number((harness.reportState().writes as Json).approved), 2)

  // 已批准的不再在队列里；重复 approve 报「不在队列」
  assert.doesNotMatch((await harness.runCommand('pending')).text, new RegExp(String(queued.id), 'u'))
  assert.match((await harness.runCommand(`approve ${String(queued.id)}`)).text, /没有匹配/u)

  // 批准是**用户命令**：只有它能把 pending 变成 active（模型工具列表里没有任何状态改写面）
  assert.equal(harness.tools.some((entry) => /approve|reject-pending|pending/i.test(entry.name)), false,
    '不得给模型任何能改 pending 状态的工具')
})

test('host#56 /memory reject-pending：置 invalid（保留审计）且永不注入', async (t) => {
  const harness = makeHarness({ config: { writePolicy: 'ask', selfIntroEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  const text = '未批准的模型猜想：构建流程统一改用 bun 并输出到 build 目录'
  const queued = await writeToolInWorkspace(harness, { kind: 'semantic', text })
  const rejected = await harness.runCommand(`reject-pending ${String(queued.id)}`)
  assert.equal(rejected.kind, 'success', rejected.text)
  assert.match(rejected.text, /invalid/u)
  assert.match(rejected.text, /保留用于审计/u)

  // 保留痕迹：记录还在（不是物理删除），status=invalid
  const row = allRows(harness).find((entry) => entry.id === queued.id)!
  assert.ok(row, 'reject 不得物理删除')
  assert.equal(row.status, 'invalid')
  assert.equal(harness.domain.deletes.length, 0, 'reject 不得走删除路径')
  assert.equal(Number((harness.reportState().writes as Json).pendingRejected), 1)

  // 永不注入
  assert.ok(!residentText(harness).includes('未批准的模型猜想'), 'invalid 记录不得进常驻块')
  assert.deepEqual(appendedText(await stepTurn(harness, 3, '构建流程是不是改成了 bun 输出到 build 目录？')), '',
    'invalid 记录不得被 R2 注入')
  assert.doesNotMatch((await harness.runCommand('list --archived')).text, /未批准的模型猜想/u)
  assert.doesNotMatch((await harness.runCommand('pending')).text, /未批准的模型猜想/u, '已拒绝的离开队列')

  // 拒绝之后仍可在审计里看到它曾经存在（reject 不是删除）
  assert.match((await harness.runCommand(`show ${String(queued.id)}`)).text, /未批准的模型猜想/u,
    '/memory show 仍能看到被拒绝的记录（保留审计痕迹）')
  assert.equal(harness.domain.deletes.length, 0)
  // 同类自我观察不会再产生（指纹登记）：与上一条同 kind + 同正文 + 同 scope = 同 hash。
  // （待确认记录的 hash 与 active 记录同口径：`recordHash` 不看 status/refs。）
  const again = await writeToolInWorkspace(harness, { kind: 'semantic', text })
  assert.equal(again.ok, false, `被拒绝过的同类写入不得再产生：${JSON.stringify(again)}`)
  assert.match(String(again.error), /rejected_by_user/u)

  // 另一条：找回 /memory reject 的语义边界 —— 待确认记录必须走 reject-pending
  const second = await writeTool(harness, { kind: 'semantic', text: '第二条待确认的模型写入内容' })
  const viaOldReject = await harness.runCommand(`reject ${String(second.id)}`)
  assert.equal(viaOldReject.kind, 'error')
  assert.match(viaOldReject.text, /reject-pending/u, '旧的 reject 必须指路到队列专用出口')
  assert.equal(allRows(harness).find((entry) => entry.id === second.id)!.status, 'pending', '指路时不得改状态')

  // 删除路径同样不得成为绕过审批的后门
  const forget = JSON.parse(String(await harness.tool('memory_forget').execute({ id: second.id }))) as Json
  assert.equal(forget.ok, false)
  assert.equal(forget.error, 'pending_requires_decision')
  // 状态治理命令一律不能把 pending 改掉
  for (const command of ['restore', 'pin', 'archive']) {
    const blocked = await harness.runCommand(`${command} ${String(second.id)}`)
    assert.equal(blocked.kind, 'error', `/memory ${command} 不得作用于 pending`)
    assert.match(blocked.text, /待确认写入/u)
  }
  assert.equal(allRows(harness).find((entry) => entry.id === second.id)!.status, 'pending')
  assert.equal(allRows(harness).filter((row) => row.status === 'active').length, 0, '没有任何 pending 被放行')

  // clear 也不抹掉待确认记录
  const cleared = await harness.runCommand('clear --all --yes')
  assert.equal(cleared.kind, 'success')
  assert.match(cleared.text, /待确认/u, 'clear 要说明跳过了待确认记录')
  assert.equal(allRows(harness).find((entry) => entry.id === second.id)!.status, 'pending')
})

// ---------------------------------------------------------------- 57. off / 队列满 / 绕过

test('host#57 off 模式：拒绝且零写入（不落盘、不建记录）', async (t) => {
  const harness = makeHarness({ config: { writePolicy: 'off' } })
  t.after(() => harness.dispose())
  await harness.settle()

  const putsBefore = harness.domain.puts.length
  const result = await writeTool(harness, { kind: 'semantic', text: '构建流程统一用 pnpm，产物输出到 dist 目录' })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /^rejected_write_policy:/u, '错误文案必须可结构化识别')
  assert.equal(result.pending, undefined)
  assert.equal(harness.domain.puts.length, putsBefore, 'off 模式零写入：领域表一次 put 都不能发生')
  assert.equal(allRows(harness).length, 0)
  assert.equal(Number((harness.reportState().writes as Json).rejected), 1)

  // off 只挡模型来源；用户命令与规则捕获照常生效
  const set = await harness.runCommand('self set work 我在动手改代码前会先跑通最小验证路径')
  assert.equal(set.kind, 'success', set.text)
  const agent = agentWith('C:\\work\\demo')
  harness.roots.push(agent)
  harness.emitSync('session/event', agent.session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记住：发布统一走 npm publish。' }] },
  })
  await harness.emit('agent/turn-stopping', { agent })
  await harness.settle()
  assert.ok(allRows(harness).some((row) => String(row.text).includes('npm publish')), 'off 不得挡住规则捕获')
  assert.equal(allRows(harness).filter((row) => row.status === 'pending').length, 0)
})

test('host#57b 队列满：结构化错误 pending_queue_full，且零写入', async (t) => {
  const harness = makeHarness({ config: { writePolicy: 'ask', pendingMax: 2 } })
  t.after(() => harness.dispose())
  await harness.settle()

  const first = await writeTool(harness, { kind: 'semantic', text: '第一条待确认的记忆内容' })
  const second = await writeTool(harness, { kind: 'semantic', text: '第二条待确认的记忆内容' })
  assert.equal(first.pending, true)
  assert.equal(second.pending, true)

  const putsBefore = harness.domain.puts.length
  const full = await writeTool(harness, { kind: 'semantic', text: '第三条待确认的记忆内容' })
  assert.equal(full.ok, false)
  assert.match(String(full.error), /^pending_queue_full:/u, '队列满必须是结构化错误')
  assert.match(String(full.error), /2\/2/u, '错误文案要写清 N/上限')
  assert.match(String(full.error), /\/memory pending/u, '要告诉用户去哪里处理')
  assert.equal(harness.domain.puts.length, putsBefore, '队列满不得静默丢弃、也不得写盘')
  assert.equal(allRows(harness).length, 2)

  // 处理掉一条后又能入队（不是「一次满就永久卡死」）。
  // 两次 `writeMemory` 在同一毫秒创建、共享 6 字符前缀，所以这里用**完整 id**定位
  // （队列行给的也是完整 id），必要时轮询到这次自画像收敛判断落地。
  const conn = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)) }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await conn()
    const settled = (await harness.runCommand(`approve ${String(first.id)}`)).kind === 'success'
      || (await harness.runCommand(`reject-pending ${String(first.id)}`)).kind === 'success'
    if (settled) break
  }
  assert.notEqual(allRows(harness).find((entry) => entry.id === first.id)!.status, 'pending', '队列里的那条必须已被处理')
  assert.match((await harness.runCommand('stats')).text, /待确认：1 条（writePolicy=ask/u)
  assert.equal((await writeTool(harness, { kind: 'semantic', text: '第三条待确认的记忆内容' })).pending, true, '腾出空位后必须能再入队')

  // pendingMax<=0 = 不设上限（契约 §2.1：NaN/非法收紧到默认值，但显式 0 表示不限）
  const unlimited = makeHarness({ config: { writePolicy: 'ask', pendingMax: 0 } })
  t.after(() => unlimited.dispose())
  await unlimited.settle()
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await writeTool(unlimited, { kind: 'semantic', text: `不限上限的第 ${index} 条待确认内容` })).pending, true)
  }
  assert.match((await unlimited.runCommand('pending')).text, /上限 不限/u)
})

test('host#57c 用户命令 / 规则捕获 / 导入跳过队列；ask 不等于绕过安全闸', async (t) => {
  const harness = makeHarness({ config: { writePolicy: 'ask' } })
  t.after(() => harness.dispose())
  await harness.settle()

  // 用户命令（self set）立刻生效，不进队列
  const set = await harness.runCommand('self set persona 我在解释概念时会先给出结论再展开细节')
  assert.equal(set.kind, 'success', set.text)
  const setRow = allRows(harness).find((row) => row.kind === 'agent_self')!
  assert.equal(setRow.status, 'active', '用户命令立刻生效')
  assert.equal(String(setRow.origin), 'user_explicit')

  // 规则捕获（observed / user_explicit 都属「非模型来源」）立刻生效，不进队列。
  // 这句命中的是 `preference` 信号（origin=observed），**不是** `explicit-imperative`（user_explicit）——
  // 因此它正好验证「规则捕获绕过队列」这一条。
  const agent = agentWith('C:\\work\\demo')
  harness.roots.push(agent)
  harness.emitSync('session/event', agent.session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我们项目用 pnpm 管理依赖，构建产物统一放在 dist 目录。' }] },
  })
  await harness.emit('agent/turn-stopping', { agent })
  await harness.settle()
  const captured = allRows(harness).find((row) => String(row.text).includes('pnpm'))
  assert.ok(captured, '规则捕获必须照常写入')
  assert.equal(captured!.status, 'active', 'observed 绕过队列')
  assert.equal(String(captured!.origin), 'observed', '这一条正是 observed（规则捕获）')
  assert.equal(Number((harness.reportState().writes as Json).pending), 0, '规则捕获不入队')

  // 导入（用户提供的文件）同样不进队列
  const file = join(harness.tempDir, 'import-m10.json')
  writeFileSync(file, JSON.stringify({ items: [{ kind: 'semantic', text: '导入的这条记忆不该进待确认队列' }] }))
  assert.equal((await harness.runCommand(`import ${file}`)).kind, 'success')
  assert.ok(allRows(harness).some((row) => String(row.text).includes('导入的这条记忆') && row.status === 'active'))

  // 队列不是绕过脱敏的后门：敏感信息在**入队前**就被拒写
  const secret = await writeTool(harness, { kind: 'semantic', text: '这台机器的部署密钥是 sk-abcdefghijklmnop123456，请记住' })
  assert.equal(secret.ok, false)
  assert.match(String(secret.error), /rejected_sensitive/u)
  assert.doesNotMatch((await harness.runCommand('pending')).text, /sk-abcdefghijklmnop123456/u)
  // 邮箱按策略脱敏后再入队（正文里不能再出现完整邮箱）
  const masked = await writeTool(harness, { kind: 'semantic', text: '用户邮箱是 zhangsan@example.com，请记录下来' })
  assert.equal(masked.pending, true)
  assert.doesNotMatch(String(masked.text), /zhangsan@example\.com/u, '入队前必须已经脱敏')
  assert.match(String(masked.text), /\*\*\*/u)
})

test('host#57d /sleep 补录绕过队列，且计划与落盘都不碰 pending', async (t) => {
  const { harness } = sleepHarness({ config: { writePolicy: 'ask' } })
  t.after(() => harness.dispose())
  await harness.settle()

  // 先放一条 pending 进库：`/sleep` 的计划与落盘都不得动它
  const parked = await writeTool(harness, { kind: 'semantic', text: '待确认的这条不该被 /sleep 改动' })

  // `/sleep --apply` 的补录来自纯函数层（`/sleep` 自己的捕获重放），origin 是 user_explicit ——
  // 用户明确说过的话不受门控，必须**立刻生效**而不是进队列。
  const applied = await harness.runCommand('--apply', 'sleep')
  assert.equal(applied.kind, 'success', applied.text)
  const added = Number(/补录 (\d+) 条/u.exec(applied.text)?.[1] ?? '0')
  assert.ok(added >= 1, `/sleep 必须真的补录了东西：${applied.text}`)

  const rows = allRows(harness)
  const backfilled = rows.filter((row) => row.status === 'active' && (row.tags as string[] | undefined)?.includes('sleep'))
  assert.equal(backfilled.length, added, '补录的每一条都必须直接 active（绕过队列）')
  for (const row of backfilled) assert.notEqual(row.status, 'pending', `${String(row.text)} 不得进队列`)

  // pending 原样留在队列里（计划不参与、落盘不改状态）
  const stillPending = rows.find((row) => row.id === parked.id)!
  assert.equal(stillPending.status, 'pending', '/sleep 不得改动待确认记录')
  assert.match((await harness.runCommand('pending')).text, /不该被 \/sleep 改动/u)

  // 计划本身也看不见 pending（预览文本里不得出现它的正文）
  const preview = await harness.runCommand('', 'sleep')
  assert.doesNotMatch(preview.text, /不该被 \/sleep 改动/u, '/sleep 的计划不得列出待确认记录')
})

// ---------------------------------------------------------------- 58. 默认 auto ＝ 0.5.9 行为

test('host#58 默认 auto 与 0.5.9 行为等价：模型写入立刻生效、不进队列', async (t) => {
  const harness = makeHarness() // 不传 writePolicy：走 DEFAULTS 的 'auto'
  t.after(() => harness.dispose())
  await harness.settle()

  const result = await writeToolInWorkspace(harness, { kind: 'semantic', text: '构建流程统一用 pnpm，产物输出到 dist 目录' })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'created', '默认配置下模型写入立刻生效')
  assert.equal(result.pending, undefined, '默认不得进队列')
  assert.equal(result.notice, undefined)
  const row = allRows(harness)[0]!
  assert.equal(row.status, 'active')
  assert.match(residentText(harness), /pnpm/u, '默认配置下立刻可注入')

  // 自画像在默认配置下也照常立刻收敛（0.5.9 行为）
  const selfWrite = await writeTool(harness, { kind: 'agent_self', facet: 'work', subject: 'style', text: '我在动手改代码前会先跑通最小验证路径。' })
  assert.equal(selfWrite.ok, true)
  assert.equal((selfWrite.portrait as Json).action, 'add', '默认配置下自画像立刻收敛，不推迟到批准时')
  assert.equal(Number((harness.reportState().self as Json).added), 1)

  const stats = await harness.runCommand('stats')
  assert.match(stats.text, /待确认：0 条（writePolicy=auto/u, 'N=0 时也要显示策略值')
  assert.match(stats.text, /累计入队 0 \/ 批准 0 \/ 拒绝 0/u)
  assert.equal(Number((harness.reportState().writes as Json).pending), 0)
  assert.match((await harness.runCommand('pending')).text, /没有待确认的写入/, '空队列必须给出「没有待确认的写入」而不是空白')

  // 非法策略值回落 auto（与 normalizeWritePolicy 同口径），不得变成「拒绝写入」
  const bogus = makeHarness({ config: { writePolicy: 'yolo' } })
  t.after(() => bogus.dispose())
  await bogus.settle()
  assert.equal((await writeTool(bogus, { kind: 'semantic', text: '非法策略值必须回落 auto' })).status, 'created')
  assert.match((await bogus.runCommand('stats')).text, /writePolicy=auto/u)
})

// ---------------------------------------------------------------- 59. stats / 重启存活

test('host#59 stats 与重启：待确认行、结构化字段、pending 随普通记录一起加载', async (t) => {
  const harness = makeHarness({ config: { writePolicy: 'ask' } })
  t.after(() => harness.dispose())
  await harness.settle()

  // N=0 时也要显示策略值
  const empty = await harness.runCommand('stats')
  assert.match(empty.text, /待确认：0 条（writePolicy=ask/u)

  const queued = await writeToolInWorkspace(harness, { kind: 'semantic', text: '待确认的这条记忆会在重启后仍然可见' })
  assert.match((await harness.runCommand('stats')).text, /待确认：1 条（writePolicy=ask/u)

  // memory_stats：结构化字段 + 同一份文本
  const raw = JSON.parse(String(await harness.tool('memory_stats').execute({}))) as Json
  assert.equal(raw.pending, 1)
  assert.equal(raw.writePolicy, 'ask')
  assert.equal(raw.pendingMax, 50)
  assert.match(String(raw.text), /待确认：1 条（writePolicy=ask/u, '工具文本与 /memory stats 同步')
  assert.equal(Number((raw.writes as Json).pending), 1, '累计入队计数要进结构化字段')
  assert.match(String(raw.pendingPath), /模型无法自我批准/u)

  // 重启存活：**新实例从同一份盘上数据加载**（openDomain 的加载分支不含状态白名单）
  const persisted = [...harness.domain.rows.values()].filter((row) => row.status === 'pending')
  assert.equal(persisted.length, 1, 'pending 记录必须在盘上（不是只在内存里）')
  assert.equal(persisted[0]!.id, queued.id, '盘上的正是入队的那条')

  // 预先播种「上一进程留下的」数据，再启动一个新实例：它会走 openDomain 的加载分支
  const reborn = makeHarness({ config: { writePolicy: 'ask' }, seedDomainRows: harness.domain.rows })
  t.after(() => reborn.dispose())
  await reborn.settle()
  const pendingText = (await reborn.runCommand('pending')).text
  assert.match(pendingText, new RegExp(String(queued.id), 'u'), '重启后 /memory pending 必须仍能看到它')
  assert.match(pendingText, /待确认的这条记忆会在重启后仍然可见/u)
  assert.match((await reborn.runCommand('stats')).text, /待确认：1 条（writePolicy=ask/u)
  // 重启后的注入路径依然干净，直到用户批准
  assert.ok(!residentText(reborn).includes('待确认的这条记忆'), '重启不得让 pending 混进常驻块')
  assert.equal((await reborn.runCommand(`approve ${String(queued.id)}`)).kind, 'success', '重启后仍可批准')
  assert.ok(residentText(reborn).includes('待确认的这条记忆'), '批准后立刻可注入')

  // 配置 Schema：两个键与契约 §2.1 的默认值逐字一致（无 schemastery 时跳过）
  if (Config === undefined) {
    assert.equal(Config, undefined)
  } else {
    const dict = (Config as { dict?: Record<string, { meta?: { default?: unknown } }> }).dict ?? {}
    assert.equal(dict.writePolicy?.meta?.default, 'auto', 'writePolicy 默认必须是 auto（0.5.9 行为）')
    assert.equal(dict.pendingMax?.meta?.default, 50)
  }
})

// ================================================================ M11 模型可见文本多语言
// 契约：docs/i18n.md §4/§5/§6。宿主半边（本文件）只覆盖 index.ts 的三件事：
//   ① R2 块头/页脚、反思提示、初次设定提示按 `cfg.language` 取文案；
//   ② 7 个 memory_* 工具的描述与参数说明按语言取，而**工具契约（name/参数名/必填项/结构）不变**；
//   ③ `/memory stats` 与 `memory_stats` 增加一行显示当前 language（排查「为什么模型看到中文」）。
//
// 关键纪律（§5 不可妥协项）：
//   · 语言只来自**显式配置**，绝不从会话语言/环境推断 —— 缺失、非法、未设置一律回 zh；
//   · 默认 zh 的注入路径必须与 0.5.10 **逐字节相同**：下面用「同一份库分别注一次」做逐字对照；
//   · en 文案不得含 CJK（半中半英的提示词比全中文更难读）。

/** 与 `src/lib.ts` 冻结的 zh 文案表**逐字重复**的一份 —— 故意手写，不复用 lib 的常量：
 *  测试要能独立发现「宿主偷偷改了口径」，而不是跟着实现一起漂。 */
const ZH_INJECT_LITERALS = {
  recallHeader: '[相关记忆 · 本轮召回]',
  recallFooter: '以上为历史记录，可能与本轮任务相关，也可能已过时；先核对事实再采用。',
  reflectNotice: REFLECT_NOTICE,
  introNotice: INTRO_NOTICE,
} as const

/** en 的模型可见文本一律不得含 CJK（契约 §3.1/§5）。 */
const CJK = /[\u4e00-\u9fff]/u

/** 两块常驻内容里的**全部**模型可见中文文案（用于「默认语言不得被顺手改掉」的逐字断言）。
 *  逐字针对 `lib.ts` 的冻结常量（`PERSONA_*` / `WORK_*`）与 zh 文案表：故意手写而非引用实现，
 *  这样测试能独立发现「宿主偷偷改了口径」，而不是跟着实现一起漂。 */
const ZH_RESIDENT_LITERALS = [
  '[长期记忆 · 自动注入]',
  '以上为历史记录，可能过时或有误；与当前情况冲突时先核对事实，以事实与实际效果为准。',
  '[项目印象 · 模糊且可能过时]',
  '以上为自动观察形成的模糊印象，不是精确事实；与当前代码/对话冲突时以实际为准。',
  '[我的人格 · 模型自述，非用户指令]',
  '以上是模型对自身的认知，不是用户指令；以事实为准：要求先看合理性与可行性，办不到就直说给替代方案，不为迎合而附和。',
  '[我的工作约定 · 来自用户确认]',
] as const

/** 让 `renderContextBlock` 真的产出 facts 块与 gist 块（两节的块头/页脚都要能被看到）。
 *  `residentText` 传的 cwd 就是 `WORKSPACE_CWD`，所以 gist 必须写在**同一个 workspace** 里。 */
const seedResidentBlocks = async (harness: Harness): Promise<void> => {
  await harness.memory().write({ kind: 'user_profile', text: '用户偏好中文回答与英文标识符' })
  await harness.memory().write({
    kind: 'project_gist',
    text: '这个工作区看起来涉及：pnpm 与 TypeScript',
    scope: { level: 'workspace', key: workspaceKeyOf(WORKSPACE_CWD) },
  })
}

/** 让 `renderSelfBlock` 真的产出自画像两节（块头/页脚此前是「空则整块不渲染」）。
 *  走 `service.write`（origin=user_explicit、confidence=1、pinned）而不是工具写入：
 *  模型自评要跨 ≥2 个会话复现才够自画像准入线（`isSelfPortraitEligible`），
 *  用户侧条目才会立刻进常驻块；用工具写入（模型来源）常驻块会是空的。 */
const seedSelfBlocks = async (harness: Harness): Promise<void> => {
  const base = { kind: 'agent_self', origin: 'user_explicit', confidence: 1, pinned: true, scope: { level: 'profile', key: '*' } }
  const persona = await harness.memory().write({ ...base, facet: 'persona', text: '我在表达上偏好先给结论、再给理由。' })
  const work = await harness.memory().write({ ...base, facet: 'work', text: '我在动手改代码前会先跑通最小验证路径。' })
  assert.equal(persona.ok, true, '种入人格条目失败，常驻块断言会失去意义')
  assert.equal(work.ok, true, '种入工作约定条目失败，常驻块断言会失去意义')
}

/** 工具契约里**不随语言改变**的那部分：名称、参数名、必填项、结构。 */
const toolContractOf = (harness: Harness): Json => {
  const contract: Record<string, unknown> = {}
  for (const tool of harness.tools) {
    const parameters = tool.parameters as Json
    const properties = parameters.properties as Record<string, Json>
    contract[tool.name] = {
      // description 故意不进指纹：它就是要随语言变的那部分
      structure: { type: parameters.type, additionalProperties: parameters.additionalProperties },
      // 参数名（顺序参与比较：JSON Schema 的 property 顺序就是模型看到的顺序）
      names: Object.keys(properties),
      required: parameters.required ?? null,
      // 参数自身的契约：类型 / 枚举 / 数组元素类型
      schema: Object.fromEntries(Object.entries(properties).map(([key, value]) => [
        key,
        { type: value.type, enum: value.enum ?? null, items: value.items ?? null },
      ])),
    }
  }
  return contract
}

test('host#60 language=en：R2 块头/页脚用英文，且正文/形状/来源与 zh 同规格（契约 §4.1）', async (t) => {
  const en = makeHarness({ config: { language: 'en', recallMode: 'inject', selfIntroEnabled: false } })
  t.after(() => en.dispose())
  await en.settle()
  await en.memory().write({ kind: 'user_profile', text: '构建流程统一用 pnpm，产物输出到 dist 目录' })

  const extra = await stepTurn(en, 3, '请继续按构建流程用 pnpm 输出 dist')
  assert.equal(extra.length, 1, '这一例只开 R2（反思/初次设定闸门未到或已关）')
  assert.equal(sectionNameOf(extra[0]!), 'dsh-memory:recall')

  const message = extra[0]!
  const text = (message.content as Json[])[0]!.text as string
  const lines = text.split('\n')
  assert.equal(lines[0], '[Related memories · recalled for this turn]', '块头必须是 en 的 recallHeader')
  assert.equal(
    lines[lines.length - 1],
    'The above are past records, possibly relevant to this turn and possibly outdated; check the facts before using them.',
    '页脚必须是 en 的 recallFooter',
  )
  assert.ok(lines.some((line) => line.includes('pnpm')), '命中条目照旧进块')
  // 条目正文本身是中文记忆（语言只改文案，不翻译数据）—— 只对块级固定文案断言无 CJK
  for (const line of [lines[0]!, lines[lines.length - 1]!]) {
    assert.doesNotMatch(line, CJK, 'en 的 R2 块头/页脚不得出现任何 CJK')
  }

  // 语言只换字符串：消息形状、来源与 section 名与 zh 完全一致
  assert.equal(message.role, 'user')
  const source = message.source as Json
  assert.equal(source.kind, 'runtime-context')
  assert.equal(source.form, 'snapshot')
  const sections = source.sections as Json[]
  assert.equal(sections.length, 1)
  assert.equal(sections[0]!.name, 'dsh-memory:recall', 'section 名是协议的一部分，不随语言变')
  assert.equal(sections[0]!.text, text)
})

test('host#61 language=en：反思提示与初次设定提示用英文（契约 §4.1）', async (t) => {
  const en = makeHarness({
    config: { language: 'en', recallMode: 'inject', selfReflectEveryTurns: 1, selfReflectMinTurn: 1, selfIntroMinTurn: 1 },
  })
  t.after(() => en.dispose())
  await en.settle()

  const bySection = new Map<string, Json>()
  for (const message of await stepTurn(en, 1)) bySection.set(sectionNameOf(message), message)
  const reflect = bySection.get('dsh-memory:self-reflect')
  const intro = bySection.get('dsh-memory:self-intro')
  assert.ok(reflect, '这一轮必须同时注入反思提示')
  assert.ok(intro, '这一轮必须同时注入初次设定提示')

  const reflectText = String((reflect.content as Json[])[0]!.text)
  const introText = String((intro.content as Json[])[0]!.text)
  assert.notEqual(reflectText, ZH_INJECT_LITERALS.reflectNotice, 'en 下不得再注入 zh 的反思提示')
  assert.notEqual(introText, ZH_INJECT_LITERALS.introNotice, 'en 下不得再注入 zh 的初次设定提示')
  assert.doesNotMatch(reflectText, CJK, 'en 的反思提示不得含 CJK')
  assert.doesNotMatch(introText, CJK, 'en 的初次设定提示不得含 CJK')
  // 语义与 zh 一一对应：四条硬要求里最关键的两条仍要在（不迎合、不改用户设置/安全边界）
  assert.match(reflectText, /please/u)
  assert.match(reflectText, /safety limits/u)
  assert.match(reflectText, /memory_write/u, '工具名是契约，不随语言变')
  assert.match(introText, /self\.persona\.name/u, '命名 subject 是契约，不随语言变')
  // 注入正文照旧过 clampText：单行
  assert.doesNotMatch(reflectText, /\n/u)
  assert.doesNotMatch(introText, /\n/u)

  // 两块的消息形状不变
  for (const message of [reflect, intro]) {
    assert.equal(message.role, 'user')
    assert.equal((message.source as Json).kind, 'runtime-context')
    assert.equal((message.source as Json).form, 'snapshot')
  }
})

test('host#62 默认 zh 与改动前逐字节相同：R2 块头/页脚、反思提示、初次设定提示（契约 §5）', async (t) => {
  // 三个实例共用同一份库内容（同一条记忆、同一段 query），因此 R2 正文可以逐字对照。
  const configs: Array<[string, Json]> = [
    ['依赖 DEFAULTS.language（完全没配）', {}],
    ['显式 zh', { language: 'zh' }],
    ['非法值回落 zh', { language: 'bau' }],
    ['volatile 访问器形态的 zh', { language: volatile('zh') }],
  ]
  const texts: string[] = []
  for (const [label, config] of configs) {
    const harness = makeHarness({
      config: {
        ...config,
        recallMode: 'inject',
        selfReflectEveryTurns: 1,
        selfReflectMinTurn: 1,
        selfIntroMinTurn: 1,
        selfIntroMaxAsks: 1,
      },
    })
    try {
      await harness.settle()
      await harness.memory().write({ kind: 'user_profile', text: '构建流程统一用 pnpm，产物输出到 dist 目录' })

      const extra = await stepTurn(harness, 1, '请继续按构建流程用 pnpm 输出 dist')
      const bySection = new Map<string, Json>()
      for (const message of extra) bySection.set(sectionNameOf(message), message)
      const recall = bySection.get('dsh-memory:recall')
      const reflect = bySection.get('dsh-memory:self-reflect')
      const intro = bySection.get('dsh-memory:self-intro')
      assert.ok(recall, `${label}：必须注入 R2`)
      assert.ok(reflect, `${label}：必须注入反思提示`)
      assert.ok(intro, `${label}：必须注入初次设定提示`)

      const recallText = String((recall.content as Json[])[0]!.text)
      const lines = recallText.split('\n')
      assert.equal(lines[0], ZH_INJECT_LITERALS.recallHeader, `${label}：R2 块头必须逐字沿用旧字面量`)
      assert.equal(lines[lines.length - 1], ZH_INJECT_LITERALS.recallFooter, `${label}：R2 页脚必须逐字沿用旧字面量`)
      // 反思/初次设定提示照旧逐字等于既有导出常量（也就是 0.5.10 注入的那串字）
      assert.equal(String((reflect.content as Json[])[0]!.text), ZH_INJECT_LITERALS.reflectNotice, `${label}：反思提示必须逐字不变`)
      assert.equal(String((intro.content as Json[])[0]!.text), ZH_INJECT_LITERALS.introNotice, `${label}：初次设定提示必须逐字不变`)

      texts.push([recallText, String((reflect.content as Json[])[0]!.text), String((intro.content as Json[])[0]!.text)].join('\n'))
    } finally {
      await harness.dispose()
    }
  }
  // 「缺省 / 显式 zh / 非法值」三者注入的每一个字节都必须相同
  for (const text of texts.slice(1)) {
    assert.equal(text, texts[0], '缺省、zh 与非法值必须注入完全相同的内容')
  }

  // 常驻两块（section + context）在默认语言下也不得漏字：逐条比对既有中文文案。
  // 注意：lib 的块头/页脚是**有内容才渲染**（空则整块不出），所以这里先把两节的记录喂进去。
  const resident = makeHarness()
  t.after(() => resident.dispose())
  await resident.settle()
  await seedResidentBlocks(resident)
  await seedSelfBlocks(resident)
  const rendered = residentText(resident)
  for (const literal of ZH_RESIDENT_LITERALS) {
    assert.ok(rendered.includes(literal), `常驻块不得漏掉既有文案：${literal}`)
  }
})

test('host#63 language=en：7 个工具描述与参数说明都是英文，且工具契约完全不变（契约 §4.2/§5）', async (t) => {
  const zh = makeHarness()
  const en = makeHarness({ config: { language: 'en' } })
  t.after(() => zh.dispose())
  t.after(() => en.dispose())

  assert.deepEqual(
    toolContractOf(en),
    toolContractOf(zh),
    '工具名/参数名/必填项/schema 结构绝不能因 language 而变（否则模型已学会的调用方式会失效）',
  )
  assert.deepEqual(en.tools.map((tool) => tool.name), zh.tools.map((tool) => tool.name))

  for (const tool of en.tools) {
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} 必须有描述`)
    assert.doesNotMatch(String(tool.description), CJK, `${tool.name} 的 en 描述不得含 CJK`)
  }
  // 参数说明（schema 里的 description）也要跟着语言走
  const enWrite = (en.tool('memory_write').parameters as Json).properties as Record<string, Json>
  const zhWrite = (zh.tool('memory_write').parameters as Json).properties as Record<string, Json>
  for (const key of ['text', 'subject', 'facet']) {
    assert.ok(String(enWrite[key]!.description ?? '').length > 0, `memory_write.${key} 必须有参数说明`)
    assert.doesNotMatch(String(enWrite[key]!.description), CJK, `memory_write.${key} 的 en 说明不得含 CJK`)
    assert.notEqual(enWrite[key]!.description, zhWrite[key]!.description, `memory_write.${key} 的说明必须按语言切换`)
  }
  const enExplain = (en.tool('memory_explain').parameters as Json).properties as Record<string, Json>
  const zhExplain = (zh.tool('memory_explain').parameters as Json).properties as Record<string, Json>
  for (const key of ['text', 'apply']) {
    assert.doesNotMatch(String(enExplain[key]!.description), CJK, `memory_explain.${key} 的 en 说明不得含 CJK`)
    assert.notEqual(enExplain[key]!.description, zhExplain[key]!.description)
  }
})

test('host#64 默认 zh：7 个工具的描述与参数说明逐字不变（契约 §5）', async (t) => {
  // 与 0.5.10 的内联字面量逐字重复（故意手写，见文件头注释）
  const expected: Record<string, string> = {
    memory_write: '写入一条长期记忆（用户偏好、项目约定、结论、做法）。写入来源由插件判定，不由本参数指定。',
    memory_recall: '按查询或过滤条件检索长期记忆，返回带来源与重要度的条目。',
    memory_list: '列出长期记忆（不做相关性打分，按确定性顺序）。',
    memory_forget: '删除长期记忆。给 id 前缀直接删；给 query 时默认只预览命中，需要 confirm=true 才真正删除。',
    memory_stats: '查看长期记忆的运行时可观测信息：条数、写入/拒绝计数、注入行数、渲染耗时、整合与召回状态。',
    memory_maintain: '整理长期记忆：合并同主题的重复条目、把矛盾条目标记为失效、按衰减归档。后台会定期自动执行，这里用于手动触发。',
    memory_explain: '诊断：给定一段文本，说明长期记忆会怎么处理它（命中哪条信号、被哪条排除规则拒绝、会写成什么记录）。apply=true 时真的写入。',
  }
  const expectedParams: Record<string, Record<string, string>> = {
    memory_write: {
      text: '单句、面向模型可读的记忆内容',
      subject: '归一化主题键，用于去重与冲突判定，例如 editor.theme',
      facet: '仅 kind=agent_self 有意义：自画像面（persona=人格/表达，work=工作倾向），缺省 work。',
    },
    memory_explain: {
      text: '待诊断的文本（通常是一句用户消息）',
      apply: '默认 false，只解释不写入',
    },
  }

  // 缺省（完全没配）、显式 zh、非法值三种情况都必须逐字落到同一份旧文案上
  for (const [label, config] of [
    ['缺省', {}],
    ['显式 zh', { language: 'zh' }],
    ['非法值回落', { language: 'zh-CN' }],
  ] as Array<[string, Json]>) {
    const harness = makeHarness({ config })
    try {
      for (const [toolName, description] of Object.entries(expected)) {
        assert.equal(String(harness.tool(toolName).description), description, `${label}：${toolName} 的描述必须逐字不变`)
      }
      for (const [toolName, params] of Object.entries(expectedParams)) {
        const properties = (harness.tool(toolName).parameters as Json).properties as Record<string, Json>
        for (const [key, description] of Object.entries(params)) {
          assert.equal(String(properties[key]!.description), description, `${label}：${toolName}.${key} 的说明必须逐字不变`)
        }
      }
    } finally {
      await harness.dispose()
    }
  }
})

test('host#65 stats：/memory stats 与 memory_stats 都显示当前 language（缺省 zh、非法值回落 zh）', async (t) => {
  // 缺省 → zh
  const zh = makeHarness()
  t.after(() => zh.dispose())
  await zh.settle()
  const zhStats = await zh.runCommand('stats')
  assert.equal(zhStats.kind, 'success')
  assert.match(zhStats.text, /语言：language=zh/u, '缺省必须显示 zh（命令输出本身仍是中文）')
  const zhTool = JSON.parse(String(await zh.tool('memory_stats').execute({}))) as Json
  assert.match(String(zhTool.text), /语言：language=zh/u, '工具文本与 /memory stats 同步')

  // 显式 en
  const en = makeHarness({ config: { language: 'en' } })
  t.after(() => en.dispose())
  await en.settle()
  assert.match((await en.runCommand('stats')).text, /语言：language=en/u, 'en 下必须显示 en')
  const enTool = JSON.parse(String(await en.tool('memory_stats').execute({}))) as Json
  assert.match(String(enTool.text), /语言：language=en/u, '工具文本与 /memory stats 同步')
  // 命令输出本轮仍为中文（契约 §4.3「本轮范围外」）
  assert.match(String(enTool.text), /域：/u, 'language=en 不得把命令输出翻译成英文')
  assert.match((await en.runCommand('stats')).text, /记录数：/u)

  // 非法值 → 回落 zh（不能显示成原始非法值，否则排查时反而误导）
  const bogus = makeHarness({ config: { language: 'english' } })
  t.after(() => bogus.dispose())
  await bogus.settle()
  assert.match((await bogus.runCommand('stats')).text, /语言：language=zh/u)

  // volatile 访问器形态（运行版就是这样下发配置的）
  const vol = makeHarness({ config: { language: volatile('en') } })
  t.after(() => vol.dispose())
  await vol.settle()
  assert.match((await vol.runCommand('stats')).text, /语言：language=en/u, 'volatile 形态必须解包后再显示')
})

test('host#66 常驻注入块在两种语言下都能渲染，且只换块级文案（本轮写域边界：只做模型可见文本）', async (t) => {
  // `renderSelfBlock`/`renderContextBlock` 的块头/页脚由 lib 侧按语言提供（上一阶段已落地）。
  // 这里在**宿主**这一侧钉死两件事：① 宿主确实把 cfg.language 传进了渲染路径；
  // ② 语言只换块级文案 —— 记忆正文（数据）一字不改。命令输出本轮仍是中文（§4.3）。
  const zh = makeHarness()
  const en = makeHarness({ config: { language: 'en' } })
  t.after(() => zh.dispose())
  t.after(() => en.dispose())
  await zh.settle()
  await en.settle()
  for (const harness of [zh, en]) {
    await seedResidentBlocks(harness)
    await seedSelfBlocks(harness)
  }

  const zhResident = residentText(zh)
  const enResident = residentText(en)
  for (const literal of ZH_RESIDENT_LITERALS) {
    assert.ok(zhResident.includes(literal), `默认语言必须保留既有块头：${literal}`)
    assert.ok(!enResident.includes(literal), `en 不得混入 zh 块头：${literal}`)
  }
  assert.match(enResident, /\[Long-term memory · auto-injected\]/u, 'en 下 facts 块必须用英文块头')
  assert.match(enResident, /\[Persona · model self-description\]/u, 'en 下自画像块必须用英文块头')
  // 数据本身不翻译：中文记忆正文照样注入
  assert.ok(zhResident.includes('用户偏好中文回答与英文标识符'))
  assert.ok(enResident.includes('用户偏好中文回答与英文标识符'), 'language 只改文案，不改记忆正文')
  // 命令输出仍然只有中文（本轮明确不做命令输出本地化）
  const enStats = await en.runCommand('stats')
  assert.match(enStats.text, /记录数：/u)
  assert.doesNotMatch(enStats.text, /Records:/u)
})

test('host#67 language 只在显式配置时生效：会话内容/域名等其它配置不得影响语言推断', async (t) => {
  // 契约 §5：默认语言的每一个字节都必须与现状相同 —— 因此绝不允许「猜」语言。
  const harness = makeHarness({
    config: { domainName: 'dsh_memory_en_looking', recallMode: 'inject', selfIntroEnabled: false },
  })
  t.after(() => harness.dispose())
  await harness.settle()
  await harness.memory().write({ kind: 'user_profile', text: 'Build with pnpm and output to dist' })

  // 全英文的对话内容也不得让注入块变成英文
  const extra = await stepTurn(harness, 3, 'please continue with the pnpm build and output to dist')
  const text = String(((extra[0]!.content as Json[])[0]!).text)
  assert.ok(text.startsWith(ZH_INJECT_LITERALS.recallHeader), '语言不得从对话内容推断')
  assert.ok(text.endsWith(ZH_INJECT_LITERALS.recallFooter))
  assert.match(text, /pnpm/u, '英文记忆内容照旧注入')
})

// ================================================================ M12 git 分支感知（branch）
// 契约：docs/branch.md 第 4/5 节。宿主侧只做三件事：解析当前分支（零 shell、5 秒 TTL 缓存）、
// 在「取记录集合的那一处」统一过滤、把当前分支暴露给用户（`/memory branch`、stats 行、explain）。
//
// 关键纪律（§5）：
//   · 分支**只**来自 `<cwd>/.git/HEAD`（或 `.git` 文件里的 `gitdir:`）—— 绝不执行任何 git 命令；
//   · fail-closed 只针对带标签的记录：无标签记录在任何分支（含未知）下都照常注入；
//   · 库内没有标签时，注入输出必须与改动前逐字节相同（本节的最后两例专门钉死这一点）。
// 测试全部用**临时目录里的真 `.git/HEAD`** 驱动，不依赖本机仓库状态。

/** 造一个「零 shell 能解析」的临时 git 仓库：`<dir>/.git/HEAD` → `ref: refs/heads/<branch>`。 */
const makeGitRepo = (branch: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-branch-'))
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  return dir
}

/** 一个没有 `.git` 的临时目录（＝不在 git 仓库里 → 分支未知）。 */
const makeNonRepo = (): string => mkdtempSync(join(tmpdir(), 'dsh-memory-norepo-'))

/** 清掉测试自己造的目录（`harness.dispose()` 只清它自己的 tempDir）。 */
const useTempDirs = (t: { after(callback: () => unknown): void }, ...dirs: string[]): void => {
  t.after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
}

/**
 * 把「当前会话的 cwd」换成给定目录。
 *
 * 宿主按 `state.lastSession.cwd` 解析分支（契约 §4.1），而它只由 `session/event` 维护 ——
 * 用一条无害事件同步它，就能在不跑 git、不重启实例的前提下模拟「切到另一个仓库/分支」。
 */
const setSessionCwd = (harness: Harness, cwd: string | null): void => {
  harness.emitSync('session/event', { id: 'session-branch', header: { cwd } }, { type: 'branch-probe' })
}

/** 指定 cwd 的一次 pre-step（`stepTurn` 把 cwd 写死成 C:\work\demo，分支用例需要自己的仓库）。 */
const stepTurnAt = async (harness: Harness, turn: number, cwd: string, query: string): Promise<Json[]> => {
  const decision = { kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: query }] }] }
  const result = await harness.preStep(
    { turn, agent: { session: { id: 'session-branch', seq: turn, header: { cwd } } }, signal: { aborted: false } },
    async () => decision,
  ) as Json
  return ((result.messages ?? []) as Json[]).slice(1)
}

/** 两条只差「有没有分支标签」的记录：正文共享同一串高频词，因此同一个查询会同时命中它们。
 *  这样「B 分支上只少了带标签的那条」就不可能被误读成「召回本身没生效」。 */
const BRANCH_TAGGED_TEXT = '分支专属约定：这个特性分支上的构建流程统一用 pnpm 输出到 dist 目录'
const BRANCH_PLAIN_TEXT = '跨分支约定：这个项目的构建流程统一用 pnpm 输出到 dist 目录'
const BRANCH_QUERY = '请继续按构建流程用 pnpm 输出到 dist 目录'

test('host#68 memory_write 的 branch：true 打当前分支、字符串指定分支、缺省不打；分支未知时不打并说明（契约 §4.3）', async (t) => {
  const feat = makeGitRepo('feature/x')
  const nonRepo = makeNonRepo()
  useTempDirs(t, feat, nonRepo)
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  // 参数声明：可选，boolean|string；既有参数一个不动
  const properties = (harness.tool('memory_write').parameters as Json).properties as Record<string, Json>
  assert.ok(properties.branch, 'memory_write 必须声明可选参数 branch')
  assert.deepEqual(properties.branch!.type, ['boolean', 'string'])
  assert.equal(properties.branch!.enum, undefined)
  assert.equal(String(properties.branch!.description ?? '').length > 0, true, 'branch 必须有参数说明')

  setSessionCwd(harness, feat)
  const tagged = await writeToolInWorkspace(harness, { kind: 'semantic', text: BRANCH_TAGGED_TEXT, branch: true }, feat)
  assert.equal(tagged.ok, true)
  assert.equal(tagged.branch, 'feature/x', 'true = 当前分支，并回显给模型')
  assert.equal(rowsOf(harness).find((row) => row.id === tagged.id)!.branch, 'feature/x')

  // 字符串：指定分支，`refs/heads/` 前缀照 lib 的规范化收敛
  const explicit = await writeToolInWorkspace(harness, { kind: 'semantic', text: '发布分支专属：打 tag 一律加 v 前缀', branch: 'refs/heads/release/1.0' }, feat)
  assert.equal(explicit.branch, 'release/1.0')
  assert.equal(rowsOf(harness).find((row) => row.id === explicit.id)!.branch, 'release/1.0')

  // 缺省：记录里**一个键都不写**（存量记录形状不变）
  const plain = await writeToolInWorkspace(harness, { kind: 'semantic', text: BRANCH_PLAIN_TEXT }, feat)
  assert.equal(plain.branch, undefined, '缺省不得回显分支')
  assert.equal('branch' in rowsOf(harness).find((row) => row.id === plain.id)!, false, '缺省时不得写 branch 键')

  // 分支未知（不在 git 仓库）而传 true：不写标签 + 说明，绝不写 "unknown" 之类的假值
  setSessionCwd(harness, nonRepo)
  const unknown = await writeToolInWorkspace(harness, { kind: 'semantic', text: '分支未知时写入的约定：先按通用规则处理', branch: true }, nonRepo)
  assert.equal(unknown.ok, true)
  assert.equal(unknown.branch, undefined)
  assert.match(String(unknown.notice), /分支未知/u)
  assert.match(String(unknown.notice), /未写分支标签/u)
  assert.equal('branch' in rowsOf(harness).find((row) => row.id === unknown.id)!, false)

  // 非法分支名（空白 / 控制字符）：同样不写标签并说明
  const bogus = await writeToolInWorkspace(harness, { kind: 'semantic', text: '分支名非法的写入', branch: '   ' }, feat)
  assert.equal(bogus.branch, undefined)
  assert.match(String(bogus.notice), /非法/u)
  assert.equal('branch' in rowsOf(harness).find((row) => row.id === bogus.id)!, false)
})

test('host#69 分支 A 的标签记录在 A 上进常驻块与 R2，在 B 下全部被挡；无标签记录两处都照常（契约 §4.2/§5）', async (t) => {
  const repoA = makeGitRepo('feature/x')
  const repoB = makeGitRepo('main')
  useTempDirs(t, repoA, repoB)
  const harness = makeHarness({ config: { recallMode: 'inject', selfIntroEnabled: false, selfReflectEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  setSessionCwd(harness, repoA)
  const tagged = await writeToolInWorkspace(harness, {
    kind: 'semantic', scopeLevel: 'profile', text: BRANCH_TAGGED_TEXT, branch: true,
  }, repoA)
  await writeToolInWorkspace(harness, { kind: 'semantic', scopeLevel: 'profile', text: BRANCH_PLAIN_TEXT }, repoA)
  assert.equal(tagged.branch, 'feature/x')

  // A：R2 能召回。**先跑 R2**：常驻渲染会把条目登记进 state.injected，之后 R2 会把它当「已在常驻块里」剔掉。
  const onA = appendedText(await stepTurnAt(harness, 10, repoA, BRANCH_QUERY))
  assert.match(onA, /分支专属约定/u, `A 分支上标签记录必须能召回：${onA}`)
  assert.match(onA, /跨分支约定/u)

  // B：带标签的记录在 R2 里必须消失，而无标签的照常 —— 证明是「分支过滤」而不是「召回没命中」
  setSessionCwd(harness, repoB)
  const onB = appendedText(await stepTurnAt(harness, 20, repoB, BRANCH_QUERY))
  assert.doesNotMatch(onB, /分支专属约定/u, `B 分支上标签记录不得进 R2：${onB}`)
  assert.match(onB, /跨分支约定/u, 'fail-closed 只针对带标签的记录')

  // 常驻块（section + context 两条通道）：B 下不得出现，切回 A 必须重新出现
  const residentB = residentText(harness)
  assert.doesNotMatch(residentB, /分支专属约定/u, `B 分支上标签记录不得进常驻块：${residentB}`)
  assert.match(residentB, /跨分支约定/u)
  setSessionCwd(harness, repoA)
  assert.match(residentText(harness), /分支专属约定/u, '切回 A 后标签记录必须重新可见')

  // 其它读取路径：B 下全部被挡，A 下可见
  setSessionCwd(harness, repoB)
  assert.doesNotMatch(String(await harness.tool('memory_recall').execute({ query: BRANCH_QUERY })), /分支专属约定/u)
  assert.match(String(await harness.tool('memory_recall').execute({ query: BRANCH_QUERY })), /跨分支约定/u)
  assert.doesNotMatch(String(await harness.tool('memory_list').execute({ status: 'all' })), /分支专属约定/u)
  assert.doesNotMatch((await harness.runCommand('list --archived')).text, /分支专属约定/u)
  assert.doesNotMatch((await harness.runCommand(`search 分支专属约定`)).text, /分支专属约定/u)
  setSessionCwd(harness, repoA)
  assert.match(String(await harness.tool('memory_list').execute({ status: 'all' })), /分支专属约定/u)
  assert.match((await harness.runCommand('list --archived')).text, /分支专属约定/u)
  assert.match((await harness.runCommand(`search 分支专属约定`)).text, /分支专属约定/u)
})

test('host#70 分支未知（不在 git 仓库）：标签记录被挡（fail-closed），无标签记录照常（契约 §1/§5）', async (t) => {
  const repo = makeGitRepo('feature/x')
  const nonRepo = makeNonRepo()
  useTempDirs(t, repo, nonRepo)
  const harness = makeHarness({ config: { recallMode: 'inject', selfIntroEnabled: false, selfReflectEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  setSessionCwd(harness, repo)
  await writeToolInWorkspace(harness, { kind: 'semantic', scopeLevel: 'profile', text: BRANCH_TAGGED_TEXT, branch: true }, repo)
  await writeToolInWorkspace(harness, { kind: 'semantic', scopeLevel: 'profile', text: BRANCH_PLAIN_TEXT }, repo)

  // 切到非仓库目录：分支未知 → 标签记录一律不注入，无标签照常
  setSessionCwd(harness, nonRepo)
  // 先 R2：常驻渲染会把条目登记进 state.injected，之后 R2 会把它当「已在常驻块里」剔掉
  const r2 = appendedText(await stepTurnAt(harness, 5, nonRepo, BRANCH_QUERY))
  assert.doesNotMatch(r2, /分支专属约定/u)
  assert.match(r2, /跨分支约定/u)
  const resident = residentText(harness)
  assert.doesNotMatch(resident, /分支专属约定/u, '分支未知时带标签的记录必须被挡下')
  assert.match(resident, /跨分支约定/u)
  assert.doesNotMatch(String(await harness.tool('memory_recall').execute({ query: BRANCH_QUERY })), /分支专属约定/u)
  assert.doesNotMatch(String(await harness.tool('memory_list').execute({ status: 'all' })), /分支专属约定/u)
  assert.doesNotMatch((await harness.runCommand('search 分支专属约定')).text, /分支专属约定/u)
  // 诊断命令必须说清「当前分支未知」与后果
  const summary = (await harness.runCommand('branch')).text
  assert.match(summary, /当前分支：unknown/u)
  assert.match(summary, /fail-closed/u)
})

test('host#71 /memory branch：当前分支、带标签条数与清单；--all 附带其它分支（契约 §4.4）', async (t) => {
  const repoA = makeGitRepo('feature/x')
  const repoB = makeGitRepo('main')
  const nonRepo = makeNonRepo()
  useTempDirs(t, repoA, repoB, nonRepo)
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  setSessionCwd(harness, repoA)
  await writeToolInWorkspace(harness, { kind: 'semantic', text: BRANCH_TAGGED_TEXT, branch: true }, repoA)
  await writeToolInWorkspace(harness, { kind: 'semantic', text: BRANCH_PLAIN_TEXT }, repoA)
  setSessionCwd(harness, repoB)
  await writeToolInWorkspace(harness, { kind: 'semantic', text: '主干专属：main 上打 tag 用 v 前缀', branch: true }, repoB)

  setSessionCwd(harness, repoA)
  const base = (await harness.runCommand('branch')).text
  assert.match(base, /\[记忆分支 · 当前分支：feature\/x\]/u)
  assert.match(base, /带分支标签的记忆：2 条/u)
  assert.match(base, /- feature\/x：1 条（当前分支）/u)
  assert.match(base, /- main：1 条/u)
  assert.match(base, /分支专属约定/u, '当前分支的标签记录要列出来')
  assert.doesNotMatch(base, /主干专属/u, '无 --all 时不得列出其它分支的记录')
  assert.match(base, /其它分支还有 1 条标签记录/u)
  assert.match(base, /\/memory branch --all/u)

  const all = (await harness.runCommand('branch --all')).text
  assert.match(all, /主干专属/u, '--all 必须附带其它分支的标签记录')
  assert.match(all, /← main/u)
  assert.match(all, /← feature\/x/u)
  assert.equal(all.includes('当前分支（feature/x）的标签记录'), true)

  // 分支未知：明说 unknown、说明后果，--all 仍能列出全部标签记录（诊断不能因未知而瞎）
  setSessionCwd(harness, nonRepo)
  const unknown = (await harness.runCommand('branch')).text
  assert.match(unknown, /当前分支：unknown/u)
  assert.match(unknown, /fail-closed/u)
  assert.match(unknown, /这 2 条标签记录都不参与注入/u)
  assert.match((await harness.runCommand('branch --all')).text, /主干专属/u)
})

test('host#72 /memory stats 与 memory_stats 的分支行：当前分支、带标签条数、branchAware（契约 §4.5）', async (t) => {
  const repoA = makeGitRepo('feature/x')
  const nonRepo = makeNonRepo()
  useTempDirs(t, repoA, nonRepo)
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  // 空库 + 分支未知：这一行也必须存在（不能等有标签才渲染）
  assert.match((await harness.runCommand('stats')).text, /分支：unknown｜带标签 0 条（branchAware=true）/u)

  setSessionCwd(harness, repoA)
  await writeToolInWorkspace(harness, { kind: 'semantic', text: BRANCH_TAGGED_TEXT, branch: true }, repoA)
  await writeToolInWorkspace(harness, { kind: 'semantic', text: BRANCH_PLAIN_TEXT }, repoA)
  assert.match((await harness.runCommand('stats')).text, /分支：feature\/x｜带标签 1 条（branchAware=true）/u)

  const raw = JSON.parse(String(await harness.tool('memory_stats').execute({}))) as Json
  assert.match(String(raw.text), /分支：feature\/x｜带标签 1 条（branchAware=true）/u, '工具文本与 /memory stats 同步')
  assert.deepEqual(raw.branch, { current: 'feature/x', tagged: 1, branchAware: true })

  setSessionCwd(harness, nonRepo)
  assert.match((await harness.runCommand('stats')).text, /分支：unknown｜带标签 1 条（branchAware=true）/u)

  // branchAware=false 要如实显示（诊断「标签为什么不起作用」的第一线索）
  const off = makeHarness({ config: { branchAware: false } })
  t.after(() => off.dispose())
  await off.settle()
  assert.match((await off.runCommand('stats')).text, /分支：unknown｜带标签 0 条（branchAware=false）/u)
})

test('host#73 memory_explain 必须能看到被分支挡下的记录与原因（契约 §5「诊断可见」）', async (t) => {
  const repoA = makeGitRepo('feature/x')
  const repoB = makeGitRepo('main')
  const nonRepo = makeNonRepo()
  useTempDirs(t, repoA, repoB, nonRepo)
  const harness = makeHarness({ config: { selfIntroEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  setSessionCwd(harness, repoA)
  await writeToolInWorkspace(harness, { kind: 'semantic', scopeLevel: 'profile', text: BRANCH_TAGGED_TEXT, branch: true }, repoA)
  await writeToolInWorkspace(harness, { kind: 'semantic', scopeLevel: 'profile', text: BRANCH_PLAIN_TEXT }, repoA)

  // 在 B 上：标签记录被挡，诊断必须能看到「它为什么没进来」
  setSessionCwd(harness, repoB)
  const explain = JSON.parse(String(await harness.tool('memory_explain').execute({ text: '随便一句用于诊断的文本' }))) as Json
  const branch = explain.branch as Json
  assert.ok(branch, 'memory_explain 必须输出 branch 诊断区')
  assert.equal(branch.current, 'main')
  assert.equal(branch.branchAware, true)
  assert.equal(branch.blockedCount, 1)
  assert.match(String(branch.reason), /分支/u)
  assert.match(String(branch.reason), /fail-closed/u)
  const blocked = branch.blocked as Json[]
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0]!.branch, 'feature/x')
  assert.match(String(blocked[0]!.text), /分支专属约定/u)
  assert.ok(!JSON.stringify(branch).includes('跨分支约定'), '被挡清单不得混进无标签记录')

  // 分支未知时同样能看到（否则「我的记忆去哪了」在仓库外无法排查）
  setSessionCwd(harness, nonRepo)
  const outside = JSON.parse(String(await harness.tool('memory_explain').execute({ text: '再诊断一次' }))) as Json
  assert.equal((outside.branch as Json).current, null)
  assert.equal((outside.branch as Json).blockedCount, 1)
  assert.match(String((outside.branch as Json).reason), /unknown/u)

  // 回到标签所在分支：没有被挡下的记录，清单为空
  setSessionCwd(harness, repoA)
  const same = JSON.parse(String(await harness.tool('memory_explain').execute({ text: '同一分支再诊断' }))) as Json
  assert.equal((same.branch as Json).blockedCount, 0)
  assert.equal((same.branch as Json).reason, null)
})

test('host#74 branchAware=false：忽略标签（被挡的记录重新可见），且不写新标签（契约 §2.1/§5）', async (t) => {
  const repoA = makeGitRepo('feature/x')
  const repoB = makeGitRepo('main')
  useTempDirs(t, repoA, repoB)
  const harness = makeHarness({
    config: { branchAware: false, recallMode: 'inject', selfIntroEnabled: false, selfReflectEnabled: false },
  })
  t.after(() => harness.dispose())
  await harness.settle()

  // 直接走服务面种一条带标签的记录：工具在 branchAware=false 下刻意不打标签（见下方断言）
  setSessionCwd(harness, repoA)
  const seeded = await harness.memory().write({
    kind: 'semantic', text: BRANCH_TAGGED_TEXT, scope: { level: 'profile', key: '*' }, branch: 'feature/x', origin: 'user_explicit',
  })
  assert.equal(seeded.ok, true)
  assert.equal(rowsOf(harness).find((row) => row.id === seeded.id)!.branch, 'feature/x')

  // 在 B 下：标签被忽略 → 照常召回、照常进列表与常驻块
  setSessionCwd(harness, repoB)
  const r2 = appendedText(await stepTurnAt(harness, 3, repoB, BRANCH_QUERY))
  assert.match(r2, /分支专属约定/u, 'branchAware=false 时忽略标签，一律注入')
  assert.match(residentText(harness), /分支专属约定/u)
  assert.match(String(await harness.tool('memory_list').execute({ status: 'all' })), /分支专属约定/u)
  const explain = JSON.parse(String(await harness.tool('memory_explain').execute({ text: '诊断' }))) as Json
  assert.equal((explain.branch as Json).branchAware, false)
  assert.equal((explain.branch as Json).blockedCount, 0)

  // 写入侧：关掉过滤时**不打任何标签**（打上去只会在以后开启过滤时静默丢记忆）
  const viaBool = await writeToolInWorkspace(harness, { kind: 'semantic', text: '关闭分支感知时传 true 的写入', branch: true }, repoB)
  assert.equal(viaBool.branch, undefined)
  assert.match(String(viaBool.notice), /branchAware=false/u)
  assert.equal('branch' in rowsOf(harness).find((row) => row.id === viaBool.id)!, false)
  const viaString = await writeToolInWorkspace(harness, { kind: 'semantic', text: '关闭分支感知时指定分支的写入', branch: 'feature/x' }, repoB)
  assert.equal(viaString.branch, undefined)
  assert.equal('branch' in rowsOf(harness).find((row) => row.id === viaString.id)!, false)
})

test('host#75 默认（库内无标签）：仓库（分支 main）与无仓库两种 cwd 下，常驻块与 R2 逐字节相同（契约 §5）', async (t) => {
  const repo = makeGitRepo('main')
  const nonRepo = makeNonRepo()
  useTempDirs(t, repo, nonRepo)
  const collected: string[] = []
  for (const cwd of [repo, nonRepo]) {
    const harness = makeHarness({ config: { recallMode: 'inject', selfIntroEnabled: false, selfReflectEnabled: false } })
    try {
      await harness.settle()
      setSessionCwd(harness, cwd)
      // 两条无标签记录，importance 不同 → 渲染顺序确定（不依赖随机 id）
      await harness.memory().write({ kind: 'user_profile', text: '用户偏好中文回答与英文标识符', importance: 0.9 })
      await harness.memory().write({
        kind: 'semantic', text: '构建流程统一用 pnpm，产物输出到 dist 目录', importance: 0.5, scope: { level: 'profile', key: '*' },
      })
      // 先 R2（常驻渲染会把条目登记进 state.injected，R2 之后会剔除它）
      const r2 = appendedText(await stepTurnAt(harness, 3, cwd, '请继续按构建流程用 pnpm 输出到 dist 目录'))
      const resident = residentText(harness)
      assert.match(r2, /pnpm/u, '前提：R2 确实注入了内容（否则「逐字节相同」可能只是两个空串）')
      assert.match(resident, /构建流程统一用 pnpm/u, '前提：常驻块确实渲染了内容')
      assert.ok(!resident.includes('分支'), `默认渲染不得出现任何分支文案：${resident}`)
      collected.push([r2, resident].join('\n===\n'))
    } finally {
      await harness.dispose()
    }
  }
  assert.equal(collected[0], collected[1], '分支解析（仓库 vs 非仓库）不得改变任何一个字节的注入输出')
})

test('host#76 零 shell：分支解析只读 .git 目录，源码里不得出现任何子进程 / 命令执行（契约 §5）', async () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  for (const banned of ['node:child_process', 'execSync', 'spawnSync', 'execFileSync', 'spawn(']) {
    assert.ok(!source.includes(banned), `分支解析必须是零 shell：不允许出现 ${banned}`)
  }
  // `.git` 是文件（worktree / submodule）时要读 `gitdir:` 再去解析真实 git 目录
  assert.match(source, /gitdir:/iu, 'resolveGitDir 必须处理 `.git` 文件里的 gitdir: 行')
  assert.match(source, /BRANCH_TTL_MS\s*=\s*5000/u, '契约 §4.1：当前分支必须带 5 秒 TTL 缓存')
})

test('host#77 .git 是文件（worktree/submodule）：读 gitdir: 并相对 cwd 解析；坏文件 → 分支未知（契约 §4.1）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-worktree-'))
  useTempDirs(t, root)
  // 「真实」git 目录：HEAD 指向 wt/x（模拟主仓库里的 .git/worktrees/wt1）
  const realGit = join(root, 'main-git', 'worktrees', 'wt1')
  mkdirSync(realGit, { recursive: true })
  writeFileSync(join(realGit, 'HEAD'), 'ref: refs/heads/wt/x\n')
  // worktree A：.git 是文件，gitdir 用绝对路径
  const worktreeAbs = join(root, 'wt-abs')
  mkdirSync(worktreeAbs, { recursive: true })
  writeFileSync(join(worktreeAbs, '.git'), `gitdir: ${realGit}\n`)
  // worktree B：gitdir 用**相对 cwd** 的路径
  const worktreeRel = join(root, 'wt-rel')
  mkdirSync(worktreeRel, { recursive: true })
  writeFileSync(join(worktreeRel, '.git'), 'gitdir: ../main-git/worktrees/wt1\n')
  // 坏 .git 文件（没有 gitdir: 行）→ 必须当分支未知，绝不猜
  const broken = join(root, 'broken')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, '.git'), 'not a gitdir line\n')

  const harness = makeHarness({ config: { recallMode: 'inject', selfIntroEnabled: false, selfReflectEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()

  for (const cwd of [worktreeAbs, worktreeRel]) {
    setSessionCwd(harness, cwd)
    const written = await writeToolInWorkspace(harness, { kind: 'semantic', text: `worktree 专属约定：${cwd} 上的构建流程`, branch: true }, cwd)
    assert.equal(written.branch, 'wt/x', `${cwd} 的 gitdir 必须被解析成真实 git 目录`)
    assert.equal(rowsOf(harness).find((row) => row.id === written.id)!.branch, 'wt/x')
  }

  setSessionCwd(harness, broken)
  const unknown = await writeToolInWorkspace(harness, { kind: 'semantic', text: '坏 .git 文件下的写入', branch: true }, broken)
  assert.equal(unknown.branch, undefined, '读不出 gitdir 时不打标签')
  assert.match(String(unknown.notice), /分支未知/u)
})

test('host#78 当前分支带 5 秒 TTL 缓存：TTL 内不重读，换 cwd 立即失效（契约 §4.1）', async (t) => {
  const repo = makeGitRepo('main')
  const other = makeGitRepo('feat/y')
  useTempDirs(t, repo, other)
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  setSessionCwd(harness, repo)
  const first = await writeToolInWorkspace(harness, { kind: 'semantic', text: '主干缓存探针', branch: true }, repo)
  assert.equal(first.branch, 'main')

  // TTL 内改写**同一个仓库**的 HEAD：解析结果必须仍是缓存值（否则每个 step 都在读盘）
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/switched\n')
  const cached = await writeToolInWorkspace(harness, { kind: 'semantic', text: 'TTL 内的第二次写入', branch: true }, repo)
  assert.equal(cached.branch, 'main', '5 秒 TTL 内不得重新读盘')

  // 换 cwd（另一个仓库）立即失效：缓存只有一条、按 cwd 记账
  setSessionCwd(harness, other)
  const otherWrite = await writeToolInWorkspace(harness, { kind: 'semantic', text: '另一个仓库的写入', branch: true }, other)
  assert.equal(otherWrite.branch, 'feat/y')

  // 切回被改写 HEAD 的仓库：缓存已被别的 cwd 顶掉 → 这次必须读到新分支
  setSessionCwd(harness, repo)
  const reread = await writeToolInWorkspace(harness, { kind: 'semantic', text: '切回后的写入', branch: true }, repo)
  assert.equal(reread.branch, 'switched')
})

// ================================================================ M13 写入审计与注入核对（`/memory audit`）
// 契约：docs/audit.md 第 3/4/5 节。宿主侧四件事：各写入路径推尝试事件（异常一律吞掉）、
// `/memory audit [--limit N] [--verify]` 的**只读**渲染、`/memory stats` 的最小摘要、
// 以及 `auditMax` 的 Schema 行（volatile）。这里用 `state.audit`（经自报告）与命令输出双向钉死。

const SECRET_TEXT = '这台机器的部署密钥是 sk-abcdefghijklmnop123456，请记住'

test('host#79 审计：成功创建 / 合并 / 忘记 / 被拒各推一条尝试（state.audit + 输出）', async (t) => {
  const harness = makeHarness()
  t.after(() => harness.dispose())
  await harness.settle()

  const created = await harness.memory().write({ kind: 'user_profile', text: '审计探针：用户偏好中文回答与英文标识符', origin: 'user_explicit' })
  assert.equal(created.ok, true)
  assert.equal(created.status, 'created')

  // 同一指纹的第二次写入必须走合并（不是新建）——两个动作各推一条，不能混为一谈。
  const merged = await harness.memory().write({ kind: 'user_profile', text: '审计探针：用户偏好中文回答与英文标识符', origin: 'user_explicit' })
  assert.equal(merged.ok, true)
  assert.equal(merged.status, 'merged', '前置条件：第二次同一指纹写入必须合并')

  assert.equal((await harness.runCommand(`forget ${String(created.id).slice(0, 8)}`)).kind, 'success')

  const rejected = await writeTool(harness, { kind: 'user_profile', text: SECRET_TEXT })
  assert.equal(rejected.ok, false, '前置条件：敏感文本必须被拒')

  const audit = harness.reportState().audit as Json
  const actions = audit.actions as Json
  assert.equal(Number(audit.entries), 4, '四次尝试各一条（created / merged / forgotten / rejected）')
  assert.equal(Number(actions.created), 1)
  assert.equal(Number(actions.merged), 1)
  assert.equal(Number(actions.forgotten), 1)
  assert.equal(Number(actions.rejected), 1)

  // 环是**新在前**：最近一条就是刚被拒的那次；被拒的尝试没有记录，id/via 必须是 null（不得编造）
  const last = audit.last as Json
  assert.equal(last.action, 'rejected')
  assert.equal(last.reason, 'rejected_sensitive', 'reason 取既有错误码，便于与工具返回值对号')
  assert.equal(last.kind, 'user_profile')
  assert.equal(last.id, null)
  assert.equal(last.via, null, '没有记录 → refs 取不到 → via 必须是 null')
  assert.equal(typeof last.at, 'number')

  // 命令输出：最近尝试清单 + 原因 + 无 via 的占位符；忘记事件带被删记录的 id 前缀
  const out = await harness.runCommand('audit')
  assert.equal(out.kind, 'success', out.text)
  assert.match(out.text, /最近尝试（新在前/u)
  assert.match(out.text, /原因：rejected_sensitive/u)
  assert.match(out.text, /via=（无）/u)
  assert.match(out.text, new RegExp(String(created.id).slice(0, 8), 'u'), 'forgotten 的 id 前缀要能对上')
})

test('host#80 审计：入队 / 批准 / 拒绝待确认各推一条；/memory audit 渲染含最近尝试与库内汇总', async (t) => {
  const harness = makeHarness({ config: { writePolicy: 'ask' } })
  t.after(() => harness.dispose())
  await harness.settle()

  const first = await writeTool(harness, { kind: 'semantic', text: '审计探针：构建统一用 bun，产物落在 build 目录' })
  const second = await writeTool(harness, { kind: 'semantic', text: '审计探针：发布统一走 npm publish，先跑一遍完整测试' })
  assert.equal(first.pending, true)
  assert.equal(second.pending, true)
  // 用**完整 id**：同一毫秒创建的两条记录前 8 位会撞前缀，前缀会命中多条（既有测试也有同样的告示）
  assert.equal((await harness.runCommand(`approve ${String(first.id)}`)).kind, 'success')
  assert.equal((await harness.runCommand(`reject-pending ${String(second.id)}`)).kind, 'success')

  const audit = harness.reportState().audit as Json
  const actions = audit.actions as Json
  assert.equal(Number(actions.pending), 2, '两次入队各一条')
  assert.equal(Number(actions.approved), 1)
  assert.equal(Number(actions['rejected-pending']), 1)
  assert.equal(Number(actions.created), 0, '入队不是创建（没有落盘的 active 记录）')

  const out = await harness.runCommand('audit')
  assert.equal(out.kind, 'success', out.text)
  assert.match(out.text, /最近尝试（新在前/u)
  assert.match(
    out.text,
    /按 action 计数：created 0 · merged 0 · pending 2 · approved 1 · rejected-pending 1 · rejected 0 · invalidated 0 · archived 0 · forgotten 0/u,
  )
  // 库内汇总来自**记录本身**（不是尝试环）：批准的 active 1 条 + 拒绝的 invalid 1 条
  assert.match(out.text, /库内状态：共 2 条 · active 1 · pending 0 · archived 0 · invalid 1（当前分支：unknown）/u)
  assert.match(out.text, /来源引用：带 refs 的 0 条（占 0%）/u)
  assert.match(out.text, /--verify：未做核对/u, '没跑 --verify 时必须说「未做核对」，不能渲染成通过')

  // 命令只读：连跑一次之后，记录与整份自报告（含所有计数器）必须一字不动
  const rowsBefore = JSON.stringify(harness.memory().list())
  const reportBefore = JSON.stringify(harness.reportState())
  await harness.runCommand('audit')
  assert.equal(JSON.stringify(harness.memory().list()), rowsBefore, 'audit 只读：记录一字不动')
  assert.equal(JSON.stringify(harness.reportState()), reportBefore, 'audit 只读：状态与计数器一字不动')

  // help 与 input.hint 同步（与其它子命令同一口径）
  assert.match((await harness.runCommand('help')).text, /audit \[--limit N\] \[--verify\]/u)
  const hint = String((harness.command() as unknown as { input?: { hint?: string } }).input?.hint ?? '')
  assert.match(hint, /audit/u, '命令的 input.hint 也要提到 audit')

  // 契约 §3.3：`/memory stats` 与 `memory_stats` 的最小摘要（最近尝试条数、核对未命中次数）
  const stats = await harness.runCommand('stats')
  assert.match(stats.text, /审计：最近尝试 4 条（记录档 2 条）；核对未命中 0 次（详见 \/memory audit）/u)
  const raw = JSON.parse(String(await harness.tool('memory_stats').execute({}))) as Json
  const auditField = raw.audit as Json
  assert.ok(auditField, 'memory_stats 必须带结构化的 audit 字段')
  assert.equal(Number(auditField.entries), 4)
  assert.equal(Number(auditField.records), 2)
  assert.equal(Number(auditField.mismatchChecks), 0)
  assert.equal(Number(auditField.auditMax), 50, '结构化字段里的容量与默认值一致')
  assert.match(String(raw.text), /审计：最近尝试 4 条/u, '工具文本与 /memory stats 同步')
})

test('host#81 /memory audit --limit：默认 20、上限 200、非法值回落默认', async (t) => {
  // 环容量调大，才能真正验证 `--limit` 的 200 上限（默认 auditMax=50 会先截断环）。
  const harness = makeHarness({ noReport: true, config: { auditMax: 300 } })
  t.after(() => harness.dispose())
  await harness.settle()

  for (let index = 0; index < 205; index += 1) {
    const result = await writeTool(harness, { kind: 'user_profile', text: `第 ${index} 条：${SECRET_TEXT}` })
    assert.equal(result.ok, false, `第 ${index} 条写入必须被拒（用来填满尝试环）`)
  }
  const entryLines = (text: string): number => text.split('\n').filter((line) => line.startsWith('  - ')).length

  const byDefault = await harness.runCommand('audit')
  assert.match(byDefault.text, /内存尝试环 20 条/u, '默认渲染最近 20 条')
  assert.equal(entryLines(byDefault.text), 20, '渲染的条目行数必须等于 limit')

  const byShort = await harness.runCommand('audit --limit 5')
  assert.match(byShort.text, /内存尝试环 5 条/u)
  assert.equal(entryLines(byShort.text), 5)

  const byInline = await harness.runCommand('audit --limit=7')
  assert.match(byInline.text, /内存尝试环 7 条/u, '--limit=N 与 --limit N 等价')

  const byInvalid = await harness.runCommand('audit --limit abc')
  assert.match(byInvalid.text, /内存尝试环 20 条/u, '非法值回落默认 20')

  const byZero = await harness.runCommand('audit --limit 0')
  assert.match(byZero.text, /内存尝试环 20 条/u, '0 不是合法条数，回落默认')

  const byBig = await harness.runCommand('audit --limit 500')
  assert.match(byBig.text, /内存尝试环 200 条/u, '上限 200（环里有 205 条）')

  // 两个开关可以叠加：`--limit` 后面紧跟另一个开关时不得把它吞掉
  const both = await harness.runCommand('audit --limit --verify')
  assert.match(both.text, /内存尝试环 20 条/u)
  assert.match(both.text, /--verify：/u, '--limit 后面的 --verify 必须仍然生效')
})

test('host#82 /memory audit --verify：有 sessionQuery 时给出 checked/matched/missing，且完全只读', async (t) => {
  const spec: FakeSessionSpec = { id: 'session-1', cwd: WORKSPACE_CWD, createdAt: 1_000, events: [] }
  const fake = makeFakeSessionQuery([spec])
  const harness = makeHarness({
    sessionQuery: fake.query,
    config: { selfIntroEnabled: false, selfReflectEnabled: false },
  })
  t.after(() => harness.dispose())
  await harness.settle()

  // 会话身份（readSession 的目标）+ 日志里至少一条 user/message（缺口判定的前提）
  emitSeqEvent(harness, refsSession(), seqUserEvent('先推进 seq。', 5))
  const contextOf = (): string => String(harness.contexts[0]!.text({ agent: { session: { header: { cwd: WORKSPACE_CWD } } } }))
  const sectionOf = (): string => String(harness.sections[0]!.text())

  await writeToolInWorkspace(harness, { kind: 'semantic', text: '构建流程统一用 pnpm，产物输出到 dist 目录', subject: 'build.tool' }, WORKSPACE_CWD)
  await writeToolInWorkspace(harness, { kind: 'semantic', text: '发布流程统一走 npm publish，先跑一遍完整测试', subject: 'deploy.flow' }, WORKSPACE_CWD)
  const rendered = contextOf()
  const section = sectionOf()
  assert.match(rendered, /构建流程统一用 pnpm/u, '前提：注入块确实渲染了这两条')

  // 「模型可见 ⟺ 已记录」：把刚落盘的注入快照逐字写进会话日志（user/message 事件）
  spec.events.push(seqUserEvent(`${section}\n${rendered}`, 6))

  const rowsBefore = JSON.parse(JSON.stringify(harness.memory().list())) as Json[]
  const reportBefore = JSON.parse(JSON.stringify(harness.reportState())) as Json
  const verified = await harness.runCommand('audit --verify')
  assert.equal(verified.kind, 'success', verified.text)
  const matched = /--verify：核对 (\d+) 行 · 命中 (\d+) 行 · 缺失 (\d+) 行/u.exec(verified.text)
  assert.ok(matched, `必须给出核对结论：${verified.text}`)
  const checked = Number(matched[1])
  assert.ok(checked >= 2, `注入行至少两条（实际 ${checked}）`)
  assert.equal(Number(matched[2]), checked, '日志逐字包含全部注入行 → 应全命中')
  assert.equal(Number(matched[3]), 0)
  assert.match(verified.text, /逐字核对通过/u)
  assert.match(verified.text, /via=tool/u, 'created 事件的 via 来自记录 refs（工具写入 → tool）')
  assert.ok(fake.read.includes('session-1'), '--verify 必须读当前会话的日志')

  // **只读**：记录快照与整份自报告（写入计数、refs 计数…）都必须逐字节相同
  assert.deepEqual(JSON.parse(JSON.stringify(harness.memory().list())), rowsBefore, '审计只读：记录快照必须逐字节相同')
  assert.deepEqual(JSON.parse(JSON.stringify(harness.reportState())), reportBefore, '审计只读：状态与计数器必须逐字节相同')
  assert.match((await harness.runCommand('stats')).text, /核对未命中 0 次/u, '--verify 不得推任何计数器')
  assert.match((await harness.runCommand('stats')).text, /审计：最近尝试 2 条（记录档 2 条）/u)

  // 缺失路径：注入之后又新增一条（日志里没有它）→ missing=1，并给出一条未命中样例
  await writeToolInWorkspace(harness, { kind: 'semantic', text: '审计核对探针：这条在注入之后才写入，日志里没有它', subject: 'audit.probe' }, WORKSPACE_CWD)
  assert.match(contextOf(), /审计核对探针/u, '前提：新条目确实进了注入行')
  const missing = await harness.runCommand('audit --verify')
  const missingMatch = /--verify：核对 (\d+) 行 · 命中 (\d+) 行 · 缺失 (\d+) 行/u.exec(missing.text)
  assert.ok(missingMatch, missing.text)
  assert.equal(Number(missingMatch[1]), checked + 1)
  assert.equal(Number(missingMatch[2]), checked)
  assert.equal(Number(missingMatch[3]), 1, `只有那条新增的注入行不在日志里：${missing.text}`)
  assert.match(missing.text, /未命中样例：- \(workspace\) 审计核对探针/u, '必须给出一条未命中的样例（逐字语义）')
})

test('host#83 /memory audit --verify：三种缺口都明说原因（无服务 / 会话 id 未知 / 无 user 事件）', async (t) => {
  // ① 宿主没有 sessionQuery 服务
  const noService = makeHarness()
  t.after(() => noService.dispose())
  await noService.settle()
  emitSeqEvent(noService, refsSession(), seqUserEvent('先推进 seq。', 5))
  await writeToolInWorkspace(noService, { kind: 'semantic', text: '缺口探针：没有 sessionQuery 时的注入行', subject: 'gap.a' }, WORKSPACE_CWD)
  String(noService.contexts[0]!.text({ agent: { session: { header: { cwd: WORKSPACE_CWD } } } }))
  const noServiceOut = await noService.runCommand('audit --verify')
  assert.equal(noServiceOut.kind, 'success', noServiceOut.text)
  assert.match(noServiceOut.text, /--verify：无法核对 —— 原因：/u)
  assert.match(noServiceOut.text, /sessionQuery/u, '必须点名缺的是哪个服务')
  assert.doesNotMatch(noServiceOut.text, /逐字核对通过/u, '缺口绝不能渲染成通过')
  assert.doesNotMatch(noServiceOut.text, /--verify：核对 \d/u, '缺口不是「核对 0 行」')

  // ② 有 sessionQuery，但本会话还没有任何 session/event → 当前会话 id 未知
  const known = makeFakeSessionQuery([{ id: 'session-1', cwd: WORKSPACE_CWD, createdAt: 1_000, events: [seqUserEvent('这一条在日志里。', 1)] }])
  const unknown = makeHarness({ sessionQuery: known.query })
  t.after(() => unknown.dispose())
  await unknown.settle()
  await writeToolInWorkspace(unknown, { kind: 'semantic', text: '缺口探针：会话 id 未知时的注入行', subject: 'gap.b' }, WORKSPACE_CWD)
  String(unknown.contexts[0]!.text({ agent: { session: { header: { cwd: WORKSPACE_CWD } } } }))
  const unknownOut = await unknown.runCommand('audit --verify')
  assert.match(unknownOut.text, /无法核对 —— 原因：.*会话 id 未知/u)
  assert.equal(known.read.length, 0, '会话 id 未知时不得猜一个 id 去读日志')

  // ③ 会话 id 已知、日志也读到了，但日志里没有任何 user/message 事件
  const assistantOnly = makeFakeSessionQuery([
    { id: 'session-1', cwd: WORKSPACE_CWD, createdAt: 1_000, events: [sleepAssistantEvent('日志里只有助手消息。', 2)] },
  ])
  const noUser = makeHarness({ sessionQuery: assistantOnly.query })
  t.after(() => noUser.dispose())
  await noUser.settle()
  emitSeqEvent(noUser, refsSession(), seqUserEvent('先推进 seq。', 5))
  String(noUser.contexts[0]!.text({ agent: { session: { header: { cwd: WORKSPACE_CWD } } } }))
  const noUserOut = await noUser.runCommand('audit --verify')
  assert.match(noUserOut.text, /无法核对 —— 原因：.*没有任何 user\/message 事件/u)
  assert.ok(assistantOnly.read.includes('session-1'), '会话 id 已知时必须真的去读日志')
})

test('host#84 auditMax=0：不记录任何尝试，命令仍可用；volatile 形态照常解包与裁剪', async (t) => {
  const off = makeHarness({ config: { auditMax: 0 } })
  t.after(() => off.dispose())
  await off.settle()

  const created = await off.memory().write({ kind: 'user_profile', text: '审计环关闭时的正常写入', origin: 'user_explicit' })
  assert.equal(created.ok, true, '审计关不改变写入结果')
  const rejected = await writeTool(off, { kind: 'user_profile', text: SECRET_TEXT })
  assert.equal(rejected.ok, false, '审计关不改变拒写结果')

  const audit = off.reportState().audit as Json
  assert.equal(Number(audit.entries), 0, 'auditMax=0 → 一条尝试都不记录')
  assert.equal(Number(audit.capacity), 0)
  const out = await off.runCommand('audit')
  assert.equal(out.kind, 'success', '环关闭时命令仍必须可用')
  assert.match(out.text, /最近尝试：本轮没有记录到被拒或入队的尝试/u)
  assert.match(out.text, /auditMax=0：审计环关闭/u, '必须明说环是关的，别让人以为「什么都没发生」')
  assert.match(out.text, /库内状态：共 1 条 · active 1/u, '记录派生汇总与环无关，仍然可用')

  // volatile 形态（运行版把 volatile 字段以访问器下发）+ 容量裁剪：3 条尝试只留最近 2 条
  const vol = makeHarness({ config: { auditMax: volatile(2) } })
  t.after(() => vol.dispose())
  await vol.settle()
  for (let index = 0; index < 3; index += 1) {
    const result = await writeTool(vol, { kind: 'user_profile', text: `第 ${index} 条：${SECRET_TEXT}` })
    assert.equal(result.ok, false)
  }
  const volAudit = vol.reportState().audit as Json
  assert.equal(Number(volAudit.capacity), 2, 'volatile 形态必须解包成 2')
  assert.equal(Number(volAudit.entries), 2, '环容量 2 → 只保留最近两条')
  assert.match((await vol.runCommand('audit')).text, /内存尝试环 2 条 · 容量 2/u)
})

test('host#85 审计推事件抛异常：写入 / 入队 / 批准 / 删除 / 拒写主流程全部照常', async (t) => {
  const harness = makeHarness({ config: { simulateAuditError: true, writePolicy: 'ask' } })
  t.after(() => harness.dispose())
  await harness.settle()

  const created = await harness.memory().write({ kind: 'user_profile', text: '审计故障注入下的正常写入', origin: 'user_explicit' })
  assert.equal(created.ok, true, '审计抛异常不得影响写入成功')
  assert.equal(created.status, 'created')
  assert.equal(harness.memory().list().length, 1, '记录确实落库了')

  const queued = await writeTool(harness, { kind: 'semantic', text: '审计故障注入下的模型猜想' })
  assert.equal(queued.pending, true, '入队路径照常')
  assert.equal((await harness.runCommand(`approve ${String(queued.id).slice(0, 8)}`)).kind, 'success', '批准路径照常')
  assert.equal((await harness.runCommand(`forget ${String(created.id).slice(0, 8)}`)).kind, 'success', '删除路径照常')
  const rejected = await writeTool(harness, { kind: 'user_profile', text: SECRET_TEXT })
  assert.equal(rejected.ok, false, '拒写路径照常')
  assert.match(String(rejected.error), /rejected_sensitive/u, '错误码不变')

  // 每一次推入都被吞掉（环始终为空），而计数器照常推进 —— 审计失败只是少一条观测
  const state = harness.reportState()
  assert.equal(Number((state.audit as Json).entries), 0, '审计异常被吞掉：环为空')
  const writes = state.writes as Json
  assert.equal(Number(writes.created), 1)
  assert.equal(Number(writes.pending), 1)
  assert.equal(Number(writes.approved), 1)
  assert.equal(Number(writes.deleted), 1)
  assert.equal(Number(writes.rejected), 1)
  const out = await harness.runCommand('audit')
  assert.equal(out.kind, 'success', '审计异常不影响命令可用')
  assert.match(out.text, /最近尝试：本轮没有记录到被拒或入队的尝试/u)
})

test('host#86 配置 Schema：auditMax 默认 50 且标 volatile（无 schemastery 时跳过）', async () => {
  if (Config === undefined) {
    assert.equal(Config, undefined)
    return
  }
  const dict = (Config as { dict?: Record<string, { meta?: { default?: unknown; volatile?: unknown } }> }).dict ?? {}
  const entry = dict.auditMax
  assert.ok(entry, 'Schema 必须声明 auditMax')
  assert.equal(entry.meta?.default, 50, '默认值必须与契约 §2.1 一致')
  assert.equal(entry.meta?.volatile, true, 'auditMax 必须标 volatile，否则设置页看不到/存不下它')
})

test('host#87 审计：整合的失效与归档各推一条（invalidated / archived）', async (t) => {
  // 先造一条「180 天前、重要度极低」的记录：写路径只能给当下时间戳，因此用 seedDomainRows 播种旧记录。
  const seedHarness = makeHarness()
  t.after(() => seedHarness.dispose())
  await seedHarness.settle()
  const aged = await seedHarness.memory().write({
    kind: 'semantic', text: '一年前的旧约定：这条早已衰减到该归档的程度。', origin: 'observed', importance: 0.05, subject: 'legacy.decay',
  })
  assert.equal(aged.ok, true)
  const staleRow = [...seedHarness.domain.rows.values()][0]!
  staleRow.observedAt = Date.now() - 400 * 86_400_000
  delete staleRow.lastUsedAt
  const seeded = new Map<string, Json>([[String(staleRow.id), staleRow]])

  const harness = makeHarness({ seedDomainRows: seeded, config: { consolidateEnabled: false } })
  t.after(() => harness.dispose())
  await harness.settle()
  assert.equal(harness.memory().list().length, 1, '前置条件：旧记录已从盘上加载')

  // 同槽位（kind|scope|subject|field）、不同 value、文本不相近 → 整合判为冲突 → 失效较旧的一条
  const file = join(harness.tempDir, 'conflicts.json')
  writeFileSync(file, JSON.stringify({
    items: [
      { kind: 'semantic', subject: 'conflict.slot', field: 'mode', value: 'a', text: '构建流程走 gulp 并且产物落在 out 目录。' },
      { kind: 'semantic', subject: 'conflict.slot', field: 'mode', value: 'b', text: '数据库迁移统一用 goose，连接串从环境变量读。' },
    ],
  }))
  assert.equal((await harness.runCommand(`import ${file}`)).kind, 'success')

  const consolidated = await harness.runCommand('consolidate')
  assert.equal(consolidated.kind, 'success', consolidated.text)
  assert.match(consolidated.text, /冲突失效 1/u, `前提：确实发生了一次冲突失效：${consolidated.text}`)
  assert.match(consolidated.text, /归档 1/u, `前提：确实发生了一次衰减归档：${consolidated.text}`)

  const audit = harness.reportState().audit as Json
  const actions = audit.actions as Json
  assert.equal(Number(actions.invalidated), 1, '整合的失效要推 invalidated')
  assert.equal(Number(actions.archived), 1, '整合的归档要推 archived')

  const out = await harness.runCommand('audit')
  assert.match(out.text, /invalidated 1/u)
  assert.match(out.text, /archived 1/u)
  assert.match(out.text, /库内状态：共 3 条 · active 1 · pending 0 · archived 1 · invalid 1/u)
})



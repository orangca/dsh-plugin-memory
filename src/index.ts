// dsh-memory — 个性化长期记忆插件
//
// 当前版本：M1（显式读写）
//   M0 已有：领域 dsh_memory、双通道注入、/memory 只读命令
//   M1 新增：memory_write / memory_recall / memory_list / memory_forget 四个工具，
//            /memory 治理子命令（forget/restore/pin/archive/export），
//            写入来源判定（user_explicit vs model_proposed）、hash 去重合并、
//            敏感信息拒写、turn-stopping 触发探测。
//
// 设计依据：dsh-memory-plugin-plan.md、dsh-memory-plugin-design-detail.md。
// 约束（M-1 spike 实测）：零外部 import（鸭子类型域 schema + 原生 JSON Schema 工具）；
// 只 inject 确定存在的服务；所有渲染/工具路径不得抛异常影响主流程。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import type {
  DshAgent,
  DshCommandResult,
  DshDomain,
  DshPluginContext,
  DshSession,
  DshSettings,
  DshStorageDomain,
  DshToolDefinition,
  DshTurnStoppingPayload,
  MemoryConfig,
  MemoryKind,
  MemoryOrigin,
  MemoryPrecision,
  MemoryRecord,
  MemoryScope,
  MemorySource,
  RecallOptions,
  ScopeLevel,
} from './types.js'
import {
  DEFAULTS,
  clampText,
  composeGistText,
  composeSubjectSummary,
  compareRecords,
  defaultScopeFor,
  deriveSubject,
  detectWorkspaceMarkers,
  deriveOriginFromMessages,
  effectiveImportance,
  estimateTokens,
  extractCandidates,
  extractSummaryText,
  facetOf,
  fillWithinBudget,
  findConflicts,
  fnv1a,
  isEcho,
  isExcluded,
  listActive,
  makeRecord,
  maskPii,
  normalizeFacet,
  pickMergeGroups,
  planPortraitUpdate,
  portraitHistory,
  portraitSubjectFor,
  recallRecords,
  recordHash,
  REFLECT_NOTICE,
  renderContextBlock,
  renderSelfBlock,
  scanSensitive,
  shouldArchive,
  shouldReflect,
  splitSentences,
  workspaceKeyOf,
} from './lib.js'
// 自画像 v2（M6-A）新增的纯函数与类型：签名冻结在 docs/self-portrait.md 第 3 节。
// 类型用 `import type` 引入（verbatimModuleSyntax）：它们只参与编译期检查，运行期不存在。
import type { PortraitAction, PortraitCandidate, PortraitDecision, SelfFacet } from './lib.js'

// 设置页表单需要 schemastery（DSH 用它把 Config 投影成表单）。但它对第三方包是**可选**的：
// profile 的 pnpm 配置是 autoInstallPeers: false，能否解析取决于宿主 loader 的 peer 映射。
// 因此用动态 import + 顶层 await：解析不到就退化为「没有表单」，绝不让插件加载失败。
type SchemaFactory = (typeof import('@deepseek-ai/schemastery'))['default']

let Schema: SchemaFactory | null = null
try {
  Schema = (await import('@deepseek-ai/schemastery')).default ?? null
} catch {
  Schema = null
}

// ---------------------------------------------------------------- 本地结构类型
//
// 下面这些接缝 types.ts 只声明了「本插件实际调用到的那一小块」，而运行版宿主比发布版多出
// 一些成员（settings 作用域属性、ctx.provide、工具 execute 的第二实参、事件载荷的具体字段）。
// 按实测运行契约在这里补最小结构视图，避免 any 逃逸。

/** `ctx.inject(['settings'], cb)` 的回调实参：被注入的服务会作为属性挂上来。 */
interface DshSettingsScope extends DshPluginContext {
  settings: DshSettings
}

/** `ctx.provide(name, service)` 是运行版宿主提供的可选接缝，types.ts 未声明。 */
interface DshPluginContextWithProvide extends DshPluginContext {
  provide(name: string, service: unknown): unknown
}

/** 工具 execute 的会话视图：运行版多一个 `deriveMessages()`。 */
interface DshToolSession extends DshSession {
  deriveMessages?: () => unknown
}

/** 工具 execute 的第二实参（types.ts 的 DshToolDefinition 只声明了 args）。 */
interface DshToolExecContext {
  agent?: { session?: DshToolSession }
}

/** 工具定义：`execute` 多接一个可选 `exec`，运行时由宿主传入。 */
interface MemoryToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec?: DshToolExecContext) => Promise<unknown> | unknown
}

/** `session/event` 的载荷视图（types.ts 只声明了 type，其余按实测契约取用）。 */
interface DshSessionEventData {
  source?: { kind?: string } | null
  content?: unknown
  message?: { content?: unknown } | null
  name?: unknown
  arguments?: unknown
  summary?: unknown
  shadowedSeqs?: unknown
}

interface DshSessionEvent {
  type?: string
  data?: DshSessionEventData
  seq?: unknown
}

/** `agent/pre-step` 的载荷与决策视图。 */
interface DshPreStepPayload {
  turn?: unknown
  signal?: { aborted?: boolean } | null
  agent?: { session?: DshSession }
}

interface DshPreStepDecision {
  kind?: unknown
  messages?: unknown[]
  [key: string]: unknown
}

/** `memory_write` 的实参视图（JSON Schema 已约束形状，这里只做一次结构化收窄）。 */
interface MemoryWriteArgs {
  kind?: MemoryKind
  text?: string
  subject?: string | null
  field?: string | null
  value?: string | null
  tags?: string[]
  scopeLevel?: ScopeLevel
  importance?: number
  pinned?: boolean
  /** 仅 `kind === 'agent_self'` 有意义：'persona' | 'work'，缺省按 'work'（存量兼容）。 */
  facet?: string
}

interface MemoryRecallArgs {
  query?: string
  kind?: MemoryKind
  scopeLevel?: ScopeLevel
  tag?: string
  limit?: number
}

interface MemoryListArgs {
  kind?: MemoryKind
  status?: MemoryStatus
  limit?: number
}

interface MemoryForgetArgs {
  id?: string
  query?: string
  confirm?: boolean
}

interface MemoryExplainArgs {
  text?: string
  apply?: boolean
}

/** `MemoryStatus` + 命令层的 `all`（`/memory list --archived` 与 memory_list 共用）。 */
type MemoryStatus = MemoryRecord['status'] | 'all'

// ---------------------------------------------------------------- 内部状态

interface MemoryWrites {
  created: number
  merged: number
  rejected: number
  deleted: number
}

interface MemoryRenders {
  context: number
  section: number
}

interface RenderMs {
  last: number
  max: number
}

interface InjectedLines {
  context: string[]
  section: string[]
}

interface TurnStoppingState {
  plain: number
  last: { channel: string; at: string } | null
}

interface CaptureLast {
  at: string
  ms?: number
  error?: string
}

interface CaptureState {
  turns: number
  written: number
  skipped: Record<string, number>
  last: CaptureLast | null
  hourWindow: number[]
  lastWriteByHash: Map<string, number>
  gistRefreshed: number
}

interface ConsolidateSummary {
  at: string
  reason: string
  merged: number
  archived: number
  invalidated: number
  summarized: number
  usageFlushed?: number
  ms?: number
  error?: string
}

interface ConsolidateState {
  runs: number
  merged: number
  archived: number
  invalidated: number
  summarized: number
  solidified: number
  skipped: number
  last: ConsolidateSummary | null
}

interface RecallLast {
  at: string
  turn?: number
  queryChars?: number
  hits?: number
  skipped?: string
  mode?: string
  ms?: number
  error?: string
  budgetSkipped?: number
  droppedByBudget?: number
  tokens?: number
  preview?: string
  detail?: Array<{ id: string; match: number; score: number }>
}

interface RecallState {
  injected: number
  turns: number
  last: RecallLast | null
}

/**
 * 领域 global 句柄：types.ts 只声明了 `get()` / `put()`，而运行版（以及原实现）的写入口叫 `set()`。
 * 保留原调用名，这里按实测契约补上（见交付报告）。
 */
type DshDomainGlobal = DshDomain['global'] & { set(value: unknown): Promise<void> | void }

/** 领域 global 水位（`domain.global.get()/set()`）。 */
interface MemoryMeta {
  schemaVersion?: number
  collectionVersion?: number
  lastConsolidatedAt?: number
}

interface BudgetCheck {
  chars: number
  estimated: number
  meterTokens: number | null
  meterError: string | null
  at: string
}

interface TurnBuffer {
  user: string[]
  assistant: string[]
  tools: string[]
  lastAt: number
  closedAt: number
}

/**
 * 自画像 v2 在 `MemoryRecord` 上新增的字段（契约 2.1）。
 * `supersedes` 是既有必需字段，这里只补两个可选项；把它们单列成视图类型，
 * 是为了让宿主代码在 lib/types 的落地过程中都能稳定读写（运行期就是同一条记录）。
 */
interface PortraitRecordFields {
  facet?: SelfFacet
  supersededBy?: string
}

type PortraitRecord = MemoryRecord & PortraitRecordFields

/** 记录的自画像视图（不做拷贝：字段就是记录自身的字段）。 */
const asPortrait = (record: MemoryRecord): PortraitRecord => record as PortraitRecord

/**
 * 自画像写入收敛的结果（进工具返回值，让模型/用户看得见「这次写入发生了什么」）。
 * `action` 是契约第 3 节的五种决策；`reason` 是可读原因（如 'user-owned'、'too-short'）。
 */
interface PortraitOutcome {
  action: PortraitAction
  reason: string
  facet: SelfFacet
  subject: string
  /** 被 reinforce/refine/supersede 命中的既有条目 id；add/skip 时为 null。 */
  targetId: string | null
}

/** 一次自画像写入的完整规划：候选 + 决策 + 对外的结果视图。 */
interface PortraitPlan {
  candidate: PortraitCandidate
  decision: PortraitDecision
  outcome: PortraitOutcome
}

/**
 * 自画像在宿主侧的运行时状态（`state.self`，由 `memory_stats` 暴露）。
 *
 * 计数四个动作：add → added；reinforce/refine → refined（都不新建条目）；
 * supersede → superseded（新建 + 旧条目归档）；skip → skipped（不写盘）。
 * 反思提示的会话状态也放在这里：会话切换时整组重置。
 */
interface SelfState {
  added: number
  refined: number
  superseded: number
  skipped: number
  /** 本会话上一次反思提醒的回合号；从未提醒过为 null。 */
  lastReflectTurn: number | null
  /** 本会话已提醒次数。 */
  reflections: number
  /** 本会话已提醒的回合号（只保留最近一批，避免无界增长）。 */
  reflectTurns: number[]
  /** 反思闸门用的会话身份：id 变化即视为新会话。 */
  sessionId: string
  /** 本会话已进行的回合数（由 pre-step 的回合号推进，单调不减）。 */
  sessionTurns: number
  /** 最近一次自画像/反思路径的异常文本（诊断用，绝不影响主流程）。 */
  lastError: string | null
}

/** apply 期间的内部状态：字段名与运行时结构一一对应（openErrorDetail 只在使用时才出现）。 */
interface PluginState {
  opened: boolean
  openError: string | null
  openErrorDetail?: Record<string, unknown> | null
  records: Map<string, MemoryRecord>
  collectionVersion: number
  seeded: number
  writes: MemoryWrites
  renders: MemoryRenders
  renderMs: RenderMs
  injected: InjectedLines
  turnStopping: TurnStoppingState
  toolCalls: Record<string, number>
  // M2 自动捕获
  capture: CaptureState
  consolidate: ConsolidateState
  consolidating: boolean
  /**
   * 捕获重入锁。`agent/turn-stopping` 用 `Promise.race([runCapture, 超时])` 只保证「按时返回」，
   * 被超时的那次仍在后台写库 —— 没有这个锁，下一个回合会与它并发改同一批
   * `state.records` / `state.capture.*`（`consolidate` 早已有同类锁）。
   */
  capturing: boolean
  rejectedHashes: Set<string>
  recall: RecallState
  recallTurnById: Map<string, number>
  /** M6：自画像 v2 的运行时状态（写入收敛计数 + 反思提示的会话闸门状态）。 */
  self: SelfState
  // 用量：注入/召回只在内存累加（每次写盘会产生大量 IO），由整合或卸载时统一落盘。
  usageDirty: Set<string>
  injectedIds: InjectedLines
  settingsPage: string
  settingsDetail: Record<string, unknown> | null
  meta: MemoryMeta | null
  lastSession: { id: string; cwd: string | null }
  budget: BudgetCheck | null
  turnBuffer: TurnBuffer
  recentEvents: Array<string | undefined>
}

/** 自报告文档（写盘给开发期诊断用）。 */
interface SelfReport {
  plugin: string
  stage: string
  revision: number | null
  startedAt: string
  domain: string
  volatileKeys: string[]
  state?: Record<string, unknown>
}

/** `writeMemory` 的入参：工具、捕获、导入三条路径共用。 */
interface WriteMemoryInput {
  kind?: MemoryKind
  text?: unknown
  precision?: MemoryPrecision
  origin?: MemoryOrigin
  scope?: MemoryScope
  subject?: string | null
  field?: string | null
  value?: string | null
  tags?: string[]
  source?: MemorySource | null
  confidence?: number
  importance?: number
  pinned?: boolean
  sessionId?: string
  /**
   * 自画像面（契约 2.1/4.1）：**只有显式提供时**才让这次 `agent_self` 写入走
   * `planPortraitUpdate` 收敛（`memory_write` 工具与 `/memory self set` 会补上缺省 'work'）。
   * 捕获/导入/整合路径不带它，行为与 0.5.x 完全一致。
   */
  facet?: SelfFacet
}

/** `writeMemory` 的返回：工具与命令共用（成功带 status，失败带 error）。 */
interface WriteMemoryResult {
  ok: boolean
  status?: 'created' | 'merged'
  id?: string
  record?: MemoryRecord
  boosted?: boolean
  error?: string
  /** 仅自画像写入（agent_self + facet）带：本次执行的收敛决策。 */
  portrait?: PortraitOutcome
}

/** `/memory` 子命令处理器。 */
type CommandHandler = (args: string[]) => DshCommandResult | Promise<DshCommandResult>

interface MemoryCommandHandlers extends Record<string, CommandHandler> {
  list(args: string[]): DshCommandResult
  show(args: string[]): DshCommandResult
  forget(args: string[]): Promise<DshCommandResult>
  restore(args: string[]): Promise<DshCommandResult>
  pin(args: string[]): Promise<DshCommandResult>
  archive(args: string[]): Promise<DshCommandResult>
  export(args: string[]): DshCommandResult
  search(args: string[]): DshCommandResult
  refresh(args: string[]): Promise<DshCommandResult>
  confirm(args: string[]): Promise<DshCommandResult>
  reject(args: string[]): Promise<DshCommandResult>
  clear(args: string[]): Promise<DshCommandResult>
  import(args: string[]): Promise<DshCommandResult>
  stats(): DshCommandResult
  consolidate(): Promise<DshCommandResult>
  /** `/memory self …`：查看/设定/查看修订链/重置自画像（契约 4.3）。 */
  self(args: string[]): Promise<DshCommandResult>
  help(): DshCommandResult
}

/** types.ts 的 MemoryConfig 尚未收录这两个只走 patch 行的字段（见交付报告）。 */
interface MemoryConfigExtras {
  exportDir?: string
  simulateCaptureError?: boolean
  /**
   * M6-A 在 `MemoryConfig` / `DEFAULTS` 里新增的 7 个自画像键（契约 3.1）。
   * 这里同样声明一遍：`cfg` 是 `MemoryConfig & MemoryConfigExtras`，两边都声明时取交集，
   * 因此无论 M6-A 是否已经改完 types.ts，宿主侧都能稳定读到这几个键。
   */
  selfPortraitEnabled?: boolean
  selfPersonaMaxTokens?: number
  selfPortraitMergeThreshold?: number
  selfReflectEnabled?: boolean
  selfReflectEveryTurns?: number
  selfReflectMinTurn?: number
  selfReflectMaxPerSession?: number
}

/**
 * 统一的错误文本：`String(error?.message ?? error)` 的类型安全版本。
 * 与运行期表达式逐字等价（普通对象上的 `message` 也会被取到）。
 */
function errorText(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return String(message ?? error)
}

export const name = 'dsh-memory'

// compaction 在本 profile 不可达（spike 实测），故不 inject；M3 走 session/event 的 compaction/summary。
export const inject = ['agents', 'systemPrompt', 'storageDomain', 'tools', 'commands']

/**
 * 配置 schema。声明为 `volatile()` 的字段会出现在 DSH 设置页的表单里（改动热生效），
 * 其余字段只能通过 patch 行设置。整块构造做了防御：schemastery 不可用或缺 `volatile`
 * 时降级为「不带 volatile」甚至「不导出 schema」，绝不让插件因为 UI 面而加载失败。
 */
function buildConfig(useVolatile: boolean): ReturnType<SchemaFactory['object']> {
  // 类型层面按「原样返回同一 schema」标注；运行期在 volatile 可用时换成 volatile 句柄。
  const field = <N>(schema: N): N => {
    if (!useVolatile) return schema
    const volatile = (schema as { volatile?: () => unknown }).volatile
    return typeof volatile === 'function' ? (volatile.call(schema) as N) : schema
  }
  return Schema!.object({
    domainName: field(Schema!.string().default('dsh_memory')),
    maxInjectedTokens: field(Schema!.number().default(300)),
    maxItemTokens: field(Schema!.number().default(60)),
    selfPortraitMaxTokens: field(Schema!.number().default(120)),
    // M6：自画像 v2（契约 3.1）——类型与默认值必须与 lib.ts 的 DEFAULTS 逐字一致
    selfPortraitEnabled: field(Schema!.boolean().default(true)),
    selfPersonaMaxTokens: field(Schema!.number().default(80)),
    selfPortraitMergeThreshold: field(Schema!.number().default(0.6)),
    selfReflectEnabled: field(Schema!.boolean().default(true)),
    selfReflectEveryTurns: field(Schema!.number().default(12)),
    selfReflectMinTurn: field(Schema!.number().default(4)),
    selfReflectMaxPerSession: field(Schema!.number().default(3)),
    recallMode: field(Schema!.union(['off', 'dry', 'inject']).default('inject')),
    recallTopK: field(Schema!.number().default(8)),
    captureMode: field(Schema!.union(['off', 'rule']).default('rule')),
    captureMaxPerTurn: field(Schema!.number().default(3)),
    consolidateEnabled: field(Schema!.boolean().default(true)),
    consolidateIntervalMinutes: field(Schema!.number().default(30)),
    // 非 volatile：仅供 patch 行/诊断使用，不进表单
    reportPath: Schema!.string(),
    // 出厂**不播种**（与 lib.js 的 DEFAULTS.seed 保持一致）：播种的演示记忆会进真实用户上下文
    seed: Schema!.boolean().default(false),
  })
}

let Config: ReturnType<typeof buildConfig> | undefined
try {
  Config = Schema ? buildConfig(true) : undefined
} catch {
  try {
    Config = Schema ? buildConfig(false) : undefined
  } catch {
    Config = undefined
  }
}
export { Config }

const passthroughSchema = {
  parse: (value: unknown): unknown => value,
  safeParse: (value: unknown): { success: true; data: unknown } => ({ success: true, data: value }),
}

const ORIGIN_RANK: Record<MemoryOrigin, number> = { observed: 0, model_proposed: 1, user_correction: 2, user_explicit: 3 }

// ---------------------------------------------------------------- 白名单与硬上限
//
// 命令层（`/memory clear --kind=`）与数据层（`/memory import`）都要按枚举校验，
// 两处各写一份必然漂移 —— 这里放唯一真源，配 `isMemoryKind` / `isScopeLevel` 类型守卫
// （守卫返回类型谓词，避免调用方再写 `as MemoryKind` 这种逃逸）。

const MEMORY_KINDS: readonly MemoryKind[] = ['user_profile', 'agent_self', 'project_gist', 'episodic', 'semantic', 'procedural']
const SCOPE_LEVELS: readonly ScopeLevel[] = ['profile', 'workspace', 'session']

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
}

function isScopeLevel(value: unknown): value is ScopeLevel {
  return typeof value === 'string' && (SCOPE_LEVELS as readonly string[]).includes(value)
}

/** `[0,1]` 夹取：非有限数（缺失 / 字符串 / NaN / ±Infinity）返回 undefined，由调用方走默认值。 */
function clamp01(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/** 冷却表（`state.recallTurnById`）保留的回合数：更早的注入记录不再压制冷却判定。 */
const RECALL_COOLDOWN_KEEP_TURNS = 200

/** 工具结果里列表条目的硬上限（按条目数截断，见 `jsonList`）。 */
const WIRE_MAX_ITEMS = 50

/**
 * 归一化宿主下发的配置。
 *
 * 实测（rev20 诊断）：一旦插件导出 `Config`，schema 里声明为 `volatile()` 的字段会以
 * **访问器对象**（`Volatile<T>`，用 `.get()` 读）下发，而不是普通标量；非 volatile 字段仍是普通值。
 * 直接把 volatile 字段当标量用会把对象塞进领域名，得到 `malformed-medium: invalid unit name '[object Object]'`。
 */
function unwrapConfig(config: unknown): Record<string, unknown> {
  if (config === null || typeof config !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    const isVolatile = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    out[key] = isVolatile ? (value as { get: () => unknown }).get() : value
  }
  return out
}

export function apply(ctx: DshPluginContext, config: unknown = {}): void {
  const cfg: MemoryConfig & MemoryConfigExtras = { ...DEFAULTS, ...unwrapConfig(config) }
  const volatileKeys = config && typeof config === 'object'
    ? Object.entries(config as Record<string, unknown>).filter(([, value]) => value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function').map(([key]) => key)
    : []
  const startedAt = new Date().toISOString()

  const state: PluginState = {
    opened: false,
    openError: null,
    records: new Map(),
    collectionVersion: 0,
    seeded: 0,
    writes: { created: 0, merged: 0, rejected: 0, deleted: 0 },
    renders: { context: 0, section: 0 },
    renderMs: { last: 0, max: 0 },
    injected: { context: [], section: [] },
    turnStopping: { plain: 0, last: null },
    toolCalls: {},
    // M2 自动捕获
    capture: { turns: 0, written: 0, skipped: {}, last: null, hourWindow: [], lastWriteByHash: new Map(), gistRefreshed: 0 },
    consolidate: { runs: 0, merged: 0, archived: 0, invalidated: 0, summarized: 0, solidified: 0, skipped: 0, last: null },
    consolidating: false,
    capturing: false,
    rejectedHashes: new Set(),
    recall: { injected: 0, turns: 0, last: null },
    recallTurnById: new Map(),
    // M6：自画像 v2（写入收敛计数 + 反思提示的会话状态）
    self: {
      added: 0,
      refined: 0,
      superseded: 0,
      skipped: 0,
      lastReflectTurn: null,
      reflections: 0,
      reflectTurns: [],
      sessionId: '',
      sessionTurns: 0,
      lastError: null,
    },
    // 用量：注入/召回只在内存累加（每次写盘会产生大量 IO），由整合或卸载时统一落盘。
    usageDirty: new Set(),
    injectedIds: { context: [], section: [] },
    settingsPage: 'none',
    settingsDetail: null,
    meta: null,
    lastSession: { id: '', cwd: null },
    budget: null,
    turnBuffer: { user: [], assistant: [], tools: [], lastAt: 0, closedAt: 0 },
    recentEvents: [],
  }

  let domain: DshDomain | null = null
  let disposed = false

  // 领域句柄的归属权在调用方（storage.zh.md：Domain.close() 由 consumer 负责）。
  // 不在卸载时关闭，被替换的修订版就会一直占着域，下一个实例只会拿到 already-open。
  ctx.effect(() => () => {
    disposed = true
    const handle = domain
    return (async () => {
      // 卸载前把内存里累加的用量落盘（best-effort），**然后**再释放领域句柄。
      // 顺序不能反：persist() 走的就是 `domain`，先把它置空会让整个用量落盘静默失败
      // （失败被 persist 内部的 catch 吞掉，外面只看到 openError）。
      try { await flushUsage() } catch { /* 落盘失败不阻塞卸载 */ }
      domain = null
      try { await handle?.close?.() } catch { /* 关闭失败不阻塞卸载 */ }
    })()
  }, 'dsh-memory.domain')

  // ---------------- 设置页表单的页面策略（设计：M5-b 界面） ----------------
  /**
   * 设置页自检文本。**按需查询** `describe()`，而不是在 apply 时查一次：
   * 描述符可能在配置变化之后才建立，apply 时查会得到时序假阴性。
   * 同时把「被投影的命名空间有哪些」打出来——这是没有 GUI 时定位「表单为什么没出现」的关键证据。
   */
  const settingsLine = (): string => {
    const base = state.settingsPage
    try {
      const forms = ctx.get<DshSettings>('settings')
      if (!forms?.describe) return `${base}（settings 服务不可用）`
      const list = forms.describe() ?? []
      const names = list.map((form) => form?.ns).filter(Boolean)
      const ours = names.includes('dsh-memory')
      return `${base}｜describe ${names.length} 个，ours=${ours}｜${names.slice(0, 24).join(', ')}`
    } catch (error) {
      return `${base}｜describe 失败：${errorText(error)}`
    }
  }

  // 官方 API：`ctx.settings.configure(presentation)` 注册**本插件实例的自动页面策略**，
  // 「设置 → 插件」里该插件自己的页面上就会渲染由 volatile Config 字段投影出的表单
  // （见 docs/subsystems/settings.zh.md、docs/cookbook/adding-a-settings-card.zh.md）。
  //
  // 三个安全措施，保证 UI 面绝不拖垮核心功能：
  //   1) 用 `ctx.inject(['settings'], cb)` 作用域注入 —— settings 缺席时这段永不执行，
  //      也不会像顶层 `inject` 那样让 fiber 永久 PENDING；服务变化时会自动重跑；
  //   2) 整段 try/catch（configure 在「本实例已有页面策略」时会抛错）；
  //   3) 结果写进 state，由 `memory_stats` 暴露 —— 这样没有 GUI 也能验证是否注册成功。
  ctx.inject(['settings'], (scope: DshPluginContext): void => {
    try {
      const forms = (scope as DshSettingsScope).settings
      const dispose = forms.configure({ auto: true })
      scope.effect(() => () => {
        try { dispose?.() } catch { /* 卸载时忽略 */ }
      }, 'dsh-memory.settings-page')
      state.settingsPage = 'auto'
      // 自检：本条目是否真的出现在表单描述符里（顺带记录描述符的字段名，便于以后核对）
      try {
        const list = forms.describe?.()
        if (Array.isArray(list)) {
          const first = list[0]
          const names = list.map((form) => form?.ns ?? form?.id ?? form?.namespace ?? form?.entry ?? null)
          state.settingsDetail = {
            count: list.length,
            keys: first ? Object.keys(first) : [],
            ours: names.includes('dsh-memory'),
          }
        }
      } catch (error) {
        state.settingsDetail = { error: errorText(error) }
      }
    } catch (error) {
      state.settingsPage = `failed: ${errorText(error)}`
    }
  })

  // ---------------- 自报告（开发期可观测性） ----------------
  const report: SelfReport = { plugin: name, stage: 'M1', revision: cfg.revision ?? null, startedAt, domain: cfg.domainName, volatileKeys }
  let lastFlushAt = 0
  /** 渲染路径每个 step 都会走，同步 writeFileSync 太贵 —— 这里按 2s 节流。 */
  const flushThrottled = (minMs: number = 2000): void => {
    const now = Date.now()
    if (now - lastFlushAt < minMs) return
    lastFlushAt = now
    flush()
  }
  const flush = (): void => {
    if (!cfg.reportPath) return
    try {
      report.state = {
        opened: state.opened,
        openError: state.openError,
        openErrorDetail: state.openErrorDetail ?? null,
        records: state.records.size,
        active: listActive(state.records.values()).length,
        seeded: state.seeded,
        collectionVersion: state.collectionVersion,
        writes: { ...state.writes },
        toolCalls: { ...state.toolCalls },
        renders: { ...state.renders },
        renderMs: { ...state.renderMs },
        injected: { context: state.injected.context.length, section: state.injected.section.length },
        lastInjection: state.injected.context,
        turnStopping: { ...state.turnStopping },
        capture: {
          turns: state.capture.turns,
          written: state.capture.written,
          skipped: { ...state.capture.skipped },
          gistRefreshed: state.capture.gistRefreshed,
          last: state.capture.last,
        },
        recentEvents: [...state.recentEvents],
        consolidate: state.consolidate,
        recall: state.recall,
        self: {
          added: state.self.added,
          refined: state.self.refined,
          superseded: state.self.superseded,
          skipped: state.self.skipped,
          lastReflectTurn: state.self.lastReflectTurn,
          reflections: state.self.reflections,
          reflectTurns: [...state.self.reflectTurns],
          sessionTurns: state.self.sessionTurns,
          lastError: state.self.lastError,
        },
        usage: {
          dirty: state.usageDirty.size,
          injectedNow: state.injectedIds.context.length + state.injectedIds.section.length,
        },
        meta: state.meta,
        budget: state.budget,
        lastReportedAt: new Date().toISOString(),
      }
      mkdirSync(dirname(cfg.reportPath), { recursive: true })
      writeFileSync(cfg.reportPath, JSON.stringify(report, null, 2))
    } catch {
      /* 自报告失败绝不影响插件 */
    }
  }

  // ---------------- 存储 ----------------
  const persist = async (record: MemoryRecord): Promise<boolean> => {
    if (!state.opened) return false
    state.records.set(record.id, record)
    state.collectionVersion += 1
    try {
      await domain!.table<MemoryRecord>('memories').put(record.id, record)
      return true
    } catch (error) {
      state.openError = `put failed: ${errorText(error)}`
      return false
    }
  }

  /**
   * 删除：先摘内存再落盘。**落盘失败必须返回 false 并回滚内存**：
   * 旧实现只记 `openError` 却 `return true`，于是 `/memory forget` 与 `clear` 报「已删除」，
   * 而重启后条目从盘上复活（审计 R7）。调用方按返回值汇总失败条数。
   */
  const remove = async (id: string): Promise<boolean> => {
    if (!state.opened) return false
    const record = state.records.get(id)
    if (!record) return false
    state.records.delete(id)
    try {
      await domain!.table<MemoryRecord>('memories').delete(id)
    } catch (error) {
      state.openError = `delete failed: ${errorText(error)}`
      // 回滚：让内存与盘保持一致（「没删掉」就是没删掉），而不是留在「内存没有、重启复活」的中间态。
      state.records.set(id, record)
      return false
    }
    state.collectionVersion += 1
    return true
  }

  /** 删除失败时的统一说明：盘上仍在，重启后会回来。 */
  const removeFailureText = (id: string): string =>
    `删除未落盘：${id}（${state.openError ?? '未知错误'}）；该条目仍在，重启后不会消失。`

  const findByHash = (hash: string): MemoryRecord | undefined => [...state.records.values()].find((record) => record.status === 'active' && record.hash === hash)

  /**
   * 记用量（设计稿 §4.1 / §4.4 / §6.2）：`lastUsedAt` 参与时间衰减，`useCount` 参与排序加成。
   * 只改内存 + 标脏，落盘交给整合或卸载，避免每步写盘。
   */
  const markUsed = (records: Iterable<MemoryRecord | undefined | null>): number => {
    const now = Date.now()
    let changed = 0
    for (const record of records) {
      if (!record || record.status !== 'active') continue
      record.lastUsedAt = now
      record.useCount = (record.useCount ?? 0) + 1
      state.usageDirty.add(record.id)
      changed += 1
    }
    return changed
  }

  /** 把标脏的用量落盘（整合与卸载时调用）。 */
  const flushUsage = async (): Promise<number> => {
    let flushed = 0
    for (const id of [...state.usageDirty]) {
      const record = state.records.get(id)
      if (!record) continue
      await persist(record)
      flushed += 1
    }
    state.usageDirty.clear()
    return flushed
  }

  // ---------------- M6：自画像写入收敛（契约 §4.1） ----------------
  //
  // 收敛只发生在**显式带 facet 的 `agent_self` 写入**上：`memory_write` 工具与 `/memory self set`
  // 会补上缺省 `'work'`；捕获/导入/整合路径不传 facet，行为与 0.5.x 完全一致（向后兼容）。
  // 决策本身是纯函数（lib.ts 的 `planPortraitUpdate`），宿主只负责**如实执行**四种决策：
  //   add → 正常新建；reinforce/refine → 更新既有条目不新建；
  //   supersede → 旧条目 archived + supersededBy，再新建；skip → 不写盘，返回可读原因。

  /** 反思提示的每会话回合号只留最近一批（无界数组会随会话增长）。 */
  const REFLECT_TURNS_KEEP = 32

  /** 自画像 subject 的 key 白名单：与 `portraitSubjectFor` 的校验一致（非法则回退 'general'）。 */
  const PORTRAIT_KEY_RE = /^[a-z0-9_]+$/u

  /**
   * 把工具/命令给的 subject 收敛成 `portraitSubjectFor(facet, key)` 的 key：
   * 接受 `voice` / `self.persona.voice` / `agent_self.work.style`，取最后一段做白名单校验，
   * 缺省或非法时回退 `'general'`（与 portraitSubjectFor 自身的回退一致）。
   */
  const portraitKeyOf = (subject: unknown): string => {
    const raw = String(subject ?? '').trim().toLowerCase()
    if (raw.length === 0) return 'general'
    const tail = raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw
    return PORTRAIT_KEY_RE.test(tail) ? tail : 'general'
  }

  /** 候选置信度：与 `makeRecord` 的缺省一致（0.6），并夹到 [0,1]。 */
  const portraitConfidenceOf = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.6

  /**
   * 规划一次自画像写入。**纯函数异常不得阻断写入**：出错时记诊断并返回 null，
   * 调用方退回普通写入路径（宁可少一次收敛，也不能丢一条记忆）。
   */
  const planPortraitWrite = (input: WriteMemoryInput, text: string, origin: MemoryOrigin): PortraitPlan | null => {
    try {
      const facet = normalizeFacet(input.facet, 'work')
      const subject = portraitSubjectFor(facet, portraitKeyOf(input.subject))
      const candidate: PortraitCandidate = {
        text,
        facet,
        subject,
        origin,
        confidence: portraitConfidenceOf(input.confidence),
        observedAt: Date.now(),
      }
      const decision = planPortraitUpdate(candidate, state.records.values(), cfg)
      return {
        candidate,
        decision,
        outcome: { action: decision.action, reason: decision.reason, facet, subject, targetId: decision.targetId },
      }
    } catch (error) {
      state.self.lastError = `portrait plan failed: ${errorText(error)}`
      return null
    }
  }

  /**
   * 自画像字段通过**变量展开**传给 makeRecord：这样在 types.ts 尚未收录 `facet` 的中间修订里
   * 也不会触发对象字面量的多余属性检查（运行期就是记录自身的字段）。
   */
  const portraitRecordFields = (facet: SelfFacet | undefined): PortraitRecordFields => ({ facet })

  /**
   * reinforce / refine：更新既有条目的正文、置信度与复现计数并落盘，**不新建**。
   * 返回 null 表示目标已被并发删除 → 调用方退回 add（不能凭空丢一次写入）。
   */
  const applyPortraitUpdate = async (
    plan: PortraitPlan,
    input: WriteMemoryInput,
    origin: MemoryOrigin,
  ): Promise<WriteMemoryResult | null> => {
    const targetId = plan.decision.targetId
    const target = targetId ? state.records.get(targetId) : undefined
    if (!target) return null
    // 如实执行决策：用户所有物的保护在 `planPortraitUpdate`（lib 规则 4，含 reinforce 的收紧）里，
    // 宿主这里不再二次判断 —— 否则同一规则会有两份实现、日后必然漂移。
    target.text = plan.decision.text || target.text
    target.confidence = plan.decision.confidence
    target.observedAt = Date.now()
    asPortrait(target).facet = plan.outcome.facet
    // 用户侧写入命中模型侧条目时升级来源与固定位（与 hash 合并分支同一语义：用户侧只升不降）。
    if (ORIGIN_RANK[origin] > ORIGIN_RANK[target.origin]) target.origin = origin
    if (input.pinned === true) target.pinned = true
    const nextImportance = clamp01(input.importance)
    if (nextImportance !== undefined) target.importance = Math.max(target.importance, nextImportance)
    const sessionId = input.sessionId ? String(input.sessionId) : ''
    const sessions = new Set([...(target.reinforcement?.sessions ?? []), ...(sessionId ? [sessionId] : [])])
    target.reinforcement = { sessions: [...sessions], count: (target.reinforcement?.count ?? 0) + 1 }
    // 指纹必须重算：recordHash 覆盖 subject 与正文
    target.hash = recordHash(target)
    await persist(target)
    state.writes.merged += 1
    state.self.refined += 1
    flush()
    return { ok: true, status: 'merged', id: target.id, record: target, boosted: false, portrait: plan.outcome }
  }

  /**
   * supersede：先把 target 置 `status:'archived'` + `supersededBy:<新 id>`，再新建候选条目。
   * 顺序不能反 —— `supersededBy` 必须指向一个已经确定的 id（§2.1：旧条目归档且留痕）。
   */
  const applyPortraitSupersede = async (
    plan: PortraitPlan,
    input: WriteMemoryInput,
    text: string,
    origin: MemoryOrigin,
  ): Promise<WriteMemoryResult> => {
    const target = plan.decision.targetId ? state.records.get(plan.decision.targetId) : undefined
    const record = makeRecord({
      ...input,
      ...portraitRecordFields(plan.outcome.facet),
      kind: 'agent_self',
      text: plan.decision.text || text,
      origin,
      confidence: plan.decision.confidence,
      subject: plan.outcome.subject,
      supersedes: target ? [target.id] : [],
    })
    asPortrait(record).facet = plan.outcome.facet
    if (plan.decision.archiveTarget && target) {
      target.status = 'archived'
      asPortrait(target).supersededBy = record.id
      await persist(target)
    }
    await persist(record)
    state.writes.created += 1
    state.self.superseded += 1
    flush()
    return { ok: true, status: 'created', id: record.id, record, portrait: plan.outcome }
  }

  /** 写入：敏感过滤 → PII 脱敏 → 回声剔除 → 自画像收敛 → hash 去重合并 → 落盘。（工具与命令共用） */
  const writeMemory = async (input: WriteMemoryInput): Promise<WriteMemoryResult> => {
    let text = String(input.text ?? '')
    const sensitive = scanSensitive(text)
    if (sensitive) {
      state.writes.rejected += 1
      flush()
      return { ok: false, error: `rejected_sensitive: 命中 ${sensitive}，长期记忆默认不保存敏感信息` }
    }
    // 硬秘密（密钥/私钥/密码/身份证/银行卡）在上面已拒写；邮箱与手机号按策略脱敏（设计稿 §8.3）
    if (cfg.piiPolicy !== 'reject') text = maskPii(text)
    // 防自激闸门 2：模型自评若只是复述刚注入的内容，不作为「新观察」写入。
    const origin = input.origin ?? 'model_proposed'
    if (origin === 'model_proposed' && isEcho(text, [...state.injected.section, ...state.injected.context], cfg.echoThreshold)) {
      state.writes.rejected += 1
      flush()
      return { ok: false, error: 'rejected_echo: 与刚注入的记忆高度相似（疑似复述），不作为新观察' }
    }

    // ---- 自画像收敛（仅显式 facet 的 agent_self 写入）----
    let portraitPlan: PortraitPlan | null = null
    if (input.kind === 'agent_self' && input.facet !== undefined) {
      const planned = planPortraitWrite(input, text, origin)
      if (planned) {
        if (planned.decision.action === 'skip') {
          state.self.skipped += 1
          flush()
          return { ok: false, error: `portrait_skipped: ${planned.decision.reason}`, portrait: planned.outcome }
        }
        if (planned.decision.action === 'reinforce' || planned.decision.action === 'refine') {
          const updated = await applyPortraitUpdate(planned, input, origin)
          if (updated) return updated
        } else if (planned.decision.action === 'supersede') {
          return await applyPortraitSupersede(planned, input, text, origin)
        }
        portraitPlan = planned
      }
    }

    const record = makeRecord({
      ...input,
      ...portraitRecordFields(portraitPlan ? portraitPlan.outcome.facet : input.facet),
      kind: input.kind as MemoryKind,
      text: portraitPlan ? (portraitPlan.decision.text || text) : text,
      origin,
      subject: portraitPlan ? portraitPlan.outcome.subject : input.subject,
      confidence: portraitPlan ? portraitPlan.decision.confidence : input.confidence,
    })
    if (!record.text) return { ok: false, error: 'rejected_invalid: text 不能为空' }
    // 用户明确拒绝过的自我观察不再重复产生（/memory reject 会登记指纹）
    if (origin === 'model_proposed' && state.rejectedHashes.has(record.hash)) {
      state.writes.rejected += 1
      flush()
      return { ok: false, error: 'rejected_by_user: 这类自我观察已被用户拒绝过' }
    }

    const existing = findByHash(record.hash)
    if (existing) {
      const sessions = new Set([
        ...(existing.reinforcement?.sessions ?? []),
        ...(record.reinforcement?.sessions ?? []),
      ])
      // 「重复提及」（设计稿 §5.2）：同一件事在**新的会话**里再次被提到 → 重要度 +boost（封顶 1）
      const incomingSession = input.sessionId ? String(input.sessionId) : null
      const isNewSession = incomingSession !== null && !(existing.reinforcement?.sessions ?? []).includes(incomingSession)
      const base = Math.max(existing.importance, record.importance)
      const merged: MemoryRecord = {
        ...existing,
        confidence: Math.max(existing.confidence, record.confidence),
        importance: isNewSession ? Math.min(1, base + (cfg.repeatMentionBoost ?? 0.1)) : base,
        origin: ORIGIN_RANK[record.origin] > ORIGIN_RANK[existing.origin] ? record.origin : existing.origin,
        observedAt: record.observedAt,
        pinned: existing.pinned || record.pinned,
        reinforcement: { sessions: [...sessions], count: (existing.reinforcement?.count ?? 0) + 1 },
      }
      await persist(merged)
      state.writes.merged += 1
      flush()
      return { ok: true, status: 'merged', id: merged.id, record: merged, boosted: isNewSession }
    }

    await persist(record)
    state.writes.created += 1
    if (portraitPlan) state.self.added += 1
    flush()
    return {
      ok: true,
      status: 'created',
      id: record.id,
      record,
      ...(portraitPlan ? { portrait: portraitPlan.outcome } : {}),
    }
  }

  // ---------------- 领域打开 + 播种 ----------------
  const openDomain = async (): Promise<void> => {
    const storageDomain = ctx.get<DshStorageDomain>('storageDomain')
    if (!storageDomain) {
      state.openError = 'storageDomain service absent'
      flush()
      return
    }
    try {
      domain = await storageDomain.open({
        name: cfg.domainName,
        version: 1,
        layout: 'per-record',
        tables: { memories: { valueSchema: passthroughSchema } },
        global: { schema: passthroughSchema, initial: { schemaVersion: 1, collectionVersion: 0 } },
      })
      // 打开期间插件可能已被卸载：立刻关闭，别把域泄漏出去。
      if (disposed) {
        try {
          await domain.close()
        } catch { /* ignore */ }
        domain = null
        return
      }
      state.opened = true
      try {
        // 必须 await：`domain.global.get()` 在运行版里返回 Promise。
        // 不 await 会把一个 Thenable 存进 state.meta —— 之后 `state.meta?.lastConsolidatedAt`
        // 恒为 undefined，启动水位丢失，每次启动都白跑一整轮整合。
        state.meta = ((await domain.global.get()) ?? null) as MemoryMeta | null
      } catch { /* 水位读取失败不影响加载 */ }
      for (const entry of domain.table<MemoryRecord>('memories').entries()) {
        const value = Array.isArray(entry) ? entry[1] : entry
        if (value && typeof value === 'object' && typeof value.id === 'string') state.records.set(value.id, value)
      }
      if (cfg.seed && state.records.size === 0) {
        // 仅开发期使用（seed 出厂为 false）。示例内容必须**通用**：
        // 不要写具体平台、时区、路径或任何能指向真实使用者与机器的信息。
        const seeds = [
          makeRecord({
            kind: 'user_profile', origin: 'user_explicit', confidence: 0.95, importance: 0.9, pinned: true,
            subject: 'language.preference', text: '示例：用户偏好的沟通语言与代码注释语言。', tags: ['seed'],
          }),
          makeRecord({
            kind: 'user_profile', origin: 'user_explicit', confidence: 0.9, importance: 0.7,
            subject: 'workflow.preference', text: '示例：用户偏好的工具链与提交粒度。', tags: ['seed'],
          }),
          makeRecord({
            kind: 'agent_self', origin: 'user_explicit', confidence: 0.9, importance: 0.9, pinned: true,
            subject: 'style.answer', text: '示例：用户认可的作答风格（先结论后理由、不做未授权的重构）。', tags: ['seed'],
          }),
        ]
        for (const record of seeds) {
          await persist(record)
          state.seeded += 1
        }
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null | undefined)?.code
      state.openError = `${code ? `${String(code)}: ` : ''}${errorText(error)}`
      // 诊断：`malformed-medium: invalid unit name '[object Object]'` 说明有对象被当成 unit 名，
      // 把实际入参记录下来，避免再靠猜。
      state.openErrorDetail = {
        domainName: String(cfg.domainName),
        domainNameType: typeof cfg.domainName,
        configKeys: Object.keys(cfg).slice(0, 40),
        configType: typeof config,
        // 宿主可能把配置包装成 accessor/volatile 形态，直接把原始形状打出来
        configRaw: (() => {
          try { return JSON.stringify(config)?.slice(0, 400) ?? String(config) } catch { return 'unserializable' }
        })(),
        domainNameShape: (() => {
          try {
            const raw = (config as { domainName?: unknown } | null | undefined)?.domainName
            return `${typeof raw}:${JSON.stringify(raw)?.slice(0, 200)}`
          } catch { return typeof (config as { domainName?: unknown } | null | undefined)?.domainName }
        })(),
        detail: (error as { detail?: unknown } | null | undefined)?.detail === undefined
          ? null
          : String(JSON.stringify((error as { detail?: unknown }).detail)).slice(0, 300),
      }
    }
    flush()
  }
  // 注意：openDomain 的调用放在文件末尾（consolidate 定义之后），避免 TDZ。

  /** 预算核对（设计稿 §7.2 步骤 4）：用自己的估算渲染，再用 tokenMeter 复核；核对结果只观测不阻断。 */
  const crossCheckTokens = (text: string): string => {
    const estimated = estimateTokens(text, cfg.charsPerToken)
    let meterTokens: number | null = null
    let meterError: string | null = null
    try {
      const meter = ctx.get<{ estimateMessage?: (message: unknown) => number }>('tokenMeter')
      if (meter && typeof meter.estimateMessage === 'function') {
        meterTokens = meter.estimateMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
      }
    } catch (error) {
      meterError = errorText(error)
    }
    state.budget = { chars: text.length, estimated, meterTokens, meterError, at: new Date().toISOString() }
    return text
  }

  // ---------------- 注入注册 ----------------
  try {
    ctx.systemPrompt.section({
      name: 'dsh-memory:self-portrait',
      order: cfg.sectionOrder,
      text: () => {
        const began = Date.now()
        try {
          const block = renderSelfBlock(state.records.values(), cfg)
          state.renders.section += 1
          state.renderMs.last = Date.now() - began
          state.renderMs.max = Math.max(state.renderMs.max, state.renderMs.last)
          state.injected.section = block.lines
          state.injectedIds.section = block.selected.map((record) => record.id)
          flushThrottled()
          return crossCheckTokens(block.text)
        } catch {
          return ''
        }
      },
    })
  } catch (error) {
    state.openError = `section register failed: ${errorText(error)}`
  }

  try {
    ctx.systemPrompt.context({
      name: 'dsh-memory:recall',
      order: cfg.contextOrder,
      text: (assembleContext) => {
        const began = Date.now()
        try {
          const cwd = assembleContext?.agent?.session?.header?.cwd
          const block = renderContextBlock(state.records.values(), cfg, workspaceKeyOf(cwd))
          state.renders.context += 1
          state.renderMs.last = Date.now() - began
          state.renderMs.max = Math.max(state.renderMs.max, state.renderMs.last)
          state.injected.context = block.lines
          state.injectedIds.context = block.selected.map((record) => record.id)
          flushThrottled()
          return crossCheckTokens(block.text)
        } catch {
          return ''
        }
      },
    })
  } catch (error) {
    state.openError = `context register failed: ${errorText(error)}`
  }

  // ---------------- M2：回合缓冲 + 回合边界规则捕获 ----------------
  // M1 实测：agent/turn-stopping 在根作用域**两种注册都收到**（plain 与 {global:true} 各 1 次），
  // 所以这里只注册一次，避免重复捕获。
  const textOfContent = (content: unknown): string => {
    if (Array.isArray(content)) return (content as unknown[]).filter((block) => (block as { type?: unknown } | null | undefined)?.type === 'text').map((block) => (block as { text?: unknown } | null | undefined)?.text).join('\n')
    return String(content ?? '')
  }

  try {
    ctx.on('session/event', (_session, rawEvent) => {
      const event = rawEvent as DshSessionEvent
      try {
        const type = event?.type
        state.lastSession = { id: String(_session?.id ?? ''), cwd: _session?.header?.cwd ?? null }
        // 压缩固化：摘要事件只写日志、不进模型上下文，正好当记忆源（设计稿 §5.5）。
        if (type === 'compaction/summary') {
          void solidifyCompaction(event)
          return
        }
        // 诊断环：保留最近事件类型顺序（event-producer-consumer 的顺序问题很难靠猜）。
        state.recentEvents.push(type === 'user/message' ? `${type}:${event.data?.source?.kind}` : type)
        if (state.recentEvents.length > 30) state.recentEvents.shift()
        state.turnBuffer.lastAt = Date.now()
        if (type === 'turn/end' || type === 'turn/start') {
          // 不能只靠 turn/start 清空：用户消息可能先于 turn/start 到达（M2 实测 userChars=0 就是被它冲掉的）。
          // 因此改为「turn/end 清空」，turn/start 只在缓冲区明显过期时清空。
          const stale = Date.now() - (state.turnBuffer.closedAt ?? 0) > 10 * 60_000
          if (type === 'turn/end' || stale) {
            state.turnBuffer = { user: [], assistant: [], tools: [], lastAt: Date.now(), closedAt: Date.now() }
          }
          return
        }
        if (type === 'user/message') {
          // 只收真实用户消息；注入的 runtime-context 不算（防自激闸门 1）。
          if (event.data?.source?.kind === 'user') state.turnBuffer.user.push(textOfContent(event.data?.content))
          return
        }
        if (type === 'assistant/message') {
          state.turnBuffer.assistant.push(textOfContent(event.data?.message?.content))
          return
        }
        if (type === 'tool/call') {
          state.turnBuffer.tools.push(`${String(event.data?.name ?? '')} ${String(event.data?.arguments ?? '').slice(0, 400)}`)
        }
      } catch { /* 观测失败绝不影响主流程 */ }
    })
  } catch { /* ignore */ }

  const isRootAgent = (agent: DshAgent | undefined): boolean => {
    try {
      return ctx.agents.roots().some((root) => root === agent)
    } catch {
      return false // 判定失败时保守跳过写入：宁可少记，也不让子会话污染主画像
    }
  }

  const mergeSkips = (target: Record<string, number>, extra?: Record<string, number>): Record<string, number> => {
    for (const [key, value] of Object.entries(extra ?? {})) target[key] = (target[key] ?? 0) + value
    return target
  }

  /**
   * 捕获入口：重入保护 + 实际捕获。
   *
   * 为什么需要锁：`agent/turn-stopping` 用 `Promise.race([runCapture(...), 超时])`，超时只意味着
   * 「本回合不再等它」，被超时的那次仍在后台继续写 `state.records` 与 `state.capture.*`；
   * 下一个回合再进来就会与它并发改同一批状态。重入时直接跳过并记一次 skipped，
   * `Promise.race` 的语义（按时返回）保持不变。
   */
  const runCapture = async (agent: DshAgent | undefined): Promise<void> => {
    if (state.capturing) {
      state.capture.turns += 1
      state.capture.skipped['capture-in-flight'] = (state.capture.skipped['capture-in-flight'] ?? 0) + 1
      const payload: Record<string, unknown> = { skipped: 'capture-in-flight' }
      state.capture.last = { at: new Date().toISOString(), ...payload }
      return
    }
    state.capturing = true
    try {
      await runCaptureInner(agent)
    } finally {
      state.capturing = false
    }
  }

  /** 一次回合收尾的捕获：规则抽取 → 节流 → 落盘 → 项目印象刷新。任何异常都不得外抛。 */
  const runCaptureInner = async (agent: DshAgent | undefined): Promise<void> => {
    const began = Date.now()
    state.capture.turns += 1
    const done = (payload: Record<string, unknown>): void => {
      state.capture.last = { at: new Date().toISOString(), ms: Date.now() - began, ...payload }
    }
    // 故障注入（设计稿 §11.2 用例 7）：验证捕获链路异常不会影响对话主流程。
    if (cfg.simulateCaptureError) throw new Error('simulated capture failure (fault injection)')
    if (cfg.captureMode === 'off') return done({ skipped: 'mode-off' })
    if (!state.opened) return done({ skipped: 'domain-not-open' })
    if (!isRootAgent(agent)) return done({ skipped: 'not-root-agent' })

    const now = Date.now()
    state.capture.hourWindow = state.capture.hourWindow.filter((ts) => now - ts < 3_600_000)
    if (state.capture.hourWindow.length >= cfg.capturePerHour) return done({ skipped: 'hour-quota' })

    const sessionId = agent?.session ? String(agent.session.id) : ''
    const cwd = agent?.session?.header?.cwd
    const workspaceKey = workspaceKeyOf(cwd) ?? '*'
    const userText = state.turnBuffer.user.join('\n')
    const { candidates, skipped } = extractCandidates(userText, cfg)

    let written = 0
    for (const candidate of candidates) {
      const lastAt = state.capture.lastWriteByHash.get(candidate.hash) ?? 0
      if (now - lastAt < 24 * 3_600_000) {
        skipped['hash-window'] = (skipped['hash-window'] ?? 0) + 1
        continue
      }
      const level = defaultScopeFor(candidate.kind)
      // 主题键：让「同一件事的两种说法」能对齐，否则合并/冲突判定永远不会生效。
      // 纠正类信号直接继承被纠正条目的 subject/field/value —— 这样整合阶段
      // 「用户侧来源无条件推翻」这条链才真正闭环。
      let subject: string | null = deriveSubject(candidate.text, candidate.signal)
      let field: string | null = null
      let value: string | null = null
      if (candidate.origin === 'user_correction') {
        const best = recallRecords(state.records.values(), {
          query: candidate.text, mode: 'memory', minHits: 1, minMatch: 0.3, limit: 1,
        })[0]
        if (best) {
          subject = best.record.subject ?? subject
          field = best.record.field ?? null
          value = best.record.value ?? null
        }
      }
      const result = await writeMemory({
        kind: candidate.kind,
        text: candidate.text,
        origin: candidate.origin,
        confidence: candidate.confidence,
        importance: candidate.importance,
        tags: candidate.tags,
        subject,
        field,
        value,
        sessionId,
        scope: { level, key: level === 'workspace' ? workspaceKey : '*' },
        source: sessionId ? { sessionId, seqStart: Number(agent?.session?.seq ?? 0), seqEnd: Number(agent?.session?.seq ?? 0) } : null,
      })
      if (result.ok) {
        written += 1
        state.capture.hourWindow.push(now)
        state.capture.lastWriteByHash.set(candidate.hash, now)
      } else {
        const reason = String(result.error ?? 'write-failed').split(':')[0] as string
        skipped[reason] = (skipped[reason] ?? 0) + 1
      }
    }

    // 项目模糊印象：零模型调用，同身份只刷新不新增（设计稿 §4.3 / §5.5）。
    let gist: string | null = null
    const markers = detectWorkspaceMarkers([userText, ...state.turnBuffer.tools].join('\n'))
    if (markers.length >= cfg.gistMinMarkers) {
      const existing = [...state.records.values()].find((record) =>
        record.kind === 'project_gist' && record.status === 'active'
        && record.scope.key === workspaceKey && record.subject === 'project.overview')
      const text = composeGistText(markers)
      if (existing) {
        existing.text = text
        existing.observedAt = now
        existing.hash = recordHash(existing)
        existing.confidence = Math.min(0.6, (existing.confidence ?? 0.5) + 0.05)
        await persist(existing)
        state.capture.gistRefreshed += 1
        gist = 'refreshed'
      } else {
        const created = await writeMemory({
          kind: 'project_gist',
          precision: 'gist',
          text,
          subject: 'project.overview',
          origin: 'observed',
          confidence: 0.5,
          importance: 0.5,
          tags: ['gist'],
          sessionId,
          // 设计稿 I3：自动写入的记忆必须带来源，项目印象也不例外
          source: sessionId ? { sessionId, seqStart: Number(agent?.session?.seq ?? 0), seqEnd: Number(agent?.session?.seq ?? 0) } : null,
          scope: { level: 'workspace', key: workspaceKey },
        })
        gist = created.ok ? 'created' : 'failed'
      }
    }

    state.capture.written += written
    mergeSkips(state.capture.skipped, skipped)
    return done({
      candidates: candidates.length,
      written,
      skipped,
      gist,
      markers,
      userChars: userText.length,
      assistantChars: state.turnBuffer.assistant.join('').length,
      toolCalls: state.turnBuffer.tools.length,
    })
  }

  try {
    ctx.on('agent/turn-stopping', async (payload: DshTurnStoppingPayload): Promise<void> => {
      state.turnStopping.plain += 1
      state.turnStopping.last = { channel: 'plain', at: new Date().toISOString() }
      // R1 的用量按**回合**记一次：常驻块每个 step 都会渲染，按 step 记会虚高。
      try {
        markUsed([...state.injectedIds.context, ...state.injectedIds.section]
          .map((id) => state.records.get(id))
          .filter(Boolean))
      } catch { /* 记用量失败绝不影响回合 */ }
      try {
        await Promise.race([
          runCapture(payload?.agent),
          new Promise((resolve) => { setTimeout(resolve, cfg.captureTimeoutMs) }),
        ])
      } catch (error) {
        state.capture.last = { at: new Date().toISOString(), error: errorText(error) }
      }
      flush()
    })
  } catch { /* ignore */ }

  // ---------------- M4：R2 按轮相关召回（pre-step 追加一条带来源的 user 快照） ----------------
  // 与 R1（常驻块）互补：R1 放长期稳定的画像/印象，R2 只放「本轮这句话真的相关」的条目。
  // 注意：长查询必须用 memoryMatch（记忆侧覆盖率），用查询覆盖率会让任何长消息都趋近 0。
  //
  // M6 起这段逻辑改为一个局部函数：pre-step 需要「先 R2、后反思提示」两步独立追加
  // （反思提示不能因为 R2 提前 return 而消失 —— 它的 gate 与 R2 不同）。
  const injectRecallSnapshot = async (
    decision: DshPreStepDecision | null | undefined,
    payload: DshPreStepPayload,
  ): Promise<DshPreStepDecision | null | undefined> => {
    const recallBegan = Date.now()
    try {
      if (decision?.kind === 'reject' || payload?.signal?.aborted === true) return decision
      if (cfg.autoRecall === false || cfg.recallMode === 'off' || !state.opened) return decision
      const proposed = Array.isArray(decision?.messages) ? decision.messages : []
      const query = proposed.map((message) => textOfContent((message as { content?: unknown } | null | undefined)?.content)).join('\n')
      if (query.trim().length < (cfg.recallMinQueryChars ?? 12)) return decision

      const turn = Number(payload?.turn ?? 0)
      const workspaceKey = workspaceKeyOf(payload?.agent?.session?.header?.cwd)
      const residentLines = new Set([...state.injected.context, ...state.injected.section]
        .map((line) => line.replace(/^[-*\s]+/u, '').replace(/^\([a-z]+\)\s*/u, '').trim()))
      const cooldownTurns = cfg.recallCooldownTurns ?? 3

      // 候选池要**大于** topK：过滤发生在取前 K 条之前，否则刚注入过的条目
      // （markUsed 给了 recency 加成，分数最高）会霸占前 K 个名额、随即被冷却过滤掉，
      // 把它们后面的相关条目全挤走 —— 表现就是后续回合「0 命中」。
      const topK = cfg.recallTopK ?? 8
      const hits = recallRecords(state.records.values(), {
        query,
        mode: 'memory',
        minHits: cfg.recallMinHits ?? 2,
        minMatch: cfg.recallMinMatch ?? 0.4,
        limit: Math.max(topK, Math.min(50, topK * 4)),
      })
        .filter((hit) => hit.record.kind !== 'agent_self')
        .filter((hit) => hit.record.scope.level !== 'workspace' || hit.record.scope.key === workspaceKey)
        .filter((hit) => !residentLines.has(hit.record.text.trim()))
        .filter((hit) => turn - (state.recallTurnById.get(hit.record.id) ?? -999) >= cooldownTurns)
        .slice(0, topK)

      state.recall.turns += 1
      // 超时保护（设计稿 §6.3：召回耗时上限 10ms，超时跳过本轮）
      const recallBudgetMs = cfg.recallBudgetMs ?? 10
      if (Date.now() - recallBegan > recallBudgetMs) {
        state.recall.last = { at: new Date().toISOString(), turn, queryChars: query.length, hits: 0, skipped: 'over-budget', ms: Date.now() - recallBegan }
        return decision
      }
      if (hits.length === 0) {
        state.recall.last = { at: new Date().toISOString(), turn, queryChars: query.length, hits: 0, mode: cfg.recallMode }
        return decision
      }

      // 硬预算（设计稿 §7.2）：块内固定文案先扣掉，再逐条填。不能像早期版本那样直接 map 全部命中，
      // 否则 8 条 × 60 token 会突破 maxInjectedTokens。
      const R2_HEADER = '[相关记忆 · 本轮召回]'
      const R2_FOOTER = '以上为历史记录，可能与本轮任务相关；与当前对话冲突时以当前对话为准。'
      const r2Budget = Math.max(0, cfg.maxInjectedTokens - estimateTokens(`${R2_HEADER}\n${R2_FOOTER}`, cfg.charsPerToken))
      const filled = fillWithinBudget(
        hits.map((hit) => hit.record),
        r2Budget,
        (record, text) => `- (${record.kind}) ${text}`,
        cfg,
      )
      const keptIds = new Set(filled.selected.map((record) => record.id))
      const keptHits = hits.filter((hit) => keptIds.has(hit.record.id))
      if (filled.lines.length === 0) {
        state.recall.last = { at: new Date().toISOString(), turn, queryChars: query.length, hits: 0, mode: cfg.recallMode, budgetSkipped: hits.length }
        return decision
      }
      const lines = filled.lines
      const text = [R2_HEADER, ...lines, R2_FOOTER].join('\n')
      state.recall.injected += cfg.recallMode === 'inject' ? keptHits.length : 0
      state.recall.last = {
        at: new Date().toISOString(),
        turn,
        queryChars: query.length,
        hits: keptHits.length,
        droppedByBudget: hits.length - keptHits.length,
        tokens: estimateTokens(text, cfg.charsPerToken),
        mode: cfg.recallMode,
        preview: text.slice(0, 300),
        detail: keptHits.map((hit) => ({ id: hit.record.id, match: Number(hit.match.toFixed(2)), score: Number(hit.score.toFixed(2)) })),
      }
      for (const hit of keptHits) state.recallTurnById.set(hit.record.id, turn)
      markUsed(keptHits.map((hit) => hit.record))
      flush()
      // dry：只算不注入（用于上线前验证打分与消息形状，不会改动对话）
      if (cfg.recallMode === 'dry') return decision
      // 形状必须与宿主自己注入的 runtime-context 消息完全一致（从会话日志取证）：
      // { role:'user', id:<uuid>, content:[{type:'text',text}], source:{kind:'runtime-context',form:'snapshot',sections:[...]} }
      // 自造 source.kind 有被运行时校验拒绝的风险，故沿用已注册的 runtime-context。
      const messageId = globalThis.crypto?.randomUUID?.() ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`
      return {
        ...decision,
        messages: [...proposed, {
          role: 'user',
          id: messageId,
          content: [{ type: 'text', text }],
          source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'dsh-memory:recall', text }] },
        }],
      }
    } catch (error) {
      state.recall.last = { at: new Date().toISOString(), error: errorText(error) }
      flush()
      return decision
    }
  }

  // ---------------- M6：低频反思提示（契约 §4.2） ----------------
  /**
   * 自画像反思提示：在 R2 **之后**追加**单独一条** runtime-context 消息（形状与 R2 完全一致，
   * 只有 `sections[0].name` 改为 `dsh-memory:self-reflect`）。为什么不与 R2 合并：
   * 两者语义不同，且 R2 可能因冷却/预算被跳过 —— 合并会让反思提示被顺带吞掉。
   *
   * 闸门与计数（严格要求）：
   *   · `recallMode === 'dry'|'off'` 或 `autoRecall === false` → 不注入且**不推进计数**；
   *   · reject / aborted / 域未打开 / 回合号非法 → 同样不注入、不推进（连「提醒过」都不算）；
   *   · 只有真正把消息追加进 decision 之后，才更新 lastReflectTurn / reflections / reflectTurns。
   * 任何异常都被 catch：pre-step 主流程绝不能因为提示注入而失败。
   */
  const injectReflectNotice = (
    decision: DshPreStepDecision | null | undefined,
    payload: DshPreStepPayload,
  ): DshPreStepDecision | null | undefined => {
    try {
      if (!decision || typeof decision !== 'object') return decision
      if (decision.kind === 'reject' || payload?.signal?.aborted === true) return decision
      if (cfg.selfReflectEnabled === false) return decision
      if (cfg.autoRecall === false || cfg.recallMode === 'off' || cfg.recallMode === 'dry' || !state.opened) return decision
      const rawTurn = Number(payload?.turn ?? 0)
      if (!Number.isFinite(rawTurn) || rawTurn < 0) return decision
      const turn = Math.floor(rawTurn)

      // 会话切换：反思配额按会话重置（回合号本来就是按会话重新计数的）
      const sessionId = String(payload?.agent?.session?.id ?? '')
      if (state.self.sessionId !== sessionId) {
        state.self.sessionId = sessionId
        state.self.lastReflectTurn = null
        state.self.reflections = 0
        state.self.reflectTurns = []
        state.self.sessionTurns = 0
      }
      // 回合号按会话递增（实测宿主这样下发），因此它本身就是「已进行的回合数」。
      // 取 max 保证单调不减：pre-step 每个 step 都会跑，回合号在极端情况下可能回退。
      if (turn > state.self.sessionTurns) state.self.sessionTurns = turn

      const due = shouldReflect({
        turn,
        lastReflectTurn: state.self.lastReflectTurn,
        reflectionsThisSession: state.self.reflections,
        sessionTurns: state.self.sessionTurns,
      }, cfg)
      if (!due) return decision

      const proposed = Array.isArray(decision.messages) ? decision.messages : []
      // 注入正文一律过 clampText：折平单行（防结构伪造），预算用整块注入预算（提示本身就是一条完整块）
      const text = clampText(REFLECT_NOTICE, Math.max(1, cfg.maxInjectedTokens ?? DEFAULTS.maxInjectedTokens), cfg.charsPerToken)
      const messageId = globalThis.crypto?.randomUUID?.() ?? `mem-reflect-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const message = {
        role: 'user',
        id: messageId,
        content: [{ type: 'text', text }],
        source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'dsh-memory:self-reflect', text }] },
      }
      // 先构造好消息再推进计数：注入失败时不能留下「提醒过」的假账
      state.self.lastReflectTurn = turn
      state.self.reflections += 1
      state.self.reflectTurns = [...state.self.reflectTurns, turn].slice(-REFLECT_TURNS_KEEP)
      flush()
      return { ...decision, messages: [...proposed, message] }
    } catch (error) {
      state.self.lastError = `reflect inject failed: ${errorText(error)}`
      flush()
      return decision
    }
  }

  try {
    ctx.on('agent/pre-step', async (rawPayload, next) => {
      const payload = rawPayload as DshPreStepPayload
      const decided = (await next()) as DshPreStepDecision | null | undefined
      // 顺序固定：R2 快照在前、反思提示在后；两者各自独立追加、互不影响对方的闸门
      const withRecall = await injectRecallSnapshot(decided, payload)
      return injectReflectNotice(withRecall, payload)
    })
  } catch { /* ignore */ }

  // ---------------- M3：整合治理（合并 / 冲突 / 衰减归档 / 摘要） ----------------
  const consolidate = async (reason: string): Promise<void> => {
    const began = Date.now()
    if (!state.opened) return
    // 重入锁：定时器与 /memory consolidate（或 memory_maintain）可能重叠，
    // 并发跑会出现「同一批记录被合并两次」这类逻辑交错。
    if (state.consolidating) {
      state.consolidate.skipped = (state.consolidate.skipped ?? 0) + 1
      return
    }
    state.consolidating = true
    try {
      await runConsolidate(reason, began)
    } finally {
      state.consolidating = false
    }
  }

  const runConsolidate = async (reason: string, began: number): Promise<void> => {
    const now = Date.now()
    const summary: ConsolidateSummary = { at: new Date().toISOString(), reason, merged: 0, archived: 0, invalidated: 0, summarized: 0 }
    const budget = cfg.consolidateMaxRecords ?? 200
    try {
      // 1) 合并同 subject 的近似条目：保留最优者，其余归档（不删除）
      for (const group of pickMergeGroups(state.records.values(), cfg)) {
        if (summary.merged >= budget) break
        const [lead, ...rest] = [...group].sort(compareRecords) as [MemoryRecord, ...MemoryRecord[]]
        for (const extra of rest) {
          lead.useCount = (lead.useCount ?? 0) + (extra.useCount ?? 0)
          lead.importance = Math.max(lead.importance, extra.importance)
          lead.confidence = Math.max(lead.confidence, extra.confidence)
          lead.observedAt = Math.max(lead.observedAt, extra.observedAt)
          extra.status = 'archived'
          await persist(extra)
          summary.merged += 1
        }
        await persist(lead)
      }
      // 2) 冲突：旧条目置 invalid（可恢复），新条目记 supersedes；模型自评不能推翻用户侧条目
      for (const { winner, loser, blocked } of findConflicts(state.records.values())) {
        if (blocked) continue
        loser.status = 'invalid'
        loser.invalidAt = now
        winner.supersedes = [...new Set([...(winner.supersedes ?? []), loser.id])]
        await persist(loser)
        await persist(winner)
        summary.invalidated += 1
      }
      // 3) 衰减与归档
      for (const record of listActive(state.records.values())) {
        if (summary.archived >= budget) break
        if (shouldArchive(record, cfg, now)) {
          record.status = 'archived'
          await persist(record)
          summary.archived += 1
        }
      }
      // 4) 规则式摘要（零模型调用；摘要条目标记 summary，不再参与后续整合）
      for (const item of composeSubjectSummary(state.records.values(), cfg)) {
        const result = await writeMemory({
          kind: item.kind,
          text: item.text,
          subject: `${item.subject}.summary`,
          origin: 'observed',
          confidence: 0.7,
          importance: 0.6,
          tags: ['summary'],
          scope: item.scope,
        })
        if (result.ok) summary.summarized += 1
      }
      // 5) 用量落盘（注入/召回只在内存累加，避免每步写盘）
      const flushedUsage = await flushUsage()
      if (flushedUsage > 0) summary.usageFlushed = flushedUsage
      // 6) 无界状态收敛：冷却表与写入窗口表只增不删会慢慢吃掉内存
      if (state.recallTurnById.size > 500) {
        // 冷却表按**回合号**记账（key = 记录 id，value = 最近一次注入它的回合号；
        // 判定在 `agent/pre-step`：`turn - last >= cooldownTurns`）。
        // cutoff 必须用**当前回合号**：旧实现读 `state.consolidate.last?.turn`，
        // 而那个字段从来没有被写过（恒为 undefined → 0），cutoff 恒为 -200，
        // `turn < -200` 永不成立 —— 冷却表因此跨会话无限增长。
        // 当前回合号直接取 `state.recall.last.turn`（pre-step 每次都会写它），不引入新的全局状态；
        // 它缺席（pre-step 因异常只写了 error）时本轮不收敛，等下一个回合再说。
        const currentTurn = state.recall.last?.turn
        if (typeof currentTurn === 'number' && Number.isFinite(currentTurn)) {
          const cutoff = currentTurn - RECALL_COOLDOWN_KEEP_TURNS
          for (const [id, turn] of state.recallTurnById) {
            // turn > currentTurn 是**上一个会话**遗留的回合号（回合号按会话从 0 重新计数）：
            // 它永远不会被冷却判定放过，留着只会永久压制该条目 —— 与过期条目一起清掉。
            if (turn < cutoff || turn > currentTurn) state.recallTurnById.delete(id)
          }
        }
      }
      if (state.capture.lastWriteByHash.size > 2000) {
        const cutoff = now - 7 * 86_400_000
        for (const [hash, at] of state.capture.lastWriteByHash) if (at < cutoff) state.capture.lastWriteByHash.delete(hash)
      }
      // 7) 元数据水位（global）
      state.meta = {
        ...(state.meta ?? {}),
        schemaVersion: 1,
        collectionVersion: state.collectionVersion,
        lastConsolidatedAt: now,
      }
      try {
        await (domain!.global as DshDomainGlobal).set(state.meta)
      } catch { /* 水位写失败不影响本轮整合结果 */ }
    } catch (error) {
      summary.error = errorText(error)
    }
    summary.ms = Date.now() - began
    state.consolidate.runs += 1
    state.consolidate.merged += summary.merged
    state.consolidate.archived += summary.archived
    state.consolidate.invalidated += summary.invalidated
    state.consolidate.summarized += summary.summarized
    state.consolidate.last = summary
    flush()
  }

  /** 压缩固化：把压缩摘要里的要点落成 episodic 记忆，防「压缩即丢失」。 */
  const solidifyCompaction = async (event: DshSessionEvent | null | undefined): Promise<void> => {
    try {
      const text = extractSummaryText(event?.data?.summary)
      if (!text) return
      const shadowed: unknown[] = Array.isArray(event?.data?.shadowedSeqs) ? (event.data.shadowedSeqs as unknown[]) : []
      const seqStart = shadowed.length > 0 ? Number(shadowed[0]) : Number(event?.seq ?? 0)
      const seqEnd = shadowed.length > 0 ? Number(shadowed[shadowed.length - 1]) : Number(event?.seq ?? 0)
      const sessionId = state.lastSession?.id ?? ''
      const workspaceKey = workspaceKeyOf(state.lastSession?.cwd) ?? '*'
      let written = 0
      for (const sentence of splitSentences(text).slice(0, cfg.solidificationMaxPerCompaction ?? 3)) {
        if (isExcluded(sentence)) continue
        const result = await writeMemory({
          kind: 'episodic',
          text: sentence.replace(/[。！？!?]+$/u, '').trim(),
          origin: 'observed',
          confidence: 0.65,
          importance: 0.55,
          tags: ['compaction'],
          scope: { level: 'workspace', key: workspaceKey },
          source: { sessionId, seqStart, seqEnd },
        })
        if (result.ok) written += 1
      }
      state.consolidate.solidified += written
      flush()
    } catch { /* 固化失败绝不影响主流程 */ }
  }

  try {
    ctx.effect(() => {
      const intervalMs = Math.max(1, cfg.consolidateIntervalMinutes ?? 30) * 60_000
      const timer = setInterval(() => {
        if (cfg.consolidateEnabled === false) return
        void consolidate('interval')
      }, intervalMs)
      return () => clearInterval(timer)
    }, 'dsh-memory.consolidate-timer')
  } catch { /* ignore */ }

  // ---------------- 模型工具（原生 JSON Schema） ----------------
  const toolOutput = {
    schema: { type: 'string' },
    render: (_args: unknown, value: unknown): Array<{ type: string; text: string }> => [{ type: 'text', text: String(value) }],
  }
  /**
   * 工具结果序列化：**绝不在 JSON 文本中间切**。
   * 旧实现是 `JSON.stringify(value, null, 2).slice(0, 8000)`：会在任意位置切断，
   * 模型拿到的是解析失败的残片（而且没有任何截断标记）。
   */
  const json = (value: unknown): string => JSON.stringify(value, null, 2)

  /**
   * 列表型结果的统一形状：按**条目数**截断（保留前 `WIRE_MAX_ITEMS` 条）后整体序列化，
   * 并带上 `total` 与 `truncated`，让模型知道「这不是全部」，而不是拿到坏 JSON。
   * `key` 保持各工具原有的字段名（items / matches / candidates），不额外制造 API 漂移。
   */
  const jsonList = (key: string, items: readonly unknown[], extra: Record<string, unknown> = {}): string => {
    const total = items.length
    const kept = items.slice(0, WIRE_MAX_ITEMS)
    return json({ ...extra, count: kept.length, total, truncated: total > kept.length, [key]: kept })
  }

  const toolMessages = (exec: DshToolExecContext | undefined): unknown => {
    try {
      return exec?.agent?.session?.deriveMessages?.() ?? []
    } catch {
      return []
    }
  }

  /**
   * 自画像条目的诊断视图（契约 §4.5）：把 `facet` 与取代链（`supersededBy` / `supersedes`）亮出来。
   * 记录本身存的就是这两个可选字段，运行期直接读；`facetOf` 负责存量兼容（无 facet → 'work'）。
   */
  const portraitRecordView = (record: MemoryRecord): Record<string, unknown> => {
    const fields = asPortrait(record)
    const view: Record<string, unknown> = {
      id: record.id,
      status: record.status,
      facet: facetOf(record),
      subject: record.subject,
      origin: record.origin,
      pinned: record.pinned,
      confidence: record.confidence,
      observedAt: new Date(record.observedAt).toISOString(),
      text: record.text,
    }
    // 「若有」：只有被取代过的旧条目才有 supersededBy，只有取代过别人的条目才有 supersedes
    if (fields.supersededBy) view.supersededBy = fields.supersededBy
    if (Array.isArray(record.supersedes) && record.supersedes.length > 0) view.supersedes = [...record.supersedes]
    return view
  }

  /** 自画像诊断：只读、绝不抛（memory_explain 的输出）。 */
  const portraitDiagnostics = (): Record<string, unknown> => {
    try {
      return {
        records: [...state.records.values()]
          .filter((record) => record.kind === 'agent_self')
          .sort(compareRecords)
          .slice(0, 20)
          .map(portraitRecordView),
        totals: {
          added: state.self.added,
          refined: state.self.refined,
          superseded: state.self.superseded,
          skipped: state.self.skipped,
        },
      }
    } catch (error) {
      return { records: [], error: errorText(error) }
    }
  }

  const tools: MemoryToolDefinition[] = [
    {
      name: 'memory_write',
      description: '写入一条长期记忆（用户偏好、项目约定、结论、做法）。写入来源由插件判定，不由本参数指定。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['user_profile', 'agent_self', 'project_gist', 'semantic', 'procedural', 'episodic'] },
          text: { type: 'string', description: '单句、面向模型可读的记忆内容' },
          subject: { type: 'string', description: '归一化主题键，用于去重与冲突判定，例如 editor.theme' },
          field: { type: 'string' },
          value: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          scopeLevel: { type: 'string', enum: ['profile', 'workspace', 'session'] },
          importance: { type: 'number' },
          pinned: { type: 'boolean' },
          facet: {
            type: 'string',
            enum: ['persona', 'work'],
            description: '仅 kind=agent_self 有意义：自画像面（persona=人格/表达，work=工作倾向），缺省 work。',
          },
        },
        required: ['kind', 'text'],
        additionalProperties: false,
      },
      execute: async (rawArgs, exec) => {
        const args = rawArgs as MemoryWriteArgs
        state.toolCalls.memory_write = (state.toolCalls.memory_write ?? 0) + 1
        const origin = cfg.trustToolWrites ? 'user_explicit' : deriveOriginFromMessages(toolMessages(exec))
        const scopeLevel = args.scopeLevel ?? defaultScopeFor(args.kind as MemoryKind)
        const scopeKey = scopeLevel === 'workspace' ? (workspaceKeyOf(exec?.agent?.session?.header?.cwd) ?? '*') : '*'
        // facet 只对 agent_self 有意义；其余类型一律不带（否则等于给普通记忆加了一个无意义的自画像字段）。
        // 注意这里**总是**给 agent_self 补上缺省 'work'：正是这个显式 facet 让写入走自画像收敛（契约 §4.1）。
        const facet = args.kind === 'agent_self' ? normalizeFacet(args.facet, 'work') : undefined
        const result = await writeMemory({
          kind: args.kind,
          text: args.text,
          subject: args.subject ?? null,
          field: args.field ?? null,
          value: args.value ?? null,
          tags: Array.isArray(args.tags) ? args.tags : [],
          importance: typeof args.importance === 'number' ? args.importance : undefined,
          pinned: args.pinned === true,
          origin,
          facet,
          scope: { level: scopeLevel, key: scopeKey },
          sessionId: exec?.agent?.session ? String(exec.agent.session.id) : undefined,
          source: exec?.agent?.session ? { sessionId: String(exec.agent.session.id), seqStart: Number(exec.agent.session.seq ?? 0), seqEnd: Number(exec.agent.session.seq ?? 0) } : null,
        })
        return json(result)
      },
    },
    {
      name: 'memory_recall',
      description: '按查询或过滤条件检索长期记忆，返回带来源与重要度的条目。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          kind: { type: 'string', enum: ['user_profile', 'agent_self', 'project_gist', 'semantic', 'procedural', 'episodic'] },
          scopeLevel: { type: 'string', enum: ['profile', 'workspace', 'session'] },
          tag: { type: 'string' },
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (rawArgs) => {
        const args = rawArgs as MemoryRecallArgs
        state.toolCalls.memory_recall = (state.toolCalls.memory_recall ?? 0) + 1
        // 归档条目（设计稿 §4.4）只是不常驻注入，模型主动检索时应当可见
        const hits = recallRecords(state.records.values(), { ...(args ?? {}), includeArchived: true })
        markUsed(hits.map((hit) => hit.record))
        return jsonList('items', hits.map(({ record, score }) => ({
          id: record.id, kind: record.kind, scope: record.scope, origin: record.origin,
          text: record.text, pinned: record.pinned, score: Number(score.toFixed(3)),
          observedAt: new Date(record.observedAt).toISOString(),
        })))
      },
    },
    {
      name: 'memory_list',
      description: '列出长期记忆（不做相关性打分，按确定性顺序）。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['user_profile', 'agent_self', 'project_gist', 'semantic', 'procedural', 'episodic'] },
          status: { type: 'string', enum: ['active', 'invalid', 'archived', 'all'] },
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (rawArgs) => {
        const args = rawArgs as MemoryListArgs
        state.toolCalls.memory_list = (state.toolCalls.memory_list ?? 0) + 1
        const status = args?.status ?? 'active'
        const rows = [...state.records.values()]
          .filter((record) => (status === 'all' ? true : record.status === status))
          .filter((record) => (args?.kind ? record.kind === args.kind : true))
          .sort(compareRecords)
          .slice(0, Math.max(1, Math.min(100, args?.limit ?? 50)))
        return jsonList('items', rows.map((record) => ({
          id: record.id, kind: record.kind, status: record.status, origin: record.origin,
          scope: record.scope, pinned: record.pinned, importance: record.importance, text: record.text,
        })))
      },
    },
    {
      name: 'memory_forget',
      description: '删除长期记忆。给 id 前缀直接删；给 query 时默认只预览命中，需要 confirm=true 才真正删除。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          query: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      execute: async (rawArgs) => {
        const args = rawArgs as MemoryForgetArgs
        state.toolCalls.memory_forget = (state.toolCalls.memory_forget ?? 0) + 1
        if (args?.id) {
          const target = [...state.records.values()].find((record) => record.id === args.id || record.id.startsWith(args.id as string))
          if (!target) return json({ ok: false, error: 'not_found' })
          // 落盘失败必须如实回报：否则「已删除」的条目重启后会复活。
          if (!(await remove(target.id))) return json({ ok: false, error: 'delete_failed', id: target.id, detail: state.openError })
          state.writes.deleted += 1
          flush()
          return json({ ok: true, deleted: [target.id], text: target.text })
        }
        if (args?.query) {
          // 破坏性操作：词面覆盖率必须 ≥ 0.6，宁可少删不可错删。
          const hits = recallRecords(state.records.values(), { query: args.query, limit: 20, minLexical: 0.6 }, Date.now())
          if (!args.confirm) {
            return jsonList('matches', hits.map(({ record }) => ({ id: record.id, text: record.text })), { ok: false, needsConfirm: true })
          }
          const deleted: string[] = []
          for (const { record } of hits) {
            if (await remove(record.id)) deleted.push(record.id)
          }
          const failed = hits.length - deleted.length
          state.writes.deleted += deleted.length
          flush()
          if (failed > 0) return json({ ok: false, error: 'delete_failed', deleted, failed, detail: state.openError })
          return json({ ok: true, deleted })
        }
        return json({ ok: false, error: 'provide id or query' })
      },
    },
    {
      name: 'memory_stats',
      description: '查看长期记忆的运行时可观测信息：条数、写入/拒绝计数、注入行数、渲染耗时、整合与召回状态。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        state.toolCalls.memory_stats = (state.toolCalls.memory_stats ?? 0) + 1
        return json(handlers.stats())
      },
    },
    {
      name: 'memory_maintain',
      description: '整理长期记忆：合并同主题的重复条目、把矛盾条目标记为失效、按衰减归档。后台会定期自动执行，这里用于手动触发。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        state.toolCalls.memory_maintain = (state.toolCalls.memory_maintain ?? 0) + 1
        await consolidate('manual')
        return json({
          ok: true,
          last: state.consolidate.last,
          totals: {
            runs: state.consolidate.runs,
            merged: state.consolidate.merged,
            archived: state.consolidate.archived,
            invalidated: state.consolidate.invalidated,
            summarized: state.consolidate.summarized,
          },
        })
      },
    },
    {
      name: 'memory_explain',
      description: '诊断：给定一段文本，说明长期记忆会怎么处理它（命中哪条信号、被哪条排除规则拒绝、会写成什么记录）。apply=true 时真的写入。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '待诊断的文本（通常是一句用户消息）' },
          apply: { type: 'boolean', description: '默认 false，只解释不写入' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async (rawArgs, exec) => {
        const args = rawArgs as MemoryExplainArgs
        state.toolCalls.memory_explain = (state.toolCalls.memory_explain ?? 0) + 1
        const { candidates, skipped } = extractCandidates(String(args?.text ?? ''), cfg)
        const candidateViews = candidates.map((candidate) => {
          const view: Record<string, unknown> = {
            signal: candidate.signal, kind: candidate.kind, origin: candidate.origin,
            confidence: candidate.confidence, importance: candidate.importance, text: candidate.text,
          }
          // 契约 §4.5：输出带 facet。只有 agent_self 有意义；捕获候选不带 facet → 存量兼容按 'work'。
          if (candidate.kind === 'agent_self') view.facet = normalizeFacet(undefined, 'work')
          return view
        })
        if (args?.apply !== true) {
          return jsonList('candidates', candidateViews, { skipped, portrait: portraitDiagnostics() })
        }
        const origin = cfg.trustToolWrites ? 'user_explicit' : deriveOriginFromMessages(toolMessages(exec))
        const written: Array<{ ok: boolean; status?: string; id?: string; error?: string; portrait?: PortraitOutcome }> = []
        for (const candidate of candidates) {
          const level = defaultScopeFor(candidate.kind)
          const result = await writeMemory({
            kind: candidate.kind,
            text: candidate.text,
            origin: candidate.origin === 'observed' ? origin : candidate.origin,
            confidence: candidate.confidence,
            importance: candidate.importance,
            tags: candidate.tags,
            sessionId: exec?.agent?.session ? String(exec.agent.session.id) : undefined,
            scope: { level, key: level === 'workspace' ? (workspaceKeyOf(exec?.agent?.session?.header?.cwd) ?? '*') : '*' },
          })
          written.push({ ok: result.ok, status: result.status, id: result.id, error: result.error, portrait: result.portrait })
        }
        // 诊断是**应用之后**再取一次：这样输出里能直接看到 supersede 的结果
        // （旧条目 status='archived' 且带 supersededBy，新条目带 facet）。
        return jsonList('candidates', candidateViews, { skipped, applied: true, written, portrait: portraitDiagnostics() })
      },
    },
  ]
  for (const tool of tools) {
    try {
      ctx.tools.register({ ...tool, output: toolOutput })
    } catch (error) {
      state.openError = `tool ${tool.name} register failed: ${errorText(error)}`
    }
  }
  flush()

  // ---------------- /memory 治理命令 ----------------
  const listLine = (record: MemoryRecord): string =>
    `${record.id.slice(0, 8)}  ${record.kind.padEnd(13)} ${record.scope.level.padEnd(9)}${record.pinned ? '★' : ' '} ${record.text}`

  const exportRecords = (targetPath?: string): string => {
    const dir = cfg.exportDir ?? (cfg.reportPath ? dirname(cfg.reportPath) : process.cwd())
    const file = targetPath && isAbsolute(targetPath) ? targetPath : join(dir, targetPath ?? `memory-export-${Date.now()}.json`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      domain: cfg.domainName,
      items: [...state.records.values()].filter((record) => record.status !== ('deleted' as MemoryRecord['status'])),
    }, null, 2))
    return file
  }

  const handlers: MemoryCommandHandlers = {
    list(args: string[]): DshCommandResult {
      const kind = args.find((part) => part.startsWith('--kind='))?.slice(7)
      const includeArchived = args.includes('--archived')
      const rows = [...state.records.values()]
        .filter((record) => record.status === 'active' || (includeArchived && record.status === 'archived'))
        .filter((record) => (kind ? record.kind === kind : true))
        .sort(compareRecords)
      if (rows.length === 0) return { kind: 'success', text: includeArchived ? '长期记忆为空。' : '没有 active 记忆（试试 /memory list --archived）。' }
      return { kind: 'success', text: `${rows.length} 条记忆：\n${rows.map((record) => `${listLine(record)}${record.status === 'archived' ? ' [archived]' : ''}`).join('\n')}` }
    },
    show(args: string[]): DshCommandResult {
      const id = args[0]
      if (!id) return { kind: 'error', text: '用法：/memory show <id 前缀>' }
      const record = [...state.records.values()].find((candidate) => candidate.id.startsWith(id))
      if (!record) return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` }
      return { kind: 'success', text: JSON.stringify(record, null, 2) }
    },
    async forget(args: string[]): Promise<DshCommandResult> {
      const id = args[0]
      if (!id) return { kind: 'error', text: '用法：/memory forget <id 前缀>' }
      const target = [...state.records.values()].find((record) => record.id.startsWith(id))
      if (!target) return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` }
      if (!(await remove(target.id))) return { kind: 'error', text: removeFailureText(target.id) }
      state.writes.deleted += 1
      flush()
      return { kind: 'success', text: `已删除 ${target.id}\n${target.text}` }
    },
    async restore(args: string[]): Promise<DshCommandResult> {
      const id = args[0]
      if (!id) return { kind: 'error', text: '用法：/memory restore <id 前缀>' }
      const target = [...state.records.values()].find((record) => record.id.startsWith(id))
      if (!target) return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` }
      target.status = 'active'
      target.invalidAt = null
      // 撤销推翻链：把当前正在推翻它的条目标为失效，否则下一次整合会立刻再推翻一次。
      const superseders = [...state.records.values()].filter((record) =>
        record.status === 'active' && record.id !== target.id && (record.supersedes ?? []).includes(target.id))
      for (const superseder of superseders) {
        superseder.status = 'invalid'
        superseder.invalidAt = Date.now()
        await persist(superseder)
      }
      await persist(target)
      return {
        kind: 'success',
        text: `已恢复 ${target.id}${superseders.length > 0 ? `（同时失效 ${superseders.length} 条推翻它的记录）` : ''}`,
      }
    },
    async pin(args: string[]): Promise<DshCommandResult> {
      const id = args[0]
      if (!id) return { kind: 'error', text: '用法：/memory pin <id 前缀>' }
      const target = [...state.records.values()].find((record) => record.id.startsWith(id))
      if (!target) return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` }
      target.pinned = !target.pinned
      await persist(target)
      return { kind: 'success', text: `${target.pinned ? '已固定' : '已取消固定'} ${target.id}` }
    },
    async archive(args: string[]): Promise<DshCommandResult> {
      const id = args[0]
      if (!id) return { kind: 'error', text: '用法：/memory archive <id 前缀>' }
      const target = [...state.records.values()].find((record) => record.id.startsWith(id))
      if (!target) return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` }
      target.status = 'archived'
      await persist(target)
      return { kind: 'success', text: `已归档 ${target.id}（不再注入，但仍可检索）` }
    },
    export(args: string[]): DshCommandResult {
      try {
        const file = exportRecords(args[0])
        return { kind: 'success', text: `已导出 ${listActive(state.records.values()).length} 条到 ${file}` }
      } catch (error) {
        return { kind: 'error', text: `导出失败：${errorText(error)}` }
      }
    },
    search(args: string[]): DshCommandResult {
      const query = args.join(' ')
      if (query.length === 0) return { kind: 'error', text: '用法：/memory search <关键词>' }
      const hits = recallRecords(state.records.values(), { query, limit: 10, includeArchived: true })
      if (hits.length === 0) return { kind: 'success', text: `没有匹配「${query}」的记忆。` }
      return { kind: 'success', text: hits.map(({ record, score }) => `${record.id.slice(0, 8)}  ${score.toFixed(2)}  ${record.text}`).join('\n') }
    },
    async refresh(args: string[]): Promise<DshCommandResult> {
      const id = args[0]
      if (!id) return { kind: 'error', text: '用法：/memory refresh <id 前缀>' }
      const target = [...state.records.values()].find((record) => record.id.startsWith(id))
      if (!target) return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` }
      target.observedAt = Date.now()
      if (target.kind === 'project_gist') target.confidence = Math.min(0.6, (target.confidence ?? 0.5) + 0.05)
      await persist(target)
      return { kind: 'success', text: `已刷新 ${target.id}（衰减重新计时）` }
    },
    async confirm(args: string[]): Promise<DshCommandResult> {
      const id = args[0]
      if (!id) return { kind: 'error', text: '用法：/memory confirm <id 前缀>（把模型自评升级为用户确认）' }
      const target = [...state.records.values()].find((record) => record.id.startsWith(id))
      if (!target) return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` }
      target.origin = 'user_explicit'
      target.confidence = Math.max(0.9, target.confidence ?? 0)
      await persist(target)
      return { kind: 'success', text: `已确认 ${target.id}（origin → user_explicit，confidence ≥ 0.9）` }
    },
    async reject(args: string[]): Promise<DshCommandResult> {
      const id = args[0]
      if (!id) return { kind: 'error', text: '用法：/memory reject <id 前缀>（拒绝一条自我观察）' }
      const target = [...state.records.values()].find((record) => record.id.startsWith(id))
      if (!target) return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` }
      target.status = 'invalid'
      target.invalidAt = Date.now()
      state.rejectedHashes.add(target.hash)
      await persist(target)
      return { kind: 'success', text: `已拒绝 ${target.id}（同类自我观察不会再产生）` }
    },
    async clear(args: string[]): Promise<DshCommandResult> {
      const all = args.includes('--all')
      const confirmed = args.includes('--yes')
      const kindRaw = args.find((part) => part.startsWith('--kind='))?.slice(7)
      const scopeRaw = args.find((part) => part.startsWith('--scope='))?.slice(8)
      const usage = '用法：/memory clear --all --yes | /memory clear --kind=<kind> [--scope=<level>] --yes（多个条件按 AND 组合；--all 不能与其它条件同时使用）'
      if (!all && kindRaw === undefined && scopeRaw === undefined) return { kind: 'error', text: usage }
      // 枚举校验：拼错的 --kind/--scope 以前会静默匹配 0 条却回「已永久删除」。
      if (kindRaw !== undefined && !isMemoryKind(kindRaw)) {
        return { kind: 'error', text: `未知的 --kind=${kindRaw}（可用：${MEMORY_KINDS.join(' | ')}）。${usage}` }
      }
      if (scopeRaw !== undefined && !isScopeLevel(scopeRaw)) {
        return { kind: 'error', text: `未知的 --scope=${scopeRaw}（可用：${SCOPE_LEVELS.join(' | ')}）。${usage}` }
      }
      // `--all` 是「无条件全删」，与其它条件混用只会让人误判删除范围 —— 直接拒绝，不猜意图。
      if (all && (kindRaw !== undefined || scopeRaw !== undefined)) {
        return { kind: 'error', text: `--all 不能与 --kind/--scope 同时使用（前者是全部，后者是筛选）。${usage}` }
      }
      if (!confirmed) return { kind: 'error', text: '这是不可逆操作，请加 --yes 确认。' }
      const kind = kindRaw as MemoryKind | undefined
      const scope = scopeRaw as ScopeLevel | undefined
      // 多条件 **AND**（旧实现是 OR：`--kind=a --scope=b` 会删掉「所有 a」加上「所有 b」）。
      const victims = [...state.records.values()].filter((record) =>
        (all || (kind !== undefined && record.kind === kind)) && (scope === undefined || record.scope.level === scope))
      if (victims.length === 0) return { kind: 'success', text: '没有匹配的记忆，未删除任何条目。' }
      let deleted = 0
      let failed = 0
      for (const victim of victims) {
        if (await remove(victim.id)) deleted += 1
        else failed += 1
      }
      state.writes.deleted += deleted
      flush()
      // 失败条数如实汇报：落盘失败的条目重启后仍在，不能笼统说「已永久删除」。
      if (failed > 0) {
        return {
          kind: 'error',
          text: `已永久删除 ${deleted} 条；${failed} 条落盘失败（${state.openError ?? '未知错误'}），重启后仍在。`,
        }
      }
      return { kind: 'success', text: `已永久删除 ${deleted} 条记忆（不可恢复）。` }
    },
    async import(args: string[]): Promise<DshCommandResult> {
      const path = args[0]
      if (!path) return { kind: 'error', text: '用法：/memory import <导出文件路径>' }
      try {
        const doc = JSON.parse(readFileSync(path, 'utf8')) as { items?: unknown } | null
        const items = Array.isArray(doc?.items) ? doc.items : []
        let created = 0
        let skipped = 0
        let invalid = 0
        for (const item of items) {
          const row = item as Record<string, unknown> | null
          if (!row || typeof row !== 'object') { invalid += 1; continue }
          // 导入的是**数据副本**，不是用户当场的要求：所有来源/身份字段一律降级或校验，
          // 否则文件里一行 `origin: "user_explicit"` 就能铸造出「用户侧」条目，冲突时永不被推翻。
          if (!isMemoryKind(row.kind) || typeof row.text !== 'string' || row.text.trim().length === 0) { invalid += 1; continue }
          let scope: MemoryScope
          if (row.scope === undefined || row.scope === null) {
            const level = defaultScopeFor(row.kind)
            scope = { level, key: '*' }
          } else {
            const raw = row.scope as { level?: unknown; key?: unknown }
            if (typeof raw !== 'object' || !isScopeLevel(raw.level)) { invalid += 1; continue }
            scope = { level: raw.level, key: typeof raw.key === 'string' ? raw.key : '*' }
          }
          const result = await writeMemory({
            kind: row.kind,
            text: row.text,
            subject: typeof row.subject === 'string' ? row.subject : null,
            field: typeof row.field === 'string' ? row.field : null,
            value: typeof row.value === 'string' ? row.value : null,
            tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
            scope,
            // origin 一律 observed；pinned 一律 false（导入的 pinned 会永久免疫衰减与归档）。
            origin: 'observed',
            confidence: clamp01(row.confidence),
            importance: clamp01(row.importance),
            pinned: false,
          })
          if (result.ok && result.status === 'created') created += 1
          else skipped += 1
        }
        return {
          kind: 'success',
          text: `导入完成：新建 ${created} 条，跳过/合并 ${skipped} 条，非法条目 ${invalid} 条（文件 ${path}）。`
            + '导入条目按 observed 处理：origin 一律降级、pinned 强制关闭、confidence/importance 夹到 [0,1]，不会获得用户侧身份。',
        }
      } catch (error) {
        return { kind: 'error', text: `导入失败：${errorText(error)}` }
      }
    },
    stats(): DshCommandResult {
      const byKind: Record<string, number> = {}
      for (const record of state.records.values()) byKind[record.kind] = (byKind[record.kind] ?? 0) + 1
      return {
        kind: 'success',
        text: [
          `域：${cfg.domainName}（opened=${state.opened}${state.openError ? `, error=${state.openError}` : ''}）`,
          `记录数：${state.records.size}（active ${listActive(state.records.values()).length}，播种 ${state.seeded}）`,
          `按类型：${JSON.stringify(byKind)}`,
          `写入：创建 ${state.writes.created} / 合并 ${state.writes.merged} / 拒写 ${state.writes.rejected} / 删除 ${state.writes.deleted}`,
          `工具调用：${JSON.stringify(state.toolCalls)}`,
          `渲染：context=${state.renders.context} section=${state.renders.section}，耗时 last=${state.renderMs.last}ms max=${state.renderMs.max}ms`,
          `注入：context=${state.injected.context.length} 行 / section=${state.injected.section.length} 行`,
          `自画像：新增 ${state.self.added} / 更新 ${state.self.refined} / 取代 ${state.self.superseded} / 跳过 ${state.self.skipped}`
            + `；反思提醒 ${state.self.reflections} 次（最近回合 ${state.self.lastReflectTurn ?? '-'}）`,
          `turn-stopping：plain=${state.turnStopping.plain}${state.turnStopping.last ? `，last=${state.turnStopping.last.at}（${state.turnStopping.last.channel}）` : '，last=none'}`,
          `设置页：${settingsLine()}`,
        ].join('\n'),
      }
    },
    async consolidate(): Promise<DshCommandResult> {
      await consolidate('manual')
      const last: Partial<ConsolidateSummary> = state.consolidate.last ?? {}
      return {
        kind: 'success',
        text: `整合完成：合并 ${last.merged ?? 0}，冲突失效 ${last.invalidated ?? 0}，归档 ${last.archived ?? 0}，摘要 ${last.summarized ?? 0}，耗时 ${last.ms ?? 0}ms${last.error ? `（错误：${last.error}）` : ''}`,
      }
    },
    /**
     * `/memory self …`（契约 §4.3）：自画像的查看/设定/修订历史/重置。
     * 全部中文输出；`set` 走 `writeMemory`（因此同样经过自画像收敛与用户所有物保护）。
     */
    async self(args: string[]): Promise<DshCommandResult> {
      const SELF_USAGE = '用法：/memory self [list] | self set <persona|work> <正文> | self history [subject] | self reset [persona|work]'
      const sub = (args[0] ?? 'list').toLowerCase()

      // 自画像条目：kind=agent_self，facet 走 facetOf（无 facet 的存量条目按 'work'）
      const portraitRows = (facet?: SelfFacet, status: MemoryRecord['status'] = 'active'): MemoryRecord[] =>
        [...state.records.values()]
          .filter((record) => record.kind === 'agent_self' && record.status === status)
          .filter((record) => (facet ? facetOf(record) === facet : true))
          .sort(compareRecords)

      const line = (record: MemoryRecord): string =>
        `${record.id.slice(0, 8)}  ${record.origin.padEnd(15)}${record.pinned ? '★' : ' '} conf=${record.confidence.toFixed(2)}  ${clampText(record.text, cfg.maxItemTokens, cfg.charsPerToken)}`

      if (sub === 'list' || sub === '' || args.length === 0) {
        const persona = portraitRows('persona')
        const work = portraitRows('work')
        const archived = [...state.records.values()].filter((record) => record.kind === 'agent_self' && record.status !== 'active').length
        if (persona.length === 0 && work.length === 0) {
          return {
            kind: 'success',
            text: '自画像为空。\n'
              + '模型可以随时用 memory_write（kind=agent_self, facet=persona|work）记录对自己的认识；\n'
              + '你也可以直接设定：/memory self set persona <正文>。'
              + (archived > 0 ? `\n（另有 ${archived} 条已归档，用 /memory self history 查看修订链。）` : ''),
          }
        }
        const block = (title: string, rows: MemoryRecord[]): string =>
          `[${title}]${rows.length === 0 ? '（空）' : ` ${rows.length} 条`}\n${rows.map(line).join('\n')}`
        return {
          kind: 'success',
          text: [
            block('人格 · 模型对自身的认知', persona),
            block('工作倾向', work),
            archived > 0 ? `（另有 ${archived} 条已归档：/memory self history）` : '',
          ].filter(Boolean).join('\n'),
        }
      }

      if (sub === 'set') {
        const facetRaw = (args[1] ?? '').toLowerCase()
        const text = args.slice(2).join(' ').trim()
        if (facetRaw !== 'persona' && facetRaw !== 'work') {
          return { kind: 'error', text: `facet 只能是 persona 或 work。${SELF_USAGE}` }
        }
        if (text.length === 0) return { kind: 'error', text: `缺少正文。${SELF_USAGE}` }
        const facet: SelfFacet = facetRaw
        // 用户直接设定：origin/pinned/confidence 按契约 §4.3 固定；收敛仍交给 planPortraitUpdate
        // （用户侧可以覆盖用户侧；模型侧条目会被这次设定 refine/supersede）。
        const result = await writeMemory({
          kind: 'agent_self',
          text,
          facet,
          subject: portraitSubjectFor(facet, 'general'),
          origin: 'user_explicit',
          pinned: true,
          confidence: 1,
          importance: 0.9,
          tags: ['self-portrait', 'user-set'],
        })
        if (!result.ok) return { kind: 'error', text: `未写入自画像：${result.error ?? '未知原因'}` }
        const action = result.portrait
          ? `（${result.portrait.action}: ${result.portrait.reason}）`
          : ''
        return {
          kind: 'success',
          text: result.status === 'merged'
            ? `已更新既有自画像条目 ${String(result.id).slice(0, 8)}${action}\n${result.record?.text ?? text}`
            : `已写入自画像（${facet}）${String(result.id).slice(0, 8)}${action}\n${result.record?.text ?? text}`,
        }
      }

      if (sub === 'history') {
        const filter = (args[1] ?? '').trim().toLowerCase()
        let revisions: ReturnType<typeof portraitHistory>
        try {
          revisions = portraitHistory(state.records.values())
        } catch (error) {
          return { kind: 'error', text: `读取修订链失败：${errorText(error)}` }
        }
        const matched = filter.length === 0
          ? revisions
          : revisions.filter((revision) => revision.subject.toLowerCase().includes(filter))
        if (matched.length === 0) {
          return { kind: 'success', text: filter.length === 0 ? '自画像还没有修订记录。' : `没有匹配「${filter}」的自画像修订链。` }
        }
        const blocks = matched.map((revision) => {
          const lines = revision.chain.map((record, index) => {
            // 归档时间：优先取「取代它的那条新记录」的 observedAt（真正发生取代的时刻），
            // 其次 invalidAt；两者都没有（如 /memory self reset 直接归档）时标注为未知。
            const successor = revision.chain.slice(index + 1).find((next) => (next.supersedes ?? []).includes(record.id))
            const archivedAt = record.status === 'archived'
              ? (successor ? new Date(successor.observedAt).toISOString() : (record.invalidAt ? new Date(record.invalidAt).toISOString() : null))
              : null
            const when = new Date(record.observedAt).toISOString()
            const flag = record.status === 'archived' ? ` [archived${archivedAt ? ` @ ${archivedAt}` : ''}]` : ''
            return `${index === revision.chain.length - 1 ? '→' : ' '} ${record.id.slice(0, 8)}  ${when}  ${record.origin}${flag}  ${clampText(record.text, cfg.maxItemTokens, cfg.charsPerToken)}`
          })
          return `[${revision.subject} · ${revision.facet}]\n${lines.join('\n')}`
        })
        return { kind: 'success', text: `共 ${matched.length} 条修订链（旧 → 新）：\n${blocks.join('\n')}` }
      }

      if (sub === 'reset') {
        const facetRaw = (args[1] ?? '').toLowerCase()
        if (facetRaw !== '' && facetRaw !== 'persona' && facetRaw !== 'work') {
          return { kind: 'error', text: `facet 只能是 persona 或 work（省略则重置全部）。${SELF_USAGE}` }
        }
        const facet = facetRaw === '' ? undefined : (facetRaw as SelfFacet)
        const victims = portraitRows(facet)
        if (victims.length === 0) return { kind: 'success', text: '没有需要重置的自画像条目。' }
        let archived = 0
        for (const record of victims) {
          // 归档而非删除：历史与检索都还在（契约 §4.3）。
          record.status = 'archived'
          await persist(record)
          archived += 1
        }
        flush()
        return {
          kind: 'success',
          text: `已重置${facet ? `（${facet}）` : ''} ${archived} 条自画像：条目已归档、历史保留。`
            + '\n模型后续写入会重新开始（/memory self history 仍可查看旧条目）。',
        }
      }

      return { kind: 'error', text: `未知的 self 子命令「${sub}」。${SELF_USAGE}` }
    },
    help(): DshCommandResult {
      return { kind: 'success', text: '用法：/memory list [--kind=agent_self] | search <关键词> | show <id> | forget <id> | restore <id> | pin <id> | archive <id> | refresh <id> | confirm <id> | reject <id> | export [path] | import <path> | clear --all --yes | clear --kind=<kind> [--scope=<level>] --yes | self [list] | self set <persona|work> <正文> | self history [subject] | self reset [persona|work] | consolidate | stats | help' }
    },
  }

  try {
    ctx.commands.register({
      name: 'memory',
      description: '查看与管理长期记忆',
      input: { hint: 'list | show <id> | self | forget <id> | export | stats' },
      handler: async (invocation) => {
        const parts = String(invocation?.rawInput ?? '').trim().split(/\s+/u).filter(Boolean)
        const sub = parts.shift() ?? 'list'
        const handler = handlers[sub] ?? handlers.help
        try {
          return await handler(parts)
        } catch (error) {
          return { kind: 'error', text: `记忆命令失败：${errorText(error)}` }
        }
      },
    })
  } catch (error) {
    state.openError = `command register failed: ${errorText(error)}`
  }

  // 供其他插件/调试使用的最小服务面（不导出类型，M4 再考虑正式 seam）
  try {
    ;(ctx as DshPluginContextWithProvide).provide('memory', {
      list: (): MemoryRecord[] => [...state.records.values()],
      stats: (): { records: number; version: number; opened: boolean } => ({ records: state.records.size, version: state.collectionVersion, opened: state.opened }),
      recall: (options: RecallOptions) => recallRecords(state.records.values(), options),
      write: (input: WriteMemoryInput) => writeMemory(input),
      consolidate: (reason?: string) => consolidate(reason ?? 'manual'),
    })
  } catch { /* 可选 */ }

  // 打开领域；随后按需补跑一次整合（此处调用保证 consolidate 已定义）。
  void openDomain().then(() => {
    try {
      if (!state.opened || cfg.consolidateEnabled === false) return
      const lastAt = state.meta?.lastConsolidatedAt ?? 0
      const intervalMs = Math.max(1, cfg.consolidateIntervalMinutes ?? 30) * 60_000
      if (Date.now() - lastAt > intervalMs) void consolidate('startup')
    } catch { /* ignore */ }
  }).catch(() => { /* openDomain 内部已记录错误 */ })

  flush()
}

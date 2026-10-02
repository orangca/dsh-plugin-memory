// 领域类型 + DSH 宿主接缝的最小类型声明。
//
// 关于宿主接缝：本插件用到的服务（systemPrompt / storageDomain / tools / commands / agents / settings）
// 在 npm 上有同名包，但其发布版本比本机运行的 DSH 旧，类型并不匹配（详见 src/shims.d.ts 的说明）。
// 因此这里按**实测运行契约**声明「我们实际调用到的那一小块」，既让 TS 检查生效，也把假设写在明处。
// 每个接口都用 JSDoc 标注调用点，便于升级 DSH 时对照检查。

// ---------------------------------------------------------------- 领域模型

export type MemoryKind = 'user_profile' | 'agent_self' | 'project_gist' | 'episodic' | 'semantic' | 'procedural'
export type MemoryOrigin = 'user_explicit' | 'user_correction' | 'model_proposed' | 'observed'
export type MemoryStatus = 'active' | 'invalid' | 'archived'
export type MemoryPrecision = 'exact' | 'gist'
export type ScopeLevel = 'profile' | 'workspace' | 'session'

export interface MemoryScope {
  level: ScopeLevel
  key: string
}

/** 自动写入的来源指针：会话 + seq 区间（设计稿 I3：自动写入必须带来源）。 */
export interface MemorySource {
  sessionId: string
  seqStart: number
  seqEnd: number
}

/** 跨会话复现计数：模型自评晋升与「重复提及」都依赖它。 */
export interface MemoryReinforcement {
  sessions: string[]
  count: number
}

export interface MemoryRecord {
  id: string
  kind: MemoryKind
  precision: MemoryPrecision
  origin: MemoryOrigin
  scope: MemoryScope
  subject: string | null
  field: string | null
  value: string | null
  text: string
  tags: string[]
  source: MemorySource | null
  confidence: number
  importance: number
  pinned: boolean
  status: MemoryStatus
  invalidAt: number | null
  supersedes: string[]
  observedAt: number
  eventTime: number | null
  lastUsedAt: number | null
  useCount: number
  reinforcement: MemoryReinforcement
  hash: string
}

/** `makeRecord` 的输入：除 kind/text 外都可省略，缺失时按类型默认值补齐。 */
export interface MakeRecordInput {
  id?: string
  kind: MemoryKind
  precision?: MemoryPrecision
  origin?: MemoryOrigin
  scope?: MemoryScope
  subject?: string | null
  field?: string | null
  value?: string | null
  text: string
  tags?: string[]
  source?: MemorySource | null
  confidence?: number
  importance?: number
  pinned?: boolean
  status?: MemoryStatus
  supersedes?: string[]
  observedAt?: number
  eventTime?: number | null
  lastUsedAt?: number | null
  useCount?: number
  reinforcement?: MemoryReinforcement
  /** 写入来源会话 id：用于 `reinforcement.sessions` 与「重复提及」判定。 */
  sessionId?: string
}

/** 召回命中：`match` 是相关性判定值，`score` 是排序分。 */
export interface RecallHit {
  record: MemoryRecord
  match: number
  score: number
}

export interface RecallOptions {
  query?: string
  kind?: MemoryKind
  scopeLevel?: ScopeLevel
  tag?: string
  limit?: number
  mode?: 'query' | 'memory'
  minLexical?: number
  minMatch?: number
  minHits?: number
  includeArchived?: boolean
}

/** 自动捕获抽出的候选（`extractCandidates` 的返回值）。 */
export interface CaptureCandidate {
  kind: MemoryKind
  text: string
  origin: MemoryOrigin
  confidence: number
  importance: number
  tags: string[]
  hash: string
  /** 命中的信号名，后续用于派生 subject 前缀。 */
  signal: string
}

/** 配置：与 `DEFAULTS` 一一对应；patch 行可只给子集。 */
export interface MemoryConfig {
  domainName: string
  maxInjectedTokens: number
  maxItemTokens: number
  selfPortraitMaxTokens: number
  selfPortraitMaxItems: number
  selfPortraitMaxSelfObserved: number
  gistBudgetRatio: number
  charsPerToken: number
  sectionOrder: number
  contextOrder: number
  seed: boolean
  reportPath: string | null
  trustToolWrites: boolean
  captureMode: 'off' | 'rule'
  piiPolicy: 'mask' | 'reject'
  repeatMentionBoost: number
  captureMaxPerTurn: number
  captureMinConfidence: number
  capturePerHour: number
  captureTimeoutMs: number
  echoThreshold: number
  gistMinMarkers: number
  selfPortraitMinConfidence: number
  selfPortraitModelMinConfidence: number
  selfPortraitPromoteSessions: number
  consolidateEnabled: boolean
  consolidateIntervalMinutes: number
  consolidateMaxRecords: number
  mergeSimilarity: number
  archiveAfterDays: number
  archiveBelowImportance: number
  summarizeAbove: number
  solidificationMaxPerCompaction: number
  autoRecall: boolean
  recallMode: 'off' | 'dry' | 'inject'
  recallTopK: number
  recallMinQueryChars: number
  recallMinHits: number
  recallMinMatch: number
  recallCooldownTurns: number
  recallBudgetMs: number
  /** `/memory export` 的默认导出目录（仅 patch 行）。 */
  exportDir?: string
  /** 故障注入开关，供故障隔离测试使用（仅 patch 行）。 */
  simulateCaptureError?: boolean
  /** 开发期由部署脚本注入的修订号（非出厂配置）。 */
  revision?: number
}

/** 渲染结果：注入的行、被选中的记录（记用量的唯一真源）与最终文本。 */
export interface RenderedBlock {
  lines: string[]
  selected: MemoryRecord[]
  text: string
}

// ---------------------------------------------------------------- DSH 宿主接缝

export type DshDisposable = () => void

/** `ctx.storageDomain.open(spec)` 返回的领域句柄；**调用方负责 close()**。 */
export interface DshDomainTable<T> {
  entries(): Iterable<[string, T] | T>
  get(key: string): T | undefined | Promise<T | undefined>
  put(key: string, value: T): Promise<void> | void
  delete(key: string): Promise<void> | void
}

export interface DshDomainGlobal {
  get(): unknown | Promise<unknown>
  /**
   * 写水位。**实测契约是 `set` 而不是 `put`**：`$DSH_HOME/storages/<domain>/global.json`
   * 里确实出现了我们写入的 `lastConsolidatedAt` / `collectionVersion`，说明这条路径有效。
   */
  set(value: unknown): Promise<void> | void
}

export interface DshDomain {
  table<T>(name: string): DshDomainTable<T>
  global: DshDomainGlobal
  close(): Promise<void> | void
}

export interface DshStorageDomain {
  open(spec: {
    name: string
    version: number
    layout: 'per-record' | 'single'
    tables: Record<string, unknown>
    global?: unknown
  }): Promise<DshDomain>
}

/** `ctx.systemPrompt.section/context`：常驻注入的两条通道。 */
export interface DshSystemPrompt {
  section(options: { name: string; order: number; text: () => string }): DshDisposable
  context(options: {
    name: string
    order: number
    text: (assembleContext: DshAssembleContext) => string
  }): DshDisposable
}

export interface DshAssembleContext {
  agent?: { session?: { header?: { cwd?: string | null } } }
}

/** `ctx.tools.register()` 的执行期第二个实参（运行版提供）。 */
export interface DshToolExecution {
  agent?: DshAgent & { session?: DshSession }
}

/** `ctx.tools.register()`：原生 JSON Schema 工具（`output` 必填）。 */
export interface DshToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: Record<string, unknown>
  execute: (args: Record<string, unknown>, execution?: DshToolExecution) => Promise<unknown> | unknown
}

export interface DshTools {
  register(definition: DshToolDefinition): DshDisposable
}

/** `/memory` 的调用对象。 */
export interface DshCommandInvocation {
  rawInput?: string
}

/** 命令返回值：kind 决定渲染成成功还是错误提示。 */
export interface DshCommandResult {
  kind: 'success' | 'error'
  text: string
}

export interface DshCommands {
  register(definition: {
    name: string
    description: string
    input?: { hint?: string }
    handler: (invocation: DshCommandInvocation) => Promise<DshCommandResult> | DshCommandResult
  }): DshDisposable
}

/** 会话/agent 的最小视图（我们只做身份比较与 seq 读取）。 */
export interface DshSession {
  id?: string
  seq?: number
  header?: { cwd?: string | null }
  /** 运行版在工具 execute 的第二个实参里提供：把会话历史派生成消息列表。 */
  deriveMessages?: () => unknown
}

export interface DshAgent {
  session: DshSession
}

export interface DshAgents {
  roots(): unknown[]
}

/** settings 服务的页面策略（值以访问器对象下发，见 src/shims.d.ts 的说明）。 */
export interface DshSettings {
  configure(presentation: { auto?: boolean }): DshDisposable
  describe(): Array<Record<string, unknown>>
}

export interface DshLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/** `agent/turn-stopping` 的载荷。 */
export interface DshTurnStoppingPayload {
  agent?: DshAgent
}

/** `agent/pre-step` 的 waterfall：`next()` 返回决策对象，原样交回即可。 */
export type DshPreStepNext = () => Promise<unknown>

/**
 * 插件拿到的 ctx：只声明本插件实际使用到的成员。
 * 与服务包的真实类型不同名，避免与「发布版类型」产生虚假的一致性。
 */
export interface DshPluginContext {
  logger?: DshLogger
  systemPrompt: DshSystemPrompt
  storageDomain: DshStorageDomain
  tools: DshTools
  commands: DshCommands
  agents: DshAgents
  effect(callback: () => DshDisposable | void, label?: string): DshDisposable
  on(event: 'session/event', listener: (session: DshSession, event: { type?: string; [key: string]: unknown }) => void): DshDisposable
  on(event: 'agent/turn-stopping', listener: (payload: DshTurnStoppingPayload) => Promise<void> | void): DshDisposable
  on(event: 'agent/pre-step', listener: (payload: unknown, next: DshPreStepNext) => Promise<unknown>): DshDisposable
  get<T = unknown>(service: string): T | undefined
  /**
   * 作用域注入：服务就绪时才执行回调，服务消失时自动清理回调内的注册。
   * 回调拿到的作用域比根 ctx 更窄 —— 这里声明本插件实际用到的那个成员。
   */
  inject(services: string[], callback: (scope: DshPluginContext & { settings?: DshSettings }) => void): unknown
  /** 对外提供服务（本插件用它暴露 memory 服务）。 */
  provide(name: string, service: unknown): void
}

// dsh-memory 纯函数层：可单独单测，不依赖 Cordis ctx。
// 设计依据：dsh-memory-plugin-design-detail.md §4（记录与判定）、§5.3（预算）、§6（检索）、§7（注入）。

import type {
  CaptureCandidate,
  MakeRecordInput,
  MemoryConfig,
  MemoryKind,
  MemoryOrigin,
  MemoryRecord,
  MemoryScope,
  RecallHit,
  RecallOptions,
  RenderedBlock,
  ScopeLevel,
  SelfFacet,
} from './types.js'

// 一并转出领域类型，方便调用方与单测只从 lib.js / lib.d.ts 取全部符号。
export type {
  CaptureCandidate,
  MakeRecordInput,
  MemoryConfig,
  MemoryKind,
  MemoryOrigin,
  MemoryRecord,
  MemoryScope,
  RecallHit,
  RecallOptions,
  RenderedBlock,
  ScopeLevel,
  SelfFacet,
} from './types.js'

// ------------------------------------------------- lib.ts 内联类型（types.ts 缺口）

/** `makeRecord` 的入参：`MakeRecordInput` 再加 `sessionId`（types.ts 目前缺这个字段）。 */
export interface MakeRecordInputWithSession extends MakeRecordInput {
  sessionId?: string
}

/** 指纹入参：只需要指纹相关字段，因此「尚未补上 hash 的记录」也能直接求指纹。 */
export interface RecordHashInput {
  kind: MemoryKind
  scope?: MemoryScope | null
  subject?: string | null
  text: string
}

/** `CAPTURE_SIGNALS` 的一行。 */
export interface CaptureSignal {
  id: string
  kind: MemoryKind
  origin: MemoryOrigin
  confidence: number
  importance: number
  re: RegExp
}

/** `extractCandidates` 的返回值。 */
export interface ExtractCandidatesResult {
  candidates: CaptureCandidate[]
  skipped: Record<string, number>
}

/** `fillWithinBudget` 的返回值（没有块级文案，因此不复用 `RenderedBlock`）。 */
export interface BudgetFill<T> {
  lines: string[]
  used: number
  selected: T[]
}

/** `memoryMatch` 的可选参数。 */
export interface MemoryMatchOptions {
  minHits?: number
  matchCap?: number
}

/** `findConflicts` 的一条冲突：winner 拟取代 loser；`blocked` 为 true 时禁止这次自动推翻。 */
export interface ConflictEntry {
  winner: MemoryRecord
  loser: MemoryRecord
  blocked: boolean
}

/** `composeSubjectSummary` 产出的一条规则式摘要。 */
export interface SubjectSummary {
  key: string
  subject: string | null
  kind: MemoryKind
  scope: MemoryScope
  text: string
  absorbed: string[]
}

/** 消息内容块视图（`deriveOriginFromMessages` 只读 type/text）。 */
export interface MemoryMessageContentBlock {
  type?: string
  text?: string
}

/** 消息视图（宿主消息只保证这几处可用）。 */
export interface MemoryMessageLike {
  role?: string
  source?: { kind?: string } | null
  content?: unknown
}

/** compaction 摘要块视图（`extractSummaryText` 只读 type/text）。 */
export interface SummaryTextBlock {
  type?: string
  text?: string
}

export const DEFAULTS: MemoryConfig = {
  domainName: 'dsh_memory',
  maxInjectedTokens: 300,
  maxItemTokens: 60,
  selfPortraitMaxTokens: 120,
  selfPortraitMaxItems: 12,
  selfPortraitMaxSelfObserved: 4,
  // M6：自画像 v2（人格 + 工作两小节）
  selfPortraitEnabled: true,
  selfPersonaMaxTokens: 80,
  selfPortraitMergeThreshold: 0.6,
  selfReflectEnabled: true,
  selfReflectEveryTurns: 12,
  selfReflectMinTurn: 4,
  selfReflectMaxPerSession: 3,
  // M7：初次设定（称呼）—— 一次性，跨会话累计最多问 2 次
  selfIntroEnabled: true,
  selfIntroMinTurn: 2,
  selfIntroMaxAsks: 2,
  // M8：`/sleep` 空闲梳理（契约 docs/sleep.md §4.1）
  sleepEnabled: true,
  sleepSessions: 3,
  sleepMaxCharsPerSession: 120_000,
  sleepMaxCharsTotal: 300_000,
  sleepMaxBackfill: 20,
  sleepAssistantContext: 3,
  sleepMaxGists: 8,
  gistBudgetRatio: 0.3,
  charsPerToken: 2.5,
  sectionOrder: 9000,
  contextOrder: 60,
  // 出厂默认**不播种**：播种的演示记忆会被注入到真实用户的上下文里。
  // 开发期由 tools/deploy-dev.ts 显式传 seed: true。
  seed: false,
  reportPath: null,
  trustToolWrites: false,
  // M2：自动捕获
  captureMode: 'rule',
  // 个人信息处理：mask（脱敏后写入）| reject（拒写）
  piiPolicy: 'mask',
  // 同一件事在**新的会话**里再次被提到时，重要度提升的幅度（设计稿 §5.2「重复提及」）
  repeatMentionBoost: 0.1,
  captureMaxPerTurn: 3,
  captureMinConfidence: 0.6,
  capturePerHour: 20,
  captureTimeoutMs: 500,
  echoThreshold: 0.9,
  gistMinMarkers: 2,
  selfPortraitMinConfidence: 0.8,
  selfPortraitModelMinConfidence: 0.85,
  selfPortraitPromoteSessions: 2,
  // M3：整合治理
  consolidateEnabled: true,
  consolidateIntervalMinutes: 30,
  consolidateMaxRecords: 200,
  mergeSimilarity: 0.7,
  archiveAfterDays: 180,
  archiveBelowImportance: 0.15,
  summarizeAbove: 5,
  solidificationMaxPerCompaction: 3,
  // M4：R2 按轮召回
  autoRecall: true,
  recallMode: 'inject',
  recallTopK: 8,
  recallMinQueryChars: 12,
  recallMinHits: 2,
  recallMinMatch: 0.4,
  recallCooldownTurns: 3,
  recallBudgetMs: 10,
}

/** 显式祈使信号：命中表示「用户在明确要求记住」，决定写入来源为 user_explicit。 */
export const EXPLICIT_SIGNAL_RE: RegExp = /(记住|记一下|记下|帮我记|以后都|以后也|从现在起|别再|不要再用|下次要|remember|always|never)/iu

/** 敏感信息形态：命中即拒写（设计稿 §8.3，无 force 通道）。 */
const SENSITIVE_PATTERNS: Array<{ reason: string; re: RegExp }> = [
  { reason: 'api-key', re: /\b(sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/u },
  { reason: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/iu },
  { reason: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { reason: 'password', re: /(密码|口令|passwd|password)\s*[:：=]\s*\S{6,}/iu },
  { reason: 'cn-id', re: /\b\d{17}[0-9Xx]\b/u },
  { reason: 'bank-card', re: /\b(?:\d[ -]?){16,19}\b/u },
]

/** FNV-1a 短哈希：用于 workspace scope key 与去重指纹（稳定、无依赖）。 */
export function fnv1a(input: unknown): string {
  let hash = 0x811c9dc5
  const text = String(input)
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/** 归一化：全角转半角、折叠空白、英文小写、去尾部标点（用于指纹与去重）。 */
export function normalizeText(text: unknown): string {
  return String(text)
    .replace(/[\uFF01-\uFF5E]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?。！？,，;；]+$/u, '')
    .trim()
    .toLowerCase()
}

/** 廉价 token 估算：保守折中（中文约 1.5 字/token、英文约 4 字/token）。 */
export function estimateTokens(text: unknown, charsPerToken: number = DEFAULTS.charsPerToken): number {
  return Math.ceil(String(text).length / charsPerToken)
}

/**
 * 把文本压成**单行**并截断到预算内。
 *
 * 为什么必须压成单行：常驻块与召回块的结构是「块头 + 逐条 `- …` 行 + 块尾声明」，
 * 而记忆文本可能来自模型写入、含换行的用户消息、`/memory import` 或压缩摘要固化。
 * 若文本自带换行，就能伪造出额外的行 —— 包括伪造成块尾声明或 `[系统] …` 这类指令行
 * （实测：一条含换行的 user_profile 让「以当前对话为准」在块里出现两次）。
 * 因此这里把控制字符（含 \r\n\t\u0085）折成空格、连续空白折成一个空格，
 * 并剔除零宽与双向控制字符，保证**一条记忆 = 一行**。
 */
export function clampText(text: unknown, maxTokens: number, charsPerToken: number = DEFAULTS.charsPerToken): string {
  const flat = String(text)
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  // 有限性兜底：`maxItemTokens` 可能被 patch 行设成 Infinity（或 NaN），那样 `slice` 不截断，
  // 一条超长记忆会吃掉整个预算并让 `fillWithinBudget` 立刻 break，把后面的条目全挤掉。
  const tokenBudget = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULTS.maxItemTokens
  const perToken = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULTS.charsPerToken
  const maxChars = Math.max(8, Math.floor(tokenBudget * perToken))
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`
}

/** 去重指纹：kind|scope.level|scope.key|subject|归一化文本。
 *  必须含 `scope.key`：否则 A 项目里写的同一句话会被判成「B 项目已有」而合并到错误的 scope。 */
export function recordHash(record: RecordHashInput): string {
  return fnv1a([
    record.kind,
    record.scope?.level ?? '',
    record.scope?.key ?? '',
    record.subject ?? '',
    normalizeText(record.text),
  ].join('|'))
}

let idCounter = 0

/** 构造一条记忆记录（字段与设计稿 §4.1 对齐）。 */
export function makeRecord(input: MakeRecordInputWithSession, now: number = Date.now()): MemoryRecord {
  idCounter = (idCounter + 1) % 46656
  const record: MemoryRecord = {
    id: input.id ?? `m_${now.toString(36)}_${idCounter.toString(36)}${fnv1a(String(Math.random())).slice(0, 4)}`,
    kind: input.kind,
    precision: input.precision ?? 'exact',
    origin: input.origin ?? 'observed',
    scope: input.scope ?? { level: defaultScopeFor(input.kind), key: '*' },
    subject: input.subject ?? null,
    field: input.field ?? null,
    value: input.value ?? null,
    text: String(input.text ?? '').trim(),
    tags: input.tags ?? [],
    source: input.source ?? null,
    confidence: input.confidence ?? 0.6,
    importance: input.importance ?? 0.5,
    pinned: input.pinned ?? false,
    status: input.status ?? 'active',
    invalidAt: null,
    supersedes: input.supersedes ?? [],
    observedAt: input.observedAt ?? now,
    eventTime: input.eventTime ?? null,
    lastUsedAt: input.lastUsedAt ?? null,
    useCount: input.useCount ?? 0,
    // 复现追踪：用于「模型自评需跨 ≥2 个会话复现才晋升」的护栏（设计稿 §7.3）。
    reinforcement: input.reinforcement
      ?? { sessions: input.sessionId ? [String(input.sessionId)] : [], count: 0 },
    hash: '',
  }
  // M6：自画像小节的透传（可选字段；缺失时不写键，保持 0.5.x 的存量形状）。
  if (input.facet !== undefined) record.facet = normalizeFacet(input.facet, 'work')
  if (input.supersededBy !== undefined) record.supersededBy = String(input.supersededBy)
  record.hash = recordHash(record)
  return record
}

export function defaultScopeFor(kind: MemoryKind): ScopeLevel {
  if (kind === 'user_profile' || kind === 'agent_self') return 'profile'
  // project_gist / semantic / procedural / episodic：都与「某个项目」绑定，
  // 因此默认 workspace 级；session 级只用于显式指定的临时上下文，不进常驻注入。
  return 'workspace'
}

/** 确定性排序：pinned → importance → confidence → id（服务设计稿 I1）。 */
export function compareRecords(a: MemoryRecord, b: MemoryRecord): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if (b.importance !== a.importance) return b.importance - a.importance
  if (b.confidence !== a.confidence) return b.confidence - a.confidence
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function listActive(records: Iterable<MemoryRecord>): MemoryRecord[] {
  return [...records].filter((record) => record.status === 'active')
}

export function workspaceKeyOf(cwd: unknown): string | null {
  return typeof cwd === 'string' && cwd.length > 0 ? fnv1a(cwd) : null
}

/** 按 token 预算逐条填充（设计稿 §7.2）。返回选中的条目，便于调用方记用量。 */
export function fillWithinBudget(
  records: Iterable<MemoryRecord>,
  budgetTokens: number,
  render: (record: MemoryRecord, text: string) => string,
  cfg: MemoryConfig,
): BudgetFill<MemoryRecord> {
  const lines: string[] = []
  const selected: MemoryRecord[] = []
  let used = 0
  for (const record of records) {
    const text = clampText(record.text, cfg.maxItemTokens, cfg.charsPerToken)
    const line = render(record, text)
    const cost = estimateTokens(line, cfg.charsPerToken)
    if (used + cost > budgetTokens) break
    lines.push(line)
    selected.push(record)
    used += cost
  }
  return { lines, used, selected }
}

/** 自画像准入（设计稿 §7.3）：用户侧来源直接进；模型自评必须跨 ≥N 个不同会话复现。 */
export function isSelfPortraitEligible(record: MemoryRecord, cfg: MemoryConfig): boolean {
  if (record.status !== 'active') return false
  if (record.origin === 'user_explicit' || record.origin === 'user_correction') {
    return record.confidence >= (cfg.selfPortraitMinConfidence ?? 0.8)
  }
  if (record.origin === 'model_proposed') {
    const sessions = record.reinforcement?.sessions?.length ?? 0
    return record.confidence >= (cfg.selfPortraitModelMinConfidence ?? 0.85)
      && sessions >= (cfg.selfPortraitPromoteSessions ?? 2)
  }
  return false
}

/** 自画像块（section 通道）：**人格小节在前**，工作两节在后（M6 §3）。
 *
 *  · 人格小节（`facet='persona'`）用独立预算 `cfg.selfPersonaMaxTokens`；块内**用户侧优先**，
 *    模型自评只吃余额，两组的条数各自受 `cfg.selfPortraitMaxSelfObserved` 约束；
 *    页脚是安全声明（描述而非指令），因此只要小节非空就必须带页脚。
 *  · 工作两节（`facet` 缺失 → `'work'`，存量兼容）沿用 0.5.x 的文案与预算口径：
 *    两节共享 `cfg.selfPortraitMaxTokens`，用户确认的约定优先，总长（含块头页脚）不超上限。
 */
export function renderSelfBlock(records: Iterable<MemoryRecord>, cfg: MemoryConfig): RenderedBlock {
  if (cfg.selfPortraitEnabled === false) return { lines: [], selected: [], text: '' }

  const eligible = listActive(records)
    .filter((record) => record.kind === 'agent_self')
    .filter((record) => isSelfPortraitEligible(record, cfg))
    .sort(compareRecords)

  const personaRecords = eligible.filter((record) => facetOf(record) === 'persona')
  const workRecords = eligible.filter((record) => facetOf(record) === 'work')
  const maxSelfObserved = cfg.selfPortraitMaxSelfObserved ?? 4

  // ---- 人格小节（在前）
  const personaBudget = cfg.selfPersonaMaxTokens ?? DEFAULTS.selfPersonaMaxTokens
  // 块头尾也要计入预算，否则「硬上限」会被块级固定文案突破
  const personaChrome = estimateTokens(`${PERSONA_HEADER}\n${PERSONA_FOOTER}`, cfg.charsPerToken)
  const personaUser = fillWithinBudget(
    personaRecords.filter((record) => isUserSideOrigin(record.origin)).slice(0, maxSelfObserved),
    Math.max(0, personaBudget - personaChrome),
    (_record, text) => `- ${text}`,
    cfg,
  )
  const personaObserved = fillWithinBudget(
    personaRecords.filter((record) => record.origin === 'model_proposed').slice(0, maxSelfObserved),
    Math.max(0, personaBudget - personaChrome - personaUser.used),
    (_record, text) => `- ${text}`,
    cfg,
  )

  // ---- 工作两节（在后，沿用既有文案与预算分配）
  const userSide = workRecords.filter((record) => isUserSideOrigin(record.origin))
  // 模型自评单独限配额：不能挤掉用户定下的规矩（设计稿 §7.3）
  const selfObserved = workRecords
    .filter((record) => record.origin === 'model_proposed')
    .slice(0, maxSelfObserved)

  // 分配顺序按设计稿 §7.3：**用户确认的规矩优先**，模型自评只吃剩下的余额；
  // 两段合计（含两个块头与页脚）不超过 selfPortraitMaxTokens。
  const confirmed = fillWithinBudget(
    userSide.slice(0, cfg.selfPortraitMaxItems),
    Math.max(0, cfg.selfPortraitMaxTokens - estimateTokens(WORK_CONFIRMED_HEADER, cfg.charsPerToken)),
    (_record, text) => `- ${text}`,
    cfg,
  )
  const observed = selfObserved.length === 0
    ? { lines: [] as string[], selected: [] as MemoryRecord[], used: 0 }
    : fillWithinBudget(
      selfObserved,
      Math.max(0, cfg.selfPortraitMaxTokens
        - estimateTokens(`${WORK_CONFIRMED_HEADER}${WORK_OBSERVED_HEADER}${WORK_OBSERVED_FOOTER}`, cfg.charsPerToken)
        - confirmed.used),
      (_record, text) => `- ${text}`,
      cfg,
    )

  const personaLines = [...personaUser.lines, ...personaObserved.lines]
  const blocks: string[] = []
  if (personaLines.length > 0) blocks.push([PERSONA_HEADER, ...personaLines, PERSONA_FOOTER].join('\n'))
  if (confirmed.lines.length > 0) blocks.push([WORK_CONFIRMED_HEADER, ...confirmed.lines].join('\n'))
  if (observed.lines.length > 0) blocks.push([WORK_OBSERVED_HEADER, ...observed.lines, WORK_OBSERVED_FOOTER].join('\n'))

  return {
    lines: [...personaLines, ...confirmed.lines, ...observed.lines],
    selected: [...personaUser.selected, ...personaObserved.selected, ...confirmed.selected, ...observed.selected],
    text: blocks.join('\n\n'),
  }
}

/** 召回块（context 通道）：用户画像/事实 + 当前 workspace 的项目模糊印象。
 *  常驻注入只收 profile 级与「当前 workspace」级；session 级属于临时上下文，永不常驻。 */
export function renderContextBlock(records: Iterable<MemoryRecord>, cfg: MemoryConfig, workspaceKey: string | null): RenderedBlock {
  const candidates = listActive(records)
    .filter((record) => record.kind !== 'agent_self')
    // 常驻层不放情景记忆（episodic 的常驻上限是 0，设计稿 §4.4）与整合摘要（摘要只供检索）
    .filter((record) => record.kind !== 'episodic')
    .filter((record) => !(record.tags ?? []).includes('summary'))
    .filter((record) => record.scope.level === 'profile'
      || (record.scope.level === 'workspace' && record.scope.key === workspaceKey))
    .sort(compareRecords)

  const facts = candidates.filter((record) => record.kind !== 'project_gist')
  const gists = candidates.filter((record) => record.kind === 'project_gist')

  // 块内的固定文案也算 token，否则「硬上限」会被它们突破
  const FACTS_HEADER = '[长期记忆 · 自动注入]'
  const FACTS_FOOTER = '以上为历史记录，可能过时或有误；与当前情况冲突时先核对事实，以事实与实际效果为准。'
  const GIST_HEADER = '[项目印象 · 模糊且可能过时]'
  const GIST_FOOTER = '以上为自动观察形成的模糊印象，不是精确事实；与当前代码/对话冲突时以实际为准。'

  const gistBudget = Math.max(40, Math.floor(cfg.maxInjectedTokens * cfg.gistBudgetRatio))
  const factsBudget = Math.max(0, cfg.maxInjectedTokens
    - estimateTokens(`${FACTS_HEADER}\n${FACTS_FOOTER}`, cfg.charsPerToken)
    - (gists.length > 0 ? estimateTokens(`${GIST_HEADER}\n${GIST_FOOTER}`, cfg.charsPerToken) : 0))

  const head = fillWithinBudget(
    facts,
    factsBudget,
    (record, text) => `- (${record.scope.level}) ${text}`,
    cfg,
  )
  const gist = fillWithinBudget(
    gists,
    gistBudget,
    (_record, text) => `- ${text}`,
    cfg,
  )

  const blocks: string[] = []
  if (head.lines.length > 0) {
    blocks.push([FACTS_HEADER, ...head.lines, FACTS_FOOTER].join('\n'))
  }
  if (gist.lines.length > 0) {
    blocks.push([GIST_HEADER, ...gist.lines, GIST_FOOTER].join('\n'))
  }
  return {
    lines: [...head.lines, ...gist.lines],
    selected: [...head.selected, ...gist.selected],
    text: blocks.join('\n\n'),
  }
}

/**
 * 宽度折叠视图（NFKC）：**只用于判定**，不用于存储。
 *
 * 为什么必须折叠：半角正则匹配不到全角写法，而 `normalizeText`（注入/检索前会用）却会把
 * 全角 U+FF01–FF5E 折回半角 —— 于是「用全角写的身份证/卡号」既能绕过拒写，又会在注入时
 * 变回合法号码进系统提示。扫描与 PII 判定先折叠，才能让两种写法一视同仁。
 */
function foldWidth(value: unknown): string {
  return String(value).normalize('NFKC')
}

/** 敏感信息扫描：返回命中的 reason，或 null。全角/兼容写法同样命中。 */
export function scanSensitive(text: unknown): string | null {
  const source = foldWidth(text)
  for (const { reason, re } of SENSITIVE_PATTERNS) {
    if (re.test(source)) return reason
  }
  return null
}

/** 可脱敏（而非直接拒写）的个人信息形态：邮箱、手机号（设计稿 §8.3）。 */
const PII_EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gu
const PII_PHONE_RE = /\b(1[3-9]\d)\d{4}(\d{4})\b/gu
/** 无 `g` 标志的探测副本：`test` 不会因为 lastIndex 状态而漏判。 */
const PII_EMAIL_PROBE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u
const PII_PHONE_PROBE = /\b1[3-9]\d{9}\b/u

/**
 * 邮箱/手机号脱敏。
 *
 * 只有当**折叠后的视图**确实命中 PII 形态时才折叠并脱敏 —— 这样普通文本一字不改
 * （不引入 NFKC 的副作用），而全角写法的 PII 也会被正确脱敏而不是原样落盘。
 *
 * 取舍：命中 PII 的那条文本会**整体**走 NFKC（全角标点等也随之半角化）。
 * 这是有意的：宁可规范一条含 PII 的记录，也不要让它带着全角形态落盘、
 * 之后在注入前被折成可读的号码。
 */
export function maskPii(text: unknown): string {
  const source = String(text)
  const folded = foldWidth(source)
  if (!PII_EMAIL_PROBE.test(folded) && !PII_PHONE_PROBE.test(folded)) return source
  return folded
    // 邮箱：只保留首字母与域名 → a***@b.com
    .replace(PII_EMAIL_RE, '$1***$2')
    // 中国大陆手机号：保留前 3 后 4 → 138****8000
    .replace(PII_PHONE_RE, '$1****$2')
}

/**
 * 写入来源判定（设计稿 §5.1：判定权在插件，不在模型）。
 * 只认 source.kind === 'user' 的真实用户消息，且必须来自最后一个回合；
 * 我们注入的 runtime-context 消息不算用户要求。
 */
export function deriveOriginFromMessages(messages: unknown): MemoryOrigin {
  if (!Array.isArray(messages)) return 'model_proposed'
  const list: readonly MemoryMessageLike[] = messages
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.role !== 'user') continue
    if (message?.source?.kind !== 'user') continue
    const content = message.content
    const text = Array.isArray(content)
      ? (content as readonly MemoryMessageContentBlock[]).filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
      : String(content ?? '')
    return EXPLICIT_SIGNAL_RE.test(text) ? 'user_explicit' : 'model_proposed'
  }
  return 'model_proposed'
}

/** 轻量拉丁词干：只处理最常见的复数/时态尾巴（不引依赖）。 */
function stemLatin(word: string): string {
  if (word.length <= 4) return word
  return word.replace(/(ing|ed|s)$/u, '')
}

/**
 * 分词（设计稿 §6.1）：拉丁词 + 轻量词干；CJK 连续串切 bigram（长度 1 时保留单字）。
 * 例：`记忆数据落在` → 记忆/忆数/数据/据落/落在；`scripts/release.mjs` → scripts/release/mjs。
 */
export function tokenize(text: unknown): string[] {
  const normalized = normalizeText(text)
  const tokens: string[] = []
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._-]*/gu)) {
    for (const piece of match[0].split(/[._-]/u).filter(Boolean)) tokens.push(stemLatin(piece))
  }
  for (const match of normalized.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/gu)) {
    const run = match[0]
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

/**
 * 记录侧 token 集合的缓存。
 *
 * 为什么需要：召回要对**每条**记录重新分词（CJK bigram 走两轮正则），而 R2 每回合扫全库、
 * 检索工具每次调用也扫全库。基准实测（tools/bench.ts）2000 条时 `recall(memory)` p50 = 23ms，
 * 而硬预算是 `recallBudgetMs` = 10ms —— 也就是说库一大，每回合的召回会先白算一遍、
 * 再被扫描之后的预算检查整体丢弃，表现为**静默失效**。缓存把这一步从「每回合每条一次」
 * 降到「每条一次」。
 *
 * 键用 `kind|hash`：`hash` 覆盖 kind/scope/subject/text，内容变了键就变了，
 * 不会读到过期分词；旧条目由容量上限兜底清理（超过上限直接清空，代价可控）。
 */
const TOKEN_CACHE = new Map<string, Set<string>>()
const TOKEN_CACHE_MAX = 8192

/** 缓存键：优先用记录指纹；手工构造、没有指纹的记录退化为按内容拼键。 */
function tokenCacheKey(record: MemoryRecord): string {
  const hash = typeof record.hash === 'string' && record.hash.length > 0
    ? record.hash
    : `${record.text}|${record.subject ?? ''}|${(record.tags ?? []).join(',')}`
  return `${record.kind}|${hash}`
}

/** 一条记录的 token 集合（text + subject + tags），带缓存。 */
function tokensOf(record: MemoryRecord): Set<string> {
  const key = tokenCacheKey(record)
  const cached = TOKEN_CACHE.get(key)
  if (cached !== undefined) return cached
  const tokens = new Set(tokenize(`${record.text} ${record.subject ?? ''} ${(record.tags ?? []).join(' ')}`))
  // 逐个淘汰最旧的一条（Map 保持插入顺序）。**不能**整表清空：扫描量超过上限时
  // 清空会让每次调用都重新分词全库，实测 5000 条反而比不做缓存更慢。
  if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) {
    const oldest = TOKEN_CACHE.keys().next().value
    if (oldest !== undefined) TOKEN_CACHE.delete(oldest)
  }
  TOKEN_CACHE.set(key, tokens)
  return tokens
}

/** 清空分词缓存（供测试与基准使用；正常运行靠指纹键自然失效）。 */
export function clearTokenCache(): void {
  TOKEN_CACHE.clear()
}

/** 当前缓存条目数（可观测性）。 */
export function tokenCacheSize(): number {
  return TOKEN_CACHE.size
}

/**
 * 查询侧视图：`recallRecords` 一次扫描要处理上千条记录，
 * 而「分词查询 + 建集合」对整轮用户消息并不便宜。算一次、传下去。
 */
interface QueryView {
  /** 归一化文本（用于「空查询」判定）。 */
  text: string
  /** 分词结果（短查询覆盖率打分用，保留重复与顺序）。 */
  tokens: string[]
  /** 去重集合（记忆侧命中判定用）。 */
  tokenSet: Set<string>
}

function queryView(query: unknown): QueryView {
  const text = normalizeText(query)
  const tokens = tokenize(query)
  return { text, tokens, tokenSet: new Set(tokens) }
}

/** 查询覆盖率（无重复计数语义，与旧实现一致）。 */
function lexicalMatchTokens(record: MemoryRecord, view: QueryView): number {
  if (view.tokens.length === 0) return 1
  const haystack = tokensOf(record)
  let hits = 0
  for (const token of view.tokens) if (haystack.has(token)) hits += 1
  return hits / view.tokens.length
}

/** 词面命中率：查询 token 在记录里的覆盖率（0–1）。空查询视为完全匹配。
 *  适合**短查询**（模型显式 recall、销毁性操作）。 */
export function lexicalMatch(record: MemoryRecord, query: unknown): number {
  return lexicalMatchTokens(record, queryView(query))
}

/**
 * 记忆侧命中度：适合**长查询**（R2 用整轮用户消息去匹配一句话记忆）。
 * 语义是「这条记忆的若干关键词出现在了本轮里」，因此
 *   · 分母封顶（默认 4）：不因为记忆长就吃亏；
 *   · 要求至少 `minHits` 个有信息量的 token（长度 ≥2 且非纯数字），挡掉巧合命中。
 * 用查询覆盖率做这件事会在长消息下趋近 0，这是 M4 评测暴露出来的缺陷。
 */
/** 记忆侧命中度（查询侧已预先分词）。 */
function memoryMatchTokens(record: MemoryRecord, view: QueryView, options: MemoryMatchOptions): number {
  const recordTokens = tokensOf(record)
  if (recordTokens.size === 0) return 0
  const queryTokens = view.tokenSet
  if (queryTokens.size === 0) return 0
  const minHits = options.minHits ?? 1
  let hits = 0
  let informative = 0
  for (const token of recordTokens) {
    if (!queryTokens.has(token)) continue
    hits += 1
    if (token.length >= 2 && !/^\d+$/u.test(token)) informative += 1
  }
  if (informative < minHits) return 0
  const denominator = Math.max(1, Math.min(options.matchCap ?? 4, recordTokens.size))
  return Math.min(1, hits / denominator)
}

export function memoryMatch(record: MemoryRecord, query: unknown, options: MemoryMatchOptions = {}): number {
  return memoryMatchTokens(record, queryView(query), options)
}

/** M1 的轻量检索打分（查询侧已预先分词）。 */
function scoreRecordTokens(record: MemoryRecord, view: QueryView, now: number, matchOverride?: number): number {
  if (view.text.length === 0) return record.importance
  const lexical = matchOverride ?? lexicalMatchTokens(record, view)
  // 有查询但词面完全没命中 → 不参与召回（避免「不相关条目靠重要度混进来」）。
  if (lexical === 0) return 0
  const ageDays = Math.max(0, (now - (record.lastUsedAt ?? record.observedAt)) / 86_400_000)
  const recency = 1 / (1 + ageDays / 30)
  return 0.6 * lexical + 0.3 * record.importance + 0.1 * recency
}

/** M1 的轻量检索打分：词面命中 + 重要度 + 时效（向量留到 M4）。 */
export function scoreRecord(record: MemoryRecord, query: unknown, now: number = Date.now(), matchOverride?: number): number {
  return scoreRecordTokens(record, queryView(query), now, matchOverride)
}

/** 检索：过滤 → 打分 → 确定性排序。
 *  `mode: 'query'`（默认）= 短查询，按查询覆盖率判定，minLexical 默认 0.34；
 *  `mode: 'memory'` = 长查询（整轮用户消息），按记忆侧覆盖率判定，minMatch 默认 0.4 + minHits 2。
 *  `includeArchived: true` 也纳入归档条目（设计稿 §4.4：归档只是不常驻注入，仍可被检索到）；
 *  `invalid` 永不参与检索。
 *  破坏性操作（删除）应传更高的 minLexical（如 0.6）。 */
export function recallRecords(records: Iterable<MemoryRecord>, options: RecallOptions, now: number = Date.now()): RecallHit[] {
  const { query = '', kind, scopeLevel, tag, limit = 8 } = options ?? {}
  const mode = options?.mode ?? 'query'
  // 查询侧只分词一次：一次扫描要过上千条记录，逐条重新分词在长查询下是主要开销
  // （实测 2000 条时 recall(memory) 从 ~23ms 降到 ~2ms，见 tools/bench.ts）。
  const view = queryView(query)
  const hasQuery = view.text.length > 0
  const threshold = mode === 'memory'
    ? (options?.minMatch ?? 0.4)
    : (options?.minLexical ?? 0.34)
  const pool = options?.includeArchived
    ? [...records].filter((record) => record.status === 'active' || record.status === 'archived')
    : listActive(records)
  return pool
    .filter((record) => (kind ? record.kind === kind : true))
    .filter((record) => (scopeLevel ? record.scope.level === scopeLevel : true))
    .filter((record) => (tag ? (record.tags ?? []).includes(tag) : true))
    .map((record) => {
      const match = mode === 'memory'
        ? memoryMatchTokens(record, view, { minHits: options?.minHits ?? 2 })
        : lexicalMatchTokens(record, view)
      return { record, match, score: scoreRecordTokens(record, view, now, match) }
    })
    .filter((entry) => (hasQuery ? entry.match >= threshold : true))
    .sort((a, b) => (b.score - a.score) || compareRecords(a.record, b.record))
    .slice(0, Math.max(1, Math.min(50, limit)))
}

// ---------------------------------------------------------------------------
// M2：W2 回合边界规则捕获（默认零模型调用）
// ---------------------------------------------------------------------------

/** 排除规则（设计稿 §5.2）：命中即丢弃，并记录原因以便观测。 */
export function isExcluded(text: unknown): string | null {
  const source = String(text).trim()
  if (source.length < 8) return 'too-short'
  if (source.includes('```')) return 'code-block'
  if (/^https?:\/\/\S+$/u.test(source)) return 'pure-url'
  if (scanSensitive(source)) return 'sensitive'
  const rules: Array<{ reason: string; re: RegExp }> = [
    { reason: 'question', re: /[?？]\s*$/u },
    { reason: 'hypothetical', re: /(^|[\s，,。])(如果|假如|要是|万一|假设|倘若)/u },
    { reason: 'quoted', re: /(他说|她说|文档里写|文档说|according to|per the docs)/iu },
  ]
  for (const { reason, re } of rules) if (re.test(source)) return reason
  return null
}

/** 句子切分：中文句末标点与换行。**保留句末标点**，否则「疑问句排除」无法判定。 */
export function splitSentences(text: unknown): string[] {
  return String(text)
    .split(/(?<=[。！？!?])|\r?\n/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** 捕获信号表（设计稿 §5.2）：顺序即优先级，先匹配者胜。 */
export const CAPTURE_SIGNALS: CaptureSignal[] = [
  { id: 'agent-self-directive', kind: 'agent_self', origin: 'user_explicit', confidence: 0.9, importance: 0.9,
    re: /(以后你|你要|你必须|别再那样|不要再这样|下次先|从现在起你|你以后)/u },
  { id: 'agent-self-correction', kind: 'agent_self', origin: 'user_correction', confidence: 0.85, importance: 0.8,
    re: /(你搞错|你弄错|你写错|你漏了|上次你)/u },
  { id: 'explicit-imperative', kind: 'user_profile', origin: 'user_explicit', confidence: 0.9, importance: 0.85,
    re: /(记住|记一下|记下|帮我记|以后都|以后也|remember)/iu },
  { id: 'correction', kind: 'user_profile', origin: 'user_correction', confidence: 0.8, importance: 0.75,
    re: /(不对|不是这|改成|应该是|其实是)/u },
  { id: 'decision', kind: 'semantic', origin: 'observed', confidence: 0.7, importance: 0.6,
    re: /(就定|采用|最终选|结论是|决定用|就用这个)/u },
  { id: 'environment', kind: 'user_profile', origin: 'observed', confidence: 0.8, importance: 0.5,
    re: /(我的系统|我的版本|我的路径|我的环境|我用的是|我机器上)/u },
  { id: 'preference', kind: 'user_profile', origin: 'observed', confidence: 0.75, importance: 0.6,
    re: /(我更喜欢|我偏好|我习惯|我一般|我喜欢|我们项目用|请不要|我不喜欢)/u },
]

/**
 * 从用户消息里抽取候选记忆（**只看用户侧**——防自激闸门 1）。
 * @returns {{ candidates: object[], skipped: Record<string, number> }}
 */
export function extractCandidates(userText: unknown, cfg: MemoryConfig, now: number = Date.now()): ExtractCandidatesResult {
  const skipped: Record<string, number> = {}
  const candidates: CaptureCandidate[] = []
  const seen = new Set<string>()
  const minConfidence = cfg.captureMinConfidence ?? 0.6
  for (const sentence of splitSentences(userText)) {
    const excluded = isExcluded(sentence)
    if (excluded) {
      skipped[excluded] = (skipped[excluded] ?? 0) + 1
      continue
    }
    const signal = CAPTURE_SIGNALS.find((entry) => entry.re.test(sentence))
    if (!signal) {
      skipped['no-signal'] = (skipped['no-signal'] ?? 0) + 1
      continue
    }
    if (signal.confidence < minConfidence) {
      skipped['below-confidence'] = (skipped['below-confidence'] ?? 0) + 1
      continue
    }
    const record = makeRecord({
      kind: signal.kind,
      // 入库文本去掉句末标点；排除判定用的是原文。
      text: sentence.replace(/[。！？!?]+$/u, '').trim(),
      origin: signal.origin,
      confidence: signal.confidence,
      importance: signal.importance,
      tags: [signal.id],
    }, now)
    if (seen.has(record.hash)) {
      skipped['duplicate-in-turn'] = (skipped['duplicate-in-turn'] ?? 0) + 1
      continue
    }
    seen.add(record.hash)
    candidates.push({ ...record, signal: signal.id })
  }
  const limit = cfg.captureMaxPerTurn ?? 3
  candidates.sort((a, b) => (b.confidence - a.confidence) || (b.importance - a.importance))
  if (candidates.length > limit) {
    skipped['over-turn-quota'] = candidates.length - limit
    candidates.length = limit
  }
  return { candidates, skipped }
}

/** token 集合相似度（Jaccard）：用于回声剔除（对称、对长度差敏感）。 */
export function similarity(a: unknown, b: unknown): number {
  const left = new Set(tokenize(a))
  const right = new Set(tokenize(b))
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

/** 包含度（intersection / min）：用于「同一件事的两种说法」的合并判定，比 Jaccard 更稳。 */
export function containment(a: unknown, b: unknown): number {
  const left = new Set(tokenize(a))
  const right = new Set(tokenize(b))
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / Math.min(left.size, right.size)
}

/** 回声剔除（防自激闸门 2）：与刚注入的任何一行高度相似 → 视为模型在复述自己。 */
export function isEcho(text: unknown, injectedLines: unknown, threshold: number = 0.9): boolean {
  if (!Array.isArray(injectedLines) || injectedLines.length === 0) return false
  const lines: readonly unknown[] = injectedLines
  const plain = String(text).replace(/^[-*\s]+/u, '').replace(/\s*（自我观察，未经用户确认）\s*$/u, '')
  for (const line of lines) {
    const candidate = String(line).replace(/^[-*\s]+/u, '').replace(/^\([a-z]+\)\s*/u, '')
    if (similarity(plain, candidate) >= threshold) return true
  }
  return false
}

/** 工作区结构标记：用于零成本的项目模糊印象。 */
const WORKSPACE_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['pnpm', /\bpnpm\b/iu], ['npm', /\bnpm\b/iu], ['yarn', /\byarn\b/iu], ['bun', /\bbun\b/iu],
  ['electron', /electron/iu], ['vite', /\bvite\b/iu], ['typescript', /typescript|\btsconfig\b/iu],
  ['react', /react/iu], ['python', /python|\.py\b|pip\b/iu], ['rust', /rust|cargo/iu],
  ['go', /go\.mod|\bgolang\b/iu], ['powershell', /powershell|pwsh/iu], ['docker', /docker/iu],
  ['sqlite', /sqlite/iu], ['jsonl', /jsonl/iu],
]

export function detectWorkspaceMarkers(text: unknown): string[] {
  const found = new Set<string>()
  const source = String(text)
  for (const [name, re] of WORKSPACE_MARKERS) if (re.test(source)) found.add(name)
  return [...found]
}

export function composeGistText(markers: readonly string[]): string {
  if (markers.length === 0) return ''
  return `这个工作区看起来涉及：${markers.slice(0, 6).join('、')}。`
}

// ---------------------------------------------------------------------------
// M3：整合、冲突、衰减与压缩固化
// ---------------------------------------------------------------------------

/** 按 kind 的半衰期（天）。设计稿 §4.4：自画像（用户侧）与做法类不衰减。 */
export const HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  user_profile: 180,
  agent_self: Infinity,
  project_gist: 30,
  episodic: 60,
  semantic: 120,
  procedural: Infinity,
}

/** 有效重要度：importance × 时间衰减。pinned 与不衰减类型原样返回。
 *  `agent_self` 按来源分档：用户侧来源不衰减；**模型自评走 90 天半衰期**（设计稿 §4.4），
 *  否则一次自评会永久留在 system prompt 里。 */
export function effectiveImportance(record: MemoryRecord, now: number = Date.now()): number {
  let halfLife = HALF_LIFE_DAYS[record.kind] ?? 120
  if (record.kind === 'agent_self' && record.origin === 'model_proposed') halfLife = 90
  if (record.pinned || !Number.isFinite(halfLife)) return record.importance
  const ageDays = Math.max(0, (now - (record.lastUsedAt ?? record.observedAt)) / 86_400_000)
  return record.importance * (2 ** (-ageDays / halfLife))
}

/** 归档判定（设计稿 §4.4）：低有效重要度且长期未用；自画像与项目印象不归档。 */
export function shouldArchive(record: MemoryRecord, cfg: MemoryConfig, now: number = Date.now()): boolean {
  if (record.status !== 'active' || record.pinned) return false
  if (record.kind === 'agent_self' || record.kind === 'project_gist') return false
  const archiveAfterDays = cfg.archiveAfterDays ?? 180
  const ageDays = Math.max(0, (now - (record.lastUsedAt ?? record.observedAt)) / 86_400_000)
  return effectiveImportance(record, now) < (cfg.archiveBelowImportance ?? 0.15) && ageDays >= archiveAfterDays
}

/** 合并分组：同 kind + 同 scope + 同 subject 且文本相似度 ≥ 阈值。 */
export function pickMergeGroups(records: Iterable<MemoryRecord>, cfg: MemoryConfig): MemoryRecord[][] {
  const threshold = cfg.mergeSimilarity ?? 0.85
  const buckets = new Map<string, MemoryRecord[]>()
  for (const record of listActive(records)) {
    if (record.kind === 'project_gist' || record.kind === 'agent_self') continue // 这两类有自己的刷新/晋升规则
    if ((record.tags ?? []).includes('summary')) continue // 摘要是整合的产物，不再参与整合，避免自反馈
    if (!record.subject) continue
    const key = `${record.kind}|${record.scope.level}|${record.scope.key}|${record.subject}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(record)
  }
  const groups: MemoryRecord[][] = []
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue
    const used = new Set<string>()
    for (let index = 0; index < bucket.length; index += 1) {
      const lead = bucket[index]!
      if (used.has(lead.id)) continue
      const group = [lead]
      used.add(lead.id)
      for (let other = index + 1; other < bucket.length; other += 1) {
        const candidate = bucket[other]!
        if (used.has(candidate.id)) continue
        if (containment(lead.text, candidate.text) >= threshold) {
          group.push(candidate)
          used.add(candidate.id)
        }
      }
      if (group.length > 1) groups.push(group)
    }
  }
  return groups
}

/** 冲突判定（设计稿 §4.3）：同 (kind, scope, subject, field) 但 value 不同。 */
export function findConflicts(records: Iterable<MemoryRecord>): ConflictEntry[] {
  const slots = new Map<string, MemoryRecord[]>()
  for (const record of listActive(records)) {
    if (!record.subject || record.field == null || record.value == null) continue
    const key = `${record.kind}|${record.scope.level}|${record.scope.key}|${record.subject}|${record.field}`
    if (!slots.has(key)) slots.set(key, [])
    slots.get(key)!.push(record)
  }
  const conflicts: ConflictEntry[] = []
  for (const group of slots.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => (b.observedAt - a.observedAt) || compareRecords(a, b))
    const winner = sorted[0]!
    for (const loser of sorted.slice(1)) {
      // 唯一禁止的自动推翻：**非用户侧来源**（模型自评/自动观察）推翻**用户侧条目**（设计稿 §4.3）。
      // 反过来（用户侧推翻任何旧条目，包括被用户纠正过的）一律允许。
      const blocked = !isUserSideOrigin(winner.origin) && isUserSideOrigin(loser.origin)
      conflicts.push({ winner, loser, blocked })
    }
  }
  return conflicts
}

/** 是否为用户侧来源（用户明说或用户纠正）。 */
export function isUserSideOrigin(origin: MemoryOrigin): boolean {
  return origin === 'user_explicit' || origin === 'user_correction'
}

/**
 * 从文本派生稳定主题键（无模型调用）：取最有信息量的两个 token。
 * 用途：让「同一件事的两种说法」能落到同一个 subject 上，从而让去重/合并/冲突判定真正生效。
 */
export function deriveSubject(text: unknown, prefix: string = 'auto'): string | null {
  const tokens = [...new Set(tokenize(text))]
    .filter((token) => token.length >= 2 && !/^\d+$/u.test(token))
    .sort((a, b) => (b.length - a.length) || (a < b ? -1 : 1))
    .slice(0, 2)
  return tokens.length === 0 ? null : `${prefix}.${tokens.join('.')}`
}

/** 规则式摘要（零模型调用）：单一 subject 下 active 条目过多时合成一条。 */
export function composeSubjectSummary(records: Iterable<MemoryRecord>, cfg: MemoryConfig): SubjectSummary[] {
  const maxPerSubject = cfg.summarizeAbove ?? 5
  const buckets = new Map<string, MemoryRecord[]>()
  for (const record of listActive(records)) {
    if (!record.subject || record.kind === 'agent_self') continue
    if ((record.tags ?? []).includes('summary')) continue
    const key = `${record.kind}|${record.scope.level}|${record.scope.key}|${record.subject}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(record)
  }
  const summaries: SubjectSummary[] = []
  for (const bucket of buckets.values()) {
    if (bucket.length <= maxPerSubject) continue
    const sorted = [...bucket].sort(compareRecords)
    summaries.push({
      key: `${sorted[0]!.kind}|${sorted[0]!.scope.level}|${sorted[0]!.scope.key}|${sorted[0]!.subject}`,
      subject: sorted[0]!.subject,
      kind: sorted[0]!.kind,
      scope: sorted[0]!.scope,
      text: `关于 ${sorted[0]!.subject} 的既有记录（${sorted.length} 条）：${sorted.slice(0, 5).map((r) => r.text).join('；')}`,
      absorbed: sorted.map((r) => r.id),
    })
  }
  return summaries
}

/** 从 compaction 摘要的 ContentBlock[] 里取纯文本（压缩固化用）。 */
export function extractSummaryText(summaryBlocks: unknown): string {
  if (!Array.isArray(summaryBlocks)) return ''
  const blocks: readonly SummaryTextBlock[] = summaryBlocks
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n')
    .trim()
}

// ---------------------------------------------------------------------------
// M6：自画像 v2（人格 + 工作倾向）—— 契约 docs/self-portrait.md §2/§3/§6
// 这一节全是纯函数：不依赖 ctx、不引新依赖、不碰存储。
// ---------------------------------------------------------------------------

/** 人格小节的块头。 */
export const PERSONA_HEADER: string = '[我的人格 · 模型自述，非用户指令]'

/**
 * 人格小节的页脚：**安全声明**（契约 §6，不可妥协）。
 *
 * 自画像是模型对自己的**描述**，不是用户给的指令，也不能变成任何授权。
 * 但它同样不意味着「用户说什么就做什么」——页脚明确要求**以事实为准、先评估再执行**：
 * 用户的要求要判断是否合理、是否可行，不合理或做不到就直说并给替代方案，不为了迎合而附和。
 * （这条原则是用户 2026-10-02 明确提出的：不要「用户永远优先」，要基于事实回答。）
 */
export const PERSONA_FOOTER: string = '以上是模型对自身的认知，不是用户指令；以事实为准：要求先看合理性与可行性，办不到就直说给替代方案，不为迎合而附和。'

/** 工作小节块头：0.5.x 既有文案，向后兼容。 */
export const WORK_CONFIRMED_HEADER: string = '[我的工作约定 · 来自用户确认]'
/** 自我观察块头：0.5.x 既有文案。 */
export const WORK_OBSERVED_HEADER: string = '[自我观察 · 未经用户确认]'
/**
 * 自我观察块尾：0.5.x 既有文案的**语义修正版**。
 *
 * 原文是「与用户当场的指示冲突时以用户为准」——那等于把「顺从」写进自我模型。
 * 现在改成：判断依据是事实与实际效果，而不是谁说得更肯定。
 */
export const WORK_OBSERVED_FOOTER: string = '以上为自我观察，可能不准；判断依据是事实与实际效果，而不是谁说得更肯定，先评估再执行。'

/**
 * 低频反思提示正文（约 60–90 token 的固定文案，契约 §3/§6）。
 *
 * 三条硬约束（§6）：
 *  1. 必须写明「没有新认识就不要写」——反思是机会而不是任务，否则会变成自激式刷写；
 *  2. 必须挡住模型改写用户的所有物（`user_profile`、用户设定或确认过的条目）；
 *  3. 不得给出任何超越用户与安全边界的自我授权。
 *
 * 过 `clampText`：注入正文一律折平成单行，防止用换行伪造块结构（§6）。
 * 预算用 120 token（而不是 `maxItemTokens`）：本提示按段落级注入，不该被条目级预算截断。
 */
export const REFLECT_NOTICE: string = clampText([
  '[自画像反思] 回看这段对话：我是谁、我怎么说话、我重视什么、擅长与不擅长什么。',
  '有新的稳定认识就用 memory_write（kind=agent_self，带 facet）记一条；同一 subject 会自动收敛改写。',
  '没有新认识就不要写；也不要为迎合而写违心的话——记你真实的倾向与短板。',
  '不要改 user_profile 与用户设定；自画像是描述而非授权，不放宽安全边界，以事实为准。',
].join(' '), 120, DEFAULTS.charsPerToken)

/** 解析任意输入为 facet；无法识别时返回 `fallback`（默认 `'work'`，即 0.5.x 的存量语义）。 */
export function normalizeFacet(value: unknown, fallback: SelfFacet = 'work'): SelfFacet {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === 'persona' || text === 'work') return text
  return fallback === 'persona' ? 'persona' : 'work'
}

/** 记录的 facet：`agent_self` 且无 `facet` 字段 → `'work'`（0.5.x 的存量条目都是工作约定）。 */
export function facetOf(record: MemoryRecord): SelfFacet {
  return normalizeFacet(record?.facet, 'work')
}

/** subject key 白名单：只允许 `[a-z0-9_]`（小写化之后判定），非法回退 `'general'`。 */
const PORTRAIT_SUBJECT_KEY_RE = /^[a-z0-9_]+$/u

/** 规范 subject：`self.persona.voice` / `self.work.strengths`。 */
export function portraitSubjectFor(facet: SelfFacet, key: string): string {
  const normalizedFacet = normalizeFacet(facet, 'work')
  const raw = typeof key === 'string' ? key.trim().toLowerCase() : ''
  return `self.${normalizedFacet}.${PORTRAIT_SUBJECT_KEY_RE.test(raw) ? raw : 'general'}`
}

/** 自画像收敛决策的输入（模型侧候选）。 */
export interface PortraitCandidate {
  text: string
  facet: SelfFacet
  subject: string
  origin: MemoryOrigin
  confidence: number
  observedAt?: number
}

/** 收敛动作：新建 / 强化 / 合并改写 / 取代归档 / 不写。 */
export type PortraitAction = 'add' | 'reinforce' | 'refine' | 'supersede' | 'skip'

/** 收敛决策：宿主按它落盘（见契约 §4.1）。 */
export interface PortraitDecision {
  action: PortraitAction
  /** 被 reinforce/refine/supersede 命中的既有条目 id；add/skip 时为 null。 */
  targetId: string | null
  /** 最终要写入的正文（已过 `clampText`：单行、条目预算内）。 */
  text: string
  /** 最终置信度（已夹到 0–1）。 */
  confidence: number
  /** 可读原因，写进工具返回值与 stats：`added` / `reinforced` / `refined` / `superseded` / `too-short` / `user-owned`。 */
  reason: string
  /** supersede 时是否把 target 归档（并写 `supersededBy`）。 */
  archiveTarget: boolean
}

/** 自画像正文的最小长度（去空白后 < 8 字符没有信息量）。 */
export const PORTRAIT_MIN_TEXT_CHARS = 8

/** 同 subject 判定用的键：与 `normalizeText` 同口径（大小写/全角/尾标点不敏感）。 */
function portraitSubjectKey(subject: unknown): string {
  return normalizeText(subject ?? '')
}

/** 合并两条正文（refine）：一方包含另一方就取长的，否则按「长；短」拼接（确定性）。 */
function mergePortraitText(left: string, right: string): string {
  const [long, short] = left.length >= right.length ? [left, right] : [right, left]
  if (long === short) return long
  return normalizeText(long).includes(normalizeText(short)) ? long : `${long}；${short}`
}

/**
 * 自画像收敛决策：**纯函数、确定性**（契约 §3 的规则，按顺序判定）。
 *
 *  1. 正文去空白后 < 8 字符 → `skip` / `'too-short'`
 *     （例外：命名 subject `self.persona.name` / `address_user` / `address_self` 只要求 ≥2 字符 ——
 *      「我叫小忆」这种天生短，用 8 字门槛会把称呼写入静默丢掉）
 *  2. 同 subject + 同 facet 的 active 条目里：
 *     a. 指纹相同（归一化文本相等）或一方包含另一方 → `reinforce`
 *        （取更长文本；confidence 取两者较大者 +0.05，上限 1）
 *     b. 相似度 ≥ `cfg.selfPortraitMergeThreshold`（默认 0.6）→ `refine`（合并文本；confidence 取较大者）
 *     c. 否则 → 认知变化 → `supersede`（`archiveTarget: true`）
 *  3. 无同 subject 条目 → `add`
 *  4. **用户所有物保护**：target 的 origin 是 user_explicit/user_correction 或 pinned=true 时，
 *     候选必须**同样来自用户侧**才允许 refine/supersede；否则：
 *       · `refine` / `supersede` → `skip` / `'user-owned'`
 *       · `reinforce` → **仅当双方归一化文本完全相同**时才允许（只累加 confidence，
 *         正文逐字保留 target 原文）；只要候选文本与 target 不同（哪怕只是「包含」）→
 *         `skip` / `'user-owned'`
 *     ⚠ 为什么 reinforce 也要管：reinforce 在「一方包含另一方」时取更长的一条，模型只要写一句
 *     包含 pinned 条目全部 token 的长句，就能把自己的话写进用户设定的条目——违反 §6 的意图。
 *
 * 实现细节（不改语义，只是把「选哪条」定死以便确定性）：
 *  · 候选没有 scope，因此「指纹」以**归一化文本相等**判定；
 *  · 同 subject 有多条 active 时按 指纹 > 包含 > 相似度 > `compareRecords` 排序取第一条；
 *  · 正文一律过 `clampText`（单行 + 条目预算），防止结构伪造（契约 §6）。
 */
export function planPortraitUpdate(
  candidate: PortraitCandidate,
  existing: Iterable<MemoryRecord>,
  cfg: MemoryConfig,
): PortraitDecision {
  const facet = normalizeFacet(candidate?.facet, 'work')
  const subject = typeof candidate?.subject === 'string' ? candidate.subject : ''
  const text = clampText(candidate?.text, cfg.maxItemTokens, cfg.charsPerToken)
  const rawConfidence = Number(candidate?.confidence)
  const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0.6

  // 命名条目（self.persona.name / address_user / address_self）天生很短：
  // 「我叫小忆」「用户叫我「忆」」都不到 8 字符，用自画像正文的门槛会把它们**静默跳过**。
  // 因此命名 subject 只要求非空（≥2 字符），其余仍用 PORTRAIT_MIN_TEXT_CHARS。
  const isNaming = NAMING_SUBJECTS.includes(subject)
  const minChars = isNaming ? 2 : PORTRAIT_MIN_TEXT_CHARS
  if (String(candidate?.text ?? '').trim().length < minChars) {
    return { action: 'skip', targetId: null, text, confidence, reason: 'too-short', archiveTarget: false }
  }

  const subjectKey = portraitSubjectKey(subject)
  const pool = subjectKey.length === 0 ? [] : [...(existing ?? [])].filter((record) => record.status === 'active'
    && record.kind === 'agent_self'
    && facetOf(record) === facet
    && portraitSubjectKey(record.subject) === subjectKey)

  if (pool.length === 0) {
    return { action: 'add', targetId: null, text, confidence, reason: 'added', archiveTarget: false }
  }

  const candidateNorm = normalizeText(text)
  const ranked = pool
    .map((record) => ({
      record,
      same: normalizeText(record.text) === candidateNorm,
      contains: containment(text, record.text) >= 1,
      similarity: similarity(text, record.text),
    }))
    .sort((a, b) => (Number(b.same) - Number(a.same))
      || (Number(b.contains) - Number(a.contains))
      || (b.similarity - a.similarity)
      || compareRecords(a.record, b.record))
  const best = ranked[0]!
  const target = best.record

  const configuredThreshold = Number(cfg.selfPortraitMergeThreshold)
  const threshold = Number.isFinite(configuredThreshold) ? configuredThreshold : DEFAULTS.selfPortraitMergeThreshold
  const action: PortraitAction = (best.same || best.contains)
    ? 'reinforce'
    : (best.similarity >= threshold ? 'refine' : 'supersede')

  // 规则 4（契约 §3 规则 4，第十八轮审计收紧）：用户的所有物 —— origin 是
  // user_explicit/user_correction 或 pinned=true —— 只能由**用户侧候选**改写。
  //
  // ⚠ 为什么连 `reinforce` 也要管：reinforce 在「一方包含另一方」时取更长的一条，
  // 模型只要写一句「包含 pinned 条目全部 token 的更长句子」，就能把自己的话写进用户设定的条目
  // （实测复现过）——这违反 §6「模型不能覆盖 user_explicit / pinned 的自画像」。
  // 因此非用户侧候选：refine/supersede 一律 skip；reinforce 仅当双方**归一化文本完全相同**
  // 时才允许，且正文逐字保留 target 原文（只累加 confidence 与 reinforcement，绝不改写正文）。
  const targetUserOwned = isUserSideOrigin(target.origin) || target.pinned === true
  const candidateUserSide = isUserSideOrigin(candidate?.origin)
  if (targetUserOwned && !candidateUserSide) {
    // skip 时 text 返回 **target 原文**（而不是被拒的模型文本）：`text` 的语义是「最终要写入的正文」，
    // 用户所有物被跳过时，留在条目里的就是用户原文。
    if (action !== 'reinforce' || !best.same) {
      return {
        action: 'skip',
        targetId: null,
        text: String(target.text ?? ''),
        confidence,
        reason: 'user-owned',
        archiveTarget: false,
      }
    }
    return {
      action: 'reinforce',
      targetId: target.id,
      // 逐字保留用户原文（不取「更长的那条」）：保护用户所有物优先于顺带规范化，
      // 注入层本来就会对每条正文过 `clampText`。
      text: String(target.text ?? ''),
      confidence: Math.min(1, Math.max(confidence, Number(target.confidence) || 0) + 0.05),
      reason: 'reinforced',
      archiveTarget: false,
    }
  }

  const targetText = clampText(target.text, cfg.maxItemTokens, cfg.charsPerToken)
  if (action === 'reinforce') {
    return {
      action,
      targetId: target.id,
      text: text.length >= targetText.length ? text : targetText,
      confidence: Math.min(1, Math.max(confidence, Number(target.confidence) || 0) + 0.05),
      reason: 'reinforced',
      archiveTarget: false,
    }
  }
  if (action === 'refine') {
    return {
      action,
      targetId: target.id,
      text: clampText(mergePortraitText(text, targetText), cfg.maxItemTokens, cfg.charsPerToken),
      confidence: Math.max(confidence, Number(target.confidence) || 0),
      reason: 'refined',
      archiveTarget: false,
    }
  }
  return { action, targetId: target.id, text, confidence, reason: 'superseded', archiveTarget: true }
}

/** 一条修订链：同一 subject + facet 下由旧到新的自画像条目。 */
export interface PortraitRevision {
  subject: string
  facet: SelfFacet
  /** 由旧到新。 */
  chain: MemoryRecord[]
}

/**
 * 修订链：把 `supersededBy` / `supersedes` 互为反向的指针串起来（链内按 `observedAt` 升序 = 由旧到新）。
 *
 * 只返回**真的发生过修订**的组（链长 ≥ 2）：单条 active 条目不是历史，`/memory self` 已经会列出它。
 * 返回值按「最新一条修订时间」倒序（新的修订在前），同刻按 subject 稳定排序。
 */
export function portraitHistory(records: Iterable<MemoryRecord>): PortraitRevision[] {
  const groups = new Map<string, MemoryRecord[]>()
  for (const record of records ?? []) {
    if (!record || record.kind !== 'agent_self') continue
    const key = `${facetOf(record)}|${portraitSubjectKey(record.subject)}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(record)
    else groups.set(key, [record])
  }

  const byAge = (a: MemoryRecord, b: MemoryRecord): number =>
    (a.observedAt - b.observedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

  const revisions: PortraitRevision[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const byId = new Map(group.map((record) => [record.id, record]))
    const nextOf = new Map<string, MemoryRecord>()
    const hasPredecessor = new Set<string>()
    for (const record of group) {
      if (typeof record.supersededBy === 'string' && record.supersededBy.length > 0) {
        const successor = byId.get(record.supersededBy)
        if (successor && !nextOf.has(record.id)) {
          nextOf.set(record.id, successor)
          hasPredecessor.add(successor.id)
        }
      }
      for (const oldId of record.supersedes ?? []) {
        const predecessor = byId.get(oldId)
        if (predecessor && !nextOf.has(predecessor.id)) {
          nextOf.set(predecessor.id, record)
          hasPredecessor.add(record.id)
        }
      }
    }
    // 没有前驱的即链头；纯环（互相指向）时退化为从最旧一条起走，visited 保证不死循环。
    const heads = group.filter((record) => !hasPredecessor.has(record.id)).sort(byAge)
    const starts = heads.length > 0 ? heads : [group.slice().sort(byAge)[0]!]
    const visited = new Set<string>()
    for (const start of starts) {
      const chain: MemoryRecord[] = []
      let cursor: MemoryRecord | undefined = start
      while (cursor && !visited.has(cursor.id)) {
        visited.add(cursor.id)
        chain.push(cursor)
        cursor = nextOf.get(cursor.id)
      }
      if (chain.length < 2) continue
      chain.sort(byAge)
      revisions.push({ subject: chain[0]!.subject ?? '', facet: facetOf(chain[0]!), chain })
    }
  }

  revisions.sort((a, b) => (b.chain[b.chain.length - 1]!.observedAt - a.chain[a.chain.length - 1]!.observedAt)
    || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0))
  return revisions
}

/** 反思提醒闸门的输入（契约 §3）。 */
export interface ReflectInput {
  /** 当前回合号。 */
  turn: number
  /** 本会话上一次反思提醒的回合号；从未提醒过为 null。 */
  lastReflectTurn: number | null
  /** 本会话已提醒次数。 */
  reflectionsThisSession: number
  /** 本会话已进行的回合数。 */
  sessionTurns: number
}

/**
 * 反思提醒闸门（纯函数）：`enabled=false` / 已达每会话上限 / 未到最小回合 / 未到间隔 → false。
 *
 * 口径：
 *  · 「最小回合」看 `sessionTurns`（契约 §3.1 说的是**本会话**最小回合数，太早没素材）；
 *    `sessionTurns` 缺失或非有限时退化为 `turn`，避免上游漏传时永远不提醒。
 *  · 「间隔」看 `turn - lastReflectTurn`（两者都是回合号）；从未提醒过（null）不受间隔约束。
 *  · `selfReflectMaxPerSession <= 0`（或 NaN）视为关闭；`Infinity` 视为不限次数。
 */
export function shouldReflect(input: ReflectInput, cfg: MemoryConfig): boolean {
  if (!input) return false
  if (cfg.selfReflectEnabled === false) return false

  const cap = cfg.selfReflectMaxPerSession ?? DEFAULTS.selfReflectMaxPerSession
  if (!(cap > 0)) return false
  const reflections = Number.isFinite(input.reflectionsThisSession) ? input.reflectionsThisSession : 0
  if (reflections >= cap) return false

  const minTurn = cfg.selfReflectMinTurn ?? DEFAULTS.selfReflectMinTurn
  const turn = Number.isFinite(input.turn) ? input.turn : 0
  const sessionTurns = Number.isFinite(input.sessionTurns) ? input.sessionTurns : turn
  if (sessionTurns < minTurn) return false

  const everyTurns = Number.isFinite(cfg.selfReflectEveryTurns) && cfg.selfReflectEveryTurns > 0
    ? cfg.selfReflectEveryTurns
    : DEFAULTS.selfReflectEveryTurns
  const lastReflectTurn = input.lastReflectTurn
  if (typeof lastReflectTurn === 'number' && Number.isFinite(lastReflectTurn) && turn - lastReflectTurn < everyTurns) {
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// M7：初次设定（称呼）—— 契约 §7
// ---------------------------------------------------------------------------

/**
 * 命名 subject：自画像里最先该定下来的三件事。
 * 与插件猜名字相比，「问一句」才是对的：称呼是双方的事。
 */
export const NAMING_SUBJECTS: readonly string[] = [
  'self.persona.name',
  'self.persona.address_user',
  'self.persona.address_self',
]

/**
 * 命名是否已确定：只要**曾经**记过任一命名 subject 就算（active 或 archived 都算）。
 *
 * 为什么 archived 也算：`supersede` 掉的名字说明「这件事谈过了」——
 * 反复追问比名字不够完美更烦人。被 `invalid`（用户 reject）的不算，那种情况允许再问一次。
 */
export function namingSettled(records: Iterable<MemoryRecord>): boolean {
  for (const record of records) {
    if (record?.kind !== 'agent_self') continue
    if (record.status === 'invalid') continue
    if (typeof record.subject === 'string' && NAMING_SUBJECTS.includes(record.subject)) return true
  }
  return false
}

/** 初次设定提醒的输入（契约 §7.3）。 */
export interface IntroInput {
  /** 当前回合号。 */
  turn: number
  /** **跨会话**累计已提醒次数（宿主从领域水位读出）。 */
  asks: number
  /** `namingSettled(...)` 的结果。 */
  settled: boolean
}

/**
 * 初次设定闸门（纯函数）：`enabled=false` / 已确定 / 已达总次数上限 / 未到最小回合 → false。
 *
 * 与反思闸门的关键区别：这里限制的是**跨会话累计次数**（`selfIntroMaxAsks`，默认 2），
 * 因为「问称呼」是一次性的事，问满就不再开口；而反思是长期的习惯。
 */
export function shouldIntroduce(input: IntroInput, cfg: MemoryConfig): boolean {
  if (!input) return false
  if (cfg.selfIntroEnabled === false) return false
  if (input.settled === true) return false

  const cap = cfg.selfIntroMaxAsks ?? DEFAULTS.selfIntroMaxAsks
  if (!(cap > 0)) return false
  const asks = Number.isFinite(input.asks) ? input.asks : 0
  if (asks >= cap) return false

  const minTurn = Number.isFinite(cfg.selfIntroMinTurn) ? cfg.selfIntroMinTurn : DEFAULTS.selfIntroMinTurn
  const turn = Number.isFinite(input.turn) ? input.turn : 0
  if (turn < minTurn) return false
  return true
}

/**
 * 初次设定提示正文（契约 §7.3，与 `REFLECT_NOTICE` 同规格：单行、克制、一次性）。
 *
 * 四条必须在：① 只问**一句**；② 用户让你自己取名就提一个并确认；
 * ③ 用 `memory_write` 落盘（三个命名 subject）；④ 用户说不用就记「保持默认称呼」，之后不再问。
 */
export const INTRO_NOTICE: string = clampText([
  '[初次设定 · 称呼] 找个自然的时机，用一句话问用户：想给你取什么名字、你该怎么称呼他/她。',
  '用户让你自己取名就提一个并确认。',
  '定下来后用 memory_write（kind=agent_self、facet=persona、subject=self.persona.name / self.persona.address_user / self.persona.address_self）各记一条。',
  '用户说不用或随便，就记一条「保持默认称呼」，之后不要再问。',
].join(' '), 120, DEFAULTS.charsPerToken)

// ---------------------------------------------------------------------------
// M8：`/sleep` 空闲梳理 —— 契约 docs/sleep.md §4
//
// 与上面几节一样，整节是**纯函数**：不依赖 ctx、不碰存储、不引新依赖、不用模型。
// `/sleep` 干两件事：① 把最近会话的完整事件日志重新过一遍记忆管线（补录当时漏记的）；
// ② 把整个库重新排一遍（合并/失效/归档/印象）。判定权仍然在规则手里，计划里只有「要做什么」。
//
// 三条不可妥协的性质（契约 §6），实现里各有一道闸门：
//  · 只认 `data.source.kind === 'user'` 的 user/message（注入的 runtime-context 不是用户说的话）；
//  · 计划里**不产生任何 agent_self 写入**（人格/工作倾向属于模型自我认知，规则不替它下结论）；
//  · 冲突建议里 `drop` 指向用户侧条目（user_explicit / user_correction / pinned）时跳过并写进 notes。
// ---------------------------------------------------------------------------

/** 一条从会话日志里抽出来的消息（只保留梳理用得上的字段）。 */
export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  at: number | null
}

/** 一个会话的抽取结果。 */
export interface SleepSource {
  sessionId: string
  cwd: string | null
  createdAt: number
  messages: TranscriptMessage[]
  /**
   * 抽取期说明（单会话字符预算截断、总预算未纳入等）。
   * `buildSleepPlan` 会把它们按 source 顺序汇总进 `plan.notes` —— 契约 §6 要求
   * 「任何一项预算超限都要在 notes 里写清」，而 `SleepPlan` 是唯一有 notes 的地方。
   */
  notes?: string[]
}

/**
 * `transcriptOf` 的入参：契约 §4 的四个字段 + 会话头的两个可选标记。
 *
 * 为什么多了 `origin` / `parentSession` / `header`：契约 §4 要「`origin: 'subagent'` 的会话整体跳过」，
 * 但 §4 给出的入参形状里没有 origin —— 宿主只能从 `DshSessionRecord.header` 里读。
 * 这三个字段都是**可选**的，所以契约里那四种字段的调用方式一字不用改。
 */
export interface SleepSessionInput {
  sessionId: string
  cwd?: string | null
  createdAt: number
  events: readonly unknown[]
  /** `DshSessionRecord.header.origin`：`'subagent'` 的会话整体跳过。 */
  origin?: string | null
  /** `DshSessionRecord.header.parentSession`：有值即视为子代理会话。 */
  parentSession?: string | null
  /** 也可以整块透传 `DshSessionRecord.header`。 */
  header?: { origin?: string | null; parentSession?: string | null } | null
}

/** `transcriptOf` 的返回值：契约的四个字段 + 会话整体级说明。 */
export interface TranscriptOfResult {
  sources: SleepSource[]
  messages: number
  chars: number
  skippedSubagents: number
  /** 挂不到具体 source 上的说明（例如跳过子代理会话），可原样传给 `buildSleepPlan({ notes })`。 */
  notes: string[]
}

/** 回放捕获产出的一条候选记忆。 */
export interface SleepCandidate {
  text: string
  sessionId: string
  at: number | null
  scope: { level: 'workspace' | 'profile'; key: string }
  origin: MemoryOrigin
  confidence: number
  /** 与 `recordHash` 同源的指纹，用于「库里已有」判定。 */
  hash: string
  /**
   * 候选的 kind 与 subject（与实况捕获路径同源：`deriveSubject(text, signal)`）。
   *
   * **宿主持候选落盘时请一并透传**：`recordHash` 把 kind/scope/subject/文本都算进去，
   * 少了 subject 就会写出一个指纹不同的记录，第二次 `/sleep` 便无法识别「已经补录过」。
   */
  kind?: MemoryKind
  subject?: string | null
}

/** 梳理计划：**只描述要做什么，不做任何写入**。 */
export interface SleepPlan {
  scanned: { sessions: number; messages: number; chars: number }
  /** 库里没有的候选（按 hash 去重后）。 */
  backfill: SleepCandidate[]
  /** 命中已有指纹（库内已有，或本次更早的候选已经出现过）而跳过的条数。 */
  duplicates: number
  /** 建议合并组（同 subject、相似度 ≥ cfg.mergeSimilarity）。 */
  merges: Array<{ ids: string[]; subject: string; text: string }>
  /** 建议失效的矛盾条目（保留 keep，失效 drop）。 */
  conflicts: Array<{ keep: string; drop: string; subject: string }>
  /** 建议归档的条目 id（`shouldArchive`）。 */
  archive: string[]
  /** 重算后的项目印象（按 workspace 分组，最多 `cfg.sleepMaxGists` 条）。 */
  gists: Array<{ level: 'workspace'; key: string; text: string }>
  /** 人读的说明/降级原因，按顺序渲染。 */
  notes: string[]
  /** 上限裁剪后的候选数（`cfg.sleepMaxBackfill`）。 */
  truncated: number
}

/** `buildSleepPlan` 的入参（契约 §4 的四个字段 + 两个可选透传口）。 */
export interface SleepPlanInput {
  records: Iterable<MemoryRecord>
  sources: readonly SleepSource[]
  cfg: MemoryConfig
  now?: number
  /** `transcriptOf(...).notes` 透传：会话整体级说明。 */
  notes?: readonly string[]
  /** `transcriptOf(...).skippedSubagents` 透传：跳过子代理会话的说明。 */
  skippedSubagents?: number
}

/** 会话事件视图（`transcriptOf` 只读 type/seq/time/data）。 */
interface SleepEventView {
  type: string
  seq: number | null
  time: number | null
  data: Record<string, unknown> | null
}

/** 消息视图：`user/message` 的 `data` 与 `assistant/message` 的 `data.message` 形状一致。 */
interface SleepMessageView {
  role?: unknown
  source?: { kind?: unknown } | null
  content?: unknown
}

/** 事件视图：非对象/无 type 的一律忽略（宿主日志里还有本插件不关心的事件）。 */
function sleepEventView(value: unknown): SleepEventView | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
  if (typeof raw.type !== 'string' || raw.type.length === 0) return null
  return {
    type: raw.type,
    seq: typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : null,
    time: typeof raw.time === 'number' && Number.isFinite(raw.time) ? raw.time : null,
    data: raw.data !== null && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : null,
  }
}

function sleepMessageView(value: unknown): SleepMessageView | null {
  return value !== null && typeof value === 'object' ? value as SleepMessageView : null
}

/** 内容块数组 → 纯文本（只取 text 块；图片/工具块忽略）。 */
function sleepTextOf(content: unknown): string {
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content as readonly MemoryMessageContentBlock[]) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
    }
    return parts.join('\n')
  }
  return typeof content === 'string' ? content : ''
}

/**
 * 真实用户消息：**只认 `data.source.kind === 'user'`**（防自激闸门 1）。
 * 我们自己注入的 runtime-context 消息同样落在 `user/message` 事件里，混进来就会把注入当用户要求。
 */
function isRealUserMessage(message: SleepMessageView): boolean {
  if (message.source?.kind !== 'user') return false
  // user/message 事件的 role 就是 'user'；缺失时不强求（实测契约如此）。
  return message.role === undefined || message.role === null || message.role === 'user'
}

/** 子代理会话：`origin: 'subagent'` 或带 `parentSession`（契约 §3/§4）—— 整体跳过。 */
function isSubagentSession(session: SleepSessionInput): boolean {
  const origin = session.origin ?? session.header?.origin ?? null
  if (typeof origin === 'string' && origin.toLowerCase() === 'subagent') return true
  const parent = session.parentSession ?? session.header?.parentSession ?? null
  return typeof parent === 'string' && parent.length > 0
}

/** 计数型上限：允许 0（= 关闭该项），NaN/负数回落到默认值；`Infinity` 视为不限。 */
function sleepCap(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) return fallback
  return value
}

/** 预算型上限：必须是正数，否则回落到默认值（0 会把所有会话裁空）。 */
function sleepBudget(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 工作区标记的规范顺序（`detectWorkspaceMarkers` 的输出顺序），用于跨会话求并集后仍保持稳定。 */
const MARKER_ORDER: ReadonlyMap<string, number> = new Map(
  WORKSPACE_MARKERS.map(([name], index): [string, number] => [name, index]),
)

/**
 * 从会话事件抽消息：**只认 `data.source.kind === 'user'` 的 user/message**，
 * 以及用于回声检测的 assistant/message 文本（`cfg.sleepAssistantContext` 条以内，默认 3，
 * 取该用户消息之前最近的几条）。空文本、控制字符、超长文本按 `clampText` 处理；
 * 每个会话的字符预算 `cfg.sleepMaxCharsPerSession`（超预算时保留**最近**的消息并记 note，
 * 与契约 §4 步骤 7「补录取最新的」同一取向：最近的话更贴近当前事实）。
 *
 * 计数口径：`messages`/`chars` 是**保留下来的全部消息**（含为回声检测保留的 assistant 文本）之和；
 * `sources` 保持入参顺序；被总预算整体裁掉的会话仍会留在 `sources` 里（`messages: []` + `notes`），
 * 这样「为什么没回放它」能随计划一起呈现，而不是静默消失。
 */
export function transcriptOf(
  sessions: readonly SleepSessionInput[],
  cfg: MemoryConfig,
): TranscriptOfResult {
  const list: readonly SleepSessionInput[] = Array.isArray(sessions) ? sessions : []
  const contextLimit = sleepCap(cfg.sleepAssistantContext, DEFAULTS.sleepAssistantContext)
  const charsPerToken = sleepBudget(cfg.charsPerToken, DEFAULTS.charsPerToken)
  const totalBudget = sleepBudget(cfg.sleepMaxCharsTotal, DEFAULTS.sleepMaxCharsTotal)
  // 单会话预算再夹一次总预算：否则「单会话预算 > 总预算」时，最新的会话会因为装不进总预算被整体丢掉。
  const sessionBudget = Math.min(
    sleepBudget(cfg.sleepMaxCharsPerSession, DEFAULTS.sleepMaxCharsPerSession),
    totalBudget,
  )
  // 单条消息的上限就是单会话预算：正常消息不会被截，异常超长文本有硬上限（且已是单行）。
  const messageBudgetTokens = sessionBudget / charsPerToken
  const notes: string[] = []
  let skippedSubagents = 0

  const drafts: Array<{ source: SleepSource; chars: number }> = []
  for (const session of list) {
    if (isSubagentSession(session)) {
      skippedSubagents += 1
      continue
    }

    // ---- 事件顺序：按 seq 升序（seq 缺失时保持原有相对顺序；Array#sort 稳定）
    const ordered = (Array.isArray(session.events) ? session.events : [])
      .map((event, index) => ({ view: sleepEventView(event), index }))
      .filter((item): item is { view: SleepEventView; index: number } => item.view !== null)
    ordered.sort((a, b) => (a.view.seq === null || b.view.seq === null ? 0 : a.view.seq - b.view.seq)
      || (a.index - b.index))

    // ---- 抽取：每条真实用户消息 = 一个「组」（它 + 它之前最近 N 条 assistant 文本）
    const groups: Array<{ user: TranscriptMessage; context: TranscriptMessage[] }> = []
    let pending: TranscriptMessage[] = []
    for (const { view: event } of ordered) {
      const at = event.time
      if (event.type === 'user/message') {
        const view = sleepMessageView(event.data)
        // 实测契约是「`data` 就是 UserMessage」；`data.message` 只是多包一层的兼容读法，
        // 仅在 data 里没有 source.kind 时才回退（否则注入消息会被误读成用户消息）。
        const message = view && view.source?.kind !== undefined
          ? view
          : sleepMessageView(event.data?.message)
        if (!message || !isRealUserMessage(message)) continue
        const text = clampText(sleepTextOf(message.content), messageBudgetTokens, charsPerToken)
        if (!text) continue
        groups.push({ user: { role: 'user', text, at }, context: pending })
        pending = []
        continue
      }
      if (event.type === 'assistant/message') {
        const message = sleepMessageView(event.data?.message) ?? sleepMessageView(event.data)
        if (!message) continue
        const text = clampText(sleepTextOf(message.content), messageBudgetTokens, charsPerToken)
        if (!text) continue
        pending.push({ role: 'assistant', text, at })
        if (pending.length > contextLimit) pending = pending.slice(pending.length - contextLimit)
      }
    }

    // ---- 单会话字符预算：从最新往回装填（装不下的整组丢弃并计数）
    const kept: Array<{ user: TranscriptMessage; context: TranscriptMessage[] }> = []
    let used = 0
    let dropped = 0
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]!
      const full = group.user.text.length + group.context.reduce((sum, item) => sum + item.text.length, 0)
      if (used + full <= sessionBudget) {
        kept.push(group)
        used += full
        continue
      }
      // 组放不下就退化为「只留用户消息」：回声上下文只是辅助，用户消息才是回放素材。
      if (used + group.user.text.length <= sessionBudget) {
        kept.push({ user: group.user, context: [] })
        used += group.user.text.length
        dropped += group.context.length
        continue
      }
      // 连用户消息都放不下：这一组以及更早的全部丢弃
      for (let earlier = 0; earlier <= index; earlier += 1) dropped += 1 + groups[earlier]!.context.length
      break
    }
    kept.reverse()
    const messages = kept.flatMap((group) => [...group.context, group.user])

    const source: SleepSource = {
      sessionId: String(session.sessionId ?? ''),
      cwd: typeof session.cwd === 'string' && session.cwd.length > 0 ? session.cwd : null,
      createdAt: typeof session.createdAt === 'number' && Number.isFinite(session.createdAt) ? session.createdAt : 0,
      messages,
    }
    if (dropped > 0) {
      source.notes = [`单会话字符预算（${sessionBudget} 字符）已满：保留最近的 ${messages.length} 条消息，丢弃较早的 ${dropped} 条。`]
    }
    drafts.push({ source, chars: messages.reduce((sum, message) => sum + message.text.length, 0) })
  }

  // ---- 总字符预算：按「会话越新越先装」分配（与入参顺序无关，结果可复现）
  const byRecency = drafts
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.source.createdAt - a.entry.source.createdAt) || (a.index - b.index))
  let usedTotal = 0
  for (const { entry } of byRecency) {
    if (entry.chars === 0) continue
    if (usedTotal + entry.chars <= totalBudget) {
      usedTotal += entry.chars
      continue
    }
    entry.source.messages = []
    entry.source.notes = [
      ...(entry.source.notes ?? []),
      `总字符预算（${totalBudget} 字符）已用尽：该会话未纳入本次回放。`,
    ]
    entry.chars = 0
  }

  const sources = drafts.map((entry) => entry.source)
  let messages = 0
  let chars = 0
  for (const entry of drafts) {
    messages += entry.source.messages.length
    chars += entry.chars
  }
  if (skippedSubagents > 0) {
    notes.push(`跳过 ${skippedSubagents} 个子代理会话（其中的「用户消息」是父代理的指令，不是用户说的话）。`)
  }
  return { sources, messages, chars, skippedSubagents, notes }
}

/**
 * 生成梳理计划（纯函数、确定性）。
 * 步骤：
 *  1. 回放捕获：对每条真实用户消息跑 `extractCandidates`（`deriveOriginFromMessages` 语义：命中显式祈使
 *     → 只补录 user_explicit，其余跳过 —— `/sleep` 只补录用户明确要求记住的东西，不把闲聊变成记忆）；
 *  2. 去重：`recordHash` 命中库内已有（**含 archived 与 invalid**）→ `duplicates += 1`，不进 backfill
 *     （本次更早出现过的同指纹候选同样跳过并计数）；
 *  3. 合并：对库内 active 集跑 `pickMergeGroups`（含 pinned 的组跳过，§6「合并不动 pinned」）；
 *  4. 冲突：跑 `findConflicts`（会把用户侧/pinned 条目判成 drop、以及涉及 agent_self 的建议跳过并写进 notes，§6）；
 *  5. 归档：跑 `shouldArchive`；
 *  6. 项目印象：用回放期间 `detectWorkspaceMarkers` 观察到的标记按 workspace 重算 `composeGistText`；
 *  7. 裁剪：backfill 最多 `cfg.sleepMaxBackfill` 条，取**最新**的（更贴近当前事实），其余计入 `truncated`；
 *  8. **不碰自画像**：计划里不产生任何 `agent_self` 写入（人格/工作倾向属于模型自我认知）。
 */
export function buildSleepPlan(input: SleepPlanInput): SleepPlan {
  const cfg = input.cfg
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now()
  const records = input.records ? [...input.records] : []
  const sources = Array.isArray(input.sources) ? [...input.sources] : []
  const notes: string[] = []
  for (const note of input.notes ?? []) if (note) notes.push(String(note))
  for (const source of sources) for (const note of source.notes ?? []) if (note) notes.push(String(note))
  const skippedSubagents = sleepCap(input.skippedSubagents, 0)
  if (skippedSubagents > 0 && !notes.some((note) => note.includes('子代理'))) {
    notes.push(`跳过 ${skippedSubagents} 个子代理会话（其中的「用户消息」是父代理的指令，不是用户说的话）。`)
  }

  // ---- 0) 统计：回看的规模（含为回声检测保留的 assistant 文本）
  let scannedMessages = 0
  let scannedChars = 0
  for (const source of sources) {
    for (const message of source.messages) {
      scannedMessages += 1
      scannedChars += message.text.length
    }
  }

  // ---- 1) 回放捕获 + 2) 去重
  const libraryHashes = new Set(records.map((record) => record.hash))
  const createdAtOf = new Map<string, number>()
  for (const source of sources) createdAtOf.set(source.sessionId, source.createdAt)
  const charsPerToken = sleepBudget(cfg.charsPerToken, DEFAULTS.charsPerToken)
  const bodyBudgetTokens = sleepBudget(cfg.sleepMaxCharsPerSession, DEFAULTS.sleepMaxCharsPerSession) / charsPerToken
  const seen = new Set<string>()
  const found: SleepCandidate[] = []
  let duplicates = 0
  for (const source of sources) {
    const workspaceKey = workspaceKeyOf(source.cwd)
    for (const message of source.messages) {
      if (!message || message.role !== 'user') continue
      const text = message.text
      // 契约 §4 步骤 1：命中显式祈使才回放 —— 与 `deriveOriginFromMessages` 的判定同源（同一个正则）。
      if (!EXPLICIT_SIGNAL_RE.test(text)) continue
      const at = typeof message.at === 'number' && Number.isFinite(message.at) ? message.at : null
      const extracted = extractCandidates(text, cfg, at ?? now)
      for (const candidate of extracted.candidates) {
        // 硬要求（§4 步骤 8）：计划里绝不产生 agent_self 写入。
        if (candidate.kind === 'agent_self') continue
        // 只补录「用户明确要求记住的东西」：observed / user_correction / model_proposed 一律不补录。
        if (candidate.origin !== 'user_explicit') continue
        const level = defaultScopeFor(candidate.kind)
        const scope: { level: 'workspace' | 'profile'; key: string } = level === 'workspace'
          ? { level: 'workspace', key: workspaceKey ?? '*' }
          : { level: 'profile', key: '*' }
        // subject 与实况捕获路径同源（`deriveSubject(text, signal)`）—— 否则指纹对不上，去重会漏判。
        const subject = deriveSubject(candidate.text, candidate.signal)
        // 与 `writeMemory` 的落盘前处理对齐（maskPii），并过 clampText（上限 = 单会话预算，正常句子不受影响）。
        const body = clampText(maskPii(candidate.text), bodyBudgetTokens, charsPerToken)
        if (!body) continue
        const hash = recordHash({ kind: candidate.kind, scope, subject, text: body })
        if (seen.has(hash) || libraryHashes.has(hash)) {
          duplicates += 1
          continue
        }
        seen.add(hash)
        found.push({
          text: body,
          sessionId: source.sessionId,
          at,
          scope,
          origin: candidate.origin,
          confidence: candidate.confidence,
          hash,
          kind: candidate.kind,
          subject,
        })
      }
    }
  }

  // ---- 3) 合并（§6：含 pinned 的组不动）
  const merges: SleepPlan['merges'] = []
  let pinnedMergeGroups = 0
  for (const group of pickMergeGroups(records, cfg)) {
    if (group.some((record) => record.pinned)) {
      pinnedMergeGroups += 1
      continue
    }
    const sorted = [...group].sort(compareRecords)
    const lead = sorted[0]!
    merges.push({
      ids: sorted.map((record) => record.id),
      subject: lead.subject ?? '',
      text: clampText(lead.text, cfg.maxItemTokens, cfg.charsPerToken),
    })
  }
  if (pinnedMergeGroups > 0) {
    notes.push(`跳过 ${pinnedMergeGroups} 组含 pinned 条目的合并建议（合并不动 pinned）。`)
  }

  // ---- 4) 冲突（§6：不允许把用户侧条目判成 drop；§4 步骤 8：自画像不由规则下结论）
  const conflicts: SleepPlan['conflicts'] = []
  let protectedConflicts = 0
  let selfConflicts = 0
  for (const entry of findConflicts(records)) {
    if (entry.winner.kind === 'agent_self' || entry.loser.kind === 'agent_self') {
      selfConflicts += 1
      continue
    }
    if (entry.blocked || isUserSideOrigin(entry.loser.origin) || entry.loser.pinned) {
      protectedConflicts += 1
      continue
    }
    conflicts.push({
      keep: entry.winner.id,
      drop: entry.loser.id,
      subject: entry.winner.subject ?? entry.loser.subject ?? '',
    })
  }
  if (protectedConflicts > 0) {
    notes.push(`跳过 ${protectedConflicts} 条会失效用户侧条目的冲突建议（用户明确说过、被用户纠正过、以及 pinned 的条目不由规则推翻）。`)
  }
  if (selfConflicts > 0) {
    notes.push(`跳过 ${selfConflicts} 条涉及自画像（agent_self）的冲突建议：人格与工作倾向属于模型自我认知，不由规则下结论。`)
  }

  // ---- 5) 归档（agent_self / project_gist / pinned 由 `shouldArchive` 自己排除）
  const archive = records
    .filter((record) => record.status === 'active' && shouldArchive(record, cfg, now))
    .map((record) => record.id)

  // ---- 6) 项目印象：回放期间观察到的标记，按 workspace 重算
  const markerSets = new Map<string, Set<string>>()
  const latestOf = new Map<string, number>()
  for (const source of sources) {
    const key = workspaceKeyOf(source.cwd)
    if (!key) continue
    latestOf.set(key, Math.max(latestOf.get(key) ?? 0, source.createdAt))
    const set = markerSets.get(key) ?? new Set<string>()
    markerSets.set(key, set)
    for (const message of source.messages) {
      for (const marker of detectWorkspaceMarkers(message.text)) set.add(marker)
    }
  }
  const gistCandidates: Array<{ level: 'workspace'; key: string; text: string; at: number }> = []
  const gistMinMarkers = sleepCap(cfg.gistMinMarkers, DEFAULTS.gistMinMarkers)
  for (const [key, markers] of markerSets) {
    if (markers.size < gistMinMarkers) continue
    // 并集按标记表的规范顺序输出，composeGistText 的文案才稳定（跨会话也是同一个顺序）
    const ordered = [...markers].sort((a, b) => (MARKER_ORDER.get(a) ?? 0) - (MARKER_ORDER.get(b) ?? 0))
    const text = clampText(composeGistText(ordered), cfg.maxItemTokens, cfg.charsPerToken)
    if (!text) continue
    // 库里已有同样文本的项目印象 → 这次无需改动（这也是「第二次 /sleep 无事可做」的一部分）。
    // subject 与宿主刷新路径保持一致（`project.overview`）：否则计划说「没变化」而宿主会新建一条。
    const unchanged = records.some((record) => record.status === 'active'
      && record.kind === 'project_gist'
      && record.scope.level === 'workspace'
      && record.scope.key === key
      && record.subject === 'project.overview'
      && record.text === text)
    if (unchanged) continue
    gistCandidates.push({ level: 'workspace', key, text, at: latestOf.get(key) ?? 0 })
  }
  gistCandidates.sort((a, b) => (b.at - a.at) || compareText(a.key, b.key))
  const maxGists = sleepCap(cfg.sleepMaxGists, DEFAULTS.sleepMaxGists)
  // 只把契约 §4 声明的三个字段交出去（排序用的 `at` 是内部信息，不进计划）
  const gists: SleepPlan['gists'] = maxGists > 0
    ? gistCandidates.slice(0, maxGists).map(({ level, key, text }) => ({ level, key, text }))
    : []
  if (gistCandidates.length > gists.length) {
    notes.push(`项目印象超过上限 ${maxGists} 条：只重算最近活跃的 ${gists.length} 个工作区，另有 ${gistCandidates.length - gists.length} 个未处理。`)
  }

  // ---- 7) 裁剪：取最新的 `cfg.sleepMaxBackfill` 条，其余计入 truncated
  const orderKeyOf = (candidate: SleepCandidate): number =>
    candidate.at ?? createdAtOf.get(candidate.sessionId) ?? 0
  const orderedBackfill = [...found].sort((a, b) => (orderKeyOf(a) - orderKeyOf(b))
    || compareText(a.sessionId, b.sessionId)
    || compareText(a.hash, b.hash))
  const maxBackfill = sleepCap(cfg.sleepMaxBackfill, DEFAULTS.sleepMaxBackfill)
  const backfill = maxBackfill > 0
    ? orderedBackfill.slice(Math.max(0, orderedBackfill.length - maxBackfill))
    : []
  const truncated = orderedBackfill.length - backfill.length
  if (truncated > 0) {
    notes.push(`补录候选 ${orderedBackfill.length} 条超过上限 ${maxBackfill} 条：只补录最新的 ${backfill.length} 条，其余 ${truncated} 条本次未补录。`)
  }

  if (sources.length === 0) {
    notes.push('没有可回看的会话（未提供会话记录，或全部被跳过）。')
  } else if (scannedMessages === 0) {
    notes.push(`最近 ${sources.length} 个会话里没有可回放的消息（注入的 runtime-context 消息与子代理会话都不算）。`)
  }

  return {
    scanned: { sessions: sources.length, messages: scannedMessages, chars: scannedChars },
    backfill,
    duplicates,
    merges,
    conflicts,
    archive,
    gists,
    notes,
    truncated,
  }
}

/** 局部时间戳（人读用；`formatSleepPlan` 内部使用）。 */
function stampOf(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '-'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function shortId(id: string): string {
  return id ? String(id).slice(0, 8) : '-'
}

/**
 * 预览/回报文本（中文，与既有命令风格一致；空计划必须给出「无需改动」而不是空白）。
 *
 * 按**预览**语义渲染：尾行会声明「以上为计划，未写入任何内容」。
 * `--apply` 之后的回报文本请由宿主另行生成（要报的是写入计数，不是计划）。
 */
export function formatSleepPlan(plan: SleepPlan, cfg: MemoryConfig): string {
  const lines: string[] = ['[记忆梳理稿 · 预览]']
  const scanned = plan?.scanned ?? { sessions: 0, messages: 0, chars: 0 }
  lines.push(`回看 ${scanned.sessions} 个会话 · ${scanned.messages} 条消息 · ${scanned.chars} 字符；`
    + `与库内指纹重复而跳过 ${plan?.duplicates ?? 0} 条。`)

  if (sleepPlanIsEmpty(plan)) {
    lines.push('无需改动：没有可补录的候选，也没有需要合并/失效/归档的条目。')
  } else {
    if (plan.backfill.length > 0) {
      lines.push(`补录 ${plan.backfill.length} 条（按时间升序）：`)
      for (const candidate of plan.backfill) {
        const parts = [String(candidate.origin), `会话 ${shortId(candidate.sessionId)}`]
        if (candidate.at !== null && Number.isFinite(candidate.at)) parts.push(stampOf(candidate.at))
        lines.push(`  - ${clampText(candidate.text, cfg.maxItemTokens, cfg.charsPerToken)}（${parts.join(' · ')}）`)
      }
    }
    if (plan.merges.length > 0) {
      lines.push(`合并 ${plan.merges.length} 组：`)
      for (const merge of plan.merges) {
        lines.push(`  - ${merge.subject || '(无主题)'}：${merge.ids.length} 条，保留 ${shortId(merge.ids[0] ?? '')}「${merge.text}」`)
      }
    }
    if (plan.conflicts.length > 0) {
      lines.push(`失效 ${plan.conflicts.length} 条：`)
      for (const conflict of plan.conflicts) {
        lines.push(`  - 保留 ${shortId(conflict.keep)}，失效 ${shortId(conflict.drop)}（${conflict.subject || '(无主题)'}）`)
      }
    }
    if (plan.archive.length > 0) {
      const sample = plan.archive.slice(0, 5).map((id) => shortId(id)).join('、')
      lines.push(`归档 ${plan.archive.length} 条：${sample}${plan.archive.length > 5 ? ` 等 ${plan.archive.length} 条` : ''}`)
    }
    if (plan.gists.length > 0) {
      lines.push(`项目印象 ${plan.gists.length} 条：`)
      for (const gist of plan.gists) lines.push(`  - ${gist.key}：${gist.text}`)
    }
  }

  if (plan?.truncated > 0) {
    lines.push(`裁剪：补录候选超出上限，本次少补录 ${plan.truncated} 条（见下方说明）。`)
  }
  if ((plan?.notes?.length ?? 0) > 0) {
    lines.push('说明：')
    for (const note of plan.notes) lines.push(`  - ${clampText(note, 300, cfg.charsPerToken)}`)
  }
  lines.push('以上为计划，未写入任何内容；确认后用 /sleep --apply 落盘（会先自动导出备份）。')
  return lines.join('\n')
}

/** 计划是否无事可做（backfill/merges/conflicts/archive/gists 全空）。 */
export function sleepPlanIsEmpty(plan: SleepPlan): boolean {
  if (!plan) return true
  return plan.backfill.length === 0
    && plan.merges.length === 0
    && plan.conflicts.length === 0
    && plan.archive.length === 0
    && plan.gists.length === 0
}

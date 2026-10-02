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
  gistMaxPerWorkspace: 8,
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

export function clampText(text: unknown, maxTokens: number, charsPerToken: number = DEFAULTS.charsPerToken): string {
  const source = String(text)
  const maxChars = Math.max(8, Math.floor(maxTokens * charsPerToken))
  return source.length <= maxChars ? source : `${source.slice(0, maxChars - 1)}…`
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

/** 自画像块（section 通道）：用户确认的约定与模型自评**必须分开成块**（设计稿 §7.3）。 */
export function renderSelfBlock(records: Iterable<MemoryRecord>, cfg: MemoryConfig): RenderedBlock {
  const eligible = listActive(records)
    .filter((record) => record.kind === 'agent_self')
    .filter((record) => isSelfPortraitEligible(record, cfg))
    .sort(compareRecords)

  const userSide = eligible.filter((record) => record.origin === 'user_explicit' || record.origin === 'user_correction')
  // 模型自评单独限配额：不能挤掉用户定下的规矩（设计稿 §7.3）
  const selfObserved = eligible
    .filter((record) => record.origin === 'model_proposed')
    .slice(0, cfg.selfPortraitMaxSelfObserved ?? 4)

  // 块头尾也要计入预算，否则「硬上限」会被块级固定文案突破
  const confirmedHeader = '[我的工作约定 · 来自用户确认]'
  const observedHeader = '[自我观察 · 未经用户确认]'
  const observedFooter = '以上为自我观察，可能不准；与用户当场的指示冲突时以用户为准。'
  const confirmedBudget = Math.max(0, cfg.selfPortraitMaxTokens
    - estimateTokens(confirmedHeader, cfg.charsPerToken)
    - (selfObserved.length > 0 ? estimateTokens(`${observedHeader}${observedFooter}`, cfg.charsPerToken) : 0))

  const confirmed = fillWithinBudget(userSide.slice(0, cfg.selfPortraitMaxItems), confirmedBudget,
    (_record, text) => `- ${text}`, cfg)
  const observed = fillWithinBudget(selfObserved, cfg.selfPortraitMaxTokens,
    (_record, text) => `- ${text}`, cfg)

  const blocks: string[] = []
  if (confirmed.lines.length > 0) blocks.push([confirmedHeader, ...confirmed.lines].join('\n'))
  if (observed.lines.length > 0) blocks.push([observedHeader, ...observed.lines, observedFooter].join('\n'))

  return {
    lines: [...confirmed.lines, ...observed.lines],
    selected: [...confirmed.selected, ...observed.selected],
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
  const FACTS_FOOTER = '以上历史信息如与当前对话冲突，以当前对话为准。'
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

/** 敏感信息扫描：返回命中的 reason，或 null。 */
export function scanSensitive(text: unknown): string | null {
  const source = String(text)
  for (const { reason, re } of SENSITIVE_PATTERNS) {
    if (re.test(source)) return reason
  }
  return null
}

/** 可脱敏（而非直接拒写）的个人信息形态：邮箱、手机号（设计稿 §8.3）。 */
export function maskPii(text: unknown): string {
  return String(text)
    // 邮箱：只保留首字母与域名 → a***@b.com
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gu, '$1***$2')
    // 中国大陆手机号：保留前 3 后 4 → 138****8000
    .replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/gu, '$1****$2')
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

/** 词面命中率：查询 token 在记录里的覆盖率（0–1）。空查询视为完全匹配。
 *  适合**短查询**（模型显式 recall、销毁性操作）。 */
export function lexicalMatch(record: MemoryRecord, query: unknown): number {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return 1
  const haystack = new Set(tokenize(`${record.text} ${record.subject ?? ''} ${(record.tags ?? []).join(' ')}`))
  let hits = 0
  for (const token of queryTokens) if (haystack.has(token)) hits += 1
  return hits / queryTokens.length
}

/**
 * 记忆侧命中度：适合**长查询**（R2 用整轮用户消息去匹配一句话记忆）。
 * 语义是「这条记忆的若干关键词出现在了本轮里」，因此
 *   · 分母封顶（默认 4）：不因为记忆长就吃亏；
 *   · 要求至少 `minHits` 个有信息量的 token（长度 ≥2 且非纯数字），挡掉巧合命中。
 * 用查询覆盖率做这件事会在长消息下趋近 0，这是 M4 评测暴露出来的缺陷。
 */
export function memoryMatch(record: MemoryRecord, query: unknown, options: MemoryMatchOptions = {}): number {
  const recordTokens = new Set(tokenize(`${record.text} ${record.subject ?? ''} ${(record.tags ?? []).join(' ')}`))
  if (recordTokens.size === 0) return 0
  const queryTokens = new Set(tokenize(query))
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

/** M1 的轻量检索打分：词面命中 + 重要度 + 时效（向量留到 M4）。 */
export function scoreRecord(record: MemoryRecord, query: unknown, now: number = Date.now(), matchOverride?: number): number {
  if (normalizeText(query).length === 0) return record.importance
  const lexical = matchOverride ?? lexicalMatch(record, query)
  // 有查询但词面完全没命中 → 不参与召回（避免「不相关条目靠重要度混进来」）。
  if (lexical === 0) return 0
  const ageDays = Math.max(0, (now - (record.lastUsedAt ?? record.observedAt)) / 86_400_000)
  const recency = 1 / (1 + ageDays / 30)
  return 0.6 * lexical + 0.3 * record.importance + 0.1 * recency
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
  const hasQuery = normalizeText(query).length > 0
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
        ? memoryMatch(record, query, { minHits: options?.minHits ?? 2 })
        : lexicalMatch(record, query)
      return { record, match, score: scoreRecord(record, query, now, match) }
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

import type { CaptureCandidate, MakeRecordInput, MemoryConfig, MemoryKind, MemoryOrigin, MemoryRecord, MemoryScope, RecallHit, RecallOptions, RenderedBlock, ScopeLevel, SelfFacet } from './types.js';
export type { CaptureCandidate, MakeRecordInput, MemoryConfig, MemoryKind, MemoryOrigin, MemoryRecord, MemoryScope, RecallHit, RecallOptions, RenderedBlock, ScopeLevel, SelfFacet, } from './types.js';
/** `makeRecord` 的入参：`MakeRecordInput` 再加 `sessionId`（types.ts 目前缺这个字段）。 */
export interface MakeRecordInputWithSession extends MakeRecordInput {
    sessionId?: string;
}
/** 指纹入参：只需要指纹相关字段，因此「尚未补上 hash 的记录」也能直接求指纹。 */
export interface RecordHashInput {
    kind: MemoryKind;
    scope?: MemoryScope | null;
    subject?: string | null;
    text: string;
}
/** `CAPTURE_SIGNALS` 的一行。 */
export interface CaptureSignal {
    id: string;
    kind: MemoryKind;
    origin: MemoryOrigin;
    confidence: number;
    importance: number;
    re: RegExp;
}
/** `extractCandidates` 的返回值。 */
export interface ExtractCandidatesResult {
    candidates: CaptureCandidate[];
    skipped: Record<string, number>;
}
/** `fillWithinBudget` 的返回值（没有块级文案，因此不复用 `RenderedBlock`）。 */
export interface BudgetFill<T> {
    lines: string[];
    used: number;
    selected: T[];
}
/** `memoryMatch` 的可选参数。 */
export interface MemoryMatchOptions {
    minHits?: number;
    matchCap?: number;
}
/** `findConflicts` 的一条冲突：winner 拟取代 loser；`blocked` 为 true 时禁止这次自动推翻。 */
export interface ConflictEntry {
    winner: MemoryRecord;
    loser: MemoryRecord;
    blocked: boolean;
}
/** `composeSubjectSummary` 产出的一条规则式摘要。 */
export interface SubjectSummary {
    key: string;
    subject: string | null;
    kind: MemoryKind;
    scope: MemoryScope;
    text: string;
    absorbed: string[];
}
/** 消息内容块视图（`deriveOriginFromMessages` 只读 type/text）。 */
export interface MemoryMessageContentBlock {
    type?: string;
    text?: string;
}
/** 消息视图（宿主消息只保证这几处可用）。 */
export interface MemoryMessageLike {
    role?: string;
    source?: {
        kind?: string;
    } | null;
    content?: unknown;
}
/** compaction 摘要块视图（`extractSummaryText` 只读 type/text）。 */
export interface SummaryTextBlock {
    type?: string;
    text?: string;
}
export declare const DEFAULTS: MemoryConfig;
/** 显式祈使信号：命中表示「用户在明确要求记住」，决定写入来源为 user_explicit。 */
export declare const EXPLICIT_SIGNAL_RE: RegExp;
/** FNV-1a 短哈希：用于 workspace scope key 与去重指纹（稳定、无依赖）。 */
export declare function fnv1a(input: unknown): string;
/** 归一化：全角转半角、折叠空白、英文小写、去尾部标点（用于指纹与去重）。 */
export declare function normalizeText(text: unknown): string;
/** 廉价 token 估算：保守折中（中文约 1.5 字/token、英文约 4 字/token）。 */
export declare function estimateTokens(text: unknown, charsPerToken?: number): number;
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
export declare function clampText(text: unknown, maxTokens: number, charsPerToken?: number): string;
/** 去重指纹：kind|scope.level|scope.key|subject|归一化文本。
 *  必须含 `scope.key`：否则 A 项目里写的同一句话会被判成「B 项目已有」而合并到错误的 scope。 */
export declare function recordHash(record: RecordHashInput): string;
/** 构造一条记忆记录（字段与设计稿 §4.1 对齐）。 */
export declare function makeRecord(input: MakeRecordInputWithSession, now?: number): MemoryRecord;
export declare function defaultScopeFor(kind: MemoryKind): ScopeLevel;
/** 确定性排序：pinned → importance → confidence → id（服务设计稿 I1）。 */
export declare function compareRecords(a: MemoryRecord, b: MemoryRecord): number;
export declare function listActive(records: Iterable<MemoryRecord>): MemoryRecord[];
export declare function workspaceKeyOf(cwd: unknown): string | null;
/** 按 token 预算逐条填充（设计稿 §7.2）。返回选中的条目，便于调用方记用量。 */
export declare function fillWithinBudget(records: Iterable<MemoryRecord>, budgetTokens: number, render: (record: MemoryRecord, text: string) => string, cfg: MemoryConfig): BudgetFill<MemoryRecord>;
/** 自画像准入（设计稿 §7.3）：用户侧来源直接进；模型自评必须跨 ≥N 个不同会话复现。 */
export declare function isSelfPortraitEligible(record: MemoryRecord, cfg: MemoryConfig): boolean;
/** 自画像块（section 通道）：**人格小节在前**，工作两节在后（M6 §3）。
 *
 *  · 人格小节（`facet='persona'`）用独立预算 `cfg.selfPersonaMaxTokens`；块内**用户侧优先**，
 *    模型自评只吃余额，两组的条数各自受 `cfg.selfPortraitMaxSelfObserved` 约束；
 *    页脚是安全声明（描述而非指令），因此只要小节非空就必须带页脚。
 *  · 工作两节（`facet` 缺失 → `'work'`，存量兼容）沿用 0.5.x 的文案与预算口径：
 *    两节共享 `cfg.selfPortraitMaxTokens`，用户确认的约定优先，总长（含块头页脚）不超上限。
 */
export declare function renderSelfBlock(records: Iterable<MemoryRecord>, cfg: MemoryConfig): RenderedBlock;
/** 召回块（context 通道）：用户画像/事实 + 当前 workspace 的项目模糊印象。
 *  常驻注入只收 profile 级与「当前 workspace」级；session 级属于临时上下文，永不常驻。 */
export declare function renderContextBlock(records: Iterable<MemoryRecord>, cfg: MemoryConfig, workspaceKey: string | null): RenderedBlock;
/** 敏感信息扫描：返回命中的 reason，或 null。全角/兼容写法同样命中。 */
export declare function scanSensitive(text: unknown): string | null;
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
export declare function maskPii(text: unknown): string;
/**
 * 写入来源判定（设计稿 §5.1：判定权在插件，不在模型）。
 * 只认 source.kind === 'user' 的真实用户消息，且必须来自最后一个回合；
 * 我们注入的 runtime-context 消息不算用户要求。
 */
export declare function deriveOriginFromMessages(messages: unknown): MemoryOrigin;
/**
 * 分词（设计稿 §6.1）：拉丁词 + 轻量词干；CJK 连续串切 bigram（长度 1 时保留单字）。
 * 例：`记忆数据落在` → 记忆/忆数/数据/据落/落在；`scripts/release.mjs` → scripts/release/mjs。
 */
export declare function tokenize(text: unknown): string[];
/** 清空分词缓存（供测试与基准使用；正常运行靠指纹键自然失效）。 */
export declare function clearTokenCache(): void;
/** 当前缓存条目数（可观测性）。 */
export declare function tokenCacheSize(): number;
/** 词面命中率：查询 token 在记录里的覆盖率（0–1）。空查询视为完全匹配。
 *  适合**短查询**（模型显式 recall、销毁性操作）。 */
export declare function lexicalMatch(record: MemoryRecord, query: unknown): number;
export declare function memoryMatch(record: MemoryRecord, query: unknown, options?: MemoryMatchOptions): number;
/** M1 的轻量检索打分：词面命中 + 重要度 + 时效（向量留到 M4）。 */
export declare function scoreRecord(record: MemoryRecord, query: unknown, now?: number, matchOverride?: number): number;
/** 检索：过滤 → 打分 → 确定性排序。
 *  `mode: 'query'`（默认）= 短查询，按查询覆盖率判定，minLexical 默认 0.34；
 *  `mode: 'memory'` = 长查询（整轮用户消息），按记忆侧覆盖率判定，minMatch 默认 0.4 + minHits 2。
 *  `includeArchived: true` 也纳入归档条目（设计稿 §4.4：归档只是不常驻注入，仍可被检索到）；
 *  `invalid` 永不参与检索。
 *  破坏性操作（删除）应传更高的 minLexical（如 0.6）。 */
export declare function recallRecords(records: Iterable<MemoryRecord>, options: RecallOptions, now?: number): RecallHit[];
/** 排除规则（设计稿 §5.2）：命中即丢弃，并记录原因以便观测。 */
export declare function isExcluded(text: unknown): string | null;
/** 句子切分：中文句末标点与换行。**保留句末标点**，否则「疑问句排除」无法判定。 */
export declare function splitSentences(text: unknown): string[];
/** 捕获信号表（设计稿 §5.2）：顺序即优先级，先匹配者胜。 */
export declare const CAPTURE_SIGNALS: CaptureSignal[];
/**
 * 从用户消息里抽取候选记忆（**只看用户侧**——防自激闸门 1）。
 * @returns {{ candidates: object[], skipped: Record<string, number> }}
 */
export declare function extractCandidates(userText: unknown, cfg: MemoryConfig, now?: number): ExtractCandidatesResult;
/** token 集合相似度（Jaccard）：用于回声剔除（对称、对长度差敏感）。 */
export declare function similarity(a: unknown, b: unknown): number;
/** 包含度（intersection / min）：用于「同一件事的两种说法」的合并判定，比 Jaccard 更稳。 */
export declare function containment(a: unknown, b: unknown): number;
/** 回声剔除（防自激闸门 2）：与刚注入的任何一行高度相似 → 视为模型在复述自己。 */
export declare function isEcho(text: unknown, injectedLines: unknown, threshold?: number): boolean;
export declare function detectWorkspaceMarkers(text: unknown): string[];
export declare function composeGistText(markers: readonly string[]): string;
/** 按 kind 的半衰期（天）。设计稿 §4.4：自画像（用户侧）与做法类不衰减。 */
export declare const HALF_LIFE_DAYS: Record<MemoryKind, number>;
/** 有效重要度：importance × 时间衰减。pinned 与不衰减类型原样返回。
 *  `agent_self` 按来源分档：用户侧来源不衰减；**模型自评走 90 天半衰期**（设计稿 §4.4），
 *  否则一次自评会永久留在 system prompt 里。 */
export declare function effectiveImportance(record: MemoryRecord, now?: number): number;
/** 归档判定（设计稿 §4.4）：低有效重要度且长期未用；自画像与项目印象不归档。 */
export declare function shouldArchive(record: MemoryRecord, cfg: MemoryConfig, now?: number): boolean;
/** 合并分组：同 kind + 同 scope + 同 subject 且文本相似度 ≥ 阈值。 */
export declare function pickMergeGroups(records: Iterable<MemoryRecord>, cfg: MemoryConfig): MemoryRecord[][];
/** 冲突判定（设计稿 §4.3）：同 (kind, scope, subject, field) 但 value 不同。 */
export declare function findConflicts(records: Iterable<MemoryRecord>): ConflictEntry[];
/** 是否为用户侧来源（用户明说或用户纠正）。 */
export declare function isUserSideOrigin(origin: MemoryOrigin): boolean;
/**
 * 从文本派生稳定主题键（无模型调用）：取最有信息量的两个 token。
 * 用途：让「同一件事的两种说法」能落到同一个 subject 上，从而让去重/合并/冲突判定真正生效。
 */
export declare function deriveSubject(text: unknown, prefix?: string): string | null;
/** 规则式摘要（零模型调用）：单一 subject 下 active 条目过多时合成一条。 */
export declare function composeSubjectSummary(records: Iterable<MemoryRecord>, cfg: MemoryConfig): SubjectSummary[];
/** 从 compaction 摘要的 ContentBlock[] 里取纯文本（压缩固化用）。 */
export declare function extractSummaryText(summaryBlocks: unknown): string;
/** 人格小节的块头。 */
export declare const PERSONA_HEADER: string;
/**
 * 人格小节的页脚：**安全声明**（契约 §6，不可妥协）。
 * 自画像是模型对自己的**描述**，不是用户给的指令；它不能变成任何授权。
 */
export declare const PERSONA_FOOTER: string;
/** 工作小节块头：0.5.x 既有文案，向后兼容。 */
export declare const WORK_CONFIRMED_HEADER: string;
/** 自我观察块头：0.5.x 既有文案。 */
export declare const WORK_OBSERVED_HEADER: string;
/** 自我观察块尾：0.5.x 既有文案。 */
export declare const WORK_OBSERVED_FOOTER: string;
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
export declare const REFLECT_NOTICE: string;
/** 解析任意输入为 facet；无法识别时返回 `fallback`（默认 `'work'`，即 0.5.x 的存量语义）。 */
export declare function normalizeFacet(value: unknown, fallback?: SelfFacet): SelfFacet;
/** 记录的 facet：`agent_self` 且无 `facet` 字段 → `'work'`（0.5.x 的存量条目都是工作约定）。 */
export declare function facetOf(record: MemoryRecord): SelfFacet;
/** 规范 subject：`self.persona.voice` / `self.work.strengths`。 */
export declare function portraitSubjectFor(facet: SelfFacet, key: string): string;
/** 自画像收敛决策的输入（模型侧候选）。 */
export interface PortraitCandidate {
    text: string;
    facet: SelfFacet;
    subject: string;
    origin: MemoryOrigin;
    confidence: number;
    observedAt?: number;
}
/** 收敛动作：新建 / 强化 / 合并改写 / 取代归档 / 不写。 */
export type PortraitAction = 'add' | 'reinforce' | 'refine' | 'supersede' | 'skip';
/** 收敛决策：宿主按它落盘（见契约 §4.1）。 */
export interface PortraitDecision {
    action: PortraitAction;
    /** 被 reinforce/refine/supersede 命中的既有条目 id；add/skip 时为 null。 */
    targetId: string | null;
    /** 最终要写入的正文（已过 `clampText`：单行、条目预算内）。 */
    text: string;
    /** 最终置信度（已夹到 0–1）。 */
    confidence: number;
    /** 可读原因，写进工具返回值与 stats：`added` / `reinforced` / `refined` / `superseded` / `too-short` / `user-owned`。 */
    reason: string;
    /** supersede 时是否把 target 归档（并写 `supersededBy`）。 */
    archiveTarget: boolean;
}
/** 自画像正文的最小长度（去空白后 < 8 字符没有信息量）。 */
export declare const PORTRAIT_MIN_TEXT_CHARS = 8;
/**
 * 自画像收敛决策：**纯函数、确定性**（契约 §3 的规则，按顺序判定）。
 *
 *  1. 正文去空白后 < 8 字符 → `skip` / `'too-short'`
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
export declare function planPortraitUpdate(candidate: PortraitCandidate, existing: Iterable<MemoryRecord>, cfg: MemoryConfig): PortraitDecision;
/** 一条修订链：同一 subject + facet 下由旧到新的自画像条目。 */
export interface PortraitRevision {
    subject: string;
    facet: SelfFacet;
    /** 由旧到新。 */
    chain: MemoryRecord[];
}
/**
 * 修订链：把 `supersededBy` / `supersedes` 互为反向的指针串起来（链内按 `observedAt` 升序 = 由旧到新）。
 *
 * 只返回**真的发生过修订**的组（链长 ≥ 2）：单条 active 条目不是历史，`/memory self` 已经会列出它。
 * 返回值按「最新一条修订时间」倒序（新的修订在前），同刻按 subject 稳定排序。
 */
export declare function portraitHistory(records: Iterable<MemoryRecord>): PortraitRevision[];
/** 反思提醒闸门的输入（契约 §3）。 */
export interface ReflectInput {
    /** 当前回合号。 */
    turn: number;
    /** 本会话上一次反思提醒的回合号；从未提醒过为 null。 */
    lastReflectTurn: number | null;
    /** 本会话已提醒次数。 */
    reflectionsThisSession: number;
    /** 本会话已进行的回合数。 */
    sessionTurns: number;
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
export declare function shouldReflect(input: ReflectInput, cfg: MemoryConfig): boolean;
//# sourceMappingURL=lib.d.ts.map
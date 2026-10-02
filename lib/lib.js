// dsh-memory 纯函数层：可单独单测，不依赖 Cordis ctx。
// 设计依据：dsh-memory-plugin-design-detail.md §4（记录与判定）、§5.3（预算）、§6（检索）、§7（注入）。
export const DEFAULTS = {
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
};
/** 显式祈使信号：命中表示「用户在明确要求记住」，决定写入来源为 user_explicit。 */
export const EXPLICIT_SIGNAL_RE = /(记住|记一下|记下|帮我记|以后都|以后也|从现在起|别再|不要再用|下次要|remember|always|never)/iu;
/** 敏感信息形态：命中即拒写（设计稿 §8.3，无 force 通道）。 */
const SENSITIVE_PATTERNS = [
    { reason: 'api-key', re: /\b(sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/u },
    { reason: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/iu },
    { reason: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
    { reason: 'password', re: /(密码|口令|passwd|password)\s*[:：=]\s*\S{6,}/iu },
    { reason: 'cn-id', re: /\b\d{17}[0-9Xx]\b/u },
    { reason: 'bank-card', re: /\b(?:\d[ -]?){16,19}\b/u },
];
/** FNV-1a 短哈希：用于 workspace scope key 与去重指纹（稳定、无依赖）。 */
export function fnv1a(input) {
    let hash = 0x811c9dc5;
    const text = String(input);
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}
/** 归一化：全角转半角、折叠空白、英文小写、去尾部标点（用于指纹与去重）。 */
export function normalizeText(text) {
    return String(text)
        .replace(/[\uFF01-\uFF5E]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/[.!?。！？,，;；]+$/u, '')
        .trim()
        .toLowerCase();
}
/** 廉价 token 估算：保守折中（中文约 1.5 字/token、英文约 4 字/token）。 */
export function estimateTokens(text, charsPerToken = DEFAULTS.charsPerToken) {
    return Math.ceil(String(text).length / charsPerToken);
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
export function clampText(text, maxTokens, charsPerToken = DEFAULTS.charsPerToken) {
    const flat = String(text)
        .replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
    // 有限性兜底：`maxItemTokens` 可能被 patch 行设成 Infinity（或 NaN），那样 `slice` 不截断，
    // 一条超长记忆会吃掉整个预算并让 `fillWithinBudget` 立刻 break，把后面的条目全挤掉。
    const tokenBudget = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULTS.maxItemTokens;
    const perToken = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULTS.charsPerToken;
    const maxChars = Math.max(8, Math.floor(tokenBudget * perToken));
    return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}
/** 去重指纹：kind|scope.level|scope.key|subject|归一化文本。
 *  必须含 `scope.key`：否则 A 项目里写的同一句话会被判成「B 项目已有」而合并到错误的 scope。 */
export function recordHash(record) {
    return fnv1a([
        record.kind,
        record.scope?.level ?? '',
        record.scope?.key ?? '',
        record.subject ?? '',
        normalizeText(record.text),
    ].join('|'));
}
let idCounter = 0;
/** 构造一条记忆记录（字段与设计稿 §4.1 对齐）。 */
export function makeRecord(input, now = Date.now()) {
    idCounter = (idCounter + 1) % 46656;
    const record = {
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
    };
    // M6：自画像小节的透传（可选字段；缺失时不写键，保持 0.5.x 的存量形状）。
    if (input.facet !== undefined)
        record.facet = normalizeFacet(input.facet, 'work');
    if (input.supersededBy !== undefined)
        record.supersededBy = String(input.supersededBy);
    record.hash = recordHash(record);
    return record;
}
export function defaultScopeFor(kind) {
    if (kind === 'user_profile' || kind === 'agent_self')
        return 'profile';
    // project_gist / semantic / procedural / episodic：都与「某个项目」绑定，
    // 因此默认 workspace 级；session 级只用于显式指定的临时上下文，不进常驻注入。
    return 'workspace';
}
/** 确定性排序：pinned → importance → confidence → id（服务设计稿 I1）。 */
export function compareRecords(a, b) {
    if (a.pinned !== b.pinned)
        return a.pinned ? -1 : 1;
    if (b.importance !== a.importance)
        return b.importance - a.importance;
    if (b.confidence !== a.confidence)
        return b.confidence - a.confidence;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
export function listActive(records) {
    return [...records].filter((record) => record.status === 'active');
}
export function workspaceKeyOf(cwd) {
    return typeof cwd === 'string' && cwd.length > 0 ? fnv1a(cwd) : null;
}
/** 按 token 预算逐条填充（设计稿 §7.2）。返回选中的条目，便于调用方记用量。 */
export function fillWithinBudget(records, budgetTokens, render, cfg) {
    const lines = [];
    const selected = [];
    let used = 0;
    for (const record of records) {
        const text = clampText(record.text, cfg.maxItemTokens, cfg.charsPerToken);
        const line = render(record, text);
        const cost = estimateTokens(line, cfg.charsPerToken);
        if (used + cost > budgetTokens)
            break;
        lines.push(line);
        selected.push(record);
        used += cost;
    }
    return { lines, used, selected };
}
/** 自画像准入（设计稿 §7.3）：用户侧来源直接进；模型自评必须跨 ≥N 个不同会话复现。 */
export function isSelfPortraitEligible(record, cfg) {
    if (record.status !== 'active')
        return false;
    if (record.origin === 'user_explicit' || record.origin === 'user_correction') {
        return record.confidence >= (cfg.selfPortraitMinConfidence ?? 0.8);
    }
    if (record.origin === 'model_proposed') {
        const sessions = record.reinforcement?.sessions?.length ?? 0;
        return record.confidence >= (cfg.selfPortraitModelMinConfidence ?? 0.85)
            && sessions >= (cfg.selfPortraitPromoteSessions ?? 2);
    }
    return false;
}
/** 自画像块（section 通道）：**人格小节在前**，工作两节在后（M6 §3）。
 *
 *  · 人格小节（`facet='persona'`）用独立预算 `cfg.selfPersonaMaxTokens`；块内**用户侧优先**，
 *    模型自评只吃余额，两组的条数各自受 `cfg.selfPortraitMaxSelfObserved` 约束；
 *    页脚是安全声明（描述而非指令），因此只要小节非空就必须带页脚。
 *  · 工作两节（`facet` 缺失 → `'work'`，存量兼容）沿用 0.5.x 的文案与预算口径：
 *    两节共享 `cfg.selfPortraitMaxTokens`，用户确认的约定优先，总长（含块头页脚）不超上限。
 */
export function renderSelfBlock(records, cfg) {
    if (cfg.selfPortraitEnabled === false)
        return { lines: [], selected: [], text: '' };
    const eligible = listActive(records)
        .filter((record) => record.kind === 'agent_self')
        .filter((record) => isSelfPortraitEligible(record, cfg))
        .sort(compareRecords);
    const personaRecords = eligible.filter((record) => facetOf(record) === 'persona');
    const workRecords = eligible.filter((record) => facetOf(record) === 'work');
    const maxSelfObserved = cfg.selfPortraitMaxSelfObserved ?? 4;
    // ---- 人格小节（在前）
    const personaBudget = cfg.selfPersonaMaxTokens ?? DEFAULTS.selfPersonaMaxTokens;
    // 块头尾也要计入预算，否则「硬上限」会被块级固定文案突破
    const personaChrome = estimateTokens(`${PERSONA_HEADER}\n${PERSONA_FOOTER}`, cfg.charsPerToken);
    const personaUser = fillWithinBudget(personaRecords.filter((record) => isUserSideOrigin(record.origin)).slice(0, maxSelfObserved), Math.max(0, personaBudget - personaChrome), (_record, text) => `- ${text}`, cfg);
    const personaObserved = fillWithinBudget(personaRecords.filter((record) => record.origin === 'model_proposed').slice(0, maxSelfObserved), Math.max(0, personaBudget - personaChrome - personaUser.used), (_record, text) => `- ${text}`, cfg);
    // ---- 工作两节（在后，沿用既有文案与预算分配）
    const userSide = workRecords.filter((record) => isUserSideOrigin(record.origin));
    // 模型自评单独限配额：不能挤掉用户定下的规矩（设计稿 §7.3）
    const selfObserved = workRecords
        .filter((record) => record.origin === 'model_proposed')
        .slice(0, maxSelfObserved);
    // 分配顺序按设计稿 §7.3：**用户确认的规矩优先**，模型自评只吃剩下的余额；
    // 两段合计（含两个块头与页脚）不超过 selfPortraitMaxTokens。
    const confirmed = fillWithinBudget(userSide.slice(0, cfg.selfPortraitMaxItems), Math.max(0, cfg.selfPortraitMaxTokens - estimateTokens(WORK_CONFIRMED_HEADER, cfg.charsPerToken)), (_record, text) => `- ${text}`, cfg);
    const observed = selfObserved.length === 0
        ? { lines: [], selected: [], used: 0 }
        : fillWithinBudget(selfObserved, Math.max(0, cfg.selfPortraitMaxTokens
            - estimateTokens(`${WORK_CONFIRMED_HEADER}${WORK_OBSERVED_HEADER}${WORK_OBSERVED_FOOTER}`, cfg.charsPerToken)
            - confirmed.used), (_record, text) => `- ${text}`, cfg);
    const personaLines = [...personaUser.lines, ...personaObserved.lines];
    const blocks = [];
    if (personaLines.length > 0)
        blocks.push([PERSONA_HEADER, ...personaLines, PERSONA_FOOTER].join('\n'));
    if (confirmed.lines.length > 0)
        blocks.push([WORK_CONFIRMED_HEADER, ...confirmed.lines].join('\n'));
    if (observed.lines.length > 0)
        blocks.push([WORK_OBSERVED_HEADER, ...observed.lines, WORK_OBSERVED_FOOTER].join('\n'));
    return {
        lines: [...personaLines, ...confirmed.lines, ...observed.lines],
        selected: [...personaUser.selected, ...personaObserved.selected, ...confirmed.selected, ...observed.selected],
        text: blocks.join('\n\n'),
    };
}
/** 召回块（context 通道）：用户画像/事实 + 当前 workspace 的项目模糊印象。
 *  常驻注入只收 profile 级与「当前 workspace」级；session 级属于临时上下文，永不常驻。 */
export function renderContextBlock(records, cfg, workspaceKey) {
    const candidates = listActive(records)
        .filter((record) => record.kind !== 'agent_self')
        // 常驻层不放情景记忆（episodic 的常驻上限是 0，设计稿 §4.4）与整合摘要（摘要只供检索）
        .filter((record) => record.kind !== 'episodic')
        .filter((record) => !(record.tags ?? []).includes('summary'))
        .filter((record) => record.scope.level === 'profile'
        || (record.scope.level === 'workspace' && record.scope.key === workspaceKey))
        .sort(compareRecords);
    const facts = candidates.filter((record) => record.kind !== 'project_gist');
    const gists = candidates.filter((record) => record.kind === 'project_gist');
    // 块内的固定文案也算 token，否则「硬上限」会被它们突破
    const FACTS_HEADER = '[长期记忆 · 自动注入]';
    const FACTS_FOOTER = '以上历史信息如与当前对话冲突，以当前对话为准。';
    const GIST_HEADER = '[项目印象 · 模糊且可能过时]';
    const GIST_FOOTER = '以上为自动观察形成的模糊印象，不是精确事实；与当前代码/对话冲突时以实际为准。';
    const gistBudget = Math.max(40, Math.floor(cfg.maxInjectedTokens * cfg.gistBudgetRatio));
    const factsBudget = Math.max(0, cfg.maxInjectedTokens
        - estimateTokens(`${FACTS_HEADER}\n${FACTS_FOOTER}`, cfg.charsPerToken)
        - (gists.length > 0 ? estimateTokens(`${GIST_HEADER}\n${GIST_FOOTER}`, cfg.charsPerToken) : 0));
    const head = fillWithinBudget(facts, factsBudget, (record, text) => `- (${record.scope.level}) ${text}`, cfg);
    const gist = fillWithinBudget(gists, gistBudget, (_record, text) => `- ${text}`, cfg);
    const blocks = [];
    if (head.lines.length > 0) {
        blocks.push([FACTS_HEADER, ...head.lines, FACTS_FOOTER].join('\n'));
    }
    if (gist.lines.length > 0) {
        blocks.push([GIST_HEADER, ...gist.lines, GIST_FOOTER].join('\n'));
    }
    return {
        lines: [...head.lines, ...gist.lines],
        selected: [...head.selected, ...gist.selected],
        text: blocks.join('\n\n'),
    };
}
/**
 * 宽度折叠视图（NFKC）：**只用于判定**，不用于存储。
 *
 * 为什么必须折叠：半角正则匹配不到全角写法，而 `normalizeText`（注入/检索前会用）却会把
 * 全角 U+FF01–FF5E 折回半角 —— 于是「用全角写的身份证/卡号」既能绕过拒写，又会在注入时
 * 变回合法号码进系统提示。扫描与 PII 判定先折叠，才能让两种写法一视同仁。
 */
function foldWidth(value) {
    return String(value).normalize('NFKC');
}
/** 敏感信息扫描：返回命中的 reason，或 null。全角/兼容写法同样命中。 */
export function scanSensitive(text) {
    const source = foldWidth(text);
    for (const { reason, re } of SENSITIVE_PATTERNS) {
        if (re.test(source))
            return reason;
    }
    return null;
}
/** 可脱敏（而非直接拒写）的个人信息形态：邮箱、手机号（设计稿 §8.3）。 */
const PII_EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gu;
const PII_PHONE_RE = /\b(1[3-9]\d)\d{4}(\d{4})\b/gu;
/** 无 `g` 标志的探测副本：`test` 不会因为 lastIndex 状态而漏判。 */
const PII_EMAIL_PROBE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;
const PII_PHONE_PROBE = /\b1[3-9]\d{9}\b/u;
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
export function maskPii(text) {
    const source = String(text);
    const folded = foldWidth(source);
    if (!PII_EMAIL_PROBE.test(folded) && !PII_PHONE_PROBE.test(folded))
        return source;
    return folded
        // 邮箱：只保留首字母与域名 → a***@b.com
        .replace(PII_EMAIL_RE, '$1***$2')
        // 中国大陆手机号：保留前 3 后 4 → 138****8000
        .replace(PII_PHONE_RE, '$1****$2');
}
/**
 * 写入来源判定（设计稿 §5.1：判定权在插件，不在模型）。
 * 只认 source.kind === 'user' 的真实用户消息，且必须来自最后一个回合；
 * 我们注入的 runtime-context 消息不算用户要求。
 */
export function deriveOriginFromMessages(messages) {
    if (!Array.isArray(messages))
        return 'model_proposed';
    const list = messages;
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const message = list[index];
        if (message?.role !== 'user')
            continue;
        if (message?.source?.kind !== 'user')
            continue;
        const content = message.content;
        const text = Array.isArray(content)
            ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
            : String(content ?? '');
        return EXPLICIT_SIGNAL_RE.test(text) ? 'user_explicit' : 'model_proposed';
    }
    return 'model_proposed';
}
/** 轻量拉丁词干：只处理最常见的复数/时态尾巴（不引依赖）。 */
function stemLatin(word) {
    if (word.length <= 4)
        return word;
    return word.replace(/(ing|ed|s)$/u, '');
}
/**
 * 分词（设计稿 §6.1）：拉丁词 + 轻量词干；CJK 连续串切 bigram（长度 1 时保留单字）。
 * 例：`记忆数据落在` → 记忆/忆数/数据/据落/落在；`scripts/release.mjs` → scripts/release/mjs。
 */
export function tokenize(text) {
    const normalized = normalizeText(text);
    const tokens = [];
    for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._-]*/gu)) {
        for (const piece of match[0].split(/[._-]/u).filter(Boolean))
            tokens.push(stemLatin(piece));
    }
    for (const match of normalized.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/gu)) {
        const run = match[0];
        if (run.length === 1) {
            tokens.push(run);
            continue;
        }
        for (let index = 0; index < run.length - 1; index += 1)
            tokens.push(run.slice(index, index + 2));
    }
    return tokens;
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
const TOKEN_CACHE = new Map();
const TOKEN_CACHE_MAX = 8192;
/** 缓存键：优先用记录指纹；手工构造、没有指纹的记录退化为按内容拼键。 */
function tokenCacheKey(record) {
    const hash = typeof record.hash === 'string' && record.hash.length > 0
        ? record.hash
        : `${record.text}|${record.subject ?? ''}|${(record.tags ?? []).join(',')}`;
    return `${record.kind}|${hash}`;
}
/** 一条记录的 token 集合（text + subject + tags），带缓存。 */
function tokensOf(record) {
    const key = tokenCacheKey(record);
    const cached = TOKEN_CACHE.get(key);
    if (cached !== undefined)
        return cached;
    const tokens = new Set(tokenize(`${record.text} ${record.subject ?? ''} ${(record.tags ?? []).join(' ')}`));
    // 逐个淘汰最旧的一条（Map 保持插入顺序）。**不能**整表清空：扫描量超过上限时
    // 清空会让每次调用都重新分词全库，实测 5000 条反而比不做缓存更慢。
    if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) {
        const oldest = TOKEN_CACHE.keys().next().value;
        if (oldest !== undefined)
            TOKEN_CACHE.delete(oldest);
    }
    TOKEN_CACHE.set(key, tokens);
    return tokens;
}
/** 清空分词缓存（供测试与基准使用；正常运行靠指纹键自然失效）。 */
export function clearTokenCache() {
    TOKEN_CACHE.clear();
}
/** 当前缓存条目数（可观测性）。 */
export function tokenCacheSize() {
    return TOKEN_CACHE.size;
}
function queryView(query) {
    const text = normalizeText(query);
    const tokens = tokenize(query);
    return { text, tokens, tokenSet: new Set(tokens) };
}
/** 查询覆盖率（无重复计数语义，与旧实现一致）。 */
function lexicalMatchTokens(record, view) {
    if (view.tokens.length === 0)
        return 1;
    const haystack = tokensOf(record);
    let hits = 0;
    for (const token of view.tokens)
        if (haystack.has(token))
            hits += 1;
    return hits / view.tokens.length;
}
/** 词面命中率：查询 token 在记录里的覆盖率（0–1）。空查询视为完全匹配。
 *  适合**短查询**（模型显式 recall、销毁性操作）。 */
export function lexicalMatch(record, query) {
    return lexicalMatchTokens(record, queryView(query));
}
/**
 * 记忆侧命中度：适合**长查询**（R2 用整轮用户消息去匹配一句话记忆）。
 * 语义是「这条记忆的若干关键词出现在了本轮里」，因此
 *   · 分母封顶（默认 4）：不因为记忆长就吃亏；
 *   · 要求至少 `minHits` 个有信息量的 token（长度 ≥2 且非纯数字），挡掉巧合命中。
 * 用查询覆盖率做这件事会在长消息下趋近 0，这是 M4 评测暴露出来的缺陷。
 */
/** 记忆侧命中度（查询侧已预先分词）。 */
function memoryMatchTokens(record, view, options) {
    const recordTokens = tokensOf(record);
    if (recordTokens.size === 0)
        return 0;
    const queryTokens = view.tokenSet;
    if (queryTokens.size === 0)
        return 0;
    const minHits = options.minHits ?? 1;
    let hits = 0;
    let informative = 0;
    for (const token of recordTokens) {
        if (!queryTokens.has(token))
            continue;
        hits += 1;
        if (token.length >= 2 && !/^\d+$/u.test(token))
            informative += 1;
    }
    if (informative < minHits)
        return 0;
    const denominator = Math.max(1, Math.min(options.matchCap ?? 4, recordTokens.size));
    return Math.min(1, hits / denominator);
}
export function memoryMatch(record, query, options = {}) {
    return memoryMatchTokens(record, queryView(query), options);
}
/** M1 的轻量检索打分（查询侧已预先分词）。 */
function scoreRecordTokens(record, view, now, matchOverride) {
    if (view.text.length === 0)
        return record.importance;
    const lexical = matchOverride ?? lexicalMatchTokens(record, view);
    // 有查询但词面完全没命中 → 不参与召回（避免「不相关条目靠重要度混进来」）。
    if (lexical === 0)
        return 0;
    const ageDays = Math.max(0, (now - (record.lastUsedAt ?? record.observedAt)) / 86_400_000);
    const recency = 1 / (1 + ageDays / 30);
    return 0.6 * lexical + 0.3 * record.importance + 0.1 * recency;
}
/** M1 的轻量检索打分：词面命中 + 重要度 + 时效（向量留到 M4）。 */
export function scoreRecord(record, query, now = Date.now(), matchOverride) {
    return scoreRecordTokens(record, queryView(query), now, matchOverride);
}
/** 检索：过滤 → 打分 → 确定性排序。
 *  `mode: 'query'`（默认）= 短查询，按查询覆盖率判定，minLexical 默认 0.34；
 *  `mode: 'memory'` = 长查询（整轮用户消息），按记忆侧覆盖率判定，minMatch 默认 0.4 + minHits 2。
 *  `includeArchived: true` 也纳入归档条目（设计稿 §4.4：归档只是不常驻注入，仍可被检索到）；
 *  `invalid` 永不参与检索。
 *  破坏性操作（删除）应传更高的 minLexical（如 0.6）。 */
export function recallRecords(records, options, now = Date.now()) {
    const { query = '', kind, scopeLevel, tag, limit = 8 } = options ?? {};
    const mode = options?.mode ?? 'query';
    // 查询侧只分词一次：一次扫描要过上千条记录，逐条重新分词在长查询下是主要开销
    // （实测 2000 条时 recall(memory) 从 ~23ms 降到 ~2ms，见 tools/bench.ts）。
    const view = queryView(query);
    const hasQuery = view.text.length > 0;
    const threshold = mode === 'memory'
        ? (options?.minMatch ?? 0.4)
        : (options?.minLexical ?? 0.34);
    const pool = options?.includeArchived
        ? [...records].filter((record) => record.status === 'active' || record.status === 'archived')
        : listActive(records);
    return pool
        .filter((record) => (kind ? record.kind === kind : true))
        .filter((record) => (scopeLevel ? record.scope.level === scopeLevel : true))
        .filter((record) => (tag ? (record.tags ?? []).includes(tag) : true))
        .map((record) => {
        const match = mode === 'memory'
            ? memoryMatchTokens(record, view, { minHits: options?.minHits ?? 2 })
            : lexicalMatchTokens(record, view);
        return { record, match, score: scoreRecordTokens(record, view, now, match) };
    })
        .filter((entry) => (hasQuery ? entry.match >= threshold : true))
        .sort((a, b) => (b.score - a.score) || compareRecords(a.record, b.record))
        .slice(0, Math.max(1, Math.min(50, limit)));
}
// ---------------------------------------------------------------------------
// M2：W2 回合边界规则捕获（默认零模型调用）
// ---------------------------------------------------------------------------
/** 排除规则（设计稿 §5.2）：命中即丢弃，并记录原因以便观测。 */
export function isExcluded(text) {
    const source = String(text).trim();
    if (source.length < 8)
        return 'too-short';
    if (source.includes('```'))
        return 'code-block';
    if (/^https?:\/\/\S+$/u.test(source))
        return 'pure-url';
    if (scanSensitive(source))
        return 'sensitive';
    const rules = [
        { reason: 'question', re: /[?？]\s*$/u },
        { reason: 'hypothetical', re: /(^|[\s，,。])(如果|假如|要是|万一|假设|倘若)/u },
        { reason: 'quoted', re: /(他说|她说|文档里写|文档说|according to|per the docs)/iu },
    ];
    for (const { reason, re } of rules)
        if (re.test(source))
            return reason;
    return null;
}
/** 句子切分：中文句末标点与换行。**保留句末标点**，否则「疑问句排除」无法判定。 */
export function splitSentences(text) {
    return String(text)
        .split(/(?<=[。！？!?])|\r?\n/u)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}
/** 捕获信号表（设计稿 §5.2）：顺序即优先级，先匹配者胜。 */
export const CAPTURE_SIGNALS = [
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
];
/**
 * 从用户消息里抽取候选记忆（**只看用户侧**——防自激闸门 1）。
 * @returns {{ candidates: object[], skipped: Record<string, number> }}
 */
export function extractCandidates(userText, cfg, now = Date.now()) {
    const skipped = {};
    const candidates = [];
    const seen = new Set();
    const minConfidence = cfg.captureMinConfidence ?? 0.6;
    for (const sentence of splitSentences(userText)) {
        const excluded = isExcluded(sentence);
        if (excluded) {
            skipped[excluded] = (skipped[excluded] ?? 0) + 1;
            continue;
        }
        const signal = CAPTURE_SIGNALS.find((entry) => entry.re.test(sentence));
        if (!signal) {
            skipped['no-signal'] = (skipped['no-signal'] ?? 0) + 1;
            continue;
        }
        if (signal.confidence < minConfidence) {
            skipped['below-confidence'] = (skipped['below-confidence'] ?? 0) + 1;
            continue;
        }
        const record = makeRecord({
            kind: signal.kind,
            // 入库文本去掉句末标点；排除判定用的是原文。
            text: sentence.replace(/[。！？!?]+$/u, '').trim(),
            origin: signal.origin,
            confidence: signal.confidence,
            importance: signal.importance,
            tags: [signal.id],
        }, now);
        if (seen.has(record.hash)) {
            skipped['duplicate-in-turn'] = (skipped['duplicate-in-turn'] ?? 0) + 1;
            continue;
        }
        seen.add(record.hash);
        candidates.push({ ...record, signal: signal.id });
    }
    const limit = cfg.captureMaxPerTurn ?? 3;
    candidates.sort((a, b) => (b.confidence - a.confidence) || (b.importance - a.importance));
    if (candidates.length > limit) {
        skipped['over-turn-quota'] = candidates.length - limit;
        candidates.length = limit;
    }
    return { candidates, skipped };
}
/** token 集合相似度（Jaccard）：用于回声剔除（对称、对长度差敏感）。 */
export function similarity(a, b) {
    const left = new Set(tokenize(a));
    const right = new Set(tokenize(b));
    if (left.size === 0 || right.size === 0)
        return 0;
    let intersection = 0;
    for (const token of left)
        if (right.has(token))
            intersection += 1;
    return intersection / (left.size + right.size - intersection);
}
/** 包含度（intersection / min）：用于「同一件事的两种说法」的合并判定，比 Jaccard 更稳。 */
export function containment(a, b) {
    const left = new Set(tokenize(a));
    const right = new Set(tokenize(b));
    if (left.size === 0 || right.size === 0)
        return 0;
    let intersection = 0;
    for (const token of left)
        if (right.has(token))
            intersection += 1;
    return intersection / Math.min(left.size, right.size);
}
/** 回声剔除（防自激闸门 2）：与刚注入的任何一行高度相似 → 视为模型在复述自己。 */
export function isEcho(text, injectedLines, threshold = 0.9) {
    if (!Array.isArray(injectedLines) || injectedLines.length === 0)
        return false;
    const lines = injectedLines;
    const plain = String(text).replace(/^[-*\s]+/u, '').replace(/\s*（自我观察，未经用户确认）\s*$/u, '');
    for (const line of lines) {
        const candidate = String(line).replace(/^[-*\s]+/u, '').replace(/^\([a-z]+\)\s*/u, '');
        if (similarity(plain, candidate) >= threshold)
            return true;
    }
    return false;
}
/** 工作区结构标记：用于零成本的项目模糊印象。 */
const WORKSPACE_MARKERS = [
    ['pnpm', /\bpnpm\b/iu], ['npm', /\bnpm\b/iu], ['yarn', /\byarn\b/iu], ['bun', /\bbun\b/iu],
    ['electron', /electron/iu], ['vite', /\bvite\b/iu], ['typescript', /typescript|\btsconfig\b/iu],
    ['react', /react/iu], ['python', /python|\.py\b|pip\b/iu], ['rust', /rust|cargo/iu],
    ['go', /go\.mod|\bgolang\b/iu], ['powershell', /powershell|pwsh/iu], ['docker', /docker/iu],
    ['sqlite', /sqlite/iu], ['jsonl', /jsonl/iu],
];
export function detectWorkspaceMarkers(text) {
    const found = new Set();
    const source = String(text);
    for (const [name, re] of WORKSPACE_MARKERS)
        if (re.test(source))
            found.add(name);
    return [...found];
}
export function composeGistText(markers) {
    if (markers.length === 0)
        return '';
    return `这个工作区看起来涉及：${markers.slice(0, 6).join('、')}。`;
}
// ---------------------------------------------------------------------------
// M3：整合、冲突、衰减与压缩固化
// ---------------------------------------------------------------------------
/** 按 kind 的半衰期（天）。设计稿 §4.4：自画像（用户侧）与做法类不衰减。 */
export const HALF_LIFE_DAYS = {
    user_profile: 180,
    agent_self: Infinity,
    project_gist: 30,
    episodic: 60,
    semantic: 120,
    procedural: Infinity,
};
/** 有效重要度：importance × 时间衰减。pinned 与不衰减类型原样返回。
 *  `agent_self` 按来源分档：用户侧来源不衰减；**模型自评走 90 天半衰期**（设计稿 §4.4），
 *  否则一次自评会永久留在 system prompt 里。 */
export function effectiveImportance(record, now = Date.now()) {
    let halfLife = HALF_LIFE_DAYS[record.kind] ?? 120;
    if (record.kind === 'agent_self' && record.origin === 'model_proposed')
        halfLife = 90;
    if (record.pinned || !Number.isFinite(halfLife))
        return record.importance;
    const ageDays = Math.max(0, (now - (record.lastUsedAt ?? record.observedAt)) / 86_400_000);
    return record.importance * (2 ** (-ageDays / halfLife));
}
/** 归档判定（设计稿 §4.4）：低有效重要度且长期未用；自画像与项目印象不归档。 */
export function shouldArchive(record, cfg, now = Date.now()) {
    if (record.status !== 'active' || record.pinned)
        return false;
    if (record.kind === 'agent_self' || record.kind === 'project_gist')
        return false;
    const archiveAfterDays = cfg.archiveAfterDays ?? 180;
    const ageDays = Math.max(0, (now - (record.lastUsedAt ?? record.observedAt)) / 86_400_000);
    return effectiveImportance(record, now) < (cfg.archiveBelowImportance ?? 0.15) && ageDays >= archiveAfterDays;
}
/** 合并分组：同 kind + 同 scope + 同 subject 且文本相似度 ≥ 阈值。 */
export function pickMergeGroups(records, cfg) {
    const threshold = cfg.mergeSimilarity ?? 0.85;
    const buckets = new Map();
    for (const record of listActive(records)) {
        if (record.kind === 'project_gist' || record.kind === 'agent_self')
            continue; // 这两类有自己的刷新/晋升规则
        if ((record.tags ?? []).includes('summary'))
            continue; // 摘要是整合的产物，不再参与整合，避免自反馈
        if (!record.subject)
            continue;
        const key = `${record.kind}|${record.scope.level}|${record.scope.key}|${record.subject}`;
        if (!buckets.has(key))
            buckets.set(key, []);
        buckets.get(key).push(record);
    }
    const groups = [];
    for (const bucket of buckets.values()) {
        if (bucket.length < 2)
            continue;
        const used = new Set();
        for (let index = 0; index < bucket.length; index += 1) {
            const lead = bucket[index];
            if (used.has(lead.id))
                continue;
            const group = [lead];
            used.add(lead.id);
            for (let other = index + 1; other < bucket.length; other += 1) {
                const candidate = bucket[other];
                if (used.has(candidate.id))
                    continue;
                if (containment(lead.text, candidate.text) >= threshold) {
                    group.push(candidate);
                    used.add(candidate.id);
                }
            }
            if (group.length > 1)
                groups.push(group);
        }
    }
    return groups;
}
/** 冲突判定（设计稿 §4.3）：同 (kind, scope, subject, field) 但 value 不同。 */
export function findConflicts(records) {
    const slots = new Map();
    for (const record of listActive(records)) {
        if (!record.subject || record.field == null || record.value == null)
            continue;
        const key = `${record.kind}|${record.scope.level}|${record.scope.key}|${record.subject}|${record.field}`;
        if (!slots.has(key))
            slots.set(key, []);
        slots.get(key).push(record);
    }
    const conflicts = [];
    for (const group of slots.values()) {
        if (group.length < 2)
            continue;
        const sorted = [...group].sort((a, b) => (b.observedAt - a.observedAt) || compareRecords(a, b));
        const winner = sorted[0];
        for (const loser of sorted.slice(1)) {
            // 唯一禁止的自动推翻：**非用户侧来源**（模型自评/自动观察）推翻**用户侧条目**（设计稿 §4.3）。
            // 反过来（用户侧推翻任何旧条目，包括被用户纠正过的）一律允许。
            const blocked = !isUserSideOrigin(winner.origin) && isUserSideOrigin(loser.origin);
            conflicts.push({ winner, loser, blocked });
        }
    }
    return conflicts;
}
/** 是否为用户侧来源（用户明说或用户纠正）。 */
export function isUserSideOrigin(origin) {
    return origin === 'user_explicit' || origin === 'user_correction';
}
/**
 * 从文本派生稳定主题键（无模型调用）：取最有信息量的两个 token。
 * 用途：让「同一件事的两种说法」能落到同一个 subject 上，从而让去重/合并/冲突判定真正生效。
 */
export function deriveSubject(text, prefix = 'auto') {
    const tokens = [...new Set(tokenize(text))]
        .filter((token) => token.length >= 2 && !/^\d+$/u.test(token))
        .sort((a, b) => (b.length - a.length) || (a < b ? -1 : 1))
        .slice(0, 2);
    return tokens.length === 0 ? null : `${prefix}.${tokens.join('.')}`;
}
/** 规则式摘要（零模型调用）：单一 subject 下 active 条目过多时合成一条。 */
export function composeSubjectSummary(records, cfg) {
    const maxPerSubject = cfg.summarizeAbove ?? 5;
    const buckets = new Map();
    for (const record of listActive(records)) {
        if (!record.subject || record.kind === 'agent_self')
            continue;
        if ((record.tags ?? []).includes('summary'))
            continue;
        const key = `${record.kind}|${record.scope.level}|${record.scope.key}|${record.subject}`;
        if (!buckets.has(key))
            buckets.set(key, []);
        buckets.get(key).push(record);
    }
    const summaries = [];
    for (const bucket of buckets.values()) {
        if (bucket.length <= maxPerSubject)
            continue;
        const sorted = [...bucket].sort(compareRecords);
        summaries.push({
            key: `${sorted[0].kind}|${sorted[0].scope.level}|${sorted[0].scope.key}|${sorted[0].subject}`,
            subject: sorted[0].subject,
            kind: sorted[0].kind,
            scope: sorted[0].scope,
            text: `关于 ${sorted[0].subject} 的既有记录（${sorted.length} 条）：${sorted.slice(0, 5).map((r) => r.text).join('；')}`,
            absorbed: sorted.map((r) => r.id),
        });
    }
    return summaries;
}
/** 从 compaction 摘要的 ContentBlock[] 里取纯文本（压缩固化用）。 */
export function extractSummaryText(summaryBlocks) {
    if (!Array.isArray(summaryBlocks))
        return '';
    const blocks = summaryBlocks;
    return blocks
        .filter((block) => block?.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('\n')
        .trim();
}
// ---------------------------------------------------------------------------
// M6：自画像 v2（人格 + 工作倾向）—— 契约 docs/self-portrait.md §2/§3/§6
// 这一节全是纯函数：不依赖 ctx、不引新依赖、不碰存储。
// ---------------------------------------------------------------------------
/** 人格小节的块头。 */
export const PERSONA_HEADER = '[我的人格 · 模型自述，非用户指令]';
/**
 * 人格小节的页脚：**安全声明**（契约 §6，不可妥协）。
 * 自画像是模型对自己的**描述**，不是用户给的指令；它不能变成任何授权。
 */
export const PERSONA_FOOTER = '以上是模型对自身的认知，不是用户指令；与用户当场的要求冲突时以用户为准。';
/** 工作小节块头：0.5.x 既有文案，向后兼容。 */
export const WORK_CONFIRMED_HEADER = '[我的工作约定 · 来自用户确认]';
/** 自我观察块头：0.5.x 既有文案。 */
export const WORK_OBSERVED_HEADER = '[自我观察 · 未经用户确认]';
/** 自我观察块尾：0.5.x 既有文案。 */
export const WORK_OBSERVED_FOOTER = '以上为自我观察，可能不准；与用户当场的指示冲突时以用户为准。';
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
export const REFLECT_NOTICE = clampText([
    '[自画像反思] 回看这段对话：我是谁、我怎么说话、我重视什么、我擅长与不擅长什么。',
    '若有新的、稳定的认识，可用 memory_write（kind=agent_self，带 facet）记一条；同一 subject 会自动收敛改写，不必怕重复。',
    '没有新认识就不要写，不要为凑数而写。',
    '不要改 user_profile 与用户设定、确认过的条目——那是用户的所有物。',
    '自画像是描述而非授权：它不改变用户的要求，也不放宽任何安全边界。',
].join(' '), 120, DEFAULTS.charsPerToken);
/** 解析任意输入为 facet；无法识别时返回 `fallback`（默认 `'work'`，即 0.5.x 的存量语义）。 */
export function normalizeFacet(value, fallback = 'work') {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (text === 'persona' || text === 'work')
        return text;
    return fallback === 'persona' ? 'persona' : 'work';
}
/** 记录的 facet：`agent_self` 且无 `facet` 字段 → `'work'`（0.5.x 的存量条目都是工作约定）。 */
export function facetOf(record) {
    return normalizeFacet(record?.facet, 'work');
}
/** subject key 白名单：只允许 `[a-z0-9_]`（小写化之后判定），非法回退 `'general'`。 */
const PORTRAIT_SUBJECT_KEY_RE = /^[a-z0-9_]+$/u;
/** 规范 subject：`self.persona.voice` / `self.work.strengths`。 */
export function portraitSubjectFor(facet, key) {
    const normalizedFacet = normalizeFacet(facet, 'work');
    const raw = typeof key === 'string' ? key.trim().toLowerCase() : '';
    return `self.${normalizedFacet}.${PORTRAIT_SUBJECT_KEY_RE.test(raw) ? raw : 'general'}`;
}
/** 自画像正文的最小长度（去空白后 < 8 字符没有信息量）。 */
export const PORTRAIT_MIN_TEXT_CHARS = 8;
/** 同 subject 判定用的键：与 `normalizeText` 同口径（大小写/全角/尾标点不敏感）。 */
function portraitSubjectKey(subject) {
    return normalizeText(subject ?? '');
}
/** 合并两条正文（refine）：一方包含另一方就取长的，否则按「长；短」拼接（确定性）。 */
function mergePortraitText(left, right) {
    const [long, short] = left.length >= right.length ? [left, right] : [right, left];
    if (long === short)
        return long;
    return normalizeText(long).includes(normalizeText(short)) ? long : `${long}；${short}`;
}
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
export function planPortraitUpdate(candidate, existing, cfg) {
    const facet = normalizeFacet(candidate?.facet, 'work');
    const subject = typeof candidate?.subject === 'string' ? candidate.subject : '';
    const text = clampText(candidate?.text, cfg.maxItemTokens, cfg.charsPerToken);
    const rawConfidence = Number(candidate?.confidence);
    const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0.6;
    if (String(candidate?.text ?? '').trim().length < PORTRAIT_MIN_TEXT_CHARS) {
        return { action: 'skip', targetId: null, text, confidence, reason: 'too-short', archiveTarget: false };
    }
    const subjectKey = portraitSubjectKey(subject);
    const pool = subjectKey.length === 0 ? [] : [...(existing ?? [])].filter((record) => record.status === 'active'
        && record.kind === 'agent_self'
        && facetOf(record) === facet
        && portraitSubjectKey(record.subject) === subjectKey);
    if (pool.length === 0) {
        return { action: 'add', targetId: null, text, confidence, reason: 'added', archiveTarget: false };
    }
    const candidateNorm = normalizeText(text);
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
        || compareRecords(a.record, b.record));
    const best = ranked[0];
    const target = best.record;
    const configuredThreshold = Number(cfg.selfPortraitMergeThreshold);
    const threshold = Number.isFinite(configuredThreshold) ? configuredThreshold : DEFAULTS.selfPortraitMergeThreshold;
    const action = (best.same || best.contains)
        ? 'reinforce'
        : (best.similarity >= threshold ? 'refine' : 'supersede');
    // 规则 4（契约 §3 规则 4，第十八轮审计收紧）：用户的所有物 —— origin 是
    // user_explicit/user_correction 或 pinned=true —— 只能由**用户侧候选**改写。
    //
    // ⚠ 为什么连 `reinforce` 也要管：reinforce 在「一方包含另一方」时取更长的一条，
    // 模型只要写一句「包含 pinned 条目全部 token 的更长句子」，就能把自己的话写进用户设定的条目
    // （实测复现过）——这违反 §6「模型不能覆盖 user_explicit / pinned 的自画像」。
    // 因此非用户侧候选：refine/supersede 一律 skip；reinforce 仅当双方**归一化文本完全相同**
    // 时才允许，且正文逐字保留 target 原文（只累加 confidence 与 reinforcement，绝不改写正文）。
    const targetUserOwned = isUserSideOrigin(target.origin) || target.pinned === true;
    const candidateUserSide = isUserSideOrigin(candidate?.origin);
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
            };
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
        };
    }
    const targetText = clampText(target.text, cfg.maxItemTokens, cfg.charsPerToken);
    if (action === 'reinforce') {
        return {
            action,
            targetId: target.id,
            text: text.length >= targetText.length ? text : targetText,
            confidence: Math.min(1, Math.max(confidence, Number(target.confidence) || 0) + 0.05),
            reason: 'reinforced',
            archiveTarget: false,
        };
    }
    if (action === 'refine') {
        return {
            action,
            targetId: target.id,
            text: clampText(mergePortraitText(text, targetText), cfg.maxItemTokens, cfg.charsPerToken),
            confidence: Math.max(confidence, Number(target.confidence) || 0),
            reason: 'refined',
            archiveTarget: false,
        };
    }
    return { action, targetId: target.id, text, confidence, reason: 'superseded', archiveTarget: true };
}
/**
 * 修订链：把 `supersededBy` / `supersedes` 互为反向的指针串起来（链内按 `observedAt` 升序 = 由旧到新）。
 *
 * 只返回**真的发生过修订**的组（链长 ≥ 2）：单条 active 条目不是历史，`/memory self` 已经会列出它。
 * 返回值按「最新一条修订时间」倒序（新的修订在前），同刻按 subject 稳定排序。
 */
export function portraitHistory(records) {
    const groups = new Map();
    for (const record of records ?? []) {
        if (!record || record.kind !== 'agent_self')
            continue;
        const key = `${facetOf(record)}|${portraitSubjectKey(record.subject)}`;
        const bucket = groups.get(key);
        if (bucket)
            bucket.push(record);
        else
            groups.set(key, [record]);
    }
    const byAge = (a, b) => (a.observedAt - b.observedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const revisions = [];
    for (const group of groups.values()) {
        if (group.length < 2)
            continue;
        const byId = new Map(group.map((record) => [record.id, record]));
        const nextOf = new Map();
        const hasPredecessor = new Set();
        for (const record of group) {
            if (typeof record.supersededBy === 'string' && record.supersededBy.length > 0) {
                const successor = byId.get(record.supersededBy);
                if (successor && !nextOf.has(record.id)) {
                    nextOf.set(record.id, successor);
                    hasPredecessor.add(successor.id);
                }
            }
            for (const oldId of record.supersedes ?? []) {
                const predecessor = byId.get(oldId);
                if (predecessor && !nextOf.has(predecessor.id)) {
                    nextOf.set(predecessor.id, record);
                    hasPredecessor.add(record.id);
                }
            }
        }
        // 没有前驱的即链头；纯环（互相指向）时退化为从最旧一条起走，visited 保证不死循环。
        const heads = group.filter((record) => !hasPredecessor.has(record.id)).sort(byAge);
        const starts = heads.length > 0 ? heads : [group.slice().sort(byAge)[0]];
        const visited = new Set();
        for (const start of starts) {
            const chain = [];
            let cursor = start;
            while (cursor && !visited.has(cursor.id)) {
                visited.add(cursor.id);
                chain.push(cursor);
                cursor = nextOf.get(cursor.id);
            }
            if (chain.length < 2)
                continue;
            chain.sort(byAge);
            revisions.push({ subject: chain[0].subject ?? '', facet: facetOf(chain[0]), chain });
        }
    }
    revisions.sort((a, b) => (b.chain[b.chain.length - 1].observedAt - a.chain[a.chain.length - 1].observedAt)
        || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
    return revisions;
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
export function shouldReflect(input, cfg) {
    if (!input)
        return false;
    if (cfg.selfReflectEnabled === false)
        return false;
    const cap = cfg.selfReflectMaxPerSession ?? DEFAULTS.selfReflectMaxPerSession;
    if (!(cap > 0))
        return false;
    const reflections = Number.isFinite(input.reflectionsThisSession) ? input.reflectionsThisSession : 0;
    if (reflections >= cap)
        return false;
    const minTurn = cfg.selfReflectMinTurn ?? DEFAULTS.selfReflectMinTurn;
    const turn = Number.isFinite(input.turn) ? input.turn : 0;
    const sessionTurns = Number.isFinite(input.sessionTurns) ? input.sessionTurns : turn;
    if (sessionTurns < minTurn)
        return false;
    const everyTurns = Number.isFinite(cfg.selfReflectEveryTurns) && cfg.selfReflectEveryTurns > 0
        ? cfg.selfReflectEveryTurns
        : DEFAULTS.selfReflectEveryTurns;
    const lastReflectTurn = input.lastReflectTurn;
    if (typeof lastReflectTurn === 'number' && Number.isFinite(lastReflectTurn) && turn - lastReflectTurn < everyTurns) {
        return false;
    }
    return true;
}
//# sourceMappingURL=lib.js.map
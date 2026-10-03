export type MemoryKind = 'user_profile' | 'agent_self' | 'project_gist' | 'episodic' | 'semantic' | 'procedural';
export type MemoryOrigin = 'user_explicit' | 'user_correction' | 'model_proposed' | 'observed';
/**
 * 自画像（M6）的两个小节：
 *  · `persona` —— 「我是谁、我怎么说话、我重视什么」；
 *  · `work`    —— 工作倾向（工作约定 + 自我观察）。
 * 仅 `agent_self` 记录使用。
 */
export type SelfFacet = 'persona' | 'work';
/**
 * 记录状态。`'pending'` 是 M10 写入审批门新增的：**待用户确认，绝不进任何注入路径**。
 * 严禁把它扩进「注入用的状态集合」——只有 `'active'` 才允许进上下文。
 */
export type MemoryStatus = 'active' | 'pending' | 'invalid' | 'archived';
/** M10：模型来源写入的处置策略（默认 `'auto'` ＝ 0.5.9 行为）。 */
export type WritePolicy = 'auto' | 'ask' | 'off';
/** M11：**模型可见文本**的语言（不含命令输出；默认 `'zh'` 保持现状）。 */
export type Language = 'zh' | 'en';
export type MemoryPrecision = 'exact' | 'gist';
export type ScopeLevel = 'profile' | 'workspace' | 'session';
export interface MemoryScope {
    level: ScopeLevel;
    key: string;
}
/** 自动写入的来源指针：会话 + seq 区间（设计稿 I3：自动写入必须带来源）。 */
export interface MemorySource {
    sessionId: string;
    seqStart: number;
    seqEnd: number;
}
/** 跨会话复现计数：模型自评晋升与「重复提及」都依赖它。 */
export interface MemoryReinforcement {
    sessions: string[];
    count: number;
}
/** M9：一条记忆的来源引用（会话 + 事件序号闭区间）。 */
export interface MemoryRef {
    sessionId: string;
    /** 起始事件序号（含）。 */
    from?: number;
    /** 结束事件序号（含）；单点引用时省略。 */
    to?: number;
    /** 写入路径，便于区分来源与自查。 */
    via?: 'live' | 'sleep' | 'tool' | 'command' | 'solidify' | 'import';
}
export interface MemoryRecord {
    id: string;
    kind: MemoryKind;
    precision: MemoryPrecision;
    origin: MemoryOrigin;
    scope: MemoryScope;
    subject: string | null;
    field: string | null;
    value: string | null;
    text: string;
    tags: string[];
    source: MemorySource | null;
    confidence: number;
    importance: number;
    pinned: boolean;
    status: MemoryStatus;
    invalidAt: number | null;
    supersedes: string[];
    /** 仅 `agent_self` 使用；缺失时按 `'work'` 处理（0.5.x 的存量条目都是工作约定）。 */
    facet?: SelfFacet;
    /** 本条被谁取代（归档时写入；与 `supersedes` 互为反向指针）。 */
    supersededBy?: string;
    /**
     * M9：来源引用（可核验：会话 + 事件序号区间）。
     * **必须不参与 `recordHash`** —— 否则同一条记忆会因为来源不同被判成两条，破坏去重与幂等。
     */
    refs?: MemoryRef[];
    observedAt: number;
    eventTime: number | null;
    lastUsedAt: number | null;
    useCount: number;
    reinforcement: MemoryReinforcement;
    hash: string;
}
/** `makeRecord` 的输入：除 kind/text 外都可省略，缺失时按类型默认值补齐。 */
export interface MakeRecordInput {
    id?: string;
    kind: MemoryKind;
    precision?: MemoryPrecision;
    origin?: MemoryOrigin;
    scope?: MemoryScope;
    subject?: string | null;
    field?: string | null;
    value?: string | null;
    text: string;
    tags?: string[];
    source?: MemorySource | null;
    confidence?: number;
    importance?: number;
    pinned?: boolean;
    status?: MemoryStatus;
    supersedes?: string[];
    /** 自画像小节（仅 `kind: 'agent_self'` 有意义）；缺失即 `'work'`。 */
    facet?: SelfFacet;
    /** 本条被谁取代（归档时写入）。 */
    supersededBy?: string;
    observedAt?: number;
    eventTime?: number | null;
    lastUsedAt?: number | null;
    useCount?: number;
    reinforcement?: MemoryReinforcement;
    /** 写入来源会话 id：用于 `reinforcement.sessions` 与「重复提及」判定。 */
    sessionId?: string;
}
/** 召回命中：`match` 是相关性判定值，`score` 是排序分。 */
export interface RecallHit {
    record: MemoryRecord;
    match: number;
    score: number;
}
export interface RecallOptions {
    query?: string;
    kind?: MemoryKind;
    scopeLevel?: ScopeLevel;
    tag?: string;
    limit?: number;
    mode?: 'query' | 'memory';
    minLexical?: number;
    minMatch?: number;
    minHits?: number;
    includeArchived?: boolean;
}
/** 自动捕获抽出的候选（`extractCandidates` 的返回值）。 */
export interface CaptureCandidate {
    kind: MemoryKind;
    text: string;
    origin: MemoryOrigin;
    confidence: number;
    importance: number;
    tags: string[];
    hash: string;
    /** 命中的信号名，后续用于派生 subject 前缀。 */
    signal: string;
}
/** 配置：与 `DEFAULTS` 一一对应；patch 行可只给子集。 */
export interface MemoryConfig {
    domainName: string;
    maxInjectedTokens: number;
    maxItemTokens: number;
    selfPortraitMaxTokens: number;
    selfPortraitMaxItems: number;
    selfPortraitMaxSelfObserved: number;
    /** M6：自画像三小节的开关（人格 + 工作两节）。 */
    selfPortraitEnabled: boolean;
    /** M6：人格小节的 token 预算（工作两节仍共享 `selfPortraitMaxTokens`）。 */
    selfPersonaMaxTokens: number;
    /** M6：自画像 refine（合并改写）的相似度阈值。 */
    selfPortraitMergeThreshold: number;
    /** M6：低频反思提示开关。 */
    selfReflectEnabled: boolean;
    /** M6：两次反思提醒之间的最小回合间隔。 */
    selfReflectEveryTurns: number;
    /** M6：本会话最小回合数（太早没素材）。 */
    selfReflectMinTurn: number;
    /** M6：每会话最多提醒几次。 */
    selfReflectMaxPerSession: number;
    /** M7：初次设定（称呼）开关。 */
    selfIntroEnabled: boolean;
    /** M7：本会话至少几回合后再问称呼（别一上来就查户口）。 */
    selfIntroMinTurn: number;
    /** M7：**跨会话**累计最多问几次称呼，问满即永久停手。 */
    selfIntroMaxAsks: number;
    /** M8：`/sleep` 命令开关。 */
    sleepEnabled: boolean;
    /** M8：默认回看最近几个会话。 */
    sleepSessions: number;
    /** M8：单会话字符预算。 */
    sleepMaxCharsPerSession: number;
    /** M8：所有会话合计字符预算。 */
    sleepMaxCharsTotal: number;
    /** M8：单次最多补录几条。 */
    sleepMaxBackfill: number;
    /** M8：每条用户消息前保留几条 assistant 文本（回声检测用）。 */
    sleepAssistantContext: number;
    /** M8：最多重算几条项目印象。 */
    sleepMaxGists: number;
    /** M9：是否为写入附着来源引用。 */
    refsEnabled: boolean;
    /** M9：每条记录最多保留几个引用。 */
    refsMax: number;
    /** M10：模型来源写入的策略（`auto` 默认＝立刻生效；`ask` 进待确认队列；`off` 直接拒绝）。 */
    writePolicy: WritePolicy;
    /** M10：待确认队列上限；满了拒绝新写入并报结构化错误。 */
    pendingMax: number;
    /** M11：模型可见文本的语言（`zh` 默认；命令输出仍为中文）。 */
    language: Language;
    gistBudgetRatio: number;
    charsPerToken: number;
    sectionOrder: number;
    contextOrder: number;
    seed: boolean;
    reportPath: string | null;
    trustToolWrites: boolean;
    captureMode: 'off' | 'rule';
    piiPolicy: 'mask' | 'reject';
    repeatMentionBoost: number;
    captureMaxPerTurn: number;
    captureMinConfidence: number;
    capturePerHour: number;
    captureTimeoutMs: number;
    echoThreshold: number;
    gistMinMarkers: number;
    selfPortraitMinConfidence: number;
    selfPortraitModelMinConfidence: number;
    selfPortraitPromoteSessions: number;
    consolidateEnabled: boolean;
    consolidateIntervalMinutes: number;
    consolidateMaxRecords: number;
    mergeSimilarity: number;
    archiveAfterDays: number;
    archiveBelowImportance: number;
    summarizeAbove: number;
    solidificationMaxPerCompaction: number;
    autoRecall: boolean;
    recallMode: 'off' | 'dry' | 'inject';
    recallTopK: number;
    recallMinQueryChars: number;
    recallMinHits: number;
    recallMinMatch: number;
    recallCooldownTurns: number;
    recallBudgetMs: number;
    /** `/memory export` 的默认导出目录（仅 patch 行）。 */
    exportDir?: string;
    /** 故障注入开关，供故障隔离测试使用（仅 patch 行）。 */
    simulateCaptureError?: boolean;
    /** 开发期由部署脚本注入的修订号（非出厂配置）。 */
    revision?: number;
}
/** 渲染结果：注入的行、被选中的记录（记用量的唯一真源）与最终文本。 */
export interface RenderedBlock {
    lines: string[];
    selected: MemoryRecord[];
    text: string;
}
export type DshDisposable = () => void;
/** `ctx.storageDomain.open(spec)` 返回的领域句柄；**调用方负责 close()**。 */
export interface DshDomainTable<T> {
    entries(): Iterable<[string, T] | T>;
    get(key: string): T | undefined | Promise<T | undefined>;
    put(key: string, value: T): Promise<void> | void;
    delete(key: string): Promise<void> | void;
}
export interface DshDomainGlobal {
    get(): unknown | Promise<unknown>;
    /**
     * 写水位。**实测契约是 `set` 而不是 `put`**：`$DSH_HOME/storages/<domain>/global.json`
     * 里确实出现了我们写入的 `lastConsolidatedAt` / `collectionVersion`，说明这条路径有效。
     */
    set(value: unknown): Promise<void> | void;
}
export interface DshDomain {
    table<T>(name: string): DshDomainTable<T>;
    global: DshDomainGlobal;
    close(): Promise<void> | void;
}
export interface DshStorageDomain {
    open(spec: {
        name: string;
        version: number;
        layout: 'per-record' | 'single';
        tables: Record<string, unknown>;
        global?: unknown;
    }): Promise<DshDomain>;
}
/** `ctx.systemPrompt.section/context`：常驻注入的两条通道。 */
export interface DshSystemPrompt {
    section(options: {
        name: string;
        order: number;
        text: () => string;
    }): DshDisposable;
    context(options: {
        name: string;
        order: number;
        text: (assembleContext: DshAssembleContext) => string;
    }): DshDisposable;
}
export interface DshAssembleContext {
    agent?: {
        session?: {
            header?: {
                cwd?: string | null;
            };
        };
    };
}
/** `ctx.tools.register()` 的执行期第二个实参（运行版提供）。 */
export interface DshToolExecution {
    agent?: DshAgent & {
        session?: DshSession;
    };
}
/** `ctx.tools.register()`：原生 JSON Schema 工具（`output` 必填）。 */
export interface DshToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: Record<string, unknown>;
    execute: (args: Record<string, unknown>, execution?: DshToolExecution) => Promise<unknown> | unknown;
}
export interface DshTools {
    register(definition: DshToolDefinition): DshDisposable;
}
/** `/memory` 的调用对象。 */
export interface DshCommandInvocation {
    rawInput?: string;
}
/** 命令返回值：kind 决定渲染成成功还是错误提示。 */
export interface DshCommandResult {
    kind: 'success' | 'error';
    text: string;
}
export interface DshCommands {
    register(definition: {
        name: string;
        description: string;
        input?: {
            hint?: string;
        };
        handler: (invocation: DshCommandInvocation) => Promise<DshCommandResult> | DshCommandResult;
    }): DshDisposable;
}
/** 会话/agent 的最小视图（我们只做身份比较与 seq 读取）。 */
export interface DshSession {
    id?: string;
    seq?: number;
    header?: {
        cwd?: string | null;
    };
    /** 运行版在工具 execute 的第二个实参里提供：把会话历史派生成消息列表。 */
    deriveMessages?: () => unknown;
}
export interface DshAgent {
    session: DshSession;
}
export interface DshAgents {
    roots(): unknown[];
}
/** settings 服务的页面策略（值以访问器对象下发，见 src/shims.d.ts 的说明）。 */
export interface DshSettings {
    configure(presentation: {
        auto?: boolean;
    }): DshDisposable;
    describe(): Array<Record<string, unknown>>;
}
export interface DshLogger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
}
/** `agent/turn-stopping` 的载荷。 */
export interface DshTurnStoppingPayload {
    agent?: DshAgent;
}
/** `agent/pre-step` 的 waterfall：`next()` 返回决策对象，原样交回即可。 */
export type DshPreStepNext = () => Promise<unknown>;
/**
 * 插件拿到的 ctx：只声明本插件实际使用到的成员。
 * 与服务包的真实类型不同名，避免与「发布版类型」产生虚假的一致性。
 */
export interface DshPluginContext {
    logger?: DshLogger;
    systemPrompt: DshSystemPrompt;
    storageDomain: DshStorageDomain;
    tools: DshTools;
    commands: DshCommands;
    agents: DshAgents;
    effect(callback: () => DshDisposable | void, label?: string): DshDisposable;
    on(event: 'session/event', listener: (session: DshSession, event: {
        type?: string;
        [key: string]: unknown;
    }) => void): DshDisposable;
    on(event: 'agent/turn-stopping', listener: (payload: DshTurnStoppingPayload) => Promise<void> | void): DshDisposable;
    on(event: 'agent/pre-step', listener: (payload: unknown, next: DshPreStepNext) => Promise<unknown>): DshDisposable;
    get<T = unknown>(service: string): T | undefined;
    /**
     * 作用域注入：服务就绪时才执行回调，服务消失时自动清理回调内的注册。
     * 回调拿到的作用域比根 ctx 更窄 —— 这里声明本插件实际用到的那个成员。
     */
    inject(services: string[], callback: (scope: DshPluginContext & {
        settings?: DshSettings;
    }) => void): unknown;
    /** 对外提供服务（本插件用它暴露 memory 服务）。 */
    provide(name: string, service: unknown): void;
}
/** `ctx.get('sessionQuery')` 的最小可用子集。 */
export interface DshSessionQuery {
    listSessions(signal?: AbortSignal): Promise<DshSessionRecord[]>;
    filterSessions(filters: readonly DshSessionResultFilter[], signal?: AbortSignal): Promise<DshSessionRecord[]>;
    readSession(sessionId: string): Promise<DshSessionLogSnapshot>;
    listEvents(sessionId: string): Promise<DshSessionEventRecord[]>;
}
export interface DshSessionRecord {
    header: {
        id: string;
        cwd?: string;
        createdAt: number;
        origin?: 'subagent';
        parentSession?: string;
    };
    live: boolean;
    persisted: boolean;
}
export interface DshSessionLogSnapshot {
    session: {
        id: string;
        cwd?: string;
        createdAt: number;
    };
    inheritedEventCount: number;
    events: DshSessionEvent[];
}
/** 会话事件：本插件只关心 `type` / `seq` / `time` / `data`。 */
export interface DshSessionEvent {
    type: string;
    seq: number;
    time: number;
    data?: Record<string, unknown>;
}
/** `listEvents` 的轻量事件记录（没有 data，只用于统计/诊断）。 */
export interface DshSessionEventRecord {
    sessionId: string;
    seq: number;
    type: string;
    time: number;
}
export type DshSessionResultFilter = {
    kind: 'id';
    values: readonly string[];
} | {
    kind: 'cwd';
    values: readonly (string | null)[];
} | {
    kind: 'created-at';
    from?: number;
    to?: number;
} | {
    kind: 'parent';
    values: readonly (string | null)[];
} | {
    kind: 'availability';
    values: readonly ('live' | 'persisted')[];
};
//# sourceMappingURL=types.d.ts.map
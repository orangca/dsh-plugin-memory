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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DEFAULTS, buildSleepPlan, clampText, composeGistText, composeSubjectSummary, compareRecords, defaultScopeFor, deriveSubject, detectWorkspaceMarkers, deriveOriginFromMessages, effectiveImportance, estimateTokens, extractCandidates, extractSummaryText, facetOf, fillWithinBudget, findConflicts, fnv1a, formatSleepPlan, isEcho, isExcluded, isUserSideOrigin, listActive, makeRecord, maskPii, normalizeFacet, normalizeText, INTRO_NOTICE, namingSettled, pickMergeGroups, planPortraitUpdate, portraitHistory, portraitSubjectFor, recallRecords, recordHash, REFLECT_NOTICE, renderContextBlock, renderSelfBlock, scanSensitive, shouldArchive, shouldIntroduce, shouldReflect, sleepPlanIsEmpty, splitSentences, transcriptOf, workspaceKeyOf, } from './lib.js';
let Schema = null;
try {
    Schema = (await import('@deepseek-ai/schemastery')).default ?? null;
}
catch {
    Schema = null;
}
/** 记录的自画像视图（不做拷贝：字段就是记录自身的字段）。 */
const asPortrait = (record) => record;
/**
 * 统一的错误文本：`String(error?.message ?? error)` 的类型安全版本。
 * 与运行期表达式逐字等价（普通对象上的 `message` 也会被取到）。
 */
function errorText(error) {
    const message = error?.message;
    return String(message ?? error);
}
export const name = 'dsh-memory';
// compaction 在本 profile 不可达（spike 实测），故不 inject；M3 走 session/event 的 compaction/summary。
export const inject = ['agents', 'systemPrompt', 'storageDomain', 'tools', 'commands'];
/**
 * 配置 schema。声明为 `volatile()` 的字段会出现在 DSH 设置页的表单里（改动热生效），
 * 其余字段只能通过 patch 行设置。整块构造做了防御：schemastery 不可用或缺 `volatile`
 * 时降级为「不带 volatile」甚至「不导出 schema」，绝不让插件因为 UI 面而加载失败。
 */
function buildConfig(useVolatile) {
    // 类型层面按「原样返回同一 schema」标注；运行期在 volatile 可用时换成 volatile 句柄。
    const field = (schema) => {
        if (!useVolatile)
            return schema;
        const volatile = schema.volatile;
        return typeof volatile === 'function' ? volatile.call(schema) : schema;
    };
    return Schema.object({
        domainName: field(Schema.string().default('dsh_memory')),
        maxInjectedTokens: field(Schema.number().default(300)),
        maxItemTokens: field(Schema.number().default(60)),
        selfPortraitMaxTokens: field(Schema.number().default(120)),
        // M6：自画像 v2（契约 3.1）——类型与默认值必须与 lib.ts 的 DEFAULTS 逐字一致
        selfPortraitEnabled: field(Schema.boolean().default(true)),
        selfPersonaMaxTokens: field(Schema.number().default(80)),
        selfPortraitMergeThreshold: field(Schema.number().default(0.6)),
        selfReflectEnabled: field(Schema.boolean().default(true)),
        selfReflectEveryTurns: field(Schema.number().default(12)),
        selfReflectMinTurn: field(Schema.number().default(4)),
        selfReflectMaxPerSession: field(Schema.number().default(3)),
        // M7：初次设定（称呼）——一次性，跨会话累计最多问 selfIntroMaxAsks 次
        selfIntroEnabled: field(Schema.boolean().default(true)),
        selfIntroMinTurn: field(Schema.number().default(2)),
        selfIntroMaxAsks: field(Schema.number().default(2)),
        // M8：/sleep（契约 docs/sleep.md §4.1）——类型与默认值必须与 lib.ts 的 DEFAULTS 逐字一致。
        // 只有前三个进设置页表单（客户端的 3 个新配置键），其余四个走 patch 行。
        sleepEnabled: field(Schema.boolean().default(true)),
        sleepSessions: field(Schema.number().default(3)),
        sleepMaxBackfill: field(Schema.number().default(20)),
        // 非 volatile：预算类参数，进设置页只会增加误配面的风险（它们是硬上限，不是偏好）。
        sleepMaxCharsPerSession: Schema.number().default(120000),
        sleepMaxCharsTotal: Schema.number().default(300000),
        sleepAssistantContext: Schema.number().default(3),
        sleepMaxGists: Schema.number().default(8),
        recallMode: field(Schema.union(['off', 'dry', 'inject']).default('inject')),
        recallTopK: field(Schema.number().default(8)),
        captureMode: field(Schema.union(['off', 'rule']).default('rule')),
        captureMaxPerTurn: field(Schema.number().default(3)),
        consolidateEnabled: field(Schema.boolean().default(true)),
        consolidateIntervalMinutes: field(Schema.number().default(30)),
        // 非 volatile：仅供 patch 行/诊断使用，不进表单
        reportPath: Schema.string(),
        // 出厂**不播种**（与 lib.js 的 DEFAULTS.seed 保持一致）：播种的演示记忆会进真实用户上下文
        seed: Schema.boolean().default(false),
    });
}
let Config;
try {
    Config = Schema ? buildConfig(true) : undefined;
}
catch {
    try {
        Config = Schema ? buildConfig(false) : undefined;
    }
    catch {
        Config = undefined;
    }
}
export { Config };
const passthroughSchema = {
    parse: (value) => value,
    safeParse: (value) => ({ success: true, data: value }),
};
const ORIGIN_RANK = { observed: 0, model_proposed: 1, user_correction: 2, user_explicit: 3 };
// ---------------------------------------------------------------- 白名单与硬上限
//
// 命令层（`/memory clear --kind=`）与数据层（`/memory import`）都要按枚举校验，
// 两处各写一份必然漂移 —— 这里放唯一真源，配 `isMemoryKind` / `isScopeLevel` 类型守卫
// （守卫返回类型谓词，避免调用方再写 `as MemoryKind` 这种逃逸）。
const MEMORY_KINDS = ['user_profile', 'agent_self', 'project_gist', 'episodic', 'semantic', 'procedural'];
const SCOPE_LEVELS = ['profile', 'workspace', 'session'];
function isMemoryKind(value) {
    return typeof value === 'string' && MEMORY_KINDS.includes(value);
}
function isScopeLevel(value) {
    return typeof value === 'string' && SCOPE_LEVELS.includes(value);
}
/** `[0,1]` 夹取：非有限数（缺失 / 字符串 / NaN / ±Infinity）返回 undefined，由调用方走默认值。 */
function clamp01(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    return Math.min(1, Math.max(0, value));
}
/** 冷却表（`state.recallTurnById`）保留的回合数：更早的注入记录不再压制冷却判定。 */
const RECALL_COOLDOWN_KEEP_TURNS = 200;
/** 工具结果里列表条目的硬上限（按条目数截断，见 `jsonList`）。 */
const WIRE_MAX_ITEMS = 50;
/** `/sleep` 回看的会话数硬上限（契约 §2：`--sessions=N` 的上限是 20，且不受配置调高影响）。 */
const SLEEP_MAX_SESSIONS = 20;
/**
 * 归一化宿主下发的配置。
 *
 * 实测（rev20 诊断）：一旦插件导出 `Config`，schema 里声明为 `volatile()` 的字段会以
 * **访问器对象**（`Volatile<T>`，用 `.get()` 读）下发，而不是普通标量；非 volatile 字段仍是普通值。
 * 直接把 volatile 字段当标量用会把对象塞进领域名，得到 `malformed-medium: invalid unit name '[object Object]'`。
 */
function unwrapConfig(config) {
    if (config === null || typeof config !== 'object')
        return {};
    const out = {};
    for (const [key, value] of Object.entries(config)) {
        const isVolatile = value !== null && typeof value === 'object' && typeof value.get === 'function';
        out[key] = isVolatile ? value.get() : value;
    }
    return out;
}
export function apply(ctx, config = {}) {
    const cfg = { ...DEFAULTS, ...unwrapConfig(config) };
    const volatileKeys = config && typeof config === 'object'
        ? Object.entries(config).filter(([, value]) => value !== null && typeof value === 'object' && typeof value.get === 'function').map(([key]) => key)
        : [];
    const startedAt = new Date().toISOString();
    const state = {
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
        // M8：/sleep（预览不计数，只有 --apply 累加）
        sleep: { runs: 0, added: 0, merged: 0, invalidated: 0, archived: 0, gists: 0, skipped: 0, last: null },
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
            // M7：初次设定的累计次数（跨会话，从水位恢复）
            introAsks: 0,
            introAskedSession: null,
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
    };
    let domain = null;
    let disposed = false;
    // 领域句柄的归属权在调用方（storage.zh.md：Domain.close() 由 consumer 负责）。
    // 不在卸载时关闭，被替换的修订版就会一直占着域，下一个实例只会拿到 already-open。
    ctx.effect(() => () => {
        disposed = true;
        const handle = domain;
        return (async () => {
            // 卸载前把内存里累加的用量落盘（best-effort），**然后**再释放领域句柄。
            // 顺序不能反：persist() 走的就是 `domain`，先把它置空会让整个用量落盘静默失败
            // （失败被 persist 内部的 catch 吞掉，外面只看到 openError）。
            try {
                await flushUsage();
            }
            catch { /* 落盘失败不阻塞卸载 */ }
            domain = null;
            try {
                await handle?.close?.();
            }
            catch { /* 关闭失败不阻塞卸载 */ }
        })();
    }, 'dsh-memory.domain');
    // ---------------- 设置页表单的页面策略（设计：M5-b 界面） ----------------
    /**
     * 设置页自检文本。**按需查询** `describe()`，而不是在 apply 时查一次：
     * 描述符可能在配置变化之后才建立，apply 时查会得到时序假阴性。
     * 同时把「被投影的命名空间有哪些」打出来——这是没有 GUI 时定位「表单为什么没出现」的关键证据。
     */
    const settingsLine = () => {
        const base = state.settingsPage;
        try {
            const forms = ctx.get('settings');
            if (!forms?.describe)
                return `${base}（settings 服务不可用）`;
            const list = forms.describe() ?? [];
            const names = list.map((form) => form?.ns).filter(Boolean);
            const ours = names.includes('dsh-memory');
            return `${base}｜describe ${names.length} 个，ours=${ours}｜${names.slice(0, 24).join(', ')}`;
        }
        catch (error) {
            return `${base}｜describe 失败：${errorText(error)}`;
        }
    };
    // 官方 API：`ctx.settings.configure(presentation)` 注册**本插件实例的自动页面策略**，
    // 「设置 → 插件」里该插件自己的页面上就会渲染由 volatile Config 字段投影出的表单
    // （见 docs/subsystems/settings.zh.md、docs/cookbook/adding-a-settings-card.zh.md）。
    //
    // 三个安全措施，保证 UI 面绝不拖垮核心功能：
    //   1) 用 `ctx.inject(['settings'], cb)` 作用域注入 —— settings 缺席时这段永不执行，
    //      也不会像顶层 `inject` 那样让 fiber 永久 PENDING；服务变化时会自动重跑；
    //   2) 整段 try/catch（configure 在「本实例已有页面策略」时会抛错）；
    //   3) 结果写进 state，由 `memory_stats` 暴露 —— 这样没有 GUI 也能验证是否注册成功。
    ctx.inject(['settings'], (scope) => {
        try {
            const forms = scope.settings;
            const dispose = forms.configure({ auto: true });
            scope.effect(() => () => {
                try {
                    dispose?.();
                }
                catch { /* 卸载时忽略 */ }
            }, 'dsh-memory.settings-page');
            state.settingsPage = 'auto';
            // 自检：本条目是否真的出现在表单描述符里（顺带记录描述符的字段名，便于以后核对）
            try {
                const list = forms.describe?.();
                if (Array.isArray(list)) {
                    const first = list[0];
                    const names = list.map((form) => form?.ns ?? form?.id ?? form?.namespace ?? form?.entry ?? null);
                    state.settingsDetail = {
                        count: list.length,
                        keys: first ? Object.keys(first) : [],
                        ours: names.includes('dsh-memory'),
                    };
                }
            }
            catch (error) {
                state.settingsDetail = { error: errorText(error) };
            }
        }
        catch (error) {
            state.settingsPage = `failed: ${errorText(error)}`;
        }
    });
    // ---------------- 自报告（开发期可观测性） ----------------
    const report = { plugin: name, stage: 'M1', revision: cfg.revision ?? null, startedAt, domain: cfg.domainName, volatileKeys };
    let lastFlushAt = 0;
    /** 渲染路径每个 step 都会走，同步 writeFileSync 太贵 —— 这里按 2s 节流。 */
    const flushThrottled = (minMs = 2000) => {
        const now = Date.now();
        if (now - lastFlushAt < minMs)
            return;
        lastFlushAt = now;
        flush();
    };
    const flush = () => {
        if (!cfg.reportPath)
            return;
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
                sleep: state.sleep,
                self: {
                    added: state.self.added,
                    refined: state.self.refined,
                    superseded: state.self.superseded,
                    skipped: state.self.skipped,
                    lastReflectTurn: state.self.lastReflectTurn,
                    reflections: state.self.reflections,
                    reflectTurns: [...state.self.reflectTurns],
                    sessionTurns: state.self.sessionTurns,
                    // M7：初次设定的累计次数（跨会话，持久化在水位里）
                    introAsks: state.self.introAsks,
                    lastError: state.self.lastError,
                },
                usage: {
                    dirty: state.usageDirty.size,
                    injectedNow: state.injectedIds.context.length + state.injectedIds.section.length,
                },
                meta: state.meta,
                budget: state.budget,
                lastReportedAt: new Date().toISOString(),
            };
            mkdirSync(dirname(cfg.reportPath), { recursive: true });
            writeFileSync(cfg.reportPath, JSON.stringify(report, null, 2));
        }
        catch {
            /* 自报告失败绝不影响插件 */
        }
    };
    // ---------------- 存储 ----------------
    const persist = async (record) => {
        if (!state.opened)
            return false;
        state.records.set(record.id, record);
        state.collectionVersion += 1;
        try {
            await domain.table('memories').put(record.id, record);
            return true;
        }
        catch (error) {
            state.openError = `put failed: ${errorText(error)}`;
            return false;
        }
    };
    /**
     * 删除：先摘内存再落盘。**落盘失败必须返回 false 并回滚内存**：
     * 旧实现只记 `openError` 却 `return true`，于是 `/memory forget` 与 `clear` 报「已删除」，
     * 而重启后条目从盘上复活（审计 R7）。调用方按返回值汇总失败条数。
     */
    const remove = async (id) => {
        if (!state.opened)
            return false;
        const record = state.records.get(id);
        if (!record)
            return false;
        state.records.delete(id);
        try {
            await domain.table('memories').delete(id);
        }
        catch (error) {
            state.openError = `delete failed: ${errorText(error)}`;
            // 回滚：让内存与盘保持一致（「没删掉」就是没删掉），而不是留在「内存没有、重启复活」的中间态。
            state.records.set(id, record);
            return false;
        }
        state.collectionVersion += 1;
        return true;
    };
    /** 删除失败时的统一说明：盘上仍在，重启后会回来。 */
    const removeFailureText = (id) => `删除未落盘：${id}（${state.openError ?? '未知错误'}）；该条目仍在，重启后不会消失。`;
    const findByHash = (hash) => [...state.records.values()].find((record) => record.status === 'active' && record.hash === hash);
    /**
     * 记用量（设计稿 §4.1 / §4.4 / §6.2）：`lastUsedAt` 参与时间衰减，`useCount` 参与排序加成。
     * 只改内存 + 标脏，落盘交给整合或卸载，避免每步写盘。
     */
    const markUsed = (records) => {
        const now = Date.now();
        let changed = 0;
        for (const record of records) {
            if (!record || record.status !== 'active')
                continue;
            record.lastUsedAt = now;
            record.useCount = (record.useCount ?? 0) + 1;
            state.usageDirty.add(record.id);
            changed += 1;
        }
        return changed;
    };
    /** 把标脏的用量落盘（整合与卸载时调用）。 */
    const flushUsage = async () => {
        let flushed = 0;
        for (const id of [...state.usageDirty]) {
            const record = state.records.get(id);
            if (!record)
                continue;
            await persist(record);
            flushed += 1;
        }
        state.usageDirty.clear();
        return flushed;
    };
    // ---------------- M6：自画像写入收敛（契约 §4.1） ----------------
    //
    // 收敛只发生在**显式带 facet 的 `agent_self` 写入**上：`memory_write` 工具与 `/memory self set`
    // 会补上缺省 `'work'`；捕获/导入/整合路径不传 facet，行为与 0.5.x 完全一致（向后兼容）。
    // 决策本身是纯函数（lib.ts 的 `planPortraitUpdate`），宿主只负责**如实执行**四种决策：
    //   add → 正常新建；reinforce/refine → 更新既有条目不新建；
    //   supersede → 旧条目 archived + supersededBy，再新建；skip → 不写盘，返回可读原因。
    /** 反思提示的每会话回合号只留最近一批（无界数组会随会话增长）。 */
    const REFLECT_TURNS_KEEP = 32;
    /** 自画像 subject 的 key 白名单：与 `portraitSubjectFor` 的校验一致（非法则回退 'general'）。 */
    const PORTRAIT_KEY_RE = /^[a-z0-9_]+$/u;
    /** M7：命名 key 白名单（对应 lib 的 `self.persona.<key>`）—— 只有这三个能定称呼。 */
    const NAMING_KEYS = new Set(['name', 'address_user', 'address_self']);
    /**
     * 把工具/命令给的 subject 收敛成 `portraitSubjectFor(facet, key)` 的 key：
     * 接受 `voice` / `self.persona.voice` / `agent_self.work.style`，取最后一段做白名单校验，
     * 缺省或非法时回退 `'general'`（与 portraitSubjectFor 自身的回退一致）。
     */
    const portraitKeyOf = (subject) => {
        const raw = String(subject ?? '').trim().toLowerCase();
        if (raw.length === 0)
            return 'general';
        const tail = raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw;
        return PORTRAIT_KEY_RE.test(tail) ? tail : 'general';
    };
    /** 候选置信度：与 `makeRecord` 的缺省一致（0.6），并夹到 [0,1]。 */
    const portraitConfidenceOf = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.6;
    /**
     * 规划一次自画像写入。**纯函数异常不得阻断写入**：出错时记诊断并返回 null，
     * 调用方退回普通写入路径（宁可少一次收敛，也不能丢一条记忆）。
     */
    const planPortraitWrite = (input, text, origin) => {
        try {
            const facet = normalizeFacet(input.facet, 'work');
            const subject = portraitSubjectFor(facet, portraitKeyOf(input.subject));
            const candidate = {
                text,
                facet,
                subject,
                origin,
                confidence: portraitConfidenceOf(input.confidence),
                observedAt: Date.now(),
            };
            const decision = planPortraitUpdate(candidate, state.records.values(), cfg);
            return {
                candidate,
                decision,
                outcome: { action: decision.action, reason: decision.reason, facet, subject, targetId: decision.targetId },
            };
        }
        catch (error) {
            state.self.lastError = `portrait plan failed: ${errorText(error)}`;
            return null;
        }
    };
    /**
     * 自画像字段通过**变量展开**传给 makeRecord：这样在 types.ts 尚未收录 `facet` 的中间修订里
     * 也不会触发对象字面量的多余属性检查（运行期就是记录自身的字段）。
     */
    const portraitRecordFields = (facet) => ({ facet });
    /**
     * reinforce / refine：更新既有条目的正文、置信度与复现计数并落盘，**不新建**。
     * 返回 null 表示目标已被并发删除 → 调用方退回 add（不能凭空丢一次写入）。
     */
    const applyPortraitUpdate = async (plan, input, origin) => {
        const targetId = plan.decision.targetId;
        const target = targetId ? state.records.get(targetId) : undefined;
        if (!target)
            return null;
        // 如实执行决策：用户所有物的保护在 `planPortraitUpdate`（lib 规则 4，含 reinforce 的收紧）里，
        // 宿主这里不再二次判断 —— 否则同一规则会有两份实现、日后必然漂移。
        target.text = plan.decision.text || target.text;
        target.confidence = plan.decision.confidence;
        target.observedAt = Date.now();
        asPortrait(target).facet = plan.outcome.facet;
        // 用户侧写入命中模型侧条目时升级来源与固定位（与 hash 合并分支同一语义：用户侧只升不降）。
        if (ORIGIN_RANK[origin] > ORIGIN_RANK[target.origin])
            target.origin = origin;
        if (input.pinned === true)
            target.pinned = true;
        const nextImportance = clamp01(input.importance);
        if (nextImportance !== undefined)
            target.importance = Math.max(target.importance, nextImportance);
        const sessionId = input.sessionId ? String(input.sessionId) : '';
        const sessions = new Set([...(target.reinforcement?.sessions ?? []), ...(sessionId ? [sessionId] : [])]);
        target.reinforcement = { sessions: [...sessions], count: (target.reinforcement?.count ?? 0) + 1 };
        // 指纹必须重算：recordHash 覆盖 subject 与正文
        target.hash = recordHash(target);
        await persist(target);
        state.writes.merged += 1;
        state.self.refined += 1;
        flush();
        return { ok: true, status: 'merged', id: target.id, record: target, boosted: false, portrait: plan.outcome };
    };
    /**
     * supersede：先把 target 置 `status:'archived'` + `supersededBy:<新 id>`，再新建候选条目。
     * 顺序不能反 —— `supersededBy` 必须指向一个已经确定的 id（§2.1：旧条目归档且留痕）。
     */
    const applyPortraitSupersede = async (plan, input, text, origin) => {
        const target = plan.decision.targetId ? state.records.get(plan.decision.targetId) : undefined;
        const record = makeRecord({
            ...input,
            ...portraitRecordFields(plan.outcome.facet),
            kind: 'agent_self',
            text: plan.decision.text || text,
            origin,
            confidence: plan.decision.confidence,
            subject: plan.outcome.subject,
            supersedes: target ? [target.id] : [],
        });
        asPortrait(record).facet = plan.outcome.facet;
        if (plan.decision.archiveTarget && target) {
            target.status = 'archived';
            asPortrait(target).supersededBy = record.id;
            await persist(target);
        }
        await persist(record);
        state.writes.created += 1;
        state.self.superseded += 1;
        flush();
        return { ok: true, status: 'created', id: record.id, record, portrait: plan.outcome };
    };
    /** 写入：敏感过滤 → PII 脱敏 → 回声剔除 → 自画像收敛 → hash 去重合并 → 落盘。（工具与命令共用） */
    const writeMemory = async (input) => {
        let text = String(input.text ?? '');
        const sensitive = scanSensitive(text);
        if (sensitive) {
            state.writes.rejected += 1;
            flush();
            return { ok: false, error: `rejected_sensitive: 命中 ${sensitive}，长期记忆默认不保存敏感信息` };
        }
        // 硬秘密（密钥/私钥/密码/身份证/银行卡）在上面已拒写；邮箱与手机号按策略脱敏（设计稿 §8.3）
        if (cfg.piiPolicy !== 'reject')
            text = maskPii(text);
        // 防自激闸门 2：模型自评若只是复述刚注入的内容，不作为「新观察」写入。
        const origin = input.origin ?? 'model_proposed';
        if (origin === 'model_proposed' && isEcho(text, [...state.injected.section, ...state.injected.context], cfg.echoThreshold)) {
            state.writes.rejected += 1;
            flush();
            return { ok: false, error: 'rejected_echo: 与刚注入的记忆高度相似（疑似复述），不作为新观察' };
        }
        // ---- 自画像收敛（仅显式 facet 的 agent_self 写入）----
        let portraitPlan = null;
        if (input.kind === 'agent_self' && input.facet !== undefined) {
            const planned = planPortraitWrite(input, text, origin);
            if (planned) {
                if (planned.decision.action === 'skip') {
                    state.self.skipped += 1;
                    flush();
                    return { ok: false, error: `portrait_skipped: ${planned.decision.reason}`, portrait: planned.outcome };
                }
                if (planned.decision.action === 'reinforce' || planned.decision.action === 'refine') {
                    const updated = await applyPortraitUpdate(planned, input, origin);
                    if (updated)
                        return updated;
                }
                else if (planned.decision.action === 'supersede') {
                    return await applyPortraitSupersede(planned, input, text, origin);
                }
                portraitPlan = planned;
            }
        }
        const record = makeRecord({
            ...input,
            ...portraitRecordFields(portraitPlan ? portraitPlan.outcome.facet : input.facet),
            kind: input.kind,
            text: portraitPlan ? (portraitPlan.decision.text || text) : text,
            origin,
            subject: portraitPlan ? portraitPlan.outcome.subject : input.subject,
            confidence: portraitPlan ? portraitPlan.decision.confidence : input.confidence,
        });
        if (!record.text)
            return { ok: false, error: 'rejected_invalid: text 不能为空' };
        // 用户明确拒绝过的自我观察不再重复产生（/memory reject 会登记指纹）
        if (origin === 'model_proposed' && state.rejectedHashes.has(record.hash)) {
            state.writes.rejected += 1;
            flush();
            return { ok: false, error: 'rejected_by_user: 这类自我观察已被用户拒绝过' };
        }
        const existing = findByHash(record.hash);
        if (existing) {
            const sessions = new Set([
                ...(existing.reinforcement?.sessions ?? []),
                ...(record.reinforcement?.sessions ?? []),
            ]);
            // 「重复提及」（设计稿 §5.2）：同一件事在**新的会话**里再次被提到 → 重要度 +boost（封顶 1）
            const incomingSession = input.sessionId ? String(input.sessionId) : null;
            const isNewSession = incomingSession !== null && !(existing.reinforcement?.sessions ?? []).includes(incomingSession);
            const base = Math.max(existing.importance, record.importance);
            const merged = {
                ...existing,
                confidence: Math.max(existing.confidence, record.confidence),
                importance: isNewSession ? Math.min(1, base + (cfg.repeatMentionBoost ?? 0.1)) : base,
                origin: ORIGIN_RANK[record.origin] > ORIGIN_RANK[existing.origin] ? record.origin : existing.origin,
                observedAt: record.observedAt,
                pinned: existing.pinned || record.pinned,
                reinforcement: { sessions: [...sessions], count: (existing.reinforcement?.count ?? 0) + 1 },
            };
            await persist(merged);
            state.writes.merged += 1;
            flush();
            return { ok: true, status: 'merged', id: merged.id, record: merged, boosted: isNewSession };
        }
        await persist(record);
        state.writes.created += 1;
        if (portraitPlan)
            state.self.added += 1;
        flush();
        return {
            ok: true,
            status: 'created',
            id: record.id,
            record,
            ...(portraitPlan ? { portrait: portraitPlan.outcome } : {}),
        };
    };
    // ---------------- 领域打开 + 播种 ----------------
    const openDomain = async () => {
        const storageDomain = ctx.get('storageDomain');
        if (!storageDomain) {
            state.openError = 'storageDomain service absent';
            flush();
            return;
        }
        try {
            domain = await storageDomain.open({
                name: cfg.domainName,
                version: 1,
                layout: 'per-record',
                tables: { memories: { valueSchema: passthroughSchema } },
                global: { schema: passthroughSchema, initial: { schemaVersion: 1, collectionVersion: 0 } },
            });
            // 打开期间插件可能已被卸载：立刻关闭，别把域泄漏出去。
            if (disposed) {
                try {
                    await domain.close();
                }
                catch { /* ignore */ }
                domain = null;
                return;
            }
            state.opened = true;
            try {
                // 必须 await：`domain.global.get()` 在运行版里返回 Promise。
                // 不 await 会把一个 Thenable 存进 state.meta —— 之后 `state.meta?.lastConsolidatedAt`
                // 恒为 undefined，启动水位丢失，每次启动都白跑一整轮整合。
                state.meta = ((await domain.global.get()) ?? null);
                // M7：初次设定的累计次数跟着水位走 —— 存量用户升级后水位里没有这个字段，
                // 按 0 处理即「会问一次」，这正是期望行为。
                const asks = Number(state.meta?.selfIntroAsks ?? 0);
                state.self.introAsks = Number.isFinite(asks) && asks > 0 ? Math.floor(asks) : 0;
            }
            catch { /* 水位读取失败不影响加载 */ }
            for (const entry of domain.table('memories').entries()) {
                const value = Array.isArray(entry) ? entry[1] : entry;
                if (value && typeof value === 'object' && typeof value.id === 'string')
                    state.records.set(value.id, value);
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
                ];
                for (const record of seeds) {
                    await persist(record);
                    state.seeded += 1;
                }
            }
        }
        catch (error) {
            const code = error?.code;
            state.openError = `${code ? `${String(code)}: ` : ''}${errorText(error)}`;
            // 诊断：`malformed-medium: invalid unit name '[object Object]'` 说明有对象被当成 unit 名，
            // 把实际入参记录下来，避免再靠猜。
            state.openErrorDetail = {
                domainName: String(cfg.domainName),
                domainNameType: typeof cfg.domainName,
                configKeys: Object.keys(cfg).slice(0, 40),
                configType: typeof config,
                // 宿主可能把配置包装成 accessor/volatile 形态，直接把原始形状打出来
                configRaw: (() => {
                    try {
                        return JSON.stringify(config)?.slice(0, 400) ?? String(config);
                    }
                    catch {
                        return 'unserializable';
                    }
                })(),
                domainNameShape: (() => {
                    try {
                        const raw = config?.domainName;
                        return `${typeof raw}:${JSON.stringify(raw)?.slice(0, 200)}`;
                    }
                    catch {
                        return typeof config?.domainName;
                    }
                })(),
                detail: error?.detail === undefined
                    ? null
                    : String(JSON.stringify(error.detail)).slice(0, 300),
            };
        }
        flush();
    };
    // 注意：openDomain 的调用放在文件末尾（consolidate 定义之后），避免 TDZ。
    /** 预算核对（设计稿 §7.2 步骤 4）：用自己的估算渲染，再用 tokenMeter 复核；核对结果只观测不阻断。 */
    const crossCheckTokens = (text) => {
        const estimated = estimateTokens(text, cfg.charsPerToken);
        let meterTokens = null;
        let meterError = null;
        try {
            const meter = ctx.get('tokenMeter');
            if (meter && typeof meter.estimateMessage === 'function') {
                meterTokens = meter.estimateMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
            }
        }
        catch (error) {
            meterError = errorText(error);
        }
        state.budget = { chars: text.length, estimated, meterTokens, meterError, at: new Date().toISOString() };
        return text;
    };
    // ---------------- 注入注册 ----------------
    try {
        ctx.systemPrompt.section({
            name: 'dsh-memory:self-portrait',
            order: cfg.sectionOrder,
            text: () => {
                const began = Date.now();
                try {
                    const block = renderSelfBlock(state.records.values(), cfg);
                    state.renders.section += 1;
                    state.renderMs.last = Date.now() - began;
                    state.renderMs.max = Math.max(state.renderMs.max, state.renderMs.last);
                    state.injected.section = block.lines;
                    state.injectedIds.section = block.selected.map((record) => record.id);
                    flushThrottled();
                    return crossCheckTokens(block.text);
                }
                catch {
                    return '';
                }
            },
        });
    }
    catch (error) {
        state.openError = `section register failed: ${errorText(error)}`;
    }
    try {
        ctx.systemPrompt.context({
            name: 'dsh-memory:recall',
            order: cfg.contextOrder,
            text: (assembleContext) => {
                const began = Date.now();
                try {
                    const cwd = assembleContext?.agent?.session?.header?.cwd;
                    const block = renderContextBlock(state.records.values(), cfg, workspaceKeyOf(cwd));
                    state.renders.context += 1;
                    state.renderMs.last = Date.now() - began;
                    state.renderMs.max = Math.max(state.renderMs.max, state.renderMs.last);
                    state.injected.context = block.lines;
                    state.injectedIds.context = block.selected.map((record) => record.id);
                    flushThrottled();
                    return crossCheckTokens(block.text);
                }
                catch {
                    return '';
                }
            },
        });
    }
    catch (error) {
        state.openError = `context register failed: ${errorText(error)}`;
    }
    // ---------------- M2：回合缓冲 + 回合边界规则捕获 ----------------
    // M1 实测：agent/turn-stopping 在根作用域**两种注册都收到**（plain 与 {global:true} 各 1 次），
    // 所以这里只注册一次，避免重复捕获。
    const textOfContent = (content) => {
        if (Array.isArray(content))
            return content.filter((block) => block?.type === 'text').map((block) => block?.text).join('\n');
        return String(content ?? '');
    };
    try {
        ctx.on('session/event', (_session, rawEvent) => {
            const event = rawEvent;
            try {
                const type = event?.type;
                state.lastSession = { id: String(_session?.id ?? ''), cwd: _session?.header?.cwd ?? null };
                // 压缩固化：摘要事件只写日志、不进模型上下文，正好当记忆源（设计稿 §5.5）。
                if (type === 'compaction/summary') {
                    void solidifyCompaction(event);
                    return;
                }
                // 诊断环：保留最近事件类型顺序（event-producer-consumer 的顺序问题很难靠猜）。
                state.recentEvents.push(type === 'user/message' ? `${type}:${event.data?.source?.kind}` : type);
                if (state.recentEvents.length > 30)
                    state.recentEvents.shift();
                state.turnBuffer.lastAt = Date.now();
                if (type === 'turn/end' || type === 'turn/start') {
                    // 不能只靠 turn/start 清空：用户消息可能先于 turn/start 到达（M2 实测 userChars=0 就是被它冲掉的）。
                    // 因此改为「turn/end 清空」，turn/start 只在缓冲区明显过期时清空。
                    const stale = Date.now() - (state.turnBuffer.closedAt ?? 0) > 10 * 60_000;
                    if (type === 'turn/end' || stale) {
                        state.turnBuffer = { user: [], assistant: [], tools: [], lastAt: Date.now(), closedAt: Date.now() };
                    }
                    return;
                }
                if (type === 'user/message') {
                    // 只收真实用户消息；注入的 runtime-context 不算（防自激闸门 1）。
                    if (event.data?.source?.kind === 'user')
                        state.turnBuffer.user.push(textOfContent(event.data?.content));
                    return;
                }
                if (type === 'assistant/message') {
                    state.turnBuffer.assistant.push(textOfContent(event.data?.message?.content));
                    return;
                }
                if (type === 'tool/call') {
                    state.turnBuffer.tools.push(`${String(event.data?.name ?? '')} ${String(event.data?.arguments ?? '').slice(0, 400)}`);
                }
            }
            catch { /* 观测失败绝不影响主流程 */ }
        });
    }
    catch { /* ignore */ }
    const isRootAgent = (agent) => {
        try {
            return ctx.agents.roots().some((root) => root === agent);
        }
        catch {
            return false; // 判定失败时保守跳过写入：宁可少记，也不让子会话污染主画像
        }
    };
    const mergeSkips = (target, extra) => {
        for (const [key, value] of Object.entries(extra ?? {}))
            target[key] = (target[key] ?? 0) + value;
        return target;
    };
    /**
     * 捕获入口：重入保护 + 实际捕获。
     *
     * 为什么需要锁：`agent/turn-stopping` 用 `Promise.race([runCapture(...), 超时])`，超时只意味着
     * 「本回合不再等它」，被超时的那次仍在后台继续写 `state.records` 与 `state.capture.*`；
     * 下一个回合再进来就会与它并发改同一批状态。重入时直接跳过并记一次 skipped，
     * `Promise.race` 的语义（按时返回）保持不变。
     */
    const runCapture = async (agent) => {
        if (state.capturing) {
            state.capture.turns += 1;
            state.capture.skipped['capture-in-flight'] = (state.capture.skipped['capture-in-flight'] ?? 0) + 1;
            const payload = { skipped: 'capture-in-flight' };
            state.capture.last = { at: new Date().toISOString(), ...payload };
            return;
        }
        state.capturing = true;
        try {
            await runCaptureInner(agent);
        }
        finally {
            state.capturing = false;
        }
    };
    /** 一次回合收尾的捕获：规则抽取 → 节流 → 落盘 → 项目印象刷新。任何异常都不得外抛。 */
    const runCaptureInner = async (agent) => {
        const began = Date.now();
        state.capture.turns += 1;
        const done = (payload) => {
            state.capture.last = { at: new Date().toISOString(), ms: Date.now() - began, ...payload };
        };
        // 故障注入（设计稿 §11.2 用例 7）：验证捕获链路异常不会影响对话主流程。
        if (cfg.simulateCaptureError)
            throw new Error('simulated capture failure (fault injection)');
        if (cfg.captureMode === 'off')
            return done({ skipped: 'mode-off' });
        if (!state.opened)
            return done({ skipped: 'domain-not-open' });
        if (!isRootAgent(agent))
            return done({ skipped: 'not-root-agent' });
        const now = Date.now();
        state.capture.hourWindow = state.capture.hourWindow.filter((ts) => now - ts < 3_600_000);
        if (state.capture.hourWindow.length >= cfg.capturePerHour)
            return done({ skipped: 'hour-quota' });
        const sessionId = agent?.session ? String(agent.session.id) : '';
        const cwd = agent?.session?.header?.cwd;
        const workspaceKey = workspaceKeyOf(cwd) ?? '*';
        const userText = state.turnBuffer.user.join('\n');
        const { candidates, skipped } = extractCandidates(userText, cfg);
        let written = 0;
        for (const candidate of candidates) {
            const lastAt = state.capture.lastWriteByHash.get(candidate.hash) ?? 0;
            if (now - lastAt < 24 * 3_600_000) {
                skipped['hash-window'] = (skipped['hash-window'] ?? 0) + 1;
                continue;
            }
            const level = defaultScopeFor(candidate.kind);
            // 主题键：让「同一件事的两种说法」能对齐，否则合并/冲突判定永远不会生效。
            // 纠正类信号直接继承被纠正条目的 subject/field/value —— 这样整合阶段
            // 「用户侧来源无条件推翻」这条链才真正闭环。
            let subject = deriveSubject(candidate.text, candidate.signal);
            let field = null;
            let value = null;
            if (candidate.origin === 'user_correction') {
                const best = recallRecords(state.records.values(), {
                    query: candidate.text, mode: 'memory', minHits: 1, minMatch: 0.3, limit: 1,
                })[0];
                if (best) {
                    subject = best.record.subject ?? subject;
                    field = best.record.field ?? null;
                    value = best.record.value ?? null;
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
            });
            if (result.ok) {
                written += 1;
                state.capture.hourWindow.push(now);
                state.capture.lastWriteByHash.set(candidate.hash, now);
            }
            else {
                const reason = String(result.error ?? 'write-failed').split(':')[0];
                skipped[reason] = (skipped[reason] ?? 0) + 1;
            }
        }
        // 项目模糊印象：零模型调用，同身份只刷新不新增（设计稿 §4.3 / §5.5）。
        let gist = null;
        const markers = detectWorkspaceMarkers([userText, ...state.turnBuffer.tools].join('\n'));
        if (markers.length >= cfg.gistMinMarkers) {
            const existing = [...state.records.values()].find((record) => record.kind === 'project_gist' && record.status === 'active'
                && record.scope.key === workspaceKey && record.subject === 'project.overview');
            const text = composeGistText(markers);
            if (existing) {
                existing.text = text;
                existing.observedAt = now;
                existing.hash = recordHash(existing);
                existing.confidence = Math.min(0.6, (existing.confidence ?? 0.5) + 0.05);
                await persist(existing);
                state.capture.gistRefreshed += 1;
                gist = 'refreshed';
            }
            else {
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
                });
                gist = created.ok ? 'created' : 'failed';
            }
        }
        state.capture.written += written;
        mergeSkips(state.capture.skipped, skipped);
        return done({
            candidates: candidates.length,
            written,
            skipped,
            gist,
            markers,
            userChars: userText.length,
            assistantChars: state.turnBuffer.assistant.join('').length,
            toolCalls: state.turnBuffer.tools.length,
        });
    };
    try {
        ctx.on('agent/turn-stopping', async (payload) => {
            state.turnStopping.plain += 1;
            state.turnStopping.last = { channel: 'plain', at: new Date().toISOString() };
            // R1 的用量按**回合**记一次：常驻块每个 step 都会渲染，按 step 记会虚高。
            try {
                markUsed([...state.injectedIds.context, ...state.injectedIds.section]
                    .map((id) => state.records.get(id))
                    .filter(Boolean));
            }
            catch { /* 记用量失败绝不影响回合 */ }
            try {
                await Promise.race([
                    runCapture(payload?.agent),
                    new Promise((resolve) => { setTimeout(resolve, cfg.captureTimeoutMs); }),
                ]);
            }
            catch (error) {
                state.capture.last = { at: new Date().toISOString(), error: errorText(error) };
            }
            flush();
        });
    }
    catch { /* ignore */ }
    // ---------------- M4：R2 按轮相关召回（pre-step 追加一条带来源的 user 快照） ----------------
    // 与 R1（常驻块）互补：R1 放长期稳定的画像/印象，R2 只放「本轮这句话真的相关」的条目。
    // 注意：长查询必须用 memoryMatch（记忆侧覆盖率），用查询覆盖率会让任何长消息都趋近 0。
    //
    // M6 起这段逻辑改为一个局部函数：pre-step 需要「先 R2、后反思提示」两步独立追加
    // （反思提示不能因为 R2 提前 return 而消失 —— 它的 gate 与 R2 不同）。
    const injectRecallSnapshot = async (decision, payload) => {
        const recallBegan = Date.now();
        try {
            if (decision?.kind === 'reject' || payload?.signal?.aborted === true)
                return decision;
            if (cfg.autoRecall === false || cfg.recallMode === 'off' || !state.opened)
                return decision;
            const proposed = Array.isArray(decision?.messages) ? decision.messages : [];
            const query = proposed.map((message) => textOfContent(message?.content)).join('\n');
            if (query.trim().length < (cfg.recallMinQueryChars ?? 12))
                return decision;
            const turn = Number(payload?.turn ?? 0);
            const workspaceKey = workspaceKeyOf(payload?.agent?.session?.header?.cwd);
            const residentLines = new Set([...state.injected.context, ...state.injected.section]
                .map((line) => line.replace(/^[-*\s]+/u, '').replace(/^\([a-z]+\)\s*/u, '').trim()));
            const cooldownTurns = cfg.recallCooldownTurns ?? 3;
            // 候选池要**大于** topK：过滤发生在取前 K 条之前，否则刚注入过的条目
            // （markUsed 给了 recency 加成，分数最高）会霸占前 K 个名额、随即被冷却过滤掉，
            // 把它们后面的相关条目全挤走 —— 表现就是后续回合「0 命中」。
            const topK = cfg.recallTopK ?? 8;
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
                .slice(0, topK);
            state.recall.turns += 1;
            // 超时保护（设计稿 §6.3：召回耗时上限 10ms，超时跳过本轮）
            const recallBudgetMs = cfg.recallBudgetMs ?? 10;
            if (Date.now() - recallBegan > recallBudgetMs) {
                state.recall.last = { at: new Date().toISOString(), turn, queryChars: query.length, hits: 0, skipped: 'over-budget', ms: Date.now() - recallBegan };
                return decision;
            }
            if (hits.length === 0) {
                state.recall.last = { at: new Date().toISOString(), turn, queryChars: query.length, hits: 0, mode: cfg.recallMode };
                return decision;
            }
            // 硬预算（设计稿 §7.2）：块内固定文案先扣掉，再逐条填。不能像早期版本那样直接 map 全部命中，
            // 否则 8 条 × 60 token 会突破 maxInjectedTokens。
            const R2_HEADER = '[相关记忆 · 本轮召回]';
            // 与 lib 的 FACTS_FOOTER 同一原则：记忆可能过时，判断以事实与实际效果为准，
            // 而不是「谁说的更新/更肯定」。原文「以当前对话为准」把顺从写进了规则。
            const R2_FOOTER = '以上为历史记录，可能与本轮任务相关，也可能已过时；先核对事实再采用。';
            const r2Budget = Math.max(0, cfg.maxInjectedTokens - estimateTokens(`${R2_HEADER}\n${R2_FOOTER}`, cfg.charsPerToken));
            const filled = fillWithinBudget(hits.map((hit) => hit.record), r2Budget, (record, text) => `- (${record.kind}) ${text}`, cfg);
            const keptIds = new Set(filled.selected.map((record) => record.id));
            const keptHits = hits.filter((hit) => keptIds.has(hit.record.id));
            if (filled.lines.length === 0) {
                state.recall.last = { at: new Date().toISOString(), turn, queryChars: query.length, hits: 0, mode: cfg.recallMode, budgetSkipped: hits.length };
                return decision;
            }
            const lines = filled.lines;
            const text = [R2_HEADER, ...lines, R2_FOOTER].join('\n');
            state.recall.injected += cfg.recallMode === 'inject' ? keptHits.length : 0;
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
            };
            for (const hit of keptHits)
                state.recallTurnById.set(hit.record.id, turn);
            markUsed(keptHits.map((hit) => hit.record));
            flush();
            // dry：只算不注入（用于上线前验证打分与消息形状，不会改动对话）
            if (cfg.recallMode === 'dry')
                return decision;
            // 形状必须与宿主自己注入的 runtime-context 消息完全一致（从会话日志取证）：
            // { role:'user', id:<uuid>, content:[{type:'text',text}], source:{kind:'runtime-context',form:'snapshot',sections:[...]} }
            // 自造 source.kind 有被运行时校验拒绝的风险，故沿用已注册的 runtime-context。
            const messageId = globalThis.crypto?.randomUUID?.() ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            return {
                ...decision,
                messages: [...proposed, {
                        role: 'user',
                        id: messageId,
                        content: [{ type: 'text', text }],
                        source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'dsh-memory:recall', text }] },
                    }],
            };
        }
        catch (error) {
            state.recall.last = { at: new Date().toISOString(), error: errorText(error) };
            flush();
            return decision;
        }
    };
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
    const injectReflectNotice = (decision, payload) => {
        try {
            if (!decision || typeof decision !== 'object')
                return decision;
            if (decision.kind === 'reject' || payload?.signal?.aborted === true)
                return decision;
            if (cfg.selfReflectEnabled === false)
                return decision;
            if (cfg.autoRecall === false || cfg.recallMode === 'off' || cfg.recallMode === 'dry' || !state.opened)
                return decision;
            const rawTurn = Number(payload?.turn ?? 0);
            if (!Number.isFinite(rawTurn) || rawTurn < 0)
                return decision;
            const turn = Math.floor(rawTurn);
            // 会话切换：反思配额按会话重置（回合号本来就是按会话重新计数的）
            const sessionId = String(payload?.agent?.session?.id ?? '');
            if (state.self.sessionId !== sessionId) {
                state.self.sessionId = sessionId;
                state.self.lastReflectTurn = null;
                state.self.reflections = 0;
                state.self.reflectTurns = [];
                state.self.sessionTurns = 0;
            }
            // 回合号按会话递增（实测宿主这样下发），因此它本身就是「已进行的回合数」。
            // 取 max 保证单调不减：pre-step 每个 step 都会跑，回合号在极端情况下可能回退。
            if (turn > state.self.sessionTurns)
                state.self.sessionTurns = turn;
            const due = shouldReflect({
                turn,
                lastReflectTurn: state.self.lastReflectTurn,
                reflectionsThisSession: state.self.reflections,
                sessionTurns: state.self.sessionTurns,
            }, cfg);
            if (!due)
                return decision;
            const proposed = Array.isArray(decision.messages) ? decision.messages : [];
            // 注入正文一律过 clampText：折平单行（防结构伪造），预算用整块注入预算（提示本身就是一条完整块）
            const text = clampText(REFLECT_NOTICE, Math.max(1, cfg.maxInjectedTokens ?? DEFAULTS.maxInjectedTokens), cfg.charsPerToken);
            const messageId = globalThis.crypto?.randomUUID?.() ?? `mem-reflect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const message = {
                role: 'user',
                id: messageId,
                content: [{ type: 'text', text }],
                source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'dsh-memory:self-reflect', text }] },
            };
            // 先构造好消息再推进计数：注入失败时不能留下「提醒过」的假账
            state.self.lastReflectTurn = turn;
            state.self.reflections += 1;
            state.self.reflectTurns = [...state.self.reflectTurns, turn].slice(-REFLECT_TURNS_KEEP);
            flush();
            return { ...decision, messages: [...proposed, message] };
        }
        catch (error) {
            state.self.lastError = `reflect inject failed: ${errorText(error)}`;
            flush();
            return decision;
        }
    };
    /**
     * M7：初次设定（称呼）提示 —— 与反思提示同形的**一次性**通道（契约 §7.5）。
     *
     * 与反思的三点不同：
     *  · 闸门限制的是**跨会话累计次数**（`selfIntroMaxAsks`，默认 2），问满即永久停手；
     *  · 同一会话只问一次（`introAskedSession`）—— 别在一个会话里追着问；
     *  · 一旦命名 subject 有过记录（`namingSettled`）立刻停手，包括用户说「不用」时
     *    模型按提示记下的那条「保持默认称呼」。
     *
     * 计数要跨会话生效，所以成功后立刻尽力落盘（水位在整合时还会再写一次）。
     * 任何异常都被 catch：pre-step 主流程绝不能因为提示注入而失败。
     */
    const injectIntroNotice = (decision, payload) => {
        try {
            if (!decision || typeof decision !== 'object')
                return decision;
            if (decision.kind === 'reject' || payload?.signal?.aborted === true)
                return decision;
            if (cfg.selfIntroEnabled === false)
                return decision;
            if (cfg.autoRecall === false || cfg.recallMode === 'off' || cfg.recallMode === 'dry' || !state.opened)
                return decision;
            const rawTurn = Number(payload?.turn ?? 0);
            if (!Number.isFinite(rawTurn) || rawTurn < 0)
                return decision;
            const turn = Math.floor(rawTurn);
            const sessionId = String(payload?.agent?.session?.id ?? '');
            if (sessionId !== '' && state.self.introAskedSession === sessionId)
                return decision;
            const settled = namingSettled(state.records.values());
            if (!shouldIntroduce({ turn, asks: state.self.introAsks, settled }, cfg))
                return decision;
            const proposed = Array.isArray(decision.messages) ? decision.messages : [];
            const text = clampText(INTRO_NOTICE, Math.max(1, cfg.maxInjectedTokens ?? DEFAULTS.maxInjectedTokens), cfg.charsPerToken);
            const messageId = globalThis.crypto?.randomUUID?.() ?? `mem-intro-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const message = {
                role: 'user',
                id: messageId,
                content: [{ type: 'text', text }],
                source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'dsh-memory:self-intro', text }] },
            };
            // 先构造好消息再推进计数：注入失败时不能留下「问过」的假账
            state.self.introAsks += 1;
            state.self.introAskedSession = sessionId === '' ? null : sessionId;
            const handle = domain;
            if (handle) {
                state.meta = {
                    ...(state.meta ?? {}),
                    schemaVersion: 1,
                    collectionVersion: state.collectionVersion,
                    selfIntroAsks: state.self.introAsks,
                };
                try {
                    void Promise.resolve(handle.global.set(state.meta)).catch(() => { });
                }
                catch { /* 同上 */ }
            }
            flush();
            return { ...decision, messages: [...proposed, message] };
        }
        catch (error) {
            state.self.lastError = `intro inject failed: ${errorText(error)}`;
            flush();
            return decision;
        }
    };
    try {
        ctx.on('agent/pre-step', async (rawPayload, next) => {
            const payload = rawPayload;
            const decided = (await next());
            // 顺序固定：R2 快照 → 反思提示 → 初次设定；三者各自独立追加、互不影响对方的闸门
            const withRecall = await injectRecallSnapshot(decided, payload);
            const withReflect = injectReflectNotice(withRecall, payload);
            return injectIntroNotice(withReflect, payload);
        });
    }
    catch { /* ignore */ }
    // ---------------- M3：整合治理（合并 / 冲突 / 衰减归档 / 摘要） ----------------
    const consolidate = async (reason) => {
        const began = Date.now();
        if (!state.opened)
            return;
        // 重入锁：定时器与 /memory consolidate（或 memory_maintain）可能重叠，
        // 并发跑会出现「同一批记录被合并两次」这类逻辑交错。
        if (state.consolidating) {
            state.consolidate.skipped = (state.consolidate.skipped ?? 0) + 1;
            return;
        }
        state.consolidating = true;
        try {
            await runConsolidate(reason, began);
        }
        finally {
            state.consolidating = false;
        }
    };
    const runConsolidate = async (reason, began) => {
        const now = Date.now();
        const summary = { at: new Date().toISOString(), reason, merged: 0, archived: 0, invalidated: 0, summarized: 0 };
        const budget = cfg.consolidateMaxRecords ?? 200;
        try {
            // 1) 合并同 subject 的近似条目：保留最优者，其余归档（不删除）
            for (const group of pickMergeGroups(state.records.values(), cfg)) {
                if (summary.merged >= budget)
                    break;
                const [lead, ...rest] = [...group].sort(compareRecords);
                for (const extra of rest) {
                    lead.useCount = (lead.useCount ?? 0) + (extra.useCount ?? 0);
                    lead.importance = Math.max(lead.importance, extra.importance);
                    lead.confidence = Math.max(lead.confidence, extra.confidence);
                    lead.observedAt = Math.max(lead.observedAt, extra.observedAt);
                    extra.status = 'archived';
                    await persist(extra);
                    summary.merged += 1;
                }
                await persist(lead);
            }
            // 2) 冲突：旧条目置 invalid（可恢复），新条目记 supersedes；模型自评不能推翻用户侧条目
            for (const { winner, loser, blocked } of findConflicts(state.records.values())) {
                if (blocked)
                    continue;
                loser.status = 'invalid';
                loser.invalidAt = now;
                winner.supersedes = [...new Set([...(winner.supersedes ?? []), loser.id])];
                await persist(loser);
                await persist(winner);
                summary.invalidated += 1;
            }
            // 3) 衰减与归档
            for (const record of listActive(state.records.values())) {
                if (summary.archived >= budget)
                    break;
                if (shouldArchive(record, cfg, now)) {
                    record.status = 'archived';
                    await persist(record);
                    summary.archived += 1;
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
                });
                if (result.ok)
                    summary.summarized += 1;
            }
            // 5) 用量落盘（注入/召回只在内存累加，避免每步写盘）
            const flushedUsage = await flushUsage();
            if (flushedUsage > 0)
                summary.usageFlushed = flushedUsage;
            // 6) 无界状态收敛：冷却表与写入窗口表只增不删会慢慢吃掉内存
            if (state.recallTurnById.size > 500) {
                // 冷却表按**回合号**记账（key = 记录 id，value = 最近一次注入它的回合号；
                // 判定在 `agent/pre-step`：`turn - last >= cooldownTurns`）。
                // cutoff 必须用**当前回合号**：旧实现读 `state.consolidate.last?.turn`，
                // 而那个字段从来没有被写过（恒为 undefined → 0），cutoff 恒为 -200，
                // `turn < -200` 永不成立 —— 冷却表因此跨会话无限增长。
                // 当前回合号直接取 `state.recall.last.turn`（pre-step 每次都会写它），不引入新的全局状态；
                // 它缺席（pre-step 因异常只写了 error）时本轮不收敛，等下一个回合再说。
                const currentTurn = state.recall.last?.turn;
                if (typeof currentTurn === 'number' && Number.isFinite(currentTurn)) {
                    const cutoff = currentTurn - RECALL_COOLDOWN_KEEP_TURNS;
                    for (const [id, turn] of state.recallTurnById) {
                        // turn > currentTurn 是**上一个会话**遗留的回合号（回合号按会话从 0 重新计数）：
                        // 它永远不会被冷却判定放过，留着只会永久压制该条目 —— 与过期条目一起清掉。
                        if (turn < cutoff || turn > currentTurn)
                            state.recallTurnById.delete(id);
                    }
                }
            }
            if (state.capture.lastWriteByHash.size > 2000) {
                const cutoff = now - 7 * 86_400_000;
                for (const [hash, at] of state.capture.lastWriteByHash)
                    if (at < cutoff)
                        state.capture.lastWriteByHash.delete(hash);
            }
            // 7) 元数据水位（global）
            state.meta = {
                ...(state.meta ?? {}),
                schemaVersion: 1,
                collectionVersion: state.collectionVersion,
                lastConsolidatedAt: now,
                // M7：初次设定的累计次数随水位一起持久化
                selfIntroAsks: state.self.introAsks,
            };
            try {
                await domain.global.set(state.meta);
            }
            catch { /* 水位写失败不影响本轮整合结果 */ }
        }
        catch (error) {
            summary.error = errorText(error);
        }
        summary.ms = Date.now() - began;
        state.consolidate.runs += 1;
        state.consolidate.merged += summary.merged;
        state.consolidate.archived += summary.archived;
        state.consolidate.invalidated += summary.invalidated;
        state.consolidate.summarized += summary.summarized;
        state.consolidate.last = summary;
        flush();
    };
    /** 压缩固化：把压缩摘要里的要点落成 episodic 记忆，防「压缩即丢失」。 */
    const solidifyCompaction = async (event) => {
        try {
            const text = extractSummaryText(event?.data?.summary);
            if (!text)
                return;
            const shadowed = Array.isArray(event?.data?.shadowedSeqs) ? event.data.shadowedSeqs : [];
            const seqStart = shadowed.length > 0 ? Number(shadowed[0]) : Number(event?.seq ?? 0);
            const seqEnd = shadowed.length > 0 ? Number(shadowed[shadowed.length - 1]) : Number(event?.seq ?? 0);
            const sessionId = state.lastSession?.id ?? '';
            const workspaceKey = workspaceKeyOf(state.lastSession?.cwd) ?? '*';
            let written = 0;
            for (const sentence of splitSentences(text).slice(0, cfg.solidificationMaxPerCompaction ?? 3)) {
                if (isExcluded(sentence))
                    continue;
                const result = await writeMemory({
                    kind: 'episodic',
                    text: sentence.replace(/[。！？!?]+$/u, '').trim(),
                    origin: 'observed',
                    confidence: 0.65,
                    importance: 0.55,
                    tags: ['compaction'],
                    scope: { level: 'workspace', key: workspaceKey },
                    source: { sessionId, seqStart, seqEnd },
                });
                if (result.ok)
                    written += 1;
            }
            state.consolidate.solidified += written;
            flush();
        }
        catch { /* 固化失败绝不影响主流程 */ }
    };
    try {
        ctx.effect(() => {
            const intervalMs = Math.max(1, cfg.consolidateIntervalMinutes ?? 30) * 60_000;
            const timer = setInterval(() => {
                if (cfg.consolidateEnabled === false)
                    return;
                void consolidate('interval');
            }, intervalMs);
            return () => clearInterval(timer);
        }, 'dsh-memory.consolidate-timer');
    }
    catch { /* ignore */ }
    // ---------------- 模型工具（原生 JSON Schema） ----------------
    const toolOutput = {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
    };
    /**
     * 工具结果序列化：**绝不在 JSON 文本中间切**。
     * 旧实现是 `JSON.stringify(value, null, 2).slice(0, 8000)`：会在任意位置切断，
     * 模型拿到的是解析失败的残片（而且没有任何截断标记）。
     */
    const json = (value) => JSON.stringify(value, null, 2);
    /**
     * 列表型结果的统一形状：按**条目数**截断（保留前 `WIRE_MAX_ITEMS` 条）后整体序列化，
     * 并带上 `total` 与 `truncated`，让模型知道「这不是全部」，而不是拿到坏 JSON。
     * `key` 保持各工具原有的字段名（items / matches / candidates），不额外制造 API 漂移。
     */
    const jsonList = (key, items, extra = {}) => {
        const total = items.length;
        const kept = items.slice(0, WIRE_MAX_ITEMS);
        return json({ ...extra, count: kept.length, total, truncated: total > kept.length, [key]: kept });
    };
    const toolMessages = (exec) => {
        try {
            return exec?.agent?.session?.deriveMessages?.() ?? [];
        }
        catch {
            return [];
        }
    };
    /**
     * 自画像条目的诊断视图（契约 §4.5）：把 `facet` 与取代链（`supersededBy` / `supersedes`）亮出来。
     * 记录本身存的就是这两个可选字段，运行期直接读；`facetOf` 负责存量兼容（无 facet → 'work'）。
     */
    const portraitRecordView = (record) => {
        const fields = asPortrait(record);
        const view = {
            id: record.id,
            status: record.status,
            facet: facetOf(record),
            subject: record.subject,
            origin: record.origin,
            pinned: record.pinned,
            confidence: record.confidence,
            observedAt: new Date(record.observedAt).toISOString(),
            text: record.text,
        };
        // 「若有」：只有被取代过的旧条目才有 supersededBy，只有取代过别人的条目才有 supersedes
        if (fields.supersededBy)
            view.supersededBy = fields.supersededBy;
        if (Array.isArray(record.supersedes) && record.supersedes.length > 0)
            view.supersedes = [...record.supersedes];
        return view;
    };
    /** 自画像诊断：只读、绝不抛（memory_explain 的输出）。 */
    const portraitDiagnostics = () => {
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
            };
        }
        catch (error) {
            return { records: [], error: errorText(error) };
        }
    };
    const tools = [
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
                const args = rawArgs;
                state.toolCalls.memory_write = (state.toolCalls.memory_write ?? 0) + 1;
                const origin = cfg.trustToolWrites ? 'user_explicit' : deriveOriginFromMessages(toolMessages(exec));
                const scopeLevel = args.scopeLevel ?? defaultScopeFor(args.kind);
                const scopeKey = scopeLevel === 'workspace' ? (workspaceKeyOf(exec?.agent?.session?.header?.cwd) ?? '*') : '*';
                // facet 只对 agent_self 有意义；其余类型一律不带（否则等于给普通记忆加了一个无意义的自画像字段）。
                // 注意这里**总是**给 agent_self 补上缺省 'work'：正是这个显式 facet 让写入走自画像收敛（契约 §4.1）。
                const facet = args.kind === 'agent_self' ? normalizeFacet(args.facet, 'work') : undefined;
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
                });
                return json(result);
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
                const args = rawArgs;
                state.toolCalls.memory_recall = (state.toolCalls.memory_recall ?? 0) + 1;
                // 归档条目（设计稿 §4.4）只是不常驻注入，模型主动检索时应当可见
                const hits = recallRecords(state.records.values(), { ...(args ?? {}), includeArchived: true });
                markUsed(hits.map((hit) => hit.record));
                return jsonList('items', hits.map(({ record, score }) => ({
                    id: record.id, kind: record.kind, scope: record.scope, origin: record.origin,
                    text: record.text, pinned: record.pinned, score: Number(score.toFixed(3)),
                    observedAt: new Date(record.observedAt).toISOString(),
                })));
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
                const args = rawArgs;
                state.toolCalls.memory_list = (state.toolCalls.memory_list ?? 0) + 1;
                const status = args?.status ?? 'active';
                const rows = [...state.records.values()]
                    .filter((record) => (status === 'all' ? true : record.status === status))
                    .filter((record) => (args?.kind ? record.kind === args.kind : true))
                    .sort(compareRecords)
                    .slice(0, Math.max(1, Math.min(100, args?.limit ?? 50)));
                return jsonList('items', rows.map((record) => ({
                    id: record.id, kind: record.kind, status: record.status, origin: record.origin,
                    scope: record.scope, pinned: record.pinned, importance: record.importance, text: record.text,
                })));
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
                const args = rawArgs;
                state.toolCalls.memory_forget = (state.toolCalls.memory_forget ?? 0) + 1;
                if (args?.id) {
                    const target = [...state.records.values()].find((record) => record.id === args.id || record.id.startsWith(args.id));
                    if (!target)
                        return json({ ok: false, error: 'not_found' });
                    // 落盘失败必须如实回报：否则「已删除」的条目重启后会复活。
                    if (!(await remove(target.id)))
                        return json({ ok: false, error: 'delete_failed', id: target.id, detail: state.openError });
                    state.writes.deleted += 1;
                    flush();
                    return json({ ok: true, deleted: [target.id], text: target.text });
                }
                if (args?.query) {
                    // 破坏性操作：词面覆盖率必须 ≥ 0.6，宁可少删不可错删。
                    const hits = recallRecords(state.records.values(), { query: args.query, limit: 20, minLexical: 0.6 }, Date.now());
                    if (!args.confirm) {
                        return jsonList('matches', hits.map(({ record }) => ({ id: record.id, text: record.text })), { ok: false, needsConfirm: true });
                    }
                    const deleted = [];
                    for (const { record } of hits) {
                        if (await remove(record.id))
                            deleted.push(record.id);
                    }
                    const failed = hits.length - deleted.length;
                    state.writes.deleted += deleted.length;
                    flush();
                    if (failed > 0)
                        return json({ ok: false, error: 'delete_failed', deleted, failed, detail: state.openError });
                    return json({ ok: true, deleted });
                }
                return json({ ok: false, error: 'provide id or query' });
            },
        },
        {
            name: 'memory_stats',
            description: '查看长期记忆的运行时可观测信息：条数、写入/拒绝计数、注入行数、渲染耗时、整合与召回状态。',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => {
                state.toolCalls.memory_stats = (state.toolCalls.memory_stats ?? 0) + 1;
                // 结构化字段与 `/memory stats` 的文本同步（契约 §5.4）：模型不必去解析那行中文。
                return json({ ...handlers.stats(), sleep: { ...state.sleep } });
            },
        },
        {
            name: 'memory_maintain',
            description: '整理长期记忆：合并同主题的重复条目、把矛盾条目标记为失效、按衰减归档。后台会定期自动执行，这里用于手动触发。',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => {
                state.toolCalls.memory_maintain = (state.toolCalls.memory_maintain ?? 0) + 1;
                await consolidate('manual');
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
                });
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
                const args = rawArgs;
                state.toolCalls.memory_explain = (state.toolCalls.memory_explain ?? 0) + 1;
                const { candidates, skipped } = extractCandidates(String(args?.text ?? ''), cfg);
                const candidateViews = candidates.map((candidate) => {
                    const view = {
                        signal: candidate.signal, kind: candidate.kind, origin: candidate.origin,
                        confidence: candidate.confidence, importance: candidate.importance, text: candidate.text,
                    };
                    // 契约 §4.5：输出带 facet。只有 agent_self 有意义；捕获候选不带 facet → 存量兼容按 'work'。
                    if (candidate.kind === 'agent_self')
                        view.facet = normalizeFacet(undefined, 'work');
                    return view;
                });
                if (args?.apply !== true) {
                    return jsonList('candidates', candidateViews, { skipped, portrait: portraitDiagnostics() });
                }
                const origin = cfg.trustToolWrites ? 'user_explicit' : deriveOriginFromMessages(toolMessages(exec));
                const written = [];
                for (const candidate of candidates) {
                    const level = defaultScopeFor(candidate.kind);
                    const result = await writeMemory({
                        kind: candidate.kind,
                        text: candidate.text,
                        origin: candidate.origin === 'observed' ? origin : candidate.origin,
                        confidence: candidate.confidence,
                        importance: candidate.importance,
                        tags: candidate.tags,
                        sessionId: exec?.agent?.session ? String(exec.agent.session.id) : undefined,
                        scope: { level, key: level === 'workspace' ? (workspaceKeyOf(exec?.agent?.session?.header?.cwd) ?? '*') : '*' },
                    });
                    written.push({ ok: result.ok, status: result.status, id: result.id, error: result.error, portrait: result.portrait });
                }
                // 诊断是**应用之后**再取一次：这样输出里能直接看到 supersede 的结果
                // （旧条目 status='archived' 且带 supersededBy，新条目带 facet）。
                return jsonList('candidates', candidateViews, { skipped, applied: true, written, portrait: portraitDiagnostics() });
            },
        },
    ];
    for (const tool of tools) {
        try {
            ctx.tools.register({ ...tool, output: toolOutput });
        }
        catch (error) {
            state.openError = `tool ${tool.name} register failed: ${errorText(error)}`;
        }
    }
    flush();
    // ---------------- /memory 治理命令 ----------------
    const listLine = (record) => `${record.id.slice(0, 8)}  ${record.kind.padEnd(13)} ${record.scope.level.padEnd(9)}${record.pinned ? '★' : ' '} ${record.text}`;
    const exportRecords = (targetPath) => {
        const dir = cfg.exportDir ?? (cfg.reportPath ? dirname(cfg.reportPath) : process.cwd());
        const file = targetPath && isAbsolute(targetPath) ? targetPath : join(dir, targetPath ?? `memory-export-${Date.now()}.json`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            domain: cfg.domainName,
            items: [...state.records.values()].filter((record) => record.status !== 'deleted'),
        }, null, 2));
        return file;
    };
    const handlers = {
        list(args) {
            const kind = args.find((part) => part.startsWith('--kind='))?.slice(7);
            const includeArchived = args.includes('--archived');
            const rows = [...state.records.values()]
                .filter((record) => record.status === 'active' || (includeArchived && record.status === 'archived'))
                .filter((record) => (kind ? record.kind === kind : true))
                .sort(compareRecords);
            if (rows.length === 0)
                return { kind: 'success', text: includeArchived ? '长期记忆为空。' : '没有 active 记忆（试试 /memory list --archived）。' };
            return { kind: 'success', text: `${rows.length} 条记忆：\n${rows.map((record) => `${listLine(record)}${record.status === 'archived' ? ' [archived]' : ''}`).join('\n')}` };
        },
        show(args) {
            const id = args[0];
            if (!id)
                return { kind: 'error', text: '用法：/memory show <id 前缀>' };
            const record = [...state.records.values()].find((candidate) => candidate.id.startsWith(id));
            if (!record)
                return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` };
            return { kind: 'success', text: JSON.stringify(record, null, 2) };
        },
        async forget(args) {
            const id = args[0];
            if (!id)
                return { kind: 'error', text: '用法：/memory forget <id 前缀>' };
            const target = [...state.records.values()].find((record) => record.id.startsWith(id));
            if (!target)
                return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` };
            if (!(await remove(target.id)))
                return { kind: 'error', text: removeFailureText(target.id) };
            state.writes.deleted += 1;
            flush();
            return { kind: 'success', text: `已删除 ${target.id}\n${target.text}` };
        },
        async restore(args) {
            const id = args[0];
            if (!id)
                return { kind: 'error', text: '用法：/memory restore <id 前缀>' };
            const target = [...state.records.values()].find((record) => record.id.startsWith(id));
            if (!target)
                return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` };
            target.status = 'active';
            target.invalidAt = null;
            // 撤销推翻链：把当前正在推翻它的条目标为失效，否则下一次整合会立刻再推翻一次。
            const superseders = [...state.records.values()].filter((record) => record.status === 'active' && record.id !== target.id && (record.supersedes ?? []).includes(target.id));
            for (const superseder of superseders) {
                superseder.status = 'invalid';
                superseder.invalidAt = Date.now();
                await persist(superseder);
            }
            await persist(target);
            return {
                kind: 'success',
                text: `已恢复 ${target.id}${superseders.length > 0 ? `（同时失效 ${superseders.length} 条推翻它的记录）` : ''}`,
            };
        },
        async pin(args) {
            const id = args[0];
            if (!id)
                return { kind: 'error', text: '用法：/memory pin <id 前缀>' };
            const target = [...state.records.values()].find((record) => record.id.startsWith(id));
            if (!target)
                return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` };
            target.pinned = !target.pinned;
            await persist(target);
            return { kind: 'success', text: `${target.pinned ? '已固定' : '已取消固定'} ${target.id}` };
        },
        async archive(args) {
            const id = args[0];
            if (!id)
                return { kind: 'error', text: '用法：/memory archive <id 前缀>' };
            const target = [...state.records.values()].find((record) => record.id.startsWith(id));
            if (!target)
                return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` };
            target.status = 'archived';
            await persist(target);
            return { kind: 'success', text: `已归档 ${target.id}（不再注入，但仍可检索）` };
        },
        export(args) {
            try {
                const file = exportRecords(args[0]);
                return { kind: 'success', text: `已导出 ${listActive(state.records.values()).length} 条到 ${file}` };
            }
            catch (error) {
                return { kind: 'error', text: `导出失败：${errorText(error)}` };
            }
        },
        search(args) {
            const query = args.join(' ');
            if (query.length === 0)
                return { kind: 'error', text: '用法：/memory search <关键词>' };
            const hits = recallRecords(state.records.values(), { query, limit: 10, includeArchived: true });
            if (hits.length === 0)
                return { kind: 'success', text: `没有匹配「${query}」的记忆。` };
            return { kind: 'success', text: hits.map(({ record, score }) => `${record.id.slice(0, 8)}  ${score.toFixed(2)}  ${record.text}`).join('\n') };
        },
        async refresh(args) {
            const id = args[0];
            if (!id)
                return { kind: 'error', text: '用法：/memory refresh <id 前缀>' };
            const target = [...state.records.values()].find((record) => record.id.startsWith(id));
            if (!target)
                return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` };
            target.observedAt = Date.now();
            if (target.kind === 'project_gist')
                target.confidence = Math.min(0.6, (target.confidence ?? 0.5) + 0.05);
            await persist(target);
            return { kind: 'success', text: `已刷新 ${target.id}（衰减重新计时）` };
        },
        async confirm(args) {
            const id = args[0];
            if (!id)
                return { kind: 'error', text: '用法：/memory confirm <id 前缀>（把模型自评升级为用户确认）' };
            const target = [...state.records.values()].find((record) => record.id.startsWith(id));
            if (!target)
                return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` };
            target.origin = 'user_explicit';
            target.confidence = Math.max(0.9, target.confidence ?? 0);
            await persist(target);
            return { kind: 'success', text: `已确认 ${target.id}（origin → user_explicit，confidence ≥ 0.9）` };
        },
        async reject(args) {
            const id = args[0];
            if (!id)
                return { kind: 'error', text: '用法：/memory reject <id 前缀>（拒绝一条自我观察）' };
            const target = [...state.records.values()].find((record) => record.id.startsWith(id));
            if (!target)
                return { kind: 'error', text: `未找到匹配 "${id}" 的记忆。` };
            target.status = 'invalid';
            target.invalidAt = Date.now();
            state.rejectedHashes.add(target.hash);
            await persist(target);
            return { kind: 'success', text: `已拒绝 ${target.id}（同类自我观察不会再产生）` };
        },
        async clear(args) {
            const all = args.includes('--all');
            const confirmed = args.includes('--yes');
            const kindRaw = args.find((part) => part.startsWith('--kind='))?.slice(7);
            const scopeRaw = args.find((part) => part.startsWith('--scope='))?.slice(8);
            const usage = '用法：/memory clear --all --yes | /memory clear --kind=<kind> [--scope=<level>] --yes（多个条件按 AND 组合；--all 不能与其它条件同时使用）';
            if (!all && kindRaw === undefined && scopeRaw === undefined)
                return { kind: 'error', text: usage };
            // 枚举校验：拼错的 --kind/--scope 以前会静默匹配 0 条却回「已永久删除」。
            if (kindRaw !== undefined && !isMemoryKind(kindRaw)) {
                return { kind: 'error', text: `未知的 --kind=${kindRaw}（可用：${MEMORY_KINDS.join(' | ')}）。${usage}` };
            }
            if (scopeRaw !== undefined && !isScopeLevel(scopeRaw)) {
                return { kind: 'error', text: `未知的 --scope=${scopeRaw}（可用：${SCOPE_LEVELS.join(' | ')}）。${usage}` };
            }
            // `--all` 是「无条件全删」，与其它条件混用只会让人误判删除范围 —— 直接拒绝，不猜意图。
            if (all && (kindRaw !== undefined || scopeRaw !== undefined)) {
                return { kind: 'error', text: `--all 不能与 --kind/--scope 同时使用（前者是全部，后者是筛选）。${usage}` };
            }
            if (!confirmed)
                return { kind: 'error', text: '这是不可逆操作，请加 --yes 确认。' };
            const kind = kindRaw;
            const scope = scopeRaw;
            // 多条件 **AND**（旧实现是 OR：`--kind=a --scope=b` 会删掉「所有 a」加上「所有 b」）。
            const victims = [...state.records.values()].filter((record) => (all || (kind !== undefined && record.kind === kind)) && (scope === undefined || record.scope.level === scope));
            if (victims.length === 0)
                return { kind: 'success', text: '没有匹配的记忆，未删除任何条目。' };
            let deleted = 0;
            let failed = 0;
            for (const victim of victims) {
                if (await remove(victim.id))
                    deleted += 1;
                else
                    failed += 1;
            }
            state.writes.deleted += deleted;
            flush();
            // 失败条数如实汇报：落盘失败的条目重启后仍在，不能笼统说「已永久删除」。
            if (failed > 0) {
                return {
                    kind: 'error',
                    text: `已永久删除 ${deleted} 条；${failed} 条落盘失败（${state.openError ?? '未知错误'}），重启后仍在。`,
                };
            }
            return { kind: 'success', text: `已永久删除 ${deleted} 条记忆（不可恢复）。` };
        },
        async import(args) {
            const path = args[0];
            if (!path)
                return { kind: 'error', text: '用法：/memory import <导出文件路径>' };
            try {
                const doc = JSON.parse(readFileSync(path, 'utf8'));
                const items = Array.isArray(doc?.items) ? doc.items : [];
                let created = 0;
                let skipped = 0;
                let invalid = 0;
                for (const item of items) {
                    const row = item;
                    if (!row || typeof row !== 'object') {
                        invalid += 1;
                        continue;
                    }
                    // 导入的是**数据副本**，不是用户当场的要求：所有来源/身份字段一律降级或校验，
                    // 否则文件里一行 `origin: "user_explicit"` 就能铸造出「用户侧」条目，冲突时永不被推翻。
                    if (!isMemoryKind(row.kind) || typeof row.text !== 'string' || row.text.trim().length === 0) {
                        invalid += 1;
                        continue;
                    }
                    let scope;
                    if (row.scope === undefined || row.scope === null) {
                        const level = defaultScopeFor(row.kind);
                        scope = { level, key: '*' };
                    }
                    else {
                        const raw = row.scope;
                        if (typeof raw !== 'object' || !isScopeLevel(raw.level)) {
                            invalid += 1;
                            continue;
                        }
                        scope = { level: raw.level, key: typeof raw.key === 'string' ? raw.key : '*' };
                    }
                    const result = await writeMemory({
                        kind: row.kind,
                        text: row.text,
                        subject: typeof row.subject === 'string' ? row.subject : null,
                        field: typeof row.field === 'string' ? row.field : null,
                        value: typeof row.value === 'string' ? row.value : null,
                        tags: Array.isArray(row.tags) ? row.tags.filter((tag) => typeof tag === 'string') : [],
                        scope,
                        // origin 一律 observed；pinned 一律 false（导入的 pinned 会永久免疫衰减与归档）。
                        origin: 'observed',
                        confidence: clamp01(row.confidence),
                        importance: clamp01(row.importance),
                        pinned: false,
                    });
                    if (result.ok && result.status === 'created')
                        created += 1;
                    else
                        skipped += 1;
                }
                return {
                    kind: 'success',
                    text: `导入完成：新建 ${created} 条，跳过/合并 ${skipped} 条，非法条目 ${invalid} 条（文件 ${path}）。`
                        + '导入条目按 observed 处理：origin 一律降级、pinned 强制关闭、confidence/importance 夹到 [0,1]，不会获得用户侧身份。',
                };
            }
            catch (error) {
                return { kind: 'error', text: `导入失败：${errorText(error)}` };
            }
        },
        stats() {
            const byKind = {};
            for (const record of state.records.values())
                byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
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
                        + `；反思提醒 ${state.self.reflections} 次（最近回合 ${state.self.lastReflectTurn ?? '-'}）`
                        + `；初次设定已问 ${state.self.introAsks} 次`,
                    `梳理（/sleep）：运行 ${state.sleep.runs} 次（补录 ${state.sleep.added} / 合并 ${state.sleep.merged} / 失效 ${state.sleep.invalidated}`
                        + ` / 归档 ${state.sleep.archived} / 印象 ${state.sleep.gists} / 跳过 ${state.sleep.skipped}）`
                        + (state.sleep.last
                            ? `；最近 ${state.sleep.last.at}（${state.sleep.last.sessions} 会话 / ${state.sleep.last.messages} 消息 / ${state.sleep.last.chars} 字符）`
                            : '；尚未运行'),
                    `turn-stopping：plain=${state.turnStopping.plain}${state.turnStopping.last ? `，last=${state.turnStopping.last.at}（${state.turnStopping.last.channel}）` : '，last=none'}`,
                    `设置页：${settingsLine()}`,
                ].join('\n'),
            };
        },
        async consolidate() {
            await consolidate('manual');
            const last = state.consolidate.last ?? {};
            return {
                kind: 'success',
                text: `整合完成：合并 ${last.merged ?? 0}，冲突失效 ${last.invalidated ?? 0}，归档 ${last.archived ?? 0}，摘要 ${last.summarized ?? 0}，耗时 ${last.ms ?? 0}ms${last.error ? `（错误：${last.error}）` : ''}`,
            };
        },
        /**
         * `/memory self …`（契约 §4.3）：自画像的查看/设定/修订历史/重置。
         * 全部中文输出；`set` 走 `writeMemory`（因此同样经过自画像收敛与用户所有物保护）。
         */
        async self(args) {
            const SELF_USAGE = '用法：/memory self [list] | self set <persona|work> [<命名key>] <正文>'
                + ' | self history [subject] | self reset [persona|work]'
                + '（命名 key 仅 persona 可用：name / address_user / address_self）';
            const sub = (args[0] ?? 'list').toLowerCase();
            // 自画像条目：kind=agent_self，facet 走 facetOf（无 facet 的存量条目按 'work'）
            const portraitRows = (facet, status = 'active') => [...state.records.values()]
                .filter((record) => record.kind === 'agent_self' && record.status === status)
                .filter((record) => (facet ? facetOf(record) === facet : true))
                .sort(compareRecords);
            const line = (record) => `${record.id.slice(0, 8)}  ${record.origin.padEnd(15)}${record.pinned ? '★' : ' '} conf=${record.confidence.toFixed(2)}  ${clampText(record.text, cfg.maxItemTokens, cfg.charsPerToken)}`;
            if (sub === 'list' || sub === '' || args.length === 0) {
                const persona = portraitRows('persona');
                const work = portraitRows('work');
                const archived = [...state.records.values()].filter((record) => record.kind === 'agent_self' && record.status !== 'active').length;
                // M7：还没定称呼时给一行提示（怎么让模型问、或自己直接设定）
                const namingHint = namingSettled(state.records.values())
                    ? ''
                    : '\n（称呼还没定：等模型问，或自己设定 —— '
                        + '/memory self set persona name 我叫小忆 ｜ address_user 我称呼你为「…」｜ address_self 用户叫我「…」。）';
                if (persona.length === 0 && work.length === 0) {
                    return {
                        kind: 'success',
                        text: '自画像为空。\n'
                            + '模型可以随时用 memory_write（kind=agent_self, facet=persona|work）记录对自己的认识；\n'
                            + '你也可以直接设定：/memory self set persona <正文>（带命名 key 可定称呼，见下）。'
                            + namingHint
                            + (archived > 0 ? `\n（另有 ${archived} 条已归档，用 /memory self history 查看修订链。）` : ''),
                    };
                }
                const block = (title, rows) => `[${title}]${rows.length === 0 ? '（空）' : ` ${rows.length} 条`}\n${rows.map(line).join('\n')}`;
                return {
                    kind: 'success',
                    text: [
                        block('人格 · 模型对自身的认知', persona),
                        block('工作倾向', work),
                        namingHint.trim(),
                        archived > 0 ? `（另有 ${archived} 条已归档：/memory self history）` : '',
                    ].filter(Boolean).join('\n'),
                };
            }
            if (sub === 'set') {
                const facetRaw = (args[1] ?? '').toLowerCase();
                if (facetRaw !== 'persona' && facetRaw !== 'work') {
                    return { kind: 'error', text: `facet 只能是 persona 或 work。${SELF_USAGE}` };
                }
                const facet = facetRaw;
                // M7：persona 可以带一个**命名 key**，用来直接定称呼：
                //   /memory self set persona name 我叫小忆
                //   /memory self set persona address_user 我称呼你为「老板」
                //   /memory self set persona address_self 用户叫我「忆」
                // 只有「首词是已知命名 key 且后面还有正文」才当作 key —— 否则整段都是正文
                // （向后兼容：/memory self set persona 我重视把事实和推测分开说 仍写 self.persona.general）。
                let rest = args.slice(2);
                let subject = portraitSubjectFor(facet, 'general');
                const head = String(rest[0] ?? '').toLowerCase();
                if (facet === 'persona' && rest.length >= 2 && NAMING_KEYS.has(head)) {
                    subject = portraitSubjectFor('persona', head);
                    rest = rest.slice(1);
                }
                const text = rest.join(' ').trim();
                if (text.length === 0)
                    return { kind: 'error', text: `缺少正文。${SELF_USAGE}` };
                // 用户直接设定：origin/pinned/confidence 按契约 §4.3 固定；收敛仍交给 planPortraitUpdate
                // （用户侧可以覆盖用户侧；模型侧条目会被这次设定 refine/supersede）。
                const result = await writeMemory({
                    kind: 'agent_self',
                    text,
                    facet,
                    subject,
                    origin: 'user_explicit',
                    pinned: true,
                    confidence: 1,
                    importance: 0.9,
                    tags: ['self-portrait', 'user-set'],
                });
                if (!result.ok)
                    return { kind: 'error', text: `未写入自画像：${result.error ?? '未知原因'}` };
                const action = result.portrait
                    ? `（${result.portrait.action}: ${result.portrait.reason}）`
                    : '';
                const naming = NAMING_KEYS.has(head) && facet === 'persona' && subject !== portraitSubjectFor(facet, 'general')
                    ? '\n称呼已定，之后不会再问。'
                    : '';
                return {
                    kind: 'success',
                    text: (result.status === 'merged'
                        ? `已更新既有自画像条目 ${String(result.id).slice(0, 8)}${action}`
                        : `已写入自画像（${subject}）${String(result.id).slice(0, 8)}${action}`)
                        + `\n${result.record?.text ?? text}${naming}`,
                };
            }
            if (sub === 'history') {
                const filter = (args[1] ?? '').trim().toLowerCase();
                let revisions;
                try {
                    revisions = portraitHistory(state.records.values());
                }
                catch (error) {
                    return { kind: 'error', text: `读取修订链失败：${errorText(error)}` };
                }
                const matched = filter.length === 0
                    ? revisions
                    : revisions.filter((revision) => revision.subject.toLowerCase().includes(filter));
                if (matched.length === 0) {
                    return { kind: 'success', text: filter.length === 0 ? '自画像还没有修订记录。' : `没有匹配「${filter}」的自画像修订链。` };
                }
                const blocks = matched.map((revision) => {
                    const lines = revision.chain.map((record, index) => {
                        // 归档时间：优先取「取代它的那条新记录」的 observedAt（真正发生取代的时刻），
                        // 其次 invalidAt；两者都没有（如 /memory self reset 直接归档）时标注为未知。
                        const successor = revision.chain.slice(index + 1).find((next) => (next.supersedes ?? []).includes(record.id));
                        const archivedAt = record.status === 'archived'
                            ? (successor ? new Date(successor.observedAt).toISOString() : (record.invalidAt ? new Date(record.invalidAt).toISOString() : null))
                            : null;
                        const when = new Date(record.observedAt).toISOString();
                        const flag = record.status === 'archived' ? ` [archived${archivedAt ? ` @ ${archivedAt}` : ''}]` : '';
                        return `${index === revision.chain.length - 1 ? '→' : ' '} ${record.id.slice(0, 8)}  ${when}  ${record.origin}${flag}  ${clampText(record.text, cfg.maxItemTokens, cfg.charsPerToken)}`;
                    });
                    return `[${revision.subject} · ${revision.facet}]\n${lines.join('\n')}`;
                });
                return { kind: 'success', text: `共 ${matched.length} 条修订链（旧 → 新）：\n${blocks.join('\n')}` };
            }
            if (sub === 'reset') {
                const facetRaw = (args[1] ?? '').toLowerCase();
                if (facetRaw !== '' && facetRaw !== 'persona' && facetRaw !== 'work') {
                    return { kind: 'error', text: `facet 只能是 persona 或 work（省略则重置全部）。${SELF_USAGE}` };
                }
                const facet = facetRaw === '' ? undefined : facetRaw;
                const victims = portraitRows(facet);
                if (victims.length === 0)
                    return { kind: 'success', text: '没有需要重置的自画像条目。' };
                let archived = 0;
                for (const record of victims) {
                    // 归档而非删除：历史与检索都还在（契约 §4.3）。
                    record.status = 'archived';
                    await persist(record);
                    archived += 1;
                }
                flush();
                return {
                    kind: 'success',
                    text: `已重置${facet ? `（${facet}）` : ''} ${archived} 条自画像：条目已归档、历史保留。`
                        + '\n模型后续写入会重新开始（/memory self history 仍可查看旧条目）。',
                };
            }
            return { kind: 'error', text: `未知的 self 子命令「${sub}」。${SELF_USAGE}` };
        },
        help() {
            return { kind: 'success', text: '用法：/memory list [--kind=agent_self] | search <关键词> | show <id> | forget <id> | restore <id> | pin <id> | archive <id> | refresh <id> | confirm <id> | reject <id> | export [path] | import <path> | clear --all --yes | clear --kind=<kind> [--scope=<level>] --yes | self [list] | self set <persona|work> <正文> | self history [subject] | self reset [persona|work] | consolidate | stats | help' };
        },
    };
    // ---------------- M8：`/sleep` 空闲梳理（契约 docs/sleep.md §5/§6） ----------------
    //
    // 与 `/memory consolidate` 的分工：consolidate 做**库内治理**，`/sleep` 做**跨库 + 跨会话**的梳理 ——
    // 回看最近若干会话的完整事件日志，补上当时漏掉/被节流掉的记忆，再把整个库重新排一遍。
    // 数据源是宿主服务 `ctx.sessionQuery`（实测契约见 §3），不是手工解会话日志文件。
    //
    // 三条不可妥协的性质（§6）：
    //   1) 默认不写：没有 `--apply` 就绝不落盘（连计数都不动）；
    //   2) 有备份才改：`--apply` 的**第一件事**是导出备份，备份失败即中止；
    //   3) 不碰自画像、不碰用户所有物：计划层已保证不该出现，宿主侧仍然逐条防御并如实汇报。
    /**
     * 契约 §4.1 默认值的宿主侧兜底：`cfg` 里这些键缺失/非法时（patch 行给错类型、中间修订）
     * 用契约默认值。口径与 lib.ts 的 `sleepCap` / `sleepBudget` **逐条对齐**，否则宿主会把
     * 用户显式设的 `sleepMaxBackfill: 0`（= 不补录）悄悄改成 20 —— 那是「配置说别写、插件照写」。
     */
    const sleepLimits = () => {
        // 计数型上限：允许 0（= 关闭该项），NaN/负数回落默认值
        const cap = (value, fallback) => typeof value === 'number' && !Number.isNaN(value) && value >= 0 ? value : fallback;
        // 预算型上限：必须是正数（0 会把所有会话裁空）
        const budget = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
        return {
            ...cfg,
            sleepEnabled: cfg.sleepEnabled !== false,
            sleepSessions: cap(cfg.sleepSessions, 3),
            sleepMaxCharsPerSession: budget(cfg.sleepMaxCharsPerSession, 120_000),
            sleepMaxCharsTotal: budget(cfg.sleepMaxCharsTotal, 300_000),
            sleepMaxBackfill: cap(cfg.sleepMaxBackfill, 20),
            sleepAssistantContext: cap(cfg.sleepAssistantContext, 3),
            sleepMaxGists: cap(cfg.sleepMaxGists, 8),
        };
    };
    /** 解析 `/sleep` 的输入：只认契约 §2 的三个开关，未知参数忽略；会话数夹进硬上限 20。 */
    const parseSleepInput = (rawInput) => {
        const parts = String(rawInput ?? '').trim().split(/\s+/u).filter(Boolean);
        const raw = parts.find((part) => part.startsWith('--sessions='))?.slice('--sessions='.length);
        const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
        // 至少要回看 1 个会话：0 个会话的 /sleep 没有意义（库内治理请用 /memory consolidate）。
        const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : Math.max(1, sleepLimits().sleepSessions);
        return {
            apply: parts.includes('--apply'),
            all: parts.includes('--all'),
            sessions: Math.max(1, Math.min(SLEEP_MAX_SESSIONS, requested)),
            capped: requested > SLEEP_MAX_SESSIONS,
        };
    };
    /**
     * 列出候选会话并逐个读完整事件日志。
     * 默认按 cwd 过滤（cwd 取「最近一个非 subagent 会话」的 header，避免把别的项目的事混进来）；
     * `--all` 用 `listSessions()`。子代理会话一律跳过（§3：它们的「用户消息」是父代理的指令）。
     */
    const collectSleepSources = async (sq, request) => {
        const notes = [];
        const listed = await sq.listSessions();
        const sorted = (Array.isArray(listed) ? [...listed] : [])
            .filter((record) => record !== null && typeof record === 'object')
            .sort((a, b) => Number(b?.header?.createdAt ?? 0) - Number(a?.header?.createdAt ?? 0));
        // cwd 取最近一个**非 subagent** 会话：子代理的 cwd 不是用户的工作目录。
        const anchor = sorted.find((record) => record?.header?.origin !== 'subagent');
        const cwd = anchor?.header?.cwd ?? null;
        let candidates = sorted;
        if (!request.all) {
            if (!cwd) {
                notes.push('最近会话没有 cwd，无法按项目过滤：本次按全部会话处理。');
            }
            else {
                try {
                    const filtered = await sq.filterSessions([{ kind: 'cwd', values: [cwd] }]);
                    candidates = Array.isArray(filtered) ? [...filtered] : [];
                    if (candidates.length === 0) {
                        notes.push(`按 cwd（${cwd}）过滤后没有会话：本次按全部会话处理。`);
                        candidates = sorted;
                    }
                }
                catch (error) {
                    notes.push(`filterSessions 失败（${errorText(error)}）：降级为在 listSessions 结果里按 cwd 手工过滤。`);
                    candidates = sorted.filter((record) => (record?.header?.cwd ?? null) === cwd);
                }
            }
        }
        const roots = candidates.filter((record) => record?.header?.origin !== 'subagent');
        const skippedSubagents = candidates.length - roots.length;
        const picked = [...roots]
            .sort((a, b) => Number(b?.header?.createdAt ?? 0) - Number(a?.header?.createdAt ?? 0))
            .slice(0, request.sessions);
        const sources = [];
        for (const record of picked) {
            const id = String(record?.header?.id ?? '');
            if (id === '')
                continue;
            try {
                const snapshot = await sq.readSession(id);
                // inheritedEventCount 与本次梳理无关（§3）：只看 events。
                // origin/parentSession 一并透传：纯函数层还会再挡一次子代理会话（防御性重复无害）。
                sources.push({
                    sessionId: id,
                    cwd: snapshot?.session?.cwd ?? record?.header?.cwd ?? null,
                    createdAt: Number(snapshot?.session?.createdAt ?? record?.header?.createdAt ?? 0),
                    events: Array.isArray(snapshot?.events) ? snapshot.events : [],
                    origin: record?.header?.origin ?? null,
                    parentSession: record?.header?.parentSession ?? null,
                });
            }
            catch (error) {
                notes.push(`读取会话 ${id} 失败，已跳过：${errorText(error)}`);
            }
        }
        return { sources, notes, skippedSubagents };
    };
    /**
     * 一条不愿被 `/sleep` 改写的既有条目（§6）：自画像是模型的自我认知（规则不能替它下结论），
     * 用户所有物（`pinned`）由用户掌控。返回原因文本（`null` = 可以动），用于如实汇报。
     */
    const sleepImmutableReason = (record) => {
        if (!record)
            return '目标不存在';
        if (record.kind === 'agent_self')
            return '自画像（agent_self）';
        if (record.pinned === true)
            return '用户固定的条目（pinned）';
        return null;
    };
    /**
     * 把 `SleepCandidate` 变成 `writeMemory` 的入参。
     *
     * 契约里的 `SleepCandidate` 只有 text/scope/origin/confidence/hash（没有 kind/subject），
     * 但 `writeMemory` 必须有 kind，而 `recordHash` 又含 kind/subject —— 猜错会让「重复执行」不再幂等。
     * 取值顺序：候选自带的 kind/subject（lib 若保留就最准）→ 库内同 hash 的既有条目 → 按 scope 兜底。
     */
    const sleepBackfillInput = (candidate) => {
        const view = candidate;
        const text = String(view?.text ?? '');
        if (text.trim().length === 0)
            return null;
        const level = view?.scope?.level === 'profile' ? 'profile' : 'workspace';
        const key = typeof view?.scope?.key === 'string' && view.scope.key.length > 0 ? view.scope.key : '*';
        const twin = [...state.records.values()].find((record) => record.hash === view?.hash);
        const kind = isMemoryKind(view?.kind) ? view.kind : (twin?.kind ?? (level === 'profile' ? 'user_profile' : 'semantic'));
        const subject = typeof view?.subject === 'string' ? view.subject : (twin?.subject ?? null);
        return { kind, scope: { level, key }, subject, text };
    };
    /** 补录的幂等防线（与 `writeMemory` 的 hash 去重互为兜底）：同 scope 下已有同文本，或该指纹已在库里（含 archived）。 */
    const sleepAlreadyPresent = (input) => {
        const hash = recordHash({ kind: input.kind, scope: input.scope, subject: input.subject, text: input.text });
        const normalized = normalizeText(input.text);
        return [...state.records.values()].some((record) => record.hash === hash
            || (record.scope.level === input.scope.level && record.scope.key === input.scope.key && normalizeText(record.text) === normalized));
    };
    /** 执行计划（调用前已确认：备份成功、领域已打开）。返回本次计数。 */
    const executeSleepPlan = async (plan, now, notes) => {
        const counts = { added: 0, merged: 0, invalidated: 0, archived: 0, gists: 0, skipped: 0 };
        // 1) 补录：走 writeMemory（敏感扫描 / 回声剔除 / 指纹去重都在里面），origin 用候选的来源。
        for (const candidate of plan.backfill ?? []) {
            const input = sleepBackfillInput(candidate);
            if (!input) {
                counts.skipped += 1;
                continue;
            }
            if (input.kind === 'agent_self') {
                counts.skipped += 1;
                notes.push('跳过 1 条补录：候选是 agent_self，而 /sleep 不生成任何自画像写入（§6）。');
                continue;
            }
            if (sleepAlreadyPresent(input)) {
                counts.skipped += 1;
                continue;
            }
            const result = await writeMemory({
                kind: input.kind,
                text: input.text,
                subject: input.subject,
                scope: input.scope,
                origin: candidate.origin,
                confidence: candidate.confidence,
                tags: ['sleep'],
                sessionId: candidate.sessionId,
                source: candidate.sessionId ? { sessionId: candidate.sessionId, seqStart: 0, seqEnd: 0 } : null,
            });
            if (result.ok && result.status === 'created')
                counts.added += 1;
            else if (result.ok)
                counts.skipped += 1; // 合并进既有条目（指纹命中）：不算新增
            else {
                counts.skipped += 1;
                notes.push(`跳过 1 条补录：${result.error ?? '写入失败'}`);
            }
        }
        // 2) 合并：复用整合的合并路径（领头者吸收计数，其余归档不删；不动 pinned 与自画像）。
        for (const merge of plan.merges ?? []) {
            const members = (merge?.ids ?? [])
                .map((id) => state.records.get(String(id)))
                .filter((record) => Boolean(record));
            if (members.length < 2) {
                counts.skipped += 1;
                continue;
            }
            const blocked = members
                .map((record) => ({ record, reason: sleepImmutableReason(record) }))
                .find((entry) => entry.reason !== null);
            if (blocked) {
                counts.skipped += 1;
                notes.push(`跳过 1 组合并（${merge.subject || '未命名主题'}）：成员 ${blocked.record.id.slice(0, 8)} 不可动 —— ${blocked.reason}。`);
                continue;
            }
            const [lead, ...rest] = members;
            for (const extra of rest) {
                lead.useCount = (lead.useCount ?? 0) + (extra.useCount ?? 0);
                lead.importance = Math.max(lead.importance, extra.importance);
                lead.confidence = Math.max(lead.confidence, extra.confidence);
                lead.observedAt = Math.max(lead.observedAt, extra.observedAt);
                extra.status = 'archived';
                await persist(extra);
                counts.merged += 1;
            }
            await persist(lead);
        }
        // 3) 冲突：旧条目置 invalid（可恢复）、新条目记 supersedes。
        //    §6：不允许把**用户侧**条目判成 drop —— 计划里出现就必须标注并跳过。
        for (const conflict of plan.conflicts ?? []) {
            const keep = state.records.get(String(conflict?.keep ?? ''));
            const drop = state.records.get(String(conflict?.drop ?? ''));
            const reason = sleepImmutableReason(drop)
                ?? (keep && drop && isUserSideOrigin(drop.origin) && !isUserSideOrigin(keep.origin) ? '用户侧条目不允许被自动推翻（§6）' : null);
            if (!keep || !drop || reason) {
                counts.skipped += 1;
                notes.push(`跳过 1 条失效（${conflict?.subject || '未命名主题'}）：${reason ?? '保留方不存在'}。`);
                continue;
            }
            drop.status = 'invalid';
            drop.invalidAt = now;
            keep.supersedes = [...new Set([...(keep.supersedes ?? []), drop.id])];
            await persist(drop);
            await persist(keep);
            counts.invalidated += 1;
        }
        // 4) 归档（shouldArchive 已排除 pinned 与自画像，这里再防一层）。
        for (const id of plan.archive ?? []) {
            const record = state.records.get(String(id ?? ''));
            if (!record) {
                counts.skipped += 1;
                continue;
            }
            const reason = sleepImmutableReason(record);
            if (reason) {
                counts.skipped += 1;
                notes.push(`跳过 1 条归档（${record.id.slice(0, 8)}）：${reason}。`);
                continue;
            }
            if (record.status === 'archived')
                continue;
            record.status = 'archived';
            await persist(record);
            counts.archived += 1;
        }
        // 5) 项目印象：同 workspace 只刷新不新增（与捕获路径同一策略）。
        for (const gist of plan.gists ?? []) {
            const text = String(gist?.text ?? '').trim();
            const key = typeof gist?.key === 'string' && gist.key.length > 0 ? gist.key : '*';
            if (text.length === 0) {
                counts.skipped += 1;
                continue;
            }
            const existing = [...state.records.values()].find((record) => record.kind === 'project_gist' && record.status === 'active'
                && record.scope.key === key && record.subject === 'project.overview');
            if (existing) {
                existing.text = text;
                existing.observedAt = now;
                existing.hash = recordHash(existing);
                existing.confidence = Math.min(0.6, (existing.confidence ?? 0.5) + 0.05);
                await persist(existing);
                counts.gists += 1;
                continue;
            }
            const result = await writeMemory({
                kind: 'project_gist',
                precision: 'gist',
                text,
                subject: 'project.overview',
                origin: 'observed',
                confidence: 0.5,
                importance: 0.5,
                tags: ['gist', 'sleep'],
                scope: { level: 'workspace', key },
            });
            if (result.ok)
                counts.gists += 1;
            else {
                counts.skipped += 1;
                notes.push(`项目印象未写入（${key}）：${result.error ?? '未知原因'}`);
            }
        }
        return counts;
    };
    /** `/sleep` 的完整流程：解析 → 取服务 → 读会话 → 纯函数计划 → 预览 / 落盘。**绝不抛**。 */
    const runSleep = async (rawInput) => {
        const request = parseSleepInput(rawInput);
        const limits = sleepLimits();
        // §5.5：/sleep 是用户显式触发的维护动作，与 recallMode / autoRecall 无关；只受 sleepEnabled 约束。
        if (limits.sleepEnabled === false) {
            return { kind: 'error', text: '`/sleep` 已在配置里关闭（sleepEnabled=false）：本次不做任何事。开启后可随时重跑；`/memory consolidate` 仍可用。' };
        }
        const sq = ctx.get('sessionQuery');
        if (!sq || typeof sq.listSessions !== 'function' || typeof sq.readSession !== 'function') {
            return {
                kind: 'error',
                text: '当前宿主没有 sessionQuery 服务，`/sleep` 需要它读取会话记录（DSH 的日志是多 zstd 帧拼接，不能手工解）；'
                    + '/memory consolidate 仍可用（库内治理不依赖会话日志）。',
            };
        }
        if (request.apply && !state.opened) {
            return { kind: 'error', text: `记忆领域未打开（${state.openError ?? '未知原因'}），无法落盘：已中止 --apply（没有备份就不改库）。` };
        }
        const collected = await collectSleepSources(sq, request);
        const transcript = transcriptOf(collected.sources, limits);
        const plan = buildSleepPlan({
            records: state.records.values(),
            sources: transcript.sources,
            cfg: limits,
            // 会话整体级说明（预算超限 / 跳过的子代理会话）透传给计划，由 formatSleepPlan 统一渲染。
            notes: transcript.notes,
            skippedSubagents: collected.skippedSubagents,
        });
        const snapshot = {
            at: new Date().toISOString(),
            sessions: plan.scanned.sessions,
            messages: plan.scanned.messages,
            chars: plan.scanned.chars,
        };
        // 只有宿主自己才知道的说明（纯函数层看不到 --sessions 这个开关）。
        const notes = [...collected.notes];
        if (request.capped) {
            notes.push(`会话数上限 ${SLEEP_MAX_SESSIONS}：本次只回看最近 ${request.sessions} 个（请求更多也只到这里）。`);
        }
        if (!request.apply) {
            // 预览：只读、只算，零写入 —— 连 state.sleep 计数都不动（§6：没有 --apply 就绝不落盘）。
            // 直接返回纯函数层的预览文本（它已声明「未写入任何内容」）；宿主自己的说明放在它之前，
            // 让「未写入」这句始终是最后一行。
            return { kind: 'success', text: [...notes, formatSleepPlan(plan, limits)].filter((line) => line.length > 0).join('\n') };
        }
        // a) 先备份：`--apply` 的**第一件事**；失败即中止（没有备份就不改库）。
        let backupFile = '';
        try {
            const stamp = new Date().toISOString().replace(/[:.]/gu, '-'); // 冒号在 Windows 路径里非法
            backupFile = exportRecords(`sleep-backup-${stamp}.json`);
            if (!existsSync(backupFile) || statSync(backupFile).size <= 0)
                throw new Error('备份文件不存在或为空');
        }
        catch (error) {
            return { kind: 'error', text: `导出备份失败，已中止 --apply（没有备份就不改库）：${errorText(error)}` };
        }
        // b) 按计划落盘；c) 计数与水位；d) flush 后回报统计。
        const now = Date.now();
        const counts = await executeSleepPlan(plan, now, notes);
        state.sleep.runs += 1;
        state.sleep.added += counts.added;
        state.sleep.merged += counts.merged;
        state.sleep.invalidated += counts.invalidated;
        state.sleep.archived += counts.archived;
        state.sleep.gists += counts.gists;
        state.sleep.skipped += counts.skipped;
        state.sleep.last = snapshot;
        if (domain) {
            state.meta = {
                ...(state.meta ?? {}),
                schemaVersion: 1,
                collectionVersion: state.collectionVersion,
                lastSleepAt: now,
                selfIntroAsks: state.self.introAsks,
            };
            try {
                await domain.global.set(state.meta);
            }
            catch { /* 水位写失败不影响本次梳理结果 */ }
        }
        flush();
        return {
            kind: 'success',
            text: [
                `梳理完成（/sleep --apply）：补录 ${counts.added} 条，合并 ${counts.merged} 条，失效 ${counts.invalidated} 条，`
                    + `归档 ${counts.archived} 条，项目印象 ${counts.gists} 条，跳过 ${counts.skipped} 条。`,
                `回看：会话 ${snapshot.sessions} 个 / 消息 ${snapshot.messages} 条 / ${snapshot.chars} 字符`,
                `备份：${backupFile}`,
                sleepPlanIsEmpty(plan) ? '计划为空：本次无需改动。' : '',
                ...notes,
            ].filter((line) => line.length > 0).join('\n'),
        };
    };
    try {
        ctx.commands.register({
            name: 'memory',
            description: '查看与管理长期记忆',
            input: { hint: 'list | show <id> | self | forget <id> | export | stats' },
            handler: async (invocation) => {
                const parts = String(invocation?.rawInput ?? '').trim().split(/\s+/u).filter(Boolean);
                const sub = parts.shift() ?? 'list';
                const handler = handlers[sub] ?? handlers.help;
                try {
                    return await handler(parts);
                }
                catch (error) {
                    return { kind: 'error', text: `记忆命令失败：${errorText(error)}` };
                }
            },
        });
    }
    catch (error) {
        state.openError = `command register failed: ${errorText(error)}`;
    }
    // `/sleep` 是**独立命令**（用户明确要的是 /sleep，不是 /memory 的子命令，见契约 §5.1）。
    // 整条命令包在 try/catch 里：任何异常都必须变成可读的 error 结果，不能抛给宿主（§5.3）。
    try {
        ctx.commands.register({
            name: 'sleep',
            description: '空闲梳理：回看最近会话补录漏掉的记忆，并重新排一遍整个库（默认只预览；--apply 才落盘，且先导出备份）',
            input: { hint: '[--apply] [--sessions=N] [--all]' },
            handler: async (invocation) => {
                try {
                    return await runSleep(String(invocation?.rawInput ?? ''));
                }
                catch (error) {
                    return { kind: 'error', text: `梳理命令失败：${errorText(error)}` };
                }
            },
        });
    }
    catch (error) {
        state.openError = `sleep command register failed: ${errorText(error)}`;
    }
    // 供其他插件/调试使用的最小服务面（不导出类型，M4 再考虑正式 seam）
    try {
        ;
        ctx.provide('memory', {
            list: () => [...state.records.values()],
            stats: () => ({ records: state.records.size, version: state.collectionVersion, opened: state.opened }),
            recall: (options) => recallRecords(state.records.values(), options),
            write: (input) => writeMemory(input),
            consolidate: (reason) => consolidate(reason ?? 'manual'),
        });
    }
    catch { /* 可选 */ }
    // 打开领域；随后按需补跑一次整合（此处调用保证 consolidate 已定义）。
    void openDomain().then(() => {
        try {
            if (!state.opened || cfg.consolidateEnabled === false)
                return;
            const lastAt = state.meta?.lastConsolidatedAt ?? 0;
            const intervalMs = Math.max(1, cfg.consolidateIntervalMinutes ?? 30) * 60_000;
            if (Date.now() - lastAt > intervalMs)
                void consolidate('startup');
        }
        catch { /* ignore */ }
    }).catch(() => { });
    flush();
}
//# sourceMappingURL=index.js.map
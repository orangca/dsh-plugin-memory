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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DEFAULTS, clampText, composeGistText, composeSubjectSummary, compareRecords, defaultScopeFor, deriveSubject, detectWorkspaceMarkers, deriveOriginFromMessages, effectiveImportance, estimateTokens, extractCandidates, extractSummaryText, fillWithinBudget, findConflicts, fnv1a, isEcho, isExcluded, listActive, makeRecord, maskPii, pickMergeGroups, recallRecords, recordHash, renderContextBlock, renderSelfBlock, scanSensitive, shouldArchive, splitSentences, workspaceKeyOf, } from './lib.js';
let Schema = null;
try {
    Schema = (await import('@deepseek-ai/schemastery')).default ?? null;
}
catch {
    Schema = null;
}
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
        rejectedHashes: new Set(),
        recall: { injected: 0, turns: 0, last: null },
        recallTurnById: new Map(),
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
        domain = null;
        return (async () => {
            // 卸载前把内存里累加的用量落盘（best-effort），再释放领域句柄。
            try {
                await flushUsage();
            }
            catch { /* 落盘失败不阻塞卸载 */ }
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
    const remove = async (id) => {
        if (!state.opened)
            return false;
        const existed = state.records.delete(id);
        if (!existed)
            return false;
        state.collectionVersion += 1;
        try {
            await domain.table('memories').delete(id);
        }
        catch (error) {
            state.openError = `delete failed: ${errorText(error)}`;
        }
        return true;
    };
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
    /** 写入：敏感过滤 → PII 脱敏 → 回声剔除 → hash 去重合并 → 落盘。返回结果对象（供工具与命令共用）。 */
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
        const record = makeRecord({ ...input, kind: input.kind, text, origin });
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
        flush();
        return { ok: true, status: 'created', id: record.id, record };
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
                state.meta = (domain.global.get() ?? null);
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
    /** 一次回合收尾的捕获：规则抽取 → 节流 → 落盘 → 项目印象刷新。任何异常都不得外抛。 */
    const runCapture = async (agent) => {
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
    try {
        ctx.on('agent/pre-step', async (rawPayload, next) => {
            const payload = rawPayload;
            const decision = (await next());
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
                const hits = recallRecords(state.records.values(), {
                    query,
                    mode: 'memory',
                    minHits: cfg.recallMinHits ?? 2,
                    minMatch: cfg.recallMinMatch ?? 0.4,
                    limit: cfg.recallTopK ?? 8,
                })
                    .filter((hit) => hit.record.kind !== 'agent_self')
                    .filter((hit) => hit.record.scope.level !== 'workspace' || hit.record.scope.key === workspaceKey)
                    .filter((hit) => !residentLines.has(hit.record.text.trim()))
                    .filter((hit) => turn - (state.recallTurnById.get(hit.record.id) ?? -999) >= cooldownTurns)
                    .slice(0, cfg.recallTopK ?? 8);
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
                const R2_FOOTER = '以上为历史记录，可能与本轮任务相关；与当前对话冲突时以当前对话为准。';
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
                const cutoff = Math.max(0, state.consolidate.last?.turn ?? 0) - 200;
                for (const [id, turn] of state.recallTurnById)
                    if (turn < cutoff)
                        state.recallTurnById.delete(id);
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
    const json = (value) => JSON.stringify(value, null, 2).slice(0, 8000);
    const toolMessages = (exec) => {
        try {
            return exec?.agent?.session?.deriveMessages?.() ?? [];
        }
        catch {
            return [];
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
                return json({ count: hits.length, items: hits.map(({ record, score }) => ({
                        id: record.id, kind: record.kind, scope: record.scope, origin: record.origin,
                        text: record.text, pinned: record.pinned, score: Number(score.toFixed(3)),
                        observedAt: new Date(record.observedAt).toISOString(),
                    })) });
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
                return json({ count: rows.length, items: rows.map((record) => ({
                        id: record.id, kind: record.kind, status: record.status, origin: record.origin,
                        scope: record.scope, pinned: record.pinned, importance: record.importance, text: record.text,
                    })) });
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
                    await remove(target.id);
                    state.writes.deleted += 1;
                    flush();
                    return json({ ok: true, deleted: [target.id], text: target.text });
                }
                if (args?.query) {
                    // 破坏性操作：词面覆盖率必须 ≥ 0.6，宁可少删不可错删。
                    const hits = recallRecords(state.records.values(), { query: args.query, limit: 20, minLexical: 0.6 }, Date.now());
                    if (!args.confirm) {
                        return json({ ok: false, needsConfirm: true, matches: hits.map(({ record }) => ({ id: record.id, text: record.text })) });
                    }
                    const deleted = [];
                    for (const { record } of hits) {
                        if (await remove(record.id))
                            deleted.push(record.id);
                    }
                    state.writes.deleted += deleted.length;
                    flush();
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
                return json(handlers.stats());
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
                const report0 = { skipped, candidates: candidates.map((candidate) => ({
                        signal: candidate.signal, kind: candidate.kind, origin: candidate.origin,
                        confidence: candidate.confidence, importance: candidate.importance, text: candidate.text,
                    })) };
                if (args?.apply !== true)
                    return json(report0);
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
                    written.push({ ok: result.ok, status: result.status, id: result.id, error: result.error });
                }
                return json({ ...report0, applied: true, written });
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
            await remove(target.id);
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
            const kind = args.find((part) => part.startsWith('--kind='))?.slice(7);
            const scope = args.find((part) => part.startsWith('--scope='))?.slice(8);
            if (!all && !kind && !scope)
                return { kind: 'error', text: '用法：/memory clear --all --yes | --kind=<kind> --yes | --scope=<level> --yes' };
            if (!confirmed)
                return { kind: 'error', text: '这是不可逆操作，请加 --yes 确认。' };
            const victims = [...state.records.values()].filter((record) => all || (kind ? record.kind === kind : false) || (scope ? record.scope.level === scope : false));
            for (const victim of victims)
                await remove(victim.id);
            state.writes.deleted += victims.length;
            flush();
            return { kind: 'success', text: `已永久删除 ${victims.length} 条记忆（不可恢复）。` };
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
                for (const item of items) {
                    const row = item;
                    if (!row || typeof row.kind !== 'string' || typeof row.text !== 'string') {
                        skipped += 1;
                        continue;
                    }
                    const result = await writeMemory({
                        kind: row.kind,
                        text: row.text,
                        subject: row.subject ?? null,
                        field: row.field ?? null,
                        value: row.value ?? null,
                        tags: row.tags ?? [],
                        scope: row.scope,
                        origin: row.origin ?? 'observed',
                        confidence: row.confidence,
                        importance: row.importance,
                        pinned: row.pinned === true,
                    });
                    if (result.ok && result.status === 'created')
                        created += 1;
                    else
                        skipped += 1;
                }
                return { kind: 'success', text: `导入完成：新建 ${created} 条，跳过/合并 ${skipped} 条（文件 ${path}）` };
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
        help() {
            return { kind: 'success', text: '用法：/memory list [--kind=agent_self] | search <关键词> | show <id> | forget <id> | restore <id> | pin <id> | archive <id> | refresh <id> | confirm <id> | reject <id> | export [path] | import <path> | clear --all --yes | consolidate | stats | help' };
        },
    };
    try {
        ctx.commands.register({
            name: 'memory',
            description: '查看与管理长期记忆',
            input: { hint: 'list | show <id> | forget <id> | export | stats' },
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
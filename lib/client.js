window.__ModuleLoader__.load({
  id: "dsh-plugin-memory",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    "use strict";
    // dsh-memory 的浏览器半边：把插件的 volatile Config 渲染成「插件」页里的设置卡片。
    //
    // 为什么必须自己写（实测结论，2026-10-01）：
    //   Host 侧导出 Config + `ctx.settings.configure({auto:true})` 只会让 settings 服务**投影出描述符**
    //   （`describe()` 里能查到我们的 ns，`memory_stats` 显示 ours=true），
    //   但这个客户端构建里**没有任何通用渲染器**消费 `autoGenerate` 去生成表单；
    //   官方每个功能的设置卡片都是各自客户端半边注册进插槽的（见 ui-settings-agent-loop）。
    //   本文件照该模板实现：SettingsFormModel + SettingsForm + SettingsValueField。
    //
    // 格式：本文件只写「模块体」。客户端模块系统要求的 lazy-CJS 外壳
    //   （`window.__ModuleLoader__.load({ id, factory: (require) => {...} })`）
    // 由 tools/build-client.ts 在 tsc（CommonJS）产出 build/client/client.js 之后自动包上，见 lib/client.js。
    // 因此这里正常写 ESM import / export：import 会被编译成 `require(...)`，而 `require` 由外层 factory 提供。
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.inject = exports.NS = void 0;
    exports.apply = apply;
    // 单独编译本文件（`tsc src/client.ts`）时，同目录的 shims.d.ts 不会被自动纳入程序，
    // 显式引用一次，保证 `react/jsx-runtime` 与本插件用到的 primitives 子集有类型；不影响任何产物。
    /// <reference path="./shims.d.ts" />
    const jsx_runtime_1 = require("react/jsx-runtime");
    const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
    /** settings 命名空间 = profile 条目 id（Host 侧 describe() 里的 ns）。 */
    exports.NS = 'dsh-memory';
    /** 本卡片自己的文案字典命名空间。 */
    const DICT = 'dsh-memory.settings';
    const zh = {
        title: '长期记忆',
        description: '本地优先的长期记忆：自动捕获、双通道注入、可解释可删除。',
        groupRecall: '召回与注入',
        groupStore: '记忆库',
        groupCapture: '自动捕获',
        groupConsolidate: '整合治理',
        groupSleep: '空闲梳理（/sleep）',
        overridden: '已覆盖',
        reset: '恢复默认',
        save: '保存',
        saving: '保存中…',
        saveFailed: '本部署没有接受这些值，已保留供你修改。',
        readOnly: '本部署的设置为只读。',
        unavailable: '该插件当前未加载，暂时无法配置。',
        invalidNumber: '请填数字；留空表示使用默认值。',
        invalidValue: '取值不合法，请检查。',
        invalidToggle: '只接受 0 或 1；留空表示使用默认值。',
        required: '必填',
        domainName: '记忆库名',
        maxInjectedTokens: '常驻注入预算（token）',
        maxItemTokens: '单条记忆长度上限',
        selfPortraitMaxTokens: '自画像段预算',
        selfPortraitEnabled: '自画像开关',
        selfPersonaMaxTokens: '人格小节预算（token）',
        selfPortraitMergeThreshold: '自画像收敛阈值',
        selfReflectEnabled: '反思提示开关',
        selfReflectEveryTurns: '反思最小间隔（回合）',
        selfReflectMinTurn: '反思起始回合',
        selfReflectMaxPerSession: '每会话反思上限',
        selfIntroEnabled: '初次设定（称呼）',
        selfIntroMinTurn: '初次设定起始回合',
        selfIntroMaxAsks: '初次设定最多问几次',
        recallMode: '按轮召回模式',
        recallTopK: '每轮召回条数',
        captureMode: '自动捕获',
        captureMaxPerTurn: '每回合最多写入',
        consolidateEnabled: '定时整合',
        consolidateIntervalMinutes: '整合间隔（分钟）',
        sleepEnabled: '空闲梳理开关',
        sleepSessions: '默认回看会话数',
        sleepMaxBackfill: '单次最多补录条数',
        refsEnabled: '来源引用',
        refsMax: '每条最多引用数',
        hintDomainName: '记忆库名（= 落盘目录名）。换成别的名字即启用一个空库，旧库仍留在磁盘上。',
        hintMaxInjectedTokens: '常驻注入的 token 硬上限；块头尾的固定文案也计入。',
        hintMaxItemTokens: '单条记忆注入时的截断长度。',
        hintSelfPortraitMaxTokens: '自画像段的独立预算。',
        hintSelfPortraitEnabled: '0=关、1=开；默认 1（开）。关掉后人格与工作两小节不再常驻注入，已有条目仍可检索。',
        hintSelfPersonaMaxTokens: '「人格」小节的独立 token 预算；默认 80。工作两小节共享上面的「自画像段预算」。',
        hintSelfPortraitMergeThreshold: '0–1，默认 0.6。新认知与同主题旧条目相似度 ≥ 阈值时合并改写；低于阈值视为改主意：旧条目归档留痕、由新条目取代（用户设定的条目模型不可覆盖）。',
        hintSelfReflectEnabled: '0=关、1=开；默认 1（开）。按下面的间隔注入一句低频反思提示，提醒模型自省要不要更新自画像。',
        hintSelfReflectEveryTurns: '两次反思提示之间至少间隔多少回合；默认 12。',
        hintSelfReflectMinTurn: '本会话至少进行到第几回合才允许提醒（太早没有素材）；默认 4。',
        hintSelfReflectMaxPerSession: '每个会话最多提醒几次；默认 3，到达上限后本会话不再提醒。',
        hintSelfIntroEnabled: '0=关、1=开；默认 1（开）。开着时，还没定称呼的话模型会找时机用一句话问你：想给它取什么名字、它该怎么称呼你。',
        hintSelfIntroMinTurn: '本会话至少进行到第几回合才允许问称呼；默认 2（别一上来就查户口）。',
        hintSelfIntroMaxAsks: '跨会话累计最多问几次；默认 2，问满即永久停手。你回复「不用」后模型会记一条「保持默认称呼」，同样不再问。',
        hintRecallMode: 'off=关闭按轮召回；dry=只计算不注入（观察用）；inject=正常注入。注意它不影响常驻注入。',
        hintRecallTopK: '每轮最多召回几条。',
        hintCaptureMode: 'off=停止自动写入（模型工具仍可用）；rule=按规则自动捕获。',
        hintCaptureMaxPerTurn: '每回合最多自动写入几条。',
        hintConsolidateEnabled: '定时整合：合并重复、失效矛盾、衰减归档、规则式摘要。',
        hintConsolidateIntervalMinutes: '整合间隔（分钟）。',
        hintSleepEnabled: '0=关、1=开；默认 1（开）。关掉后 /sleep 只返回一句说明、不做任何事；它不受 recallMode / autoRecall 影响。',
        hintSleepSessions: '不带 --sessions=N 时默认回看最近几个会话；上限 20。',
        hintSleepMaxBackfill: '一次 /sleep --apply 最多补录几条（只补用户明确要求记住的内容）；超出的候选计入计划的 truncated 并写进说明。',
        hintRefsEnabled: '0=关、1=开；默认 1（开）。开着时每条记忆都会记下来源（会话 + 事件序号区间），可用 /memory verify <id> 回到原文核对；关掉后新记录不带引用，已有引用不受影响。',
        hintRefsMax: '每条记录最多保留几个来源引用（默认 5，新的在前）；0 = 不保留引用，Infinity = 不限。',
    };
    const en = {
        title: 'Long-term memory',
        description: 'Local-first long-term memory: automatic capture, dual-channel injection, explainable and deletable.',
        groupRecall: 'Recall & injection',
        groupStore: 'Memory store',
        groupCapture: 'Automatic capture',
        groupConsolidate: 'Consolidation',
        groupSleep: 'Idle review (/sleep)',
        overridden: 'Overridden',
        reset: 'Reset to default',
        save: 'Save',
        saving: 'Saving…',
        saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
        readOnly: 'This deployment stores settings read-only.',
        unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
        invalidNumber: 'Enter a number, or leave blank to use the default.',
        invalidValue: 'Invalid value; please check it.',
        invalidToggle: 'Enter 0 or 1, or leave blank to use the default.',
        required: 'Required',
        domainName: 'Memory store name',
        maxInjectedTokens: 'Resident injection budget (tokens)',
        maxItemTokens: 'Per-memory length cap',
        selfPortraitMaxTokens: 'Self-portrait budget',
        selfPortraitEnabled: 'Self-portrait switch',
        selfPersonaMaxTokens: 'Persona section budget (tokens)',
        selfPortraitMergeThreshold: 'Self-portrait merge threshold',
        selfReflectEnabled: 'Reflection prompt switch',
        selfReflectEveryTurns: 'Reflection interval (turns)',
        selfReflectMinTurn: 'Earliest reflection turn',
        selfReflectMaxPerSession: 'Reflections per session',
        selfIntroEnabled: 'First-run introduction',
        selfIntroMinTurn: 'Introduction earliest turn',
        selfIntroMaxAsks: 'Introduction max asks',
        recallMode: 'Per-turn recall mode',
        recallTopK: 'Recalled per turn',
        captureMode: 'Automatic capture',
        captureMaxPerTurn: 'Writes per turn',
        consolidateEnabled: 'Scheduled consolidation',
        consolidateIntervalMinutes: 'Consolidation interval (min)',
        sleepEnabled: 'Idle review switch',
        sleepSessions: 'Sessions reviewed by default',
        sleepMaxBackfill: 'Backfill cap per run',
        refsEnabled: 'Source references',
        refsMax: 'References per record',
        hintDomainName: 'Memory store name (= on-disk directory). A new name starts an empty store; the old one stays on disk.',
        hintMaxInjectedTokens: 'Hard token cap for resident injection; the fixed block header/footer counts too.',
        hintMaxItemTokens: 'Truncation length for one injected memory.',
        hintSelfPortraitMaxTokens: 'Separate budget for the self-portrait block.',
        hintSelfPortraitEnabled: '0 = off, 1 = on; default 1 (on). When off, neither the persona nor the work sections are injected; existing rows stay searchable.',
        hintSelfPersonaMaxTokens: 'Separate token budget for the persona section; default 80. The two work sections share the self-portrait budget above.',
        hintSelfPortraitMergeThreshold: '0–1, default 0.6. A new insight is merged into the same-subject row when similarity is at or above this threshold; below it the model changed its mind — the old row is archived for the record and superseded (rows the user set are never overwritten by the model).',
        hintSelfReflectEnabled: '0 = off, 1 = on; default 1 (on). Injects one low-frequency reflection prompt at the interval below, inviting the model to reconsider its self-portrait.',
        hintSelfReflectEveryTurns: 'Minimum number of turns between two reflection prompts; default 12.',
        hintSelfReflectMinTurn: 'Earliest session turn that may carry a prompt (too early means nothing to reflect on); default 4.',
        hintSelfReflectMaxPerSession: 'Maximum reflection prompts per session; default 3 — once reached, the session stays quiet.',
        hintSelfIntroEnabled: '0 = off, 1 = on; default 1. While the names are unsettled, the model asks one short question at a natural moment: what to call it, and how it should address you.',
        hintSelfIntroMinTurn: 'Earliest turn in a session at which the naming question may be asked; default 2.',
        hintSelfIntroMaxAsks: 'Total questions across sessions; default 2 — after that it stops for good. If you decline, the model records "keep the default address", which also settles it.',
        hintRecallMode: 'off = no per-turn recall; dry = compute but do not inject; inject = normal. Does not affect resident injection.',
        hintRecallTopK: 'Maximum recalled memories per turn.',
        hintCaptureMode: 'off = stop automatic writes (model tools still work); rule = rule-based capture.',
        hintCaptureMaxPerTurn: 'Maximum automatic writes per turn.',
        hintConsolidateEnabled: 'Scheduled consolidation: merge duplicates, invalidate conflicts, decay-archive, rule-based summary.',
        hintConsolidateIntervalMinutes: 'Consolidation interval in minutes.',
        hintSleepEnabled: '0 = off, 1 = on; default 1 (on). When off, /sleep only explains that it is disabled and does nothing; it is not affected by recallMode / autoRecall.',
        hintSleepSessions: 'How many recent sessions /sleep reviews when --sessions=N is omitted; capped at 20.',
        hintSleepMaxBackfill: 'Maximum rows one /sleep --apply may backfill (only things the user explicitly asked to remember); candidates beyond it are reported as truncated in the plan and its notes.',
        hintRefsEnabled: '0 = off, 1 = on; default 1 (on). While enabled every memory records where it came from (session + event seq range), and /memory verify <id> can check it against the original events. Turning it off only affects new rows; existing references stay.',
        hintRefsMax: 'How many source references one record keeps (default 5, newest first); 0 = keep none, Infinity = unlimited.',
    };
    /**
     * 卡片编辑的字段：与 Host 侧 `Config` 里标了 `volatile()` 的字段一一对应。
     * kind 决定控件：number/text 用框架的 SettingsValueField；boolean/enum 用原生控件（避免依赖未确认的原语 API）。
     * `bool01: true` 的 number 字段在 Host 侧其实是布尔，只是界面上按契约用 0/1 表达（见 `booleanZeroOneField`）。
     */
    const FIELDS = [
        { name: 'domainName', kind: 'text', group: 'groupStore' },
        { name: 'maxInjectedTokens', kind: 'number', group: 'groupRecall' },
        { name: 'maxItemTokens', kind: 'number', group: 'groupRecall' },
        { name: 'selfPortraitMaxTokens', kind: 'number', group: 'groupRecall' },
        { name: 'selfPortraitEnabled', kind: 'number', bool01: true, group: 'groupRecall' },
        { name: 'selfPersonaMaxTokens', kind: 'number', group: 'groupRecall' },
        { name: 'selfPortraitMergeThreshold', kind: 'number', group: 'groupRecall' },
        { name: 'selfReflectEnabled', kind: 'number', bool01: true, group: 'groupRecall' },
        { name: 'selfReflectEveryTurns', kind: 'number', group: 'groupRecall' },
        { name: 'selfReflectMinTurn', kind: 'number', group: 'groupRecall' },
        { name: 'selfReflectMaxPerSession', kind: 'number', group: 'groupRecall' },
        // M7：初次设定（称呼）
        { name: 'selfIntroEnabled', kind: 'number', bool01: true, group: 'groupRecall' },
        { name: 'selfIntroMinTurn', kind: 'number', group: 'groupRecall' },
        { name: 'selfIntroMaxAsks', kind: 'number', group: 'groupRecall' },
        { name: 'recallMode', kind: 'enum', options: ['off', 'dry', 'inject'], group: 'groupRecall' },
        { name: 'recallTopK', kind: 'number', group: 'groupRecall' },
        { name: 'captureMode', kind: 'enum', options: ['off', 'rule'], group: 'groupCapture' },
        { name: 'captureMaxPerTurn', kind: 'number', group: 'groupCapture' },
        { name: 'consolidateEnabled', kind: 'boolean', group: 'groupConsolidate' },
        { name: 'consolidateIntervalMinutes', kind: 'number', group: 'groupConsolidate' },
        // M8：空闲梳理（独立命令 `/sleep`）。这里只放最常用的三个旋钮；字符预算与自画像条数
        // （sleepMaxCharsPerSession / sleepMaxCharsTotal / sleepAssistantContext / sleepMaxGists）
        // 仍走 patch 行，见两份 README 的配置章节。
        { name: 'sleepEnabled', kind: 'number', bool01: true, group: 'groupSleep' },
        { name: 'sleepSessions', kind: 'number', group: 'groupSleep' },
        { name: 'sleepMaxBackfill', kind: 'number', group: 'groupSleep' },
        // M9：可核验引用（每条记忆指向来源会话与事件序号区间）
        { name: 'refsEnabled', kind: 'number', bool01: true, group: 'groupRecall' },
        { name: 'refsMax', kind: 'number', group: 'groupRecall' },
    ];
    /**
     * 布尔/枚举的转换规格：空串 = 清除覆盖；非法值返回 undefined 让框架标为 invalid。
     *
     * 只接受 boolean/enum。**这是一处有意的行为修复**：TypeScript 版之前（以及 0.4.x 的 JS 版）
     * 让文本字段也走这个函数，于是 `domainName` 的非空草稿会执行 `field.options.includes(...)`
     * 并抛 `TypeError` —— 也就是在设置表单里改「记忆库名」会直接崩。
     * 文本字段现在交给原语的 `settingsTextField`（空草稿 = 清除覆盖，非空 = 设置值），
     * 与框架自身对文本字段的语义一致。
     */
    function customSpec(field) {
        return {
            field: field.name,
            format: (value) => (value === undefined || value === null ? '' : String(value)),
            parse: (text) => {
                const trimmed = String(text).trim();
                if (trimmed === '')
                    return { kind: 'clear' };
                if (field.kind === 'boolean') {
                    if (trimmed !== 'true' && trimmed !== 'false')
                        return undefined;
                    return { kind: 'set', value: trimmed === 'true' };
                }
                if (!field.options.includes(trimmed))
                    return undefined;
                return { kind: 'set', value: trimmed };
            },
        };
    }
    /**
     * 布尔字段的「0/1」转换规格：控件复用原语的数字输入（`settingsNumberField` 的格式与数字校验），
     * 但**写回的值是真布尔**。
     *
     * 为什么不能直接写 0/1 数字：Host 侧这两个键是 `Schema.boolean()`（契约 3.1），
     * 而 settings 服务只做 JSON 形状校验（`cloneJsonShaped`）不做类型转换，数字会一路落进 profile patch，
     * 再在 volatile 重解析时抛 `$.selfPortraitEnabled expected boolean but got 0`（schemastery 实测），
     * 于是「关掉自画像」反而会把插件配置弄坏。所以 0/1 只作为**界面语义**，落盘仍是布尔。
     *
     * 空草稿 = 清除覆盖；0/1 之外的值返回 undefined，让框架标为 invalid。
     */
    function booleanZeroOneField(field) {
        const numeric = (0, dsh_client_ui_primitives_1.settingsNumberField)(field);
        return {
            field,
            format: (value) => (value === true ? '1' : value === false ? '0' : ''),
            parse: (text) => {
                const write = numeric.parse(text);
                if (!write || write.kind !== 'set')
                    return write;
                if (write.value === 0)
                    return { kind: 'set', value: false };
                if (write.value === 1)
                    return { kind: 'set', value: true };
                return undefined;
            },
        };
    }
    /** 字段 → 转换规格：数字与文本用原语，布尔与枚举用上面的自定义规格。 */
    function specs() {
        return FIELDS.map((field) => {
            if (field.kind === 'number') {
                return field.bool01 ? booleanZeroOneField(field.name) : (0, dsh_client_ui_primitives_1.settingsNumberField)(field.name);
            }
            if (field.kind === 'text')
                return (0, dsh_client_ui_primitives_1.settingsTextField)(field.name);
            return customSpec(field);
        });
    }
    /** 一个命名空间上的分阶段表单：本地草稿 → 保存时一次性提交（框架负责校验与持久化）。 */
    class MemoryCardController {
        form;
        store;
        constructor(scope) {
            this.form = new dsh_client_ui_primitives_1.SettingsFormModel(scope, specs());
            this.store = this.form.bind(() => this.projection());
        }
        projection() {
            const out = { ...this.form.shell() };
            for (const field of FIELDS)
                out[field.name] = this.form.field(field.name);
            return out;
        }
        inject() {
            return { hooks: { memoryCard: this.store }, ...this.form.actions() };
        }
        dispose() {
            this.form.dispose();
        }
    }
    // ---------------------------------------------------------------- 渲染
    /** 原生控件的外层与样式：不依赖尚未确认的原语 props。 */
    function row(children) {
        return (0, jsx_runtime_1.jsx)('div', { style: { margin: '10px 0' }, children });
    }
    function renderField(field, state, props, t) {
        const view = state[field.name] ?? { text: '', overridden: false, invalid: false };
        const label = t(field.name);
        if (field.kind === 'number' || field.kind === 'text') {
            return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.SettingsValueField, {
                id: `dsh-memory-${field.name}`,
                key: field.name,
                label,
                hint: t(`hint${field.name.charAt(0).toUpperCase()}${field.name.slice(1)}`),
                overriddenLabel: t('overridden'),
                resetLabel: t('reset'),
                invalidLabel: field.kind === 'number' ? (field.bool01 ? t('invalidToggle') : t('invalidNumber')) : t('invalidValue'),
                numeric: field.kind === 'number',
                disabled: !state.writable,
                ...view,
                onEdit: (text) => props.edit(field.name, text),
                onReset: () => props.resetField(field.name),
            });
        }
        if (field.kind === 'boolean') {
            return row((0, jsx_runtime_1.jsxs)('label', {
                key: field.name,
                style: { display: 'flex', gap: '8px', alignItems: 'center' },
                children: [
                    (0, jsx_runtime_1.jsx)('input', {
                        type: 'checkbox',
                        checked: view.text === 'true',
                        disabled: !state.writable,
                        onChange: (event) => props.edit(field.name, event.target.checked ? 'true' : 'false'),
                    }),
                    (0, jsx_runtime_1.jsx)('span', { children: label }),
                ],
            }));
        }
        // enum
        return row((0, jsx_runtime_1.jsxs)('label', {
            key: field.name,
            style: { display: 'flex', gap: '8px', alignItems: 'center' },
            children: [
                (0, jsx_runtime_1.jsx)('span', { children: label }),
                (0, jsx_runtime_1.jsx)('select', {
                    value: view.text,
                    disabled: !state.writable,
                    onChange: (event) => props.edit(field.name, event.target.value),
                    children: field.options.map((option) => (0, jsx_runtime_1.jsx)('option', { value: option, children: option })),
                }),
            ],
        }));
    }
    /** 插件页卡片：列表里给一行摘要，详情里给完整表单。 */
    function MemoryCard(props) {
        const state = props.useMemoryCard((snapshot) => snapshot);
        const t = props.t;
        if (props.view === 'summary')
            return t('description');
        const groups = [];
        for (const field of FIELDS) {
            if (!groups.includes(field.group))
                groups.push(field.group);
        }
        const children = groups.map((group) => (0, jsx_runtime_1.jsxs)('section', {
            key: group,
            children: [
                (0, jsx_runtime_1.jsx)('h4', { style: { margin: '14px 0 4px' }, children: t(group) }),
                ...FIELDS.filter((field) => field.group === group).map((field) => renderField(field, state, props, t)),
            ],
        }));
        return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.SettingsForm, {
            labels: {
                unavailable: t('unavailable'),
                readOnly: t('readOnly'),
                saveFailed: t('saveFailed'),
                save: t('save'),
                saving: t('saving'),
            },
            state,
            onSave: props.save,
            onDiscard: props.discard,
            children,
        });
    }
    /** 需要的客户端服务（cordis fiber inject）。 */
    exports.inject = ['slots', 'locale', 'configForms'];
    /**
     * 本插件 bundle 的包名与行 id。插槽 key 必须与 manager 的 `rowConfigKey(bundle, rowId)`
     * （= `` `${bundle}#${rowId}` ``）一致，否则卡片不会挂到 dsh-plugin-memory 下面。
     * 刻意写死而非 import：客户端包不依赖 Host 包。
     */
    const BUNDLE_NAME = 'dsh-plugin-memory';
    const ROW_ID = 'dsh-memory';
    const ROW_CONFIG_KEY = `${BUNDLE_NAME}#${ROW_ID}`;
    /**
     * 挂载记忆插件的设置卡片。
     *
     * 插槽选择（读 manager 源码确认，2026-10-01）：
     *   - `plugins.item` 是 **list** 插槽，条目会被 manager 归入「官方插件」分组 —— 用它就会出现
     *     「卡片不在 dsh-plugin-memory 里」的现象（我们 0.4.0 踩过）；
     *   - `plugins.row.config` / `plugins.bundle.config` 是 **keyed** 配置插槽，分别按
     *     `` `${bundle}#${rowId}` `` 与 bundle 包名挂载，渲染在 `PackageDetail`/`RowDetail`
     *     的 `data-plugin-config` 区块内。
     * 因此这里注册**行级配置**：卡片出现在 `dsh-plugin-memory` → 行 `dsh-memory` 的页面里，
     * 列表里对应行也会显示摘要（`view: 'summary'`）。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
        const t = ctx.locale.bind(DICT);
        ctx.effect(() => ctx.locale.register(DICT, { zh, en }), 'dsh-memory: dictionaries');
        const card = new MemoryCardController(ctx.configForms.get(exports.NS));
        ctx.effect(() => () => {
            card.dispose();
        }, 'dsh-memory: form subscription');
        ctx.effect(() => ctx.configForms.whileServed([exports.NS], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config',
            key: ROW_CONFIG_KEY,
            locale: DICT,
            inject: () => card.inject(),
        }, MemoryCard))), 'dsh-memory: row config page');
    }
    return module.exports
  },
})

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
        // 精简（docs/simplify.md §1）：分组收敛到 4 组；标题中英各一套、键集合必须一致。
        groupStore: '记忆库与行为',
        groupWrite: '写入与安全',
        groupLanguage: '模型可见',
        groupOther: '其它',
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
        // 精简（docs/simplify.md §1）：表单恰好 8 个字段，键顺序即表单顺序；其余 22 个键只走 patch 行。
        domainName: '记忆库名',
        captureMode: '自动捕获',
        recallMode: '按轮召回模式',
        writePolicy: '模型写入审批',
        language: '模型可见文本语言',
        selfPortraitEnabled: '自画像开关',
        branchAware: '分支感知过滤',
        sleepEnabled: '空闲梳理开关',
        hintDomainName: '记忆库名（= 落盘目录名）。换成别的名字即启用一个空库，旧库仍留在磁盘上。',
        hintCaptureMode: 'off=停止自动写入（模型工具仍可用）；rule=按规则自动捕获。',
        hintRecallMode: 'off=关闭按轮召回；dry=只计算不注入（观察用）；inject=正常注入。注意它不影响常驻注入。',
        hintWritePolicy: 'auto=默认，模型写入立刻生效（与 0.5.9 一致）；ask=模型写入先进待确认队列（用 /memory admin pending 查看），要你 /memory admin approve <id> 才生效；off=直接拒绝模型写入。规则捕获、用户命令与 /sleep 不受影响。',
        hintLanguage: '只影响**模型可见文本**：常驻注入块与块头/页脚、每轮召回块头/页脚、反思与初次设定提示词、7 个 memory_* 工具的描述与参数说明。命令输出（/memory …、/sleep 预览、stats…）**仍是中文**。默认 zh：升级前后逐字节相同。',
        hintSelfPortraitEnabled: '0=关、1=开；默认 1（开）。关掉后人格与工作两小节不再常驻注入，已有条目仍可检索。',
        hintBranchAware: '0=关、1=开；默认 1（开）。只影响带分支标签的记录：开时其它分支的专属记忆不会被注入；现有记录都没有标签，所以开箱行为与升级前完全一致。',
        hintSleepEnabled: '0=关、1=开；默认 1（开）。关掉后 /sleep 只返回一句说明、不做任何事；它不受 recallMode / autoRecall 影响。',
    };
    const en = {
        title: 'Long-term memory',
        description: 'Local-first long-term memory: automatic capture, dual-channel injection, explainable and deletable.',
        groupStore: 'Memory store & behaviour',
        groupWrite: 'Writes & safety',
        groupLanguage: 'Model-visible',
        groupOther: 'Other',
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
        // Simplified (docs/simplify.md §1): the form keeps exactly 8 fields, in form order; the other 22 keys are patch-line only.
        domainName: 'Memory store name',
        captureMode: 'Automatic capture',
        recallMode: 'Per-turn recall mode',
        writePolicy: 'Model write policy',
        language: 'Model-visible text language',
        selfPortraitEnabled: 'Self-portrait switch',
        branchAware: 'Branch-aware filtering',
        sleepEnabled: 'Idle review switch',
        hintDomainName: 'Memory store name (= on-disk directory). A new name starts an empty store; the old one stays on disk.',
        hintCaptureMode: 'off = stop automatic writes (model tools still work); rule = rule-based capture.',
        hintRecallMode: 'off = no per-turn recall; dry = compute but do not inject; inject = normal. Does not affect resident injection.',
        hintWritePolicy: 'auto = default: model writes take effect immediately (as in 0.5.9); ask = model writes wait in the pending queue (/memory admin pending to review) until you run /memory admin approve <id>; off = reject model writes outright. Rule capture, user commands and /sleep are never gated.',
        hintLanguage: 'Affects **model-visible text only**: the resident injection blocks and their headers/footers, the per-turn recall block header/footer, the reflection and first-run prompts, and the descriptions of the seven memory_* tools. Command output (/memory …, /sleep preview, stats…) **stays Chinese**. Default zh: byte-for-byte identical to before the upgrade.',
        hintSelfPortraitEnabled: '0 = off, 1 = on; default 1 (on). When off, neither the persona nor the work sections are injected; existing rows stay searchable.',
        hintBranchAware: '0 = off, 1 = on; default 1 (on). Affects only records that carry a branch tag: when on, memories exclusive to another branch are not injected. Every existing record is untagged, so out of the box the behaviour is exactly as before the upgrade.',
        hintSleepEnabled: '0 = off, 1 = on; default 1 (on). When off, /sleep only explains that it is disabled and does nothing; it is not affected by recallMode / autoRecall.',
    };
    /**
     * 卡片编辑的字段：**Host 侧 volatile 字段的子集**（精简后只剩 8 个，见 docs/simplify.md §1）。
     * 被移出表单的 22 个键仍然 volatile、仍可 patch 行设置，只是不再摆在这里。
     * kind 决定控件：number/text 用框架的 SettingsValueField；boolean/enum 用原生控件（避免依赖未确认的原语 API）。
     * `bool01: true` 的 number 字段在 Host 侧其实是布尔，只是界面上按契约用 0/1 表达（见 `booleanZeroOneField`）。
     */
    const FIELDS = [
        // 记忆库与行为：换库＝换一整套记忆；「要不要自动记 / 要不要注入」是用户最先会问的两件事。
        { name: 'domainName', kind: 'text', group: 'groupStore' },
        { name: 'captureMode', kind: 'enum', options: ['off', 'rule'], group: 'groupStore' },
        { name: 'recallMode', kind: 'enum', options: ['off', 'dry', 'inject'], group: 'groupStore' },
        // 写入与安全：M10（契约 docs/write-policy.md §2.1）——默认 auto，不改变现有行为。
        { name: 'writePolicy', kind: 'enum', options: ['auto', 'ask', 'off'], group: 'groupWrite' },
        // 模型可见：M11（契约 docs/i18n.md §2/§6）——枚举，默认 zh；只切换模型看到的那一半。
        { name: 'language', kind: 'enum', options: ['zh', 'en'], group: 'groupLanguage' },
        // 自画像总开关：M6（契约 docs/self-portrait.md 3.1）——一个开关管整块能力。
        { name: 'selfPortraitEnabled', kind: 'number', bool01: true, group: 'groupLanguage' },
        // 其它：M12 分支感知（契约 docs/branch.md §2.1/§6）+ M8 空闲梳理（契约 docs/sleep.md §4.1）。
        // 两者都是布尔键，界面按 0/1 表达、写回真布尔；/sleep 花 token，所以必须能一眼关掉。
        { name: 'branchAware', kind: 'number', bool01: true, group: 'groupOther' },
        { name: 'sleepEnabled', kind: 'number', bool01: true, group: 'groupOther' },
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

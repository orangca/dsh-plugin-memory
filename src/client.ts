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

// 单独编译本文件（`tsc src/client.ts`）时，同目录的 shims.d.ts 不会被自动纳入程序，
// 显式引用一次，保证 `react/jsx-runtime` 与本插件用到的 primitives 子集有类型；不影响任何产物。
/// <reference path="./shims.d.ts" />

import { jsx, jsxs } from 'react/jsx-runtime'
import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  settingsNumberField,
  settingsTextField,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SettingsFieldSpec,
  SettingsFieldView,
  SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

// ---------------------------------------------------------------- 客户端上下文
//
// shims.d.ts 里还没有客户端上下文的类型，这里按**实测运行契约**声明本半边实际用到的那一小块
// （做法与 src/types.ts 的 DshPluginContext 一致）。未使用的成员刻意不声明。

/** 文案取值函数：`ctx.locale.bind(ns)` 的返回值。 */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/**
 * 浏览器插件上下文（cordis fiber 的 ctx）。
 *
 * 注意 `locale.register` 的返回类型写成 `void | (() => void)`：JS 版把它的返回值**直接**交给
 * `ctx.effect(...)` 当清理函数用，所以这里必须让返回值可被 effect 接受，否则就得改写调用点、
 * 从而丢掉清理（行为差异）。真实返回值是 loader 的 disposer，运行时形状不受此声明影响。
 */
export interface ClientContext {
  locale: {
    register(
      namespace: string,
      dictionaries: { zh: Record<string, string>; en: Record<string, string> },
    ): void | (() => void)
    bind(namespace: string): Translate
  }
  configForms: {
    /** 取某个 settings 命名空间的作用域对象，交给 `SettingsFormModel`。 */
    get(namespace: string): unknown
    /** 只有这些命名空间被服务时才执行注册；返回注销函数。 */
    whileServed(namespaces: string[], register: () => unknown): () => void
  }
  slots: {
    inject(slot: string, register: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  effect(callback: () => void | (() => void), label?: string): unknown
}

/** settings 命名空间 = profile 条目 id（Host 侧 describe() 里的 ns）。 */
export const NS = 'dsh-memory'
/** 本卡片自己的文案字典命名空间。 */
const DICT = 'dsh-memory.settings'

const zh = {
  title: '长期记忆',
  description: '本地优先的长期记忆：自动捕获、双通道注入、可解释可删除。',
  groupRecall: '召回与注入',
  groupStore: '记忆库',
  groupCapture: '自动捕获',
  groupConsolidate: '整合治理',
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
}

const en = {
  title: 'Long-term memory',
  description: 'Local-first long-term memory: automatic capture, dual-channel injection, explainable and deletable.',
  groupRecall: 'Recall & injection',
  groupStore: 'Memory store',
  groupCapture: 'Automatic capture',
  groupConsolidate: 'Consolidation',
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
}

// ---------------------------------------------------------------- 字段定义

/** 控件种类：number/text 走原语，boolean/enum 走原生控件。 */
type FieldKind = 'text' | 'number' | 'boolean' | 'enum'

interface BaseField {
  name: string
  group: string
  /** 只有 enum 用。 */
  options?: readonly string[]
}

interface NumberField extends BaseField {
  kind: 'number'
  /**
   * 这个字段在 Host 侧是**布尔**，界面上用 0/1 表达（见 `booleanZeroOneField`）。
   * 只影响取哪条转换规格与非法文案，控件仍是原语的数字输入。
   */
  bool01?: boolean
}
interface TextField extends BaseField {
  kind: 'text'
}
interface BooleanField extends BaseField {
  kind: 'boolean'
}
interface EnumField extends BaseField {
  kind: 'enum'
  options: readonly string[]
}

type Field = NumberField | TextField | BooleanField | EnumField

/**
 * 卡片编辑的字段：与 Host 侧 `Config` 里标了 `volatile()` 的字段一一对应。
 * kind 决定控件：number/text 用框架的 SettingsValueField；boolean/enum 用原生控件（避免依赖未确认的原语 API）。
 * `bool01: true` 的 number 字段在 Host 侧其实是布尔，只是界面上按契约用 0/1 表达（见 `booleanZeroOneField`）。
 */
const FIELDS: readonly Field[] = [
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
]

/**
 * 布尔/枚举的转换规格：空串 = 清除覆盖；非法值返回 undefined 让框架标为 invalid。
 *
 * 只接受 boolean/enum。**这是一处有意的行为修复**：TypeScript 版之前（以及 0.4.x 的 JS 版）
 * 让文本字段也走这个函数，于是 `domainName` 的非空草稿会执行 `field.options.includes(...)`
 * 并抛 `TypeError` —— 也就是在设置表单里改「记忆库名」会直接崩。
 * 文本字段现在交给原语的 `settingsTextField`（空草稿 = 清除覆盖，非空 = 设置值），
 * 与框架自身对文本字段的语义一致。
 */
function customSpec(field: BooleanField | EnumField): SettingsFieldSpec {
  return {
    field: field.name,
    format: (value: unknown): string => (value === undefined || value === null ? '' : String(value)),
    parse: (text: string) => {
      const trimmed = String(text).trim()
      if (trimmed === '') return { kind: 'clear' }
      if (field.kind === 'boolean') {
        if (trimmed !== 'true' && trimmed !== 'false') return undefined
        return { kind: 'set', value: trimmed === 'true' }
      }
      if (!field.options.includes(trimmed)) return undefined
      return { kind: 'set', value: trimmed }
    },
  }
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
function booleanZeroOneField(field: string): SettingsFieldSpec {
  const numeric = settingsNumberField(field)
  return {
    field,
    format: (value: unknown): string => (value === true ? '1' : value === false ? '0' : ''),
    parse: (text: string) => {
      const write = numeric.parse(text)
      if (!write || write.kind !== 'set') return write
      if (write.value === 0) return { kind: 'set', value: false }
      if (write.value === 1) return { kind: 'set', value: true }
      return undefined
    },
  }
}

/** 字段 → 转换规格：数字与文本用原语，布尔与枚举用上面的自定义规格。 */
function specs(): SettingsFieldSpec[] {
  return FIELDS.map((field) => {
    if (field.kind === 'number') {
      return field.bool01 ? booleanZeroOneField(field.name) : settingsNumberField(field.name)
    }
    if (field.kind === 'text') return settingsTextField(field.name)
    return customSpec(field)
  })
}

// ---------------------------------------------------------------- 表单模型

/** 卡片快照：`shell()` 的字段 + 每个字段名 → 控件视图（即 `projection()` 的扁平形状）。 */
type MemoryCardState = SettingsFormShell & { [field: string]: SettingsFieldView }

/** 表单动作：`SettingsFormModel.actions()` 转发给卡片的 props。 */
interface MemoryCardActions {
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
}

/** `store`：`SettingsFormModel.bind()` 返回的订阅句柄（原语只声明形状，这里照抄）。 */
interface SettingsStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 一个命名空间上的分阶段表单：本地草稿 → 保存时一次性提交（框架负责校验与持久化）。 */
class MemoryCardController {
  private readonly form: SettingsFormModel
  private readonly store: SettingsStore<MemoryCardState>

  constructor(scope: unknown) {
    this.form = new SettingsFormModel(scope, specs())
    this.store = this.form.bind(() => this.projection())
  }

  projection(): MemoryCardState {
    const out = { ...this.form.shell() } as MemoryCardState
    for (const field of FIELDS) out[field.name] = this.form.field(field.name)
    return out
  }

  inject(): { hooks: { memoryCard: SettingsStore<MemoryCardState> } } & ReturnType<SettingsFormModel['actions']> {
    return { hooks: { memoryCard: this.store }, ...this.form.actions() }
  }

  dispose(): void {
    this.form.dispose()
  }
}

// ---------------------------------------------------------------- 渲染

/** 原生控件的外层与样式：不依赖尚未确认的原语 props。 */
function row(children: unknown): unknown {
  return jsx('div', { style: { margin: '10px 0' }, children })
}

/** 原生控件回调收到的事件：只声明我们真正读到的 target 字段。 */
interface CheckboxChangeEvent {
  target: { checked: boolean }
}

interface SelectChangeEvent {
  target: { value: string }
}

function renderField(field: Field, state: MemoryCardState, props: MemoryCardActions, t: Translate): unknown {
  const view = state[field.name] ?? { text: '', overridden: false, invalid: false }
  const label = t(field.name)
  if (field.kind === 'number' || field.kind === 'text') {
    return jsx(SettingsValueField, {
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
      onEdit: (text: string) => props.edit(field.name, text),
      onReset: () => props.resetField(field.name),
    })
  }
  if (field.kind === 'boolean') {
    return row(jsxs('label', {
      key: field.name,
      style: { display: 'flex', gap: '8px', alignItems: 'center' },
      children: [
        jsx('input', {
          type: 'checkbox',
          checked: view.text === 'true',
          disabled: !state.writable,
          onChange: (event: CheckboxChangeEvent) => props.edit(field.name, event.target.checked ? 'true' : 'false'),
        }),
        jsx('span', { children: label }),
      ],
    }))
  }
  // enum
  return row(jsxs('label', {
    key: field.name,
    style: { display: 'flex', gap: '8px', alignItems: 'center' },
    children: [
      jsx('span', { children: label }),
      jsx('select', {
        value: view.text,
        disabled: !state.writable,
        onChange: (event: SelectChangeEvent) => props.edit(field.name, event.target.value),
        children: field.options.map((option) => jsx('option', { value: option, children: option })),
      }),
    ],
  }))
}

/** 插槽传给我们卡片的 props：`inject()` 的结果（actions + hooks）再叠加插槽自己的字段。 */
interface MemoryCardProps extends MemoryCardActions {
  view?: 'summary' | 'detail'
  t: Translate
  useMemoryCard: <T>(selector: (state: MemoryCardState) => T) => T
  save: () => void
  discard: () => void
}

/** 插件页卡片：列表里给一行摘要，详情里给完整表单。 */
function MemoryCard(props: MemoryCardProps): unknown {
  const state = props.useMemoryCard((snapshot) => snapshot)
  const t = props.t
  if (props.view === 'summary') return t('description')
  const groups: string[] = []
  for (const field of FIELDS) {
    if (!groups.includes(field.group)) groups.push(field.group)
  }
  const children = groups.map((group) => jsxs('section', {
    key: group,
    children: [
      jsx('h4', { style: { margin: '14px 0 4px' }, children: t(group) }),
      ...FIELDS.filter((field) => field.group === group).map((field) => renderField(field, state, props, t)),
    ],
  }))
  return jsx(SettingsForm, {
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
  })
}

/** 需要的客户端服务（cordis fiber inject）。 */
export const inject = ['slots', 'locale', 'configForms']

/**
 * 本插件 bundle 的包名与行 id。插槽 key 必须与 manager 的 `rowConfigKey(bundle, rowId)`
 * （= `` `${bundle}#${rowId}` ``）一致，否则卡片不会挂到 dsh-plugin-memory 下面。
 * 刻意写死而非 import：客户端包不依赖 Host 包。
 */
const BUNDLE_NAME = 'dsh-plugin-memory'
const ROW_ID = 'dsh-memory'
const ROW_CONFIG_KEY = `${BUNDLE_NAME}#${ROW_ID}`

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
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(DICT)
  ctx.effect(() => ctx.locale.register(DICT, { zh, en }), 'dsh-memory: dictionaries')
  const card = new MemoryCardController(ctx.configForms.get(NS))
  ctx.effect(() => () => {
    card.dispose()
  }, 'dsh-memory: form subscription')
  ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: ROW_CONFIG_KEY,
    locale: DICT,
    inject: () => card.inject(),
  }, MemoryCard))), 'dsh-memory: row config page')
}

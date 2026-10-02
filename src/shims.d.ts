// 环境 shim：为「DSH 客户端模块系统」与「浏览器半边用到的两个外部模块」提供最小类型。
//
// 为什么不直接依赖 npm 上的 @deepseek-ai/* 类型包：
// 实测（2026-10-02）发布版 `@deepseek-ai/dsh-client-ui-primitives@0.0.1-rc.1` **并不导出**
// `SettingsForm` / `SettingsFormModel` / `SettingsValueField` / `settingsNumberField` 等 settings API，
// 而本机运行的 DSH（0.2.0-rc.2 一系）确实提供它们。发布版比运行版旧，因此这里按**实测契约**声明子集，
// 而不是按发布版类型编程。宿主侧同理，见 src/types.ts 的 DshPluginContext。
//
// 这些声明只影响类型检查；运行时的 `require` 由客户端的 lazy-CJS loader 注入。

/** 客户端模块加载器：DSH 用它装载第三方客户端半边。 */
interface DshModuleLoader {
  load(entry: {
    id: string
    factory: (require: (specifier: string) => unknown) => unknown
  }): void
}

/** 与 DOM lib 的 Window 声明合并（不要再 `declare const window`，那会与 lib.dom 重复声明）。 */
interface Window {
  __ModuleLoader__: DshModuleLoader
}

/** 供 react/jsx-runtime 的 shim 与本文件的组件签名共用（顶层声明才不会在 declare module 内失联）。 */
interface JsxProps {
  children?: unknown
  key?: string | number
  [prop: string]: unknown
}

declare module 'react/jsx-runtime' {
  export type Key = string | number
  export function jsx(type: unknown, props: JsxProps, key?: Key): unknown
  export function jsxs(type: unknown, props: JsxProps, key?: Key): unknown
  export const Fragment: unknown
}

/**
 * 本插件客户端半边实际用到的 primitives 子集。
 * 字段形状按运行版实测记录；未使用的导出刻意不声明，避免假装覆盖了整包 API。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** 一个字段的转换规格：把草稿文本转成写回操作。 */
  export interface SettingsFieldSpec {
    field: string
    format: (value: unknown) => string
    parse: (text: string) => { kind: 'set'; value: unknown } | { kind: 'clear' } | undefined
  }

  /** 数字字段：空草稿 = 清除覆盖；非有限数视为非法。 */
  export function settingsNumberField(field: string): SettingsFieldSpec
  /** 文本字段：空草稿 = 清除覆盖。 */
  export function settingsTextField(field: string): SettingsFieldSpec

  /** 一个控件读到的状态。 */
  export interface SettingsFieldView {
    text: string
    overridden: boolean
    invalid: boolean
  }

  /** 卡片级状态：Host 是否在服务、是否只读、是否有未保存改动等。 */
  export interface SettingsFormShell {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }

  /** 分阶段表单：草稿在本地累积，保存时一次性提交给 settings 服务。 */
  export class SettingsFormModel {
    constructor(scope: unknown, specs: SettingsFieldSpec[], secrets?: SettingsFieldSpec[])
    bind<T>(project: () => T): { getSnapshot(): T; subscribe(listener: () => void): () => void }
    shell(): SettingsFormShell
    field(field: string): SettingsFieldView
    actions(): {
      edit: (field: string, text: string) => void
      resetField: (field: string) => void
      save: () => void
      discard: () => void
    }
    dispose(): void
  }

  /** 表单外壳：渲染保存/放弃按钮、只读与失败提示。 */
  export function SettingsForm(props: JsxProps): unknown
  /** 单个文本/数字控件。 */
  export function SettingsValueField(props: JsxProps): unknown
}

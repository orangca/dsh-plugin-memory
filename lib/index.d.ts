import type { DshPluginContext } from './types.js';
type SchemaFactory = (typeof import('@deepseek-ai/schemastery'))['default'];
export declare const name = "dsh-memory";
export declare const inject: string[];
/**
 * 配置 schema。声明为 `volatile()` 的字段会出现在 DSH 设置页的表单里（改动热生效），
 * 其余字段只能通过 patch 行设置。整块构造做了防御：schemastery 不可用或缺 `volatile`
 * 时降级为「不带 volatile」甚至「不导出 schema」，绝不让插件因为 UI 面而加载失败。
 */
declare function buildConfig(useVolatile: boolean): ReturnType<SchemaFactory['object']>;
declare let Config: ReturnType<typeof buildConfig> | undefined;
export { Config };
export declare function apply(ctx: DshPluginContext, config?: unknown): void;
//# sourceMappingURL=index.d.ts.map
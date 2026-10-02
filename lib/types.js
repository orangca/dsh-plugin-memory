// 领域类型 + DSH 宿主接缝的最小类型声明。
//
// 关于宿主接缝：本插件用到的服务（systemPrompt / storageDomain / tools / commands / agents / settings）
// 在 npm 上有同名包，但其发布版本比本机运行的 DSH 旧，类型并不匹配（详见 src/shims.d.ts 的说明）。
// 因此这里按**实测运行契约**声明「我们实际调用到的那一小块」，既让 TS 检查生效，也把假设写在明处。
// 每个接口都用 JSDoc 标注调用点，便于升级 DSH 时对照检查。
export {};
//# sourceMappingURL=types.js.map
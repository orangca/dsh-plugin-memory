// 模块级单测：验证插件模块的加载契约与「失败安全」。
//
// 这条用例的重点是**发布版 profile 与本地开发环境的差异**：
//   · 打包发布的 profile 里插件目录没有自己的 node_modules，profile 又配了 autoInstallPeers: false，
//     因此 `@deepseek-ai/schemastery` 常常**不可解析**。这正是验证降级路径的真实环境：
//     设置页表单所依赖的 schemastery 缺失时，插件**必须仍能加载**，只是没有表单（Config → undefined）。
//   · 而本仓库的开发环境把 schemastery 装成了 devDependency，动态 import 会成功 → Config 是一个 schema。
// 两种状态都合法，所以这里只断言「环境无关的性质」，不再硬编码 `Config === undefined`。
//
// 导入的是**编译产物**（../lib/index.js），与发布形态一致（`pnpm test` 会先 build）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 模块导出视图：只声明契约断言用到的成员。 */
interface PluginExports {
  name?: unknown
  inject: string[]
  apply?: unknown
  Config?: unknown
}

const loadPlugin = async (): Promise<PluginExports> => (await import('../lib/index.js')) as PluginExports

test('插件模块：导出契约完整（name / inject / apply / Config）', async () => {
  const mod = await loadPlugin()
  assert.equal(mod.name, 'dsh-memory')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组')
  for (const service of ['agents', 'systemPrompt', 'storageDomain', 'tools', 'commands']) {
    assert.ok(mod.inject.includes(service), `应 inject ${service}`)
  }
  // compaction 在本 profile 不可达，不能被 inject（否则 fiber 永久 PENDING）
  assert.ok(!mod.inject.includes('compaction'), '不应 inject 可能缺席的服务')
})

test('失败安全：schemastery 能否解析都不影响模块加载（Config 或有或无）', async () => {
  const mod = await loadPlugin()
  // 能走到这里就说明模块加载成功：schemastery 缺失也不会让 import 抛错（动态 import + 顶层 await 已兜住）
  assert.equal(typeof mod.apply, 'function')
  if (mod.Config === undefined) {
    // 发布版 profile：peer 映射不到 schemastery → 降级为「没有设置页表单」，其余功能照常
    assert.equal(mod.Config, undefined)
  } else {
    // 本地开发环境：schemastery 可解析 → Config 是可调用的 schema（函数）或对象
    assert.ok(typeof mod.Config === 'object' || typeof mod.Config === 'function', `Config 类型异常：${typeof mod.Config}`)
  }
})

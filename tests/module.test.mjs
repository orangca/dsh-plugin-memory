// 模块级单测：验证插件模块的加载契约与「失败安全」。
//
// 这里的机器上 `@deepseek-ai/schemastery` 对工作区不可解析（插件目录没有 node_modules，
// profile 又配了 autoInstallPeers: false）。因此这正是验证降级路径的最佳环境：
// 设置页表单所依赖的 schemastery 缺失时，插件**必须仍能加载**，只是没有表单。

import { test } from 'node:test'
import assert from 'node:assert/strict'

test('插件模块：导出契约完整（name / inject / apply / Config）', async () => {
  const mod = await import('../src/index.js')
  assert.equal(mod.name, 'dsh-memory')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组')
  for (const service of ['agents', 'systemPrompt', 'storageDomain', 'tools', 'commands']) {
    assert.ok(mod.inject.includes(service), `应 inject ${service}`)
  }
  // compaction 在本 profile 不可达，不能被 inject（否则 fiber 永久 PENDING）
  assert.ok(!mod.inject.includes('compaction'), '不应 inject 可能缺席的服务')
})

test('失败安全：schemastery 不可解析时，模块仍加载且 Config 为空', async () => {
  const mod = await import('../src/index.js')
  // 本机无 @deepseek-ai/schemastery → 动态 import 失败 → Config 必须降级为 undefined
  assert.equal(mod.Config, undefined)
  // 且不能因此抛出异常（能走到这里就说明 import 成功了）
  assert.equal(typeof mod.apply, 'function')
})

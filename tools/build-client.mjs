// 把 tsc 用 CommonJS 编出来的客户端工厂，包成 DSH 客户端模块系统要求的 lazy-CJS 形式：
//
//   window.__ModuleLoader__.load({ id, factory: (require) => { ...module body...; return module.exports } })
//
// 为什么需要这一步：客户端半边必须是「一段脚本 + 一个 factory」，而不是普通 ESM/CJS 模块；
// 官方仓库用 packages/client/tsdown.client.ts 的 clientBundle 预设生成它，那个预设不在任何已发布包里，
// 所以仓库之外的包要自己复刻（官方 cookbook 明确说明）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'build', 'client', 'client.js')
const target = join(root, 'lib', 'client.js')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const body = readFileSync(source, 'utf8')
  // 去掉 tsc 的 sourceMappingURL（源映射指向 build/ 目录，发布包里没有）
  .replace(/\/\/# sourceMappingURL=.*$/mu, '')
  .trimEnd()

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageJson.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
${body.split('\n').map((line) => (line.length > 0 ? `    ${line}` : line)).join('\n')}
    return module.exports
  },
})
`, 'utf8')

console.log(`已生成 ${target.replace(`${root}\\`, '').replace(`${root}/`, '')}（客户端 lazy-CJS 包装，${body.length} B 载荷）`)

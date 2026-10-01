// 扫描整个 app.asar，定位某个字符串出现在哪个客户端产物里（用于排查界面/协议实现）
//
// 用法：node tools/scan-asar.cjs <要搜索的字符串> [app.asar 路径]
//   asar 路径也可用环境变量 DSH_ASAR 指定；都不给时按 Windows 默认安装位置推断。
const fs = require('node:fs')
const path = require('node:path')

const defaultAsar = path.join(
  process.env.LOCALAPPDATA ?? path.join(process.env.HOME ?? '', 'AppData', 'Local'),
  'Programs', 'DeepSeek Harness', 'resources', 'app.asar',
)
const asar = process.env.DSH_ASAR ?? process.argv[3] ?? defaultAsar
if (!fs.existsSync(asar)) {
  console.error(`找不到 app.asar：${asar}\n请用第二个参数或环境变量 DSH_ASAR 指定其路径。`)
  process.exit(1)
}
const fd = fs.openSync(asar, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, headerBuf, 0, jsonLen, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const dataStart = 16 + jsonLen

// 建立 offset → 条目 的映射（只看 .js/.mjs/.cjs）
const entries = []
;(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p)
    else if (/\.(js|mjs|cjs)$/.test(p)) entries.push({ path: p, offset: Number(entry.offset), size: entry.size })
  }
})(header, '')
entries.sort((a, b) => a.offset - b.offset)
console.log('可扫描 JS 文件数：', entries.length)

const needle = process.argv[2] ?? 'configForms'
const target = Buffer.from(needle)
const CHUNK = 8 * 1024 * 1024
let pos = dataStart
let found = 0
const hits = []
const buf = Buffer.alloc(CHUNK)
let carry = Buffer.alloc(0)
while (true) {
  const read = fs.readSync(fd, buf, 0, CHUNK, pos)
  if (read <= 0) break
  const chunk = Buffer.concat([carry, buf.subarray(0, read)])
  const base = pos - carry.length
  let idx = chunk.indexOf(target)
  while (idx !== -1) {
    const abs = base + idx
    const ctx = chunk.subarray(Math.max(0, idx - 160), Math.min(chunk.length, idx + 160)).toString('utf8').replace(/\s+/g, ' ')
    hits.push({ abs, ctx })
    found++
    idx = chunk.indexOf(target, idx + 1)
  }
  carry = chunk.subarray(Math.max(0, chunk.length - target.length))
  pos += read
}
fs.closeSync(fd)

console.log(`命中 ${found} 处，打印前 12 处（含所属文件）：`)
const seen = new Set()
for (const hit of hits) {
  const owner = [...entries].reverse().find((e) => e.offset <= hit.abs)
  const key = `${owner?.path}|${hit.ctx.slice(0, 60)}`
  if (seen.has(key)) continue
  seen.add(key)
  const rel = owner ? hit.abs - owner.offset : -1
  console.log(`\n--- ${owner?.path} +${rel}`)
  console.log('   ', hit.ctx.slice(0, 300))
  if (seen.size >= 12) break
}

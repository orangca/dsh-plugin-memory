// 打印会话日志第一行（会话头）的形状，用于确定 cwd 字段位置。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function firstFrameText(file) {
  const buffer = readFileSync(file)
  const offsets = []
  let cursor = 0
  while (cursor >= 0) {
    const found = buffer.indexOf(MAGIC, cursor)
    if (found < 0) break
    offsets.push(found)
    cursor = found + 4
  }
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try { text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8') } catch { /* skip */ }
    if (text.includes('\n')) break
  }
  return text
}

const root = process.argv[2]
let newest = null
const walk = (dir, depth) => {
  if (depth > 3) return
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { walk(full, depth + 1); continue }
    if (!entry.name.startsWith('session.') || !entry.name.endsWith('.zstd')) continue
    const size = statSync(full).size
    if (!newest || size > newest.size) newest = { file: full, size }
  }
}
walk(root, 0)
if (!newest) { console.log('没有找到会话日志'); process.exit(0) }
const firstLine = firstFrameText(newest.file).split('\n')[0]
console.log(`文件：${newest.file}（${newest.size} 字节）`)
try {
  const header = JSON.parse(firstLine)
  console.log('头行 type:', header.type)
  console.log('顶层字段:', Object.keys(header))
  console.log('data 字段:', header.data ? Object.keys(header.data) : '(无)')
  console.log(JSON.stringify(header, null, 2).slice(0, 900))
} catch {
  console.log('头行不是 JSON：', firstLine.slice(0, 300))
}

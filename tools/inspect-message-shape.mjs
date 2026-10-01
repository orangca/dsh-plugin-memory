// 从会话日志里取最近一条 runtime-context 的 user/message，打印其完整形状。
// 用途：确认 pre-step 注入的 user 消息对象应该长什么样（本地无法读 llm 源码时的取证手段）。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decompressAllFrames(buffer) {
  const offsets = []
  let cursor = 0
  while (cursor >= 0) {
    const found = buffer.indexOf(ZSTD_MAGIC, cursor)
    if (found < 0) break
    offsets.push(found)
    cursor = found + 4
  }
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try { text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8') } catch { /* skip */ }
  }
  return text
}

const root = process.argv[2]
const wanted = process.argv[3] ?? 'runtime-context'
let found = null
let userSample = null

const walk = (dir, depth) => {
  if (depth > 3 || found) return
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (found && userSample) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { walk(full, depth + 1); continue }
    if (!entry.name.startsWith('session.') || !entry.name.endsWith('.zstd')) continue
    if (statSync(full).size < 500) continue
    const text = decompressAllFrames(readFileSync(full))
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event?.type !== 'user/message') continue
      const kind = event.data?.source?.kind
      if (kind === wanted && !found) found = { file: full, event }
      if (kind === 'user' && !userSample) userSample = { file: full, event }
    }
  }
}

walk(root, 0)
if (found) {
  console.log('=== runtime-context 消息（持久化形状）===')
  console.log(JSON.stringify(found.event, null, 2).slice(0, 2500))
} else {
  console.log('未找到 runtime-context 消息')
}
if (userSample) {
  console.log('\n=== 真实用户消息（对照）===')
  console.log(JSON.stringify(userSample.event, null, 2).slice(0, 1200))
}

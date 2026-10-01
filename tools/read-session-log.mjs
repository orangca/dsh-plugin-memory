// 读取 DSH 会话原始日志（zstd 压缩的 JSONL），打印最近的事件类型顺序。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const tail = Number(process.argv[3] ?? 60)
const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
const lines = text.split('\n').filter((line) => line.trim().length > 0)
const rows = lines.slice(-tail).map((line) => {
  try {
    const event = JSON.parse(line)
    const detail = event.type === 'user/message'
      ? ` source=${event.data?.source?.kind} seq=${event.seq}`
      : event.type === 'turn/start' || event.type === 'turn/end'
        ? ` turn=${event.data?.turn} seq=${event.seq}`
        : ''
    return `${event.type}${detail}`
  } catch {
    return '?'
  }
})
console.log(`共 ${lines.length} 行，末 ${rows.length} 条：`)
console.log(rows.join('\n'))

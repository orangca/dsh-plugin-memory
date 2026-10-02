// 读取 DSH 会话原始日志（zstd 压缩的 JSONL），打印最近的事件类型顺序。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** 会话日志里的一行（只声明本工具读到的字段）。 */
interface SessionLogEvent {
  type?: string
  seq?: number
  data?: {
    source?: { kind?: string } | null
    turn?: number
  } | null
}

const file = process.argv[2]
if (!file) {
  console.error('用法：node tools/read-session-log.ts <会话日志路径> [末尾条数，默认 60]')
  console.error('提示：日志在 $DSH_HOME/sessions/<会话>/session.*.jsonl.zstd')
  process.exit(1)
}
const tail = Number(process.argv[3] ?? 60)
const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
const lines = text.split('\n').filter((line) => line.trim().length > 0)
const rows = lines.slice(-tail).map((line) => {
  try {
    const event = JSON.parse(line) as SessionLogEvent
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

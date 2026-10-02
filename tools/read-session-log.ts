// 读取 DSH 会话原始日志（多帧 zstd 压缩的 JSONL），打印最近的事件类型顺序。
//
// ⚠ 这里曾经用 `zstdDecompressSync(readFileSync(file))` —— 那只解**第一帧**，
// 于是一个 8MB、几千条事件的日志只会打印出「共 1 行」的会话头（实测）。
// 现在统一走 tools/session-log.ts 的逐帧解压。
import { statSync } from 'node:fs'
import { listSessionLogs, readSessionEvents, sessionHeaderOf } from './session-log.ts'
import type { SessionLogEvent } from './session-log.ts'

const input = process.argv[2]
if (!input) {
  console.error('用法：node tools/read-session-log.ts <会话日志路径 | $DSH_HOME/sessions 目录> [末尾条数，默认 60]')
  console.error('提示：日志在 $DSH_HOME/sessions/<cwd 段>/<会话 id>/session.v4.jsonl.zstd')
  process.exit(1)
}
const tail = Math.max(0, Number(process.argv[3] ?? 60))

/** 允许直接传 sessions 根目录：自动挑最新的一个日志，省得手工拼路径。 */
const resolveFile = (candidate: string): string | null => {
  let isDirectory = false
  try {
    isDirectory = statSync(candidate).isDirectory()
  } catch {
    return null
  }
  if (!isDirectory) return candidate
  const newest = listSessionLogs(candidate)[0]
  if (!newest) return null
  console.log(`（目录输入：选中最新日志 ${newest.file}）`)
  return newest.file
}

const describe = (event: SessionLogEvent): string => {
  const detail = event.type === 'user/message'
    ? ` source=${event.data?.source?.kind} seq=${event.seq}`
    : event.type === 'turn/start' || event.type === 'turn/end'
      ? ` turn=${event.data?.turn} seq=${event.seq}`
      : ''
  return `${event.type}${detail}`
}

const target = resolveFile(input)
if (!target) {
  console.error(`找不到会话日志：${input}`)
  process.exit(1)
}

const events = readSessionEvents(target)
const header = sessionHeaderOf(events)
if (header) console.log(`会话 ${String(header.id ?? '?')}  cwd=${String(header.cwd ?? '?')}`)
const rows = events.slice(-tail).map(describe)
console.log(`共 ${events.length} 条事件，末 ${rows.length} 条：`)
console.log(rows.join('\n'))

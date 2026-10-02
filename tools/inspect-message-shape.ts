// 从会话日志里取最近一条 runtime-context 的 user/message，打印其完整形状。
// 用途：确认 pre-step 注入的 user 消息对象应该长什么样（本地无法读 llm 源码时的取证手段）。
import { isRealUserMessage, listSessionLogs, readSessionEvents, sessionsRoot } from './session-log.ts'
import type { SessionLogEvent } from './session-log.ts'

const root = process.argv[2] ?? sessionsRoot()
const wanted = process.argv[3] ?? 'runtime-context'

/** 命中的一条消息及其所在文件。 */
interface MessageSample {
  file: string
  event: SessionLogEvent
}

let found: MessageSample | null = null
let userSample: MessageSample | null = null
let scanned = 0

// 从新到旧扫描；只看体积像样的日志（会话头那种空日志没有消息）
for (const log of listSessionLogs(root, { minBytes: 500 })) {
  if (found && userSample) break
  scanned += 1
  let events: SessionLogEvent[]
  try {
    events = readSessionEvents(log.file)
  } catch {
    continue
  }
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const kind = event.data?.source?.kind
    if (kind === wanted && !found) found = { file: log.file, event }
    if (isRealUserMessage(event) && !userSample) userSample = { file: log.file, event }
  }
}

console.log(`（扫描 ${scanned} 个日志，根目录 ${root}）`)
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

// 打印会话日志第一行（会话头）的形状，用于确定 cwd 字段位置。
//
// 走 tools/session-log.ts 的逐帧解压与路径发现：免得每个工具各写一份魔数切帧
// （过去正是这种复制粘贴漂移出了「只看第一帧」的 bug）。
import { listSessionLogs, readSessionEvents, sessionHeaderOf, sessionsRoot } from './session-log.ts'

// 参数缺省用 $DSH_HOME/sessions；也可以传任意 sessions 根目录
const root = process.argv[2] ?? sessionsRoot()
const newest = listSessionLogs(root).sort((a, b) => b.bytes - a.bytes)[0]
if (!newest) {
  console.log(`没有找到会话日志（根目录：${root}）`)
  process.exit(0)
}

const events = readSessionEvents(newest.file)
const header = sessionHeaderOf(events)
console.log(`文件：${newest.file}（${newest.bytes} 字节，共 ${events.length} 条事件）`)
if (!header) {
  console.log('（没有 type=session 的头行）')
  process.exit(0)
}
console.log('头行 type:', header.type)
console.log('顶层字段:', Object.keys(header))
console.log('data 字段:', header.data ? Object.keys(header.data) : '(无)')
console.log(JSON.stringify(header, null, 2).slice(0, 900))

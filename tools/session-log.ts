// DSH 会话日志的读取（工具共享模块）。
//
// ⚠ 格式要点（实测，踩过坑）：DSH 的 `session.v4.jsonl.zstd` 是**多个独立 zstd 帧顺序追加**的，
// 每帧里是一到几行 JSONL。`zstdDecompressSync(buffer)` **只解第一帧**（流式解压同样只解第一帧），
// 于是一个 8MB 的日志只解出 213 字符 / 1 行（会话头），后面几千条事件全部丢失。
// 正确做法：按 zstd 魔数（28 B5 2F FD）切帧，逐帧解压后拼接。
//
// 注意：**插件运行期不该用它**。宿主提供 `ctx.sessionQuery`（`readSession` 返回完整事件日志），
// 那是 `/sleep` 的正式读取通道；本模块只服务于离线开发工具。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志里的一行（只声明工具会用到的字段，其余用索引签名兜住）。 */
export interface SessionLogEvent {
  type?: string
  seq?: number
  time?: number
  /** 会话头行（`type: 'session'`）直接把这些放在顶层。 */
  cwd?: string
  id?: string
  data?: {
    source?: { kind?: string } | null
    content?: unknown
    turn?: number
    [key: string]: unknown
  } | null
  [key: string]: unknown
}

/** 找到的一个会话日志文件。 */
export interface SessionLogFile {
  file: string
  sessionId: string
  bytes: number
  mtimeMs: number
}

/**
 * 逐帧解压：按魔数切帧，逐帧解压后拼接。
 * 没有魔数时退化为按普通 zstd 解一次（容忍非分帧文件）；全失败时返回空串。
 */
export function decompressAllFrames(buffer: Buffer): string {
  const offsets: number[] = []
  let cursor = 0
  while (cursor >= 0) {
    const found = buffer.indexOf(ZSTD_MAGIC, cursor)
    if (found < 0) break
    offsets.push(found)
    cursor = found + ZSTD_MAGIC.length
  }
  if (offsets.length === 0) {
    try {
      return zstdDecompressSync(buffer).toString('utf8')
    } catch {
      return ''
    }
  }
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]!
    const end = index + 1 < offsets.length ? offsets[index + 1]! : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch {
      /* 单帧失败跳过：畸形帧不该让整个日志读不出来 */
    }
  }
  return text
}

/** 解压一个日志文件（读盘 + 逐帧解压）。 */
export function readSessionText(file: string): string {
  return decompressAllFrames(readFileSync(file))
}

/** JSONL → 事件数组；空行与非 JSON 行（跨帧残行）跳过。 */
export function parseSessionLines(text: string): SessionLogEvent[] {
  const events: SessionLogEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      events.push(JSON.parse(line) as SessionLogEvent)
    } catch {
      /* 忽略残行 */
    }
  }
  return events
}

/** 读一个会话日志的**全部**事件（这是修掉「只看第一帧」的关键入口）。 */
export function readSessionEvents(file: string): SessionLogEvent[] {
  return parseSessionLines(readSessionText(file))
}

/** 会话日志根目录（`$DSH_HOME/sessions`，缺省回退到 `~/.dsh/sessions`）。 */
export function sessionsRoot(): string {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  return join(home, 'sessions')
}

/**
 * 递归列出会话日志文件（深度 3，够覆盖 `<cwd 段>/<会话 id>/session.v4.jsonl.zstd`）。
 * `minBytes` 可过滤掉只有会话头的空日志；结果按修改时间**从新到旧**排序。
 */
export function listSessionLogs(root: string, options: { minBytes?: number } = {}): SessionLogFile[] {
  const minBytes = options.minBytes ?? 0
  const files: SessionLogFile[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    let entries: Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.name.startsWith('session.') || !entry.name.endsWith('.zstd')) continue
      let bytes = 0
      let mtimeMs = 0
      try {
        const stat = statSync(full)
        bytes = stat.size
        mtimeMs = stat.mtimeMs
      } catch {
        continue
      }
      if (bytes < minBytes) continue
      // 会话 id 就是日志所在目录名（`<cwd 段>/<session-id>/session.v4.jsonl.zstd`）
      const directory = full.slice(0, full.lastIndexOf('\\') >= 0 ? full.lastIndexOf('\\') : full.lastIndexOf('/'))
      const sessionId = directory.slice(Math.max(directory.lastIndexOf('\\'), directory.lastIndexOf('/')) + 1)
      files.push({ file: full, sessionId, bytes, mtimeMs })
    }
  }
  walk(root, 0)
  // 从新到旧；mtime 相同时按路径兜底，保证顺序**确定**（同一毫秒写入的测试/脚本很常见）
  files.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return files
}

/** 会话头事件（`type === 'session'`）。 */
export function sessionHeaderOf(events: readonly SessionLogEvent[]): SessionLogEvent | null {
  return events.find((event) => event.type === 'session') ?? null
}

/** 一条消息事件的文本（内容块数组里的 text 拼接；非数组内容按字符串处理）。 */
export function textOfMessageContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type?: string; text?: string } => Boolean(block) && typeof block === 'object')
      .filter((block) => block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n')
  }
  return typeof content === 'string' ? content : ''
}

/** 事件是不是**真实用户消息**（`source.kind === 'user'`；我们注入的 runtime-context 不算）。 */
export function isRealUserMessage(event: SessionLogEvent): boolean {
  return event.type === 'user/message' && event.data?.source?.kind === 'user'
}

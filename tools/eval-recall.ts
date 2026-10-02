// eval-recall.ts — 长期记忆召回自检（M4）
//
// 为什么离线：`ctx.sessionQuery` 只能在宿主内调用，但会话日志与记忆库都落在磁盘上，
// 直接读盘就能用真实数据评测，不需要模型、不需要联网。
//
// 关键建模（前几版踩过的坑）：
//   · R2 的查询是**整轮用户消息**（可能几百字），记忆只有一句话 → 必须用记忆侧命中度
//     （memoryMatch），用查询覆盖率做分母会趋近 0；
//   · 线上 R2 会剔除**已由 R1 常驻块注入**的条目 → 评测必须同样建模，否则触发率被高估；
//   · 常驻块按 **workspace 作用域**过滤 → 必须用每个会话自己的 cwd（会话头**顶层**的 cwd），
//     且必须**按会话分桶**评估，不能把主会话与子代理会话混成一个池。
//
// 指标：自检索准确率 / 触发率（按消息长度分桶）/ 召回延迟 p50·p95 / 注入 token 预算。
//
// 用法：node tools/eval-recall.ts [--domain dsh_memory] [--limit 400] [--minHits 2] [--minMatch 0.4]

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

import {
  DEFAULTS,
  estimateTokens,
  listActive,
  recallRecords,
  renderContextBlock,
  renderSelfBlock,
  workspaceKeyOf,
} from '../lib/lib.js'
import type { MemoryConfig, MemoryRecord } from '../lib/lib.js'

/** 会话日志里的一行（只声明本工具读到的字段）。 */
interface SessionLogEvent {
  type?: string
  cwd?: string
  data?: {
    source?: { kind?: string } | null
    content?: unknown
  } | null
}

/** 消息内容块视图（只读 type/text）。 */
interface ContentBlock {
  type?: string
  text?: string
}

/** 一个会话的样本：文件、会话头 cwd、截断后的真实用户消息。 */
interface SessionSample {
  file: string
  cwd: string | null
  messages: string[]
}

/** 触发率分桶。 */
interface TriggerBucket {
  total: number
  triggered: number
}

/** 每个会话的召回池统计。 */
interface PoolStat {
  cwd: string | null
  messages: number
  recallable: number
  active: number
}

/** 触发示例。 */
interface TriggerExample {
  cwd: string | null
  queryChars: number
  query: string
  hit: string
  score: number
}

/** 评测报告（写进 reports/eval-*.json 的结构）。 */
interface RecallReport {
  domain: string
  at: string
  sessions: number
  memories: { total: number; active: number; byKind: Record<string, number> }
  selfRetrieval: { top1: number; top3: number; total: number; misses: string[] }
  triggerRate: {
    messages: number
    triggered: number
    byLength: { short: TriggerBucket; long: TriggerBucket }
    examples: TriggerExample[]
    pools: PoolStat[]
  }
  latency: { samples: number; p50: number; p95: number; max: number }
  injection: { recallTokens: number; selfTokens: number; lines: number; primaryCwd?: string | null }
}

const args = process.argv.slice(2)
const argOf = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const domain = argOf('domain', 'dsh_memory')
const perSessionLimit = Number(argOf('limit', '400'))
const minHits = Number(argOf('minHits', String(DEFAULTS.recallMinHits)))
const minMatch = Number(argOf('minMatch', String(DEFAULTS.recallMinMatch)))
const cfg: MemoryConfig = { ...DEFAULTS, reportPath: null }

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 逐帧解压（DSH 的会话日志是多个 zstd 帧顺序追加的，zstdDecompressSync 只解第一帧）。 */
function decompressAllFrames(buffer: Buffer): string {
  const offsets: number[] = []
  let cursor = 0
  while (cursor >= 0) {
    const found = buffer.indexOf(ZSTD_MAGIC, cursor)
    if (found < 0) break
    offsets.push(found)
    cursor = found + 4
  }
  if (offsets.length === 0) {
    try { return zstdDecompressSync(buffer).toString('utf8') } catch { return '' }
  }
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try { text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8') } catch { /* 单帧失败跳过 */ }
  }
  return text
}

/** 读一个会话日志：返回该会话的 cwd 与真实用户消息（按会话分桶，绝不跨会话混合）。 */
function readSession(file: string): SessionSample | null {
  let text: string
  try { text = decompressAllFrames(readFileSync(file)) } catch { return null }
  let cwd: string | null = null
  const messages: string[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let event: SessionLogEvent
    try { event = JSON.parse(line) as SessionLogEvent } catch { continue }
    if (event.type === 'session') {
      if (typeof event.cwd === 'string') cwd = event.cwd
      continue
    }
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const rawContent = event.data?.content
    const content = Array.isArray(rawContent)
      ? rawContent.filter((block: ContentBlock) => block?.type === 'text').map((block: ContentBlock) => block.text).join('\n')
      : ''
    const trimmed = content.trim()
    // 过滤空消息与 XML 包装（子代理提示词常以标签开头），它们不代表真实人类输入
    if (trimmed.length >= 8 && !trimmed.startsWith('<')) messages.push(trimmed)
  }
  if (messages.length === 0) return null
  return { file, cwd, messages: messages.slice(-perSessionLimit) }
}

function loadSessions(root: string): SessionSample[] {
  const sessions: SessionSample[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    let entries: Dirent[] = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full, depth + 1); continue }
      if (!entry.name.startsWith('session.') || !entry.name.endsWith('.zstd')) continue
      try { if (statSync(full).size < 500) continue } catch { continue }
      const session = readSession(full)
      if (session) sessions.push(session)
    }
  }
  walk(root, 0)
  return sessions
}

function loadMemories(domainName: string): MemoryRecord[] {
  const dir = join(dshHome, 'storages', domainName, 'memories')
  let files: string[] = []
  try { files = readdirSync(dir).filter((name) => name.endsWith('.json')) } catch { return [] }
  const records: MemoryRecord[] = []
  for (const file of files) {
    try {
      const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { record?: MemoryRecord } | null
      if (doc?.record?.id) records.push(doc.record)
    } catch { /* 坏文档跳过 */ }
  }
  return records
}

const normalizeLine = (line: string): string => line.replace(/^[-*\s]+/u, '').replace(/^\([a-z]+\)\s*/u, '').trim()

/** 某会话的 R2 召回池 = 全部 active − 已由 R1 常驻块注入的条目。 */
function recallPoolFor(records: MemoryRecord[], workspaceKey: string | null): MemoryRecord[] {
  const resident = new Set([
    ...renderContextBlock(records, cfg, workspaceKey).lines,
    ...renderSelfBlock(records, cfg).lines,
  ].map(normalizeLine))
  return records.filter((record) => !resident.has(record.text.trim()))
}

// ---------- 评测 ----------
const memories = loadMemories(domain)
const active = listActive(memories)
const sessions = loadSessions(join(dshHome, 'sessions'))

const report: RecallReport = {
  domain,
  at: new Date().toISOString(),
  sessions: sessions.length,
  memories: { total: memories.length, active: active.length, byKind: {} },
  selfRetrieval: { top1: 0, top3: 0, total: 0, misses: [] },
  triggerRate: { messages: 0, triggered: 0, byLength: { short: { total: 0, triggered: 0 }, long: { total: 0, triggered: 0 } }, examples: [], pools: [] },
  latency: { samples: 0, p50: 0, p95: 0, max: 0 },
  injection: { recallTokens: 0, selfTokens: 0, lines: 0 },
}

for (const record of active) report.memories.byKind[record.kind] = (report.memories.byKind[record.kind] ?? 0) + 1

// 1) 自检索（打分器健全性）
for (const record of active) {
  const hits = recallRecords(active, { query: record.text, limit: 3 })
  report.selfRetrieval.total += 1
  if (hits[0]?.record.id === record.id) report.selfRetrieval.top1 += 1
  if (hits.some((hit) => hit.record.id === record.id)) report.selfRetrieval.top3 += 1
  else if (report.selfRetrieval.misses.length < 5) report.selfRetrieval.misses.push(record.text.slice(0, 60))
}

// 2) 触发率（按会话分桶 + 按消息长度分桶）
for (const session of sessions) {
  const pool = recallPoolFor(active, workspaceKeyOf(session.cwd ?? ''))
  report.triggerRate.pools.push({ cwd: session.cwd, messages: session.messages.length, recallable: pool.length, active: active.length })
  for (const message of session.messages) {
    const hits = recallRecords(pool, { query: message, mode: 'memory', minHits, minMatch, limit: cfg.recallTopK ?? 8 })
    const bucket = message.length >= 20 ? report.triggerRate.byLength.long : report.triggerRate.byLength.short
    bucket.total += 1
    report.triggerRate.messages += 1
    if (hits.length > 0) {
      report.triggerRate.triggered += 1
      bucket.triggered += 1
      if (report.triggerRate.examples.length < 6) {
        report.triggerRate.examples.push({
          cwd: session.cwd,
          queryChars: message.length,
          query: message.slice(0, 40),
          hit: hits[0].record.text.slice(0, 50),
          score: Number(hits[0].score.toFixed(3)),
        })
      }
    }
  }
}

// 3) 延迟
const allMessages = sessions.flatMap((session) => session.messages)
const timings: number[] = []
for (let index = 0; index < 200; index += 1) {
  const query = allMessages[index % Math.max(1, allMessages.length)] ?? '记忆'
  const began = process.hrtime.bigint()
  recallRecords(active, { query, mode: 'memory', minHits, minMatch, limit: 8 })
  timings.push(Number(process.hrtime.bigint() - began) / 1e6)
}
timings.sort((a, b) => a - b)
report.latency = {
  samples: timings.length,
  p50: Number((timings[Math.floor(timings.length * 0.5)] ?? 0).toFixed(3)),
  p95: Number((timings[Math.floor(timings.length * 0.95)] ?? 0).toFixed(3)),
  max: Number((timings[timings.length - 1] ?? 0).toFixed(3)),
}

// 4) 注入预算（主会话视角：取出现次数最多的 cwd）
const primaryCwd = sessions.map((session) => session.cwd).filter(Boolean).sort((a, b) =>
  sessions.filter((s) => s.cwd === b).length - sessions.filter((s) => s.cwd === a).length)[0]
const recallBlock = renderContextBlock(active, cfg, workspaceKeyOf(primaryCwd ?? ''))
const selfBlock = renderSelfBlock(active, cfg)
report.injection = {
  primaryCwd: primaryCwd ?? null,
  recallTokens: estimateTokens(recallBlock.text, cfg.charsPerToken),
  selfTokens: estimateTokens(selfBlock.text, cfg.charsPerToken),
  lines: recallBlock.lines.length + selfBlock.lines.length,
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports')
try { mkdirSync(outDir, { recursive: true }) } catch { /* ignore */ }
const outFile = join(outDir, `eval-${Date.now()}.json`)
writeFileSync(outFile, JSON.stringify(report, null, 2))

// ---------- 输出 ----------
const percent = (part: number, whole: number): string => (whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`)
console.log(`记忆库 ${domain}：${report.memories.active}/${report.memories.total} 条 active，${JSON.stringify(report.memories.byKind)}`)
console.log(`会话样本：${report.sessions} 个（主会话 cwd：${report.injection.primaryCwd ?? '未知'}）`)
console.log(`自检索 Top1 ${percent(report.selfRetrieval.top1, report.selfRetrieval.total)}，Top3 ${percent(report.selfRetrieval.top3, report.selfRetrieval.total)}（${report.selfRetrieval.total} 条）`)
console.log(`召回触发率：${percent(report.triggerRate.triggered, report.triggerRate.messages)}（长消息 ≥20 字 ${percent(report.triggerRate.byLength.long.triggered, report.triggerRate.byLength.long.total)}，短指令 ${percent(report.triggerRate.byLength.short.triggered, report.triggerRate.byLength.short.total)}；共 ${report.triggerRate.messages} 条真实用户消息）`)
console.log(`召回延迟 p50 ${report.latency.p50}ms / p95 ${report.latency.p95}ms / max ${report.latency.max}ms（${report.latency.samples} 次）`)
console.log(`注入预算：召回块 ${report.injection.recallTokens} token，自画像块 ${report.injection.selfTokens} token，共 ${report.injection.lines} 行`)
for (const pool of report.triggerRate.pools) console.log(`  会话池 ${pool.cwd ?? '未知'}：消息 ${pool.messages}，可召回 ${pool.recallable}/${pool.active}`)
if (report.triggerRate.examples.length > 0) {
  console.log('触发示例：')
  for (const example of report.triggerRate.examples) console.log(`  [${example.queryChars}字] "${example.query}" → "${example.hit}" (${example.score})`)
}
if (report.selfRetrieval.misses.length > 0) console.log(`自检索未命中：${report.selfRetrieval.misses.join(' | ')}`)
console.log(`报告已写入 ${outFile}`)

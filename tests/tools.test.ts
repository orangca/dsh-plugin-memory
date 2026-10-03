// 开发工具的测试。重点是会话日志的**逐帧**读取 ——
// 这里曾有一个真 bug：`zstdDecompressSync` 只解第一帧，于是一个 8MB、9000 条事件的日志
// 只读出 1 行会话头（`read-session-log.ts` 因此长期打印「共 1 行」，任何人都看不出来）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import {
  isRealUserMessage,
  listSessionLogs,
  parseSessionLines,
  readSessionEvents,
  readSessionText,
  sessionHeaderOf,
  textOfMessageContent,
  ZSTD_MAGIC,
  decompressAllFrames,
} from '../tools/session-log.ts'

/** 造一个「多帧顺序追加」的日志：每帧一条 JSONL，与 DSH 的真实写法一致。 */
function writeMultiFrameLog(file: string, lines: unknown[]): void {
  const frames = lines.map((line) => zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`, 'utf8')))
  writeFileSync(file, Buffer.concat(frames))
}

test('session-log：多帧 zstd 必须**全部**解出来（只看第一帧是历史 bug）', () => {
  const lines = [
    { type: 'session', id: 's1', cwd: 'C:/proj/a', createdAt: 1 },
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '构建统一用 pnpm。' }] } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '注入的上下文' }] } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ]
  const frames = lines.map((line) => zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`, 'utf8')))
  const buffer = Buffer.concat(frames)

  // 先证明这个隐患是真的：只解第一帧（历史上的写法）只拿得到头行
  const firstOnly = parseSessionLines(zstdDecompressSync(frames[0]!).toString('utf8'))
  assert.equal(firstOnly.length, 1, '只解第一帧就只看得到头行（这就是过去的 bug 现场）')

  // 共享实现必须拿到全部四行
  const all = parseSessionLines(decompressAllFrames(buffer))
  assert.equal(all.length, 4)
  assert.equal(all[0]!.type, 'session')
  assert.equal(all[3]!.type, 'turn/end')
  // 魔数切帧的前提：文件里确实有 4 个帧头
  let count = 0
  let cursor = buffer.indexOf(ZSTD_MAGIC, 0)
  while (cursor !== -1) {
    count += 1
    cursor = buffer.indexOf(ZSTD_MAGIC, cursor + ZSTD_MAGIC.length)
  }
  assert.equal(count, 4)
})

test('session-log：readSessionEvents 从文件读全部帧（bug 的直接回归）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-session-log-'))
  try {
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeMultiFrameLog(file, [
      { type: 'session', id: 'ses-1', cwd: 'C:/proj/b', createdAt: 42 },
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记住：产物在 dist。' }] } },
      { type: 'assistant/message', seq: 2, data: { source: { kind: 'model' } } },
      { type: 'user/message', seq: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '再记一条。' }] } },
    ])

    const events = readSessionEvents(file)
    assert.equal(events.length, 4, '四帧四行一条都不能少')
    const header = sessionHeaderOf(events)
    assert.equal(header?.id, 'ses-1')
    assert.equal(header?.cwd, 'C:/proj/b')
    // 真实用户消息只有两条：runtime-context 之类注入的 `source.kind` 不同
    assert.equal(events.filter(isRealUserMessage).length, 2)
    // 文本抽取
    assert.equal(textOfMessageContent(events[1]!.data?.content), '记住：产物在 dist。')
    assert.equal(textOfMessageContent('纯字符串'), '纯字符串')
    assert.equal(textOfMessageContent([{ type: 'reasoning', text: '不该算' }, { type: 'text', text: '只取文本块' }]), '只取文本块')
    assert.equal(readSessionText(file).includes('ses-1'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session-log：畸形/非 JSON 行被跳过，解析不抛', () => {
  const events = parseSessionLines([
    '{"type":"session","id":"x"}',
    '',
    '   ',
    '不是 JSON',
    '{"type":"turn/start","data":{"turn":1}}',
    '{"type":',            // 跨帧残行
  ].join('\n'))
  assert.equal(events.length, 2)
  assert.equal(events[1]!.type, 'turn/start')
  // 完全没有 zstd 魔数的输入退化为「不是 zstd」，返回空串而不是抛
  assert.equal(decompressAllFrames(Buffer.from('plain text')), '')
})

test('session-log：listSessionLogs 递归发现、minBytes 过滤、按修改时间从新到旧', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-'))
  try {
    const oldDir = join(root, '--C-proj-a--', 'session-old')
    const newDir = join(root, '--C-proj-b--', 'session-new')
    mkdirSync(oldDir, { recursive: true })
    mkdirSync(newDir, { recursive: true })
    writeMultiFrameLog(join(oldDir, 'session.v4.jsonl.zstd'), [{ type: 'session', id: 'old' }])
    // 等一会儿再写新的，让 mtime 真的有区分（同一毫秒写入时模块按路径兜底，但那条路径不该被当成主排序）
    await new Promise((resolve) => setTimeout(resolve, 25))
    const newFile = join(newDir, 'session.v4.jsonl.zstd')
    writeMultiFrameLog(newFile, [
      { type: 'session', id: 'new' },
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '补一点体积，让它像真实日志。' }] } },
    ])

    const all = listSessionLogs(root)
    assert.equal(all.length, 2)
    assert.equal(all[0]!.sessionId, 'session-new', '最新的排在最前')
    assert.equal(all[1]!.sessionId, 'session-old')
    assert.ok(all[0]!.bytes > 0)

    // 空日志（只有会话头、很小）在真实体积过滤下会被滤掉
    const big = listSessionLogs(root, { minBytes: 500 })
    assert.equal(big.length, 0, '两个合成日志都小于 500 字节')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// README 结构一致性（tools/check-readmes.ts）
//
// 整段追加在文件末尾：既有用例一行都没动。ESM 的 import 声明会提升，写在后面同样生效。

import { checkReadmes } from '../tools/check-readmes.ts'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 定向破坏一对 README 的开关（全关 = 结构一致）。 */
interface PairOptions {
  /** zh 里把两个带锚点的小节顺序颠倒。 */
  swapZhSections?: boolean
  /** 从 zh 的表格里删掉这个键所在的行。 */
  dropZhKey?: string
  /** 从 zh 的命令块里删掉以它开头的行。 */
  dropZhCommand?: string
  /** 删掉 zh 顶部的 English 互链。 */
  dropZhLink?: boolean
  /** 从 en 里删掉一个代码围栏标记（凑成奇数）。 */
  breakEnFence?: boolean
}

/** 造一对「结构一致」的最小 README；每个校验项都留了可定向破坏的锚点。 */
function makeReadmePair(options: PairOptions = {}): { en: string; zh: string } {
  let en = [
    '# dsh-plugin-memory',
    '',
    '[中文说明](README.zh.md) | English',
    '',
    'Intro.',
    '',
    '## `alpha`',
    '',
    'Body. The settings form has **3 fields**.',
    '',
    '## `beta`',
    '',
    'More text.',
    '',
    '| Field | Default | Meaning |',
    '|---|---|---|',
    '| `recallTopK` | `8` | cap |',
    '| `auditMax` | `50` | ring size |',
    '',
    '```',
    '/memory list [--archived]   list memories',
    '/memory stats               runtime numbers',
    '/sleep [--apply]            idle review',
    '```',
    '',
  ].join('\n')
  let zh = [
    '# dsh-plugin-memory',
    '',
    '中文 | [English](README.md)',
    '',
    '说明。',
    '',
    '## `alpha`',
    '',
    '正文。表单里有 **3 个字段**。',
    '',
    '## `beta`',
    '',
    '更多文字。',
    '',
    '| 字段 | 默认 | 含义 |',
    '|---|---|---|',
    '| `recallTopK` | `8` | 上限 |',
    '| `auditMax` | `50` | 审计环容量 |',
    '',
    '```',
    '/memory list [--archived]   列出记忆',
    '/memory stats               运行时可观测',
    '/sleep [--apply]            空闲梳理',
    '```',
    '',
  ].join('\n')
  if (options.swapZhSections === true) {
    zh = zh.replace('## `alpha`', '@@swap@@').replace('## `beta`', '## `alpha`').replace('@@swap@@', '## `beta`')
  }
  if (options.dropZhKey !== undefined) {
    zh = zh.split('\n').filter((line) => !line.startsWith('| `' + options.dropZhKey + '` |')).join('\n')
  }
  if (options.dropZhCommand !== undefined) {
    zh = zh.split('\n').filter((line) => !line.startsWith(options.dropZhCommand + ' ') && line !== options.dropZhCommand).join('\n')
  }
  if (options.dropZhLink === true) {
    zh = zh.replace('[English](README.md)', 'English')
  }
  if (options.breakEnFence === true) {
    const lines = en.split('\n')
    lines.splice(lines.lastIndexOf('```'), 1)
    en = lines.join('\n')
  }
  return { en, zh }
}

/** 把造好的一对 README 写进临时目录，跑一次校验，然后清掉临时目录。 */
function checkPair(options: PairOptions = {}): { ok: boolean; problems: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-check-readmes-'))
  try {
    const pair = makeReadmePair(options)
    writeFileSync(join(dir, 'README.md'), pair.en, 'utf8')
    writeFileSync(join(dir, 'README.zh.md'), pair.zh, 'utf8')
    return checkReadmes(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('check-readmes：结构一致的一对 README 判定为 ok', () => {
  const result = checkPair()
  assert.deepEqual(result.problems, [], `一致的一对不该有问题：${result.problems.join(' / ')}`)
  assert.equal(result.ok, true)
})

test('check-readmes：小节顺序颠倒 → 不 ok，并指出是小节顺序', () => {
  const result = checkPair({ swapZhSections: true })
  assert.equal(result.ok, false)
  assert.ok(
    result.problems.some((problem) => problem.includes('小节顺序不一致')),
    `应报告小节顺序问题：${result.problems.join(' / ')}`,
  )
})

test('check-readmes：配置表缺一个键 → 不 ok，并点名缺的键', () => {
  const result = checkPair({ dropZhKey: 'auditMax' })
  assert.equal(result.ok, false)
  assert.ok(
    result.problems.some((problem) => problem.includes('表格键集合不一致') && problem.includes('auditMax')),
    `应点名缺的表格键：${result.problems.join(' / ')}`,
  )
})

test('check-readmes：命令行缺一条 → 不 ok，并点名缺的命令', () => {
  const result = checkPair({ dropZhCommand: '/memory stats' })
  assert.equal(result.ok, false)
  assert.ok(
    result.problems.some((problem) => problem.includes('命令行清单不一致') && problem.includes('/memory stats')),
    `应点名缺的命令：${result.problems.join(' / ')}`,
  )
})

test('check-readmes：代码围栏奇数 → 不 ok', () => {
  const result = checkPair({ breakEnFence: true })
  assert.equal(result.ok, false)
  assert.ok(
    result.problems.some((problem) => problem.includes('代码围栏不成对')),
    `应报告围栏不成对：${result.problems.join(' / ')}`,
  )
})

test('check-readmes：顶部互链缺失 → 不 ok', () => {
  const result = checkPair({ dropZhLink: true })
  assert.equal(result.ok, false)
  assert.ok(
    result.problems.some((problem) => problem.includes('顶部互链缺失') && problem.includes('README.zh.md')),
    `应报告互链缺失：${result.problems.join(' / ')}`,
  )
})

test('check-readmes：真实仓库的两份 README 结构一致（回归闸门）', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const result = checkReadmes(repoRoot)
  assert.deepEqual(result.problems, [], `真实 README 不该有结构差异：${result.problems.join(' / ')}`)
  assert.equal(result.ok, true)
})

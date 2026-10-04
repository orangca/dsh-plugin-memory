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

// ─────────────────────────────────────────────────────────────────────────────
// 发布物隐私扫描（tools/verify-self-contained.ts §4）
//
// 整段追加在文件末尾：既有用例一行都没动。ESM 的 import 声明会提升，写在后面同样生效。

import { PRIVACY_MAX_FILE_BYTES, scanReleasePrivacy, verifySelfContained } from '../tools/verify-self-contained.ts'
import { checkPrivacy, isUsableIdentityUsername } from '../tools/verify-self-contained.ts'
import { userInfo } from 'node:os'

/** 造一个临时「仓库」目录，只写进给的文件，跑一次隐私扫描后清掉临时目录。 */
function scanTempRepo(
  files: Record<string, string | Buffer>,
  overrides: { username?: string | null; dshHome?: string | null; maxBytes?: number } = {},
): ReturnType<typeof scanReleasePrivacy> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-privacy-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const absolute = join(dir, name)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, content)
    }
    return scanReleasePrivacy({ repo: dir, files: Object.keys(files), ...overrides })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('隐私扫描：含本机用户名的文本 ⇒ 命中本机用户名（不通过）', () => {
  // 用户名叫什么由 os.userInfo() 现场给出，绝不把任何具体名字写死进工具或测试。
  // 但 CI 通用账号（runner / root）按工具口径**不是**身份判据（见下面的「CI 局限」用例），
  // 拿它当输入会让这条用例在 CI 上自相矛盾，所以退回一个合成名字。
  const detected = userInfo().username
  const username = isUsableIdentityUsername(detected) ? detected : 'placeholder-user'
  const result = scanTempRepo({ 'docs/notes.md': `# 笔记\n\n作者：${username}\n` }, { username })
  assert.equal(result.scanned, 1)
  assert.deepEqual(result.skipped, [])
  assert.equal(result.hitsTotal, 1)
  assert.equal(result.hits[0]?.file, 'docs/notes.md')
  assert.equal(result.hits[0]?.kind, 'username')
  assert.equal(result.hits[0]?.line, 3, '要给出行号，不能只说「这个文件有问题」')
})

test('隐私扫描：含 Windows 盘符绝对路径 ⇒ 命中（不通过）', () => {
  const result = scanTempRepo(
    { 'README.md': '# 说明\n\n产物在 C:\\Users\\x\\proj\\lib\n' },
    { username: null, dshHome: null },
  )
  assert.equal(result.hitsTotal, 1)
  assert.equal(result.hits[0]?.kind, 'windows-drive-path')
  assert.equal(result.hits[0]?.line, 3)
})

test('隐私扫描：含 POSIX 家目录（/home/… 与 /Users/…）⇒ 命中（不通过）', () => {
  const result = scanTempRepo(
    { 'docs/a.md': '见 /home/someone/notes.md\n以及 /Users/someone/notes.md\n' },
    { username: null, dshHome: null },
  )
  assert.equal(result.hitsTotal, 2)
  assert.deepEqual(result.hits.map((hit) => hit.kind), ['posix-home-path', 'posix-home-path'])
  assert.deepEqual(result.hits.map((hit) => hit.line), [1, 2], '两种家目录写法各给出行号')
})

test('隐私扫描：干净文件 ⇒ 通过（命中为 0，扫描数如实报告）', () => {
  const result = scanTempRepo({
    'README.md': '# 说明\n\n产物在 <repo>/lib 下。\n',
    'docs/b.md': '路径写成相对形式：docs/b.md\n',
  })
  assert.deepEqual(result.hits, [])
  assert.equal(result.hitsTotal, 0)
  assert.equal(result.scanned, 2)
  assert.deepEqual(result.skipped, [])
})

test('隐私扫描：二进制与大文件被**跳过**，而不是失败', () => {
  const binary = Buffer.concat([Buffer.from('C:\\Users\\x', 'utf8'), Buffer.from([0x00, 0x01])])
  // 文本里确实有泄漏，但体积超过单文件上限 ⇒ 属于「没扫」：既不产生命中，也不算失败。
  const big = `C:\\Users\\x\n${'x'.repeat(PRIVACY_MAX_FILE_BYTES)}`
  const result = scanTempRepo({ 'lib/blob.bin': binary, 'lib/big.js': big }, { username: null, dshHome: null })
  assert.equal(result.scanned, 0)
  assert.equal(result.hitsTotal, 0, '跳过 ≠ 失败：读不动的文件不产生命中')
  assert.equal(result.skipped.length, 2)
  assert.ok(result.skipped.some((item) => item.file === 'lib/blob.bin' && item.reason.includes('二进制')))
  assert.ok(result.skipped.some((item) => item.file === 'lib/big.js' && item.reason.includes('超过单文件上限')))
})

test('隐私扫描：真实 $DSH_HOME 出现在文本里 ⇒ 命中（不通过）', () => {
  const result = scanTempRepo(
    { 'docs/c.md': '记忆目录：/opt/dsh-home/memories\n' },
    { username: null, dshHome: '/opt/dsh-home' },
  )
  assert.equal(result.hitsTotal, 1)
  assert.equal(result.hits[0]?.kind, 'dsh-home')
})

test('隐私扫描：取不到用户名 / 环境里没有 $DSH_HOME 时明说「没有扫」，不假装扫过', () => {
  const result = scanTempRepo({ 'README.md': '干净\n' }, { username: null, dshHome: null })
  assert.deepEqual(result.hits, [])
  assert.ok(result.notes.some((note) => note.includes('本机用户名') && note.includes('没有扫')))
  assert.ok(result.notes.some((note) => note.includes('$DSH_HOME') && note.includes('没有扫')))
})

test('隐私扫描：拿不到 npm pack 清单时这一条**跳过**并说明原因（绝不记成通过）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-skip-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'privacy-skip-probe', version: '0.0.0' }), 'utf8')
    const result = verifySelfContained({ repo: dir, pack: false, npmCache: join(dir, 'npm-cache'), npmTimeoutMs: 1000 })
    const privacy = result.checks.find((check) => check.id === 'privacy')
    assert.ok(privacy !== undefined, '整体结论里必须有 privacy 这一条')
    assert.equal(privacy.status, 'skip', '拿不到清单只能跳过，绝不能记成通过')
    assert.ok(privacy.details.some((line) => line.includes('--no-pack')), `跳过要点名原因：${privacy.details.join(' / ')}`)
    assert.ok(privacy.details.some((line) => line.includes('不是「通过」')), '跳过口径要与工具既有风格一致')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 隐私扫描的对抗性审计修复（tools/verify-self-contained.ts §4）
//
// 审计确认的盲区（当前发布集里没有这些写法，属于**潜在**风险）：
//   · 正斜杠盘符 `C:/work/…`、`D:/…`；
//   · 无尾斜杠的 `see /home/bob`、`see /Users/bob`；
//   · `file:///D:/secret/x.txt`、UNC 网络路径、`~/.ssh/id_rsa`、%USERPROFILE%；
//   · 凭证完全不扫：`sk-`、AKIA、ghp_、xox[baprs]-、私钥头、JWT；
//   · 判据依赖本机用户名与 $DSH_HOME ⇒ CI（ubuntu-latest，username=runner）里这两条等于失效，
//     而 CI 是唯一的自动门。
// 每一条修复都配了「先复现漏判、再证明不再漏」的用例；凭证判据另配一组**不该命中**的反例。
//
// 整段追加在文件末尾：既有用例的断言一条都没改（只把「取本机用户名」那行的输入换成跳过 CI 通用账号）。

/** checkPrivacy 的 pack 检查占位结果：本组用例只测隐私检查本身，pack 部分不参与。 */
function placeholderPackCheck() {
  return { id: 'pack', title: 'pack 检查（占位）', status: 'skip' as const, details: ['本组用例只测隐私检查本身'] }
}

test('隐私扫描：正斜杠盘符（C:/… 与 D:/…）⇒ 命中（审计确认的漏判）', () => {
  const result = scanTempRepo(
    { 'docs/notes.md': '产物在 C:/work/private/notes.md\n备份在 D:/work/private\n' },
    { username: null, dshHome: null },
  )
  assert.equal(result.hitsTotal, 2, `正斜杠盘符必须命中：${JSON.stringify(result.hits)}`)
  assert.deepEqual(result.hits.map((hit) => hit.kind), ['windows-drive-path', 'windows-drive-path'])
  assert.deepEqual(result.hits.map((hit) => hit.line), [1, 2], '两种盘符各给出行号')
})

test('隐私扫描：无尾斜杠的 /home/<name> 与 /Users/<name> ⇒ 命中（审计确认的漏判）', () => {
  const result = scanTempRepo(
    { 'docs/notes.md': 'see /home/bob\nsee /Users/bob\n' },
    { username: null, dshHome: null },
  )
  assert.equal(result.hitsTotal, 2, `无尾斜杠的家目录必须命中：${JSON.stringify(result.hits)}`)
  assert.deepEqual(result.hits.map((hit) => hit.kind), ['posix-home-path', 'posix-home-path'])
  assert.deepEqual(result.hits.map((hit) => hit.line), [1, 2])
})

test('隐私扫描：file:/// 形式的盘符路径 ⇒ 命中（审计确认的漏判）', () => {
  const result = scanTempRepo({ 'docs/a.md': '打开 file:///D:/secret/x.txt\n' }, { username: null, dshHome: null })
  assert.equal(result.hitsTotal, 1)
  assert.equal(result.hits[0]?.kind, 'windows-drive-path')
  assert.equal(result.hits[0]?.line, 1)
})

test('隐私扫描：UNC 网络路径（\\\\host\\share）⇒ 命中（审计确认的漏判）', () => {
  const result = scanTempRepo(
    { 'docs/b.md': '共享私有目录：\\\\fileserver\\share\\private\n' },
    { username: null, dshHome: null },
  )
  assert.equal(result.hitsTotal, 1, `UNC 路径必须命中：${JSON.stringify(result.hits)}`)
  assert.equal(result.hits[0]?.kind, 'unc-path')
  assert.equal(result.hits[0]?.line, 1)
})

test('隐私扫描：家目录简写 ~/… ⇒ 命中（审计确认的漏判）', () => {
  const result = scanTempRepo({ 'docs/c.md': '私钥在 ~/.ssh/id_rsa\n' }, { username: null, dshHome: null })
  assert.equal(result.hitsTotal, 1)
  assert.equal(result.hits[0]?.kind, 'home-shorthand')
})

test('隐私扫描：%USERPROFILE% 路径 ⇒ 命中（审计确认的漏判）', () => {
  const result = scanTempRepo({ 'docs/d.md': '配置在 %USERPROFILE%\\secret\n' }, { username: null, dshHome: null })
  assert.equal(result.hitsTotal, 1)
  assert.equal(result.hits[0]?.kind, 'userprofile-env')
})

test('隐私扫描：常见凭证形状 ⇒ 逐条命中（审计确认「完全不扫凭证」）', () => {
  // ⚠ 夹具**必须现场拼装**，不能写字面量：0.5.21 第一次推送就被 GitHub push protection 拦下
  // （GH013「Push cannot contain secrets」，指向本文件里的 Slack token 形状），
  // 因为 GitHub 看到的是**形状**，不区分"这是测试夹具"。全角/空格拼接既保持形状判据可测，
  // 又不会在提交里出现任何看起来像真密钥的字符串。
  const fake = (head: string, body: string) => `${head}${body}`
  const result = scanTempRepo(
    {
      'docs/keys.md': [
        `api_key = ${fake('sk-' + 'live-', '0123456789abcdefghij')}`,
        `aws_access_key_id = ${fake('AKIA', 'IOSFODNN7EXAMPLE')}`,
        `token: ${fake('ghp' + '_', '0123456789abcdefghijklmnopqrstuvwx')}`,
        `slack = ${fake('xox' + 'b-', '123456789012-abcdefghijklmnop')}`,
        fake('-----BEGIN ', 'RSA PRIVATE KEY-----'),
        '',
      ].join('\n'),
      // 单文件最多列 5 条明细（PRIVACY_MAX_HITS_PER_FILE），所以第 6 种形状放进第二个文件，
      // 保证六种形状都真的被报出来、而不是被明细上限吃掉。
      'docs/jwt.md': 'auth = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.AAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
    },
    { username: null, dshHome: null },
  )
  assert.equal(result.hitsTotal, 6, `六种凭证形状都要命中：${JSON.stringify(result.hits)}`)
  assert.deepEqual(result.hits.map((hit) => hit.kind), [
    'secret-api-key',
    'secret-aws-access-key',
    'secret-github-token',
    'secret-slack-token',
    'secret-private-key',
    'secret-jwt',
  ])
  assert.deepEqual(result.hits.map((hit) => hit.line), [1, 2, 3, 4, 5, 1], '每个命中都要给出行号')
  assert.deepEqual([...new Set(result.hits.map((hit) => hit.file))], ['docs/keys.md', 'docs/jwt.md'])
})

test('隐私扫描：凭证判据的反例（普通长单词 / 前缀单独出现 / 公钥头 / 单段 eyJ）⇒ 不命中', () => {
  const result = scanTempRepo(
    {
      'docs/words.md': [
        'risk-management-strategy-documentation 里出现了 sk- 两个字符。',
        '前缀 sk- 之后才是密钥；sk-learn 只是缩写。',
        'AKIA 是前缀，单独出现不该报。',
        'ghp_ 与 xoxb- 也一样，只有前缀不算凭证。',
        '-----BEGIN PUBLIC KEY----- 是公钥，发布它不算泄漏。',
        '版本号 v1.2.3 与单段 eyJhbGciOiJIUzI1NiJ9 都不是 JWT。',
        '',
      ].join('\n'),
    },
    { username: null, dshHome: null },
  )
  assert.equal(result.hitsTotal, 0, `这些写法都不该命中（宁可窄一点也不误报）：${JSON.stringify(result.hits)}`)
})

test('隐私扫描：路径判据的反例（相对路径段 / 系统 file:/// / 占位 <name> / URL 路径段）⇒ 不命中', () => {
  const result = scanTempRepo(
    {
      'docs/paths.md': [
        '相对路径写作 docs/home/notes.md。',
        '系统文件：file:///etc/hosts',
        '占位写法 /Users/<name> 与 /home/<name> 不算泄漏。',
        'URL 路径段 https://example.com/home/index.html 也不是家目录。',
        '',
      ].join('\n'),
    },
    { username: null, dshHome: null },
  )
  assert.equal(result.hitsTotal, 0, `这些写法都不该命中（否则文档会频繁误报）：${JSON.stringify(result.hits)}`)
})

test('隐私扫描：报告只给 文件 + 行号 + 类型，不回显命中内容', () => {
  const secret = 'sk-live-0123456789abcdefghijklmnop'
  const result = scanTempRepo({ 'docs/keys.md': `key = ${secret}\n` }, { username: null, dshHome: null })
  assert.equal(result.hitsTotal, 1)
  const rendered = JSON.stringify(result)
  assert.ok(!rendered.includes(secret), '命中明细里不能出现命中的内容本身')
  assert.ok(!rendered.includes('sk-live'), '连前缀片段也不该回显（否则等于把密钥誊写进 CI 日志）')
  assert.deepEqual(Object.keys(result.hits[0]!).sort(), ['file', 'kind', 'line'])
})

test('隐私扫描：CI 通用账号（runner / root）不能当身份判据，且必须明说「不可靠、没有扫」', () => {
  assert.equal(isUsableIdentityUsername('runner'), false)
  assert.equal(isUsableIdentityUsername('Runner'), false, '大小写不敏感')
  assert.equal(isUsableIdentityUsername('root'), false)
  assert.equal(isUsableIdentityUsername(''), false, '空串取不到身份')
  assert.equal(isUsableIdentityUsername(null), false)
  assert.equal(isUsableIdentityUsername(undefined), false)
  assert.equal(isUsableIdentityUsername('somebody'), true, '真实用户名仍然是判据')

  // CI：username=runner、没有 $DSH_HOME —— 文本里的 runner / root 是通用词，不该当成「本机用户名」
  const result = scanTempRepo(
    { 'README.md': '在 CI runner 上跑测试，root 用户也能跑。\n' },
    { username: 'runner', dshHome: null },
  )
  assert.equal(result.scanned, 1)
  assert.equal(result.hitsTotal, 0, '通用账号名不是某个人的身份，报出来就是假阳性')
  assert.deepEqual(result.unavailable.map((item) => item.kind), ['username', 'dsh-home'])
  assert.ok(
    result.notes.some((note) => note.includes('本机用户名') && note.includes('不可靠') && note.includes('没有扫')),
    `必须明说这条判据没扫：${result.notes.join(' / ')}`,
  )
  assert.ok(
    result.notes.some((note) => note.includes('$DSH_HOME') && note.includes('没有扫')),
    `必须明说 $DSH_HOME 没扫：${result.notes.join(' / ')}`,
  )
  assert.ok(
    result.notes.every((note) => note.includes('跳过 ≠ 通过')),
    `沿用既有「跳过 ≠ 通过」的措辞：${result.notes.join(' / ')}`,
  )
})

test('隐私检查：判据在本次环境下不可靠 ⇒ 整条**跳过**并明说，不静默给「干净」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-privacy-check-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'privacy-check-probe', version: '0.0.0' }), 'utf8')
    writeFileSync(join(dir, 'README.md'), '这不是泄漏，只是一份文档。\n', 'utf8')
    const options = { repo: dir, pack: false, npmCache: join(dir, 'npm-cache'), npmTimeoutMs: 1000 }

    // CI 环境：username=runner、没有 $DSH_HOME —— 两条身份判据失效，0 命中不等于「干净」
    const ci = checkPrivacy(options, placeholderPackCheck(), ['README.md'], { username: 'runner', dshHome: null })
    assert.equal(ci.status, 'skip', '判据不可靠时只能跳过，不能记成通过')
    // 「干净」是这一条通过时的结论句（`干净：已扫过的 …`）；跳过时不许出现它。
    assert.ok(!ci.details.some((line) => line.startsWith('干净')), `跳过时不许给「干净」结论：${ci.details.join(' / ')}`)
    assert.ok(ci.details.some((line) => line.includes('本机用户名') && line.includes('没有扫')))
    assert.ok(ci.details.some((line) => line.includes('跳过 ≠ 通过')), '口径要与工具既有风格一致')

    // 判据齐全 + 真的干净 ⇒ 才说「干净」
    const full = checkPrivacy(options, placeholderPackCheck(), ['README.md'], { username: 'somebody', dshHome: '/opt/dsh-home' })
    assert.equal(full.status, 'pass')
    assert.ok(full.details.some((line) => line.includes('干净')), `判据齐全时要明确说干净：${full.details.join(' / ')}`)

    // 命中优先于不可靠：CI 里照样因为凭证命中而失败
    writeFileSync(join(dir, 'keys.md'), 'key = sk-live-0123456789abcdefghijklmnop\n', 'utf8')
    const leaked = checkPrivacy(options, placeholderPackCheck(), ['keys.md'], { username: 'runner', dshHome: null })
    assert.equal(leaked.status, 'fail', '凭证命中必须失败，不能被「判据不可靠」冲淡')
    assert.ok(leaked.details.some((line) => line.includes('命中') && line.includes('keys.md:1')))
    assert.ok(leaked.details.some((line) => line.includes('API 密钥')), '命中类型要说清楚')
    assert.ok(!leaked.details.some((line) => line.includes('sk-live')), '命中明细不回显内容')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('隐私扫描：本仓真实发布内容在新判据下依然干净（回归闸门，防假阳性）', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const { readdirSync } = await import('node:fs')
  const files = ['README.md', 'README.zh.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE', 'cordis.patch.yml']
  for (const dir of ['docs', 'lib']) {
    for (const name of readdirSync(join(repoRoot, dir), { recursive: true, encoding: 'utf8' as const })) {
      files.push(`${dir}/${name.replaceAll('\\', '/')}`)
    }
  }
  const result = scanReleasePrivacy({
    repo: repoRoot,
    files,
    // 注入两个本仓绝不可能出现的身份值：这组用例只关心路径判据与凭证判据在真实内容上会不会误报。
    username: 'privacy-probe-user',
    dshHome: '/opt/dsh-home-probe',
  })
  assert.deepEqual(result.hits, [], `新判据不该在本仓真实文档/产物上误报：${JSON.stringify(result.hits)}`)
  assert.equal(result.scanned, files.length, '所有真实发布内容都要真的被扫过（含 source map）')
  assert.deepEqual(result.unavailable, [], '身份判据是注入的，这里不该有「没有扫」的判据')
})

// ─────────────────────────────────────────────────────────────────────────────
// 变异测试工具（tools/mutate.ts）
//
// 为什么测它：这个工具是「测试自己够不够硬」的裁判，它一旦骗自己（把没跑成当被杀死、
// 把目录过期当已变异、把副本污染当结果），整套体检数字就全是假的。所以这里钉住三件事：
//   · 目录不许过期（每条 find 必须在真实文件里逐字节存在且只出现一次）；
//   · 抽样必须可复现（同种子同批）；
//   · 端到端用**玩具仓库**验证判定与退出码 —— 不跑真实仓库（那样一次几十秒，测试会变成负担）。
//
// 整段追加在文件末尾：既有用例的断言一条都没改（ESM 的 import 声明会提升，写在后面同样生效）。

import { applyMutation, mutationCatalogue, parseArgs, runMutationTesting, sampleMutations } from '../tools/mutate.ts'
import type { Mutation } from '../tools/mutate.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

test('applyMutation：精确替换第一处；多行 find 也命中；找不到 find 必须抛错', () => {
  const base = (over: Partial<Mutation>): Mutation => ({
    id: 'probe',
    file: 'src/probe.ts',
    find: 'foo',
    replace: 'bar',
    note: '探针',
    ...over,
  })

  assert.equal(applyMutation('foo foo foo', base({})), 'bar foo foo', '只替换第一处')
  assert.equal(applyMutation('前缀 foo 后缀', base({})), '前缀 bar 后缀')
  assert.equal(applyMutation('x\ny z\n', base({ find: 'x\ny', replace: 'X\nY' })), 'X\nY z\n', '多行 find 也要能命中')
  assert.equal(applyMutation('没变', base({ find: '没变', replace: '没变' })), '没变')

  // 找不到 find ⇒ 抛错，绝不静默返回原文当「已变异」（那样跑出来的全绿是没改过代码的成绩单）
  assert.throws(() => applyMutation('别的文本', base({ id: 'missing-entry' })), /missing-entry/u, '报错要点名是哪条变异')
  assert.throws(() => applyMutation('别的文本', base({ id: 'missing-entry', file: 'src/lib.ts' })), /src\/lib\.ts/u, '报错要能定位到文件')
})

test('mutationCatalogue：id 唯一、note 非空；每条 find 在真实仓库文件里恰好出现一次（防目录过期）', () => {
  // 在变异副本里跑测试时，`DSH_MUTATE_SOURCE_REPO` 指向**未变异**的原仓库：
  // 否则任何一条变异都会先把这条断言弄红 —— 于是所有变异都被误判成「被杀死」，
  // 裁判自己把观测搅浑。正常跑测试时它不存在，就用当前仓库。
  const repoRoot = process.env.DSH_MUTATE_SOURCE_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..')
  const catalogue = mutationCatalogue()

  assert.ok(catalogue.length >= 20 && catalogue.length <= 30, `目录应在 20–30 条之间，实际 ${catalogue.length} 条`)
  assert.equal(new Set(catalogue.map((mutation) => mutation.id)).size, catalogue.length, 'id 必须唯一（--only 靠它点名）')

  for (const mutation of catalogue) {
    assert.ok(mutation.note.trim().length > 0, `变异 ${mutation.id} 的 note 不能为空（存活项要靠它解释）`)
    assert.notEqual(mutation.find, mutation.replace, `变异 ${mutation.id} 的替换必须真的改变内容`)
    const text = readFileSync(join(repoRoot, mutation.file), 'utf8')
    const occurrences = text.split(mutation.find).length - 1
    assert.equal(
      occurrences,
      1,
      `变异 ${mutation.id} 的 find 应在 ${mutation.file} 里恰好出现一次（实际 ${occurrences} 次）—— 目录过期要立刻发现`,
    )
  }
})

test('parseArgs：默认值、--limit（含 0 与非法值）、--seed、--only、--list、--json、--keep', () => {
  assert.deepEqual(
    parseArgs([]),
    { limit: 8, seed: 20261004, only: null, list: false, json: false, keep: false },
    '默认抽样 8 条、种子固定（可复现）',
  )
  assert.equal(parseArgs(['--limit', '3']).limit, 3)
  assert.equal(parseArgs(['--limit', '0']).limit, 0, '0 = 不抽样、跑整个目录（不是默认值）')
  assert.equal(parseArgs(['--limit', 'abc']).limit, 8, '非法值回落默认，绝不把 NaN 当「跑 0 条」')
  assert.equal(parseArgs(['--limit', '-2']).limit, 8, '负数非法')
  assert.equal(parseArgs(['--limit', '2.5']).limit, 8, '小数非法')
  assert.equal(parseArgs(['--limit']).limit, 8, '缺值同样回落默认')
  assert.equal(parseArgs(['--seed', '7']).seed, 7)
  assert.equal(parseArgs(['--seed', 'oops']).seed, 20261004, '种子非法时回落固定默认值')
  assert.equal(parseArgs(['--only', 'recall-limit-floor']).only, 'recall-limit-floor')
  assert.equal(parseArgs(['--only']).only, null, '--only 缺值＝没指定')
  assert.equal(parseArgs(['--list']).list, true)
  assert.equal(parseArgs(['--json']).json, true)
  assert.equal(parseArgs(['--keep']).keep, true)
  // 未知参数忽略（与仓库既有 tools/*.ts 一致），且不妨碍它后面的参数
  assert.equal(parseArgs(['--unknown', '--limit', '4']).limit, 4)
})

test('sampleMutations：同 (limit, seed) 抽到同一批；换种子换一批；limit 0 或超过目录 ⇒ 整份目录', () => {
  const catalogue = mutationCatalogue()
  const first = sampleMutations(catalogue, 6, 20261004).map((mutation) => mutation.id)
  const again = sampleMutations(catalogue, 6, 20261004).map((mutation) => mutation.id)
  const other = sampleMutations(catalogue, 6, 1).map((mutation) => mutation.id)

  assert.equal(first.length, 6)
  assert.deepEqual(first, again, '同一条命令每次必须抽到同一批（报告数字才可复现）')
  assert.notDeepEqual(other, first, '换种子应当换一批，而不是照抄目录前 6 条')
  assert.deepEqual(
    sampleMutations(catalogue, 0, 1).map((mutation) => mutation.id),
    catalogue.map((mutation) => mutation.id),
    'limit 0 = 整份目录',
  )
  assert.equal(sampleMutations(catalogue, catalogue.length + 5, 1).length, catalogue.length)
})

/** 造一个纯 JS 的玩具仓库：一个 src + 一个会红/会绿的假测试（这里只验证「改一处 → 跑测试 → 判定」链路）。 */
function makeToyRepo(root: string): string {
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-mutate-toy', version: '0.0.0', type: 'module' }), 'utf8')
  const source = join(root, 'src', 'value.js')
  writeFileSync(
    source,
    [
      'export function add(a, b) {',
      '  return a + b',
      '}',
      '',
      'export const UNUSED = 1',
      '',
      'export function double(x) {',
      '  return x * 2',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(root, 'tests', 'toy.test.js'),
    [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { add, double } from '../src/value.js'",
      '',
      "test('add', () => { assert.equal(add(1, 1), 2) })",
      "test('double', () => { assert.equal(double(3), 6) })",
      '',
    ].join('\n'),
    'utf8',
  )
  return source
}

test('runMutationTesting：玩具仓库端到端 —— 必被杀死 / 必存活 / 退出码 / 不碰原仓库 / 收尾清理', () => {
  const outer = mkdtempSync(join(tmpdir(), 'dsh-mutate-e2e-'))
  try {
    const repo = join(outer, 'toy')
    const sourcePath = makeToyRepo(repo)
    const original = readFileSync(sourcePath, 'utf8')
    const workRoot = join(outer, 'work')
    const testCommand = { command: process.execPath, args: ['--test', 'tests/toy.test.js'] }
    const killed: Mutation = {
      id: 'toy-killed',
      file: 'src/value.js',
      find: '  return a + b',
      replace: '  return a - b',
      note: '加法改成减法：假测试必须红',
    }
    const survived: Mutation = {
      id: 'toy-survived',
      file: 'src/value.js',
      find: 'export const UNUSED = 1',
      replace: 'export const UNUSED = 2',
      note: '没人引用的常量：假测试照样全绿',
    }

    // ① 一条必被杀死 + 一条必存活：判定、计数、退出码都要对
    const both = runMutationTesting({ repo, mutations: [killed, survived], build: null, test: testCommand, workRoot })
    assert.equal(both.error, null, `不该有环境问题：${both.error}`)
    assert.deepEqual(both.outcomes.map((outcome) => outcome.verdict), ['killed', 'survived'])
    assert.equal(both.tried, 2)
    assert.equal(both.killed, 1)
    assert.equal(both.survived, 1)
    assert.equal(both.buildErrors, 0)
    assert.notEqual(both.exitCode, 0, '存在存活 ⇒ 非零（体检不合格的信号）')
    assert.equal(both.workdir, null, '默认不保留副本')
    assert.ok(both.outcomes[0]!.detail.length > 0, '被杀死的那条要带上失败证据')
    assert.ok(both.outcomes[1]!.detail.includes('全绿'), `存活的那条要说明「测试仍全绿」：${both.outcomes[1]!.detail}`)
    assert.deepEqual(readdirSync(workRoot), [], '跑完必须把副本清掉（只留空的工作目录）')

    // ② 只跑「必被杀死」的那条：全部被杀死 ⇒ 退出码 0
    const allKilled = runMutationTesting({ repo, mutations: [killed], build: null, test: testCommand, workRoot })
    assert.equal(allKilled.killed, 1)
    assert.equal(allKilled.survived, 0)
    assert.equal(allKilled.exitCode, 0, '全部被杀死 ⇒ 0')
    assert.deepEqual(readdirSync(workRoot), [], '这一次同样要清干净')

    // ③ 绝不改原仓库（工具只在副本里改文件）
    assert.equal(readFileSync(sourcePath, 'utf8'), original, '原仓库的源文件必须逐字节不变')

    // ④ --keep：保留副本以便排查，而且仍然不碰原仓库
    const kept = runMutationTesting({ repo, mutations: [survived], build: null, test: testCommand, workRoot, keep: true })
    assert.equal(kept.kept, true)
    assert.ok(kept.workdir !== null && existsSync(kept.workdir), '--keep 时副本要留在硬盘上')
    // 副本根里除了每条的副本目录，还有这条命令的日志（1-test.log）：按「含有源文件」筛出副本。
    const keptCopies = readdirSync(kept.workdir).filter((name) => existsSync(join(kept.workdir!, name, 'src', 'value.js')))
    assert.equal(keptCopies.length, 1, '--keep 时这条变异的副本应当留着（正好一份）')
    const keptSource = join(kept.workdir, keptCopies[0]!, 'src', 'value.js')
    assert.ok(existsSync(keptSource), `保留的副本里要有源文件：${keptSource}`)
    assert.ok(readFileSync(keptSource, 'utf8').includes('UNUSED = 2'), '副本里应当真的是变异后的文件')
    assert.equal(readFileSync(sourcePath, 'utf8'), original, '保留副本也不能碰原仓库')
    rmSync(kept.workdir, { recursive: true, force: true })
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

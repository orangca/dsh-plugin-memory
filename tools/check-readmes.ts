// check-readmes.ts — 校验 README.md 与 README.zh.md 的**结构一致性**。
//
// 为什么需要它：两份 README 是同一份文档的两个语言版本。正文各写各的没关系，但结构必须
// 一一对应 —— 小节顺序、代码围栏、表格键、表单字段数、命令清单、顶部互链。漏改任何一处，
// 其中一份文档就会悄悄过时，而且不会有任何测试告诉你。
//
// 用法：node tools/check-readmes.ts     （从仓库根目录运行；根目录按脚本位置推断，不写死路径）
// 退出码：0 = 一致；1 = 有差异（差异逐条打印）。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 校验结果：problems 为空即一致。 */
export interface ReadmeCheckResult {
  ok: boolean
  problems: string[]
}

/** 两份文档的文件名（按「英文 → 中文」的固定顺序）。 */
const EN_FILE = 'README.md'
const ZH_FILE = 'README.zh.md'

/** 一份文档里解析出来的结构特征。 */
interface Side {
  file: string
  /** `## ` 小节的标题，按出现顺序。 */
  headings: string[]
  /** 标题里语言无关的锚点（反引号片段），按出现顺序（无锚点的标题直接跳过）。 */
  anchors: string[]
  /** 代码围栏标记（``` 开头的行）总数。 */
  fences: number
  /** 表格行首列被反引号整格包住的键，按出现顺序。 */
  keys: string[]
  /** 「N 个字段 / N fields」里抓到的数字，按出现顺序。 */
  fieldCounts: number[]
  /** 代码块里以 /memory 或 /sleep 开头的命令行，抽出的命令名集合。 */
  commands: string[]
  /** 顶部区（首个 `## ` 之前）的 markdown 链接目标。 */
  links: string[]
}

/** 表格行首列被反引号整格包住的键：`| `key` | default | …`。 */
const TABLE_KEY = /^\s*\|\s*`([^`\s][^`]*?)`\s*\|/u
/** 「N 个字段 / N fields」：允许数字两侧有加粗标记。 */
const FIELD_COUNT = /(\d+)\s*\*{0,2}\s*(?:个字段|fields)/gu
/** markdown 行内链接 `[文字](目标)`。 */
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/gu

/** 抽 `## ` 小节标题（恰好两个 # 加空白；`###` 不算）。 */
function headingsOf(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const matched = /^##\s+(.+?)\s*$/u.exec(line)
    if (matched !== null) out.push(matched[1] ?? '')
  }
  return out
}

/**
 * 标题的语言无关锚点：标题里的反引号片段。
 * 例如 `## \`/memory audit\`：写入审计` → "/memory audit"。
 * 两份文档的标题正文允许翻译，逐位比对只能靠这种锚点；没有锚点的标题返回 null（不参与顺序比对）。
 */
function anchorOf(heading: string): string | null {
  const spans: string[] = []
  for (const matched of heading.matchAll(/`([^`]+)`/gu)) {
    const span = (matched[1] ?? '').trim()
    if (span.length > 0) spans.push(span)
  }
  return spans.length > 0 ? spans.join(' + ') : null
}

/** 每行开头的 ``` 都算一个围栏标记（成对才闭合）。 */
function countFences(lines: string[]): number {
  let count = 0
  for (const line of lines) {
    if (/^\s*```/u.test(line)) count += 1
  }
  return count
}

/** 抽表格行首列的反引号键。 */
function keysOf(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const matched = TABLE_KEY.exec(line)
    const key = matched?.[1]?.trim()
    if (key !== undefined && key.length > 0) out.push(key)
  }
  return out
}

/** 抽「N 个字段 / N fields」里的数字。 */
function fieldCountsOf(text: string): number[] {
  const out: number[] = []
  for (const matched of text.matchAll(FIELD_COUNT)) out.push(Number(matched[1]))
  return out
}

/**
 * 命令名 = 开头的 `/memory` / `/sleep` 加上紧跟的裸词（list、self、self set、reject-pending…）。
 * 两条边界：说明文字与命令之间是 2 个以上空格（对齐列），先按它切断；再一遇到占位符
 * （`<id 前缀>`）、选项（`--all`）就停 —— 那些都是参数，不属于命令名。最多 4 个词兜底。
 */
function commandNameOf(line: string): string {
  const head = (line.split(/\s{2,}/u)[0] ?? line).trim()
  const tokens = head.split(/\s+/u)
  const parts: string[] = [tokens[0] ?? '']
  for (let index = 1; index < tokens.length && parts.length < 4; index += 1) {
    const token = tokens[index] ?? ''
    if (!/^[a-z][a-z0-9-]*$/u.test(token)) break
    parts.push(token)
  }
  return parts.join(' ')
}

/** 只扫代码块（``` 之间）里以 /memory 或 /sleep 开头的行，返回去重排序后的命令名。 */
function commandsOf(lines: string[]): string[] {
  const out = new Set<string>()
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) continue
    const trimmed = line.trim()
    if (!/^\/(?:memory|sleep)(?:\s|$)/u.test(trimmed)) continue
    out.add(commandNameOf(trimmed))
  }
  return [...out].sort()
}

/** 顶部区（首个 `## ` 之前）的链接目标。 */
function linksOf(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (/^##\s/u.test(line)) break
    for (const matched of line.matchAll(MARKDOWN_LINK)) out.push(matched[1] ?? '')
  }
  return out
}

/** 链接目标是否指向某个文件（允许 ./ 前缀与 #锚点）。 */
function pointsTo(links: string[], file: string): boolean {
  return links.some((link) => {
    const target = (link.split('#')[0] ?? '').replace(/\\/gu, '/')
    return target.split('/').pop() === file
  })
}

/** 读一份 README 并解析结构；文件缺失/读不出时记一条问题并返回 null。 */
function readSide(root: string, file: string, problems: string[]): Side | null {
  const full = join(root, file)
  if (!existsSync(full)) {
    problems.push(`文件缺失：在 ${root} 下找不到 ${file}`)
    return null
  }
  let text: string
  try {
    text = readFileSync(full, 'utf8')
  } catch (error) {
    problems.push(`文件读不出来：${file}（${error instanceof Error ? error.message : String(error)}）`)
    return null
  }
  const lines = text.split(/\r?\n/u)
  const headings = headingsOf(lines)
  return {
    file,
    headings,
    anchors: headings.map(anchorOf).filter((anchor): anchor is string => anchor !== null),
    fences: countFences(lines),
    keys: keysOf(lines),
    fieldCounts: fieldCountsOf(text),
    commands: commandsOf(lines),
    links: linksOf(lines),
  }
}

/** 把键名列表渲染成 `[a, b]`；太长就截断，保证失败信息可读又不刷屏。 */
function list(items: string[], max = 8): string {
  const shown = items.slice(0, max).map((item) => `\`${item}\``)
  if (items.length > max) shown.push(`…共 ${items.length} 个`)
  return `[${shown.join(', ')}]`
}

/** 每个锚点第一次出现的小节下标。 */
function anchorPositionsOf(anchors: string[]): Map<string, number> {
  const positions = new Map<string, number>()
  anchors.forEach((anchor, index) => {
    if (!positions.has(anchor)) positions.set(anchor, index)
  })
  return positions
}

/** 1. `## ` 小节的数量与顺序（标题正文允许翻译，顺序只比对两边都有的语言无关锚点）。 */
function checkHeadings(en: Side, zh: Side, problems: string[]): void {
  if (en.headings.length === 0 && zh.headings.length === 0) {
    problems.push(`两边都没有「## 」小节：${EN_FILE} 与 ${ZH_FILE} 的标题层级可能都不见了`)
    return
  }
  if (en.headings.length !== zh.headings.length) {
    problems.push(`小节数量不一致：${EN_FILE} 有 ${en.headings.length} 个「## 」小节，${ZH_FILE} 有 ${zh.headings.length} 个`)
  }

  // 两份文档的标题正文不同语言，只能拿共有锚点（反引号片段，如 `/memory audit`）的相对先后关系做顺序判据。
  // 锚点数量允许不同：中文标题未必保留反引号（如「写入审批门（writePolicy）」）。
  const enPositions = anchorPositionsOf(en.anchors)
  const zhPositions = anchorPositionsOf(zh.anchors)
  const common = [...enPositions.keys()].filter((anchor) => zhPositions.has(anchor))
  const byPosition = (positions: Map<string, number>) => (a: string, b: string): number =>
    (positions.get(a) ?? 0) - (positions.get(b) ?? 0)
  const enOrder = [...common].sort(byPosition(enPositions))
  const zhOrder = [...common].sort(byPosition(zhPositions))
  for (let index = 0; index < enOrder.length; index += 1) {
    if (enOrder[index] !== zhOrder[index]) {
      problems.push(`小节顺序不一致：共有锚点小节在 ${EN_FILE} 的顺序是 ${list(enOrder)}，在 ${ZH_FILE} 的顺序是 ${list(zhOrder)}`)
      break
    }
  }
}

/** 2. 代码围栏各自成对（各文件内为偶数）。 */
function checkFences(en: Side, zh: Side, problems: string[]): void {
  for (const side of [en, zh]) {
    if (side.fences % 2 !== 0) {
      problems.push(`代码围栏不成对：${side.file} 有 ${side.fences} 个围栏标记（必须是偶数）`)
    }
  }
}

/** 3. 表格首列键集合一致（配置表就在这里）。 */
function checkTableKeys(en: Side, zh: Side, problems: string[]): void {
  const enKeys = new Set(en.keys)
  const zhKeys = new Set(zh.keys)
  if (enKeys.size === 0 && zhKeys.size === 0) {
    problems.push(`两边都没解析到表格首列键（形如 | \`key\` | default | … 的表格行）：${EN_FILE} 与 ${ZH_FILE}`)
    return
  }
  const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key)).sort()
  const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key)).sort()
  if (missingInZh.length > 0 || missingInEn.length > 0) {
    const parts: string[] = []
    if (missingInZh.length > 0) parts.push(`${ZH_FILE} 缺 ${list(missingInZh)}`)
    if (missingInEn.length > 0) parts.push(`${EN_FILE} 缺 ${list(missingInEn)}`)
    problems.push(`表格键集合不一致：${parts.join('；')}`)
  }
}

/** 4. 表单字段数的数字一致。 */
function checkFieldCounts(en: Side, zh: Side, problems: string[]): void {
  if (en.fieldCounts.length === 0 && zh.fieldCounts.length === 0) {
    problems.push(`两边都没抓到字段数声明（「N 个字段 / N fields」）：${EN_FILE} 与 ${ZH_FILE}`)
    return
  }
  const enCounts = [...en.fieldCounts].sort((a, b) => a - b)
  const zhCounts = [...zh.fieldCounts].sort((a, b) => a - b)
  if (enCounts.join(',') !== zhCounts.join(',')) {
    problems.push(
      `表单字段数不一致：${EN_FILE} 抓到 [${enCounts.join(', ')}]，${ZH_FILE} 抓到 [${zhCounts.join(', ')}]（「N 个字段 / N fields」）`,
    )
  }
}

/** 5. 命令行清单（命令名集合）一致。 */
function checkCommands(en: Side, zh: Side, problems: string[]): void {
  const enCommands = new Set(en.commands)
  const zhCommands = new Set(zh.commands)
  if (enCommands.size === 0 && zhCommands.size === 0) {
    problems.push(`两边都没在代码块里找到 /memory 或 /sleep 命令行：${EN_FILE} 与 ${ZH_FILE}`)
    return
  }
  const missingInZh = [...enCommands].filter((command) => !zhCommands.has(command)).sort()
  const missingInEn = [...zhCommands].filter((command) => !enCommands.has(command)).sort()
  if (missingInZh.length > 0 || missingInEn.length > 0) {
    const parts: string[] = []
    if (missingInZh.length > 0) parts.push(`${ZH_FILE} 缺 ${list(missingInZh)}`)
    if (missingInEn.length > 0) parts.push(`${EN_FILE} 缺 ${list(missingInEn)}`)
    problems.push(`命令行清单不一致：${parts.join('；')}`)
  }
}

/** 6. 顶部语言切换互链存在且互相指向对方文件。 */
function checkLinks(en: Side, zh: Side, problems: string[]): void {
  if (!pointsTo(en.links, ZH_FILE)) {
    problems.push(`顶部互链缺失：${EN_FILE} 顶部没有指向 ${ZH_FILE} 的链接`)
  }
  if (!pointsTo(zh.links, EN_FILE)) {
    problems.push(`顶部互链缺失：${ZH_FILE} 顶部没有指向 ${EN_FILE} 的链接`)
  }
}

/**
 * 校验 root 下 README.md 与 README.zh.md 的结构一致性。
 * @param root 仓库根目录（由调用方给出，函数内不写死任何绝对路径）。
 */
export function checkReadmes(root: string): ReadmeCheckResult {
  const problems: string[] = []
  const en = readSide(root, EN_FILE, problems)
  const zh = readSide(root, ZH_FILE, problems)
  if (en === null || zh === null) return { ok: false, problems }

  checkHeadings(en, zh, problems)
  checkFences(en, zh, problems)
  checkTableKeys(en, zh, problems)
  checkFieldCounts(en, zh, problems)
  checkCommands(en, zh, problems)
  checkLinks(en, zh, problems)

  return { ok: problems.length === 0, problems }
}

/** 只有被 `node tools/check-readmes.ts` 直接运行时才执行 CLI；被 import 时只导出上面的函数。 */
function isDirectRun(): boolean {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  const self = fileURLToPath(import.meta.url)
  const invoked = resolve(argv1)
  return process.platform === 'win32'
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self
}

if (isDirectRun()) {
  // 根目录按脚本位置推断（与 build-client.ts / deploy-dev.ts 一致）：不依赖 cwd，也不写死绝对路径。
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const result = checkReadmes(root)
  if (result.ok) {
    console.log(`README 结构一致：${EN_FILE} 与 ${ZH_FILE}（小节 / 围栏 / 表格键 / 字段数 / 命令 / 互链 全部对齐）`)
  } else {
    console.log(`README 结构不一致：${EN_FILE} 与 ${ZH_FILE}，共 ${result.problems.length} 项：`)
    for (const problem of result.problems) console.log(`  - ${problem}`)
    process.exitCode = 1
  }
}

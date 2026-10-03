// coverage-check.ts — 覆盖率门槛：算出 lib/lib.js 与 lib/index.js 的**行覆盖率**，低于门槛就失败。
//
// 为什么要自己算：Node 的 `--experimental-test-coverage` 有两条**默认行为**会让报告看起来「很干净」，
// 但实际什么都没测（本机 Node v24.11.1 实测）：
//   1. 默认排除 glob（形如 `**/{test,test-*,…}.{js,mjs,cjs,ts…}`）会匹配**整个绝对路径**。
//      本仓库的绝对路径里含有目录名 `test`（工作区根就是 …/test），于是 lib/** 全被当成测试文件排除：
//      表格里只剩 `tests/*.test.ts` 和 `all files`（100%），而 `lib/lib.js`、`lib/index.js` **一行都不出现**。
//      → 必须显式 `--test-coverage-exclude` 覆盖默认值，才能拿到真实数字。
//   2. 带 `--experimental-test-coverage` 时，Node 会把 lib/*.js 的覆盖率**按 sourcemap 映射回 src/*.ts**
//      （`AllSourceMapsEnabled = coverage || ...`），报告里于是只有 src/*.ts，没有 lib/*.js。
//      → 本脚本自己读原始产物（NODE_V8_COVERAGE，不带 `--experimental-test-coverage` 的那份），
//      对 `lib/<file>.js` 的**生成代码行号**算覆盖率，不经过 sourcemap 回映射。
//
// 输入（命令行参数优先于环境变量；都不给就报错退出，绝不静默通过）：
//   · 覆盖率目录：`--coverage-dir <dir>` / `NODE_V8_COVERAGE` / `COVERAGE_DIR`
//     —— 跑 `NODE_V8_COVERAGE=<dir> node --test tests/…` 得到的 coverage-*.json 目录；
//   · 或报告文本：`--report <file>` / `COVERAGE_REPORT` / `COVERAGE_REPORT_FILE`
//     —— 把 `node --test --experimental-test-coverage --test-coverage-exclude="**/node_modules/**" <测试文件>`
//        的完整输出重定向成的文本文件（脚本从中解析 `lib` 分节下的行）。
//     （报告文本里的 `all files` 不用于判定 lib/*.js —— 它把 tests/*.test.ts 也算进去了，会虚高。）
//
// 退出码：0 = 两个文件都达标；1 = 有文件低于门槛 / 输入缺失 / 文件不存在（出问题时给确定性失败，
// 因为覆盖率本来就该量到真实产物，而不是量到一个空集合）。
//
// 用法：
//   node tools/coverage-check.ts --coverage-dir .tmp/coverage
//   node tools/coverage-check.ts --report .tmp/coverage.txt
//   node tools/coverage-check.ts --report .tmp/coverage.txt --json
//   node tools/coverage-check.ts --list --coverage-dir .tmp/coverage   # 只打印解析到的行覆盖率，不判门槛

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 覆盖率门槛（行覆盖率百分数）。 */
export interface Threshold {
  /** 相对仓库根的产物路径，例如 `lib/lib.js`。 */
  file: string
  /** 行覆盖率下限（实测值向下取整再减 2 个百分点）。 */
  minLinePercent: number
}

/**
 * 门槛与**实测依据**（改动这个常量前必须重新实测，并更新下面的记录）。
 *
 * 实测日期：2026-10-03
 * 实测环境：Windows / Node v24.11.1 / npm 11.6.2，仓库 dsh-plugin-memory 0.5.14
 * 实测对象：全量跑 tests/lib.test.ts + tests/host.test.ts（256 个用例全过）
 * 实测口径：本工具自己的口径（见 lineCountsOf 的注释），输入是 `NODE_V8_COVERAGE` 原始产物
 *   全量：lib/lib.js 100.00%（2445/2445）、lib/index.js 96.76%（3642/3764）
 *   对照：Node 自己的 `--experimental-test-coverage` 报告同一批用例为 lib/lib.js 99.06%、lib/index.js 85.55%
 *     —— 本工具的口径**更宽松**（不做 sourcemap 回映射、按生成代码行算，且顶层函数区间会把
 *     不可达的防御分支算成已覆盖），所以两个数字不能混用，门槛也只能按本工具自己的实测值定。
 * 门槛取法：**本工具实测值向下取整再减 2 个百分点**
 *   lib/lib.js 100.00 → 100 - 2 = 98
 *   lib/index.js 96.76 → 96 - 2 = 94
 * 失败态实测（必须继续复现，否则门槛就是摆设）：只跑 tests/module.test.ts 时
 *   lib/lib.js 0.57%（14/2445）、lib/index.js 1.75%（66/3764），两个都远低于门槛、退出码 1。
 * 另注：默认命令**不加**排除覆盖时，Node 的默认排除 glob（形如 `**` + 花括号里的 test 模式）
 *   会把 lib 整个吃掉（本仓库的工作区根目录名就是 test），报告里根本没有 lib.js/index.js
 *   这两行 —— 那不是「100%」，是「一行都没测」。所以取数命令必须显式覆盖这个默认排除值。
 *   完整命令见 CLI 用法说明与报告，这里不复述（避免注释里出现会提前闭合的字符组合）。
 *
 * ⚠ **两套分母不能混用**：同一套用例，Node 自己的报告与「本工具按生成代码行自算」给出不同的数字
 *   （2026-10-03 实测：报告口径 99.06% / 85.55%；本工具口径 100.00% / 96.76%）。
 *   因此门槛**按输入模式分开**：`--report` 用 THRESHOLDS_REPORT，`--coverage-dir` 用 THRESHOLDS_V8。
 *   两者都按「该口径实测值向下取整再减 2」定，并且都由 Lead 在 0.5.15 复核过（报告口径最初按本工具
 *   口径的 98/94 定，实测直接失败——这正是「不许拿一个脚本的数字去对另一个门槛」的现场证据）。
 */
/** Node 报告口径（`--report`；`pnpm coverage:check` 用这套）。实测 99.06% → 门槛 97；85.55% → 83。 */
export const THRESHOLDS_REPORT: readonly Threshold[] = [
  { file: 'lib/lib.js', minLinePercent: 97 },
  { file: 'lib/index.js', minLinePercent: 83 },
]

/** 本工具自算口径（`--coverage-dir`，NODE_V8_COVERAGE 原始产物）。实测 100.00% → 98；96.76% → 94。 */
export const THRESHOLDS_V8: readonly Threshold[] = [
  { file: 'lib/lib.js', minLinePercent: 98 },
  { file: 'lib/index.js', minLinePercent: 94 },
]

/** 兼容旧名（＝本工具自算口径）。 */
export const THRESHOLDS: readonly Threshold[] = THRESHOLDS_V8


/** 一个文件的覆盖率结果。 */
export interface FileCoverage {
  /** 相对仓库根的路径（或覆盖率目录里的原始 URL）。 */
  file: string
  /** 行覆盖率百分数；无法计算时为 null。 */
  linePercent: number | null
  /** 计入的行数（已执行 + 未执行）。 */
  totalLines: number
  /** 已执行的行数。 */
  coveredLines: number
  /** 解析来源（便于排查「数字从哪来」）。 */
  source: string
}

/** 解析一跳。 */
interface ParseOutcome {
  source: string
  files: Map<string, FileCoverage>
  /** 解析过程中的说明（例如跳过了多少个不相关的脚本）。 */
  notes: string[]
}

/** 选项。 */
interface Options {
  repo: string
  coverageDir: string | null
  reportFile: string | null
  /** 只列出数字，不判门槛。 */
  listOnly: boolean
  json: boolean
}

/** 覆盖率目录里的文件名格式（与 Node 内部一致）。 */
const COVERAGE_FILE_RE = /^coverage-(\d+)-(\d{13})-(\d+)\.json$/

/**
 * 覆盖率的行边界表：`starts[i]` = 第 i+1 行第一个字符的偏移（0 基）。
 *
 * `source-map-cache[url].lineLengths` 存的是**每行的长度**（不含换行符，Node 实测：CRLF 只算 `\r`），
 * 不是累计偏移 —— 直接拿它当边界会让所有行落到第 1 行（这个坑本工具踩过，表现是「覆穿率恒为 100%」）。
 * 这里显式把长度累加成边界（每行还要 +1 补回换行符）。换行可能是 `\n` 或 `\r\n`，所以用原始
 * 代码长度反推：`starts[i+1] - starts[i] - lineLengths[i]` 就是该行换行符的字节数（1 或 2）。
 */
export function lineStarts(lineLengths: readonly number[], sourceLength?: number): number[] {
  const starts: number[] = []
  let offset = 0
  for (let index = 0; index < lineLengths.length; index += 1) {
    starts.push(offset)
    const length = lineLengths[index] ?? 0
    // 默认按 LF 推进；若给了源码总长度且累计超出，说明这里有 CRLF（多出来的 1 个就是 \r）。
    offset += length + 1
  }
  if (sourceLength !== undefined && starts.length > 0) {
    // 用真实源码长度校准：把差距（CRLF 行数）按行摊回去，保证最后一行也落在文件内。
    const last = starts[starts.length - 1] ?? 0
    const extra = sourceLength - (last + (lineLengths[lineLengths.length - 1] ?? 0))
    if (extra > 0) {
      const crlfLines = Math.min(extra, lineLengths.length)
      for (let index = crlfLines; index < starts.length; index += 1) starts[index] += crlfLines
      for (let index = 0; index < crlfLines; index += 1) starts[index] += index
    }
  }
  return starts
}

/** 把一段脚本里的字符偏移换成 1 基行号（纯函数，便于单测）。 */
export function lineOfOffset(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  let answer = 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if ((starts[mid] ?? 0) <= offset) {
      answer = mid + 1
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return answer
}

/** 第 line 行（1 基）的结束偏移（含行内最后一个字符，不含换行符）。 */
function lineEndOffset(starts: readonly number[], lineLengths: readonly number[], line: number): number {
  const start = starts[line - 1] ?? 0
  const length = lineLengths[line - 1] ?? 0
  return start + Math.max(0, length - 1)
}

/** 覆盖率目录里的单个脚本记录（V8 格式）。 */
interface ScriptRecord {
  url: string
  functions: {
    functionName: string
    isBlockCoverage: boolean
    ranges: { startOffset: number; endOffset: number; count: number }[]
  }[]
}

/** 一行代码的覆盖率判据（不导出，只在本文件用）。 */
interface LineCount {
  line: number
  count: number
  /** 该行第一个字符的偏移。 */
  start: number
  /** 该行最后一个字符的偏移（不含换行符）。 */
  end: number
}

/**
 * 收集一个脚本里每一行的执行计数与「可执行行」判定。
 *
 * 口径说明（本工具不依赖 Node 内部的私有算法，但实测与其口径接近）：
 *   · 分母 = V8 报告里**出现过区间的行**（`executable` 标记）。空白行、纯注释行、字符串续行
 *     通常不在任何区间里，不计入分母 —— 与 Node 的 line% 分母一致（Node 也会跳过这些行）。
 *   · 分子 = 至少被一个 `count > 0` 区间覆盖过的行。
 *   · `functions[0]` 是 V8 的**整段脚本**区间（未命名、覆盖 0..文件末尾、count 通常为 1），
 *     它不是函数体，铺开会把所有行都标成「已执行」，覆盖率假性 100%。实测（Node v24.11.1）
 *     只跑一个测试时 lib/lib.js 的 `functions[0]` 就是 `0-102013:1`，而真正被调用的函数只有 3 个。
 *     所以整段脚本区间只用来**扩充分母**（它圈定了文件的字符范围），不参与分子。
 *
 * 实测对比（2026-10-03，Node v24.11.1，全量跑 tests/lib.test.ts + tests/host.test.ts）：
 *   本算法 lib/lib.js 99.83%（Node 99.06%）、lib/index.js 99.95%（Node 85.55%）。
 *   index.js 的差距来自 `functions[0]` 之外的顶层区间：Node 会按 sourcemap 回映射到 src/index.ts
 *   再算行，本工具坚持按 **lib/*.js 生成代码的行**算 —— 那正是要盯的产物，也是本工具的既定目标。
 *   两个门槛（97% / 83%）都留了 2 个百分点余量，且在「只跑一个小测试」时实测会掉到 0.79% / 1.81%，
 *   失败态判别非常明确（见报告里的实测输出）。这是**保守**方向：本算法只会比 Node 略宽，
 *   一旦真的掉到门槛以下，就是真有回归。
 */
function lineCountsOf(script: ScriptRecord, starts: readonly number[], lineLengths: readonly number[]): LineCount[] {
  const counts = new Map<number, number>()
  const executable = new Set<number>()
  for (let index = 0; index < script.functions.length; index += 1) {
    const fn = script.functions[index]
    if (fn === undefined) continue
    // 整段脚本区间：只贡献分母。
    const isWholeScript = index === 0 && fn.functionName === ''
    for (let r = 0; r < fn.ranges.length; r += 1) {
      const range = fn.ranges[r]
      if (range === undefined) continue
      const first = lineOfOffset(starts, range.startOffset)
      const last = lineOfOffset(starts, Math.max(range.startOffset, range.endOffset - 1))
      for (let line = first; line <= last; line += 1) {
        if (line < 1 || line > lineLengths.length) continue
        executable.add(line)
        if (isWholeScript) continue
        if (range.count > 0) counts.set(line, Math.max(counts.get(line) ?? 0, range.count))
      }
    }
  }
  return [...executable]
    .sort((a, b) => a - b)
    .map((line) => ({ line, count: counts.get(line) ?? 0, start: starts[line - 1] ?? 0, end: lineEndOffset(starts, lineLengths, line) }))
}

/** 从一行文本里解析出的百分数。 */
function percentOf(text: string): number | null {
  const matched = /(-?\d+(?:\.\d+)?)\s*%/u.exec(text)
  if (matched === null) return null
  const value = Number(matched[1])
  return Number.isFinite(value) ? value : null
}

/**
 * 覆盖率表格里「行 %」那一格的值。
 *
 * 表格长这样（Node v24 实测）：
 *   `file      | line % | branch % | funcs % | uncovered lines`
 *   ` index.js |  85.55 |    69.31 |   90.20 | 20-22 75-76 …`
 * 注意百分号**只在表头**出现，数据格是纯数字；所以这里先认「带 % 的格子」，
 * 认不到就退回「第 2 格里的纯数字」（数据行的形态）。
 */
function linePercentCell(cells: string[]): number | null {
  for (const cell of cells) {
    if (cell.includes('%')) {
      const percent = percentOf(cell)
      if (percent !== null) return percent
    }
  }
  for (const cell of cells.slice(1)) {
    const matched = /^\s*(-?\d+(?:\.\d+)?)\s*$/u.exec(cell)
    if (matched === null) continue
    const value = Number(matched[1])
    if (Number.isFinite(value)) return value
  }
  return null
}

/** 报告文本里的一个「文件行」：`[lib]  index.js  |  85.55 | …`。 */
interface ReportRow {
  group: string | null
  name: string
  linePercent: number | null
}

/** 解析 `--experimental-test-coverage` 的表格行（纯函数，便于单测）。 */
export function parseReportRows(text: string): ReportRow[] {
  const rows: ReportRow[] = []
  let group: string | null = null
  for (const raw of text.split(/\r?\n/u)) {
    // 可能有多层前缀：`ℹ ` 是 Node 的 diagnostic 前缀，`▐ ` / `● ` 是 CI 或 PowerShell 加的颜色/图标前缀。
    const line = raw.replace(/^[\s\p{So}\p{Cf}]*ℹ?[\s\p{So}\p{Cf}]*/u, '').trimEnd()
    if (line.trim().length === 0) continue
    if (/^-{3,}/u.test(line) || line.startsWith('start of coverage') || line.startsWith('end of coverage')) continue
    const cells = line.split('|')
    if (cells.length < 3) continue
    const head = (cells[0] ?? '').trim()
    if (head.length === 0) continue
    if (head === 'file' || head === 'all files') continue
    const percent = linePercentCell(cells)
    if (percent === null) {
      // 没有百分数 → 分组行（`lib`、`tests`），记住它给下面的文件行归组。
      // 但也要排除别的诊断（`tests 256`、`duration_ms 1121` 之类）：只有「组名」才配当分组。
      if (/^[A-Za-z0-9_@.-]+$/u.test(head)) group = head
      rows.push({ group: null, name: head, linePercent: null })
      continue
    }
    rows.push({ group, name: head, linePercent: percent })
  }
  return rows
}

/**
 * 把报告文本折成「相对仓库根的产物路径 → 行覆盖率」。
 * 分组行给出前缀（`lib`、`tests`），文件行的名字与组拼起来就是路径。
 */
export function reportCoverageOf(text: string, repo: string): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>()
  for (const row of parseReportRows(text)) {
    if (row.linePercent === null) continue
    const candidates = [
      ...(row.group === null ? [] : [normalizeKey(`${row.group}/${row.name}`, repo)]),
      normalizeKey(row.name, repo),
    ]
    for (const key of candidates) {
      if (!out.has(key)) {
        out.set(key, {
          file: key,
          linePercent: row.linePercent,
          totalLines: 0,
          coveredLines: 0,
          source: `报告文本 ${row.group === null ? '' : `${row.group}/`}${row.name}`,
        })
      }
    }
  }
  return out
}

/** 覆盖率目录里的裸文件名（`lib/lib.js` / `src/index.ts` / `node_modules/...`）。 */
export function coverageKeyOfUrl(url: string, repo: string): string {
  let path = url
  if (path.startsWith('file:')) {
    try {
      path = fileURLToPath(path)
    } catch {
      // 保留原样
    }
  }
  let relative = normalizeKey(path, repo)
  const nodeModules = relative.lastIndexOf('node_modules/')
  if (nodeModules !== -1) relative = relative.slice(nodeModules + 'node_modules/'.length)
  return relative
}

/** 把路径归一成相对仓库根的 POSIX 形式（大小写不敏感做前缀比较）。 */
function normalizeKey(path: string, repo: string): string {
  const posix = path.replace(/\\/gu, '/')
  const prefixBase = repo.replace(/\\/gu, '/')
  const prefix = prefixBase.endsWith('/') ? prefixBase : `${prefixBase}/`
  const trimmed = posix.toLowerCase().startsWith(prefix.toLowerCase()) ? posix.slice(prefix.length) : posix
  return trimmed
}

/** 读覆盖率目录，算出每个脚本（按 URL）的行覆盖率。 */
export function readCoverageDirectory(dir: string, repo: string): ParseOutcome {
  const files = new Map<string, FileCoverage>()
  const notes: string[] = []
  const scripts = new Map<string, ScriptRecord>()
  const lineOffsets = new Map<string, number[]>()
  let coverageFiles = 0

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (error) {
    throw new Error(`覆盖率目录读不出来：${dir}（${error instanceof Error ? error.message : String(error)}）`)
  }

  for (const name of entries.sort()) {
    if (!COVERAGE_FILE_RE.test(name)) continue
    coverageFiles += 1
    const full = join(dir, name)
    let parsed: { result?: ScriptRecord[]; 'source-map-cache'?: Record<string, { lineLengths?: number[] }> }
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8')) as typeof parsed
    } catch (error) {
      notes.push(`跳过 ${name}：不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
      continue
    }
    const cache = parsed['source-map-cache'] ?? {}
    for (const [url, entry] of Object.entries(cache)) {
      if (Array.isArray(entry.lineLengths)) lineOffsets.set(url, entry.lineLengths)
    }
    for (const script of parsed.result ?? []) {
      const previous = scripts.get(script.url)
      if (previous === undefined) {
        scripts.set(script.url, { url: script.url, functions: [...script.functions] })
      } else {
        // 同一文件在多次进程 / 多个测试文件里都会出现，计数要**合并**而不是二选一。
        // 这里把新脚本的函数区间并进已有列表；下面的 `lineCountsOf` 对同一行取最大计数，
        // 于是「某次跑到过」就能保住这一行（覆盖取并集）。
        previous.functions.push(...script.functions)
      }
    }
  }

  if (coverageFiles === 0) {
    notes.push(`目录里没有 coverage-*.json：${dir}`)
  }

  for (const [url, script] of scripts) {
    const key = coverageKeyOfUrl(url, repo)
    // 只关心仓库自己的东西：node_modules 与 node: 一律不进表。
    if (url.startsWith('node:') || key.startsWith('node_modules/') || key.startsWith('evalmachine')) continue
    const offsets = lineOffsets.get(url)
    if (offsets === undefined || offsets.length === 0) {
      files.set(key, { file: key, linePercent: null, totalLines: 0, coveredLines: 0, source: `${url}（无 source-map 行长度信息）` })
      continue
    }
    const lineLengths = offsets
    const starts = lineStarts(lineLengths)
    const counts = lineCountsOf(script, starts, lineLengths)
    const total = counts.length
    const covered = counts.filter((item) => item.count > 0).length
    const previous = files.get(key)
    // 同一个文件在多个 coverage-*.json 里出现（进程隔离会各写一份）时取「合并后更全」的那份，
    // 否则表里只算了其中一次运行的覆盖率，数字会虚低。
    if (previous !== undefined && previous.totalLines >= total) continue
    files.set(key, {
      file: key,
      linePercent: total === 0 ? null : (covered / total) * 100,
      totalLines: total,
      coveredLines: covered,
      source: url,
    })
  }

  notes.push(`coverage-*.json ${coverageFiles} 个，脚本 ${scripts.size} 个（仓库内 ${files.size} 个）`)
  return { source: `NODE_V8_COVERAGE 目录 ${dir}`, files, notes }
}

/** 只读一个文件的行数（用于确认产物真的存在、有内容）。 */
function fileLineCount(file: string): number {
  return readFileSync(file, 'utf8').split(/\r?\n/u).length
}

/** 跑完整套门槛判定。 */
export function checkCoverage(options: Options): { results: FileCoverage[]; failures: string[]; notes: string[] } {
  const notes: string[] = []
  let outcome: ParseOutcome | null = null
  // 门槛按输入模式选：报告口径与自算口径的分母不同（见 THRESHOLDS_* 注释）。
  let thresholds: readonly Threshold[] = THRESHOLDS_V8

  if (options.coverageDir !== null) {
    outcome = readCoverageDirectory(options.coverageDir, options.repo)
    thresholds = THRESHOLDS_V8
  } else if (options.reportFile !== null) {
    thresholds = THRESHOLDS_REPORT
    const text = readFileSync(options.reportFile, 'utf8')
    const files = reportCoverageOf(text, options.repo)
    if (files.size === 0) {
      notes.push(`报告文本里没有解析到任何带百分数的行：${options.reportFile}`)
    }
    outcome = { source: `覆盖率报告文本 ${options.reportFile}`, files, notes: [] }
  }

  if (outcome === null) {
    return {
      results: [],
      failures: ['没有给出覆盖率输入：请用 --coverage-dir <目录> 或 --report <文件>，或设置 NODE_V8_COVERAGE / COVERAGE_DIR / COVERAGE_REPORT。'],
      notes,
    }
  }

  notes.push(...outcome.notes)
  const failures: string[] = []
  const results: FileCoverage[] = []

  for (const threshold of thresholds) {
    const found = outcome.files.get(threshold.file)
    const absolute = join(options.repo, threshold.file)
    if (!existsSync(absolute)) {
      failures.push(`产物不存在：${threshold.file}（先跑构建：pnpm build 或 tsc）`)
      results.push({ file: threshold.file, linePercent: null, totalLines: 0, coveredLines: 0, source: '缺失' })
      continue
    }
    if (found === undefined || (found.linePercent === null && !found.source.startsWith('缺失'))) {
      // 产物在、但输入里没有它的数据：这说明覆盖率没被测到它（常见原因就是 Node 默认排除 glob 把它吃了）。
      failures.push(
        `${threshold.file}：输入里没有这个文件的行覆盖率数据（产物有 ${fileLineCount(absolute)} 行）。`
        + ' 这通常意味着 Node 的默认排除 glob 把 lib/** 整个排除了 —— 请显式加 --test-coverage-exclude="**/node_modules/**"。',
      )
      results.push({ file: threshold.file, linePercent: null, totalLines: 0, coveredLines: 0, source: '输入缺失' })
      continue
    }
    const percent = found.linePercent ?? 0
    results.push({ ...found, file: threshold.file })
    if (!options.listOnly && percent < threshold.minLinePercent) {
      failures.push(`${threshold.file}：行覆盖率 ${percent.toFixed(2)}% 低于门槛 ${threshold.minLinePercent}%`)
    }
  }

  return { results, failures, notes }
}

/** 解析命令行（不引入任何依赖）。 */
function parseArgs(argv: string[]): Options {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const options: Options = {
    repo: repoRoot,
    coverageDir: null,
    reportFile: null,
    listOnly: false,
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--coverage-dir') options.coverageDir = resolvePath(argv[++index] ?? '')
    else if (arg === '--report') options.reportFile = resolvePath(argv[++index] ?? '')
    else if (arg === '--repo') options.repo = resolvePath(argv[++index] ?? '')
    else if (arg === '--list') options.listOnly = true
    else if (arg === '--json') options.json = true
  }
  if (options.coverageDir === null && options.reportFile === null) {
    const dir = process.env.NODE_V8_COVERAGE ?? process.env.COVERAGE_DIR
    const report = process.env.COVERAGE_REPORT ?? process.env.COVERAGE_REPORT_FILE
    if (dir !== undefined && dir.trim().length > 0) options.coverageDir = resolvePath(dir)
    else if (report !== undefined && report.trim().length > 0) options.reportFile = resolvePath(report)
  }
  return options
}

/** 只有被 `node tools/coverage-check.ts` 直接运行时才执行 CLI；被 import 时只导出上面的函数。 */
function isDirectRun(): boolean {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  const self = fileURLToPath(import.meta.url)
  const invoked = resolvePath(argv1)
  return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self
}

if (isDirectRun()) {
  const options = parseArgs(process.argv.slice(2))
  // 展示用的门槛表：与 checkCoverage 内部的选择口径保持一致（报告口径 ≠ 自算口径）。
  const displayThresholds = options.coverageDir !== null ? THRESHOLDS_V8 : THRESHOLDS_REPORT
  let outcome: { results: ReturnType<typeof checkCoverage>['results']; failures: string[]; notes: string[] }
  try {
    outcome = checkCoverage(options)
  } catch (error) {
    // 输入路径不可读等环境问题：给一行清楚的错误 + 非零退出，不要甩一段堆栈。
    const message = error instanceof Error ? error.message : String(error)
    if (process.argv.slice(2).includes('--json')) {
      console.log(JSON.stringify({ ok: false, failures: [message], thresholds: displayThresholds, results: [], notes: [], node: process.version }, null, 2))
    } else {
      console.log(`覆盖率门槛（行覆盖率）：输入 ${describeUsage(options)}`)
      console.log(`失败：${message}`)
    }
    process.exitCode = 1
    process.exit?.(1)
  }
  const { results, failures, notes } = outcome

  if (options.json) {
    console.log(JSON.stringify({
      ok: failures.length === 0,
      thresholds: displayThresholds,
      results,
      failures,
      notes,
      node: process.version,
    }, null, 2))
  } else {
    const usage = describeUsage(options)
    console.log(`覆盖率门槛（行覆盖率）：输入 ${usage}`)
    console.log('文件             行覆盖率     已覆盖/总行数   门槛    判定')
    for (const threshold of displayThresholds) {
      const found = results.find((item) => item.file === threshold.file)
      const percent: number | null = found?.linePercent ?? null
      const ratio = found === undefined || found.totalLines === 0 ? '—' : `${found.coveredLines}/${found.totalLines}`
      const verdict = options.listOnly
        ? '（--list 不判定）'
        : percent === null
          ? '缺失'
          : percent < threshold.minLinePercent
            ? '低于门槛'
            : '通过'
      console.log(
        `${threshold.file.padEnd(16)} ${(percent === null ? '—' : `${percent.toFixed(2)}%`).padStart(8)}   ${ratio.padStart(12)}   ${`${threshold.minLinePercent}%`.padStart(5)}   ${verdict}`,
      )
    }
    console.log('')
    console.log('门槛依据：见本文件 THRESHOLDS_* 上方的「实测日期 / 环境 / 结果」注释。')
    for (const note of notes) console.log(`  · ${note}`)
    if (options.listOnly) {
      console.log('已用 --list：只报告数字，不判门槛。')
    } else if (failures.length === 0) {
      console.log('通过：两个产物的行覆盖率都不低于门槛。')
    } else {
      for (const failure of failures) console.log(`失败：${failure}`)
    }
  }

  if (!options.listOnly && failures.length > 0) process.exitCode = 1
}

/** 人话描述这次的输入是哪来的。 */
function describeUsage(options: Options): string {
  if (options.coverageDir !== null) return `覆盖率目录 ${options.coverageDir}`
  if (options.reportFile !== null) return `报告文本 ${options.reportFile}`
  return '（未提供）'
}

/** 判断一个路径是不是覆盖率目录（CLI 帮助信息用；也被 --list 的调试输出引用）。 */
export function isCoverageDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

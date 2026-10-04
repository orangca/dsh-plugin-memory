// tools/mutate.ts — 把「变异测试」从每轮手工做固化成可复跑的常驻工具。
//
// 为什么需要它：测试全绿只说明「现有断言没被违反」，不说明断言**盯得住实现**。
// 变异测试反过来问一句：故意把实现改错一处，测试会不会红？
//   · 红了     = 这条约束有人钉住（killed，好事）；
//   · 还全绿   = 盲区（survived）——不是一定出过 bug，但值得看一眼；
//   · tsc 就挂 = 变异被编译期拦下（build-error），既不冤杀也不当存活，单列。
// 手工每轮做一遍既慢又会漏，所以这里把「改一处 → 重建 → 跑全量测试」固化成一条命令。
//
// 安全硬约束（这个工具的立身之本）：
//   · **绝不改原仓库**：每次变异都在 `os.tmpdir()` 下的一份副本里做，`node_modules` 用
//     junction/symlink 指回原仓库（省掉重新装包，也让 tsc/测试照常解析依赖）；
//   · **一条变异一个干净副本**：上一条的编译产物不会污染下一条 —— 尤其是编译失败时
//     `noEmitOnError` 会让 lib/ 停在上一次构建，复用副本会张冠李戴（把上一条的变异
//     当成这一条的测试结果）；
//   · 收尾删副本（`--keep` 可保留排查）：删之前**先摘掉 node_modules 链接**，并核对
//     待删路径确实在临时目录里 —— 绝不对着一个计算出来的路径直接递归删。
//
// 判定与退出码：
//   · 测试红 ⇒ killed；测试仍全绿 ⇒ survived；tsc 失败 ⇒ build-error；
//   · 全部被杀死（或编译期拦下）⇒ 0；存在存活 ⇒ 非零（体检不合格的信号）；
//   · 环境问题（node/tsc 缺失、副本建不起来、命令起不来或超时、目录过期）⇒ 非零并明说原因。
//
// 用法：
//   node tools/mutate.ts [--limit N] [--seed S] [--only id] [--list] [--json] [--keep]
//   --limit N   从目录里**确定性随机**抽 N 条（默认 8；0 = 不抽样，跑整个目录）
//   --seed S    抽样种子（默认固定值，同一命令每次都抽到同一批）
//   --only id   只跑一条（按目录里的 id）
//   --list      只打印目录，不跑
//   --json      机器可读结果
//   --keep      保留副本目录（排查用；否则跑完就删）
//
// 零依赖：只用 node 内置模块；不联网。

import { spawnSync } from 'node:child_process'
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 一条变异：在文件里把 `find` 精确替换成 `replace`（只替换第一处，找不到就报错）。 */
export interface Mutation {
  /** 目录内唯一 id（报告与 `--only` 用它点名）。 */
  id: string
  /** 相对仓库根的 POSIX 路径。 */
  file: string
  /** 必须**逐字节**存在的原文片段；找不到 ＝ 目录过期，工具立刻报错。 */
  find: string
  /** 替换成什么。 */
  replace: string
  /** 一句中文：改错了会怎样（存活项要连它一起报出来）。 */
  note: string
}

/** 默认抽样条数。 */
export const DEFAULT_LIMIT = 8

/** 默认抽样种子：**固定值**才能让「同一条命令每次抽到同一批」成立（可复现）。 */
export const DEFAULT_SEED = 20261004

/** 全部被杀死（或编译期拦下）＝ 体检合格。 */
export const EXIT_OK = 0
/** 存在存活 ＝ 有盲区，这是「体检不合格」的信号。 */
export const EXIT_SURVIVED = 1
/** 环境问题（node/tsc 缺失、副本建不起来、命令起不来、目录过期）：非零 + 明说原因。 */
export const EXIT_ENVIRONMENT = 2

/** 单条命令超时（毫秒）：全量测试实测约 2 秒，给足余量，但绝不无限等。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000

/**
 * 内置变异目录（20–30 条精选）。
 *
 * 挑选口径：**真的会改错语义**的那些地方 —— 阈值边界、过滤/护栏反转、默认值改动、
 * 缓存淘汰、排序兜底、指纹字段增删。每条 `find` 都必须在当前实现里**逐字节存在**：
 * 找不到就报错，这是刻意的 —— 目录一旦过期，工具立刻发现，而不是静默少跑几条。
 *
 * `recordHash`（指纹）与 `tokenCacheKey`（缓存键）故意用「一整个表达式」当 find：
 * 只删一个字段比整行替换更难核对，而这里的目的是让人一眼看出「删了哪个字段」。
 */
export function mutationCatalogue(): Mutation[] {
  return [
    {
      id: 'merge-similarity-fallback',
      file: 'src/lib.ts',
      find: 'const threshold = cfg.mergeSimilarity ?? DEFAULTS.mergeSimilarity',
      replace: 'const threshold = cfg.mergeSimilarity ?? 0.85',
      note: '合并阈值的兜底从 DEFAULTS(0.7) 改回硬编码 0.85：缺省配置下的合并行为会静默变化。',
    },
    {
      id: 'index-recall-topk-default',
      file: 'src/index.ts',
      find: 'recallTopK: field(Schema!.number().default(8)),',
      replace: 'recallTopK: field(Schema!.number().default(5)),',
      note: 'Config 里 recallTopK 的默认值从 8 改成 5：设置页/patch 行看到的默认召回条数会与 DEFAULTS 不一致。',
    },
    {
      id: 'excluded-min-chars',
      file: 'src/lib.ts',
      find: "if (source.length < 8) return 'too-short'",
      replace: "if (source.length < 7) return 'too-short'",
      note: '短句排除门槛从 8 降到 7：7 个字符的噪声也会被当成可捕获内容写进长期记忆。',
    },
    {
      id: 'recall-min-lexical',
      file: 'src/lib.ts',
      find: ': (options?.minLexical ?? 0.34)',
      replace: ': (options?.minLexical ?? 0.44)',
      note: '短查询门槛从 0.34 抬到 0.44：临界命中被静默丢弃，召回「看起来一切正常」却少了几条。',
    },
    {
      id: 'recall-limit-floor',
      file: 'src/lib.ts',
      find: '.slice(0, Math.max(1, Math.min(50, limit)))',
      replace: '.slice(0, Math.min(50, limit))',
      note: '去掉「至少 1 条」的兜底：limit=0 时返回空数组，调用方会读成「没有命中」。',
    },
    {
      id: 'recall-score-tiebreak',
      file: 'src/lib.ts',
      find: '.sort((a, b) => (b.score - a.score) || compareRecords(a.record, b.record))',
      replace: '.sort((a, b) => (b.score - a.score))',
      note: '丢掉同分兜底排序：同分条目的先后交给引擎，召回结果不再确定性可测。',
    },
    {
      id: 'compare-pinned-order',
      file: 'src/lib.ts',
      find: 'if (a.pinned !== b.pinned) return a.pinned ? -1 : 1',
      replace: 'if (a.pinned !== b.pinned) return a.pinned ? 1 : -1',
      note: 'pinned 条目的方向反了：用户钉住的记忆反而排在普通条目后面。',
    },
    {
      id: 'compare-importance-order',
      file: 'src/lib.ts',
      find: 'if (b.importance !== a.importance) return b.importance - a.importance',
      replace: 'if (b.importance !== a.importance) return a.importance - b.importance',
      note: '重要度从高→低变成低→高：注入与展示的优先级整体颠倒。',
    },
    {
      id: 'compare-id-fallback',
      file: 'src/lib.ts',
      find: 'return a.id < b.id ? -1 : a.id > b.id ? 1 : 0',
      replace: 'return 0',
      note: '丢掉 id 兜底：全序退化成偏序，同分次序随输入抖动（不可复现的输出）。',
    },
    {
      id: 'token-cache-key-flags',
      file: 'src/lib.ts',
      find: "return `${record.kind}|${hash}|${flags.stemming ? 's1' : 's0'}${flags.bigram ? 'b1' : 'b0'}`",
      replace: 'return `${record.kind}|${hash}`',
      note: '缓存键丢掉分词开关：切了 searchStemming/searchBigram 还会读到上一次的分词（缓存改变语义）。',
    },
    {
      id: 'token-cache-max',
      file: 'src/lib.ts',
      find: 'const TOKEN_CACHE_MAX = 8192',
      replace: 'const TOKEN_CACHE_MAX = 1',
      note: '缓存上限降到 1：每条新记录都淘汰旧条目，大库每回合重新分词全库（性能静默崩塌）。',
    },
    {
      id: 'record-hash-branch',
      file: 'src/lib.ts',
      find: '    ...(branch ? [branch] : []),',
      replace: '    ...[],',
      note: '分支不参与指纹：主干上的通用约定与特性分支的临时约定被判成同一条，互相吃掉。',
    },
    {
      id: 'record-hash-scope-key',
      file: 'src/lib.ts',
      find: "    record.scope?.key ?? '',",
      replace: "    '',",
      note: '指纹丢掉 scope.key：A 项目写过的同一句话会被判成「B 项目已有」，合并到错误的 scope。',
    },
    {
      id: 'default-scope-agent-self',
      file: 'src/lib.ts',
      find: "  if (kind === 'user_profile' || kind === 'agent_self') return 'profile'",
      replace: "  if (kind === 'user_profile') return 'profile'",
      note: 'agent_self 默认从 profile 掉到 workspace：自画像不再跨项目生效。',
    },
    {
      id: 'clamp-text-min-chars',
      file: 'src/lib.ts',
      find: 'const maxChars = Math.max(8, Math.floor(tokenBudget * perToken))',
      replace: 'const maxChars = Math.max(1, Math.floor(tokenBudget * perToken))',
      note: '极小预算下不再保底 8 字符：条目被截成 1 个字 + 省略号，等于丢内容。',
    },
    {
      id: 'budget-number-zero',
      file: 'src/lib.ts',
      // 跨行 find：同样的表达式在 `sleepBudget` 里还有一份，只取本函数的（顺带钉住 applyMutation 的多行能力）。
      find: 'function budgetNumber(value: unknown, fallback: number): number {\n  return typeof value === \'number\' && Number.isFinite(value) && value > 0 ? value : fallback',
      replace: 'function budgetNumber(value: unknown, fallback: number): number {\n  return typeof value === \'number\' && Number.isFinite(value) && value >= 0 ? value : fallback',
      note: '把 0 当合法预算：除法得 Infinity，注入被静默关闭（原本必须回落默认值）。',
    },
    {
      id: 'self-eval-half-life',
      file: 'src/lib.ts',
      find: "if (record.kind === 'agent_self' && record.origin === 'model_proposed') halfLife = 90",
      replace: "if (record.kind === 'agent_self' && record.origin === 'model_proposed') halfLife = 30",
      note: '模型自评的半衰期从 90 天缩到 30 天：自评衰减快 3 倍，「跨会话复现才晋升」的护栏失效。',
    },
    {
      id: 'archive-importance-boundary',
      file: 'src/lib.ts',
      find: 'return effectiveImportance(record, now) < (cfg.archiveBelowImportance ?? 0.15) && ageDays >= archiveAfterDays',
      replace: 'return effectiveImportance(record, now) <= (cfg.archiveBelowImportance ?? 0.15) && ageDays >= archiveAfterDays',
      note: '归档判定的比较从「严格小于」放宽成「小于等于」：恰好等于阈值的条目被提前归档。',
    },
    {
      id: 'refs-max-zero',
      file: 'src/lib.ts',
      find: "return typeof value !== 'number' || Number.isNaN(value) || value < 0 ? DEFAULTS.refsMax : value",
      replace: "return typeof value !== 'number' || Number.isNaN(value) || value < 1 ? DEFAULTS.refsMax : value",
      note: 'refsMax 的 0 不再表示「不保留引用」：负数回落的分界被挪到 1，0 悄悄变成默认 5 条。',
    },
    {
      id: 'conflict-model-override-guard',
      file: 'src/lib.ts',
      find: 'const blocked = !isUserSideOrigin(winner.origin) && isUserSideOrigin(loser.origin)',
      replace: 'const blocked = false',
      note: '「模型写入不得自动推翻用户条目」的护栏被拿掉：模型一句自评就能顶掉用户明说的事实。',
    },
    {
      id: 'user-side-origin-correction',
      file: 'src/lib.ts',
      find: "return origin === 'user_explicit' || origin === 'user_correction'",
      replace: "return origin === 'user_explicit'",
      note: '用户纠正不再算用户侧来源：冲突护栏与优先级判定跟着一起失效。',
    },
    {
      id: 'blend-null-fallback',
      file: 'src/lib.ts',
      find: 'if (semantic === null || semantic === undefined) return lexicalScore',
      replace: 'if (semantic === null || semantic === undefined) return 0',
      note: '嵌入不可用时不再回落词面、直接归零：一次嵌入失败变成整轮漏召回（失败冒泡）。',
    },
    {
      id: 'blend-weights-swapped',
      file: 'src/lib.ts',
      find: 'return clamp01((1 - w) * lexicalScore + w * semanticScore)',
      replace: 'return clamp01(w * lexicalScore + (1 - w) * semanticScore)',
      note: '词面/语义权重方向反了：w=0.5 时看不出来，权重一调（0 或 1）就整体走反。',
    },
    {
      id: 'pending-queue-boundary',
      file: 'src/lib.ts',
      find: 'return max > 0 && count >= max',
      replace: 'return max > 0 && count > max',
      note: '待确认队列满的边界放宽一条：上限名存实亡（每轮多放一条进来）。',
    },
    {
      id: 'refs-prepend-order',
      file: 'src/lib.ts',
      find: 'return normalizeRefs([ref, ...(Array.isArray(refs) ? refs : [])], cfg)',
      replace: 'return normalizeRefs([...(Array.isArray(refs) ? refs : []), ref], cfg)',
      note: '新引用排到队尾：refsMax 满时最新引用反而被裁掉（审计线索丢失）。',
    },
    {
      id: 'branch-visible-fail-open',
      file: 'src/lib.ts',
      find: 'return current !== null && current === branch',
      replace: 'return current === null || current === branch',
      note: '分支可见性从 fail-closed 变 fail-open：当前分支未知时反而把带标签记录注入进来。',
    },
    {
      id: 'index-pending-max-default',
      file: 'src/index.ts',
      find: 'pendingMax: field(Schema!.number().default(50)),',
      replace: 'pendingMax: field(Schema!.number().default(20)),',
      note: '待确认队列上限默认从 50 缩到 20：宿主不传配置时「队列满」提前触发，模型写入被拒。',
    },
    {
      id: 'index-audit-max-default',
      file: 'src/index.ts',
      find: 'auditMax: field(Schema!.number().default(50)),',
      replace: 'auditMax: field(Schema!.number().default(20)),',
      note: '审计环默认容量从 50 缩到 20：历史事件被提前挤掉，事后追不了。',
    },
    {
      id: 'index-write-policy-default',
      file: 'src/index.ts',
      find: "writePolicy: field(Schema!.union(['auto', 'ask', 'off']).default('auto')),",
      replace: "writePolicy: field(Schema!.union(['auto', 'ask', 'off']).default('ask')),",
      note: '模型写入默认从 auto 变成 ask：升级即行为变化，模型写入全部进待确认队列。',
    },
  ]
}

/**
 * 套用一条变异：把 `find` **精确替换**成 `replace`（只替换第一处）。
 *
 * 找不到 `find` 就抛错 —— 绝不静默返回原文当「已变异」：那样跑出来的「全绿」
 * 会是一条根本没被改过的代码的成绩单，比漏跑更误导。
 */
export function applyMutation(text: string, mutation: Mutation): string {
  const at = text.indexOf(mutation.find)
  if (at === -1) {
    throw new Error(`变异 ${mutation.id} 找不到 find 串（目录过期？）：${mutation.file}`)
  }
  return text.slice(0, at) + mutation.replace + text.slice(at + mutation.find.length)
}

/** 命令行选项。 */
export interface Options {
  /** 抽样条数；0 ＝ 不抽样，跑整个目录。 */
  limit: number
  /** 抽样种子（固定默认值 ⇒ 可复现）。 */
  seed: number
  /** 只跑这一条（`--only <id>`）；null ＝ 按 limit 抽样。 */
  only: string | null
  /** `--list`：只打印目录。 */
  list: boolean
  /** `--json`：机器可读输出。 */
  json: boolean
  /** `--keep`：保留副本目录。 */
  keep: boolean
}

/**
 * 解析命令行参数（零依赖）。
 *
 * `--limit` 只认非负整数：`0` = 跑整个目录；非法值（缺值/NaN/负数/小数）**回落默认 8**，
 * 绝不把 NaN 当成「跑 0 条」静默糊过去。`--seed` 只认整数，非法值回落固定默认种子。
 * 未知参数忽略（与仓库既有 tools/*.ts 的口径一致）。
 */
export function parseArgs(argv: string[]): Options {
  const options: Options = { limit: DEFAULT_LIMIT, seed: DEFAULT_SEED, only: null, list: false, json: false, keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') options.list = true
    else if (arg === '--json') options.json = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--limit') {
      const value = Number(argv[index + 1])
      index += 1
      if (Number.isInteger(value) && value >= 0) options.limit = value
    } else if (arg === '--seed') {
      const value = Number(argv[index + 1])
      index += 1
      if (Number.isInteger(value)) options.seed = value
    } else if (arg === '--only') {
      const value = (argv[index + 1] ?? '').trim()
      index += 1
      if (value.length > 0) options.only = value
    }
  }
  return options
}

/** mulberry32：32 位整数状态的确定性 PRNG（零依赖）。种子相同 ⇒ 序列相同。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 确定性抽样：同一 (limit, seed) 永远抽到同一批、同一顺序。
 *
 * `limit <= 0` 或 `limit >= 目录长度` ⇒ 返回整份目录（不抽样）。
 * 抽完按目录顺序排回去：报告读起来稳定，不因为抽样顺序跳来跳去。
 */
export function sampleMutations(mutations: readonly Mutation[], limit: number, seed: number): Mutation[] {
  const list = [...mutations]
  if (limit <= 0 || limit >= list.length) return list
  const random = mulberry32(seed)
  const pool = list.map((_, index) => index)
  const picked: number[] = []
  for (let count = 0; count < limit; count += 1) {
    picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!)
  }
  picked.sort((a, b) => a - b)
  return picked.map((index) => list[index]!)
}

/** 一条外部命令（可执行文件 + 参数），直接 spawn，不过 shell。 */
export interface CommandSpec {
  /** 可执行文件：绝对路径，或交给 PATH 的名字。 */
  command: string
  args: readonly string[]
}

/** 判定。 */
export type MutationVerdict = 'killed' | 'survived' | 'build-error'

/** 一条变异的结论。 */
export interface MutationOutcome {
  mutation: Mutation
  verdict: MutationVerdict
  /** 从复制副本到判定结束的墙钟毫秒数。 */
  ms: number
  /** 证据摘要：被杀死的给出失败测试行；编译失败的给出 tsc 末尾输出。 */
  detail: string
}

/** 跑一轮变异测试的输入。 */
export interface RunTestingOptions {
  /** 原仓库根（**只读**；工具只在副本里改文件）。 */
  repo: string
  /** 本次要跑的变异（调用方已抽样）。 */
  mutations: readonly Mutation[]
  /** 重建命令；null ＝ 该仓库不需要重建（例如纯 JS 的玩具仓库）。 */
  build: CommandSpec | null
  /** 全量测试命令。 */
  test: CommandSpec
  /** 保留副本目录（排查用）。 */
  keep?: boolean
  /** 副本父目录；默认 `os.tmpdir()`。 */
  workRoot?: string
  /** 单条命令超时毫秒数。 */
  timeoutMs?: number
  /** 逐条进度回调（CLI 打印用）。 */
  onLine?: (line: string) => void
}

/** 跑一轮变异测试的输出。 */
export interface RunTestingResult {
  /** 副本根目录：保留时是现存路径，未保留（已清理）时是 null。 */
  workdir: string | null
  kept: boolean
  outcomes: MutationOutcome[]
  /** 真的判定过的条数。 */
  tried: number
  killed: number
  survived: number
  /** 编译期就失败的条数（被拦下，但不算测试杀死）。 */
  buildErrors: number
  /** 0 = 合格；1 = 有存活；2 = 环境问题。 */
  exitCode: number
  /** 环境问题的一句话原因；没问题时 null。 */
  error: string | null
}

/** 与 package.json 的 `test` 脚本一致的全量测试文件清单。 */
const TEST_FILES: readonly string[] = [
  'tests/lib.test.ts',
  'tests/client.test.ts',
  'tests/host.test.ts',
  'tests/tools.test.ts',
  'tests/module.test.ts',
  'tests/protocol.test.ts',
  'tests/docs.test.ts',
]

/** 复制副本时排除的目录：装包产物与 git 元数据没必要抄（node_modules 另有链接）。 */
const COPY_EXCLUDE: ReadonlySet<string> = new Set(['node_modules', '.git', '.tmp'])

/** 错误 → 一句话。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** child 是否真的在 parent 里面（用于「绝不删不确定的路径」）。 */
function isInside(parent: string, child: string): boolean {
  const root = resolvePath(parent)
  const target = resolvePath(child)
  if (target === root) return false
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return target.startsWith(prefix)
}

/** id → 能当目录名的片段。 */
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 60)
}

/** 复制仓库到副本（排除 node_modules/.git/.tmp）。 */
function copyRepo(repo: string, destination: string): void {
  cpSync(repo, destination, {
    recursive: true,
    force: true,
    filter: (source) => {
      const rel = relative(repo, source)
      if (rel.length === 0) return true
      return !rel.split(/[\\/]/u).some((segment) => COPY_EXCLUDE.has(segment))
    },
  })
}

/** `node_modules` 指回原仓库：junction（Windows，不需要管理员）或 dir 符号链接。 */
function linkNodeModules(repo: string, copy: string): void {
  const source = join(repo, 'node_modules')
  if (!existsSync(source)) return
  symlinkSync(source, join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
}

/** 在副本里套用一条变异（找不到 find 由 applyMutation 抛错）。 */
function mutateCopy(copy: string, mutation: Mutation): void {
  const file = join(copy, mutation.file)
  if (!existsSync(file)) throw new Error(`变异 ${mutation.id} 指向的文件不在仓库里：${mutation.file}`)
  writeFileSync(file, applyMutation(readFileSync(file, 'utf8'), mutation), 'utf8')
}

/**
 * 跑一条命令并把 stdout/stderr **重定向到文件**（不用管道）。
 *
 * 为什么不用管道捕获：沙箱里管道会 EPERM/EINVAL，拿到的空串会被误读成「测试全绿」。
 * 文件描述符直连没有这个问题（与 tools/verify-self-contained.ts 的做法同源）。
 */
function runCommand(
  spec: CommandSpec,
  cwd: string,
  logFile: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): { status: number | null; error: Error | null; output: string } {
  const fd = openSync(logFile, 'w')
  let status: number | null = null
  let spawnError: Error | null = null
  try {
    const result = spawnSync(spec.command, [...spec.args], {
      cwd,
      stdio: ['ignore', fd, fd],
      timeout: timeoutMs,
      windowsHide: true,
      env,
    })
    status = result.status
    spawnError = result.error ?? null
  } finally {
    closeSync(fd)
  }
  const output = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  return { status, error: spawnError, output }
}

/** 从测试输出里挑失败证据：失败计数行 + 前几条 `✖` 用例名。 */
function failureSummary(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const parts = [
    ...lines.filter((line) => line.startsWith('ℹ fail ')),
    ...lines.filter((line) => line.startsWith('✖')).slice(0, 3),
  ]
  const text = parts.length > 0 ? parts.join(' / ') : lines.slice(-3).join(' / ')
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

/** 摘掉 node_modules 链接再删副本：绝不顺着链接递归进原仓库。 */
function removeCopy(copy: string, runRoot: string): void {
  if (!isInside(runRoot, copy)) return
  const link = join(copy, 'node_modules')
  try {
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) rmSync(link, { force: true })
  } catch {
    // 链接摘不掉时先不硬删：留给失败信息与 --keep 排查，绝不冒险递归。
  }
  rmSync(copy, { recursive: true, force: true })
}

/** 建副本根目录；建不起来时给出原因（环境问题）。 */
function createRunRoot(workRoot: string): { root: string; error: null } | { root: null; error: string } {
  try {
    mkdirSync(workRoot, { recursive: true })
    return { root: mkdtempSync(join(workRoot, 'dsh-mutate-')), error: null }
  } catch (error) {
    return { root: null, error: `临时目录建不起来（${workRoot}）：${messageOf(error)}` }
  }
}

/** 清掉整个副本根（只在确认它确实在工作目录里时才动）。 */
function removeRunRoot(workRoot: string, runRoot: string): void {
  if (!isInside(workRoot, runRoot)) return
  rmSync(runRoot, { recursive: true, force: true })
}

/**
 * 跑一轮变异测试：每条变异一个干净副本 → 套一处变异 → 重建 → 跑全量测试 → 判定。
 *
 * 环境问题（副本建不起来、命令起不来/超时、目录过期）一律**中止并明说**，
 * 不把「没跑成」当成「被杀死」——那是这个工具最容易骗自己的地方。
 */
export function runMutationTesting(options: RunTestingOptions): RunTestingResult {
  const log = options.onLine ?? ((): void => {})
  const repo = resolvePath(options.repo)
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const outcomes: MutationOutcome[] = []

  const failed = (message: string): RunTestingResult => ({
    workdir: null,
    kept: false,
    outcomes,
    tried: outcomes.length,
    killed: outcomes.filter((outcome) => outcome.verdict === 'killed').length,
    survived: outcomes.filter((outcome) => outcome.verdict === 'survived').length,
    buildErrors: outcomes.filter((outcome) => outcome.verdict === 'build-error').length,
    exitCode: EXIT_ENVIRONMENT,
    error: message,
  })

  if (!existsSync(join(repo, 'package.json'))) {
    return failed(`仓库根不可用（没有 package.json）：${repo}`)
  }
  if (!existsSync(process.execPath)) {
    return failed(`node 可执行文件不存在：${process.execPath}（环境不完整，本次没有跑任何变异）`)
  }

  const workRoot = resolvePath(options.workRoot ?? tmpdir())
  const created = createRunRoot(workRoot)
  if (created.root === null) return failed(created.error)
  const runRoot = created.root

  // 测试子进程要知道「原仓库」在哪：副本里的 tests/tools.test.ts 需要拿**未变异**的源文件
  // 核对目录里每条 find 是否仍然存在（否则任何一条变异都会先把那条断言弄红，
  // 于是所有变异都被误判成「被杀死」——工具自己把自己的观测搅浑）。
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_MUTATE_SOURCE_REPO: repo }
  // ⚠ 绝不能把父测试进程的 `NODE_TEST_CONTEXT` 传下去：带着它跑 `node --test`，node 会认为
  // 自己在测试文件里递归调用 run()，于是「跳过全部文件 + 退出码 0」—— 空跑会被读成
  // 「测试全绿」，也就是把每一步都判成存活（2026-10 实测：玩具仓库的「必被杀死」变异
  // 正是这样骗过了判定）。
  delete env.NODE_TEST_CONTEXT

  /** 跑一次测试命令并给出判定（build 与 no-build 两条路径共用）。 */
  const judge = (copy: string, index: number, mutation: Mutation): MutationOutcome => {
    const startedAt = Date.now()
    if (options.build !== null) {
      const built = runCommand(options.build, copy, join(runRoot, `${index + 1}-build.log`), timeoutMs, env)
      if (built.error !== null) throw new Error(`重建命令没跑完（${mutation.id}）：${built.error.message}`)
      if (built.status !== 0) {
        return { mutation, verdict: 'build-error', ms: Date.now() - startedAt, detail: failureSummary(built.output) }
      }
    }
    const tested = runCommand(options.test, copy, join(runRoot, `${index + 1}-test.log`), timeoutMs, env)
    if (tested.error !== null) throw new Error(`测试命令没跑完（${mutation.id}）：${tested.error.message}`)
    const verdict: MutationVerdict = tested.status === 0 ? 'survived' : 'killed'
    return {
      mutation,
      verdict,
      ms: Date.now() - startedAt,
      detail: verdict === 'survived' ? '全量测试仍全绿（这条约束没人钉住）' : failureSummary(tested.output),
    }
  }

  try {
    for (const [index, mutation] of options.mutations.entries()) {
      const copy = join(runRoot, `${String(index + 1).padStart(2, '0')}-${safeSegment(mutation.id)}`)
      mkdirSync(copy, { recursive: true })
      copyRepo(repo, copy)
      linkNodeModules(repo, copy)
      mutateCopy(copy, mutation)

      const outcome = judge(copy, index, mutation)
      outcomes.push(outcome)
      const badge = outcome.verdict === 'killed' ? '✔' : outcome.verdict === 'survived' ? '✖' : '⚠'
      log(`${badge} ${mutation.id} @ ${mutation.file} ${outcome.verdict} ${(outcome.ms / 1000).toFixed(1)}s`)
      if (options.keep !== true) removeCopy(copy, runRoot)
    }
  } catch (error) {
    if (options.keep !== true) removeRunRoot(workRoot, runRoot)
    const result = failed(`变异测试中止：${messageOf(error)}`)
    // `--keep` 时副本确实还留着：报告里就不能说「没保留」（否则用户照着空路径去排查）。
    if (options.keep === true) {
      result.workdir = runRoot
      result.kept = true
    }
    return result
  }

  const killed = outcomes.filter((outcome) => outcome.verdict === 'killed').length
  const survived = outcomes.filter((outcome) => outcome.verdict === 'survived').length
  const buildErrors = outcomes.filter((outcome) => outcome.verdict === 'build-error').length
  const kept = options.keep === true
  let workdir: string | null = null
  if (kept) workdir = runRoot
  else removeRunRoot(workRoot, runRoot)
  return {
    workdir,
    kept,
    outcomes,
    tried: outcomes.length,
    killed,
    survived,
    buildErrors,
    exitCode: survived > 0 ? EXIT_SURVIVED : EXIT_OK,
    error: null,
  }
}

/** 本仓库的构建/测试命令：tsc 从仓库自己的 node_modules 取，路径不写死。 */
export interface RepoCommands {
  build: CommandSpec
  test: CommandSpec
}

/**
 * 组装本仓库的命令；拿不到就返回原因（环境问题要明说，不许静默跳过）。
 * 不用 npm/pnpm 包一层：node 直接跑 tsc 与测试，少一层 shell 少一类平台坑。
 */
export function repoCommands(repo: string): { commands: RepoCommands | null; error: string | null } {
  const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) {
    return {
      commands: null,
      error: `没有找到 TypeScript（${tsc}）：先装依赖（pnpm install / npm install）或确认 node_modules 存在；本次没有跑任何变异。`,
    }
  }
  return {
    commands: {
      build: { command: process.execPath, args: [tsc, '-p', 'tsconfig.json'] },
      test: { command: process.execPath, args: ['--test', ...TEST_FILES] },
    },
    error: null,
  }
}

/** 判定 → 中文标签。 */
export const VERDICT_LABELS: Readonly<Record<MutationVerdict, string>> = {
  killed: '被杀死',
  survived: '存活',
  'build-error': '编译期失败',
}

/** 只打印目录（`--list`）。 */
function printCatalogue(mutations: readonly Mutation[]): void {
  console.log(`内置变异目录：${mutations.length} 条`)
  for (const mutation of mutations) {
    console.log(`  · ${mutation.id} @ ${mutation.file} —— ${mutation.note}`)
  }
}

/** 报告头（跑之前打印，长跑时至少知道这次要跑什么）。 */
function printHeader(repo: string, catalogueSize: number, options: Options, tried: number): void {
  console.log(`变异测试：${repo}`)
  const scope = options.only === null ? `本次跑 ${tried} 条（seed ${options.seed}，limit ${options.limit === 0 ? '全部' : options.limit}）` : `本次只跑 --only ${options.only}`
  console.log(`目录 ${catalogueSize} 条，${scope}`)
}

/** 汇总 + 存活项（逐条明细在跑的过程中已经打过了）。 */
function printSummary(result: RunTestingResult): void {
  if (result.error !== null) {
    console.log(`❌ 环境问题：${result.error}`)
    return
  }
  const seconds = (result.outcomes.reduce((sum, outcome) => sum + outcome.ms, 0) / 1000).toFixed(1)
  console.log(`试了 ${result.tried} 条，杀死 ${result.killed}，存活 ${result.survived}（编译期失败 ${result.buildErrors}，用时 ${seconds}s）`)
  const survivors = result.outcomes.filter((outcome) => outcome.verdict === 'survived')
  if (survivors.length > 0) {
    console.log('存活项（盲区）：')
    for (const outcome of survivors) console.log(`  · ${outcome.mutation.id} @ ${outcome.mutation.file} —— ${outcome.mutation.note}`)
    console.log('存活 ≠ 一定是漏洞，但值得看一眼。')
  }
  if (result.kept && result.workdir !== null) console.log(`副本保留在：${result.workdir}`)
}

/** 机器可读结果（`--json`）。 */
function jsonReport(repo: string, catalogueSize: number, options: Options, result: RunTestingResult): unknown {
  return {
    repo,
    catalogue: catalogueSize,
    seed: options.seed,
    limit: options.limit,
    tried: result.tried,
    killed: result.killed,
    survived: result.survived,
    buildErrors: result.buildErrors,
    exitCode: result.exitCode,
    error: result.error,
    kept: result.kept,
    workdir: result.workdir,
    outcomes: result.outcomes.map((outcome) => ({
      id: outcome.mutation.id,
      file: outcome.mutation.file,
      verdict: outcome.verdict,
      ms: outcome.ms,
      note: outcome.mutation.note,
      detail: outcome.detail,
    })),
  }
}

/** CLI 的公共尾巴：组装命令 → 跑 → 打印 → 定退出码。 */
function runCli(repo: string, catalogue: Mutation[], options: Options): void {
  let chosen: Mutation[]
  if (options.only !== null) {
    const found = catalogue.find((mutation) => mutation.id === options.only)
    if (found === undefined) {
      console.error(`没有这条变异：${options.only}`)
      console.error(`用 node tools/mutate.ts --list 看全部 ${catalogue.length} 条。`)
      process.exitCode = EXIT_ENVIRONMENT
      return
    }
    chosen = [found]
  } else {
    chosen = sampleMutations(catalogue, options.limit, options.seed)
  }

  const { commands, error } = repoCommands(repo)
  if (commands === null || error !== null) {
    if (options.json) console.log(JSON.stringify({ repo, error, exitCode: EXIT_ENVIRONMENT }, null, 2))
    else {
      console.log(`变异测试：${repo}`)
      console.log(`❌ 环境问题：${error}`)
    }
    process.exitCode = EXIT_ENVIRONMENT
    return
  }

  if (!options.json) printHeader(repo, catalogue.length, options, chosen.length)
  const result = runMutationTesting({
    repo,
    mutations: chosen,
    build: commands.build,
    test: commands.test,
    keep: options.keep,
    onLine: options.json ? undefined : (line) => console.log(`  ${line}`),
  })
  if (options.json) console.log(JSON.stringify(jsonReport(repo, catalogue.length, options, result), null, 2))
  else printSummary(result)
  process.exitCode = result.exitCode
}

/** 只有被 `node tools/mutate.ts` 直接运行时才执行 CLI；被 import 时只导出上面的函数。 */
function isDirectRun(): boolean {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  const self = fileURLToPath(import.meta.url)
  const invoked = resolvePath(argv1)
  return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self
}

if (isDirectRun()) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
  const options = parseArgs(process.argv.slice(2))
  const catalogue = mutationCatalogue()
  if (options.list) {
    if (options.json) console.log(JSON.stringify({ repo, catalogue }, null, 2))
    else printCatalogue(catalogue)
  } else {
    runCli(repo, catalogue, options)
  }
}

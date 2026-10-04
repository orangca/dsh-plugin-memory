// verify-self-contained.ts — 断言这个仓库存下来的东西**自己就够用**（GitHub 直接安装能跑）。
//
// 为什么需要它：`dsh plugin add github:<owner>/<repo>` 拉的是源码、**不跑构建脚本**，
// 所以「装下来能跑」只依赖三件事，任何一件悄悄破掉，本地开发都看不出来：
//   1. package.json 的 `dependencies` 必须是空的 —— 有运行期依赖就得联网装包，
//      而 GitHub 安装路径既不装包、也不跑构建；
//   2. src/ 与 tools/ 里的 bare import 只能指向 devDependencies 或 Node 内置模块 ——
//      指向运行期第三方包就等于把上面那条约束抄近路绕开（类型导入不算运行期依赖）；
//   3. 实际打包产物里必须有入口与文档（lib/index.js、lib/lib.js、lib/client.js、
//      cordis.patch.yml、README.md、README.zh.md），否则 `files` 字段漏改也没人知道；
//   4. 发布物里不能出现隐私：本机用户名、绝对路径（盘符 `C:\` / `C:/`、POSIX 家目录、UNC、
//      `~/` 家目录简写、%USERPROFILE%）、真实 $DSH_HOME，也不能出现凭证（`sk-` / `AKIA` /
//      `ghp_` / `xox[baprs]-` / `-----BEGIN … PRIVATE KEY-----` / JWT）——`docs/` 全量进包之后，
//      顺手贴进文档的本机路径或密钥会跟着发布出去；扫描范围就是 npm pack **实际会发布的每个文件**
//      （与第 3 条共用同一次 npm pack，不重复跑）。
//      注意：本机用户名与 $DSH_HOME 这两条判据依赖环境——CI（ubuntu-latest，username=runner）里
//      它们**等于失效**，所以失效时必须显式说明「没有扫」（跳过 ≠ 通过），绝不静默给「干净」。
//
// 用法：node tools/verify-self-contained.ts [--json] [--no-pack] [--repo <绝对路径>]
//   --json      机器可读结果（CI 用）
//   --no-pack   跳过 npm pack 自检（离线 / 不方便跑 npm 时）
//   --repo      指定仓库根（默认按脚本位置推断，不写死任何绝对路径）
// 退出码：0 = 通过（或显式跳过）；1 = 有失败项；不拿「拿不到」当「通过」。
//
// 环境变量：
//   VERIFY_NPM_CACHE     给 npm 用的私有 cache 目录（默认 os.tmpdir()/dsh-npm-cache）。
//                        为什么需要：本机 npm 默认 cache 落在 Program Files 下，沙箱里不可写，
//                        `npm pack` 会直接以 EPERM 失败。给个临时 cache 才能真的把包列出来；
//                        真装不上时脚本会**跳过并说明**，绝不误报成功。
//   VERIFY_NPM_TIMEOUT   单次 npm 调用的超时毫秒数（默认 120000）。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

/** 一条检查的结论。 */
export interface CheckResult {
  /** 检查项标识（CI 里可用来筛选）。 */
  id: string
  /** 一句人话说明这项在查什么。 */
  title: string
  /** pass = 通过；fail = 违反约束；skip = 环境做不到，已明说原因。 */
  status: 'pass' | 'fail' | 'skip'
  /** 逐条证据：通过项也打印，方便肉眼复核。 */
  details: string[]
}

/** 脚本的整体结论。 */
export interface VerifyResult {
  ok: boolean
  /** 失败项个数（skip 不计入）。 */
  failures: number
  /** 跳过项个数（skip 一律打印原因）。 */
  skipped: number
  checks: CheckResult[]
}

/** 选项。 */
export interface VerifyOptions {
  repo: string
  /** 是否跑 npm pack 自检（默认真跑）。 */
  pack: boolean
  /** 给 npm 用的 cache 目录。 */
  npmCache: string
  /** 单次 npm 调用超时毫秒数。 */
  npmTimeoutMs: number
}

/** 打包产物里必须出现的成员（与 package.json 的 `files` 及 main/exports 对应）。 */
export const REQUIRED_PACK_FILES: readonly string[] = [
  'lib/index.js',
  'lib/lib.js',
  'lib/client.js',
  'cordis.patch.yml',
  'README.md',
  'README.zh.md',
]

/** Node 内置模块名集合（builtinModules 不含 `node:` 前缀，也不含只在裸写时出现的子路径）。 */
const BUILTINS: ReadonlySet<string> = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

/** typescript 自身永远算「零运行期依赖」。 */
const TYPESCRIPT_PACKAGE = 'typescript'

/**
 * 客户端半边（src/client.ts）的刻意豁免：它的产出是 lazy-CJS 的 `lib/client.js`，
 * `require` 由 DSH 客户端模块系统注入，**不经过我们自己的 node_modules**：
 *   · `react/jsx-runtime`：注释里写明由工厂注入（官方客户端预设的 external）
 *   · `@deepseek-ai/dsh-client-ui-primitives`：package.json 的 `dsh.client.inject` + 可选 peerDependency
 * 这两条不是「随便放行」，而是白名单 + 校验：只有同时满足「出现在 shims.d.ts 的 declare module」
 * 或「在 package.json 里声明了 dsh.client.inject / peerDependencies」，才记为客户端豁免。
 * 其余任何运行期第三方裸导入（服务端半边尤其不允许）一律报错。
 */
const CLIENT_SIDE_FILE = 'src/client.ts'

/** package.json 里与客户端外部模块有关的字段。 */
interface ClientExternals {
  /** `dsh.client.inject` 声明的模块。 */
  injected: Set<string>
  /** peerDependencies 里声明的包（可选 peer 也算「由宿主提供」）。 */
  peers: Set<string>
  /** shims.d.ts 里 `declare module '…'` 声明的模块。 */
  shimmed: Set<string>
}

/** 从一条 import/export 语句里抽出的模块说明符。 */
interface Specifier {
  /** import 语句里写的原始模块说明符。 */
  raw: string
  /** 判断归属用的包名（`@scope/name` 保留两段，其余只取第一段；`node:fs` 归一成 `fs`）。 */
  packageName: string
  /** 是否裸导入（不以 `.` 开头、不以 `node:` 开头、不是绝对路径）。 */
  bare: boolean
  /** 是否纯类型导入（`import type ... from`）—— 编译后不存在，不算运行期依赖。 */
  typeOnly: boolean
  /** 出现所在行的 1 基行号。 */
  line: number
}

/** `.ts` 源码里一条可能指向第三方包的模块说明符。 */
interface SourceSpecifier extends Specifier {
  /** 相对仓库根的路径（POSIX 分隔符）。 */
  file: string
}

/**
 * 模块说明符的**静态部分**，只认两种真正的导入语法：
 *   1. `import … from 'spec'` / `export … from 'spec'`（含 `import type { … } from 'spec'`）
 *   2. 只求副作用的裸 `import 'spec'`
 *
 * 为什么不用一条宽松的「行里出现 from '...'」正则：那种写法会把**注释和字符串**里的
 * `from 'x'` 也当成导入（本文件自己的中文注释里就写着 `from '...'`），于是自检工具会
 * 自证有罪（假阳性）。多行 import 语句在这里按行拼接后仍然只算一次，因为 `from` 只出现一次。
 *
 * 已知代价：`import * as x from './y'` 的 `x` 会被当成「被导入的名字」，
 * 只有在 x 恰好与某个依赖同名时才可能漏报；动态 `import('spec')` 需要真的在源码里出现，
 * 一旦出现会在 `imports` 检查里以「没有出现在任何 import 语句里」的形式报出来。
 */
const SPECIFIER_PATTERNS: readonly { pattern: RegExp; specifierGroup: number; headGroup: number }[] = [
  {
    pattern: /(?:^|[;{}\s])(?:import|export)\s*([^;]*?)\s+from\s*['"]([^'"]+)['"]/gmu,
    specifierGroup: 2,
    headGroup: 1,
  },
  {
    pattern: /(?:^|[;{}\s])import\s+['"]([^'"]+)['"]/gmu,
    specifierGroup: 1,
    headGroup: 1,
  },
]

/** 一个文件里出现的说明符，按行号排序去重。 */
function specifiersOf(text: string): Specifier[] {
  // 先把「行尾换行 + 行首空白」折成一个空格：多行 import 语句拼成一行后，上面的行正则仍然成立。
  const flat = text.replace(/[ \t]*\r?\n[ \t]*/gu, ' ')
  const found: Specifier[] = []
  for (const { pattern, specifierGroup, headGroup } of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0
    let matched: RegExpExecArray | null
    while ((matched = pattern.exec(flat)) !== null) {
      const raw = (matched[specifierGroup] ?? '').trim()
      if (raw.length === 0) continue
      const head = matched[headGroup] ?? ''
      found.push({
        raw,
        packageName: packageNameOf(raw),
        bare: isBareSpecifier(raw),
        // `import type { X } from 'pkg'` 编译后整条语句消失，不算运行期依赖。
        typeOnly: /import\s+type\b/u.test(head),
        line: lineAt(text, matched.index),
      })
    }
  }
  return found
}

/** 折平后的偏移量 → 原文 1 基行号（用于失败信息里给出行号）。 */
function lineAt(text: string, flatIndex: number): number {
  let line = 1
  let cursor = 0
  // 折平只吃掉「空白 + 换行」，所以反向扫描原文字符数即可：逐行推进到覆盖该偏移。
  for (const raw of text.split(/\r?\n/u)) {
    const consumed = raw.replace(/^[ \t]+/u, '').length
    if (cursor + consumed >= flatIndex) return line
    cursor += consumed + 1
    line += 1
  }
  return line
}

/** 说明符 → 包名：`@scope/name/sub` → `@scope/name`；`fs/promises` → `fs`；`node:fs` → `fs`。 */
export function packageNameOf(specifier: string): string {
  const withoutProtocol = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  const segments = withoutProtocol.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return withoutProtocol
  if (withoutProtocol.startsWith('@')) return segments.slice(0, 2).join('/')
  return segments[0] ?? withoutProtocol
}

/** 是否是裸导入：不以 `.` 开头、不以 `node:` 开头、不是绝对路径、不是 URL 协议。 */
export function isBareSpecifier(specifier: string): boolean {
  if (specifier.length === 0) return false
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('\\')) return false
  if (specifier.startsWith('node:')) return false
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(specifier)) return false // file: / data: / https: 等
  return true
}

/** 从 import 语句的整个 head 里判断有没有 `type` 关键字（`import type { … } from`）。 */
function isTypescriptPackage(name: string): boolean {
  return name === TYPESCRIPT_PACKAGE
}

/** package.json 里我们真正读到的字段。 */
interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  files?: string[]
  dsh?: { client?: { inject?: string[] } }
}

/** 收集「由 DSH 客户端模块系统提供」的外部模块清单。 */
function clientExternalsOf(repo: string, manifest: PackageManifest): ClientExternals {
  const injected = new Set(manifest.dsh?.client?.inject ?? [])
  const peers = new Set(Object.keys(manifest.peerDependencies ?? {}))
  const shimmed = new Set<string>()
  try {
    const shims = readFileSync(join(repo, 'src', 'shims.d.ts'), 'utf8')
    for (const matched of shims.matchAll(/declare\s+module\s+['"]([^'"]+)['"]/gu)) {
      const name = matched[1]
      if (name !== undefined) shimmed.add(name)
    }
  } catch {
    // shims.d.ts 读不到就不算豁免，宁可报错也不要静默放行。
  }
  return { injected, peers, shimmed }
}

/** 这条裸导入能不能按「客户端外部模块」豁免。 */
function isClientExternal(specifier: SourceSpecifier, externals: ClientExternals): boolean {
  if (specifier.file !== CLIENT_SIDE_FILE) return false
  const raw = specifier.raw
  const packageName = specifier.packageName
  // shim 声明的模块（精确匹配）或声明了 dsh.client.inject / peerDependencies 的包。
  return externals.shimmed.has(raw) || externals.injected.has(packageName) || externals.peers.has(packageName)
}

/** 递归列出 dir 下的文件（相对 root 的 POSIX 路径），不做 glob，纯 node:fs。 */
function listFiles(root: string, dir: string, extensions: readonly string[]): string[] {
  const out: string[] = []
  const walk = (absolute: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(absolute, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        out.push(relativePosix(root, child))
      }
    }
  }
  walk(dir)
  return out.sort()
}

/** 绝对路径 → 相对 root 的 POSIX 路径。 */
function relativePosix(root: string, absolute: string): string {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  const relative = absolute.startsWith(normalizedRoot) ? absolute.slice(normalizedRoot.length) : absolute
  return relative.split(sep).join('/')
}

/** 检查 1：`dependencies` 必须为空或不存在。 */
function checkDependencies(manifest: PackageManifest): CheckResult {
  const dependencies = manifest.dependencies
  const names = dependencies === undefined ? [] : Object.keys(dependencies)
  if (dependencies === undefined) {
    return {
      id: 'dependencies',
      title: 'package.json 没有 dependencies 字段（GitHub 直接安装可跑的前提）',
      status: 'pass',
      details: ['dependencies：不存在（等价于空）'],
    }
  }
  if (names.length === 0) {
    return {
      id: 'dependencies',
      title: 'package.json 的 dependencies 为空',
      status: 'pass',
      details: ['dependencies：{}'],
    }
  }
  return {
    id: 'dependencies',
    title: 'package.json 的 dependencies 必须为空',
    status: 'fail',
    details: [
      `dependencies 里有 ${names.length} 个运行期依赖：${names.map((name) => `\`${name}\``).join(', ')}`,
      'GitHub 安装路径不装包也不跑构建，出现运行期依赖就意味着装下来直接加载失败。',
      '若只是开发/类型用途，请移到 devDependencies。',
    ],
  }
}

/** 检查 2：src/*.ts 与 tools/*.ts 的 bare import 只能来自 devDependencies 或 typescript。 */
function checkImports(repo: string, manifest: PackageManifest): CheckResult {
  const devDependencies = new Set(Object.keys(manifest.devDependencies ?? {}))
  const scanned = [
    ...listFiles(repo, join(repo, 'src'), ['.ts']),
    ...listFiles(repo, join(repo, 'tools'), ['.ts']),
  ]

  const all: SourceSpecifier[] = []
  for (const file of scanned) {
    let text: string
    try {
      text = readFileSync(join(repo, file), 'utf8')
    } catch {
      continue
    }
    for (const specifier of specifiersOf(text)) {
      all.push({ ...specifier, file })
    }
  }

  const runtimeBare = all.filter((item) => item.bare && !item.typeOnly)
  const typeOnlyBare = all.filter((item) => item.bare && item.typeOnly)
  const relative = all.filter((item) => !item.bare)

  const externals = clientExternalsOf(repo, manifest)
  const isThirdParty = (item: SourceSpecifier): boolean =>
    !BUILTINS.has(item.packageName) && !BUILTINS.has(item.raw) && !isTypescriptPackage(item.packageName)

  const thirdPartyRuntime = runtimeBare.filter(isThirdParty)
  const clientExempt = thirdPartyRuntime.filter((item) => isClientExternal(item, externals))
  // 真正的违规：运行期第三方裸导入，且不满足「devDependencies + 客户端白名单」两条豁免之一。
  const offenders = thirdPartyRuntime.filter(
    (item) => !devDependencies.has(item.packageName) && !isClientExternal(item, externals),
  )
  const typeOnlyAllowed = typeOnlyBare.filter((item) => devDependencies.has(item.packageName) || isTypescriptPackage(item.packageName))

  const details = [
    `扫描文件：${scanned.length} 个（src/*.ts ${scanned.filter((f) => f.startsWith('src/')).length} 个，tools/*.ts ${scanned.filter((f) => f.startsWith('tools/')).length} 个）`,
    `模块说明符：相对导入 ${relative.length} 条，裸导入 ${runtimeBare.length + typeOnlyBare.length} 条（其中 import type ${typeOnlyBare.length} 条）`,
    runtimeBare.length === 0
      ? '运行期裸导入：无'
      : `运行期裸导入 ${runtimeBare.length} 条（其中非内置 ${thirdPartyRuntime.length} 条）：${runtimeBare
          .slice(0, 12)
          .map((item) => `${item.raw}@${item.file}:${item.line}`)
          .join(', ')}${runtimeBare.length > 12 ? ` …共 ${runtimeBare.length} 条` : ''}`,
    typeOnlyBare.length === 0
      ? 'import type 裸导入：无'
      : `import type 裸导入（豁免，编译后不存在）：${typeOnlyBare
          .slice(0, 8)
          .map((item) => `${item.raw}@${item.file}:${item.line}`)
          .join(', ')}${typeOnlyBare.length > 8 ? ` …共 ${typeOnlyBare.length} 条` : ''}`,
  ]

  if (clientExempt.length > 0) {
    details.push(`${CLIENT_SIDE_FILE} 的客户端外部模块（由 DSH 客户端模块系统注入，不走 node_modules）：`)
    for (const item of clientExempt) {
      const why = externals.shimmed.has(item.raw)
        ? 'shims.d.ts 的 declare module'
        : externals.injected.has(item.packageName)
          ? 'package.json dsh.client.inject'
          : 'package.json peerDependencies'
      details.push(`  · \`${item.raw}\` @ ${item.file}:${item.line}（依据：${why}）`)
    }
  }

  if (offenders.length > 0) {
    details.push('以下运行期裸导入既不在 devDependencies、也不是 Node 内置模块、也不是客户端外部模块：')
    for (const item of offenders) {
      details.push(`  · \`${item.raw}\` @ ${item.file}:${item.line}（包名 ${item.packageName}）`)
    }
    details.push('运行期第三方包必须为 0：要么改成 import type，要么移进 devDependencies，要么（客户端半边）声明为宿主注入的外部模块。')
    return { id: 'imports', title: 'src/ 与 tools/ 的裸导入只能来自 devDependencies、内置模块或客户端外部模块', status: 'fail', details }
  }

  if (thirdPartyRuntime.length > 0) {
    details.push(
      `非内置裸导入 ${thirdPartyRuntime.length} 条全部合规（devDependencies ${thirdPartyRuntime.filter((item) => devDependencies.has(item.packageName)).length} 条，客户端外部模块 ${clientExempt.length} 条，import type 另有 ${typeOnlyAllowed.length} 条）。`,
    )
    details.push('服务端半边（lib/index.js、lib/lib.js）没有任何未声明的运行期第三方依赖。')
  } else {
    details.push('src/ 与 tools/ 里没有任何运行期第三方包导入。')
  }

  return { id: 'imports', title: 'src/ 与 tools/ 的裸导入只能来自 devDependencies、内置模块或客户端外部模块', status: 'pass', details }
}

/**
 * npm 在 Windows 上必须走 shell：npm 实体是 `npm.cmd`，`spawnSync('npm', …)` 会 ENOENT。
 * POSIX 上直接用 npm（无 shell），避免命令串被再次解释。
 */
export function npmInvocation(environment: NodeJS.ProcessEnv = process.env): { command: string; shell: boolean } {
  const isWindows = (environment.OS ?? process.platform) === 'win32'
  return isWindows ? { command: 'npm.cmd', shell: true } : { command: 'npm', shell: false }
}

/**
 * `npm` 到底能不能启动：Windows 上 npm 是 `npm.cmd`（PATH 里没有裸 `npm`）。
 * 本沙箱里 `spawnSync('npm', …)` 会 ENOENT，正是这个坑。
 */
export function npmCanStart(environment: NodeJS.ProcessEnv = process.env): boolean {
  const candidates = (environment.OS ?? process.platform) === 'win32' ? ['npm.cmd', 'npm'] : ['npm']
  for (const command of candidates) {
    const probe = spawnSync(`${command} --version`, {
      shell: true,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    if (probe.error === undefined && probe.status === 0 && typeof probe.stdout === 'string' && probe.stdout.trim().length > 0) {
      return true
    }
  }
  return false
}

/**
 * 试一次 npm pack，返回拿到的 stdout 文本（拿不到就是空串）。
 *
 * 为什么不直接用 `spawnSync(npm, …, { encoding: 'utf8' })`：本沙箱下管道捕获会 EINVAL/EPERM，
 * 只拿到空串——那正是「拿不到却当成通过」的经典坑。所以主路径是
 * 「stdout 重定向到临时文件再读」；调用方还会用管道捕获再试一次，两路都空才算拿不到。
 */
function tryNpmPack(commandLine: string, options: VerifyOptions, env: NodeJS.ProcessEnv): { status: number | null; error?: Error; stdout: string; stderr: string } {
  // 本函数的调用方已经用 npmCanStart() 确认过 npm 能启动，走到这里强制走 shell（Windows 的 npm 是 .cmd）。
  const outputFile = join(options.npmCache, 'pack-dry-run.json')
  const stderrFile = `${outputFile}.stderr`
  try {
    const result = spawnSync(`${commandLine} > "${outputFile}" 2> "${stderrFile}"`, {
      shell: true,
      encoding: 'utf8',
      cwd: options.repo,
      env,
      timeout: options.npmTimeoutMs,
      windowsHide: true,
    })
    const text = readTextFile(outputFile)
    const stderr = readTextFile(stderrFile)
    return {
      status: result.status,
      error: result.error ?? undefined,
      stdout: text.length > 0 ? text : typeof result.stdout === 'string' ? result.stdout : '',
      stderr: stderr.length > 0 ? stderr : typeof result.stderr === 'string' ? result.stderr : '',
    }
  } catch (error) {
    return { status: null, error: error instanceof Error ? error : new Error(String(error)), stdout: '', stderr: '' }
  }
}

/** 读一个可选文件；读不到返回空串（不抛）。 */
function readTextFile(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

/**
 * npm pack 清单探测结果：检查 3（产物清单）与检查 4（隐私扫描）共用**同一次** npm pack，
 * 所以真实清单从这里传出去，而不是让隐私扫描为了拿清单再跑一遍 npm。
 */
interface PackListing {
  /** 真实发布物清单（相对仓库根的 POSIX 路径）；拿不到清单时保持 null。 */
  files: string[] | null
}

/** 检查 3：npm pack --dry-run --json 的产物清单必须包含入口与文档。 */
function checkPack(options: VerifyOptions, listing: PackListing): CheckResult {
  const id = 'pack'
  const title = 'npm pack 产物必须包含入口与文档'

  if (!options.pack) {
    return {
      id,
      title,
      status: 'skip',
      details: ['已用 --no-pack 跳过（本次没有验证打包清单）。'],
    }
  }

  mkdirSync(options.npmCache, { recursive: true })
  const npm = npmCanStart() ? npmInvocation() : null
  if (npm === null) {
    return {
      id,
      title,
      status: 'skip',
      details: [
        'npm 不可用（`npm --version` / `npm.cmd --version` 都没跑通），本次没有验证打包清单。',
        '这属于「没验证」，不是「通过」：请在有 npm 的环境（或显式用 --no-pack 跳过）再跑一次。',
      ],
    }
  }
  const commandLine = `${npm.command} pack --dry-run --json`
  // 私有 cache：本机 npm 默认 cache 落在 Program Files 下，沙箱里不可写，
  // 不换 cache 时 npm pack 直接 EPERM。换 cache 后 npm 的 stdout 就是真正的产物清单。
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_cache: options.npmCache,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }

  // 第一次：shell 重定向到临时文件再读（沙箱下管道捕获可能拿不到，见 tryNpmPack 注释）。
  let run = tryNpmPack(commandLine, options, environment)
  // 第二次：同一命令换管道捕获。两路都拿不到才算「拿不到」——绝不当成通过。
  if (run.stdout.trim().length === 0) {
    const piped = spawnSync(commandLine, {
      shell: npm.shell,
      cwd: options.repo,
      env: environment,
      encoding: 'utf8',
      timeout: options.npmTimeoutMs,
      windowsHide: true,
    })
    run = {
      status: piped.status,
      error: piped.error ?? undefined,
      stdout: typeof piped.stdout === 'string' ? piped.stdout : '',
      stderr: typeof piped.stderr === 'string' ? piped.stderr : '',
    }
  }

  const text = run.stdout
  const failDetail = (prefix: string): string[] => [
    `${prefix}（shell 重定向与管道捕获都试过；最后一次退出码：${run.status === null ? 'null' : run.status}）`,
    run.error === undefined ? '无 spawn 错误' : `spawn 错误：${run.error.message}`,
    run.stderr.trim().length > 0 ? `stderr：${firstLines(run.stderr, 3)}` : 'stderr：空',
    '这属于「没验证」，不是「通过」：请在有 npm 的环境（或用 --no-pack 显式跳过）再跑一次。',
  ]

  if (text.trim().length === 0) {
    return { id, title, status: 'skip', details: failDetail('npm 不可用或拿不到输出') }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      id,
      title,
      status: 'skip',
      details: [
        `npm pack --dry-run --json 输出了 ${text.length} 字节，但不是合法 JSON，没有验证包内容。`,
        `解析错误：${error instanceof Error ? error.message : String(error)}`,
        `输出开头：${firstLines(text, 2)}`,
        '这属于「没验证」，不是「通过」。',
      ],
    }
  }

  // npm 在失败时（如 cache EPERM）也会输出一个合法 JSON 的 `{ error: … }`，必须区分开。
  const failure = packFailureOf(parsed)
  if (failure !== null) {
    return {
      id,
      title,
      status: 'skip',
      details: [`npm pack 报了错：${failure}`, ...failDetail('没有拿到真正的产物清单')],
    }
  }

  const files = packPathsOf(parsed)
  if (files === null || files.length === 0) {
    return {
      id,
      title,
      status: 'fail',
      details: [
        'npm pack --dry-run --json 的 JSON 里没有 files 数组，或数组为空。',
        `输出开头：${firstLines(text, 2)}`,
      ],
    }
  }

  // 真的拿到清单了：交给调用方（隐私扫描）复用这一份，避免再跑一次 npm pack。
  listing.files = files

  const have = new Set(files)
  const missing = REQUIRED_PACK_FILES.filter((required) => !have.has(required))
  const details = [
    `npm pack 产物 ${files.length} 个文件（已返回真实清单）。`,
    `必需项：${REQUIRED_PACK_FILES.map((file) => (have.has(file) ? '✅' : '❌') + file).join('  ')}`,
    `lib/ 产物：${files.filter((file) => file.startsWith('lib/')).join(', ') || '（无）'}`,
  ]
  if (missing.length > 0) {
    details.push(`缺少 ${missing.length} 项：${missing.join(', ')}`)
    details.push('检查 package.json 的 `files` 字段与构建是否跑到（lib/index.js、lib/lib.js、lib/client.js 缺一个就装不起来）。')
    return { id, title, status: 'fail', details }
  }
  return { id, title, status: 'pass', details }
}

/** 取 JSON 输出里的错误信息；不是错误结构就返回 null。 */
function packFailureOf(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const error = (parsed as { error?: unknown }).error
  if (error === undefined || error === null) return null
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    const summary = (error as { summary?: unknown }).summary
    const code = (error as { code?: unknown }).code
    if (typeof summary === 'string') return typeof code === 'string' ? `${code}: ${summary}` : summary
  }
  return '未知错误结构'
}

/** 从 `npm pack --json` 的输出里抽文件路径列表；结构不对返回 null。 */
export function packPathsOf(parsed: unknown): string[] | null {
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const out: string[] = []
  let sawFiles = false
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const files = (entry as { files?: unknown }).files
    if (!Array.isArray(files)) continue
    sawFiles = true
    for (const file of files) {
      if (file !== null && typeof file === 'object' && typeof (file as { path?: unknown }).path === 'string') {
        // npm 在不同平台用 `/` 或 `\` 列路径，统一成 POSIX 再比对。
        out.push((file as { path: string }).path.replace(/\\/gu, '/'))
      }
    }
  }
  return sawFiles ? out : null
}

/** 取前 n 行，给失败信息用；每行都折平，避免刷屏。 */
function firstLines(text: string, count: number): string {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .slice(0, count)
    .join(' / ')
}

// ─────────────────────────────────────────────────────────────────────────────
// 检查 4：发布物的隐私扫描
//
// 为什么：`files` 里放开 `docs/` 之后，「顺手把本机路径贴进文档」会跟着包一起被发布出去
// （本机用户名、家目录、真实 $DSH_HOME、密钥）；靠人工扫迟早会漏，所以对 npm pack **实际会发布的每个文件**逐行扫。
//
// 判据（四条路径类 + 身份类 + 凭证类）：
//   · 本机用户名（`os.userInfo().username`，大小写不敏感）—— 但 CI / 容器的通用账号（runner、root）
//     不是任何人的身份信息，拿它当判据只会把通用词当成泄漏：这类环境下这一条**没有扫**；
//   · 绝对路径：盘符 `[A-Za-z]:\` 与 `[A-Za-z]:/`（含 `file:///D:/…`）、`/Users/<name>`、`/home/<name>`
//     （**不要求尾斜杠**）、UNC `\\host\share`、`~/…`、`%USERPROFILE%`；
//   · 真实 $DSH_HOME（若该环境变量存在）；
//   · 常见凭证形状：`sk-`+长随机串、`AKIA`+16 位、`ghp_`+长随机串、`xox[baprs]-`+长串、
//     `-----BEGIN … PRIVATE KEY-----`、三段式 JWT。判据只认「前缀 + 足够长度」的形状，
//     文档里单独出现 `sk-`、`AKIA`、`ghp_` 这类前缀**不算命中**（宁可窄一点，也不要假阳性）。
//
// 口径（与检查 3 一致：宁可说「没验证」，也绝不说「通过」）：
//   · 命中 ⇒ fail（退出码非零），报告 文件 + 行号 + 命中类型；**不回显命中行的内容**，
//     免得把隐私再誊写进 CI 日志；
//   · 二进制 / 超大文件安全跳过（读不动不算失败），但跳过必须显式说明「跳过 ≠ 通过」；
//   · 拿不到 pack 清单（--no-pack / npm 不可用）⇒ 这一条 skip 并说明原因，绝不记成通过；
//   · 身份类判据在本次环境下不可靠（取不到用户名 / 是 runner、root 这类通用账号 / 没有 $DSH_HOME）
//     ⇒ 显式列出「没有扫」的判据并把整条检查降为 skip（跳过 ≠ 通过）：0 命中只说明扫过的判据
//     没命中，不说明发布物干净。绝不静默给「干净」。

/** 单文件扫描上限（字节）：超过就跳过。发布物里最大的是编译产物，量级远小于此。 */
export const PRIVACY_MAX_FILE_BYTES = 2 * 1024 * 1024

/** 单文件最多报几处明细；更多只报总数，避免一个文件刷屏。 */
const PRIVACY_MAX_HITS_PER_FILE = 5

/** 命中类型。 */
export type PrivacyKind =
  | 'username'
  | 'windows-drive-path'
  | 'posix-home-path'
  | 'unc-path'
  | 'home-shorthand'
  | 'userprofile-env'
  | 'dsh-home'
  | 'secret-api-key'
  | 'secret-aws-access-key'
  | 'secret-github-token'
  | 'secret-slack-token'
  | 'secret-private-key'
  | 'secret-jwt'

/** 命中类型 → 人话（报告里只说类型，绝不回显命中内容）。 */
const PRIVACY_KIND_LABELS: Readonly<Record<PrivacyKind, string>> = {
  username: '本机用户名',
  'windows-drive-path': 'Windows 盘符绝对路径',
  'posix-home-path': 'POSIX 家目录绝对路径（/Users/… 或 /home/…）',
  'unc-path': 'UNC 网络路径（\\\\host\\share）',
  'home-shorthand': '家目录简写路径（~/…）',
  'userprofile-env': '%USERPROFILE% 路径',
  'dsh-home': '真实 $DSH_HOME 路径',
  'secret-api-key': '疑似 API 密钥（sk- 前缀 + 长随机串）',
  'secret-aws-access-key': '疑似 AWS Access Key ID（AKIA + 16 位）',
  'secret-github-token': '疑似 GitHub 令牌（ghp_ 前缀 + 长随机串）',
  'secret-slack-token': '疑似 Slack 令牌（xox[baprs]- 前缀 + 长串）',
  'secret-private-key': '私钥文件头（PRIVATE KEY）',
  'secret-jwt': '疑似 JWT（三段式随机串）',
}

/**
 * CI / 容器里的通用账号：这些名字不是「某个人的身份」，出现在文档里是常态，
 * 拿它当隐私判据只会把通用词当成泄漏（假阳性）。命中它们时这一条判据**等于失效**。
 *   · `runner` —— GitHub Actions（ubuntu-latest）的默认用户；
 *   · `root`   —— POSIX 容器 / 多数 CI 镜像的默认用户。
 */
export const GENERIC_CI_USERNAMES: ReadonlySet<string> = new Set(['runner', 'root'])

/** 这个用户名能不能当隐私判据：空串与 CI 通用账号都不能（见 {@link GENERIC_CI_USERNAMES}）。 */
export function isUsableIdentityUsername(name: string | null | undefined): boolean {
  const value = (name ?? '').trim()
  return value.length > 0 && !GENERIC_CI_USERNAMES.has(value.toLowerCase())
}

/**
 * Windows 盘符绝对路径：`C:\…` 与 `C:/…` 两种分隔符都认（`file:///D:/secret` 也算 —— 盘符前的 `/`
 * 不是标识符字符，不会被下面的边界挡住）。
 *
 * 为什么不是裸的 `[A-Za-z]:[\\/]`：编译产物 lib/*.js 里有 `/^\s*gitdir:\s*(.+?)\s*$/`、
 * `/^ref:\s*(.+)$/` 这类正则字面量，裸模式会把 `r:\`、`f:\` 认成盘符（假阳性，而且那是生成物，
 * 从源码里也改不掉）。所以要求盘符**不紧跟在标识符字符后面**：`gitdir:` 被挡掉，`C:\Users\x`、`C:/work/x` 照旧命中。
 */
const WINDOWS_DRIVE_PATH = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/u

/**
 * POSIX 家目录：`/Users/<name>` 与 `/home/<name>`，**不要求尾斜杠**（`see /home/bob` 这种写法同样命中）。
 * 名字段只认 `[A-Za-z0-9._-]`，所以文档里的占位写法（`/Users/<name>`、`/home/<name>`）不算命中 ——
 * 它没有泄漏任何真实名字；真实用户名（含 `.` `_` `-`）都会命中。
 *
 * 左边的 `(?<![A-Za-z0-9._-])` 挡掉「前面还连着路径/主机名」的情况：`docs/home/x`、`host/home/index.html`
 * 属于相对路径或 URL 路径段，不是某台机器的家目录。`file:///home/bob` 之类仍然命中（`/` 不是标识符字符）。
 */
const POSIX_HOME_PATH = /(?<![A-Za-z0-9._-])\/(?:Users|home)\/[A-Za-z0-9._-]+(?![A-Za-z0-9._-])/u

/**
 * UNC 网络路径：`\\host\share…`。
 * 主机名与共享名都至少两位，且前面不能是反斜杠或标识符字符 —— 这样转义序列 `\\w\\s`、`\\s\\s`
 * （正则字面量里常见）不会因为「反斜杠 + 单字母」被误认成主机名与共享名。
 */
const UNC_PATH = /(?<![\\A-Za-z0-9_])\\\\[A-Za-z0-9][A-Za-z0-9._-]{1,}\\[A-Za-z0-9$][A-Za-z0-9$._-]{0,}/u

/**
 * 家目录简写：`~/…`，要求 `~/` 后面真的跟着一个路径字符（`~/` 单独出现不算），
 * 且左边不是标识符字符（挡掉 `docs~/x` 之类噪声）。
 */
const HOME_SHORTHAND_PATH = /(?<![A-Za-z0-9._-])~\/[A-Za-z0-9._$-]/u

/** `%USERPROFILE%`（大小写不敏感，在 lower 上判）。它指向真实家目录，进包等于泄漏。 */
const USERPROFILE_ENV = '%userprofile%'

// ── 凭证形状 ────────────────────────────────────────────────────────────────
// 刻意只认「前缀 + 足够长度的随机串」：文档里单独出现 `sk-`、`AKIA`、`ghp_`、`xoxb-` 不该报，
// 普通长单词（`risk-management-strategy-documentation`）也不该报 —— 所以每个判据都带左右边界，
// 并给了最小长度。宁可窄一点漏一点，也不要让开发文档频繁误报、最后把这条检查关掉。
//
// 反例（刻意**不**命中）写在 tests/tools.test.ts 里，与判据一一对应。

/** `sk-` + ≥20 位随机串（OpenAI / Anthropic 等；左边不能是标识符字符，挡掉 `risk-management-…`）。 */
const SECRET_API_KEY = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/u

/** `AKIA` + ≥16 位大写字母数字（AWS Access Key ID 是 AKIA + 16 位）。 */
const SECRET_AWS_ACCESS_KEY = /(?<![A-Za-z0-9])AKIA[A-Z0-9]{16,}(?![A-Za-z0-9])/u

/** `ghp_` + ≥20 位字母数字（GitHub personal access token 是 ghp_ + 36 位）。 */
const SECRET_GITHUB_TOKEN = /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/u

/** `xox[baprs]-` + ≥10 位字母数字/连字符（Slack 令牌）。 */
const SECRET_SLACK_TOKEN = /(?<![A-Za-z0-9-])xox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/u

/** PEM 私钥头：`-----BEGIN PRIVATE KEY-----`、`-----BEGIN RSA PRIVATE KEY-----`、OpenSSH / EC / PGP 等。 */
const SECRET_PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY[A-Z ]*-----/u

/** JWT：`eyJ…`（base64 的 `{"`）开头的三段式，每段都要求足够长。 */
const SECRET_JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/u

/** 一条命中。 */
export interface PrivacyHit {
  /** 相对仓库根的 POSIX 路径。 */
  file: string
  /** 1 基行号。 */
  line: number
  /** 命中类型。 */
  kind: PrivacyKind
}

/** 被跳过的文件与原因。 */
export interface PrivacySkip {
  file: string
  reason: string
}

/** 隐私扫描输入。 */
export interface PrivacyScanOptions {
  /** 仓库根。 */
  repo: string
  /** 要扫的文件（相对仓库根的 POSIX 路径，来自 npm pack 清单）。 */
  files: readonly string[]
  /** 本机用户名；缺省取 `os.userInfo().username`（测试可注入）。显式 null 表示取不到。 */
  username?: string | null
  /** 真实 `$DSH_HOME`；缺省取 `process.env.DSH_HOME`。显式 null 表示环境里没有。 */
  dshHome?: string | null
  /** 单文件字节上限；缺省 `PRIVACY_MAX_FILE_BYTES`。 */
  maxBytes?: number
}

/** 一条在本次环境下**不可靠、实际没有扫**的判据（CI 局限：跳过 ≠ 通过）。 */
export interface UnavailableCriterion {
  /** 判据标识（复用命中类型，便于 CI 里筛选）。 */
  kind: PrivacyKind
  /** 一句人话：为什么这次扫不了，以及「跳过 ≠ 通过」。 */
  reason: string
}

/** 隐私扫描结论。 */
export interface PrivacyScanResult {
  /** 命中明细（每个文件最多 `PRIVACY_MAX_HITS_PER_FILE` 条）。 */
  hits: PrivacyHit[]
  /** 命中总处数（可能大于 `hits.length`）。 */
  hitsTotal: number
  /** 真的逐行扫过的文件数。 */
  scanned: number
  /** 跳过的文件（二进制 / 超大 / 读不到 / 越界）。 */
  skipped: PrivacySkip[]
  /** 没能覆盖到的扫描项（取不到用户名 / 通用账号 / 没设 `$DSH_HOME`），也含在 `unavailable` 里。 */
  notes: string[]
  /** 本次环境下不可靠、实际没有扫的判据（调用方必须显式说「跳过 ≠ 通过」，不许当「干净」）。 */
  unavailable: UnavailableCriterion[]
}

/** 本机用户名：取不到就返回空串，报告里明说这一项没扫，不假装扫过。 */
function localUsername(): string {
  try {
    return userInfo().username ?? ''
  } catch {
    return ''
  }
}

/** 一条隐私判据：命中类型 + 单行判定。 */
interface PrivacyMatcher {
  kind: PrivacyKind
  /** line 是原文，lower 是同一行的小写副本（省得每个判据各转一次）。 */
  match: (line: string, lower: string) => boolean
}

/**
 * 逐行扫一批文件，找出发布物里的隐私。
 *
 * 只读「文本」：含 NUL 字节的按二进制跳过，非法 UTF-8 也跳过，超过 `maxBytes` 的直接跳过 ——
 * 这三种都算「没扫」，调用方必须把 skipped 显式说出来（跳过 ≠ 通过）。
 */
export function scanReleasePrivacy(options: PrivacyScanOptions): PrivacyScanResult {
  const hits: PrivacyHit[] = []
  const skipped: PrivacySkip[] = []
  const notes: string[] = []
  const unavailable: UnavailableCriterion[] = []
  let hitsTotal = 0
  let scanned = 0

  const maxBytes = options.maxBytes ?? PRIVACY_MAX_FILE_BYTES
  const rawUsername = (options.username === undefined ? localUsername() : options.username) ?? ''
  const username = rawUsername.trim()
  // 空串 / CI 通用账号（runner、root）都不能当判据：前者取不到身份，后者不是任何人的身份。
  const usernameUsable = isUsableIdentityUsername(username)
  const dshHome = (options.dshHome === undefined ? (process.env.DSH_HOME ?? '') : options.dshHome) ?? ''
  if (!usernameUsable) {
    const reason =
      username.length === 0
        ? '取不到本机用户名（os.userInfo() 不可用），「本机用户名」这一项**没有扫**（跳过 ≠ 通过，不是通过）。'
        : `本机用户名是 CI / 容器通用账号（${[...GENERIC_CI_USERNAMES].join('、')} 之类），它不是任何人的身份信息：` +
          '「本机用户名」这一项在本次环境下不可靠，**没有扫**（跳过 ≠ 通过，不是通过）。'
    notes.push(reason)
    unavailable.push({ kind: 'username', reason })
  }
  if (dshHome.length === 0) {
    const reason = '环境里没有 $DSH_HOME，这一项**没有扫**（跳过 ≠ 通过，不是通过）。'
    notes.push(reason)
    unavailable.push({ kind: 'dsh-home', reason })
  }

  const usernameLower = usernameUsable ? username.toLowerCase() : ''
  // 同一份 $DSH_HOME，文本里可能写成反斜杠或正斜杠，两种写法都算命中。
  const dshNeedles =
    dshHome.length === 0 ? [] : [...new Set([dshHome, dshHome.replace(/\\/gu, '/')])].map((value) => value.toLowerCase())

  const matchers: PrivacyMatcher[] = []
  if (usernameLower.length > 0) {
    matchers.push({ kind: 'username', match: (_line, lower) => lower.includes(usernameLower) })
  }
  matchers.push({ kind: 'windows-drive-path', match: (line) => WINDOWS_DRIVE_PATH.test(line) })
  matchers.push({ kind: 'posix-home-path', match: (line) => POSIX_HOME_PATH.test(line) })
  matchers.push({ kind: 'unc-path', match: (line) => UNC_PATH.test(line) })
  matchers.push({ kind: 'home-shorthand', match: (line) => HOME_SHORTHAND_PATH.test(line) })
  matchers.push({ kind: 'userprofile-env', match: (_line, lower) => lower.includes(USERPROFILE_ENV) })
  if (dshNeedles.length > 0) {
    matchers.push({ kind: 'dsh-home', match: (_line, lower) => dshNeedles.some((needle) => lower.includes(needle)) })
  }
  // 凭证形状：只报「前缀 + 足够长度」，文档里的普通词与单独出现的前缀都不报。
  matchers.push({ kind: 'secret-api-key', match: (line) => SECRET_API_KEY.test(line) })
  matchers.push({ kind: 'secret-aws-access-key', match: (line) => SECRET_AWS_ACCESS_KEY.test(line) })
  matchers.push({ kind: 'secret-github-token', match: (line) => SECRET_GITHUB_TOKEN.test(line) })
  matchers.push({ kind: 'secret-slack-token', match: (line) => SECRET_SLACK_TOKEN.test(line) })
  matchers.push({ kind: 'secret-private-key', match: (line) => SECRET_PRIVATE_KEY_HEADER.test(line) })
  matchers.push({ kind: 'secret-jwt', match: (line) => SECRET_JWT.test(line) })

  const repoRoot = resolvePath(options.repo)
  const rootPrefix = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`

  for (const file of options.files) {
    const absolute = resolvePath(repoRoot, file)
    if (absolute !== repoRoot && !absolute.startsWith(rootPrefix)) {
      skipped.push({ file, reason: '清单里的路径越出了仓库根，未读' })
      continue
    }

    let size: number
    try {
      const info = statSync(absolute)
      if (!info.isFile()) {
        skipped.push({ file, reason: '不是普通文件' })
        continue
      }
      size = info.size
    } catch {
      skipped.push({ file, reason: '读不到（statSync 失败）' })
      continue
    }
    if (size > maxBytes) {
      skipped.push({ file, reason: `${size} 字节，超过单文件上限 ${maxBytes} 字节` })
      continue
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(absolute)
    } catch {
      skipped.push({ file, reason: '读不到（readFileSync 失败）' })
      continue
    }
    if (buffer.includes(0)) {
      skipped.push({ file, reason: '二进制文件（含 NUL 字节）' })
      continue
    }

    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      skipped.push({ file, reason: '不是合法 UTF-8 文本' })
      continue
    }

    scanned += 1
    const lines = text.split(/\r?\n/u)
    let reported = 0
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const lower = line.toLowerCase()
      // 行粒度：同一行同一种类型只报一处（行号足够定位，重复出现不再刷屏）。
      for (const matcher of matchers) {
        if (!matcher.match(line, lower)) continue
        hitsTotal += 1
        if (reported < PRIVACY_MAX_HITS_PER_FILE) {
          hits.push({ file, line: index + 1, kind: matcher.kind })
          reported += 1
        }
      }
    }
  }

  return { hits, hitsTotal, scanned, skipped, notes, unavailable }
}

/**
 * 检查 4：npm pack 会发布的每个文件里不能出现隐私（用户名 / 绝对路径 / 真实 $DSH_HOME / 凭证）。
 *
 * `identity` 只是给测试用的注入点（用户名 / `$DSH_HOME`）；生产调用不传，走环境探测。
 */
export function checkPrivacy(
  options: VerifyOptions,
  packCheck: CheckResult,
  files: readonly string[] | null,
  identity: { username?: string | null; dshHome?: string | null } = {},
): CheckResult {
  const id = 'privacy'
  const title = '发布物里不能出现本机用户名、绝对路径、真实 $DSH_HOME 或凭证'

  if (files === null) {
    // pack 拿不到清单：这一条必须显式「跳过」并说明原因，绝不记成通过。
    // 原因直接引用检查 3 自己的措辞，两处口径不会各说各话。
    const why = (packCheck.details[0] ?? '原因见上一条 pack 检查').replace(/。$/u, '')
    return {
      id,
      title,
      status: 'skip',
      details: [
        `没有拿到 npm pack 清单，本次没有扫描发布物隐私：${why}。`,
        '这属于「没验证」，不是「通过」：拿不到清单时这一条只显示跳过，绝不记成通过。',
      ],
    }
  }

  const result = scanReleasePrivacy({ repo: options.repo, files, ...identity })
  const details = [
    `扫描范围：npm pack 实际会发布的 ${files.length} 个文件；逐行扫过 ${result.scanned} 个，跳过 ${result.skipped.length} 个。`,
  ]
  for (const item of result.skipped.slice(0, 8)) details.push(`  · 跳过 ${item.file}（${item.reason}）`)
  if (result.skipped.length > 8) details.push(`  · …另有 ${result.skipped.length - 8} 个被跳过`)
  if (result.skipped.length > 0) {
    details.push('跳过 ≠ 通过：被跳过的文件**没有**被扫过（二进制 / 超大文件不因为读不动就算失败）。')
  }
  for (const note of result.notes) details.push(note)

  if (result.hits.length > 0) {
    details.push(`命中 ${result.hitsTotal} 处（只报文件、行号与命中类型，不回显命中内容）：`)
    for (const hit of result.hits) details.push(`  · ${hit.file}:${hit.line} 命中「${PRIVACY_KIND_LABELS[hit.kind]}」`)
    if (result.hitsTotal > result.hits.length) details.push(`  …另有 ${result.hitsTotal - result.hits.length} 处未逐条列出`)
    details.push('本机用户名 / 绝对路径 / 真实 $DSH_HOME / 凭证进包就等于一起发布出去：请改成占位写法（如 <home>、<name>）或把该文件移出 `files`；')
    details.push('若命中凭证（sk- / AKIA / ghp_ / xox[baprs]- / PRIVATE KEY / JWT），发布出去的那把密钥必须**撤销并轮换**，只删文件不够。')
    return { id, title, status: 'fail', details }
  }

  // 判据本身不可靠（CI 里 username=runner、$DSH_HOME 通常缺失）⇒ 不许静默给「干净」：
  // 显式列出「没有扫」的判据，整条检查降为 skip（与检查 3 的 npm 不可用同一种口径）。
  if (result.unavailable.length > 0) {
    const labels = result.unavailable.map((item) => PRIVACY_KIND_LABELS[item.kind]).join('、')
    details.push(`本次环境不可靠、实际**没有扫**的判据：${labels}（原因见上）。`)
    details.push('跳过 ≠ 通过：这一条**没有完整验证通过** —— 命中 0 处只说明扫过的那些判据没命中，不说明发布物干净。')
    details.push('这些判据要在具备条件的环境（开发者本机、或设了 $DSH_HOME 的机器）里再跑一次才算验证过；CI 的 runner、root 账号不构成身份信息。')
    return { id, title, status: 'skip', details }
  }

  const clean = `干净：已扫过的 ${result.scanned} 个文件里没有本机用户名、绝对路径、真实 $DSH_HOME 或凭证。`
  details.push(result.skipped.length > 0 ? `${clean}（但跳过 ≠ 通过，见上。）` : clean)
  return { id, title, status: 'pass', details }
}

/** 跑完整套检查。 */
export function verifySelfContained(options: VerifyOptions): VerifyResult {
  const manifestPath = join(options.repo, 'package.json')
  let manifest: PackageManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      failures: 1,
      skipped: 0,
      checks: [
        {
          id: 'manifest',
          title: '能读到 package.json',
          status: 'fail',
          details: [`读不出 ${manifestPath}：${message}`],
        },
      ],
    }
  }

  // 同一次 npm pack 的清单：检查 3 负责拿，检查 4（隐私扫描）复用。
  const listing: PackListing = { files: null }
  const packCheck = checkPack(options, listing)
  const checks = [
    checkDependencies(manifest),
    checkImports(options.repo, manifest),
    packCheck,
    checkPrivacy(options, packCheck, listing.files),
  ]
  const failures = checks.filter((check) => check.status === 'fail').length
  const skipped = checks.filter((check) => check.status === 'skip').length
  return { ok: failures === 0, failures, skipped, checks }
}

/** 解析命令行参数（不引入任何依赖）。 */
function parseArgs(argv: string[]): VerifyOptions {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const options: VerifyOptions = {
    repo: repoRoot,
    pack: true,
    npmCache: process.env.VERIFY_NPM_CACHE ?? join(tmpdir(), 'dsh-npm-cache'),
    npmTimeoutMs: Number(process.env.VERIFY_NPM_TIMEOUT ?? '120000'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') continue
    else if (arg === '--no-pack') options.pack = false
    else if (arg === '--pack') options.pack = true
    else if (arg === '--repo') options.repo = resolvePath(argv[++index] ?? '')
    else if (arg === '--npm-cache') options.npmCache = resolvePath(argv[++index] ?? '')
    else if (arg === '--timeout') options.npmTimeoutMs = Number(argv[++index] ?? '120000')
  }
  if (!Number.isFinite(options.npmTimeoutMs) || options.npmTimeoutMs <= 0) options.npmTimeoutMs = 120_000
  return options
}

/** 只有被 `node tools/verify-self-contained.ts` 直接运行时才执行 CLI；被 import 时只导出上面的函数。 */
function isDirectRun(): boolean {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  const self = fileURLToPath(import.meta.url)
  const invoked = resolvePath(argv1)
  return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self
}

if (isDirectRun()) {
  const environment = process.env
  const options = parseArgs(process.argv.slice(2))
  const wantJson = process.argv.slice(2).includes('--json')
  const result = verifySelfContained(options)

  if (wantJson) {
    console.log(JSON.stringify({ ok: result.ok, failures: result.failures, skipped: result.skipped, repo: options.repo, checks: result.checks, env: { node: process.version, os: environment.OS ?? process.platform } }, null, 2))
  } else {
    console.log(`自足性自检：${options.repo}`)
    for (const check of result.checks) {
      const badge = check.status === 'pass' ? '✅' : check.status === 'fail' ? '❌' : '⚠️'
      console.log(`${badge} ${check.title}`)
      for (const detail of check.details) console.log(`   ${detail}`)
    }
    if (result.ok) {
      console.log(
        result.skipped > 0
          ? `通过：${result.checks.length - result.skipped} 项通过，${result.skipped} 项**跳过**（跳过原因见上，未验证 ≠ 通过）。`
          : '通过：依赖为空、无运行期第三方导入、打包清单齐全、发布物隐私干净。',
      )
    } else {
      console.log(`失败：${result.failures} 项不满足，${result.skipped} 项跳过。`)
    }
  }

  if (!result.ok) process.exitCode = 1
}

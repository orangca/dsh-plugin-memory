// 从 app.asar 里提取客户端包（asar = [4B][4B][4B jsonLen][json][files...]）
//
// 用法：node tools/extract-asar.ts [app.asar 路径]
//   asar 路径也可用环境变量 DSH_ASAR 指定；都不给时按 Windows 默认安装位置推断。
//
// 健壮性说明（相对最初的 .cjs 版是有意修复）：头部里有个别条目没有 offset/size
// （实测会在 readSync 处抛 `ERR_OUT_OF_RANGE ... Received NaN`，旧版固定崩在第 356 个文件）。
// 现在会把这类条目跳过并计数，单个文件读取失败也不会中断整轮提取。
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** app.asar 头部 JSON 的一个节点：目录有 files，文件节点有 offset/size（畸形头可能缺字段）。 */
interface AsarNode {
  files?: Record<string, AsarNode>
  offset?: string
  size?: number
}

/** 头部里收集到的一个文件条目（offset 已确认为有限数）。 */
interface AsarFile {
  path: string
  size: number
  offset: number
}

const defaultAsar = join(
  process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '', 'AppData', 'Local'),
  'Programs', 'DeepSeek Harness', 'resources', 'app.asar',
)
const asar = process.env.DSH_ASAR ?? process.argv[2] ?? defaultAsar
if (!existsSync(asar)) {
  console.error(`找不到 app.asar：${asar}\n请用第一个参数或环境变量 DSH_ASAR 指定其路径。`)
  process.exit(1)
}
const outDir = join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'dsh-gui')
mkdirSync(outDir, { recursive: true })

const fd = openSync(asar, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
// 常见布局：offset 12 = json 字节数，offset 16 = json 起点
let jsonLen = head.readUInt32LE(12)
let headerBuf = Buffer.alloc(jsonLen)
readSync(fd, headerBuf, 0, jsonLen, 16)
let header: AsarNode
try {
  header = JSON.parse(headerBuf.toString('utf8')) as AsarNode
} catch (error) {
  console.log('offset16/12 解析失败，尝试 8/4：', error instanceof Error ? error.message : String(error))
  jsonLen = head.readUInt32LE(4)
  headerBuf = Buffer.alloc(jsonLen)
  readSync(fd, headerBuf, 0, jsonLen, 8)
  header = JSON.parse(headerBuf.toString('utf8')) as AsarNode
}
const dataStart = 16 + jsonLen
console.log('header 解析成功，条目数：', Object.keys(header.files ?? {}).length)

// 收集所有文件路径（跳过缺 offset/size 的畸形条目）
const files: AsarFile[] = []
let malformed = 0
function walk(node: AsarNode, prefix: string): void {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) {
      walk(entry, p)
      continue
    }
    const offset = Number(entry.offset)
    const size = Number(entry.size)
    if (!Number.isFinite(offset) || !Number.isFinite(size) || size < 0) {
      malformed += 1
      continue
    }
    files.push({ path: p, size, offset })
  }
}
walk(header, '')
if (malformed > 0) console.log(`跳过 ${malformed} 个缺 offset/size 的畸形条目`)

const wanted = files.filter((f) => /ui-settings-plugins|ui-settings\/|client-modules/.test(f.path) && /\.(js|mjs|cjs)$/.test(f.path))
console.log('候选文件：', wanted.length)
// 全部客户端产物（找谁注册了 plugins.detail.section / 自动表单）
const broad = files.filter((f) => /\/lib\/(client|index)\.js$/.test(f.path))
console.log('全部客户端 client.js：', broad.length, '总大小(MB)：', (broad.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1))
const extract = broad
let written = 0
let failed = 0
for (const f of extract) {
  try {
    const buf = Buffer.alloc(f.size)
    readSync(fd, buf, 0, f.size, dataStart + f.offset)
    writeFileSync(join(outDir, f.path.replace(/[\\/]/g, '__')), buf)
    written += 1
  } catch (error) {
    failed += 1
    if (failed <= 3) {
      console.warn(`  读取失败：${f.path}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
}
console.log(`已提取 ${written} 个文件到 ${outDir}${failed > 0 ? `（${failed} 个读取失败）` : ''}`)
closeSync(fd)

// 从 app.asar 里提取客户端包（asar = [4B][4B][4B jsonLen][json][files...]）
//
// 用法：node tools/extract-asar.cjs [app.asar 路径]
//   asar 路径也可用环境变量 DSH_ASAR 指定；都不给时按 Windows 默认安装位置推断。
const fs = require('node:fs')
const path = require('node:path')

const defaultAsar = path.join(
  process.env.LOCALAPPDATA ?? path.join(process.env.HOME ?? '', 'AppData', 'Local'),
  'Programs', 'DeepSeek Harness', 'resources', 'app.asar',
)
const asar = process.env.DSH_ASAR ?? process.argv[2] ?? defaultAsar
if (!fs.existsSync(asar)) {
  console.error(`找不到 app.asar：${asar}\n请用第一个参数或环境变量 DSH_ASAR 指定其路径。`)
  process.exit(1)
}
const outDir = path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'dsh-gui')
fs.mkdirSync(outDir, { recursive: true })

const fd = fs.openSync(asar, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
// 常见布局：offset 12 = json 字节数，offset 16 = json 起点
let jsonLen = head.readUInt32LE(12)
let headerBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, headerBuf, 0, jsonLen, 16)
let header
try {
  header = JSON.parse(headerBuf.toString('utf8'))
} catch (error) {
  console.log('offset16/12 解析失败，尝试 8/4：', error.message)
  jsonLen = head.readUInt32LE(4)
  headerBuf = Buffer.alloc(jsonLen)
  fs.readSync(fd, headerBuf, 0, jsonLen, 8)
  header = JSON.parse(headerBuf.toString('utf8'))
}
const dataStart = 16 + jsonLen
console.log('header 解析成功，条目数：', Object.keys(header.files ?? {}).length)

// 收集所有文件路径
const files = []
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p)
    else files.push({ path: p, size: entry.size, offset: entry.offset })
  }
}
walk(header, '')

const wanted = files.filter((f) => /ui-settings-plugins|ui-settings\/|client-modules/.test(f.path) && /\.(js|mjs|cjs)$/.test(f.path))
console.log('候选文件：', wanted.length)
// 全部客户端产物（找谁注册了 plugins.detail.section / 自动表单）
const broad = files.filter((f) => /\/lib\/(client|index)\.js$/.test(f.path))
console.log('全部客户端 client.js：', broad.length, '总大小(MB)：', (broad.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1))
const extract = broad
for (const f of extract) {
  const buf = Buffer.alloc(f.size)
  fs.readSync(fd, buf, 0, f.size, dataStart + Number(f.offset))
  const target = path.join(outDir, f.path.replace(/[\\/]/g, '__'))
  fs.writeFileSync(target, buf)
}
console.log('已提取到', outDir)
fs.closeSync(fd)

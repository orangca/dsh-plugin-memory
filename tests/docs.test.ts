// 文档订正的**回归测试**：把「审计确认的真问题」一条条钉在文档上，避免它们悄悄回退。
//
// 每项都是「先复现 → 再订正 → 证明不再复现」三步里的第三步：
//   复现（改文档之前，这些正则**匹配得到**旧错说法 / 匹配不到正确说法）
//     · SECURITY.md「Data location」行只写「无网络调用、无遥测、无嵌入服务」而没提宿主注入的嵌入器；
//     · 协议 §3.3 的 `mode` 表写成 `'query' | 'memory'`，与 §11 的 `'lexical' | 'semantic' | 'hybrid'` 冲突；
//     · 协议没写 `recall()` 什么时候同步 / 什么时候返回 Promise；
//     · §3.2 把 `version` 写成「每次成功 put/delete 自增」（实现里 put 失败也自增）；
//     · §4.3 写「/memory approve、/memory confirm 都能让 pending 变 active」（confirm 不碰 status）；
//     · §11 写「四处服务面新增」而漏了 `lastRecall()`；
//     · `refs: string[]` 的字符串语法（`sessionId#from-to`、`;` 分隔）从未写明；
//     · refs.md 把「结果新在前」写成 `normalizeRefs` 的保证（实现保持入参顺序）；
//       refs.md 的 `formatRefs` 示例是短化形态（实现默认不短化）；
//     · embedder.md 用「不改返回类型」描述 `recall()`（实现缺省同步、要嵌入时才 Promise）；
//     · 缺「宿主半边怎么接起来」（ctx 接缝 / storageDomain 句柄形状 / 卸载清理）。
//   订正：只改这两份协议文档 + SECURITY.md + docs/refs.md + docs/embedder.md + 两份 README（逐节对齐）。
//
// 这些用例**只读文档**，不碰 src/、不碰 lib/、不发任何服务调用；因此它们与实现改动互不干扰。
// 与 tests/protocol.test.ts#11「两份协议逐节对齐」互补：那条钉 `## ` 数量，这条钉内容。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

const EN = read('docs/protocol-v1.md')
const ZH = read('docs/protocol-v1.zh.md')
const SECURITY = read('SECURITY.md')
const REFS = read('docs/refs.md')
const EMBEDDER = read('docs/embedder.md')
const README_EN = read('README.md')
const README_ZH = read('README.zh.md')

/** `## ` 小节标题（恰好两个 # 加空白；`###` 不算），与 tests/protocol.test.ts#11 同一口径。 */
const sectionsOf = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('## '))

// ---------------------------------------------------------------- 1. SECURITY.md 的「数据去哪」不再是空承诺

test('docs#1 SECURITY.md：Data location 行如实写「宿主注入远端 embedder ⇒ 记忆正文离开本机」', () => {
  const row = SECURITY.split('\n').find((line) => line.includes('| Data location |'))
  assert.ok(row, 'SECURITY.md 必须有 Data location 行')
  const text = String(row)
  // 旧错说法：只保证「无网络调用 / 无遥测 / 无嵌入服务」，对宿主注入的嵌入器只字不提。
  assert.doesNotMatch(
    text,
    /No network calls, no telemetry, no embedding service\./u,
    'Data location 行不得只写「无网络调用、无遥测、无嵌入服务」——宿主注入嵌入器后记忆正文会外发',
  )
  // 正确说法要同时给出「插件自身不联网」与「嵌入器会把正文交出去」两面。
  assert.match(text, /no network request of its own|never calls a network/iu, '要点明插件自身不发起网络请求')
  assert.match(text, /embedder\.embed|memory text/iu, '要点明交给嵌入函数的是记忆正文本身')
  assert.match(text, /host/iu, '要点明这是宿主注入的嵌入器 / 宿主与用户的决定')
  assert.match(text, /leave the machine|off the machine|remote/iu, '要点明远端嵌入器会让正文离开本机')
})

test('docs#1 SECURITY.md：已知限制里单列「注入的嵌入器决定正文去哪」', () => {
  assert.match(SECURITY, /\*\*An injected embedder decides where memory text goes\.\*\*/u)
  assert.match(SECURITY, /capabilities\(\)/u, '要提醒 capabilities() 只能说明「注册了某个东西」，不能证明它是本地的')
})

// ---------------------------------------------------------------- 2. §3.3 的 mode 表与 §11 合并

test('docs#2 协议 §3.3：mode 表合并两套词汇表（词面口径 + 打分口径）、并写明非法值行为', () => {
  for (const [name, doc] of [['en', EN], ['zh', ZH]] as const) {
    // 旧错说法：类型列只写 'query' | 'memory'，与 §11 的三个通道值冲突。
    assert.doesNotMatch(
      doc,
      /\|\s*`mode`[^|]*\|\s*`'query' \| 'memory'`\s*\|/u,
      `${name}: mode 的类型列不得只写 'query' | 'memory'（与 §11 冲突）`,
    )
    // 冻结签名里的联合类型也必须写全五个值（否则又是「表里两套、签名只有一套」）。
    assert.match(
      doc,
      /mode\?: 'query' \| 'memory' \| 'lexical' \| 'semantic' \| 'hybrid'/u,
      `${name}: RecallOptions 的 mode 联合类型必须写全五个值`,
    )
    for (const value of ["'query'", "'memory'", "'lexical'", "'semantic'", "'hybrid'"]) {
      assert.ok(doc.includes(value), `${name}: mode 表必须点名 ${value}`)
    }
    // 两套值的各自语义要在同一张（组）表里出现。
    assert.match(doc, /lexical posture|词面口径/u, `${name}: 要说明 'query'/'memory' 是词面口径`)
    assert.match(doc, /ranking channel|检索通道/u, `${name}: 要说明 'lexical'/'semantic'/'hybrid' 是打分口径`)
    // 非法值：按缺省处理、当词面、不抛、绝不被当成 semantic。
    assert.match(doc, /invalid `?mode`?|非法的 `mode`/u, `${name}: 要写清非法 mode 值的行为`)
    assert.match(doc, /never falls back to `'semantic'`|绝不.{0,6}被当成 `'semantic'`/u, `${name}: 非法值不得被猜成语义`)
  }
})

// ---------------------------------------------------------------- 3. recall() 的返回类型

test('docs#3 协议 §3.3：recall() 的返回类型与实现一致（不走嵌入 ⇒ 数组；要调 embed ⇒ Promise）', () => {
  for (const [name, doc] of [['en', EN], ['zh', ZH]] as const) {
    assert.match(doc, /`RecallHit\[\] \| Promise<RecallHit\[\]>`/u, `${name}: 要写出联合返回类型`)
    assert.match(
      doc,
      /default \/ `'lexical'`[\s\S]{0,400}(plain array|普通数组)|缺省 \/ `'lexical'`[\s\S]{0,400}(普通数组|plain array)/u,
      `${name}: 要写明缺省/lexical 是同步数组`,
    )
    // 审计后实现改成「没注册 embedder 的语义模式同步回落」，文档必须跟实现一致（而不是写理想状态）。
    assert.match(
      doc,
      /no embedder registered ⇒ a plain array|没注册嵌入器 ⇒ 也是普通数组/u,
      `${name}: 要写明「未注册嵌入器时 semantic/hybrid 同步返回数组」——这正是实现的行为`,
    )
    assert.match(
      doc,
      /with an embedder registered ⇒ a `Promise`|且已注册嵌入器 ⇒ `Promise`/u,
      `${name}: 要写明「注册后 semantic/hybrid 才返回 Promise」`,
    )
    assert.doesNotMatch(
      doc,
      /always a `Promise`|总是 `Promise`/u,
      `${name}: 不得再写「semantic 总是 Promise」——未注册时实现是同步回落`,
    )
  }
  // 与实现一致性的旁证（**读的是当前实现**，不是理想状态）：
  //   · 词面/缺省、以及未注册 embedder 的语义模式，都同步 `return lexicalHits(…)` 一个数组；
  //   · 真正会调 embed 时才转交 async 的 `recallWithEmbedding`（⇒ Promise）。
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(index, /const recallWithEmbedding = async/u, '语义路径必须是 async（实现旁证：要嵌入时才 Promise）')
  assert.match(
    index,
    /if \(mode === 'lexical'\) return lexicalHits\('lexical', null\)/u,
    'lexical 分支必须同步 return 数组（实现旁证）',
  )
  assert.match(
    index,
    /if \(embedderState\.current === null\) return lexicalHits\(mode, 'no-embedder'\)/u,
    '未注册 embedder 的语义分支必须同步 return 数组（实现旁证）',
  )
  assert.match(
    index,
    /return recallWithEmbedding\(options, mode\)/u,
    '已注册时转交 async 实现（实现旁证：它返回 Promise 而不是数组）',
  )
})

// ---------------------------------------------------------------- 4. §3.2 的 version 语义

test('docs#4 协议 §3.2：version 照实现写「put 失败也自增；delete 失败回滚」', () => {
  assert.doesNotMatch(
    EN,
    /incremented on every successful put\/delete/u,
    'en: 不得再写「每次成功 put/delete 自增」——put 失败也自增',
  )
  assert.doesNotMatch(
    ZH,
    /每次成功的 put\/delete 都 \+1/u,
    'zh: 不得再写「每次成功的 put/delete 都 +1」',
  )
  for (const [name, doc] of [['en', EN], ['zh', ZH]] as const) {
    // 断言 §3.2 的 version 行本身（表格行可能折成多行，所以取从该行到下一个表格行为止）。
    const lines = doc.split('\n')
    const start = lines.findIndex((line) => /^\|\s*`version`\s*\|/u.test(line))
    assert.ok(start >= 0, `${name}: §3.2 必须有 version 行`)
    let end = start + 1
    while (end < lines.length && !/^\|\s*`opened`\s*\|/u.test(lines[end] ?? '')) end += 1
    const row = lines.slice(start, end).join(' ')
    assert.match(row, /throws|抛错/u, `${name}: 要写明 put 抛错也自增`)
    assert.match(row, /roll|回滚/u, `${name}: 要写明 delete 失败会回滚、version 不动`)
  }
  // 实现旁证：persist() 先 +1 再 await put；remove() 失败时回滚内存。
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(index, /state\.collectionVersion \+= 1[\s\S]{0,300}?await domain!\.table<MemoryRecord>\('memories'\)\.put/u)
})

// ---------------------------------------------------------------- 5. §4.3 的 pending 出口

test('docs#5 协议 §4.3：pending → active 的唯一出口是 /memory approve（不是 confirm）', () => {
  for (const [name, doc] of [['en', EN], ['zh', ZH]] as const) {
    assert.doesNotMatch(
      doc,
      /`\/memory approve`, `\/memory confirm`|`\/memory approve`、`\/memory confirm`/u,
      `${name}: 不得再把 approve 与 confirm 并列成 pending 出口`,
    )
    assert.match(
      doc,
      /`\/memory approve` is the only|能让它变 `active` 的只有 `\/memory approve`/u,
      `${name}: 要点名唯一出口是 approve`,
    )
    assert.match(doc, /confirm[\s\S]{0,160}(never touches `?status`?|从不碰 `status`)/u, `${name}: 要说明 confirm 不碰 status`)
  }
})

// ---------------------------------------------------------------- 6. §11 的「五处服务面新增」

test('docs#6 协议 §11：服务面新增是五处，且 lastRecall() 单独列出', () => {
  const rows = (doc: string): string[] => doc.split('\n').filter((line) => /^\|\s*[1-9]\s*\|/u.test(line))
  for (const [name, doc] of [['en', EN], ['zh', ZH]] as const) {
    assert.doesNotMatch(doc, /four surface additions|四处服务面新增/u, `${name}: 不得再写「四处服务面新增」`)
  }
  const enRows = rows(EN.split('## 11.')[1] ?? '')
  const zhRows = rows(ZH.split('## 11.')[1] ?? '')
  assert.equal(enRows.length, 5, `en §11 必须是 5 行：实际 ${enRows.length}`)
  assert.equal(zhRows.length, 5, `zh §11 必须是 5 行：实际 ${zhRows.length}`)
  assert.ok(enRows.some((row) => row.includes('`lastRecall()`')), 'en §11 必须单独列出 lastRecall()')
  assert.ok(zhRows.some((row) => row.includes('`lastRecall()`')), 'zh §11 必须单独列出 lastRecall()')
})

// ---------------------------------------------------------------- 7. refs 的字符串语法

test('docs#7 协议 §4.2：写明 refs 的字符串语法（sessionId#from-to、单点 #from、; 分隔）', () => {
  for (const [name, doc] of [['en', EN], ['zh', ZH]] as const) {
    const section = doc.split('### 4.2')[1]?.split('### 4.3')[0] ?? ''
    assert.ok(section.length > 0, `${name}: 必须能切出 §4.2`)
    assert.match(section, /`;`|（`;`）/u, `${name}: 要写明多条用 ; 分隔`)
    assert.match(section, /#from-to|#120-180/u, `${name}: 要给出区间形态的例子`)
    assert.match(section, /single point|单点/u, `${name}: 要写明单点引用只有 #from`)
    assert.match(section, /refsMax/u, `${name}: 要写明上限`)
  }
})

// ---------------------------------------------------------------- 8. docs/refs.md

test('docs#8 refs.md：normalizeRefs 保持入参顺序（「新在前」是调用方责任）', () => {
  assert.doesNotMatch(
    REFS,
    /规范化（去重 \+ 裁剪 \+ 字段校验）：非法项丢弃，结果新在前/u,
    '不得再写「结果新在前」——实现保持入参顺序',
  )
  assert.match(REFS, /保持入参顺序/u, '要写明保持入参顺序')
  assert.match(REFS, /「新引用在前」是\*\*调用方[^*]*\*\*/u, '要写明「新在前」是调用方责任')
  // 实现旁证：normalizeRefs 不排序。
  const lib = readFileSync(new URL('../src/lib.ts', import.meta.url), 'utf8')
  const body = lib.split('export function normalizeRefs')[1]?.split('export function withRef')[0] ?? ''
  assert.doesNotMatch(body, /\.sort\(/u, 'normalizeRefs 实现里不得排序（文档写的才是真的）')
})

test('docs#8 refs.md：formatRefs 默认不短化（示例形态改过来）', () => {
  assert.doesNotMatch(
    REFS,
    /export function formatRefs[^)]*\): string\n[\s\S]{0,0}?？/u,
    '占位（防止误读）',
  )
  // 旧错说法：`/** 展示：`ses-84a547da#120-180`；无引用返回空串。 */`
  assert.doesNotMatch(
    REFS,
    /\/\*\* 展示：`ses-[^`]*`；无引用返回空串。 \*\//u,
    '不得再把短化形态写成 formatRefs 的缺省输出',
  )
  assert.match(REFS, /\*\*`formatRefs` 默认不短化\*\*/u, '要有「默认不短化」一节')
  assert.match(REFS, /`\{ short: true \}` 才是/u, '示例形态要区分 short: true')
  // 实现旁证：short 只在 options.short === true 时生效。
  const lib = readFileSync(new URL('../src/lib.ts', import.meta.url), 'utf8')
  assert.match(lib, /const short = options\?\.short === true/u)
})

// ---------------------------------------------------------------- 9. 协议里补「宿主半边怎么接起来」

test('docs#9 协议：补上 apply(ctx, config) 用法、ctx 接缝、storageDomain 句柄形状与卸载清理', () => {
  for (const [name, doc] of [['en', EN], ['zh', ZH]] as const) {
    assert.match(doc, /### 2\.1 /u, `${name}: 要有 §2.1 宿主接线一节`)
    assert.match(doc, /### 2\.2 /u, `${name}: 要有 §2.2 storageDomain 句柄一节`)
    assert.match(doc, /### 2\.3 /u, `${name}: 要有 §2.3 卸载/清理一节`)
    for (const seam of ['ctx.effect', 'ctx.inject', 'ctx.on', 'ctx.systemPrompt', 'ctx.tools.register', 'ctx.commands.register', 'provide']) {
      assert.ok(doc.includes(seam), `${name}: 接缝清单要含 ${seam}`)
    }
    for (const shape of ["global.get", "global.set", "entries()", '.put(', '.delete(']) {
      assert.ok(doc.includes(shape), `${name}: storageDomain 句柄必需形状要含 ${shape}`)
    }
    assert.match(
      doc,
      /no `dispose\(\)` on the `memory` service object|没有.{0,4}`dispose\(\)`|服务面.{0,6}没有.{0,4}`dispose\(\)`/u,
      `${name}: 要如实写「服务面没有 dispose()」`,
    )
  }
  // 接缝清单要与实现的 inject 逐字对得上（不是抄意图）。
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const inject = /export const inject = \[([^\]]+)\]/u.exec(index)?.[1] ?? ''
  for (const service of inject.split(',').map((part) => part.trim().replace(/^'|'$/gu, '')).filter(Boolean)) {
    assert.ok(EN.includes(service) && ZH.includes(service), `接缝清单必须覆盖实现的 inject 项：${service}`)
  }
})

// ---------------------------------------------------------------- 10. docs/embedder.md

test('docs#10 embedder.md：recall() 的返回类型与实现一致（未注册时 semantic 也是同步数组）', () => {
  assert.doesNotMatch(
    EMBEDDER,
    /\*\*不改返回类型\*\*/u,
    '不得再用「不改返回类型」描述 recall()——缺省同步、要嵌入时是 Promise',
  )
  assert.match(EMBEDDER, /RecallHit\[\] \| Promise<RecallHit\[\]>/u, '要写出联合返回类型')
  assert.match(EMBEDDER, /且未注册 embedder\*\* ⇒ \*\*也是同步数组\*\*/u, '要写明未注册时是同步数组')
  assert.match(EMBEDDER, /且已注册 embedder\*\* ⇒ \*\*`Promise`\*\*/u, '要写明注册后才返回 Promise')
  assert.match(
    EMBEDDER,
    /别写成「未注册时 semantic 返回 Promise」/u,
    '要明确否掉与实现不符的描述（未注册时其实是同步数组）',
  )
})

// ---------------------------------------------------------------- 11. README 两份的隐私声明与 mode 用法

test('docs#11 两份 README：隐私声明把「注入远端嵌入器 ⇒ 正文外发」写清楚，且中英对齐', () => {
  // 旧错说法：injectProject…README 的隐私行只写「Nothing leaves the machine」。
  assert.doesNotMatch(
    README_EN,
    /\n- Nothing leaves the machine\. There is no telemetry/u,
    'README.md 不得再写「Nothing leaves the machine」而不提注入嵌入器的后果',
  )
  assert.doesNotMatch(
    README_ZH,
    /- 数据不出本机：无遥测/u,
    'README.zh.md 不得再写「数据不出本机」而不提注入嵌入器的后果',
  )
  assert.match(README_EN, /memory text.{0,40}(leave|off) the machine|sends memory text off the machine/isu)
  assert.match(README_ZH, /记忆正文.{0,20}(离开本机|送出本机)/u)
  // 两份 README 的 `## ` 小节数量仍要相等（与 tools/check-readmes.ts 同一判据）。
  const count = (text: string): number => text.split('\n').filter((line) => line.startsWith('## ')).length
  assert.equal(count(README_EN), count(README_ZH), '两份 README 的 ## 小节数必须相等')
})

test('docs#11 两份 README：mode 用法与协议一致（semantic/hybrid 未注册嵌入器时回落词面）', () => {
  for (const [name, doc] of [['en', README_EN], ['zh', README_ZH]] as const) {
    assert.doesNotMatch(
      doc,
      /off by default\*\*; see|默认关闭\*\* —— 见/u,
      `${name}: 不得只写「默认关闭」而不写「没注册时回落词面」`,
    )
    assert.match(doc, /mode: 'semantic' \| 'hybrid'|'semantic' \| 'hybrid'\)/u, `${name}: 要写出显式模式与回落`)
    assert.ok(doc.includes('lastRecall()'), `${name}: 回落要靠 lastRecall() 说出来`)
  }
})

// ---------------------------------------------------------------- 12. 两份协议逐节对齐（内容版）

test('docs#12 两份协议逐节对齐：## 与 ### 小节数都相等', () => {
  const h2 = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('## '))
  const h3 = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('### '))
  assert.equal(h2(ZH).length, h2(EN).length, `## 数量必须相等：en=${h2(EN).length} zh=${h2(ZH).length}`)
  assert.equal(h3(ZH).length, h3(EN).length, `### 数量必须相等：en=${h3(EN).length} zh=${h3(ZH).length}`)
  assert.ok(EN.includes("ctx.get('memory')") && ZH.includes("ctx.get('memory')"))
  // 协议文档是公开的，不得混进任何人的机器路径（与 tests/protocol.test.ts#11 同一纪律）。
  assert.doesNotMatch(EN + ZH, /\b[A-Za-z]:\\/u, '协议文档不得出现本机绝对路径')
  // 小节数也不能被人无形改掉：这里把当前的真实数字钉住（en=zh=11）。
  assert.equal(sectionsOf(EN).length, 11)
  assert.equal(sectionsOf(ZH).length, 11)
})

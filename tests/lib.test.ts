// dsh-memory 纯函数层单测（node --test）
// 覆盖设计稿 §11.1 的 store/retrieve/inject/redact 四类：
// 被测代码取自**编译产物** `lib/lib.js`（由 src/lib.ts 编译而来），不是 src/lib.ts 本身。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { MakeRecordInput, MemoryConfig } from '../lib/lib.js'

import {
  DEFAULTS,
  clampText,
  compareRecords,
  composeGistText,
  composeSubjectSummary,
  deriveOriginFromMessages,
  detectWorkspaceMarkers,
  effectiveImportance,
  estimateTokens,
  extractCandidates,
  extractSummaryText,
  findConflicts,
  fnv1a,
  isEcho,
  isSelfPortraitEligible,
  lexicalMatch,
  listActive,
  makeRecord,
  maskPii,
  memoryMatch,
  normalizeText,
  pickMergeGroups,
  recallRecords,
  recordHash,
  renderContextBlock,
  renderSelfBlock,
  scanSensitive,
  shouldArchive,
  tokenize,
  workspaceKeyOf,
} from '../lib/lib.js'

const cfg: MemoryConfig = { ...DEFAULTS }

test('normalizeText：全角转半角、折叠空白、英文小写、去尾部标点', () => {
  assert.equal(normalizeText('  用户   偏好中文。 '), '用户 偏好中文')
  assert.equal(normalizeText('Hello, World!'), 'hello, world')
  assert.equal(normalizeText('ＡＢＣ'), 'abc')
})

test('fnv1a：稳定且对输入敏感', () => {
  assert.equal(fnv1a('abc'), fnv1a('abc'))
  assert.notEqual(fnv1a('abc'), fnv1a('abd'))
})

test('recordHash：同 kind/scope/subject 且文本归一化相同 → 同指纹（去重基础）', () => {
  const base: MakeRecordInput = { kind: 'user_profile', scope: { level: 'profile', key: '*' }, subject: 'lang', text: '偏好中文。' }
  const a = makeRecord(base)
  const b = makeRecord({ ...base, text: '  偏好中文 ' })
  assert.equal(a.hash, b.hash)
  const c = makeRecord({ ...base, subject: 'other' })
  assert.notEqual(a.hash, c.hash)
})

test('makeRecord：按 kind 推断默认作用域', () => {
  assert.equal(makeRecord({ kind: 'project_gist', text: 'x' }).scope.level, 'workspace')
  assert.equal(makeRecord({ kind: 'agent_self', text: 'x' }).scope.level, 'profile')
  assert.equal(makeRecord({ kind: 'semantic', text: 'x' }).scope.level, 'workspace')
  assert.equal(makeRecord({ kind: 'procedural', text: 'x' }).scope.level, 'workspace')
})

test('renderContextBlock：session 级记录永不常驻注入；非当前 workspace 的也不注入', () => {
  const currentKey = workspaceKeyOf('C:/proj/a')!
  const records = [
    makeRecord({ kind: 'semantic', text: '临时结论', scope: { level: 'session', key: '*' } }),
    makeRecord({ kind: 'semantic', text: '别的项目知识', scope: { level: 'workspace', key: workspaceKeyOf('C:/proj/b')! } }),
    makeRecord({ kind: 'semantic', text: '本项目知识', scope: { level: 'workspace', key: currentKey } }),
  ]
  const block = renderContextBlock(records, cfg, currentKey)
  assert.match(block.text, /本项目知识/)
  assert.doesNotMatch(block.text, /临时结论/)
  assert.doesNotMatch(block.text, /别的项目知识/)
})

test('compareRecords：pinned → importance → confidence → id 的确定性顺序', () => {
  const pinnedLow = makeRecord({ kind: 'user_profile', text: 'a', pinned: true, importance: 0.1 })
  const highImp = makeRecord({ kind: 'user_profile', text: 'b', importance: 0.9 })
  const lowImp = makeRecord({ kind: 'user_profile', text: 'c', importance: 0.2 })
  const sorted = [highImp, lowImp, pinnedLow].sort(compareRecords)
  assert.deepEqual(sorted.map((r) => r.text), ['a', 'b', 'c'])
  // 相同输入重复排序结果一致（I1 确定性）
  const again = [lowImp, pinnedLow, highImp].sort(compareRecords)
  assert.deepEqual(again.map((r) => r.text), ['a', 'b', 'c'])
})

test('clampText / estimateTokens：超长截断且成本随长度单调', () => {
  const long = 'x'.repeat(500)
  const clamped = clampText(long, 10, cfg.charsPerToken)
  assert.ok(clamped.length <= 10 * cfg.charsPerToken)
  assert.ok(clamped.endsWith('…'))
  assert.ok(estimateTokens('x'.repeat(100), 2.5) > estimateTokens('x'.repeat(10), 2.5))
})

test('renderSelfBlock：只收 agent_self，模型自评需跨会话复现才晋升', () => {
  const records = [
    makeRecord({ kind: 'agent_self', text: '回答先给结论。', origin: 'user_explicit', confidence: 0.9, pinned: true }),
    makeRecord({ kind: 'agent_self', text: '我倾向于先写测试。', origin: 'model_proposed', confidence: 0.9, reinforcement: { sessions: ['s1', 's2'], count: 1 } }),
    makeRecord({ kind: 'agent_self', text: '只在一个会话里出现过。', origin: 'model_proposed', confidence: 0.9, reinforcement: { sessions: ['s1'], count: 0 } }),
    makeRecord({ kind: 'user_profile', text: '偏好中文。', origin: 'user_explicit', confidence: 0.9 }),
  ]
  const block = renderSelfBlock(records, cfg)
  assert.match(block.text, /\[我的工作约定 · 来自用户确认\]/)
  assert.match(block.text, /回答先给结论/)
  // 模型自评必须**独立成块**（设计稿 §7.3），不能混进「用户确认」块
  assert.match(block.text, /\[自我观察 · 未经用户确认\]/)
  assert.match(block.text, /我倾向于先写测试/)
  const confirmedPart = block.text.split('[自我观察')[0]!
  assert.doesNotMatch(confirmedPart, /我倾向于先写测试/)
  // 只复现 1 次的不能进
  assert.doesNotMatch(block.text, /只在一个会话里出现过/)
  assert.doesNotMatch(block.text, /偏好中文/)

  const tiny = renderSelfBlock(records, { ...cfg, selfPortraitMaxTokens: 12 })
  assert.ok(tiny.text.length <= block.text.length)
  // 提高门槛后，自评被挡在 section 通道之外
  const strict = renderSelfBlock(records, { ...cfg, selfPortraitPromoteSessions: 3 })
  assert.doesNotMatch(strict.text, /我倾向于先写测试/)
  // 自评配额：最多 4 条进块
  const manyObserved = Array.from({ length: 7 }, (_, index) => makeRecord({
    kind: 'agent_self', text: `自我观察第 ${index} 条。`, origin: 'model_proposed', confidence: 0.9,
    reinforcement: { sessions: ['s1', 's2'], count: 1 },
  }))
  const capped = renderSelfBlock(manyObserved, cfg)
  assert.equal(capped.selected.length, cfg.selfPortraitMaxSelfObserved)
  assert.match(capped.text, /自我观察第 0 条/)
  assert.doesNotMatch(capped.text, /自我观察第 5 条/)
})

test('extractCandidates：信号表、排除规则、每回合配额', () => {
  const explicit = extractCandidates('记住：以后都用 pnpm 管理依赖。', cfg)
  assert.equal(explicit.candidates.length, 1)
  assert.equal(explicit.candidates[0]!.kind, 'user_profile')
  assert.equal(explicit.candidates[0]!.origin, 'user_explicit')
  assert.match(explicit.candidates[0]!.text, /pnpm/)
  assert.ok(!explicit.candidates[0]!.text.endsWith('。'), '入库文本应去掉句末标点')

  const selfDirective = extractCandidates('以后你要先给结论再解释。', cfg)
  assert.equal(selfDirective.candidates[0]!.kind, 'agent_self')
  assert.equal(selfDirective.candidates[0]!.origin, 'user_explicit')

  const selfFix = extractCandidates('你搞错了，这里应该用 workspace 作用域。', cfg)
  assert.equal(selfFix.candidates[0]!.kind, 'agent_self')
  assert.equal(selfFix.candidates[0]!.origin, 'user_correction')

  // 排除规则
  assert.equal(extractCandidates('这个文件是干什么的？', cfg).candidates.length, 0)
  assert.equal(extractCandidates('如果重启 DSH 会怎样呢？', cfg).candidates.length, 0)
  assert.equal(extractCandidates('记住', cfg).candidates.length, 0)
  assert.equal(extractCandidates('记住：sk-abcdefghijklmnopqrstuv', cfg).candidates.length, 0)

  // 无信号句被记为 no-signal
  const none = extractCandidates('今天天气不错，我们继续看代码。', cfg)
  assert.equal(none.candidates.length, 0)
  assert.ok((none.skipped['no-signal'] ?? 0) >= 1)

  // 每回合配额
  const many = extractCandidates([
    '记住：第一条偏好是 A。',
    '记住：第二条偏好是 B。',
    '记住：第三条偏好是 C。',
    '记住：第四条偏好是 D。',
  ].join('\n'), cfg)
  assert.equal(many.candidates.length, cfg.captureMaxPerTurn)
  assert.equal(many.skipped['over-turn-quota'], 1)
})

test('isEcho：复述刚注入的内容会被识别（防自激闸门 2）', () => {
  const injected = ['- (profile) 用户偏好中文回答，代码注释与标识符用英文。']
  assert.equal(isEcho('用户偏好中文回答，代码注释与标识符用英文。', injected), true)
  assert.equal(isEcho('回答先给结论，再给理由。', injected), false)
  assert.equal(isEcho('任何内容', []), false)
})

test('detectWorkspaceMarkers / composeGistText：零成本项目印象', () => {
  const markers = detectWorkspaceMarkers('项目用 pnpm，跑 Electron + TypeScript，脚本是 PowerShell。')
  assert.ok(markers.includes('pnpm'))
  assert.ok(markers.includes('electron'))
  assert.ok(markers.includes('typescript'))
  assert.ok(markers.length >= cfg.gistMinMarkers)
  assert.match(composeGistText(markers), /这个工作区看起来涉及/)
  assert.equal(composeGistText([]), '')
})

// ---------------- M3：整合治理 ----------------

const DAY = 86_400_000

test('effectiveImportance：pinned/不衰减类型保持，project_gist 衰减快于 user_profile', () => {
  const now = Date.now()
  const old = now - 180 * DAY
  const pinned = makeRecord({ kind: 'user_profile', text: 'x', importance: 0.8, pinned: true, observedAt: old })
  assert.equal(effectiveImportance(pinned, now), 0.8)

  const selfOld = makeRecord({ kind: 'agent_self', text: 'x', importance: 0.8, observedAt: old })
  assert.equal(effectiveImportance(selfOld, now), 0.8)

  const profile = makeRecord({ kind: 'user_profile', text: 'x', importance: 0.8, observedAt: old })
  const gist = makeRecord({ kind: 'project_gist', text: 'x', importance: 0.8, observedAt: old })
  assert.ok(effectiveImportance(gist, now) < effectiveImportance(profile, now))
  assert.ok(effectiveImportance(profile, now) < 0.8)
})

test('shouldArchive：低有效重要度 + 长期未用才归档；pinned/自画像/项目印象永不自动归档', () => {
  const now = Date.now()
  const veryOld = now - 400 * DAY
  const old = now - 200 * DAY
  assert.equal(shouldArchive(makeRecord({ kind: 'semantic', text: 'x', importance: 0.1, observedAt: veryOld }), cfg, now), true)
  // 200 天时高重要度尚未衰减到阈值以下
  assert.equal(shouldArchive(makeRecord({ kind: 'semantic', text: 'x', importance: 0.9, observedAt: old }), cfg, now), false)
  // 但衰减是设计行为：足够久之后连高重要度也会归档
  assert.equal(shouldArchive(makeRecord({ kind: 'semantic', text: 'x', importance: 0.9, observedAt: veryOld }), cfg, now), true)
  assert.equal(shouldArchive(makeRecord({ kind: 'semantic', text: 'x', importance: 0.1, observedAt: veryOld, pinned: true }), cfg, now), false)
  assert.equal(shouldArchive(makeRecord({ kind: 'agent_self', text: 'x', importance: 0.1, observedAt: veryOld }), cfg, now), false)
  assert.equal(shouldArchive(makeRecord({ kind: 'project_gist', text: 'x', importance: 0.1, observedAt: veryOld }), cfg, now), false)
  // 时间不够久也不归档
  assert.equal(shouldArchive(makeRecord({ kind: 'semantic', text: 'x', importance: 0.1, observedAt: now - 10 * DAY }), cfg, now), false)
})

test('pickMergeGroups：同 subject 且文本近似才合并；摘要条目不参与', () => {
  const base: Omit<MakeRecordInput, 'text'> = { kind: 'semantic', subject: 'project.build', scope: { level: 'workspace', key: 'k' } }
  const a = makeRecord({ ...base, text: '构建用 pnpm build 跑。' })
  const b = makeRecord({ ...base, text: '构建用 pnpm build 执行。' })
  const c = makeRecord({ ...base, text: '完全不同的另一件事，讲的是部署流程。' })
  const summary = makeRecord({ ...base, text: '构建用 pnpm build 跑。', tags: ['summary'] })
  const groups = pickMergeGroups([a, b, c, summary], cfg)
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.length, 2)
  assert.ok(!groups.flat().some((record) => (record.tags ?? []).includes('summary')))
})

test('findConflicts：同 (subject, field) 不同 value 判为冲突；模型自评不能推翻用户侧条目', () => {
  const scope = { level: 'profile', key: '*' }
  const user = makeRecord({ kind: 'user_profile', subject: 'editor.theme', field: 'theme', value: 'dark', text: '偏好深色主题。', origin: 'user_explicit', observedAt: 1000 })
  const model = makeRecord({ kind: 'user_profile', subject: 'editor.theme', field: 'theme', value: 'light', text: '似乎是浅色主题。', origin: 'model_proposed', observedAt: 2000 })
  const conflicts = findConflicts([user, model])
  assert.equal(conflicts.length, 1)
  // winner 是更新的 model_proposed，但用户侧条目更强 → blocked
  assert.equal(conflicts[0]!.blocked, true)

  const newer = makeRecord({ kind: 'user_profile', subject: 'editor.theme', field: 'theme', value: 'light', text: '改成浅色主题。', origin: 'user_correction', observedAt: 3000 })
  const conflicts2 = findConflicts([user, newer])
  assert.equal(conflicts2.length, 1)
  assert.equal(conflicts2[0]!.blocked, false)
  assert.equal(conflicts2[0]!.winner.id, newer.id)
})

test('composeSubjectSummary：单一 subject 条目过多时产出摘要', () => {
  const records = Array.from({ length: 7 }, (_, index) => makeRecord({
    kind: 'semantic', subject: 'project.release', text: `第 ${index} 条关于发布的记录。`,
  }))
  const summaries = composeSubjectSummary(records, { ...cfg, summarizeAbove: 5 })
  assert.equal(summaries.length, 1)
  assert.match(summaries[0]!.text, /关于 project.release 的既有记录（7 条）/)
  assert.equal(summaries[0]!.absorbed.length, 7)
  assert.equal(composeSubjectSummary(records.slice(0, 3), { ...cfg, summarizeAbove: 5 }).length, 0)
})

test('extractSummaryText：从 ContentBlock[] 取纯文本', () => {
  assert.equal(extractSummaryText([{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }]), '第一段\n第二段')
  assert.equal(extractSummaryText([]), '')
  assert.equal(extractSummaryText(undefined), '')
})

test('renderContextBlock：workspace 印象只取当前 workspace，且单独成块并声明模糊', () => {
  const currentKey = workspaceKeyOf('C:/proj/a')!
  const records = [
    makeRecord({ kind: 'user_profile', text: '偏好中文。', importance: 0.9 }),
    makeRecord({ kind: 'project_gist', text: '这是 A 项目。', scope: { level: 'workspace', key: currentKey } }),
    makeRecord({ kind: 'project_gist', text: '这是 B 项目。', scope: { level: 'workspace', key: workspaceKeyOf('C:/proj/b')! } }),
  ]
  const block = renderContextBlock(records, cfg, currentKey)
  assert.match(block.text, /长期记忆/)
  assert.match(block.text, /项目印象 · 模糊且可能过时/)
  assert.match(block.text, /这是 A 项目/)
  assert.doesNotMatch(block.text, /这是 B 项目/)
  assert.match(block.text, /以当前对话为准/)
})

test('renderContextBlock：空库不产生任何注入（冷启动不注入空块）', () => {
  assert.equal(renderContextBlock([], cfg, null).text, '')
  assert.equal(renderSelfBlock([], cfg).text, '')
})

test('renderContextBlock：常驻层排除 episodic 与整合摘要（设计稿 §4.4：episodic 常驻上限 0）', () => {
  const workspaceKey = workspaceKeyOf('C:/proj/a')!
  const records = [
    makeRecord({ kind: 'user_profile', text: '常驻画像。', importance: 0.9 }),
    makeRecord({ kind: 'episodic', text: '情景记忆不该常驻。', scope: { level: 'profile', key: '*' }, importance: 0.9 }),
    makeRecord({ kind: 'semantic', text: '整合摘要也不该常驻。', tags: ['summary'], scope: { level: 'workspace', key: workspaceKey }, importance: 0.9 }),
  ]
  const block = renderContextBlock(records, cfg, workspaceKey)
  assert.match(block.text, /常驻画像/)
  assert.doesNotMatch(block.text, /情景记忆不该常驻/)
  assert.doesNotMatch(block.text, /整合摘要也不该常驻/)
  assert.equal(block.selected.length, 1)
})

test('renderContextBlock：块头尾文案也计入硬预算', () => {
  const records = Array.from({ length: 12 }, (_, index) => makeRecord({
    kind: 'user_profile', text: `画像条目 ${index}：${'内容'.repeat(10)}。`, importance: 0.9 - index * 0.01,
  }))
  const block = renderContextBlock(records, { ...cfg, maxInjectedTokens: 60 }, null)
  const total = estimateTokens(block.text, cfg.charsPerToken)
  assert.ok(total <= 60, `实际 ${total} token 超过硬上限 60`)
})

test('scanSensitive：各类敏感形态正负例', () => {
  const hits = [
    'sk-abcdefghijklmnopqrstuv',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_abcdefghijklmnopqrstuvwx',
    'password: hunter2xyz',
    '-----BEGIN RSA PRIVATE KEY-----',
    '11010119900307123X',
    '4111 1111 1111 1111',
  ]
  for (const text of hits) assert.ok(scanSensitive(text), `应命中：${text}`)
  assert.equal(scanSensitive('用户偏好中文回答。'), null)
  assert.equal(scanSensitive('项目用 pnpm 管理，构建脚本在 scripts/。'), null)
})

test('maskPii：邮箱与手机号脱敏（设计稿 §8.3），硬秘密仍走拒写', () => {
  assert.equal(maskPii('联系 alice@example.com 即可'), '联系 a***@example.com 即可')
  assert.equal(maskPii('手机 13812345678'), '手机 138****5678')
  assert.equal(maskPii('没有个人信息'), '没有个人信息')
  // 18 位身份证不应被手机号规则误伤（它仍由 scanSensitive 拒写）
  assert.equal(scanSensitive('11010119900307123X'), 'cn-id')
  assert.equal(maskPii('11010119900307123X'), '11010119900307123X')
  // 复杂本地部分只留首字母，域名保留
  assert.equal(maskPii('a.b+tag@sub.example.org'), 'a***@sub.example.org')
})

test('deriveOriginFromMessages：只认真实用户消息，注入的 runtime-context 不算', () => {
  const injected = { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '记住这个' }] }
  const realExplicit = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '记住：以后都用 pnpm' }] }
  const realNeutral = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '这个文件是干什么的？' }] }
  const assistant = { role: 'assistant', content: [{ type: 'text', text: '记住：以后都用 pnpm' }] }

  assert.equal(deriveOriginFromMessages([]), 'model_proposed')
  assert.equal(deriveOriginFromMessages([injected]), 'model_proposed')
  assert.equal(deriveOriginFromMessages([assistant, realExplicit]), 'user_explicit')
  assert.equal(deriveOriginFromMessages([realExplicit, realNeutral]), 'model_proposed')
})

test('tokenize：CJK bigram、拉丁词干、路径拆分', () => {
  assert.deepEqual(tokenize('记忆数据'), ['记忆', '忆数', '数据'])
  assert.ok(tokenize('scripts/release.mjs').includes('release'))
  assert.ok(tokenize('running').includes('runn'))
  assert.deepEqual(tokenize('中'), ['中'])
})

test('lexicalMatch：覆盖率而非「前两字」误命中', () => {
  const semantic = makeRecord({ kind: 'semantic', text: '记忆数据落在 ~/.dsh/storages/ 下。' })
  const unrelated = makeRecord({ kind: 'procedural', text: '记忆插件的开发迭代流程是跑 deploy-dev.ts。' })
  assert.ok(lexicalMatch(semantic, '记忆数据落在') > 0.6)
  assert.ok(lexicalMatch(unrelated, '记忆数据落在') < 0.4, '只含「记忆」两字不应算作高覆盖')
  assert.equal(lexicalMatch(semantic, ''), 1)
})

test('memoryMatch：长查询用记忆侧覆盖率，短查询才是查询覆盖率', () => {
  const memory = makeRecord({ kind: 'user_profile', text: '用户偏好用 pnpm，不用 npm。' })
  // 长轮次消息：包含 "pnpm" 与 "npm"
  const longTurn = `我想给这个仓库加一个新包，${'前置说明。'.repeat(60)}构建时到底该用 pnpm 还是 npm？请给出建议。`
  const shortQuery = '发布流程'

  assert.ok(memoryMatch(memory, longTurn) > 0.4, '长查询应能命中记忆侧的 pnpm/npm')
  assert.ok(lexicalMatch(memory, longTurn) < 0.2, '查询覆盖率在长消息下必然被稀释（这正是要换指标的原因）')
  assert.equal(memoryMatch(memory, shortQuery), 0, '无关查询不应命中')

  const unrelated = makeRecord({ kind: 'procedural', text: '记忆插件的开发迭代流程。' })
  // 只含「记忆」二字不构成命中（长轮次里没出现），构造一句确实含 2 个信息 token 的查询
  assert.equal(memoryMatch(unrelated, longTurn), 0, '长轮次里没出现记忆相关词 → 不命中')
  assert.ok(memoryMatch(unrelated, '记忆开发') > 0, '两个信息 token 命中即视为相关')
  assert.equal(memoryMatch(unrelated, '记忆开发', { minHits: 3 }), 0, '提高 minHits 可挡掉少量巧合命中')
})

test('recallRecords：相关性排序、过滤、limit 与空查询回退', () => {
  const records = [
    makeRecord({ kind: 'user_profile', text: '用户偏好中文回答。', importance: 0.9, subject: 'language' }),
    makeRecord({ kind: 'procedural', text: '发布流程用 pnpm release。', importance: 0.5, tags: ['release'] }),
    makeRecord({ kind: 'project_gist', text: '这个仓库是 Electron 桌面应用。', importance: 0.4 }),
  ]
  const hits = recallRecords(records, { query: 'pnpm 发布', limit: 5 })
  assert.ok(hits.length >= 1)
  assert.match(hits[0]!.record.text, /pnpm/)

  assert.equal(recallRecords(records, { query: '', kind: 'procedural' }).length, 1)
  assert.equal(recallRecords(records, { query: '', tag: 'release' }).length, 1)
  assert.equal(recallRecords(records, { query: '', limit: 2 }).length, 2)
  // 不相关查询不应命中
  assert.equal(recallRecords(records, { query: '量子力学 黑洞' }).length, 0)
  // 破坏性阈值：低覆盖不入选
  assert.equal(recallRecords(records, { query: '发布流程', minLexical: 0.9 }).length, 1)
  assert.equal(recallRecords(records, { query: '用户偏好中文回答', minLexical: 0.9 }).length, 1)
})

test('listActive：过滤 archived/invalid', () => {
  const active = makeRecord({ kind: 'user_profile', text: 'a' })
  const archived = makeRecord({ kind: 'user_profile', text: 'b', status: 'archived' })
  const invalid = makeRecord({ kind: 'user_profile', text: 'c', status: 'invalid' })
  assert.deepEqual(listActive([active, archived, invalid]).map((r) => r.text), ['a'])
})

test('recallRecords：归档条目仍可被检索（设计稿 §4.4），invalid 永不返回', () => {
  const active = makeRecord({ kind: 'semantic', text: '构建用 pnpm。' })
  const archived = makeRecord({ kind: 'semantic', text: '归档的构建笔记：pnpm build。', status: 'archived' })
  const invalid = makeRecord({ kind: 'semantic', text: '被推翻的构建笔记：npm build。', status: 'invalid' })

  const byDefault = recallRecords([active, archived, invalid], { query: '构建' })
  assert.deepEqual(byDefault.map((hit) => hit.record.status), ['active'])

  const withArchived = recallRecords([active, archived, invalid], { query: '构建', includeArchived: true })
  assert.deepEqual(withArchived.map((hit) => hit.record.status).sort(), ['active', 'archived'])
  assert.ok(!withArchived.some((hit) => hit.record.status === 'invalid'), 'invalid 永不参与检索')
})

// ---------------- 用量追踪（lastUsedAt / useCount） ----------------

test('renderContextBlock / renderSelfBlock：返回被选中的记录（记用量的唯一真源）', () => {
  const workspaceKey = workspaceKeyOf('C:/proj/a')!
  const records = [
    makeRecord({ kind: 'user_profile', text: '偏好中文。', importance: 0.9 }),
    makeRecord({ kind: 'agent_self', text: '先给结论。', origin: 'user_explicit', confidence: 0.9, pinned: true }),
    makeRecord({ kind: 'project_gist', text: '这是 A 项目。', scope: { level: 'workspace', key: workspaceKey } }),
    makeRecord({ kind: 'semantic', text: '预算之外的条目。', scope: { level: 'workspace', key: workspaceKey }, importance: 0.1 }),
  ]
  const context = renderContextBlock(records, { ...cfg, maxInjectedTokens: 12 }, workspaceKey)
  assert.ok(context.selected.length > 0, '至少选中一条')
  assert.ok(context.selected.length <= context.lines.length)
  // selected 必须与真正渲染出来的行一一对应
  for (const record of context.selected) {
    assert.ok(context.lines.some((line) => line.includes(record.text.slice(0, 6))), `行里应有 ${record.text}`)
  }

  const self = renderSelfBlock(records, cfg)
  assert.equal(self.selected.length, 1)
  assert.equal(self.selected[0]!.kind, 'agent_self')
})

test('effectiveImportance：lastUsedAt 更近则衰减更少（用量真的参与排序与归档判定）', () => {
  const now = Date.now()
  const idle = makeRecord({ kind: 'semantic', text: 'x', importance: 0.8, observedAt: now - 365 * DAY })
  const used = makeRecord({ kind: 'semantic', text: 'y', importance: 0.8, observedAt: now - 365 * DAY, lastUsedAt: now - DAY })
  assert.ok(effectiveImportance(used, now) > effectiveImportance(idle, now) * 5, '刚用过的条目有效重要度应显著更高')
  // 长期未用会被判归档，而刚用过的不会
  assert.equal(shouldArchive(idle, cfg, now), true)
  assert.equal(shouldArchive(used, cfg, now), false)
})

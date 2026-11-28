// 纯逻辑冒烟测试：不启动 DSH，只在 Node 里跑客户端半边的解析函数。
// 用法：node test/smoke.mjs
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let captured = null
const React = { createElement: (...args) => ({ args }) }
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { captured = definition } } },
  console,
}
vm.runInNewContext(source, sandbox, { filename: 'client.js' })
assert.ok(captured, 'client.js 应该调用 window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-wordbook')
const moduleExports = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
const { parseWordInput, normalizeState, normalizeWords, REVIEW_INTERVALS, normalizeReview, rateReview, isDueToday, isMature, dueLabel, judgeLocal, drawReport } = moduleExports.__internals

const pairs = (text) => JSON.stringify(parseWordInput(text).map((w) => [w.term, w.meaning]))
assert.equal(pairs('apple 苹果'), JSON.stringify([['apple', '苹果']]))
assert.equal(pairs('look forward to 期待'), JSON.stringify([['look forward to', '期待']]))
assert.equal(pairs('apple - 苹果'), JSON.stringify([['apple', '苹果']]))
assert.equal(JSON.stringify(parseWordInput('1. abandon 放弃\n# 注释\n\nbanana').map((w) => w.term)), JSON.stringify(['abandon', 'banana']))
assert.equal(pairs('abandon：放弃'), JSON.stringify([['abandon', '放弃']]))

const words = normalizeWords([{ term: 'apple', meaning: '苹果' }, { term: 'APPLE', meaning: '重复' }, { term: '  ' }, 'banana'])
assert.equal(JSON.stringify(words.map((w) => w.term)), JSON.stringify(['apple', 'banana']))

const state = normalizeState({ words: [{ term: 'apple' }], chat: [{ role: 'user', content: 'hi' }, { role: 'tool', content: 'x' }, { role: 'assistant', content: '' }], updatedAt: 5 })
assert.equal(state.words.length, 1)
assert.equal(state.chat.length, 1)
assert.equal(state.updatedAt, 5)


const withHistory = normalizeState({ history: [
  { ts: 1, term: 'apple', correct: true, source: 'local' },
  { ts: 2, term: 'pear', correct: false, source: 'maimemo' },
  { ts: 'bad', term: '' },
] })
assert.equal(withHistory.history.length, 2)
assert.equal(withHistory.history[1].source, 'maimemo')

// 艾宾浩斯：新词 10 分钟后进入第一次复习；记住升一阶，忘了回到第一阶。
const now = Date.now()
const first = normalizeReview(null, now)
assert.equal(first.stage, 0)
assert.equal(first.dueAt, now + REVIEW_INTERVALS[0] * 60000)
assert.equal(isDueToday({ review: first }, now), true)
const second = rateReview(first, true, now)
assert.equal(second.stage, 1)
assert.equal(second.dueAt, now + REVIEW_INTERVALS[1] * 60000)
assert.equal(second.reviews, 1)
const third = rateReview(second, true, now)
assert.equal(third.stage, 2)
const forgot = rateReview(third, false, now)
assert.equal(forgot.stage, 0)
assert.equal(forgot.lapses, 1)
assert.equal(forgot.dueAt, now + REVIEW_INTERVALS[0] * 60000)
const far = { review: { stage: 7, dueAt: now + 8 * 24 * 60 * 60 * 1000 } }
assert.equal(isDueToday(far, now), false)
assert.match(dueLabel(far, now), /天后/)
assert.match(dueLabel({ review: first }, now), /分钟后/)
assert.ok(normalizeWords([{ term: 'legacy' }])[0].review, '旧词条应补出 review')

// 分阶段出题：前几阶只问词义，第 4 阶（约第 3~4 天）之后才整句翻译。
assert.equal(isMature({ review: { stage: 3 }, createdAt: now }, now), false)
assert.equal(isMature({ review: { stage: 4 }, createdAt: now }, now), true)
assert.equal(isMature({ review: { stage: 0 }, createdAt: now - 8 * 24 * 60 * 60 * 1000 }, now), true)
assert.equal(isMature({ review: { stage: 0 }, createdAt: now }, now), false)

console.log('wordbook smoke: OK')

// 结构化默写的本地判分：明显匹配直接过，拿不准交给 AI。
assert.equal(judgeLocal('挑战', { meaning: '挑战；质疑', accepted: [] }), true)
assert.equal(judgeLocal('挑 战', { meaning: '挑战', accepted: [] }), true)
assert.equal(judgeLocal('意思为挑战', { meaning: '挑战', accepted: [] }), true)
assert.equal(judgeLocal('文化遗产', { meaning: '遗产', accepted: ['文化遗产'] }), true)
assert.equal(judgeLocal('质疑', { meaning: '挑战', accepted: ['挑战', '难题'] }), null)
assert.equal(judgeLocal('让水变干净', { meaning: '净化', accepted: ['净化', '过滤'] }), null)
assert.equal(judgeLocal('不是挑战', { meaning: '挑战', accepted: [] }), null)

// 墨墨阶段判定：新词 / STICKING 一律词义模式；熟知或已学 4 次以上才整句。
const bridge = await import('../../dsh-maimemo/index.js')
const { modeOf } = bridge.__internals
assert.equal(modeOf({ is_new: true }, { study_count: 10, tags: ['WELL_FAMILIAR'] }), 'word')
assert.equal(modeOf({ is_new: false }, { study_count: 5, tags: ['STICKING'] }), 'word')
assert.equal(modeOf({ is_new: false }, { study_count: 5, tags: ['WELL_FAMILIAR'] }), 'sentence')
assert.equal(modeOf({ is_new: false }, { study_count: 4, tags: [] }), 'sentence')
assert.equal(modeOf({ is_new: false }, { study_count: 3, tags: [] }), 'word')
console.log('maimemo mode: OK')

// 报告卡片：用假 canvas 跑一遍绘制，至少保证不会因为缺方法炸掉。
const ctx = {
  fillStyle: '', font: '', textBaseline: '',
  fillRect() {}, beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, fillText() {},
  measureText: (text) => ({ width: String(text).length * 10 }),
}
const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,x' }
const png = drawReport(canvas, {
  date: '2026-11-28', todayCount: 12, accuracy: 83, streak: 4, goal: 20, due: 9,
  mmFinished: 10, mmTotal: 50,
  bars: Array.from({ length: 14 }, (_, i) => ({ label: '11/' + (i + 1), count: i % 4 })),
  weak: [{ term: 'heritage', count: 2 }],
})
assert.equal(png, 'data:image/png;base64,x')
assert.equal(canvas.width, 1080)
console.log('report card: OK')

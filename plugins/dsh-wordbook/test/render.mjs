// 用最小 React 替身跑一遍面板渲染：不启动浏览器，只抓「渲染期炸了 / 关键文案没了」。
// 用法：node test/render.mjs
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let captured = null

function createReact() {
  let hooks = []
  let index = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
    },
    useState(initial) {
      const at = index++
      if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial
      return [hooks[at], () => {}]
    },
    useEffect() {
      index += 1
    },
    useRef(initial) {
      const at = index++
      if (!(at in hooks)) hooks[at] = { current: initial }
      return hooks[at]
    },
    useCallback(fn) {
      index += 1
      return fn
    },
  }
  return { React, reset() { hooks = []; index = 0 } }
}

const mini = createReact()
const storage = new Map()
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { captured = definition } }, confirm: () => true },
  localStorage,
  console,
  setTimeout,
  clearTimeout,
  fetch: async () => ({ json: async () => ({ ok: true, state: null }), ok: true }),
}
vm.runInNewContext(source, sandbox, { filename: 'client.js' })
const exports = captured.factory((name) => {
  if (name === 'react') return mini.React
  throw new Error('unexpected require: ' + name)
})
const { WordbookPanel } = exports.__internals

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.props?.children)
}

function render(props = {}) {
  mini.reset()
  return textOf(mini.React.createElement(WordbookPanel, props))
}

// 1. 空词表
let output = render()
assert.ok(output.includes('背单词'), '面板标题')
assert.ok(output.includes('词卷'), '左侧词卷')
assert.ok(output.includes('添加单词'), '添加按钮')
assert.ok(output.includes('还没有单词'), '空词表提示')
assert.ok(output.includes('今日任务') && output.includes('今天没有到期复习'), '今日任务卡片')
assert.ok(output.includes('对话讲解') && output.includes('默写') && output.includes('阅读理解'), '右侧标签页')

// 2. 有词：释义默认遮住，点开才显示
storage.set('dsh-wordbook:state:v1', JSON.stringify({
  words: [
    { id: 'w1', term: 'ankle', meaning: '踝；踝关节', phonetic: '/ˈæŋkl/', pos: 'n.' },
    { id: 'w2', term: 'percentage', meaning: '百分比', phonetic: '/pəˈsentɪdʒ/', pos: 'n.' },
  ],
  chat: [],
  reading: null,
  updatedAt: 1,
}))
storage.set('dsh-wordbook:side:v1', '1')
output = render()
assert.ok(output.includes('ankle') && output.includes('percentage'), '词条渲染')
assert.ok(output.includes('英 /ˈæŋkl/'), '音标渲染')
assert.ok(output.includes('点击显示'), '释义默认遮住')
assert.ok(output.includes('今日任务') && output.includes('待复习 2 个'), '到期词计入今日任务')
assert.ok(!output.includes('踝；踝关节'), '释义不该默认直接露出')

// 3. 收起词卷后留一个竖排小把手
storage.set('dsh-wordbook:side:v1', '0')
output = render()
assert.ok(output.includes('词 卷'), '收起后的词卷把手')
assert.ok(output.includes('2 个单词'), '右侧空状态仍显示词表数量')


// 4. 墨墨词卷：今日进度、阶段、隐藏释义、只读提示
const maimemo = {
  status: 'ready',
  progress: { finished: 10, total: 20, studyTime: 300000 },
  counts: { total: 2, finished: 1, remaining: 1, newCount: 1, sticking: 1, sentenceMode: 1 },
  error: '',
  items: [
    { vocId: 'a', spelling: 'generate', isNew: false, isFinished: true, studyCount: 11, tags: [], sticking: false, wellFamiliar: false, mode: 'sentence', firstResponse: 'FAMILIAR' },
    { vocId: 'b', spelling: 'motto', isNew: false, isFinished: false, studyCount: 3, tags: ['STICKING'], sticking: true, wellFamiliar: false, mode: 'word', firstResponse: 'FORGET' },
  ],
}
storage.set('dsh-wordbook:side:v1', '1')
output = render({ __testMaimemo: maimemo })
assert.ok(output.includes('墨墨今日') && output.includes('已学 10 / 20'), '墨墨进度')
assert.ok(output.includes('学习 5 分钟') && output.includes('易忘 1 个'), '墨墨学习时长/易忘')
assert.ok(output.includes('generate') && output.includes('motto'), '墨墨词条')
assert.ok(output.includes('整句') && output.includes('词义'), '阶段标记')
assert.ok(output.includes('点击显示'), '墨墨释义默认遮住')


// 5. 结构化默写：设置页、答题页、结果页
const practiceIdle = { status: 'idle', source: 'local', count: 10, items: [], index: 0, input: '', results: [], feedback: null, busy: false, error: '', startedAt: 0 }
output = render({ __testPractice: practiceIdle })
assert.ok(output.includes('结构化默写') && output.includes('开始默写'), '默写设置页')
assert.ok(output.includes('墨墨今日') && output.includes('我的词表'), '词库切换')
assert.ok(output.includes('10'), '数量选择')

const practiceReady = {
  ...practiceIdle,
  status: 'ready',
  count: 1,
  startedAt: Date.now(),
  items: [{ term: 'challenge', sentence: 'The new job is a real challenge for her.', meaning: '挑战', accepted: ['挑战', '难题'], translation: '这份新工作对她来说是个真正的挑战。', source: 'local', localWordId: 'w1', phonetic: '/ˈtʃælɪndʒ/' }],
}
output = render({ __testPractice: practiceReady })
assert.ok(output.includes('第 1 / 1 题') && output.includes('challenge'), '默写答题页')
assert.ok(output.includes('The new job is a real') && output.includes('challenge') && output.includes('是什么意思'), '语境句和提问')

const practiceDone = {
  ...practiceIdle,
  status: 'done',
  startedAt: Date.now() - 30000,
  finishedAt: Date.now(),
  results: [{ term: 'challenge', meaning: '挑战', answer: '质疑', correct: false, feedback: '句中指挑战' }],
}
output = render({ __testPractice: practiceDone })
assert.ok(output.includes('这一轮做完了') && output.includes('正确率 0%'), '默写结果页')
assert.ok(output.includes('错词 1 个') && output.includes('你写的：质疑'), '错词清单')

// 6. 设置面板与学习报告
output = render({ __testSettingsOpen: true })
assert.ok(output.includes('设置') && output.includes('墨墨 API'), '设置面板')
assert.ok(output.includes('保存 token') && output.includes('每日目标'), '设置项')
output = render({ __testReportOpen: true })
assert.ok(output.includes('学习报告') && output.includes('正在生成'), '学习报告弹层')

console.log('wordbook render: OK')

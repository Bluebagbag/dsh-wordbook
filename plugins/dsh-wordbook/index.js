/**
 * dsh-wordbook — 宿主半边
 * ════════════════════════════════════════════════════════════════════════
 * 只做三件事：
 *   1. 把词表 / 聊天记录 / 阅读理解题的快照存到本机磁盘
 *      （$DSH_HOME/wordbook/state.json），浏览器 localStorage 之外多一层保险；
 *   2. 提供两个同源接口，用 DSH 当前配置的模型做「聊天式讲解」和「出阅读理解题」；
 *   3. 接口套一层信任栅栏（同源 + Host 头 + 请求体上限），只接受本机页面来的请求。
 *
 * 不自己存 API Key，也不直连厂商：模型走 ctx.llm，所以用户换模型/换厂商时插件跟着走。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 宿主插件行的 id，必须与 cordis.patch.yml 一致。 */
export const name = 'wordbook'

/** 需要的外部服务：HTTP 路由 + 模型调用 + 默认模型选择。 */
export const inject = ['webServer', 'llm', 'agentDefaultModel']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'wordbook')
const STATE_FILE = path.join(STATE_DIR, 'state.json')

const MAX_BODY_BYTES = 256 * 1024
const MAX_WORDS = 500
const MAX_MESSAGE_CHARS = 4000
const MAX_HISTORY_FOR_MODEL = 16

/** 读取持久化快照；文件不存在或损坏时返回 null（客户端会退回 localStorage）。 */
function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 原子写：先写临时文件再 rename，避免半截 JSON。 */
function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8')
  fs.renameSync(tmp, STATE_FILE)
}

/** 把客户端传来的词表清洗成 `{ term, meaning }` 列表。 */
function normalizeWords(input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const item of input.slice(0, MAX_WORDS)) {
    const term = String(item && typeof item === 'object' ? item.term ?? item.word ?? '' : item ?? '').trim()
    const meaning = String(item && typeof item === 'object' ? item.meaning ?? '' : '').trim()
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const phonetic = String(item && typeof item === 'object' ? item.phonetic ?? '' : '').trim()
    const pos = String(item && typeof item === 'object' ? item.pos ?? '' : '').trim()
    out.push({ term: term.slice(0, 120), meaning: meaning.slice(0, 300), phonetic: phonetic.slice(0, 80), pos: pos.slice(0, 20) })
  }
  return out
}

/** 词表 → 提示词里的一行一个。 */
function wordsBlock(words) {
  if (words.length === 0) return '（词表还是空的）'
  return words.map((word) => `- ${word.term}${word.meaning ? '：' + word.meaning : ''}`).join('\n')
}

/** 取当前默认模型；配置缺省时退回 DeepSeek 官方 flash。 */
function selectionOf(ctx) {
  try {
    const selection = ctx.agentDefaultModel?.currentSelection?.()
    if (selection?.provider && selection?.model) return selection
  } catch {
    /* 取不到就用兜底 */
  }
  return { provider: 'deepseek-official', model: 'deepseek-flash' }
}

/**
 * 调一次模型并把文本增量拼起来。
 * @param {object} ctx 插件上下文
 * @param {{ system: string, user: string, temperature?: number, maxTokens?: number }} request
 * @returns {Promise<string>} 完整回答文本
 */
async function callModel(ctx, request) {
  const selection = selectionOf(ctx)
  let text = ''
  let failure = null
  const stream = ctx.llm.stream({
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    system: request.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
    temperature: request.temperature,
    maxTokens: request.maxTokens,
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      failure = chunk.reason.failure
    }
  }
  if (failure) throw new Error(`${failure.code || 'LLM_ERROR'}: ${failure.message || '模型调用失败'}`)
  if (!text.trim()) throw new Error('模型没有返回内容，请稍后再试')
  return text.trim()
}

const CHAT_SYSTEM = `你是一位擅长「主动回忆 + 间隔重复」的英语词汇教练，不是一本词典。学生正在背一组单词（词表在下面）。

带练方式：
1. 默认先让学生回忆，再揭晓。学生问「X 什么意思」时，先让他猜一下，或给一个含 X 的例句让他从上下文猜；他说「不知道 / 直接说」再讲。
2. 讲一个词按这个顺序，能省则省：核心义一句话 → 一个生活化例句和翻译 → 一个记忆钩子（词根、联想、近反义对比、易混词） → 一个 10 秒能做完的小检查（英译中默写或英文填空，不要给中文选项）。
3. 一次只推进 1~2 个词，不要一口气罗列好几个词的义项；等学生答完再继续。
4. 学生答错时，先说错在哪，再给正确说法，并马上让他用自己的话再说一遍；不要只回「对 / 错」。
5. 出题默认「生词模式」：给一个含目标词的英文句子，然后只问学生「句子里 X 是什么意思」，让他填这个词的中文；不要让他翻译整句，也不要给中文选项或中文提示。
6. 只有学生明确说这个词背熟了，或者任务里标了「整句翻译」，才用「熟词模式」：仍然只给英文句子，但让学生把整句翻成中文。没有标注就按生词模式。
7. 同一个词在不同句子里中文可能不同，按语境判断学生的答案贴不贴合；意思对就给过，再补更准确的说法。不管哪种模式都别一次报出答案。
8. 学生说「开始复习 / 测我」时，从词表里抽词出题，一次一题，答完再出下一题；把答错的词隔几题再考一次。
9. 语气像坐在旁边的朋友，可以轻松一点、偶尔幽默，但不要灌水、不要每次都用同一种开场白。
10. 中文为主；例句英文配中文翻译。普通回答尽量 200 字以内，复杂问题最多 350 字。
11. 优先用学生词表里的词造句；不确定的词义别编。学生发英文句子就批改，给更自然的版本，并点出一个可以升级的表达。`

const LOOKUP_SYSTEM = `你是一位严谨的英汉词典编辑，服务对象是中国英语学习者。只输出严格的 JSON，不输出 Markdown 代码块或任何解释。`

const READING_SYSTEM = `你是一位英语阅读命题老师。你写短文和题目，只输出严格的 JSON，不输出 Markdown 代码块或多余解释。`

/** 从模型输出里抠出 JSON（容忍 ```json 包裹和前后废话）。 */
function extractJson(text) {
  let body = String(text).trim()
  body = body.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const objAt = body.indexOf('{')
  const arrAt = body.indexOf('[')
  const arrayFirst = arrAt >= 0 && (objAt < 0 || arrAt < objAt)
  const first = arrayFirst ? arrAt : objAt
  const last = arrayFirst ? body.lastIndexOf(']') : body.lastIndexOf('}')
  if (first >= 0 && last > first) body = body.slice(first, last + 1)
  return JSON.parse(body)
}

/** 规整词典返回：音标统一成 /.../，缺字段留空。 */
function normalizeLookup(payload, terms) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.entries) ? payload.entries : []
  const byTerm = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const term = String(row.term ?? '').trim()
    if (!term) continue
    let phonetic = String(row.phonetic ?? '').trim().replace(/^[/\[]+|[/\]]+$/g, '').trim()
    if (phonetic) phonetic = '/' + phonetic + '/'
    byTerm.set(term.toLowerCase(), {
      term,
      phonetic: phonetic.slice(0, 80),
      pos: String(row.pos ?? '').trim().slice(0, 20),
      meaning: String(row.meaning ?? '').trim().slice(0, 300),
    })
  }
  // 按输入顺序返回，模型漏掉的项补空条目，前端不会一直等。
  return terms.map((term) => byTerm.get(term.toLowerCase()) ?? { term, phonetic: '', pos: '', meaning: '' })
}

/** 把答案统一成 A/B/C/D。 */
function normalizeAnswer(answer, options) {
  const value = String(answer ?? '').trim()
  if (/^[A-Ha-h]$/.test(value)) return value.toUpperCase()
  const prefixed = value.match(/^([A-Ha-h])\s*[.、)．:：]/)
  if (prefixed) return prefixed[1].toUpperCase()
  const index = options.findIndex((option) => String(option).trim() === value)
  if (index >= 0) return String.fromCharCode(65 + index)
  return value
}

/** 校验并规整模型返回的阅读题。 */
function normalizeReading(payload, words) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('模型返回的题目格式不对，请重试')
  }
  const passage = String(payload.passage ?? '').trim()
  if (!passage) throw new Error('模型没有给出短文，请重试')
  const questions = (Array.isArray(payload.questions) ? payload.questions : [])
    .slice(0, 8)
    .map((item) => {
      const options = (Array.isArray(item?.options) ? item.options : []).map((option) => String(option).trim()).slice(0, 4)
      return {
        question: String(item?.question ?? '').trim(),
        options,
        answer: normalizeAnswer(item?.answer, options),
        explanation: String(item?.explanation ?? '').trim(),
      }
    })
    .filter((item) => item.question && item.options.length >= 2)
  if (questions.length === 0) throw new Error('模型没有给出可用的题目，请重试')
  return {
    title: String(payload.title ?? 'Reading Comprehension').trim(),
    passage,
    questions,
    words: words.map((word) => word.term),
    createdAt: Date.now(),
  }
}

/** 历史记录拼进提示词（只发用户与助手文本，不信任客户端结构）。 */
function historyBlock(history) {
  if (!Array.isArray(history)) return ''
  const lines = []
  for (const message of history.slice(-MAX_HISTORY_FOR_MODEL)) {
    const role = message?.role === 'assistant' ? '老师' : '学生'
    const content = String(message?.content ?? '').trim()
    if (!content) continue
    lines.push(`${role}：${content.slice(0, 2000)}`)
  }
  return lines.join('\n')
}

/**
 * 同源信任栅栏：Host 头必须是正常主机名（防 DNS rebinding），
 * Origin 若存在必须与 Host 一致，'null' 源直接拒绝。
 */
function trustCheck(req) {
  const host = String(req.headers?.host || '')
  if (!host) return false
  if (!/^[-a-zA-Z0-9.]+(:\d+)?$/.test(host)) return false
  const origin = req.headers?.origin
  if (origin === 'null') return false
  if (origin !== undefined && origin !== null) {
    try {
      const url = new URL(String(origin))
      if (url.host.toLowerCase() !== host.toLowerCase()) return false
    } catch {
      return false
    }
  }
  return true
}

/** 带双重上限地读 JSON 请求体。 */
async function readJsonBody(req) {
  const declared = Number(req.headers?.['content-length'] || 0)
  if (declared > MAX_BODY_BYTES) throw new Error('请求体过大')
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

/** 挂路由。webServer 在插件 apply 时可能还没就绪，所以用 inject 等它。 */
function mount(ctx, webServer) {
  const send = (res, code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: '/dsh-wordbook/api',
        handler: async (req, res) => {
          try {
            if (!trustCheck(req)) return send(res, 403, { ok: false, error: 'untrusted request' })
            const url = new URL(req.url || '/', 'http://localhost')
            const route = url.pathname.replace(/^\/dsh-wordbook\/api/, '') || '/'

            if (req.method === 'GET' && (route === '/state' || route === '/')) {
              return send(res, 200, { ok: true, state: readState() })
            }

            if (req.method === 'POST' && route === '/state') {
              const body = await readJsonBody(req)
              const next = body?.state
              if (!next || typeof next !== 'object') return send(res, 400, { ok: false, error: '缺少 state' })
              writeState(next)
              return send(res, 200, { ok: true })
            }

            if (req.method === 'POST' && route === '/chat') {
              const body = await readJsonBody(req)
              const message = String(body?.message ?? '').trim()
              if (!message) return send(res, 400, { ok: false, error: '消息为空' })
              if (message.length > MAX_MESSAGE_CHARS) return send(res, 400, { ok: false, error: '消息太长了' })
              const words = normalizeWords(body?.words)
              const prior = historyBlock(body?.history)
              const user = [
                '【当前词表】',
                wordsBlock(words),
                '',
                '【之前的对话】',
                prior || '（还没有聊过）',
                '',
                '【学生这次说】',
                message,
                '',
                '请直接回答，不要复述这些说明。',
              ].join('\n')
              const text = await callModel(ctx, { system: CHAT_SYSTEM, user, temperature: 0.6, maxTokens: 1200 })
              return send(res, 200, { ok: true, text })
            }

            if (req.method === 'POST' && route === '/lookup') {
              const body = await readJsonBody(req)
              const terms = normalizeWords(body?.words).map((word) => word.term).slice(0, 40)
              if (terms.length === 0) return send(res, 400, { ok: false, error: '没有要查询的单词' })
              const user = [
                '请为下面这些英语单词或短语查询词典条目：',
                terms.map((term) => '- ' + term).join('\n'),
                '',
                '只输出一个 JSON 数组，不要代码块，不要任何别的文字。每一项格式：',
                '{"term":"输入的单词原样","phonetic":"英式音标，用斜杠包住，如 /ˈæŋkəl/","pos":"n.","meaning":"最常见的中文释义，用中文分号分隔，最多 3 个义项"}',
                '规则：短语 pos 用 phr.；没有把握的音标给空字符串；不要例句；不要遗漏任何一项；顺序与输入一致。',
              ].join('\n')
              const raw = await callModel(ctx, { system: LOOKUP_SYSTEM, user, temperature: 0, maxTokens: 2000 })
              let entries
              try {
                entries = normalizeLookup(extractJson(raw), terms)
              } catch {
                entries = terms.map((term) => ({ term, phonetic: '', pos: '', meaning: '' }))
              }
              return send(res, 200, { ok: true, entries })
            }

            if (req.method === 'POST' && route === '/reading') {
              const body = await readJsonBody(req)
              const words = normalizeWords(body?.words)
              if (words.length === 0) return send(res, 400, { ok: false, error: '先添加一些单词再出题' })
              const count = Math.min(8, Math.max(2, Number(body?.count) || 5))
              const difficulty = String(body?.difficulty ?? '高中').slice(0, 20)
              const user = [
                '请用下面这些英语单词写一篇英语阅读理解短文，并出单选题。',
                '',
                '【必须覆盖的单词】',
                wordsBlock(words),
                '',
                `【难度】${difficulty}`,
                `【题目数量】${count} 道`,
                '',
                '写作要求：',
                '- 短文 3~4 段，总词数 180~260；这些单词至少用上 80%，用上的要自然融入，不要生硬罗列。',
                '- 题材可以是故事、科普、校园生活或社会话题；语言地道，适合英语学习者。',
                '- 每题 4 个选项，只有一个正确答案；题干用英文。',
                '- 解析用中文，简短说明为什么对，必要时点出这个词在文中的意思。',
                '',
                '只输出一个 JSON 对象，不要代码块，不要任何别的文字。格式：',
                '{"title":"英文标题","passage":"英文短文，段落之间用 \\n\\n 分隔","questions":[{"question":"英文题干","options":["A. 选项","B. 选项","C. 选项","D. 选项"],"answer":"A","explanation":"中文解析"}]}',
              ].join('\n')
              const raw = await callModel(ctx, { system: READING_SYSTEM, user, temperature: 0.75, maxTokens: 2600 })
              let reading
              try {
                reading = normalizeReading(extractJson(raw), words)
              } catch {
                // JSON 解析失败时不要把整段崩掉：把原始文本交给前端兜底展示。
                reading = {
                  title: 'Reading Comprehension',
                  passage: raw,
                  questions: [],
                  words: words.map((word) => word.term),
                  createdAt: Date.now(),
                  raw: true,
                }
              }
              return send(res, 200, { ok: true, reading })
            }

            return send(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return send(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'wordbook: HTTP 路由',
  )
}

/** 插件入口。 */
export function apply(ctx) {
  const ready = (scoped) => {
    if (!scoped.webServer) return
    mount(scoped, scoped.webServer)
  }
  const direct = ctx.get?.('webServer')
  if (direct) {
    mount(ctx, direct)
    return
  }
  ctx.inject(['webServer'], ready)
}

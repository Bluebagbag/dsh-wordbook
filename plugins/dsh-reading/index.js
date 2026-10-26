/**
 * dsh-reading — 按词表生成英语阅读理解
 * ════════════════════════════════════════════════════════════════════════
 * 普通出题接口的短文字数是写死的；墨墨一天几十个词时根本塞不下。
 * 这里按词数动态拉长短文，并要求每个目标词至少出现一次（原形或变形都可）。
 * 只读：只生成题目，不写回墨墨或本地词表。
 */

import path from 'node:path'

export const name = 'reading-gen'
export const inject = ['webServer', 'llm', 'agentDefaultModel']

const MAX_BODY_BYTES = 256 * 1024
const MAX_WORDS = 200

function selectionOf(ctx) {
  try {
    const selection = ctx.agentDefaultModel?.currentSelection?.()
    if (selection?.provider && selection?.model) return selection
  } catch {
    /* fallback below */
  }
  return { provider: 'deepseek-official', model: 'deepseek-flash' }
}

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

function normalizeWords(input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const item of input.slice(0, MAX_WORDS)) {
    const term = String(item && typeof item === 'object' ? item.term ?? item.word ?? item.spelling ?? '' : item ?? '').trim()
    const meaning = String(item && typeof item === 'object' ? item.meaning ?? '' : '').trim()
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ term: term.slice(0, 120), meaning: meaning.slice(0, 300) })
  }
  return out
}

const SYSTEM = `你是一位英语阅读命题老师。你写短文和题目，只输出严格的 JSON，不输出 Markdown 代码块或多余解释。`

function extractJson(text) {
  let body = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const objAt = body.indexOf('{')
  const arrAt = body.indexOf('[')
  const arrayFirst = arrAt >= 0 && (objAt < 0 || arrAt < objAt)
  const first = arrayFirst ? arrAt : objAt
  const last = arrayFirst ? body.lastIndexOf(']') : body.lastIndexOf('}')
  if (first >= 0 && last > first) body = body.slice(first, last + 1)
  return JSON.parse(body)
}

function normalizeAnswer(answer, options) {
  const value = String(answer ?? '').trim()
  if (/^[A-Ha-h]$/.test(value)) return value.toUpperCase()
  const prefixed = value.match(/^([A-Ha-h])\s*[.、)．:：]/)
  if (prefixed) return prefixed[1].toUpperCase()
  const found = value.match(/\b([A-Ha-h])\b/)
  if (found) return found[1].toUpperCase()
  const index = options.findIndex((option) => String(option).trim() === value)
  if (index >= 0) return String.fromCharCode(65 + index)
  return value
}

function normalizeReading(payload, words) {
  const passage = String(payload?.passage ?? '').trim()
  if (!passage) throw new Error('模型没有给出短文')
  const questions = (Array.isArray(payload?.questions) ? payload.questions : [])
    .slice(0, 10)
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
  if (questions.length === 0) throw new Error('模型没有给出可用的题目')
  return {
    title: String(payload?.title ?? 'Reading Comprehension').trim(),
    passage,
    questions,
    words: words.map((word) => word.term),
    wordCount: words.length,
    createdAt: Date.now(),
  }
}

function trustCheck(req) {
  const host = String(req.headers?.host || '')
  if (!host || !/^[-a-zA-Z0-9.]+(:\d+)?$/.test(host)) return false
  const origin = req.headers?.origin
  if (origin === 'null') return false
  if (origin !== undefined && origin !== null) {
    try {
      if (new URL(String(origin)).host.toLowerCase() !== host.toLowerCase()) return false
    } catch {
      return false
    }
  }
  return true
}

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
  return text ? JSON.parse(text) : {}
}

function send(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function mount(ctx, webServer) {
  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: '/dsh-reading/api',
        handler: async (req, res) => {
          try {
            if (!trustCheck(req)) return send(res, 403, { ok: false, error: 'untrusted request' })
            const url = new URL(req.url || '/', 'http://localhost')
            const route = url.pathname.replace(/^\/dsh-reading\/api/, '') || '/'
            if (req.method !== 'POST' || route !== '/make') return send(res, 404, { ok: false, error: 'not found' })

            const body = await readJsonBody(req)
            const words = normalizeWords(body?.words)
            if (words.length === 0) return send(res, 400, { ok: false, error: '没有单词' })
            const count = Math.min(8, Math.max(3, Number(body?.count) || 5))
            const difficulty = String(body?.difficulty ?? '高中').slice(0, 20)
            const targetWords = Math.max(220, Math.min(900, words.length * 8))
            const list = words.map((word) => `- ${word.term}${word.meaning ? '：' + word.meaning : ''}`).join('\n')
            const user = [
              `请用下面全部 ${words.length} 个英语单词写一篇英语阅读理解短文，并出 ${count} 道单选题。`,
              '',
              '【必须覆盖的单词】',
              list,
              '',
              `【难度】${difficulty}`,
              `【短文长度】约 ${targetWords} 个英文单词，分 4~6 段`,
              '',
              '硬性要求：',
              `1. 必须把上面每一个单词都用进短文，每个至少出现一次；原形或常见变形（复数、过去式、ing 等）都算。`,
              '2. 不要为了塞词写成单词表；用故事、科普或校园生活把它们自然串起来。',
              '3. 每题 4 个选项，只有一个正确答案；题干用英文。',
              '4. 解析用中文，一句话说明为什么对；不要写长解析。',
              '5. 只输出一个 JSON 对象，不要代码块，不要任何别的文字。格式：',
              '{"title":"英文标题","passage":"英文短文，段落之间用 \\n\\n 分隔","questions":[{"question":"英文题干","options":["A. 选项","B. 选项","C. 选项","D. 选项"],"answer":"A","explanation":"中文解析"}]}',
            ].join('\n')

            const raw = await callModel(ctx, { system: SYSTEM, user, temperature: 0.75, maxTokens: 6000 })
            let reading
            try {
              reading = normalizeReading(extractJson(raw), words)
            } catch {
              reading = {
                title: 'Reading Comprehension',
                passage: raw,
                questions: [],
                words: words.map((word) => word.term),
                wordCount: words.length,
                createdAt: Date.now(),
                raw: true,
              }
            }
            return send(res, 200, { ok: true, reading })
          } catch (error) {
            return send(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'reading-gen: route',
  )
}

export function apply(ctx) {
  const direct = ctx.get?.('webServer')
  if (direct) return mount(ctx, direct)
  ctx.inject(['webServer'], (scoped) => mount(scoped, scoped.webServer))
}

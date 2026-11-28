/**
 * dsh-practice — 结构化默写的宿主半边
 * ════════════════════════════════════════════════════════════════════════
 * 两个只读接口：
 *   POST /dsh-practice/api/generate  为一批词生成「语境句 + 锁定义项 + 可接受说法」
 *   POST /dsh-practice/api/judge     判断学生的中文答案是否贴合句中的意思
 *
 * 只调用模型，不写任何词表、不写墨墨。
 */

export const name = 'practice'
export const inject = ['webServer', 'llm', 'agentDefaultModel']

const MAX_BODY_BYTES = 128 * 1024
const MAX_WORDS = 30

function selectionOf(ctx) {
  try {
    const selection = ctx.agentDefaultModel?.currentSelection?.()
    if (selection?.provider && selection?.model) return selection
  } catch {
    /* fallback */
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
  if (!text.trim()) throw new Error('模型没有返回内容，请重试')
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

function normalizeItem(raw, fallbackTerm) {
  if (!raw || typeof raw !== 'object') return null
  const term = String(raw.term || fallbackTerm || '').trim()
  const sentence = String(raw.sentence || '').trim()
  const meaning = String(raw.meaning || '').trim()
  if (!term || !sentence || !meaning) return null
  const accepted = (Array.isArray(raw.accepted) ? raw.accepted : [])
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 8)
  return {
    term,
    sentence: sentence.slice(0, 500),
    meaning: meaning.slice(0, 200),
    accepted,
    translation: String(raw.translation || '').trim().slice(0, 500),
  }
}

function normalizeItems(payload, words) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : []
  const byTerm = new Map(words.map((word) => [word.term.toLowerCase(), word.term]))
  const out = []
  for (const row of rows) {
    const item = normalizeItem(row, '')
    if (!item) continue
    const canonical = byTerm.get(item.term.toLowerCase())
    if (!canonical) continue
    item.term = canonical
    out.push(item)
  }
  // 按输入顺序返回，模型漏掉的词就跳过。
  const order = new Map(words.map((word, index) => [word.term.toLowerCase(), index]))
  return out.sort((left, right) => (order.get(left.term.toLowerCase()) ?? 999) - (order.get(right.term.toLowerCase()) ?? 999))
}

const GENERATE_SYSTEM = `你是一位英语词汇教练。你写语境句和中文释义，只输出严格的 JSON，不输出 Markdown 代码块或解释。`

const JUDGE_SYSTEM = `你是一位严格但通情达理的英语词汇老师。你只判断学生写的中文是否贴合句中词义，只输出严格的 JSON。`

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
        path: '/dsh-practice/api',
        handler: async (req, res) => {
          try {
            if (!trustCheck(req)) return send(res, 403, { ok: false, error: 'untrusted request' })
            const url = new URL(req.url || '/', 'http://localhost')
            const route = url.pathname.replace(/^\/dsh-practice\/api/, '') || '/'

            if (req.method === 'POST' && route === '/generate') {
              const body = await readJsonBody(req)
              const words = normalizeWords(body?.words)
              if (words.length === 0) return send(res, 400, { ok: false, error: '没有单词' })
              const count = Math.min(words.length, Math.max(1, Number(body?.count) || words.length))
              const selected = words.slice(0, count)
              const list = selected.map((word) => `- ${word.term}${word.meaning ? '（参考义：' + word.meaning + '）' : ''}`).join('\n')
              const user = [
                `请为下面 ${selected.length} 个英语单词/短语各写一个语境句，并锁定一个中文义项。`,
                '',
                '【目标词】',
                list,
                '',
                '要求：',
                '1. 每个目标词写一个自然、生活化的英文句子；目标词在句中只体现一个明确的中文意思。',
                '2. 一词多义时，用句子语境把你要考的那个义项锁死，不要写歧义句。',
                '3. 给出这个词在句中的中文意思（meaning），尽量简短；再给 2~4 个可接受的中文说法（accepted），方便判分。',
                '4. 给句子一句中文翻译（translation）。',
                '5. 目标词在句中使用原形或常见变形都可以；短语要完整出现。',
                '6. 只输出一个 JSON 数组，不要代码块，不要任何别的文字：',
                '[{"term":"challenge","sentence":"The new job is a real challenge for her.","meaning":"挑战","accepted":["挑战","难题"],"translation":"这份新工作对她来说是个真正的挑战。"}]',
              ].join('\n')
              const raw = await callModel(ctx, { system: GENERATE_SYSTEM, user, temperature: 0.7, maxTokens: 5000 })
              let items = []
              try {
                items = normalizeItems(extractJson(raw), selected)
              } catch {
                items = []
              }
              if (items.length === 0) return send(res, 502, { ok: false, error: '生成失败，模型没有给出可用的语境题，请重试' })
              return send(res, 200, { ok: true, items })
            }

            if (req.method === 'POST' && route === '/judge') {
              const body = await readJsonBody(req)
              const term = String(body?.term || '').trim()
              const sentence = String(body?.sentence || '').trim()
              const meaning = String(body?.meaning || '').trim()
              const accepted = (Array.isArray(body?.accepted) ? body.accepted : []).map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
              const answer = String(body?.answer || '').trim()
              if (!term || !meaning || !answer) return send(res, 400, { ok: false, error: '缺少判分参数' })
              const user = [
                '句子：' + sentence,
                '目标词：' + term,
                '这个词在句中的意思：' + meaning,
                accepted.length > 0 ? '可接受说法：' + accepted.join('；') : '',
                '学生答案：' + answer,
                '',
                '判断学生答案是否表达了这个词在句中的意思。同义、近义、口语化、只写了其中一个义项，都算对；只写词性或英文不算。',
                '只输出一个 JSON 对象：{"correct":true或false,"feedback":"不超过40字的中文反馈","canonical":"最准确的中文意思"}',
              ].filter(Boolean).join('\n')
              const raw = await callModel(ctx, { system: JUDGE_SYSTEM, user, temperature: 0, maxTokens: 400 })
              let result
              try {
                const parsed = extractJson(raw)
                result = {
                  correct: parsed?.correct === true,
                  feedback: String(parsed?.feedback || '').slice(0, 120),
                  canonical: String(parsed?.canonical || meaning).slice(0, 120),
                }
              } catch {
                result = { correct: false, feedback: '没判断出来，请再试一次。', canonical: meaning }
              }
              return send(res, 200, { ok: true, ...result })
            }

            return send(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return send(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'practice: routes',
  )
}

export function apply(ctx) {
  const direct = ctx.get?.('webServer')
  if (direct) return mount(ctx, direct)
  ctx.inject(['webServer'], (scoped) => mount(scoped, scoped.webServer))
}

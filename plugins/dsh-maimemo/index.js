/**
 * dsh-maimemo — 墨墨开放 API 的只读桥接
 * ════════════════════════════════════════════════════════════════════════
 * 只做读操作：
 *   GET  /study/get_study_progress     今日进度
 *   POST /study/get_today_items        今日单词
 *   POST /study/query_study_records    学习记录（study_count / tags / next_study_date）
 *   POST /vocabulary/query             拼写 → voc_id
 *   GET  /interpretations?voc_id=      自定义释义（可能为空）
 *   GET  /phrases?voc_id=              自定义例句（可能为空）
 *
 * 绝不调用 add_words / advance_study / notes / interpretations 写入等接口，
 * 不会改动用户的学习内容或进度。
 *
 * Token 从 $DSH_HOME/maimemo/config.json 读取（600 权限），不落到前端。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'maimemo'
export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'maimemo', 'config.json')

const MAX_BODY_BYTES = 64 * 1024
const MIN_GAP_MS = 550 // 墨墨限速 20 次/10 秒，留一点余量
const TODAY_TTL_MS = 25 * 1000
const LOOKUP_TTL_MS = 6 * 60 * 60 * 1000

const todayCache = { at: 0, data: null }
const lookupCache = new Map()

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return {}
    return {
      token: String(parsed.token || '').trim(),
      baseUrl: String(parsed.baseUrl || 'https://open.maimemo.com/open/api/v1').replace(/\/+$/, ''),
    }
  } catch {
    return {}
  }
}

// ── 限速：所有墨墨请求串行排队，间隔 MIN_GAP_MS ──────────────────────
let gateChain = Promise.resolve()
let lastCallAt = 0
function gate() {
  const run = gateChain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastCallAt = Date.now()
  })
  gateChain = run.catch(() => {})
  return run
}

function errorMessage(payload, status) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : undefined
  const msg = first?.msg || first?.code || payload?.error || ('HTTP ' + status)
  if (String(msg) === 'Internal server error') return '墨墨服务暂时不可用（公测接口偶发 503），点重试'
  return String(msg)
}

/** 调一个墨墨端点，返回 data（实际响应是 {success, data, errors}）。 */
async function call(route, options = {}, attempt = 0) {
  const config = readConfig()
  if (!config.token) throw Object.assign(new Error('还没有配置墨墨 token'), { code: 'NO_TOKEN' })
  const method = options.method || 'GET'
  const url = new URL(config.baseUrl + route)
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  await gate()
  let response
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(30000),
    })
  } catch (error) {
    throw Object.assign(new Error('连接墨墨失败：' + (error && error.message ? error.message : String(error))), { code: 'NETWORK' })
  }
  const text = await response.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = null
  }
  if (!response.ok || payload?.success === false || payload === null) {
    // 公测的学习数据接口偶发 503，自动重试一次再报错。
    if (response.status >= 500 && attempt < 1) {
      await new Promise((resolve) => setTimeout(resolve, 900))
      return call(route, options, attempt + 1)
    }
    throw Object.assign(new Error(errorMessage(payload, response.status)), {
      code: payload?.errors?.[0]?.code || 'HTTP_' + response.status,
      status: response.status,
    })
  }
  return payload.data ?? payload
}

// ── 今日任务 ─────────────────────────────────────────────────────────

function modeOf(item, record) {
  const tags = Array.isArray(record?.tags) ? record.tags : []
  const studyCount = Number(record?.study_count) || 0
  if (item.is_new) return 'word'
  if (tags.includes('STICKING')) return 'word'
  if (tags.includes('WELL_FAMILIAR') || studyCount >= 4) return 'sentence'
  return 'word'
}

function enrichItems(items, records) {
  const bySpelling = new Map()
  for (const record of records) {
    if (record?.voc_spelling) bySpelling.set(String(record.voc_spelling).toLowerCase(), record)
  }
  return items.map((item) => {
    const record = bySpelling.get(String(item.voc_spelling).toLowerCase())
    const tags = Array.isArray(record?.tags) ? record.tags : []
    return {
      vocId: item.voc_id,
      spelling: item.voc_spelling,
      order: item.order,
      isNew: item.is_new === true,
      isFinished: item.is_finished === true,
      firstResponse: item.first_response || '',
      studyCount: Number(record?.study_count) || 0,
      tags,
      sticking: tags.includes('STICKING'),
      wellFamiliar: tags.includes('WELL_FAMILIAR'),
      nextStudyDate: record?.next_study_date || '',
      lastStudyDate: record?.last_study_date || '',
      mode: modeOf(item, record),
    }
  })
}

async function loadToday(force = false) {
  if (!force && todayCache.data && Date.now() - todayCache.at < TODAY_TTL_MS) return todayCache.data
  const progressData = await call('/study/get_study_progress', { method: 'POST', body: {} })
  const todayData = await call('/study/get_today_items', { method: 'POST', body: { limit: 1000 } })
  const items = Array.isArray(todayData.today_items) ? todayData.today_items : []
  let records = []
  if (items.length > 0) {
    const spellings = [...new Set(items.map((item) => item.voc_spelling).filter(Boolean))]
    try {
      const recordData = await call('/study/query_study_records', { method: 'POST', body: { spellings, limit: 1000 } })
      records = Array.isArray(recordData.records) ? recordData.records : []
    } catch {
      // records 是增强信息，失败时仍然返回今日单词（mode 会退化）。
    }
  }
  const enriched = enrichItems(items, records)
  const progress = progressData.progress || {}
  const data = {
    progress: {
      finished: Number(progress.finished) || 0,
      total: Number(progress.total) || 0,
      studyTime: Number(progress.study_time) || 0,
    },
    items: enriched,
    counts: {
      total: enriched.length,
      finished: enriched.filter((item) => item.isFinished).length,
      remaining: enriched.filter((item) => !item.isFinished).length,
      newCount: enriched.filter((item) => item.isNew).length,
      sticking: enriched.filter((item) => item.sticking).length,
      sentenceMode: enriched.filter((item) => item.mode === 'sentence').length,
    },
    fetchedAt: Date.now(),
  }
  todayCache.at = Date.now()
  todayCache.data = data
  return data
}

// ── 单词 / 自定义释义 / 例句（只读） ─────────────────────────────────

async function resolveVocIds(spellings) {
  const ids = new Map()
  const missing = []
  for (const spelling of spellings) {
    const key = spelling.toLowerCase()
    const cached = lookupCache.get(key)
    if (cached && cached.vocId) ids.set(key, cached.vocId)
    else missing.push(spelling)
  }
  if (missing.length > 0) {
    const data = await call('/vocabulary/query', { method: 'POST', body: { spellings: missing } })
    for (const voc of data.voc || []) {
      if (voc?.spelling && voc?.id) {
        const key = String(voc.spelling).toLowerCase()
        ids.set(key, voc.id)
        const entry = lookupCache.get(key) || { fetchedAt: Date.now() }
        entry.vocId = voc.id
        lookupCache.set(key, entry)
      }
    }
  }
  return ids
}

function cachedEntry(spelling) {
  const key = spelling.toLowerCase()
  let entry = lookupCache.get(key)
  if (!entry || Date.now() - entry.fetchedAt > LOOKUP_TTL_MS) {
    entry = { fetchedAt: Date.now() }
    lookupCache.set(key, entry)
  }
  return entry
}

async function fetchInterpretations(spelling) {
  const entry = cachedEntry(spelling)
  if (Array.isArray(entry.interpretations)) return
  if (!entry.vocId) entry.interpretations = []
  else {
    const data = await call('/interpretations', { query: { voc_id: entry.vocId } })
    entry.interpretations = (Array.isArray(data.interpretations) ? data.interpretations : [])
      .filter((item) => item && item.status !== 'DELETED')
      .map((item) => ({ text: String(item.interpretation || ''), tags: item.tags || [] }))
      .filter((item) => item.text)
  }
}

async function fetchPhrases(spelling) {
  const entry = cachedEntry(spelling)
  if (Array.isArray(entry.phrases)) return
  if (!entry.vocId) entry.phrases = []
  else {
    const data = await call('/phrases', { query: { voc_id: entry.vocId } })
    entry.phrases = (Array.isArray(data.phrases) ? data.phrases : [])
      .filter((item) => item && item.status !== 'DELETED')
      .map((item) => ({ text: String(item.phrase || ''), translation: String(item.interpretation || ''), tags: item.tags || [] }))
      .filter((item) => item.text)
  }
}

async function lookup(spellings, withPhrases) {
  const unique = [...new Set(spellings.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 12)
  if (unique.length === 0) return []
  await resolveVocIds(unique)
  for (const spelling of unique) {
    await fetchInterpretations(spelling)
    if (withPhrases) await fetchPhrases(spelling)
  }
  return unique.map((spelling) => {
    const entry = cachedEntry(spelling)
    return {
      spelling,
      vocId: entry.vocId || '',
      meanings: Array.isArray(entry.interpretations) ? entry.interpretations : [],
      phrases: Array.isArray(entry.phrases) ? entry.phrases : [],
    }
  })
}

// ── HTTP 路由 ────────────────────────────────────────────────────────

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
        path: '/dsh-maimemo/api',
        handler: async (req, res) => {
          try {
            if (!trustCheck(req)) return send(res, 403, { ok: false, error: 'untrusted request' })
            const url = new URL(req.url || '/', 'http://localhost')
            const route = url.pathname.replace(/^\/dsh-maimemo\/api/, '') || '/'
            const config = readConfig()

            if (req.method === 'GET' && route === '/status') {
              return send(res, 200, {
                ok: true,
                configured: Boolean(config.token),
                todayCachedAt: todayCache.at || 0,
                cacheSize: lookupCache.size,
                readOnly: true,
              })
            }

            if (req.method === 'POST' && route === '/today') {
              const body = await readJsonBody(req)
              const data = await loadToday(body?.force === true)
              return send(res, 200, { ok: true, ...data })
            }

            if (req.method === 'POST' && route === '/lookup') {
              const body = await readJsonBody(req)
              const spellings = Array.isArray(body?.spellings) ? body.spellings : []
              const words = await lookup(spellings, body?.phrases === true)
              return send(res, 200, { ok: true, words })
            }

            return send(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return send(res, 500, {
              ok: false,
              error: error && error.message ? error.message : String(error),
              code: error && error.code ? error.code : 'INTERNAL',
            })
          }
        },
      }),
    'maimemo: read-only routes',
  )
}

export function apply(ctx) {
  const direct = ctx.get?.('webServer')
  if (direct) return mount(ctx, direct)
  ctx.inject(['webServer'], (scoped) => mount(scoped, scoped.webServer))
}

/** 单元测试把手（框架不认识这个字段）。 */
export const __internals = { modeOf, enrichItems }

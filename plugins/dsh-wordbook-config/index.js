/**
 * dsh-wordbook-config — 本机设置小桥
 * ════════════════════════════════════════════════════════════════════════
 * 只做一件事：让设置面板能保存/清除墨墨 token。
 * Token 永远不返回给前端，只返回“是否已配置”。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'wordbook-config'
export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'maimemo', 'config.json')
const MAX_BODY_BYTES = 8 * 1024

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return {}
    return {
      baseUrl: String(parsed.baseUrl || 'https://open.maimemo.com/open/api/v1').replace(/\/+$/, ''),
      token: String(parsed.token || '').trim(),
    }
  } catch {
    return {}
  }
}

function writeToken(token) {
  const config = readConfig()
  const next = {
    baseUrl: config.baseUrl || 'https://open.maimemo.com/open/api/v1',
    token: String(token || '').trim(),
  }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  try { fs.chmodSync(path.dirname(CONFIG_FILE), 0o700) } catch { /* ignore */ }
  const tmp = CONFIG_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next), 'utf8')
  fs.renameSync(tmp, CONFIG_FILE)
  try { fs.chmodSync(CONFIG_FILE, 0o600) } catch { /* ignore */ }
  return next
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
        path: '/dsh-wordbook-config/api',
        handler: async (req, res) => {
          try {
            if (!trustCheck(req)) return send(res, 403, { ok: false, error: 'untrusted request' })
            const url = new URL(req.url || '/', 'http://localhost')
            const route = url.pathname.replace(/^\/dsh-wordbook-config\/api/, '') || '/'

            if (route === '/maimemo' && req.method === 'GET') {
              return send(res, 200, { ok: true, configured: Boolean(readConfig().token) })
            }

            if (route === '/maimemo' && req.method === 'POST') {
              const body = await readJsonBody(req)
              const token = String(body?.token ?? '').trim().slice(0, 1000)
              const next = writeToken(token)
              return send(res, 200, { ok: true, configured: Boolean(next.token) })
            }

            return send(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return send(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'wordbook-config: routes',
  )
}

export function apply(ctx) {
  const direct = ctx.get?.('webServer')
  if (direct) return mount(ctx, direct)
  ctx.inject(['webServer'], (scoped) => mount(scoped, scoped.webServer))
}

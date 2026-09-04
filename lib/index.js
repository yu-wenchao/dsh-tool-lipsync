/**
 * dsh-tool-lipsync — Host half (Node side)
 * -------------------------------------------
 * 在 DSH 的 Node 进程里运行。职责：
 *   1) 开启一个本地 HTTP bridge（默认 127.0.0.1:8790），
 *      代理 FreeLipSync 的公开 API（samples / voices / upload / generate /
 *      status / history），供浏览器端 client.js 面板调用（绕过 CORS，
 *      且不消耗模型 token）。
 *   2) 同时在 DSH 工具注册表注册 lipsync_* 工具，保留对话调用能力。
 *
 * 关键点：freelipsync.com 不返回 CORS 头，浏览器无法直连；
 * 因此所有 API 都经由本 host bridge 代理。
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-tool-lipsync'
export const inject = ['tools']

const API_BASE = 'https://freelipsync.com'
const LOG = '[tool-lipsync-ui]'

// ---------- 匿名会话 cookie jar ----------
let sessionCookies = {}
let sessionReady = false

function captureSetCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const raw of list) {
    const [pair] = raw.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) sessionCookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
}
function cookieHeader() {
  const entries = Object.entries(sessionCookies)
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join('; ') : undefined
}
let sessionPromise = null
async function ensureSession() {
  if (sessionReady) return
  if (sessionPromise) return sessionPromise
  sessionPromise = (async () => {
    try {
      const r = await fetch(`${API_BASE}/zh-CN`, { headers: UA() })
      captureSetCookies(r)
    } catch { /* 忽略 */ }
    sessionReady = true
    sessionPromise = null
  })()
  return sessionPromise
}
function UA() {
  return { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0' }
}

/** 请求 FreeLipSync API（统一处理 cookie、重定向、JSON） */
async function callAPI(method, apiPath, body, contentType) {
  await ensureSession()
  const url = apiPath.startsWith('http') ? apiPath : `${API_BASE}${apiPath}`
  const headers = { ...UA() }
  const cookie = cookieHeader()
  if (cookie) headers['Cookie'] = cookie
  let init = { method, headers, redirect: 'follow' }
  if (body != null) {
    if (Buffer.isBuffer(body)) {
      headers['Content-Type'] = contentType || 'application/octet-stream'
      init.body = body
    } else if (typeof body === 'string') {
      headers['Content-Type'] = contentType || 'application/json'
      init.body = body
    } else {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
  }
  const resp = await fetch(url, init)
  captureSetCookies(resp)
  const text = await resp.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: resp.status, json, text }
}

// ---------- 历史记录（按 DSH_HOME 或临时目录持久化） ----------
let historyFile = null
let backendFile = null
let backendConfig = { base: '', key: '', session: '', user: '', userLoggedIn: false }
function initStateDir(stateDir) {
  let dir
  if (stateDir) dir = stateDir
  else dir = join(tmpdir(), 'dsh-lipsync-ui-state')
  try { mkdirSync(dir, { recursive: true }) } catch {}
  historyFile = join(dir, 'history.json')
  backendFile = join(dir, 'backend.json')
  try { backendConfig = { ...backendConfig, ...JSON.parse(readFileSync(backendFile, 'utf8')) } } catch {}
  // 兼容旧版本：如果 session 以 'auth_' 开头，说明是登录状态
  if (backendConfig.session && backendConfig.session.startsWith('auth_')) {
    backendConfig.userLoggedIn = true
  } else {
    backendConfig.userLoggedIn = false
  }
}
function saveBackendConfig() {
  try { writeFileSync(backendFile, JSON.stringify(backendConfig, null, 2), 'utf8') } catch {}
}
function backendReady() {
  return !!(backendConfig?.base && backendConfig?.key)
}

/**
 * 请求白标后台（经 CF 内网穿透）。generate/status/download/license/auth/register
 * 全部经由后台代理,以轮换后台账号池里的 cookie 拿到无水印低清版本。
 */
async function callBackend(method, apiPath, body) {
  if (!backendReady()) {
    return { status: 503, json: { ok: false, error: 'backend not configured', code: 'NO_BACKEND' }, text: '' }
  }
  const url = `${backendConfig.base}${apiPath}`
  const headers = {
    'Content-Type': 'application/json',
    'X-FLS-Api-Key': backendConfig.key,
  }
  if (backendConfig.session) headers['Cookie'] = backendConfig.session
  const init = { method, headers }
  if (body != null) init.body = JSON.stringify(body)
  let resp
  try {
    resp = await fetch(url, init)
  } catch (e) {
    return { status: 0, json: { ok: false, error: 'backend unreachable', code: 'BACKEND_NET' }, text: '' }
  }
  // 捕获后台 set-cookie(用户登录会话)
  const setCookies = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : []
  if (setCookies.length) {
    const pairs = []
    for (const raw of setCookies) {
      const [pair] = raw.split(';')
      if (pair) pairs.push(pair)
    }
    if (pairs.length) { backendConfig.session = pairs.join('; '); saveBackendConfig() }
  }
  const text = await resp.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: resp.status, json, text }
}
function loadHistory() {
  try { return JSON.parse(readFileSync(historyFile, 'utf8')) } catch { return [] }
}
function addHistory(entry) {
  try {
    const hist = loadHistory()
    const gid = entry.generationId
    if (!gid) return
    const idx = hist.findIndex(h => h.generationId === gid)
    if (idx >= 0) {
      // 已有同 ID 记录:合并更新(保留原始 createdAt 和首次 text/model)
      const existing = hist[idx]
      hist[idx] = { ...existing, ...entry, createdAt: existing.createdAt, text: existing.text || entry.text, model: existing.model || entry.model }
    } else {
      hist.unshift({ ...entry, createdAt: Date.now() })
    }
    writeFileSync(historyFile, JSON.stringify(hist.slice(0, 200), null, 2), 'utf8')
  } catch { /* 忽略写失败 */ }
}
function writeHistory(hist) {
  try { writeFileSync(historyFile, JSON.stringify(hist.slice(0, 200), null, 2), 'utf8') } catch { /* 忽略 */ }
}

// 对 history 里未结束的任务实时核对 freelipsync 状态，补上 videoUrl / 状态
async function reconcileHistory(hist) {
  const out = []
  let changed = false
  for (const h of hist) {
    const isDone = h.status === 'completed' || h.status === 'failed'
    if (isDone || !h.generationId) { out.push(h); continue }
    try {
      const r = backendReady()
        ? await callBackend('POST', '/api/status.php', { ids: [h.generationId] })
        : await callAPI('POST', `/api/status/batch?poll=1`, { ids: [h.generationId] })
      const gen = r.json?.generations?.[0] || r.json?.generation || null
      if (gen && gen.status && gen.status !== h.status) {
        changed = true
        const nh = { ...h, status: gen.status, videoUrl: gen.videoUrl || h.videoUrl, lowResolutionVideoUrl: gen.lowResolutionVideoUrl || h.lowResolutionVideoUrl, error: gen.error || h.error }
        if (gen.status === 'completed' || gen.status === 'failed') out.push(nh)
        else out.push({ ...nh, status: 'processing' })
        continue
      }
      if (gen && gen.status === 'completed' && (gen.videoUrl || gen.lowResolutionVideoUrl) && h.status !== 'completed') {
        changed = true; out.push({ ...h, status: 'completed', videoUrl: gen.videoUrl || h.videoUrl, lowResolutionVideoUrl: gen.lowResolutionVideoUrl || h.lowResolutionVideoUrl }); continue
      }
      out.push(h)
    } catch { out.push(h) }
  }
  if (changed) { try { writeFileSync(historyFile, JSON.stringify(out.slice(0, 200), null, 2), 'utf8') } catch {} }
  return out
}

// ---------- 本地 bridge HTTP 服务 ----------
const MAX_BODY_BYTES = 50 * 1024 * 1024 // 50MB max request body
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let totalBytes = 0
    req.on('data', (c) => {
      totalBytes += c.length
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy()
        resolve({ __error: 'request body too large' })
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      try { resolve(JSON.parse(buf.toString('utf8'))) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}
// 本地 bridge 仅监听 127.0.0.1，CORS * 安全且兼容 DSH 不同端口加载
function json(res, status, obj) {
  const data = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(data)
}

async function bridgeHandler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
    res.end()
    return
  }
  let url
  try { url = new URL(req.url, 'http://127.0.0.1') } catch { return json(res, 400, { error: 'bad url' }) }
  const p = url.pathname
  try {
    if (p === '/api/health') return json(res, 200, { ok: true, ts: Date.now() })

    // 后台健康/配置(白标标题、开关、菜单、每日限额)
    if (p === '/api/frontend-config' && req.method === 'GET') {
      if (!backendReady()) return json(res, 200, { ok: true, configured: false, title: backendConfig.title || 'FreeLipSync', enabled: true, menus: [{}, {}, {}] })
      const r = await callBackend('GET', '/api/config.php')
      const merged = { ...(r.json || {}), configured: true }
      // 本地 bridge 配置的标题优先于后端返回的标题
      if (backendConfig.title) merged.title = backendConfig.title
      return json(res, r.status, merged)
    }

    // 后台对接配置(浏览器写,host 存本地)
    if (p === '/api/backend' && req.method === 'GET') {
      return json(res, 200, { ok: true, configured: backendReady(), base: backendConfig.base || '', key: backendConfig.key ? '已设置(已隐藏)' : '', loggedIn: !!backendConfig.userLoggedIn, user: backendConfig.user || '' })
    }
    if (p === '/api/backend' && req.method === 'POST') {
      const body = (await readBody(req)) || {}
      const hasBase = typeof body.base === 'string'
      const hasKey = typeof body.key === 'string'
      if (hasBase) backendConfig.base = String(body.base).replace(/\/+$/, '').trim()
      if (hasKey) backendConfig.key = String(body.key).trim()
      if (typeof body.title === 'string') backendConfig.title = body.title.trim()
      if (hasBase && backendConfig.base === '') { backendConfig.session = ''; backendConfig.userLoggedIn = false }
      saveBackendConfig()
      return json(res, 200, { ok: true, configured: backendReady(), base: backendConfig.base || '', loggedIn: !!backendConfig.userLoggedIn })
    }
    if (p === '/api/backend' && req.method === 'DELETE') {
      backendConfig.session = ''; backendConfig.user = ''
      saveBackendConfig()
      return json(res, 200, { ok: true })
    }

    // 授权 / 注册 / 登录
    if (p === '/api/license' && req.method === 'POST') {
      const r = await callBackend('POST', '/api/license.php', await readBody(req))
      return json(res, r.status, r.json || { error: 'license failed' })
    }
    if (p === '/api/register' && req.method === 'POST') {
      const body = await readBody(req)
      const r = await callBackend('POST', '/api/register.php', body)
      if (r.json?.ok) {
        backendConfig.user = body.email || ''
        backendConfig.userLoggedIn = true
        saveBackendConfig()
      }
      return json(res, r.status, r.json || { error: 'register failed' })
    }
    if (p === '/api/auth' && req.method === 'POST') {
      const body = await readBody(req)
      const r = await callBackend('POST', '/api/auth.php', body)
      if (r.json?.ok) {
        backendConfig.user = body.email || ''
        backendConfig.userLoggedIn = true
        saveBackendConfig()
      }
      else if (backendConfig.user === body.email) { backendConfig.user = '' }
      return json(res, r.status, r.json || { error: 'auth failed' })
    }
    if (p === '/api/logout' && req.method === 'POST') {
      backendConfig.session = ''; backendConfig.user = ''; backendConfig.userLoggedIn = false
      saveBackendConfig()
      return json(res, 200, { ok: true })
    }
    if (p === '/api/change-password' && req.method === 'POST') {
      const body = await readBody(req)
      const r = await callBackend('POST', '/api/change-password.php', body)
      return json(res, r.status, r.json || { error: 'change password failed' })
    }

    if (p === '/api/samples' && req.method === 'GET') {
      const r = await callAPI('GET', '/api/samples')
      return json(res, r.status, r.json || { samples: [] })
    }

    if (p === '/api/voices' && req.method === 'GET') {
      const locale = url.searchParams.get('locale') || 'zh-CN'
      const r = await callAPI('GET', `/api/catalog/voices?all=1&locale=${encodeURIComponent(locale)}`)
      const voices = Array.isArray(r.json) ? r.json : (r.json?.items || [])
      return json(res, r.status, { total: r.json?.total ?? voices.length, voices })
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const body = await readBody(req)
      const { filename, contentType, dataBase64 } = body || {}
      if (!filename || !dataBase64) return json(res, 400, { error: 'missing filename or dataBase64' })
      // 清理文件名，防止路径遍历
      const safeFilename = basename(filename).replace(/[^\w.\-]/g, '_').slice(0, 128)
      const buffer = Buffer.from(dataBase64, 'base64')
      const ps = await callAPI('POST', '/api/upload/presign', { filename: safeFilename, contentType: contentType || 'application/octet-stream', size: buffer.length })
      if (ps.status !== 200 || !ps.json?.uploadUrl) return json(res, 500, { error: 'presign failed', detail: ps.text?.slice(0, 200) })
      // 验证 presigned URL 域名，防止 SSRF
      try {
        const pu = new URL(ps.json.uploadUrl)
        const h = pu.hostname
        const allowed = h === 'freelipsync.com' || h.endsWith('.freelipsync.com') || h.endsWith('.r2.cloudflarestorage.com') || h.endsWith('.cloudflare.com') || h.endsWith('.amazonaws.com')
        if (!allowed) return json(res, 502, { error: 'invalid upload host: ' + h })
      } catch { return json(res, 500, { error: 'bad presign url' }) }
      const putResp = await fetch(ps.json.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType || 'application/octet-stream' }, body: buffer })
      if (!putResp.ok) return json(res, 502, { error: `upload to R2 failed HTTP ${putResp.status}` })
      return json(res, 200, { publicUrl: ps.json.publicUrl, fileKey: ps.json.fileKey })
    }

    if (p === '/api/generate' && req.method === 'POST') {
      const payload = await readBody(req)
      if (backendReady()) {
        const r = await callBackend('POST', '/api/generate.php', payload)
        return json(res, r.status, r.json || { error: r.text?.slice(0, 200) })
      }
      const r = await callAPI('POST', '/api/generate', payload)
      return json(res, r.status, r.json || { error: r.text?.slice(0, 200) })
    }

    if (p === '/api/status' && req.method === 'POST') {
      const { generationId } = await readBody(req)
      if (!generationId) return json(res, 400, { error: 'missing generationId' })
      if (backendReady()) {
        const r = await callBackend('POST', '/api/status.php', { ids: [generationId] })
        return json(res, r.status, { ...(r.json?.generation || r.json || {}), generationId })
      }
      const r = await callAPI('POST', `/api/status/batch?poll=1`, { ids: [generationId] })
      const gen = r.json?.generations?.[0]
      if (gen) return json(res, 200, { ...gen, generationId })
      return json(res, 200, { status: 'unknown', generationId, error: 'not found' })
    }

    // 下载:请求后台生成一次性临时链接(POST → 后台产链接,配额在前台把关)
    if (p === '/api/download' && req.method === 'POST') {
      const body = (await readBody(req)) || {}
      const generationId = body.generationId
      if (!generationId) return json(res, 400, { error: 'missing generationId' })
      if (!backendReady()) return json(res, 503, { error: 'backend not configured' })
      const r = await callBackend('POST', '/api/download.php', { generationId })
      // 后台返回的 media 链接重指到本地 bridge(/api/media),保持白标不暴露后台域名
      if (r.json?.url) {
        const tok = r.json.url.match(/token=([a-f0-9]{32})/)?.[1]
        if (tok) r.json.url = `/api/media?token=${tok}`
      }
      return json(res, r.status, r.json || { error: 'download failed' })
    }

    // 一次性媒体交付:浏览器(用户自身 IP)经本地 bridge 从后台拉临时文件字节。
    if (p === '/api/media' && req.method === 'GET') {
      const token = url.searchParams.get('token')
      if (!token || !/^[a-f0-9]{32}$/.test(token)) return json(res, 400, { error: 'bad token' })
      if (!backendReady()) return json(res, 503, { error: 'backend not configured' })
      const mediaUrl = `${backendConfig.base}/api/media.php?token=${token}`
      let dl
      try { dl = await fetch(mediaUrl, { headers: { 'X-FLS-Api-Key': backendConfig.key } }) }
      catch (e) { return json(res, 502, { error: 'media backend unreachable: ' + e.message }) }
      if (!dl.ok) {
        const t = await dl.text(); let j = {}; try { j = JSON.parse(t) } catch {}
        return json(res, dl.status, j)
      }
      const buf = Buffer.from(await dl.arrayBuffer())
      const contentType = dl.headers.get('content-type') || 'video/mp4'
      const disp = dl.headers.get('content-disposition') || 'attachment; filename="video.mp4"'
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
        'Content-Disposition': disp,
      })
      res.end(buf)
      return
    }

    if (p === '/api/history' && req.method === 'GET') return json(res, 200, await reconcileHistory(loadHistory()))
    if (p === '/api/history' && req.method === 'POST') {
      addHistory(await readBody(req))
      return json(res, 200, { ok: true })
    }
    if (p === '/api/history/delete' && req.method === 'POST') {
      const body = await readBody(req)
      const genId = body.generationId
      if (!genId) return json(res, 400, { error: 'missing generationId' })
      const hist = loadHistory()
      const filtered = hist.filter(h => h.generationId !== genId)
      writeHistory(filtered)
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'not found' })
  } catch (e) {
    console.error(LOG, 'bridge error:', e.message)
    try { json(res, 500, { error: e.message }) } catch {}
  }
}

// ---------- DSH 工具（保留对话调用能力） ----------
function buildTools(ctx, bridgePort) {
  const tools = []

  tools.push(defineTool({
    name: 'lipsync_list_samples',
    description: '列出 FreeLipSync 的示例人脸/宠物/卡通素材。返回每条素材的 id、title、mediaType、mediaUrl，可直接用于 lipsync_generate 的 faceUrl。',
    parameters: {
      limit: { type: 'integer', description: '最多返回条数，默认 10' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          total: { type: 'integer' },
          samples: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
    async execute({ limit = 10 }) {
      const r = await callAPI('GET', '/api/samples')
      const samples = (r.json?.samples || []).slice(0, limit)
      return { total: r.json?.total ?? samples.length, samples }
    },
  }))

  tools.push(defineTool({
    name: 'lipsync_list_voices',
    description: '列出 FreeLipSync 的预设声音（3000+，覆盖 500+ 语言）。可按 language（如 zh-CN）和 query（名称关键词）筛选。返回每条声音的 id（用于 lipsync_generate 的 voiceId）、name、language、description。',
    parameters: {
      language: { type: 'string', description: '按语言过滤，如 zh-CN、en、ja' },
      query: { type: 'string', description: '按声音名称关键词过滤' },
      limit: { type: 'integer', description: '最多返回条数，默认 30' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          total: { type: 'integer' },
          voices: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
    async execute({ language = 'zh-CN', query, limit = 30 }) {
      let p = `/api/catalog/voices?all=1&locale=${encodeURIComponent(language)}`
      if (query) p += `&q=${encodeURIComponent(query)}`
      const r = await callAPI('GET', p)
      let voices = Array.isArray(r.json) ? r.json : (r.json?.items || [])
      if (query) voices = voices.filter(v => (v.name || '').toLowerCase().includes(query.toLowerCase()))
      return { total: voices.length, voices: voices.slice(0, limit) }
    },
  }))

  tools.push(defineTool({
    name: 'lipsync_generate',
    description: '提交一个 FreeLipSync 对口型口播视频生成任务。提供人脸图片/视频 URL（faceUrl）和文本（text），或音频 URL（audioUrl）。返回 generationId，用于 lipsync_status 轮询。免费层最长 20 秒。',
    parameters: {
      faceUrl: { type: 'string', description: '人脸图片或视频 URL' },
      text: { type: 'string', description: '人物要说的文本台词' },
      audioUrl: { type: 'string', description: '人物要朗读的音频 URL（与 text 二选一）' },
      voiceId: { type: 'string', description: '预设声音 ID，省略使用默认中文声音' },
      model: { type: 'string', enum: ['fast', 'max', 'music'], description: '生成模型：fast（说话）、max（高清自然）、music（唱歌）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          generationId: { type: 'string' },
          status: { type: 'string' },
          error: { type: 'string' },
        },
      },
    },
    async execute({ faceUrl, text, audioUrl, voiceId, model = 'fast' }) {
      const payload = {
        inputType: 'image',
        mode: audioUrl ? 'audio' : 'text',
        workType: 'single_speaker',
        faceUrl,
        sourceWidth: 1024,
        sourceHeight: 1024,
        requestedTier: 'free',
        generationModel: model,
        surface: 'dsh-plugin',
        locale: 'zh-CN',
        sessionId: 'dsh-' + Date.now(),
      }
      if (audioUrl) payload.audioUrl = audioUrl
      else { payload.text = text; if (voiceId) payload.presetVoiceId = voiceId }
      const r = await callAPI('POST', '/api/generate', payload)
      if (!r.json?.generationId) return { error: r.text?.slice(0, 200) }
      return { generationId: r.json.generationId, status: r.json.status || 'submitted' }
    },
  }))

  tools.push(defineTool({
    name: 'lipsync_status',
    description: '轮询一次 FreeLipSync 生成任务状态。返回 status（processing/generating_video/completed/failed）、progress、以及 completed 时的 videoUrl。建议每 5-6 秒轮询。',
    parameters: {
      generationId: { type: 'string', description: 'lipsync_generate 返回的 generationId' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          generationId: { type: 'string' },
          status: { type: 'string' },
          progress: { type: 'number' },
          videoUrl: { type: 'string' },
          error: { type: 'string' },
        },
      },
    },
    async execute({ generationId }) {
      const r = await callAPI('POST', `/api/status/batch?poll=1`, { ids: [generationId] })
      const gen = r.json?.generations?.[0] || {}
      return { generationId, status: gen.status || 'unknown', progress: gen.progress ?? gen.generationProgress?.estimatedProgress ?? 0, videoUrl: gen.videoUrl, lowResolutionVideoUrl: gen.lowResolutionVideoUrl, error: gen.error }
    },
  }))

  tools.push(defineTool({
    name: 'lipsync_download',
    description: '从 FreeLipSync 成片 URL 下载视频到本地文件。返回本地路径和大小。',
    parameters: {
      url: { type: 'string', description: 'lipsync_status 返回的 videoUrl' },
      outputPath: { type: 'string', description: '保存路径，省略则存到 DSH 工作区' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          size: { type: 'number' },
          error: { type: 'string' },
        },
      },
    },
    async execute({ url, outputPath }) {
      if (!url) return { error: 'missing url' }
      const resp = await fetch(url)
      if (!resp.ok) return { error: `HTTP ${resp.status}` }
      const buf = Buffer.from(await resp.arrayBuffer())
      const ws = process.env.DSH_WORKSPACE || process.cwd()
      const out = outputPath || join(ws, 'lipsync-download.mp4')
      // 防止路径遍历：确保最终路径在工作区内
      if (!resolve(out).startsWith(resolve(ws))) return { error: 'path traversal detected' }
      try { writeFileSync(out, buf) } catch (e) { return { error: e.message } }
      return { path: out, size: buf.length }
    },
  }))

  return tools
}

// ---------- apply ----------
export function apply(ctx, config = {}) {
  const bridgePort = Number(config?.bridgePort) || 8790
  initStateDir(config?.stateDir || null)

  // 工具注册由宿主/旧插件 dsh-tool-lipsync 提供（本插件专注面板 + bridge），
  // 避免与旧插件注册同名 lipsync_* 工具造成重复注册冲突而拖垮 harness 启动。
  // 面板的生成/上传/状态等操作通过下方 bridge 的 /api/* HTTP 端点完成，不依赖本插件注册的工具。

  // 开启本地 bridge
  let server = null
  const startBridge = () => {
    server = createServer(bridgeHandler)
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.warn(LOG, `bridge 端口 ${bridgePort} 被占用，跳过（面板可能已有 host）`)
      } else {
        console.error(LOG, 'bridge error:', e.message)
      }
    })
    server.listen(bridgePort, '127.0.0.1', () => {
      console.log(LOG, `FreeLipSync 面板 bridge 已启动: http://127.0.0.1:${bridgePort}`)
    })
  }
  startBridge()

  // 卸载时清理
  ctx.on('dispose', () => {
    if (server) { try { server.close() } catch {} }
  })

  return ctx
}

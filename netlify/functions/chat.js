const https = require('https')
const crypto = require('crypto')

// ── ENV CONFIG ──
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qspbuutauihcuvsxjmcs.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzcGJ1dXRhdWloY3V2c3hqbWNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5NDIyMDIsImV4cCI6MjA5MTUxODIwMn0.bzzkm4LV4_1PAU0PC9am2F-zXVGTlL6WYcyTEl-jWFg'
const SESSION_SECRET = process.env.SESSION_SECRET || 'amigo-ley-dev-secret-change-in-production'
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'
const GOOGLE_CLIENT_ID = '987326208252-vdejm5hhn0bkf9c38cluue4jnpj65coh.apps.googleusercontent.com'

const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
}

const LIMITS = {
  free: { chats: 3, documents: 0 },
  premium: { chats: 30, documents: 5 }
}

const MAX_MESSAGES = 20
const MAX_MESSAGE_LEN = 5000
const MAX_BODY_BYTES = 8 * 1024 * 1024

// ── SYSTEM PROMPTS (server-side only — never exposed to client) ──
const SYSTEM_PROMPT = `INSTRUCCIÓN CRÍTICA: Responde SIEMPRE en español colombiano. NUNCA respondas en inglés. Tu nombre es "Amigo Ley" — NUNCA lo traduzcas.

Eres Amigo Ley, asesor jurídico colombiano. Hablas como un abogado cercano, claro y empático. Usas lenguaje cotidiano colombiano.

FORMATO DE RESPUESTA OBLIGATORIO — devuelve SIEMPRE un JSON válido con esta estructura exacta (todo en español):
{
  "summary": "Frase corta en español (máx 2 líneas) que explica la situación en lenguaje cotidiano colombiano",
  "keyEmoji": "Un emoji relevante",
  "keyPoint": "La acción MÁS importante que debe hacer el usuario (1 línea en español, usa **negritas** para lo clave)",
  "detail": "**Qué dice la ley:**\\n[explicación en español]\\n\\n**Pasos a seguir:**\\n1. [paso en español]\\n2. [paso en español]\\n3. [paso en español]\\n\\n**Ante quién reclamar:**\\n[entidad en español]\\n\\n**Plazo:**\\n[plazo en español]\\n\\n⚠️ Orientación jurídica informativa. No reemplaza la consulta con un abogado habilitado.",
  "temasRelacionados": ["Tema relacionado 1 en español", "Tema relacionado 2 en español", "Tema relacionado 3 en español"]
}

REGLAS ESTRICTAS:
- TODO debe estar en español colombiano. Si escribes en inglés, estás fallando.
- summary: máximo 2 líneas, sin tecnicismos, como le explicarías a un amigo
- keyPoint: la acción más urgente e importante
- detail: técnico, con artículos y leyes colombianas exactas, en español
- temasRelacionados: 3 temas jurídicos relacionados que el usuario probablemente quiera conocer (cortos, máx 5 palabras cada uno)
- NUNCA inventes leyes o artículos colombianos
- Responde SOLO el JSON, sin texto antes ni después, sin markdown code blocks
- Para saludos o preguntas sin contenido jurídico: summary amigable en español, detail vacío "", temasRelacionados con temas útiles generales

CONOCIMIENTO JURÍDICO COLOMBIA 2026: Constitución 1991, Código Civil, Código Penal (Ley 599/2000), Código de Tránsito (Ley 769/2002 + 1843/2017), CST Laboral, Ley 1751/2015 (Salud Arts. 1-26), Ley 1480/2011 (Consumidor), Ley 142/1994 (Servicios públicos), Ley 820/2003 (Arriendo), Ley 1437/2011 (CPACA), Ley 1755/2015 (Peticiones), Ley 1266/2008 y 1581/2012 (Habeas Data), Ley 1801/2016 (Policía), Ley 361/1997 y 1010/2006 (Laboral especial), Ley 2121/2021 (Teletrabajo), Ley 472/1998 (Acciones populares), Decreto 410/1971 (Comercio).`

const WIZARD_SYSTEM_PROMPT = `Eres un abogado colombiano experto en redacción de documentos legales. Redactas documentos formales, correctos y listos para usar según la legislación colombiana vigente 2026. Responde SIEMPRE en español. Genera el documento completo sin cortar.`

// ── SESSION TOKENS (HMAC-SHA256, 30 días) ──
function createSessionToken(userId) {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000
  const payload = `${userId}:${exp}`
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex')
  return Buffer.from(payload).toString('base64url') + '.' + sig
}

function verifySessionToken(token) {
  try {
    const dot = token.indexOf('.')
    if (dot < 1) return null
    const payloadB64 = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const payload = Buffer.from(payloadB64, 'base64url').toString()
    const parts = payload.split(':')
    if (parts.length !== 2) return null
    const [userId, exp] = parts
    if (!userId || !exp || Date.now() > parseInt(exp, 10)) return null
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex')
    const sigBuf = Buffer.from(sig, 'hex')
    const expBuf = Buffer.from(expected, 'hex')
    if (sigBuf.length !== expBuf.length) return null
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null
    return { userId: parseInt(userId, 10) }
  } catch { return null }
}

// ── GOOGLE TOKEN VERIFICATION ──
function parseJwtLocal(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(Buffer.from(b64, 'base64').toString())
  } catch { return null }
}

async function verifyGoogleCredential(credential) {
  const local = parseJwtLocal(credential)
  if (!local || Date.now() / 1000 > (local.exp || 0)) {
    throw new Error('Token expirado')
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: `/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      method: 'GET'
    }, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try {
          const p = JSON.parse(data)
          if (p.error || p.error_description) return reject(new Error('Token inválido'))
          if (p.aud !== GOOGLE_CLIENT_ID) return reject(new Error('Audience no coincide'))
          resolve(p)
        } catch { reject(new Error('Error de verificación')) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// ── INPUT VALIDATION ──
function validateMessages(msgs) {
  if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > MAX_MESSAGES * 2) return false
  return msgs.every(m => {
    if (!m || typeof m !== 'object') return false
    if (m.role !== 'user' && m.role !== 'assistant') return false
    if (typeof m.content === 'string') return m.content.length <= MAX_MESSAGE_LEN
    return Array.isArray(m.content)
  })
}

function validateGoogleId(id) {
  return typeof id === 'string' && /^\d{10,25}$/.test(id)
}

// ── SUPABASE ──
async function supabaseReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + path)
    const payload = body ? JSON.stringify(body) : null
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        Prefer: method === 'POST' ? 'return=representation' : ''
      }
    }
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload)
    const req = https.request(opts, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve(data) } })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function getOrCreateUser(googleId, email, name, avatar) {
  const existing = await supabaseReq('GET',
    `/rest/v1/users?google_id=eq.${encodeURIComponent(googleId)}&select=*`)
  if (existing && existing.length > 0) return existing[0]
  const created = await supabaseReq('POST', '/rest/v1/users', {
    google_id: googleId, email, name, avatar, plan: 'free'
  })
  return Array.isArray(created) ? created[0] : created
}

async function getUserById(id) {
  const rows = await supabaseReq('GET', `/rest/v1/users?id=eq.${id}&select=*`)
  return rows && rows.length > 0 ? rows[0] : null
}

async function getOrCreateUsage(userId) {
  const today = new Date().toISOString().split('T')[0]
  const existing = await supabaseReq('GET',
    `/rest/v1/daily_usage?user_id=eq.${userId}&date=eq.${today}&select=*`)
  if (existing && existing.length > 0) return existing[0]
  const created = await supabaseReq('POST', '/rest/v1/daily_usage', {
    user_id: userId, date: today, chats: 0, documents: 0
  })
  return Array.isArray(created) ? created[0] : { chats: 0, documents: 0, user_id: userId, date: today }
}

async function incrementUsage(userId, field) {
  const today = new Date().toISOString().split('T')[0]
  const usage = await getOrCreateUsage(userId)
  await supabaseReq('PATCH',
    `/rest/v1/daily_usage?user_id=eq.${userId}&date=eq.${today}`,
    { [field]: (usage[field] || 0) + 1 }
  )
  return { ...usage, [field]: (usage[field] || 0) + 1 }
}

// ── CLAUDE ──
async function callClaude(systemPrompt, messages, maxTokens) {
  const safeMsgs = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-MAX_MESSAGES)
    .map(m => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content.slice(0, MAX_MESSAGE_LEN) }
      }
      if (Array.isArray(m.content)) {
        return {
          role: m.role,
          content: m.content.map(c =>
            c.type === 'text' ? { ...c, text: c.text.slice(0, MAX_MESSAGE_LEN) } : c
          )
        }
      }
      return m
    })

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens || 1400,
      system: systemPrompt,
      messages: safeMsgs
    })
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }
    const req = https.request(opts, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error('Parse error')) } })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ── HANDLER ──
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' }
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' }
  }
  if (event.body && event.body.length > MAX_BODY_BYTES) {
    return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: 'payload_too_large' }) }
  }

  let body
  try { body = JSON.parse(event.body) } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) }
  }

  // Ignore any client-provided system prompt — always use server-side prompts
  const { messages, user, isDocument, isWizard, googleCredential, sessionToken } = body

  // ── AUTHENTICATION: session token → Google credential → legacy fallback ──
  let dbUser = null
  let newSessionToken = null

  if (sessionToken && typeof sessionToken === 'string') {
    const session = verifySessionToken(sessionToken)
    if (session) {
      try { dbUser = await getUserById(session.userId) } catch (e) {
        console.error('DB lookup:', e.message)
      }
    }
  }

  if (!dbUser && googleCredential && typeof googleCredential === 'string' && googleCredential.length < 4096) {
    try {
      const gp = await verifyGoogleCredential(googleCredential)
      dbUser = await getOrCreateUser(gp.sub, gp.email, gp.name, gp.picture)
      newSessionToken = createSessionToken(dbUser.id)
    } catch (e) {
      console.error('Google auth:', e.message)
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ error: 'auth_failed', message: 'Sesión inválida. Por favor inicia sesión nuevamente.' })
      }
    }
  }

  // Backward-compat: accept legacy user object while clients migrate
  if (!dbUser && user && validateGoogleId(user.googleId)) {
    try {
      dbUser = await getOrCreateUser(user.googleId, user.email, user.name, user.avatar)
    } catch (e) {
      console.error('Legacy auth:', e.message)
    }
  }

  if (!dbUser) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ error: 'no_user', message: 'Inicia sesión para usar Amigo Ley' })
    }
  }

  // ── VALIDATE MESSAGES ──
  if (!validateMessages(messages)) {
    return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'invalid_request', message: 'Solicitud inválida' })
    }
  }

  const plan = dbUser.plan || 'free'
  const limits = LIMITS[plan] || LIMITS.free
  const respHeaders = newSessionToken
    ? { ...CORS, 'X-Session-Token': newSessionToken }
    : { ...CORS }

  try {
    // ── WIZARD ──
    if (isWizard === true) {
      const usage = await getOrCreateUsage(dbUser.id)
      if ((usage.chats || 0) >= limits.chats) {
        return {
          statusCode: 200, headers: respHeaders,
          body: JSON.stringify({
            error: 'limit_reached',
            message: `Llegaste a tus ${limits.chats} consultas de hoy 🔒\n\nActualiza al plan Premium por $20.000/mes para:\n• 30 consultas diarias\n• Crear documentos sin límites`,
            plan, upgrade: plan === 'free'
          })
        }
      }
      const response = await callClaude(WIZARD_SYSTEM_PROMPT, messages, 2500)
      if (response.error) throw new Error('API error')
      const newUsage = await incrementUsage(dbUser.id, 'chats')
      return {
        statusCode: 200, headers: respHeaders,
        body: JSON.stringify({ ...response, plan, usage: newUsage, limits })
      }
    }

    // ── DOCUMENT UPLOAD (premium only) ──
    if (isDocument === true) {
      if (plan === 'free') {
        return {
          statusCode: 200, headers: respHeaders,
          body: JSON.stringify({
            error: 'upgrade_required',
            message: '🔒 La subida de documentos es exclusiva del plan Premium 👑\n\nActualiza por solo $20.000 COP/mes y obtén:\n• 30 consultas diarias\n• 5 documentos por día\n• Análisis de contratos y multas',
            plan
          })
        }
      }
      const usage = await getOrCreateUsage(dbUser.id)
      if ((usage.documents || 0) >= limits.documents) {
        return {
          statusCode: 200, headers: respHeaders,
          body: JSON.stringify({
            error: 'limit_reached',
            message: `Usaste tus ${limits.documents} análisis de documentos de hoy 📋\nTu límite se renueva a medianoche.`,
            plan, upgrade: false
          })
        }
      }
      const response = await callClaude(SYSTEM_PROMPT, messages, 1600)
      if (response.error) throw new Error('API error')
      const newUsage = await incrementUsage(dbUser.id, 'documents')
      return {
        statusCode: 200, headers: respHeaders,
        body: JSON.stringify({ ...response, plan, usage: newUsage, limits })
      }
    }

    // ── REGULAR CHAT ──
    const usage = await getOrCreateUsage(dbUser.id)
    if ((usage.chats || 0) >= limits.chats) {
      return {
        statusCode: 200, headers: respHeaders,
        body: JSON.stringify({
          error: 'limit_reached',
          message: `Llegaste a tus ${limits.chats} consultas gratuitas de hoy 🔒\n\nActualiza al plan Premium por $20.000/mes:\n• 30 consultas diarias\n• 5 documentos por día\n• Crear documentos legales`,
          plan, upgrade: plan === 'free'
        })
      }
    }

    const response = await callClaude(SYSTEM_PROMPT, messages, 1400)
    if (response.error) throw new Error('API error')
    const newUsage = await incrementUsage(dbUser.id, 'chats')
    return {
      statusCode: 200, headers: respHeaders,
      body: JSON.stringify({ ...response, plan, usage: newUsage, limits })
    }

  } catch (err) {
    console.error('Handler error:', err.message)
    return {
      statusCode: 500, headers: respHeaders,
      body: JSON.stringify({ error: 'server_error', message: 'Ocurrió un error. Intenta de nuevo.' })
    }
  }
}

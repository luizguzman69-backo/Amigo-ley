const https = require('https')
 
const SUPABASE_URL = 'https://qspbuutauihcuvsxjmcs.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzcGJ1dXRhdWloY3V2c3hqbWNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5NDIyMDIsImV4cCI6MjA5MTUxODIwMn0.bzzkm4LV4_1PAU0PC9am2F-zXVGTlL6WYcyTEl-jWFg'
 
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
 
const LIMITS = {
  free: { chats: 3, documents: 0 },
  premium: { chats: 30, documents: 5 }
}
 
async function supabaseReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + path)
    const payload = body ? JSON.stringify(body) : null
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': method === 'POST' ? 'return=representation' : ''
      }
    }
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload)
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve(data) }
      })
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
 
async function callClaude(system, messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens || 1400,
      system,
      messages
    })
    const options = {
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
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error('Parse error')) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}
 
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' }
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' }
  }
 
  try {
    const body = JSON.parse(event.body)
    const { system, messages, user, isDocument, isWizard } = body
 
    // ── NO USER: reject ──
    if (!user || !user.googleId) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ error: 'no_user', message: 'Inicia sesión para usar Amigo Ley' })
      }
    }
 
    // ── GET/CREATE USER ──
    let dbUser
    try {
      dbUser = await getOrCreateUser(user.googleId, user.email, user.name, user.avatar)
    } catch(e) {
      // Supabase error — still allow the call but without limits
      console.error('Supabase error:', e)
      const response = await callClaude(system, messages, isWizard ? 2000 : 1400)
      return { statusCode: 200, headers: CORS, body: JSON.stringify(response) }
    }
 
    const plan = dbUser.plan || 'free'
    const limits = LIMITS[plan] || LIMITS.free
 
    // ── WIZARD (doc generation): count as 1 chat, allow for free users too ──
    if (isWizard) {
      const usage = await getOrCreateUsage(dbUser.id)
      if ((usage.chats || 0) >= limits.chats) {
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            error: 'limit_reached',
            message: `Llegaste a tus ${limits.chats} consultas de hoy 🔒\n\nActualiza al plan Premium por $20.000/mes para:\n• 30 consultas diarias\n• Crear documentos sin límites`,
            plan, upgrade: plan === 'free'
          })
        }
      }
      // Call Claude with more tokens for document generation
      const response = await callClaude(system, messages, 2500)
      if (response.error) throw new Error(response.error.message || 'API error')
      const newUsage = await incrementUsage(dbUser.id, 'chats')
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ ...response, plan, usage: newUsage, limits })
      }
    }
 
    // ── DOCUMENT UPLOAD (premium only) ──
    if (isDocument) {
      if (plan === 'free') {
        return {
          statusCode: 200, headers: CORS,
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
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            error: 'limit_reached',
            message: `Usaste tus ${limits.documents} análisis de documentos de hoy 📋\nTu límite se renueva a medianoche.`,
            plan, upgrade: false
          })
        }
      }
      const response = await callClaude(system, messages, 1600)
      if (response.error) throw new Error(response.error.message || 'API error')
      const newUsage = await incrementUsage(dbUser.id, 'documents')
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ ...response, plan, usage: newUsage, limits })
      }
    }
 
    // ── REGULAR CHAT ──
    const usage = await getOrCreateUsage(dbUser.id)
    if ((usage.chats || 0) >= limits.chats) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          error: 'limit_reached',
          message: `Llegaste a tus ${limits.chats} consultas gratuitas de hoy 🔒\n\nActualiza al plan Premium por $20.000/mes:\n• 30 consultas diarias\n• 5 documentos por día\n• Crear documentos legales`,
          plan, upgrade: plan === 'free'
        })
      }
    }
 
    const response = await callClaude(system, messages, 1400)
    if (response.error) throw new Error(response.error.message || 'API error')
    const newUsage = await incrementUsage(dbUser.id, 'chats')
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ...response, plan, usage: newUsage, limits })
    }
 
  } catch (err) {
    console.error('Handler error:', err)
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: err.message })
    }
  }
}
 

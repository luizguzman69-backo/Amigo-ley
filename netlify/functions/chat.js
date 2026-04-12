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

async function supabase(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + path)
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
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { resolve(data) }
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function getOrCreateUser(googleId, email, name, avatar) {
  // Buscar usuario existente
  const existing = await supabase('GET',
    `/rest/v1/users?google_id=eq.${googleId}&select=*`)
  if (existing && existing.length > 0) return existing[0]

  // Crear nuevo usuario
  const created = await supabase('POST', '/rest/v1/users', {
    google_id: googleId, email, name, avatar, plan: 'free'
  })
  return Array.isArray(created) ? created[0] : created
}

async function getUsage(userId) {
  const today = new Date().toISOString().split('T')[0]
  const existing = await supabase('GET',
    `/rest/v1/daily_usage?user_id=eq.${userId}&date=eq.${today}&select=*`)
  if (existing && existing.length > 0) return existing[0]

  // Crear registro de hoy
  const created = await supabase('POST', '/rest/v1/daily_usage', {
    user_id: userId, date: today, chats: 0, documents: 0
  })
  return Array.isArray(created) ? created[0] : { chats: 0, documents: 0 }
}

async function incrementUsage(userId, field) {
  const today = new Date().toISOString().split('T')[0]
  const usage = await getUsage(userId)
  await supabase('PATCH',
    `/rest/v1/daily_usage?user_id=eq.${userId}&date=eq.${today}`,
    { [field]: (usage[field] || 0) + 1 }
  )
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
    const { system, messages, user, isDocument } = body

    // Si no hay usuario, responder sin límites (para pruebas)
    if (!user || !user.googleId) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ error: 'no_user', message: 'Inicia sesión para usar Amigo Ley' })
      }
    }

    // Obtener o crear usuario en BD
    const dbUser = await getOrCreateUser(
      user.googleId, user.email, user.name, user.avatar
    )

    // Verificar plan y límites
    const plan = dbUser.plan || 'free'
    const limits = LIMITS[plan] || LIMITS.free
    const usage = await getUsage(dbUser.id)
    const field = isDocument ? 'documents' : 'chats'

    // Verificar límite de documentos en plan free
    if (isDocument && plan === 'free') {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          error: 'upgrade_required',
          message: 'La subida de documentos es exclusiva del plan Premium 👑\n\nActualiza por solo $20.000 COP/mes y obtén:\n• 30 consultas diarias\n• 5 documentos por día\n• Análisis completo de contratos y multas',
          plan
        })
      }
    }

    // Verificar límite diario
    if ((usage[field] || 0) >= limits[field]) {
      const isPremium = plan === 'premium'
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          error: 'limit_reached',
          message: isPremium
            ? `Has usado tus ${limits[field]} ${isDocument ? 'documentos' : 'consultas'} de hoy 📋\n\nTu límite se renueva a medianoche. ¡Vuelve mañana!`
            : `Has usado tus ${limits.chats} consultas gratuitas de hoy 🔒\n\nActualiza al plan Premium por solo $20.000 COP/mes y obtén:\n• 30 consultas diarias\n• 5 documentos por día\n• Análisis de contratos y fotomultas`,
          plan,
          upgrade: !isPremium
        })
      }
    }

    // Llamar a Claude
    const response = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1400,
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
          try { resolve(JSON.parse(data)) }
          catch { reject(new Error('Parse error')) }
        })
      })
      req.on('error', reject)
      req.write(payload)
      req.end()
    })

    // Incrementar uso
    await incrementUsage(dbUser.id, field)

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ...response, plan, usage: { ...usage, [field]: (usage[field] || 0) + 1 }, limits })
    }

  } catch (err) {
    console.error('Error:', err)
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: err.message })
    }
  }
}

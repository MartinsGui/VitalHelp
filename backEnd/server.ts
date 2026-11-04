import 'dotenv/config'
import { randomBytes, randomInt } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import { rateLimit } from 'express-rate-limit'
import { OAuth2Client } from 'google-auth-library'
import argon2 from 'argon2'
import {
  closeDatabase,
  createUser,
  decryptProfile,
  deleteUser,
  getAccountSessionUser,
  getPublicUser,
  getPublicSessionUser,
  getUserByEmail,
  getUserByGoogleSub,
  getUserById,
  linkGoogleAccount,
  MedicalProfileDecryptionError,
  normalizeEmail,
  initializeDatabase,
  revokeAccountSession,
  revokePublicSession,
  saveAccountSession,
  savePublicSession,
  saveMedicalProfile,
  setConsultationPassword,
} from './repositories/database.js'
import { profileIsComplete } from './services/medical-profile.js'

const port = Number(process.env.PORT ?? 3000)
const googleClientId = process.env.GOOGLE_CLIENT_ID
const sessionSecret = process.env.SESSION_SECRET
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? 'http://127.0.0.1:5173'
const isProduction = process.env.NODE_ENV === 'production'
const publicFrontendOrigin = process.env.PUBLIC_FRONTEND_URL
  ? new URL(process.env.PUBLIC_FRONTEND_URL).origin
  : getLanFrontendOrigin() ?? frontendOrigin
const sessionCookieName = 'vitalhelp_session'
const publicSessionCookieName = 'vitalhelp_public_session'
const sessionDurationSeconds = 60 * 60 * 2
const googleClient = googleClientId ? new OAuth2Client(googleClientId) : null
const app = express()
const frontendBuildPath = join(process.cwd(), 'frontEnd/dist')
const allowedFrontendOrigins = new Set([frontendOrigin, publicFrontendOrigin])
const configuredFrontendUrl = new URL(frontendOrigin)
if (configuredFrontendUrl.hostname === '127.0.0.1') {
  configuredFrontendUrl.hostname = 'localhost'
  allowedFrontendOrigins.add(configuredFrontendUrl.origin)
} else if (configuredFrontendUrl.hostname === 'localhost') {
  configuredFrontendUrl.hostname = '127.0.0.1'
  allowedFrontendOrigins.add(configuredFrontendUrl.origin)
}

function getLanFrontendOrigin() {
  const addresses = Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((network) => network.family === 'IPv4' && !network.internal)
    .map((network) => network.address)
    .filter((address) => (
      address.startsWith('192.168.')
      || address.startsWith('10.')
      || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    ))
  addresses.sort((first, second) => {
    const rank = (address: string) => address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2
    return rank(first) - rank(second)
  })
  return addresses[0] ? `http://${addresses[0]}:5173` : null
}

function isDuplicateEntryError(error: unknown) {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ER_DUP_ENTRY'
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT precisa ser um número entre 1 e 65535.')
}
if (!['http:', 'https:'].includes(new URL(publicFrontendOrigin).protocol)) {
  throw new Error('PUBLIC_FRONTEND_URL precisa usar HTTP ou HTTPS.')
}
if (!googleClientId) {
  throw new Error('Configure GOOGLE_CLIENT_ID no arquivo .env.')
}
if (!sessionSecret || Buffer.byteLength(sessionSecret) < 32) {
  throw new Error('SESSION_SECRET precisa ter pelo menos 32 caracteres no arquivo .env.')
}
if (!googleClient) {
  throw new Error('A configuração de autenticação está incompleta.')
}
app.disable('x-powered-by')
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.setHeader('X-Frame-Options', 'DENY')
  const origin = request.get('origin')
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    && (!origin || !allowedFrontendOrigins.has(origin))
  ) {
    response.status(403).json({ error: 'Origem da solicitação não autorizada.' })
    return
  }
  next()
})
app.use(express.json({ limit: '32kb' }))

const signInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
})
const publicUnlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_request, response) => {
    response.status(429).json({
      error: 'Muitas tentativas de consulta. Aguarde alguns minutos antes de tentar novamente.',
    })
  },
})

function setSessionCookie(response: Response, token: string) {
  response.cookie(sessionCookieName, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: sessionDurationSeconds * 1000,
    path: '/',
  })
}

function clearSessionCookie(response: Response) {
  response.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  })
}

function setPublicSessionCookie(response: Response, token: string) {
  response.cookie(publicSessionCookieName, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: sessionDurationSeconds * 1000,
    path: '/',
  })
}

function clearPublicSessionCookie(response: Response) {
  response.clearCookie(publicSessionCookieName, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  })
}

function getCookieToken(request: Request, cookieName: string) {
  const cookies = request.headers.cookie?.split(';') ?? []
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=')
    if (separator < 0 || cookie.slice(0, separator).trim() !== cookieName) continue
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

function getSessionToken(request: Request) {
  return getCookieToken(request, sessionCookieName)
}

async function getSessionUser(request: Request): Promise<{ id: string; email: string; name: string } | null> {
  const token = getSessionToken(request)
  return token ? getAccountSessionUser(token) : null
}

async function requireSession(request: Request, response: Response, next: NextFunction) {
  try {
    const user = await getSessionUser(request)
    if (!user) {
      clearSessionCookie(response)
      response.status(401).json({ error: 'Entre na sua conta para continuar.' })
      return
    }
    request.user = user
    next()
  } catch (error) {
    next(error)
  }
}

async function startSession(
  response: Response,
  user: { id: string; email: string; name: string },
) {
  const expiresAt = new Date(Date.now() + sessionDurationSeconds * 1000)
  const token = randomBytes(32).toString('base64url')
  await saveAccountSession(user.id, token, expiresAt)
  setSessionCookie(response, token)
  response.setHeader('Cache-Control', 'no-store')
  response.json({ user: { id: user.id, email: user.email, name: user.name } })
}

function setProfileStatus(response: Response, user: {
  id: string
  email: string
  name: string
  medical_profile: string | null
  consultation_password_hash: string | null
}) {
  const { profile, readable } = readUserProfile(user)
  const isComplete = profileIsComplete(profile)
  response.setHeader('Cache-Control', 'no-store')
  response.json({
    user: { id: user.id, email: user.email, name: user.name },
    profile,
    profileReadable: readable,
    profileComplete: isComplete,
    hasConsultationPassword: Boolean(user.consultation_password_hash),
    canViewQr: isComplete && Boolean(user.consultation_password_hash),
  })
}

function readUserProfile(user: { medical_profile: string | null } | null) {
  try {
    return { profile: normalizeProfile(decryptProfile(user?.medical_profile ?? null)), readable: true }
  } catch (error) {
    if (error instanceof MedicalProfileDecryptionError) {
      return { profile: null, readable: false }
    }
    throw error
  }
}

const clinicalFields = ['allergies', 'medications', 'conditions', 'surgeries']

function normalizeProfile(profile: Record<string, any> | null) {
  if (!profile) return null
  for (const field of clinicalFields) {
    const value = profile[field]
    if (field === 'medications') {
      profile[field] = Array.isArray(value)
        ? value.filter((item) => (
          (typeof item === 'string' && item.trim())
          || (item && typeof item.name === 'string' && item.name.trim())
        )).map((item) => (
          typeof item === 'string'
            ? item.trim()
            : {
              name: item.name.trim(),
              dose: typeof item.dose === 'string' ? item.dose.trim() : '',
              frequency: typeof item.frequency === 'string' ? item.frequency.trim() : '',
            }
        ))
        : typeof value === 'string' && value.trim()
          ? [value.trim()]
          : []
      continue
    }
    profile[field] = Array.isArray(value)
      ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : typeof value === 'string' && value.trim()
        ? [value.trim()]
        : []
  }
  return profile
}

function cleanProfile(body: Record<string, any>) {
  const textFields = [
    'name',
    'surname',
    'dateOfBirth',
    'sex',
    'bloodType',
    'emergencyContactName',
    'emergencyContactPhone',
    'emergencyContactRelationship',
  ]
  const profile: Record<string, any> = {}
  const fieldErrors: Record<string, string> = {}
  const optionalClinicalFields: string[] = ['conditions', 'surgeries']
  const fieldLabels: Record<string, string> = {
    name: 'Nome',
    surname: 'Sobrenome',
    dateOfBirth: 'Data de nascimento',
    sex: 'Sexo',
    bloodType: 'Tipo sanguíneo',
    emergencyContactName: 'Nome do contato de emergência',
    emergencyContactPhone: 'Telefone do contato de emergência',
    emergencyContactRelationship: 'Parentesco do contato de emergência',
  }
  const fieldMaxLengths: Record<string, number> = {
    name: 80,
    surname: 80,
    dateOfBirth: 10,
    sex: 30,
    bloodType: 10,
    emergencyContactName: 160,
    emergencyContactPhone: 40,
    emergencyContactRelationship: 50,
  }
  const addError = (field: string, message: string) => {
    fieldErrors[field] = message
  }

  for (const field of textFields) {
    const value = body[field]
    if (value !== undefined && typeof value !== 'string') {
      addError(field, `${fieldLabels[field]}: valor inválido.`)
      profile[field] = ''
      continue
    }
    profile[field] = (value ?? '').trim()
    if (profile[field].length > fieldMaxLengths[field]) {
      addError(field, `${fieldLabels[field]}: o texto é muito longo.`)
    }
  }
  for (const field of ['name', 'surname', 'sex', 'bloodType']) {
    if (!profile[field]) addError(field, `${fieldLabels[field]}: preencha este campo.`)
  }
  const contactFields = [
    'emergencyContactName',
    'emergencyContactPhone',
    'emergencyContactRelationship',
  ]
  if (contactFields.some((field) => profile[field])) {
    for (const field of contactFields) {
      if (!profile[field]) addError(field, `${fieldLabels[field]}: preencha este campo.`)
    }
  }
  if (!isValidBirthDate(profile.dateOfBirth)) {
    addError('dateOfBirth', 'Data de nascimento: informe uma data válida que não seja futura.')
  }
  for (const field of clinicalFields) {
    const value = body[field]
    if (value === undefined) {
      if (optionalClinicalFields.includes(field)) {
        profile[field] = ['Nenhuma']
        continue
      }
      addError(field, `${clinicalFieldLabel(field)}: informe ao menos um item ou “Nenhuma”.`)
      profile[field] = []
      continue
    }
    if (typeof value === 'string') {
      const trimmedValue = value.trim()
      if (!trimmedValue && !optionalClinicalFields.includes(field)) {
        addError(field, `${clinicalFieldLabel(field)}: informe ao menos um item ou “Nenhuma”.`)
      }
      profile[field] = [trimmedValue || 'Nenhuma']
      continue
    }
    if (!Array.isArray(value)) {
      addError(field, `${clinicalFieldLabel(field)}: formato inválido.`)
      profile[field] = []
      continue
    }
    if (value.length > 20) {
      addError(field, `${clinicalFieldLabel(field)}: o limite é 20 itens.`)
      profile[field] = []
      continue
    }
    if (field === 'medications') {
      profile[field] = []
      for (const [index, item] of value.entries()) {
        const label = `Medicamento ${index + 1}`
        if (typeof item === 'string') {
          if (item.length > 300) {
            addError(`medications.${index}.name`, `${label}: o nome é muito longo.`)
            continue
          }
          const name = item.trim()
          if (name) profile[field].push(name)
          continue
        }
        if (!item || typeof item.name !== 'string' || item.name.length > 300) {
          addError(`medications.${index}.name`, `${label}: informe um nome válido.`)
          continue
        }
        if (typeof item.dose !== 'string' || item.dose.length > 100) {
          addError(`medications.${index}.dose`, `${label}: informe uma dose válida (até 100 caracteres).`)
          continue
        }
        if (typeof item.frequency !== 'string' || item.frequency.length > 120) {
          addError(`medications.${index}.frequency`, `${label}: informe uma frequência válida (até 120 caracteres).`)
          continue
        }
        const name = item.name.trim()
        const dose = item.dose.trim()
        const frequency = item.frequency.trim()
        if (!name) continue
        const isNone = name.toLowerCase() === 'nenhuma'
        if (!isNone && !dose) {
          addError(`medications.${index}.dose`, `${label}: informe a dose (por exemplo, 50 mg).`)
        }
        if (!isNone && !frequency) {
          addError(`medications.${index}.frequency`, `${label}: informe a frequência.`)
        }
        profile[field].push({ name, dose: isNone ? '' : dose, frequency: isNone ? '' : frequency })
      }
    } else {
      profile[field] = []
      for (const [index, item] of value.entries()) {
        if (typeof item !== 'string') {
          addError(`${field}.${index}`, `${clinicalFieldLabel(field)} ${index + 1}: valor inválido.`)
        } else if (item.length > 300) {
          addError(`${field}.${index}`, `${clinicalFieldLabel(field)} ${index + 1}: o texto é muito longo.`)
        } else if (item.trim()) {
          profile[field].push(item.trim())
        }
      }
    }
    if (profile[field].length === 0) {
      if (optionalClinicalFields.includes(field)) {
        profile[field] = ['Nenhuma']
      } else if (!fieldErrors[field]) {
        addError(field, `${clinicalFieldLabel(field)}: informe ao menos um item ou “Nenhuma”.`)
      }
    }
  }
  return { profile, fieldErrors }
}

function clinicalFieldLabel(field: string) {
  return {
    allergies: 'Alergias',
    medications: 'Medicamentos em uso',
    conditions: 'Doenças / condições',
    surgeries: 'Cirurgias',
  }[field]
}

function isValidBirthDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf())
    && date.toISOString().slice(0, 10) === value
    && value <= new Date().toISOString().slice(0, 10)
}

app.get('/api/config', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.json({ googleClientId })
})

app.post('/api/auth/signup', signInLimiter, async (request, response, next) => {
  try {
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
    const email = typeof request.body?.email === 'string' ? normalizeEmail(request.body.email) : ''
    const password = request.body?.password
    if (
      name.length < 2
      || name.length > 120
      || email.length > 254
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      response.status(400).json({ error: 'Informe um nome e um e-mail válidos.' })
      return
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      response.status(400).json({ error: 'A senha deve ter entre 8 e 128 caracteres.' })
      return
    }
    if (await getUserByEmail(email)) {
      response.status(409).json({ error: 'Este e-mail já possui uma conta. Faça login.' })
      return
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    const user = await createUser({ email, name, passwordHash })
    await startSession(response, user)
  } catch (error) {
    if (isDuplicateEntryError(error)) {
      response.status(409).json({ error: 'Este e-mail já possui uma conta. Faça login.' })
      return
    }
    next(error)
  }
})

app.post('/api/auth/login', signInLimiter, async (request, response, next) => {
  try {
    const email = typeof request.body?.email === 'string' ? normalizeEmail(request.body.email) : ''
    const password = request.body?.password
    const user = await getUserByEmail(email)
    if (
      !user
      || !user.password_hash
      || typeof password !== 'string'
      || !(await argon2.verify(user.password_hash, password))
    ) {
      response.status(401).json({ error: 'E-mail ou senha incorretos.' })
      return
    }
    await startSession(response, user)
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/google', signInLimiter, async (request, response, next) => {
  const { credential } = request.body ?? {}
  if (typeof credential !== 'string' || credential.length > 10_000) {
    response.status(400).json({ error: 'Credencial do Google inválida.' })
    return
  }

  let payload
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: googleClientId,
    })
    payload = ticket.getPayload()
  } catch {
    console.warn('O Google recusou uma credencial de login.')
    response.status(401).json({ error: 'Não foi possível validar sua conta Google.' })
    return
  }
  if (!payload?.sub || !payload.email || payload.email_verified !== true) {
    response.status(401).json({ error: 'A conta Google não possui um e-mail verificado.' })
    return
  }

  try {
    const email = normalizeEmail(payload.email)
    let user = await getUserByGoogleSub(payload.sub)
    if (!user) {
      const emailUser = await getUserByEmail(email)
      if (emailUser) {
        user = emailUser.google_sub
          ? null
          : await linkGoogleAccount({ id: emailUser.id, googleSub: payload.sub, name: payload.name ?? '' })
        if (!user) {
          response.status(409).json({ error: 'Esta conta Google já está vinculada a outro usuário.' })
          return
        }
      } else {
        user = await createUser({
          email,
          name: payload.name ?? '',
          googleSub: payload.sub,
        })
      }
    }
    await startSession(response, user)
  } catch (error) {
    if (isDuplicateEntryError(error)) {
      response.status(409).json({ error: 'Esta conta Google já está vinculada a outro usuário.' })
      return
    }
    next(error)
  }
})

app.get('/api/me', requireSession, async (request, response, next) => {
  try {
    const user = await getUserById(request.user.id)
    if (!user) {
      clearSessionCookie(response)
      response.status(401).json({ error: 'Entre na sua conta para continuar.' })
      return
    }
    setProfileStatus(response, user)
  } catch (error) {
    next(error)
  }
})

app.get('/api/profile', requireSession, async (request, response, next) => {
  try {
    const user = await getUserById(request.user.id)
    if (!user) {
      clearSessionCookie(response)
      response.status(401).json({ error: 'Entre na sua conta para continuar.' })
      return
    }
    const { profile, readable } = readUserProfile(user)
    response.setHeader('Cache-Control', 'no-store')
    response.json({ profile, profileReadable: readable })
  } catch (error) {
    next(error)
  }
})

app.put('/api/profile', requireSession, async (request, response, next) => {
  try {
    const { profile, fieldErrors } = cleanProfile(request.body ?? {})
    if (Object.keys(fieldErrors).length > 0) {
      response.status(400).json({
        error: 'Confira os campos destacados e tente novamente.',
        fieldErrors,
      })
      return
    }
    const user = await getUserById(request.user.id)
    if (!user) {
      clearSessionCookie(response)
      response.status(401).json({ error: 'Entre na sua conta para continuar.' })
      return
    }
    const { readable } = readUserProfile(user)
    if (!readable && request.body?.replaceUnreadableProfile !== true) {
      response.status(409).json({
        error: 'O perfil existente não pode ser lido. Restaure o SESSION_SECRET original ou confirme a substituição do perfil.',
      })
      return
    }
    await saveMedicalProfile(request.user.id, profile)
    const updatedUser = await getUserById(request.user.id)
    if (!updatedUser) throw new Error('A conta não foi encontrada após salvar o perfil.')
    setProfileStatus(response, updatedUser)
  } catch (error) {
    next(error)
  }
})

app.delete('/api/account', requireSession, async (request, response, next) => {
  try {
    await deleteUser(request.user.id)
    clearSessionCookie(response)
    response.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.post('/api/consultation-password/generate', requireSession, async (request, response, next) => {
  try {
    const user = await getUserById(request.user.id)
    if (!user) {
      clearSessionCookie(response)
      response.status(401).json({ error: 'Entre na sua conta para continuar.' })
      return
    }
    const { profile, readable } = readUserProfile(user)
    if (!readable) {
      response.status(409).json({
        error: 'O perfil não pode ser descriptografado. Restaure o SESSION_SECRET usado quando foi salvo ou substitua o perfil.',
      })
      return
    }
    if (!profileIsComplete(profile)) {
      response.status(409).json({ error: 'Salve um perfil médico completo antes de gerar o código de consulta.' })
      return
    }
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    const password = Array.from({ length: 16 }, () => alphabet[randomInt(alphabet.length)]).join('')
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    await setConsultationPassword(request.user.id, passwordHash)
    response.setHeader('Cache-Control', 'no-store')
    response.json({ hasConsultationPassword: true, consultationPassword: password })
  } catch (error) {
    next(error)
  }
})

app.get('/api/qr', requireSession, async (request, response, next) => {
  try {
    const user = await getUserById(request.user.id)
    if (!user) {
      clearSessionCookie(response)
      response.status(401).json({ error: 'Entre na sua conta para continuar.' })
      return
    }
    const { profile, readable } = readUserProfile(user)
    if (!readable) {
      response.status(409).json({
        error: 'O perfil não pode ser descriptografado. Restaure o SESSION_SECRET usado quando foi salvo ou substitua o perfil.',
      })
      return
    }
    if (!profileIsComplete(profile) || !user.consultation_password_hash) {
      response.status(403).json({
        error: 'Complete seu perfil médico e configure a senha de consulta para liberar o QR Code.',
      })
      return
    }
    if (!user.public_id) {
      response.status(500).json({ error: 'Não foi possível gerar o identificador do QR Code.' })
      return
    }
    response.setHeader('Cache-Control', 'no-store')
    response.json({ url: `${publicFrontendOrigin}/consulta/${user.public_id}` })
  } catch (error) {
    next(error)
  }
})

app.post('/api/public/:publicId/unlock', publicUnlockLimiter, async (request, response, next) => {
  try {
    const password = request.body?.password
    if (typeof password !== 'string' || password.length > 128) {
      response.status(400).json({ error: 'Informe a senha de consulta.' })
      return
    }
    const publicId = request.params.publicId
    if (typeof publicId !== 'string') {
      response.status(400).json({ error: 'Identificador de consulta inválido.' })
      return
    }
    const user = await getPublicUser(publicId)
    if (
      !user
      || !user.consultation_password_hash
      || !(await argon2.verify(user.consultation_password_hash, password))
    ) {
      response.status(401).json({ error: 'Senha de consulta incorreta.' })
      return
    }
    const { profile, readable } = readUserProfile(user)
    if (!readable) {
      response.status(409).json({ error: 'O perfil médico do titular está inacessível no momento.' })
      return
    }
    if (!profileIsComplete(profile)) {
      response.status(409).json({ error: 'O perfil médico do titular não está completo.' })
      return
    }
    if (!user.profile_id || user.public_access_version === null) {
      throw new Error('O perfil médico não possui os dados necessários para abrir uma sessão pública.')
    }
    const expiresAt = new Date(Date.now() + sessionDurationSeconds * 1000)
    const token = randomBytes(32).toString('base64url')
    await savePublicSession(user.profile_id, user.public_access_version, token, expiresAt)
    setPublicSessionCookie(response, token)
    response.setHeader('Cache-Control', 'no-store')
    response.json({ profile })
  } catch (error) {
    next(error)
  }
})

app.post('/api/logout', async (request, response, next) => {
  try {
    const token = getSessionToken(request)
    if (token) await revokeAccountSession(token)
  } catch (error) {
    next(error)
    return
  }
  clearSessionCookie(response)
  response.status(204).end()
})

app.post('/api/public/logout', async (request, response, next) => {
  try {
    const token = getCookieToken(request, publicSessionCookieName)
    if (token) await revokePublicSession(token)
  } catch (error) {
    next(error)
    return
  }
  clearPublicSessionCookie(response)
  response.status(204).end()
})

app.get('/api/public/:publicId/profile', async (request, response, next) => {
  try {
    const publicId = request.params.publicId
    const token = getCookieToken(request, publicSessionCookieName)
    if (typeof publicId !== 'string' || !token) {
      clearPublicSessionCookie(response)
      response.status(401).json({ error: 'Informe a senha de consulta para continuar.' })
      return
    }

    const user = await getPublicSessionUser(publicId, token)
    if (!user) {
      clearPublicSessionCookie(response)
      response.status(401).json({ error: 'A sessão de consulta expirou. Informe a senha novamente.' })
      return
    }
    const { profile, readable } = readUserProfile(user)
    if (!readable || !profile || !profileIsComplete(profile)) {
      clearPublicSessionCookie(response)
      await revokePublicSession(token)
      response.status(409).json({ error: 'O perfil médico do titular está inacessível no momento.' })
      return
    }
    response.setHeader('Cache-Control', 'no-store')
    response.json({ profile })
  } catch (error) {
    next(error)
  }
})

app.use('/api', (_request, response) => {
  response.status(404).json({
    error: 'Rota da API não encontrada. Reinicie o servidor da API e tente novamente.',
  })
})

app.use(express.static(frontendBuildPath))
app.get('/{*path}', (_request, response, next) => {
  response.sendFile(join(frontendBuildPath, 'index.html'), (error) => {
    if (error) next(error)
  })
})

const apiErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error('Erro inesperado na API:', error)
  response.status(500).json({ error: 'Ocorreu um erro interno.' })
}
app.use(apiErrorHandler)

await initializeDatabase()

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`API VitalHelp disponível em http://127.0.0.1:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(async (error) => {
      if (error) {
        console.error('Erro ao encerrar o servidor HTTP:', error)
        process.exitCode = 1
      }
      try {
        await closeDatabase()
      } catch (databaseError) {
        console.error('Erro ao encerrar a conexão com o MySQL:', databaseError)
        process.exitCode = 1
      }
    })
  })
}

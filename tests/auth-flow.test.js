import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import test from 'node:test'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

async function getAvailablePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitForApi(baseUrl, child, getLogs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`API encerrou ao iniciar: ${getLogs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/config`)
      if (response.ok) return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`API não iniciou a tempo: ${getLogs()}`)
}

test('cadastro, perfil médico, senha de consulta e liberação de QR', async (context) => {
  const testDatabase = `vitalhelp_test_${randomUUID().replaceAll('-', '')}`
  const testUser = process.env.MYSQL_TEST_USER ?? 'root'
  const testPassword = process.env.MYSQL_TEST_PASSWORD ?? process.env.MYSQL_ROOT_PASSWORD
  if (!testPassword) {
    throw new Error('Configure MYSQL_TEST_PASSWORD ou MYSQL_ROOT_PASSWORD para executar os testes.')
  }
  const mysqlConfig = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: testUser,
    password: testPassword,
  }
  if (!['127.0.0.1', 'localhost'].includes(mysqlConfig.host)) {
    throw new Error('Os testes de integração só podem usar um MySQL local para não alterar bancos remotos.')
  }
  const admin = await mysql.createConnection(mysqlConfig)
  await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [testDatabase])
  const port = await getAvailablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [join(projectRoot, 'dist/backEnd/server.js')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MYSQL_HOST: mysqlConfig.host,
      MYSQL_PORT: String(mysqlConfig.port),
      MYSQL_DATABASE: testDatabase,
      MYSQL_USER: mysqlConfig.user,
      MYSQL_PASSWORD: mysqlConfig.password,
      FRONTEND_ORIGIN: baseUrl,
      PUBLIC_FRONTEND_URL: 'http://192.168.1.25:5173',
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      SESSION_SECRET: 'test-session-secret-that-is-at-least-32-bytes',
      PORT: String(port),
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let logs = ''
  child.stdout.setEncoding('utf8').on('data', (data) => { logs += data })
  child.stderr.setEncoding('utf8').on('data', (data) => { logs += data })
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await admin.query('DROP DATABASE ??', [testDatabase])
    await admin.end()
  })

  await waitForApi(baseUrl, child, () => logs)

  async function send(path, { method = 'GET', body, cookie, origin = baseUrl } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const result = response.status === 204 ? null : await response.json()
    return { response, result, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }

  const missingRoute = await send('/api/route-that-does-not-exist')
  assert.equal(missingRoute.response.status, 404)
  assert.equal(missingRoute.result.error, 'Rota da API não encontrada. Reinicie o servidor da API e tente novamente.')

  const signup = await send('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Marina Oliveira', email: 'MARINA@example.com', password: 'account-pass-123' },
  })
  assert.equal(signup.response.status, 200, JSON.stringify(signup.result))
  assert.ok(signup.cookie)
  assert.match(signup.cookie, /^vitalhelp_session=[A-Za-z0-9_-]{43}$/)
  let status = await send('/api/me', { cookie: signup.cookie })
  assert.equal(status.response.status, 200)
  assert.equal(status.result.profileComplete, false)
  assert.equal(status.result.canViewQr, false)
  const prematureCode = await send('/api/consultation-password/generate', {
    method: 'POST',
    cookie: signup.cookie,
  })
  assert.equal(prematureCode.response.status, 409)

  const foreignOrigin = await fetch(`${baseUrl}/api/profile`, {
    method: 'PUT',
    headers: {
      Origin: 'http://attacker.example',
      Cookie: signup.cookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })
  assert.equal(foreignOrigin.status, 403)

  const localhostOrigin = await send('/api/profile', {
    method: 'PUT',
    body: {},
    origin: `http://localhost:${port}`,
    cookie: signup.cookie,
  })
  assert.equal(localhostOrigin.response.status, 400)
  assert.equal(localhostOrigin.result.error, 'Confira os campos destacados e tente novamente.')
  assert.ok(localhostOrigin.result.fieldErrors.dateOfBirth)

  let qr = await send('/api/qr', { cookie: signup.cookie })
  assert.equal(qr.response.status, 403)

  const profile = {
    name: 'Marina',
    surname: 'Oliveira',
    dateOfBirth: '1990-05-12',
    sex: 'Feminino',
    bloodType: 'O+',
    allergies: ['Alergia de teste confidencial', 'Outra alergia de teste'],
    medications: [
      { name: 'Medicamento de teste', dose: '50 mg', frequency: '1 vez ao dia' },
      { name: 'Segundo medicamento', dose: '10 mg', frequency: 'A cada 8 horas' },
    ],
    conditions: ['Nenhuma'],
    surgeries: ['Nenhuma'],
    emergencyContactName: 'Paulo Oliveira',
    emergencyContactPhone: '(11) 99999-0000',
    emergencyContactRelationship: 'Irmão',
  }
  const savedProfile = await send('/api/profile', {
    method: 'PUT',
    cookie: signup.cookie,
    body: profile,
  })
  assert.equal(savedProfile.response.status, 200, JSON.stringify(savedProfile.result))
  assert.equal(savedProfile.result.profileComplete, true)
  assert.equal(savedProfile.result.canViewQr, false)
  assert.deepEqual(savedProfile.result.profile.medications, profile.medications)
  assert.equal((await send('/api/qr', { cookie: signup.cookie })).response.status, 403)

  const legacyMedicationProfile = await send('/api/profile', {
    method: 'PUT',
    cookie: signup.cookie,
    body: { ...profile, medications: ['Medicamento antigo sem dose'] },
  })
  assert.equal(legacyMedicationProfile.response.status, 200)
  assert.equal(legacyMedicationProfile.result.profileComplete, false)
  assert.equal((await send('/api/qr', { cookie: signup.cookie })).response.status, 403)
  const restoredMedicationProfile = await send('/api/profile', {
    method: 'PUT',
    cookie: signup.cookie,
    body: profile,
  })
  assert.equal(restoredMedicationProfile.result.profileComplete, true)

  const missingMedicationDose = await send('/api/profile', {
    method: 'PUT',
    cookie: signup.cookie,
    body: { ...profile, medications: [{ name: 'Medicamento sem dose', dose: '', frequency: '' }] },
  })
  assert.equal(missingMedicationDose.response.status, 400)
  assert.equal(missingMedicationDose.result.fieldErrors['medications.0.dose'], 'Medicamento 1: informe a dose (por exemplo, 50 mg).')
  assert.equal(missingMedicationDose.result.fieldErrors['medications.0.frequency'], 'Medicamento 1: informe a frequência.')
  const invalidBirthDate = await send('/api/profile', {
    method: 'PUT',
    cookie: signup.cookie,
    body: { ...profile, dateOfBirth: '2099-12-31' },
  })
  assert.equal(invalidBirthDate.response.status, 400)
  assert.equal(invalidBirthDate.result.fieldErrors.dateOfBirth, 'Data de nascimento: informe uma data válida que não seja futura.')

  const missingAllergies = await send('/api/profile', {
    method: 'PUT',
    cookie: signup.cookie,
    body: { ...profile, allergies: [] },
  })
  assert.equal(missingAllergies.response.status, 400)
  assert.ok(missingAllergies.result.fieldErrors.allergies)

  const testConnection = await mysql.createConnection({
    ...mysqlConfig,
    database: testDatabase,
  })
  await testConnection.execute('UPDATE users SET medical_profile = ?', ['not-valid-ciphertext'])
  await testConnection.end()
  status = await send('/api/me', { cookie: signup.cookie })
  assert.equal(status.response.status, 200)
  assert.equal(status.result.profileReadable, false)
  assert.equal(status.result.profileComplete, false)
  const unreadableProfile = await send('/api/profile', { cookie: signup.cookie })
  assert.equal(unreadableProfile.response.status, 200)
  assert.equal(unreadableProfile.result.profileReadable, false)
  assert.equal(unreadableProfile.result.profile, null)
  const unconfirmedReplacement = await send('/api/profile', {
    method: 'PUT',
    cookie: signup.cookie,
    body: profile,
  })
  assert.equal(unconfirmedReplacement.response.status, 409)

  const confirmedReplacement = await send('/api/profile', {
    method: 'PUT',
    cookie: signup.cookie,
    body: { ...profile, replaceUnreadableProfile: true },
  })
  assert.equal(confirmedReplacement.response.status, 200)
  assert.equal(confirmedReplacement.result.profileReadable, true)
  assert.equal(confirmedReplacement.result.profileComplete, true)

  const blankOptionalClinicalFields = await send('/api/profile', {
    method: 'PUT',
    cookie: signup.cookie,
    body: {
      ...profile,
      conditions: [],
      surgeries: ['  '],
    },
  })
  assert.equal(blankOptionalClinicalFields.response.status, 200, JSON.stringify(blankOptionalClinicalFields.result))
  assert.deepEqual(blankOptionalClinicalFields.result.profile.conditions, ['Nenhuma'])
  assert.deepEqual(blankOptionalClinicalFields.result.profile.surgeries, ['Nenhuma'])
  assert.equal((await send('/api/me', { cookie: signup.cookie })).result.profileComplete, true)

  const missingRequiredClinicalFields = await send('/api/profile', {
    method: 'PUT',
    cookie: signup.cookie,
    body: { ...profile, allergies: [] },
  })
  assert.equal(missingRequiredClinicalFields.response.status, 400)
  assert.deepEqual((await send('/api/profile', { cookie: signup.cookie })).result.profile.conditions, ['Nenhuma'])

  const savedPassword = await send('/api/consultation-password/generate', {
    method: 'POST',
    cookie: signup.cookie,
  })
  assert.equal(savedPassword.response.status, 200)
  const consultationPassword = savedPassword.result.consultationPassword
  assert.match(consultationPassword, /^[A-Za-z0-9]{16}$/)
  status = await send('/api/me', { cookie: signup.cookie })
  assert.equal(status.result.canViewQr, true)

  qr = await send('/api/qr', { cookie: signup.cookie })
  assert.equal(qr.response.status, 200)
  assert.match(qr.result.url, /^http:\/\/192\.168\.1\.25:5173\/consulta\//)
  const publicId = new URL(qr.result.url).pathname.split('/').at(-1)
  assert.match(publicId, /^[A-Za-z0-9_-]+$/)

  const wrongPassword = await send(`/api/public/${publicId}/unlock`, {
    method: 'POST',
    body: { password: 'wrong-password' },
  })
  assert.equal(wrongPassword.response.status, 401)
  assert.equal((await send(`/api/public/${publicId}/profile`)).response.status, 401)

  const publicProfile = await send(`/api/public/${publicId}/unlock`, {
    method: 'POST',
    body: { password: consultationPassword },
    origin: 'http://192.168.1.25:5173',
  })
  assert.equal(publicProfile.response.status, 200)
  assert.match(publicProfile.cookie, /^vitalhelp_public_session=[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(publicProfile.result.profile.allergies, profile.allergies)
  assert.deepEqual(publicProfile.result.profile.conditions, profile.conditions)
  assert.deepEqual(publicProfile.result.profile.medications, profile.medications)
  assert.deepEqual(publicProfile.result.profile.surgeries, ['Nenhuma'])
  const resumedPublicProfile = await send(`/api/public/${publicId}/profile`, {
    cookie: publicProfile.cookie,
  })
  assert.equal(resumedPublicProfile.response.status, 200)
  assert.deepEqual(resumedPublicProfile.result.profile.allergies, profile.allergies)
  const publicEditAttempt = await fetch(`${baseUrl}/api/public/${publicId}/unlock`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conditions: ['Alteração não autorizada'] }),
  })
  assert.equal(publicEditAttempt.status, 404)

  const secondCode = await send('/api/consultation-password/generate', {
    method: 'POST',
    cookie: signup.cookie,
  })
  assert.equal(secondCode.response.status, 200)
  assert.notEqual(secondCode.result.consultationPassword, consultationPassword)
  const oldCode = await send(`/api/public/${publicId}/unlock`, {
    method: 'POST',
    body: { password: consultationPassword },
  })
  assert.equal(oldCode.response.status, 401)
  assert.equal((await send(`/api/public/${publicId}/profile`, {
    cookie: publicProfile.cookie,
  })).response.status, 401)

  const deletedProfile = await send('/api/account', {
    method: 'DELETE',
    cookie: signup.cookie,
  })
  assert.equal(deletedProfile.response.status, 204)
  assert.match(deletedProfile.response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/)
  assert.equal((await send('/api/me')).response.status, 401)
  assert.equal((await send('/api/qr', { cookie: signup.cookie })).response.status, 401)
  assert.equal((await send(`/api/public/${publicId}/profile`, {
    cookie: publicProfile.cookie,
  })).response.status, 401)
  assert.equal((await send(`/api/public/${publicId}/unlock`, {
    method: 'POST',
    body: { password: secondCode.result.consultationPassword },
  })).response.status, 401)

  let rateLimitedResponse
  for (let attempt = 0; attempt < 2; attempt += 1) {
    rateLimitedResponse = await send(`/api/public/${publicId}/unlock`, {
      method: 'POST',
      body: { password: 'invalid-code' },
    })
  }
  assert.equal(rateLimitedResponse.response.status, 429)
  assert.equal(rateLimitedResponse.result.error, 'Muitas tentativas de consulta. Aguarde alguns minutos antes de tentar novamente.')

  const login = await send('/api/auth/login', {
    method: 'POST',
    body: { email: 'marina@example.com', password: 'account-pass-123' },
  })
  assert.equal(login.response.status, 401)

  const remainingConnection = await mysql.createConnection({
    ...mysqlConfig,
    database: testDatabase,
  })
  const [remainingRows] = await remainingConnection.execute('SELECT COUNT(*) AS count FROM users')
  await remainingConnection.end()
  assert.equal(Number(remainingRows[0].count), 0)
})

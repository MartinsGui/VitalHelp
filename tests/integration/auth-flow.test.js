import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import mysql from 'mysql2/promise'
import test from 'node:test'
import { createMysqlTestServer, sendApiRequest } from './helpers/mysql-test-server.js'

test('cadastro, perfil médico, senha de consulta e liberação de QR', async (context) => {
  const { baseUrl, mysqlConfig, testDatabase } = await createMysqlTestServer(context)
  const send = (path, options) => sendApiRequest(baseUrl, path, options)

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
  assert.match(signup.response.headers.get('set-cookie'), /HttpOnly/i)
  assert.match(signup.response.headers.get('set-cookie'), /SameSite=Lax/i)
  const duplicateSignup = await send('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Another Account', email: 'marina@example.com', password: 'account-pass-123' },
  })
  assert.equal(duplicateSignup.response.status, 409)

  const accountConnection = await mysql.createConnection({
    ...mysqlConfig,
    database: testDatabase,
  })
  const rawSessionToken = signup.cookie.slice(signup.cookie.indexOf('=') + 1)
  const [storedAccount] = await accountConnection.execute(
    'SELECT password_hash FROM users WHERE email = ?',
    ['marina@example.com'],
  )
  const [storedAccountSession] = await accountConnection.execute(`
    SELECT token_hash
    FROM auth_sessions
    WHERE scope = 'account' AND user_id = (
      SELECT id FROM users WHERE email = ?
    )
  `, ['marina@example.com'])
  assert.match(storedAccount[0].password_hash, /^\$argon2id\$/)
  assert.equal(storedAccountSession.length, 1)
  assert.deepEqual(
    Buffer.from(storedAccountSession[0].token_hash),
    createHash('sha256').update(rawSessionToken).digest(),
  )
  await accountConnection.end()
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
  const profileConnection = await mysql.createConnection({
    ...mysqlConfig,
    database: testDatabase,
  })
  const [storedClinicalData] = await profileConnection.execute(
    'SELECT allergies FROM medical_profiles WHERE user_id = ?',
    [signup.result.user.id],
  )
  assert.ok(storedClinicalData[0].allergies)
  assert.equal(storedClinicalData[0].allergies.includes('Alergia de teste confidencial'), false)
  await profileConnection.end()

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
  await testConnection.execute(
    'UPDATE medical_profiles SET allergies = ? WHERE user_id = ?',
    ['not-valid-ciphertext', signup.result.user.id],
  )
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
  const refreshedPublicSession = await send(`/api/public/${publicId}/unlock`, {
    method: 'POST',
    body: { password: secondCode.result.consultationPassword },
  })
  assert.equal(refreshedPublicSession.response.status, 200)
  const publicLogout = await send('/api/public/logout', {
    method: 'POST',
    cookie: refreshedPublicSession.cookie,
  })
  assert.equal(publicLogout.response.status, 204)
  assert.equal((await send(`/api/public/${publicId}/profile`, {
    cookie: refreshedPublicSession.cookie,
  })).response.status, 401)

  const logout = await send('/api/logout', {
    method: 'POST',
    cookie: signup.cookie,
  })
  assert.equal(logout.response.status, 204)
  assert.equal((await send('/api/me', { cookie: signup.cookie })).response.status, 401)
  const restoredAccountSession = await send('/api/auth/login', {
    method: 'POST',
    body: { email: 'marina@example.com', password: 'account-pass-123' },
  })
  assert.equal(restoredAccountSession.response.status, 200)
  signup.cookie = restoredAccountSession.cookie

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

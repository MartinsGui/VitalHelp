import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import argon2 from 'argon2'

process.env.MYSQL_DATABASE = 'vitalhelp_unit_tests'
process.env.MYSQL_PASSWORD = 'unit-test-only'
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64')

const { decryptProfile, encryptProfile, MedicalProfileDecryptionError } = await import(
  '../../dist/backEnd/repositories/database.js'
)

test('criptografa e descriptografa dados clínicos sem alterar a estrutura', () => {
  const profile = {
    allergies: ['Alergia confidencial'],
    medications: [{ name: 'Medicamento', dose: '20 mg', frequency: '1x/dia' }],
  }
  const ciphertext = encryptProfile(profile)

  assert.notEqual(ciphertext, JSON.stringify(profile))
  assert.equal(ciphertext.includes('Alergia confidencial'), false)
  assert.deepEqual(decryptProfile(ciphertext), profile)
})

test('rejeita texto clínico adulterado ou ciphertext inválido', () => {
  const ciphertext = encryptProfile({ allergies: ['Nenhuma'] })
  const bytes = Buffer.from(ciphertext, 'base64')
  bytes[bytes.length - 1] ^= 1

  assert.throws(() => decryptProfile(bytes.toString('base64')), MedicalProfileDecryptionError)
  assert.throws(() => decryptProfile('invalid'), MedicalProfileDecryptionError)
})

test('não cria dados clínicos para perfil inexistente', () => {
  assert.equal(decryptProfile(null), null)
})

test('gera hash Argon2id verificável sem armazenar a senha em texto', async () => {
  const password = 'senha-de-teste-segura'
  const hash = await argon2.hash(password, { type: argon2.argon2id })

  assert.match(hash, /^\$argon2id\$/)
  assert.notEqual(hash, password)
  assert.equal(await argon2.verify(hash, password), true)
  assert.equal(await argon2.verify(hash, 'senha-incorreta'), false)
})

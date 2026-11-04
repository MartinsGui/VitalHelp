import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import mysql from 'mysql2/promise'
import { createMysqlTestServer } from './helpers/mysql-test-server.js'

test('aplica as cinco entidades planejadas, índices únicos e relações com cascata', async (context) => {
  const { admin, testDatabase } = await createMysqlTestServer(context)
  const [tableRows] = await admin.execute(`
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ?
  `, [testDatabase])
  assert.deepEqual(
    tableRows.map((row) => row.TABLE_NAME).sort(),
    [
      'auth_sessions',
      'emergency_contacts',
      'medical_profiles',
      'password_reset_tokens',
      'schema_migrations',
      'users',
    ],
  )

  const [constraints] = await admin.execute(`
    SELECT
      kcu.TABLE_NAME AS table_name,
      kcu.COLUMN_NAME AS column_name,
      kcu.REFERENCED_TABLE_NAME AS referenced_table,
      rc.DELETE_RULE AS delete_rule
    FROM information_schema.KEY_COLUMN_USAGE kcu
    JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
      ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
      AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
    WHERE kcu.CONSTRAINT_SCHEMA = ?
      AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
  `, [testDatabase])
  const foreignKeys = constraints.map((row) => ({
    table: row.table_name,
    column: row.column_name,
    referencedTable: row.referenced_table,
    deleteRule: row.delete_rule,
  }))
  assert.ok(foreignKeys.some((key) => (
    key.table === 'medical_profiles'
    && key.column === 'user_id'
    && key.referencedTable === 'users'
    && key.deleteRule === 'CASCADE'
  )))
  assert.ok(foreignKeys.some((key) => (
    key.table === 'emergency_contacts'
    && key.column === 'medical_profile_id'
    && key.referencedTable === 'medical_profiles'
    && key.deleteRule === 'CASCADE'
  )))
  assert.ok(foreignKeys.some((key) => (
    key.table === 'password_reset_tokens'
    && key.column === 'user_id'
    && key.referencedTable === 'users'
    && key.deleteRule === 'CASCADE'
  )))
  assert.ok(foreignKeys.some((key) => (
    key.table === 'auth_sessions'
    && key.column === 'medical_profile_id'
    && key.referencedTable === 'medical_profiles'
    && key.deleteRule === 'CASCADE'
  )))

  const [uniqueIndexes] = await admin.execute(`
    SELECT TABLE_NAME, COLUMN_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0
  `, [testDatabase])
  assert.ok(uniqueIndexes.some((index) => (
    index.TABLE_NAME === 'medical_profiles' && index.COLUMN_NAME === 'user_id'
  )))
  assert.ok(uniqueIndexes.some((index) => (
    index.TABLE_NAME === 'emergency_contacts' && index.COLUMN_NAME === 'medical_profile_id'
  )))
})

test('mantém a senha e os tokens de sessão somente em formatos não reversíveis', async (context) => {
  const { admin, baseUrl, mysqlConfig, testDatabase } = await createMysqlTestServer(context)
  const response = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Teste de Sessão',
      email: 'session-storage@example.com',
      password: 'strong-account-password',
    }),
  })
  assert.equal(response.status, 200)

  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const rawToken = cookie.slice(cookie.indexOf('=') + 1)
  const connection = await mysql.createConnection({
    ...mysqlConfig,
    database: testDatabase,
  })
  try {
    const [users] = await connection.execute(
      'SELECT password_hash FROM users WHERE email = ?',
      ['session-storage@example.com'],
    )
    assert.match(users[0].password_hash, /^\$argon2id\$/)
    assert.equal(users[0].password_hash.includes('strong-account-password'), false)

    const [sessions] = await connection.execute(
      'SELECT scope, token_hash, expires_at FROM auth_sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)',
      ['session-storage@example.com'],
    )
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].scope, 'account')
    assert.equal(Buffer.from(sessions[0].token_hash).length, 32)
    assert.deepEqual(
      Buffer.from(sessions[0].token_hash),
      createHash('sha256').update(rawToken).digest(),
    )
    assert.ok(new Date(sessions[0].expires_at) > new Date())
  } finally {
    await connection.end()
  }
})

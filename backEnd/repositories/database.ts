import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql, { type RowDataPacket } from 'mysql2/promise'

const databaseName = process.env.MYSQL_DATABASE ?? 'vitalhelp_v2'
if (databaseName.length > 64 || !/^[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error('MYSQL_DATABASE deve ter até 64 caracteres e conter apenas letras, números e sublinhados.')
}

const mysqlPort = Number(process.env.MYSQL_PORT ?? 3306)
if (!Number.isInteger(mysqlPort) || mysqlPort < 1 || mysqlPort > 65535) {
  throw new Error('MYSQL_PORT precisa ser um número entre 1 e 65535.')
}

const mysqlPassword = process.env.MYSQL_PASSWORD
if (!mysqlPassword) {
  throw new Error('Configure MYSQL_PASSWORD no arquivo .env.')
}

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST ?? '127.0.0.1',
  port: mysqlPort,
  user: process.env.MYSQL_USER ?? 'vitalhelp_app',
  password: mysqlPassword,
  database: databaseName,
  charset: 'utf8mb4',
  timezone: 'Z',
  supportBigNumbers: true,
  bigNumberStrings: true,
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})

const encryptionKeyValue = process.env.DATA_ENCRYPTION_KEY
const sessionSecret = process.env.SESSION_SECRET
let encryptionKey: Buffer
if (encryptionKeyValue) {
  encryptionKey = Buffer.from(encryptionKeyValue, 'base64')
  if (encryptionKey.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY deve ser uma chave Base64 válida de 32 bytes.')
  }
} else {
  if (!sessionSecret || Buffer.byteLength(sessionSecret) < 32) {
    throw new Error('Configure um SESSION_SECRET com pelo menos 32 caracteres no arquivo .env.')
  }
  encryptionKey = Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(sessionSecret),
    Buffer.from('vitalhelp-medical-profile'),
    Buffer.from('profile-encryption-v1'),
    32,
  ))
}

export async function initializeDatabase() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(100) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  const lockName = databaseName
  const connection = await pool.getConnection()
  let lockAcquired = false
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>(
      'SELECT GET_LOCK(?, 10) AS acquired',
      [lockName],
    )
    lockAcquired = Number(lockRows[0]?.acquired) === 1
    if (!lockAcquired) {
      throw new Error('Não foi possível obter o bloqueio para aplicar as migrações do banco.')
    }

    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT version FROM schema_migrations WHERE version = ?',
      ['001_initial_schema'],
    )
    if (rows.length) return

    const migration = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '../migrations/001_initial_schema.sql'),
      'utf8',
    )
    for (const statement of migration.split(';').map((part) => part.trim()).filter(Boolean)) {
      await connection.query(statement)
    }
    const [columns] = await connection.execute<RowDataPacket[]>(`
      SELECT COLUMN_TYPE
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'id'
    `, [databaseName])
    if (columns[0]?.COLUMN_TYPE !== 'bigint unsigned') {
      throw new Error('A tabela users existente não corresponde ao modelo VitalHelp.')
    }
    await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', ['001_initial_schema'])
  } catch (error) {
    if (!lockAcquired) throw error
    throw new Error(
      `Não foi possível aplicar o esquema VitalHelp. Use um banco novo e vazio (MYSQL_DATABASE=${databaseName}).`,
      { cause: error },
    )
  } finally {
    try {
      if (lockAcquired) await connection.query('SELECT RELEASE_LOCK(?)', [lockName])
    } finally {
      connection.release()
    }
  }
}

export async function closeDatabase() {
  await pool.end()
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

export function encryptProfile(profile: unknown) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(profile), 'utf8'),
    cipher.final(),
  ])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export class MedicalProfileDecryptionError extends Error {
  constructor(cause?: unknown) {
    super('Não foi possível autenticar os dados criptografados do perfil médico.', { cause })
    this.name = 'MedicalProfileDecryptionError'
  }
}

export function decryptProfile(encryptedProfile: string | null) {
  if (!encryptedProfile) return null
  const data = Buffer.from(encryptedProfile, 'base64')
  if (data.length < 29) throw new MedicalProfileDecryptionError()
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(0, 12))
    decipher.setAuthTag(data.subarray(12, 28))
    return JSON.parse(Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString('utf8')) as Record<string, unknown>
  } catch (error) {
    throw new MedicalProfileDecryptionError(error)
  }
}

interface UserRow extends RowDataPacket {
  id: string
  email: string
  name: string
  password_hash: string | null
  google_sub: string | null
  profile_id: string | null
  first_name: string | null
  last_name: string | null
  date_of_birth: string | null
  sex: string | null
  blood_type: string | null
  allergies: string | null
  medications: string | null
  diseases: string | null
  surgeries: string | null
  consultation_password_hash: string | null
  public_id: string | null
  public_access_version: number | null
  emergency_contact_name: string | null
  emergency_contact_phone: string | null
  emergency_contact_relationship: string | null
}

interface UserRecord extends UserRow {
  medical_profile: string | null
}

const userQuery = `
  SELECT
    u.id, u.email, u.name, u.password_hash, u.google_sub,
    mp.id AS profile_id, mp.first_name, mp.last_name, mp.date_of_birth,
    mp.sex, mp.blood_type, mp.allergies, mp.medications, mp.diseases,
    mp.surgeries, mp.public_password_hash AS consultation_password_hash,
    mp.public_token AS public_id, mp.public_access_version,
    ec.name AS emergency_contact_name, ec.phone AS emergency_contact_phone,
    ec.relationship AS emergency_contact_relationship
  FROM users u
  LEFT JOIN medical_profiles mp ON mp.user_id = u.id
  LEFT JOIN emergency_contacts ec ON ec.medical_profile_id = mp.id
`

function decodeClinicalField(value: string | null) {
  if (!value) return []
  const parsed = decryptProfile(value)
  if (!Array.isArray(parsed)) throw new MedicalProfileDecryptionError()
  return parsed
}

function toUserRecord(row: UserRow | undefined): UserRecord | null {
  if (!row) return null
  const profile = row.profile_id === null ? null : {
    name: row.first_name,
    surname: row.last_name,
    dateOfBirth: row.date_of_birth?.slice(0, 10),
    sex: row.sex,
    bloodType: row.blood_type,
    allergies: decodeClinicalField(row.allergies),
    medications: decodeClinicalField(row.medications),
    conditions: decodeClinicalField(row.diseases),
    surgeries: decodeClinicalField(row.surgeries),
    emergencyContactName: row.emergency_contact_name ?? '',
    emergencyContactPhone: row.emergency_contact_phone ?? '',
    emergencyContactRelationship: row.emergency_contact_relationship ?? '',
  }
  return {
    ...row,
    medical_profile: profile ? encryptProfile(profile) : null,
  }
}

export async function createUser({
  email,
  name,
  passwordHash = null,
  googleSub = null,
}: {
  email: string
  name: string
  passwordHash?: string | null
  googleSub?: string | null
}) {
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    'INSERT INTO users (email, name, password_hash, google_sub) VALUES (?, ?, ?, ?)',
    [email, name, passwordHash, googleSub],
  )
  const user = await getUserById(result.insertId)
  if (!user) throw new Error('A conta não foi encontrada após o cadastro.')
  return user
}

export async function getUserById(id: string | number) {
  const [rows] = await pool.execute<UserRow[]>(`${userQuery} WHERE u.id = ?`, [id])
  return toUserRecord(rows[0])
}

export async function getUserByEmail(email: string) {
  const [rows] = await pool.execute<UserRow[]>(`${userQuery} WHERE u.email = ?`, [email])
  return toUserRecord(rows[0])
}

export async function getUserByGoogleSub(googleSub: string) {
  const [rows] = await pool.execute<UserRow[]>(`${userQuery} WHERE u.google_sub = ?`, [googleSub])
  return toUserRecord(rows[0])
}

export async function linkGoogleAccount({ id, googleSub, name }: {
  id: string | number
  googleSub: string
  name: string
}) {
  await pool.execute(
    "UPDATE users SET google_sub = ?, name = IF(name = '', ?, name) WHERE id = ?",
    [googleSub, name, id],
  )
  return getUserById(id)
}

export async function saveMedicalProfile(userId: string | number, profile: Record<string, any>) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute(`
      INSERT INTO medical_profiles (
        user_id, first_name, last_name, date_of_birth, sex, blood_type,
        allergies, medications, diseases, surgeries
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        first_name = VALUES(first_name),
        last_name = VALUES(last_name),
        date_of_birth = VALUES(date_of_birth),
        sex = VALUES(sex),
        blood_type = VALUES(blood_type),
        allergies = VALUES(allergies),
        medications = VALUES(medications),
        diseases = VALUES(diseases),
        surgeries = VALUES(surgeries),
        public_access_version = public_access_version + 1,
        status = 'active'
    `, [
      userId,
      profile.name,
      profile.surname,
      profile.dateOfBirth,
      profile.sex,
      profile.bloodType,
      encryptProfile(profile.allergies),
      encryptProfile(profile.medications),
      encryptProfile(profile.conditions),
      encryptProfile(profile.surgeries),
    ])

    const [profiles] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM medical_profiles WHERE user_id = ?',
      [userId],
    )
    const medicalProfileId = profiles[0].id
    if (profile.emergencyContactName && profile.emergencyContactPhone) {
      await connection.execute(`
        INSERT INTO emergency_contacts (medical_profile_id, name, phone, relationship)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          phone = VALUES(phone),
          relationship = VALUES(relationship)
      `, [
        medicalProfileId,
        profile.emergencyContactName,
        profile.emergencyContactPhone,
        profile.emergencyContactRelationship,
      ])
    } else {
      await connection.execute('DELETE FROM emergency_contacts WHERE medical_profile_id = ?', [medicalProfileId])
    }
    await connection.execute('UPDATE users SET name = ? WHERE id = ?', [
      `${profile.name} ${profile.surname}`.trim(),
      userId,
    ])
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export async function deleteUser(userId: string | number) {
  await pool.execute('DELETE FROM users WHERE id = ?', [userId])
}

export async function setConsultationPassword(userId: string | number, passwordHash: string) {
  const user = await getUserById(userId)
  if (!user?.profile_id) throw new Error('O perfil médico não existe para esta conta.')
  const publicId = user.public_id ?? randomBytes(32).toString('hex')
  await pool.execute(`
    UPDATE medical_profiles
    SET public_password_hash = ?, public_token = ?, public_access_version = public_access_version + 1
    WHERE user_id = ?
  `, [passwordHash, publicId, userId])
  return publicId
}

export async function getPublicUser(publicId: string) {
  const [rows] = await pool.execute<UserRow[]>(`${userQuery} WHERE mp.public_token = ? AND mp.status = 'active'`, [publicId])
  return toUserRecord(rows[0])
}

function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest()
}

export async function saveAccountSession(userId: string | number, token: string, expiresAt: Date) {
  await pool.execute(`
    INSERT INTO auth_sessions (scope, user_id, token_hash, expires_at)
    VALUES ('account', ?, ?, ?)
  `, [userId, hashSessionToken(token), expiresAt])
}

export async function getAccountSessionUser(token: string) {
  const [rows] = await pool.execute<RowDataPacket[]>(`
    SELECT u.id, u.email, u.name
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.scope = 'account' AND s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP(3)
  `, [hashSessionToken(token)])
  const user = rows[0]
  return user ? { id: String(user.id), email: user.email, name: user.name } : null
}

export async function revokeAccountSession(token: string) {
  await pool.execute(
    "DELETE FROM auth_sessions WHERE scope = 'account' AND token_hash = ?",
    [hashSessionToken(token)],
  )
}

export async function savePublicSession(
  medicalProfileId: string,
  publicAccessVersion: number,
  token: string,
  expiresAt: Date,
) {
  await pool.execute(`
    INSERT INTO auth_sessions (
      scope, medical_profile_id, public_access_version, token_hash, expires_at
    ) VALUES ('public', ?, ?, ?, ?)
  `, [medicalProfileId, publicAccessVersion, hashSessionToken(token), expiresAt])
}

export async function getPublicSessionUser(publicId: string, token: string) {
  const [rows] = await pool.execute<UserRow[]>(`
    SELECT
      u.id, u.email, u.name, u.password_hash, u.google_sub,
      mp.id AS profile_id, mp.first_name, mp.last_name, mp.date_of_birth,
      mp.sex, mp.blood_type, mp.allergies, mp.medications, mp.diseases,
      mp.surgeries, mp.public_password_hash AS consultation_password_hash,
      mp.public_token AS public_id, mp.public_access_version,
      ec.name AS emergency_contact_name, ec.phone AS emergency_contact_phone,
      ec.relationship AS emergency_contact_relationship
    FROM auth_sessions s
    JOIN medical_profiles mp ON mp.id = s.medical_profile_id
    JOIN users u ON u.id = mp.user_id
    LEFT JOIN emergency_contacts ec ON ec.medical_profile_id = mp.id
    WHERE s.scope = 'public'
      AND s.token_hash = ?
      AND s.expires_at > CURRENT_TIMESTAMP(3)
      AND mp.public_token = ?
      AND mp.public_access_version = s.public_access_version
      AND mp.status = 'active'
  `, [hashSessionToken(token), publicId])
  return toUserRecord(rows[0])
}

export async function revokePublicSession(token: string) {
  await pool.execute(
    "DELETE FROM auth_sessions WHERE scope = 'public' AND token_hash = ?",
    [hashSessionToken(token)],
  )
}

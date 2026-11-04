import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const projectRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))

async function getAvailablePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
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

export async function createMysqlTestServer(context) {
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
    throw new Error('Os testes de integração só podem usar um MySQL local.')
  }

  const admin = await mysql.createConnection(mysqlConfig)
  try {
    await admin.query(
      'CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
      [testDatabase],
    )
  } catch (error) {
    await admin.end()
    throw error
  }

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
    try {
      await admin.query('DROP DATABASE ??', [testDatabase])
    } finally {
      await admin.end()
    }
  })

  await waitForApi(baseUrl, child, () => logs)

  return {
    admin,
    baseUrl,
    mysqlConfig,
    testDatabase,
  }
}

export async function sendApiRequest(baseUrl, path, {
  method = 'GET',
  body,
  cookie,
  origin = baseUrl,
} = {}) {
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

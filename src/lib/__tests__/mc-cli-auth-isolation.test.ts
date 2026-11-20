import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function runCli(args: string[], home: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/mc-cli.cjs'), ...args], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        MC_API_KEY: '',
        MC_COOKIE: '',
        MC_URL: '',
      },
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => resolveResult({ code, stderr }))
  })
}

it('does not send credentials left in a legacy CLI profile', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mc-cli-glas-'))
  folders.push(folder)
  let key = ''
  let cookie = ''
  const server = createServer((request, response) => {
    key = String(request.headers['x-api-key'] || '')
    cookie = String(request.headers.cookie || '')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP listener')
    const profiles = join(folder, '.mission-control', 'profiles')
    mkdirSync(profiles, { recursive: true })
    writeFileSync(join(profiles, 'default.json'), JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      apiKey: 'legacy-profile-key',
      cookie: 'legacy-profile-cookie',
    }))
    const result = await runCli(['raw', '--method', 'GET', '--path', '/api/status', '--json'], folder)
    expect(result.code, result.stderr).toBe(0)
    expect(key).toBe('')
    expect(cookie).toBe('')
  } finally {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
  }
}, 10_000)

it('rejects a command-line API key', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mc-cli-glas-'))
  folders.push(folder)
  const result = await runCli(['status', 'health', '--api-key', 'synthetic-key'], folder)
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('GLAS-injected MC_API_KEY')
})

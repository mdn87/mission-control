// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../../..')
const LAUNCHER = join(ROOT, 'scripts/with-glas.py')
const SERVER_EXAMPLE = join(ROOT, 'config/glas.example.json')
const CLI_EXAMPLE = join(ROOT, 'config/glas.cli.example.json')

let dir: string
let stub: string
let out: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-glas-'))
  stub = join(dir, 'fake-glas-python')
  out = join(dir, 'out.json')
  // Stands in for the GLAS interpreter: records what it was asked to run.
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env python3',
      'import json, os, sys',
      'json.dump({"argv": sys.argv[1:], "env": sorted(os.environ)}, open(os.environ["STUB_OUT"], "w"))',
      '',
    ].join('\n'),
  )
  chmodSync(stub, 0o755)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function launch(args: string[], env: Record<string, string>) {
  return spawnSync('python3', [LAUNCHER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '',
      GLAS_PYTHON: stub,
      GLAS_ROOT: join(dir, 'no-glas-checkout'),
      GLAS_HOME: join(dir, 'glas-home'),
      STUB_OUT: out,
      ...env,
    },
  })
}

describe('GLAS launch paths', () => {
  it('runs the docker launcher under the server manifest and drops inherited credentials', () => {
    const result = launch(['--exec', 'node', 'scripts/docker-up.cjs'], {
      GLAS_MANIFEST: SERVER_EXAMPLE,
      AUTH_SECRET: 'inherited',
      API_KEY: 'inherited',
      GITHUB_TOKEN: 'inherited',
      BWS_ACCESS_TOKEN: 'inherited',
    })
    expect(result.status, result.stderr).toBe(0)
    const seen = JSON.parse(readFileSync(out, 'utf8'))
    expect(seen.argv).toEqual([
      '-m', 'glas', 'run', '--manifest', SERVER_EXAMPLE, '--',
      'node', 'scripts/docker-up.cjs',
    ])
    expect(seen.env).toContain('MC_GLAS_MANIFEST')
    for (const name of ['AUTH_SECRET', 'API_KEY', 'GITHUB_TOKEN', 'BWS_ACCESS_TOKEN']) {
      expect(seen.env).not.toContain(name)
    }
  })

  it('refuses to launch without a reference manifest', () => {
    const result = launch(['--exec', 'docker', 'compose', 'up', '-d'], {
      GLAS_MANIFEST: join(dir, 'missing.json'),
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Glas reference manifest is missing')
    expect(() => readFileSync(out)).toThrow()
  })
})

describe('GLAS example manifests', () => {
  const placeholder = /^0{8}-0{4}-0{4}-0{4}-0{11}[0-9]$/

  it('binds the server credentials by reference only', () => {
    const manifest = JSON.parse(readFileSync(SERVER_EXAMPLE, 'utf8'))
    expect(manifest.secrets.map((s: { env: string }) => s.env)).toEqual(['AUTH_SECRET', 'API_KEY'])
    for (const secret of manifest.secrets) expect(secret.secret_id).toMatch(placeholder)
  })

  it('gives the CLI manifest the same API key reference as MC_API_KEY', () => {
    const server = JSON.parse(readFileSync(SERVER_EXAMPLE, 'utf8'))
    const cli = JSON.parse(readFileSync(CLI_EXAMPLE, 'utf8'))
    const apiKey = server.secrets.find((s: { env: string }) => s.env === 'API_KEY')
    expect(cli.secrets).toHaveLength(1)
    expect(cli.secrets[0].env).toBe('MC_API_KEY')
    expect(cli.secrets[0].secret_id).toBe(apiKey.secret_id)
  })
})

describe('docker credential delivery', () => {
  const SECRET = 'value-that-must-stay-out-of-argv'
  const API = 'api-value-that-must-stay-out-of-argv'

  function fakeDocker() {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const log = join(dir, 'docker.log')
    // Records each call's argv, stdin, and whether the credentials were in its env.
    writeFileSync(
      join(bin, 'docker'),
      [
        '#!/usr/bin/env python3',
        'import json, os, sys',
        'args = sys.argv[1:]',
        'stdin = sys.stdin.read() if "-i" in args or "ps" in args else ""',
        'leaked = [n for n in ("AUTH_SECRET", "API_KEY") if n in os.environ]',
        `open(${JSON.stringify(log)}, "a").write(json.dumps({"argv": args, "stdin": stdin, "leaked": leaked}) + "\\n")`,
        'print("c1") if "ps" in args else None',
        '',
      ].join('\n'),
    )
    chmodSync(join(bin, 'docker'), 0o755)
    return { bin, log }
  }

  it('sends values over docker exec stdin only, never argv or the docker environment', () => {
    const { bin, log } = fakeDocker()
    const result = spawnSync('node', [join(ROOT, 'scripts/docker-up.cjs'), '-f', 'docker-compose.yml'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        NODE_ENV: 'test',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        MC_GLAS_MANIFEST: SERVER_EXAMPLE,
        AUTH_SECRET: SECRET,
        API_KEY: API,
      },
    })
    expect(result.status, result.stderr).toBe(0)
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(calls[0].argv).toEqual(['compose', '-f', 'docker-compose.yml', 'up', '-d', '--build', '--force-recreate'])
    const delivered = Object.fromEntries(
      calls.filter(c => c.argv[0] === 'exec' && c.argv[1] === '-i').map(c => [c.argv.at(-1), c.stdin]),
    )
    expect(delivered).toEqual({ AUTH_SECRET: SECRET, API_KEY: API })
    expect(calls.at(-1).argv).toEqual(['exec', 'c1', 'touch', '/tmp/mc-credentials/.ready'])
    for (const call of calls) {
      expect(call.leaked).toEqual([])
      expect(JSON.stringify(call.argv)).not.toContain('must-stay-out')
    }
  })

  it('refuses to start containers without the GLAS credentials', () => {
    const { bin, log } = fakeDocker()
    const result = spawnSync('node', [join(ROOT, 'scripts/docker-up.cjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: `${bin}:${process.env.PATH ?? ''}`, MC_GLAS_MANIFEST: SERVER_EXAMPLE },
    })
    expect(result.status).toBe(1)
    expect(() => readFileSync(log)).toThrow()
  })

  it('lists no credential names in the compose file', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')
    for (const name of ['AUTH_SECRET', 'API_KEY', 'LUGOS_OPERATOR_API_TOKEN', 'GITHUB_TOKEN', 'OPENCLAW_GATEWAY_TOKEN']) {
      expect(compose).not.toMatch(new RegExp(`^\\s+- ${name}(=|$)`, 'm'))
    }
  })
})

describe('docker entrypoint', () => {
  function entrypoint(files: Record<string, string> | null, env: Record<string, string> = {}) {
    const creds = join(dir, 'creds')
    const bin = join(dir, 'ebin')
    mkdirSync(bin)
    // Stands in for `node server.js`: dumps the environment it was started with.
    writeFileSync(join(bin, 'node'), `#!/bin/sh\nenv > ${JSON.stringify(join(dir, 'server.env'))}\n`)
    chmodSync(join(bin, 'node'), 0o755)
    if (files) {
      mkdirSync(creds)
      for (const [name, value] of Object.entries(files)) writeFileSync(join(creds, name), value)
      writeFileSync(join(creds, '.ready'), '')
    }
    const result = spawnSync('sh', [join(ROOT, 'docker-entrypoint.sh')], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: `${bin}:/usr/bin:/bin`, MC_CREDENTIALS_DIR: creds, MC_CREDENTIALS_WAIT: '1', ...env },
    })
    return { result, creds }
  }

  it('loads delivered credentials into the server process and removes the files', () => {
    const { result, creds } = entrypoint({ AUTH_SECRET: 'a-secret\n', API_KEY: 'k', 'bad-name': 'x' })
    expect(result.status, result.stderr).toBe(0)
    const serverEnv = readFileSync(join(dir, 'server.env'), 'utf8')
    expect(serverEnv).toContain('AUTH_SECRET=a-secret\n')
    expect(serverEnv).toMatch(/^API_KEY=k$/m)
    expect(readdirSync(creds)).toEqual(['bad-name'])
  })

  it('exits when nothing is delivered', () => {
    const { result } = entrypoint(null)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('credentials were not delivered')
    expect(() => readFileSync(join(dir, 'server.env'))).toThrow()
  })
})

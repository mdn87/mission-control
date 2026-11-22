// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  it('runs docker compose under the server manifest and drops inherited credentials', () => {
    const result = launch(['--exec', 'docker', 'compose', 'up', '-d', '--build'], {
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
      'docker', 'compose', 'up', '-d', '--build',
    ])
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

describe('docker compose credential wiring', () => {
  it('passes credentials through by name without values', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')
    for (const name of ['AUTH_SECRET', 'API_KEY']) {
      expect(compose).toMatch(new RegExp(`^\\s+- ${name}$`, 'm'))
      expect(compose).not.toMatch(new RegExp(`${name}=`))
    }
  })
})

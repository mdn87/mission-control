#!/usr/bin/env node
// Starts the Compose services and hands GLAS-injected credentials to each
// container over `docker exec` stdin. The values never enter the Compose file,
// a `docker` argument list, or the container configuration that `docker inspect`
// shows. The entry point reads them from its tmpfs and removes the files.
// Run only through GLAS: `pnpm docker:up`. Extra arguments are Compose options
// placed before `up`, for example `-f docker-compose.yml -f docker-compose.hardened.yml`.

const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')

const DIR = '/tmp/mc-credentials'
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function fail(message) {
  console.error(`docker:up: ${message}`)
  process.exit(1)
}

const manifestPath = process.env.MC_GLAS_MANIFEST
if (!manifestPath) fail('run this through the GLAS launcher (pnpm docker:up)')
const names = JSON.parse(readFileSync(manifestPath, 'utf8')).secrets.map(secret => secret.env)
const values = {}
for (const name of names) {
  if (!NAME.test(name)) fail('the manifest maps an invalid environment variable name')
  if (process.env[name] !== undefined) values[name] = process.env[name]
}
if (!values.AUTH_SECRET || !values.API_KEY) fail('GLAS did not supply AUTH_SECRET and API_KEY')

// Docker and Compose never need the values.
const env = { ...process.env }
for (const name of names) delete env[name]

function docker(args, input) {
  const result = spawnSync('docker', args, {
    env,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', input === undefined ? 'inherit' : 'pipe', 'inherit'],
  })
  if (result.status !== 0) fail(`docker ${args[0]} ${args[1] || ''} failed`)
  return result.stdout || ''
}

const compose = ['compose', ...process.argv.slice(2)]
// A fresh container waits in its entry point for this delivery.
docker([...compose, 'up', '-d', '--build', '--force-recreate'])
const ids = docker([...compose, 'ps', '-q'], '').split(/\s+/).filter(Boolean)
if (ids.length === 0) fail('no running containers to receive credentials')

for (const id of ids) {
  for (const [name, value] of Object.entries(values)) {
    docker(['exec', '-i', id, 'sh', '-c', `umask 077 && mkdir -p ${DIR} && cat > ${DIR}/"$1"`, 'sh', name], value)
  }
  docker(['exec', id, 'touch', `${DIR}/.ready`], '')
}
console.log(`docker:up: delivered ${Object.keys(values).length} credential(s) to ${ids.length} container(s)`)

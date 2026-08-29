import {
  createPublicKey,
  verify,
} from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from 'node:https'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import type { TLSSocket } from 'node:tls'
import Database from 'better-sqlite3'
import { ZodError } from 'zod'
import {
  capsuleSigningBytes,
  remoteDecisionCapsuleSchema,
} from '../integrations/lugos/remote-decision-contract'
import { RemoteRelayIssuer } from '../integrations/lugos/relay-issuer'
import {
  RelayQueueError,
  RemoteRelayQueue,
} from '../integrations/lugos/relay-queue'
import { RemoteRelaySigner } from '../integrations/lugos/relay-signer'
import { FileRelayKeyProvider } from './file-key-provider'
import {
  RelayRequestError,
  RemoteRelayApplication,
  type RelayDeviceIdentity,
} from './relay-application'

const MAX_REQUEST_BYTES = 16 * 1024
const DEVICE_CONFIG_SCHEMA = 'lugos.remote-relay-devices/v1'

interface RelayConfig {
  databasePath: string
  internalHost: '127.0.0.1' | '::1'
  internalPort: number
  internalToken: string
  listenHost: string
  listenPort: number
  tlsCertificatePath: string
  tlsPrivateKeyPath: string
  tlsClientCaPath: string
  signingKeyPath: string
  signingKeyId: string
  issuerId: string
  lifetimeSeconds: number
  bodyRetentionSeconds: number
  devices: Map<string, RelayDeviceIdentity>
}

interface DeviceConfigFile {
  schema: string
  devices: Array<{
    device_id: string
    transport_principal: string
    certificate_sha256: string
  }>
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`relay_config_missing:${name}`)
  return value
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim()
  const value = raw ? Number(raw) : fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`relay_config_invalid:${name}`)
  }
  return value
}

function normalizeFingerprint(value: string): string {
  const normalized = value.replaceAll(':', '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('relay_device_certificate_fingerprint_invalid')
  }
  return normalized
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  if (env.LUGOS_RELAY_ISSUER_ENABLED !== 'true') {
    throw new Error('relay_issuer_disabled')
  }
  const internalHost = (env.LUGOS_RELAY_INTERNAL_HOST || '127.0.0.1').trim()
  if (internalHost !== '127.0.0.1' && internalHost !== '::1') {
    throw new Error('relay_internal_host_not_loopback')
  }
  const listenHost = required(env, 'LUGOS_RELAY_LISTEN_HOST')
  if (isIP(listenHost) === 0 || ['0.0.0.0', '::', '127.0.0.1', '::1'].includes(listenHost)) {
    throw new Error('relay_listen_host_invalid')
  }
  const deviceConfigPath = safeExistingFile(
    required(env, 'LUGOS_RELAY_DEVICES_FILE'),
    false,
  )
  const parsed = JSON.parse(readFileSync(deviceConfigPath, 'utf8')) as DeviceConfigFile
  if (parsed.schema !== DEVICE_CONFIG_SCHEMA
    || !Array.isArray(parsed.devices)
    || parsed.devices.length < 1
    || parsed.devices.length > 16) {
    throw new Error('relay_device_config_invalid')
  }
  const devices = new Map<string, RelayDeviceIdentity>()
  for (const raw of parsed.devices) {
    const keys = Object.keys(raw).sort().join(',')
    if (keys !== 'certificate_sha256,device_id,transport_principal') {
      throw new Error('relay_device_config_invalid')
    }
    for (const value of [raw.device_id, raw.transport_principal]) {
      if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
        throw new Error('relay_device_config_invalid')
      }
    }
    const certificateSha256 = normalizeFingerprint(raw.certificate_sha256)
    if (devices.has(certificateSha256)
      || [...devices.values()].some(device => device.device_id === raw.device_id)) {
      throw new Error('relay_device_config_duplicate')
    }
    devices.set(certificateSha256, {
      device_id: raw.device_id,
      transport_principal: raw.transport_principal,
      certificate_sha256: certificateSha256,
    })
  }
  const token = required(env, 'LUGOS_RELAY_INTERNAL_TOKEN')
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) {
    throw new Error('relay_internal_token_invalid')
  }
  return {
    databasePath: safeDatabasePath(required(env, 'LUGOS_RELAY_DB_PATH')),
    internalHost,
    internalPort: integer(env, 'LUGOS_RELAY_INTERNAL_PORT', 8792, 1024, 65_535),
    internalToken: token,
    listenHost,
    listenPort: integer(env, 'LUGOS_RELAY_PORT', 8793, 1024, 65_535),
    tlsCertificatePath: safeExistingFile(required(env, 'LUGOS_RELAY_TLS_CERT'), false),
    tlsPrivateKeyPath: safeExistingFile(required(env, 'LUGOS_RELAY_TLS_KEY'), true),
    tlsClientCaPath: safeExistingFile(required(env, 'LUGOS_RELAY_CLIENT_CA'), false),
    signingKeyPath: safeExistingFile(required(env, 'LUGOS_RELAY_SIGNING_KEY'), true),
    signingKeyId: required(env, 'LUGOS_RELAY_SIGNING_KEY_ID'),
    issuerId: required(env, 'LUGOS_RELAY_ISSUER_ID'),
    lifetimeSeconds: integer(env, 'LUGOS_RELAY_CAPSULE_LIFETIME_SECONDS', 60, 1, 120),
    bodyRetentionSeconds: integer(env, 'LUGOS_RELAY_BODY_RETENTION_SECONDS', 300, 0, 300),
    devices,
  }
}

function safeExistingFile(path: string, privateFile: boolean): string {
  const absolute = resolve(path)
  const metadata = lstatSync(absolute)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('relay_file_path_unsafe')
  }
  if (privateFile && process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('relay_private_file_permissions_unsafe')
  }
  return absolute
}

function safeDatabasePath(path: string): string {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  if (realpathSync(parent) !== parent) throw new Error('relay_database_path_unsafe')
  try {
    const metadata = lstatSync(absolute)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('relay_database_path_unsafe')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return absolute
}

function createApplication(config: RelayConfig): {
  application: RemoteRelayApplication
  database: Database.Database
} {
  const keyProvider = new FileRelayKeyProvider({
    keyPath: config.signingKeyPath,
    keyId: config.signingKeyId,
    issuerId: config.issuerId,
  })
  const signingKey = keyProvider.activeSigningKey()
  const publicKey = createPublicKey(signingKey.private_key.export({
    type: 'pkcs8',
    format: 'pem',
  }))
  const signer = new RemoteRelaySigner(keyProvider, {
    enabled: () => true,
    lifetimeSeconds: config.lifetimeSeconds,
  })
  const database = new Database(config.databasePath)
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = FULL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')
  const queue = new RemoteRelayQueue(database, {
    databasePurpose: 'remote-relay-isolated-v1',
    enabled: true,
    terminalBodyRetentionMs: config.bodyRetentionSeconds * 1_000,
    verifyCapsule(rawCapsule) {
      const capsule = remoteDecisionCapsuleSchema.parse(rawCapsule)
      if (capsule.key_id !== signingKey.key_id || capsule.issuer_id !== signingKey.issuer_id
        || !verify(
          null,
          capsuleSigningBytes(capsule),
          publicKey,
          Buffer.from(capsule.signature, 'base64url'),
        )) {
        throw new RelayQueueError('relay_capsule_signature_invalid')
      }
    },
  })
  return {
    application: new RemoteRelayApplication(
      new RemoteRelayIssuer(signer, queue),
      queue,
      config.internalToken,
    ),
    database,
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'] || 0)
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_REQUEST_BYTES) {
    throw new RelayRequestError('relay_request_too_large', 413)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > MAX_REQUEST_BYTES) {
      throw new RelayRequestError('relay_request_too_large', 413)
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RelayRequestError('relay_request_invalid', 400)
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Cache-Control': 'no-store' })
  response.end()
}

function errorResponse(response: ServerResponse, error: unknown): void {
  let code = 'relay_unavailable'
  let status = 503
  if (error instanceof RelayRequestError) {
    code = error.code
    status = error.status
  } else if (error instanceof RelayQueueError) {
    code = error.code
    status = code.includes('not_found') ? 404 : code.includes('conflict') ? 409 : 400
  } else if (error instanceof ZodError || error instanceof SyntaxError) {
    code = 'relay_request_invalid'
    status = 400
  }
  console.error(JSON.stringify({ event: 'remote_relay_request_failed', code, status }))
  sendJson(response, status, { error: code })
}

function externalIdentity(
  request: IncomingMessage,
  devices: Map<string, RelayDeviceIdentity>,
): RelayDeviceIdentity {
  const socket = request.socket as TLSSocket
  if (!socket.authorized) throw new RelayRequestError('relay_mtls_unauthorized', 401)
  const peer = socket.getPeerCertificate()
  const fingerprint = peer.fingerprint256
    ? normalizeFingerprint(peer.fingerprint256)
    : ''
  const identity = devices.get(fingerprint)
  if (!identity) throw new RelayRequestError('relay_device_certificate_unrecognized', 403)
  return identity
}

export function createRelayServers(
  config: RelayConfig,
  application: RemoteRelayApplication,
): { internal: ReturnType<typeof createHttpServer>; external: HttpsServer } {
  const internal = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://relay.internal')
      if (request.method === 'GET' && url.pathname === '/internal/v1/health') {
        application.maintain()
        sendJson(response, 200, { status: 'healthy', issuer_enabled: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/internal/v1/enqueue') {
        const capsule = application.enqueue(
          request.headers.authorization,
          await readJson(request),
        )
        sendJson(response, 202, capsule)
        return
      }
      sendJson(response, 404, { error: 'relay_route_not_found' })
    } catch (error) {
      errorResponse(response, error)
    }
  })

  const external = createHttpsServer({
    cert: readFileSync(config.tlsCertificatePath),
    key: readFileSync(config.tlsPrivateKeyPath),
    ca: readFileSync(config.tlsClientCaPath),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
  }, async (request, response) => {
    try {
      const identity = externalIdentity(request, config.devices)
      const url = new URL(request.url || '/', 'https://relay.external')
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(response, 200, {
          status: 'healthy',
          device_id: identity.device_id,
          transport_principal: identity.transport_principal,
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/claims') {
        const claimed = application.claim(identity, await readJson(request))
        if (claimed === null) sendEmpty(response, 204)
        else sendJson(response, 200, {
          ...claimed,
          transport_principal: identity.transport_principal,
        })
        return
      }
      const revocation = /^\/v1\/revocations\/([^/]+)$/.exec(url.pathname)
      if (request.method === 'GET' && revocation) {
        const commandId = url.searchParams.get('command_id') || ''
        const value = application.getRevocation(
          identity,
          decodeURIComponent(revocation[1]),
          commandId,
        )
        if (value === null) sendEmpty(response, 204)
        else sendJson(response, 200, value)
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/acknowledgements') {
        const record = application.acknowledge(identity, await readJson(request))
        sendJson(response, 200, record)
        return
      }
      sendJson(response, 404, { error: 'relay_route_not_found' })
    } catch (error) {
      errorResponse(response, error)
    }
  })
  return { internal, external }
}

export function main(): void {
  const config = loadRelayConfig()
  const { application, database } = createApplication(config)
  application.maintain()
  const servers = createRelayServers(config, application)
  const maintenance = setInterval(() => {
    try {
      const result = application.maintain()
      if (result.expired || result.requeued || result.bodies_purged) {
        console.log(JSON.stringify({ event: 'remote_relay_maintenance', ...result }))
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: 'remote_relay_maintenance_failed',
        error: error instanceof Error ? error.name : 'unknown',
      }))
    }
  }, 30_000)

  servers.internal.listen(config.internalPort, config.internalHost, () => {
    console.log(JSON.stringify({
      event: 'remote_relay_internal_listening',
      host: config.internalHost,
      port: config.internalPort,
    }))
  })
  servers.external.listen(config.listenPort, config.listenHost, () => {
    console.log(JSON.stringify({
      event: 'remote_relay_external_listening',
      host: config.listenHost,
      port: config.listenPort,
    }))
  })

  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    clearInterval(maintenance)
    servers.internal.close()
    servers.external.close(() => {
      database.close()
      process.exitCode = 0
    })
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

if (require.main === module) main()

import fs from 'node:fs'
import { config } from '@/lib/config'
import { logger } from '@/lib/logger'
import { acquireFileLockSync, atomicReplaceFileSync } from '@/lib/atomic-file'

interface OpenClawGatewayConfig {
  gateway?: {
    auth?: {
      mode?: 'token' | 'password'
      token?: string
      password?: string
    }
    port?: number
    controlUi?: {
      allowedOrigins?: string[]
    }
  }
}

function readOpenClawConfig(): OpenClawGatewayConfig | null {
  const configPath = config.openclawConfigPath
  if (!configPath || !fs.existsSync(configPath)) return null
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    return JSON.parse(raw) as OpenClawGatewayConfig
  } catch {
    return null
  }
}

export function registerMcAsDashboard(mcUrl: string): { registered: boolean; alreadySet: boolean } {
  const configPath = config.openclawConfigPath
  if (!configPath) {
    return { registered: false, alreadySet: false }
  }

  let releaseLock: (() => void) | undefined
  try {
    releaseLock = acquireFileLockSync(configPath)
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, any>

    // Ensure nested structure
    if (!parsed.gateway) parsed.gateway = {}
    if (!parsed.gateway.controlUi) parsed.gateway.controlUi = {}

    const origin = new URL(mcUrl).origin
    const origins: string[] = parsed.gateway.controlUi.allowedOrigins || []
    const alreadyInOrigins = origins.includes(origin)

    if (alreadyInOrigins) {
      return { registered: false, alreadySet: true }
    }

    // Add MC origin to allowedOrigins only — do NOT touch dangerouslyDisableDeviceAuth.
    // MC authenticates via gateway token, but forcing device auth off is a security
    // downgrade that the operator should control, not Mission Control.
    origins.push(origin)
    parsed.gateway.controlUi.allowedOrigins = origins

    atomicReplaceFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n')
    logger.info({ origin }, 'Registered MC origin in gateway config')
    return { registered: true, alreadySet: false }
  } catch (err: any) {
    // Read-only filesystem (e.g. Docker read_only: true, or intentional mount) —
    // treat as a non-fatal skip rather than an error.
    if (err?.code === 'EROFS' || err?.code === 'EACCES' || err?.code === 'EPERM') {
      logger.warn(
        { err, configPath },
        'Gateway config is read-only — skipping MC origin registration. ' +
        'To enable auto-registration, mount openclaw.json with write access or ' +
        'add the MC origin to gateway.controlUi.allowedOrigins manually.',
      )
      return { registered: false, alreadySet: false }
    }
    logger.error({ err }, 'Failed to register MC in gateway config')
    return { registered: false, alreadySet: false }
  } finally {
    releaseLock?.()
  }
}

/**
 * Returns the gateway auth credential (token or password) for Bearer/WS auth.
 * Env overrides: OPENCLAW_GATEWAY_TOKEN, GATEWAY_TOKEN, OPENCLAW_GATEWAY_PASSWORD, GATEWAY_PASSWORD.
 * The gateway credential must be injected into the current process.
 */
export function getDetectedGatewayToken(): string {
  const envToken = (process.env.OPENCLAW_GATEWAY_TOKEN || process.env.GATEWAY_TOKEN || '').trim()
  if (envToken) return envToken
  
  const envPassword = (process.env.OPENCLAW_GATEWAY_PASSWORD || process.env.GATEWAY_PASSWORD || '').trim()
  if (envPassword) return envPassword

  return ''
}

export function getDetectedGatewayPort(): number | null {
  const envPort = Number(process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || '')
  if (Number.isFinite(envPort) && envPort > 0) return envPort

  const parsed = readOpenClawConfig()
  const cfgPort = Number(parsed?.gateway?.port || 0)
  if (Number.isFinite(cfgPort) && cfgPort > 0) {
    logger.debug({ port: cfgPort }, 'Gateway port loaded from openclaw.json (set OPENCLAW_GATEWAY_PORT env var to override)')
    return cfgPort
  }
  return null
}

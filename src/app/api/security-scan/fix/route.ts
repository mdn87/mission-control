import { NextRequest, NextResponse } from 'next/server'
import { existsSync, readFileSync, chmodSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { requireRole } from '@/lib/auth'
import { config } from '@/lib/config'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { FIX_SAFETY, runSecurityScan, type FixSafety } from '@/lib/security-scan'
import { securityFixLimiter } from '@/lib/rate-limit'
import { acquireFileLockSync, atomicReplaceFileSync } from '@/lib/atomic-file'
import { z } from 'zod'

export interface FixResult {
  id: string
  name: string
  fixed: boolean
  detail: string
  fixSafety?: FixSafety
}

const fixRequestSchema = z.object({
  ids: z.array(
    z.string().min(1).max(128).refine((id) => id in FIX_SAFETY, 'Unknown security check id'),
  ).min(1).max(50).optional(),
}).strict()

function getFailingChecks() {
  return Object.values(runSecurityScan().categories)
    .flatMap((category) => category.checks)
    .filter((check) => check.status !== 'pass')
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = securityFixLimiter(`${auth.user.workspace_id}:${auth.user.id}`)
  if (rateCheck) return rateCheck

  // Omit ids to intentionally fix all currently supported checks.
  const parsed = fixRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid security fix request' }, { status: 400 })
  }
  const targetIds = parsed.data.ids ? new Set(parsed.data.ids) : null

  const shouldFix = (id: string) => !targetIds || targetIds.has(id)

  const results: FixResult[] = []
  // 1. Fix .env file permissions
  const envPath = path.join(process.cwd(), '.env')
  if (shouldFix('env_permissions') && existsSync(envPath)) {
    try {
      const stat = statSync(envPath)
      const mode = (stat.mode & 0o777).toString(8)
      if (mode !== '600') {
        chmodSync(envPath, 0o600)
        results.push({ id: 'env_permissions', name: '.env file permissions', fixed: true, detail: `Changed from ${mode} to 600`, fixSafety: FIX_SAFETY['env_permissions'] })
      } else {
        results.push({ id: 'env_permissions', name: '.env file permissions', fixed: true, detail: 'Already 600', fixSafety: FIX_SAFETY['env_permissions'] })
      }
    } catch (e: any) {
      results.push({ id: 'env_permissions', name: '.env file permissions', fixed: false, detail: e.message, fixSafety: FIX_SAFETY['env_permissions'] })
    }
  }

  // 6. Fix OpenClaw config
  const ocFixIds = ['config_permissions', 'gateway_bind', 'elevated_disabled', 'dm_isolation', 'exec_restricted', 'control_ui_device_auth', 'control_ui_insecure_auth', 'fs_workspace_only', 'log_redaction']
  const configPath = config.openclawConfigPath
  if (ocFixIds.some(id => shouldFix(id)) && configPath && existsSync(configPath)) {
    let releaseConfigLock: (() => void) | undefined
    let ocConfig: any
    try {
      releaseConfigLock = acquireFileLockSync(configPath)
      ocConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch (error: any) {
      ocConfig = null
      if (error?.code === 'EBUSY') {
        results.push({ id: 'config_write', name: 'Write OpenClaw config', fixed: false, detail: error.message })
      }
    }

    try {
      if (ocConfig) {
      let configChanged = false

      // Fix config file permissions
      if (shouldFix('config_permissions')) try {
        const stat = statSync(configPath)
        const mode = (stat.mode & 0o777).toString(8)
        if (mode !== '600') {
          chmodSync(configPath, 0o600)
          results.push({ id: 'config_permissions', name: 'OpenClaw config permissions', fixed: true, detail: `Changed from ${mode} to 600`, fixSafety: FIX_SAFETY['config_permissions'] })
        }
      } catch (e: any) {
        results.push({ id: 'config_permissions', name: 'OpenClaw config permissions', fixed: false, detail: e.message, fixSafety: FIX_SAFETY['config_permissions'] })
      }

      // Fix gateway bind
      if (shouldFix('gateway_bind')) {
        if (!ocConfig.gateway) ocConfig.gateway = {}
        if (ocConfig.gateway.bind !== 'loopback' && ocConfig.gateway.bind !== '127.0.0.1') {
          ocConfig.gateway.bind = 'loopback'
          configChanged = true
          results.push({ id: 'gateway_bind', name: 'Gateway bind address', fixed: true, detail: 'Set bind to "loopback"', fixSafety: FIX_SAFETY['gateway_bind'] })
        }
      }

      // Fix elevated mode
      if (shouldFix('elevated_disabled')) {
        if (!ocConfig.elevated) ocConfig.elevated = {}
        if (ocConfig.elevated.enabled === true) {
          ocConfig.elevated.enabled = false
          configChanged = true
          results.push({ id: 'elevated_disabled', name: 'Elevated mode', fixed: true, detail: 'Disabled elevated mode', fixSafety: FIX_SAFETY['elevated_disabled'] })
        }
      }

      // Fix DM isolation
      if (shouldFix('dm_isolation')) {
        if (!ocConfig.session) ocConfig.session = {}
        if (ocConfig.session.dmScope !== 'per-channel-peer') {
          ocConfig.session.dmScope = 'per-channel-peer'
          configChanged = true
          results.push({ id: 'dm_isolation', name: 'DM session isolation', fixed: true, detail: 'Set dmScope to "per-channel-peer"', fixSafety: FIX_SAFETY['dm_isolation'] })
        }
      }

      // Fix exec security
      if (shouldFix('exec_restricted')) {
        if (!ocConfig.tools) ocConfig.tools = {}
        if (!ocConfig.tools.exec) ocConfig.tools.exec = {}
        if (ocConfig.tools.exec.security !== 'allowlist' && ocConfig.tools.exec.security !== 'deny') {
          ocConfig.tools.exec.security = 'allowlist'
          configChanged = true
          results.push({ id: 'exec_restricted', name: 'Exec tool restriction', fixed: true, detail: 'Set exec security to "allowlist"', fixSafety: FIX_SAFETY['exec_restricted'] })
        }
      }

      // Fix Control UI device auth
      if (shouldFix('control_ui_device_auth')) {
        if (ocConfig.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true) {
          ocConfig.gateway.controlUi.dangerouslyDisableDeviceAuth = false
          configChanged = true
          results.push({ id: 'control_ui_device_auth', name: 'Control UI device auth', fixed: true, detail: 'Disabled dangerouslyDisableDeviceAuth', fixSafety: FIX_SAFETY['control_ui_device_auth'] })
        }
      }

      // Fix Control UI insecure auth
      if (shouldFix('control_ui_insecure_auth')) {
        if (ocConfig.gateway?.controlUi?.allowInsecureAuth === true) {
          ocConfig.gateway.controlUi.allowInsecureAuth = false
          configChanged = true
          results.push({ id: 'control_ui_insecure_auth', name: 'Control UI secure auth', fixed: true, detail: 'Disabled allowInsecureAuth', fixSafety: FIX_SAFETY['control_ui_insecure_auth'] })
        }
      }

      // Fix filesystem workspace isolation
      if (shouldFix('fs_workspace_only')) {
        if (!ocConfig.tools) ocConfig.tools = {}
        if (!ocConfig.tools.fs) ocConfig.tools.fs = {}
        if (ocConfig.tools.fs.workspaceOnly !== true) {
          ocConfig.tools.fs.workspaceOnly = true
          configChanged = true
          results.push({ id: 'fs_workspace_only', name: 'Filesystem workspace isolation', fixed: true, detail: 'Set tools.fs.workspaceOnly to true', fixSafety: FIX_SAFETY['fs_workspace_only'] })
        }
      }

      // Fix log redaction
      if (shouldFix('log_redaction')) {
        if (!ocConfig.logging) ocConfig.logging = {}
        if (!ocConfig.logging.redactSensitive) {
          ocConfig.logging.redactSensitive = 'tools'
          configChanged = true
          results.push({ id: 'log_redaction', name: 'Log redaction', fixed: true, detail: 'Set logging.redactSensitive to "tools"', fixSafety: FIX_SAFETY['log_redaction'] })
        }
      }

      if (configChanged) {
        try {
          atomicReplaceFileSync(configPath, JSON.stringify(ocConfig, null, 2) + '\n')
        } catch (e: any) {
          results.push({ id: 'config_write', name: 'Write OpenClaw config', fixed: false, detail: e.message })
        }
      }
    }
    } finally {
      releaseConfigLock?.()
    }
  }

  // 7. Fix world-writable files (uses execFileSync with find — no user input)
  if (shouldFix('world_writable')) try {
    const cwd = process.cwd()
    const wwOutput = execFileSync('find', [cwd, '-maxdepth', '2', '-perm', '-o+w', '-not', '-type', 'l'], {
      encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (wwOutput) {
      const files = wwOutput.split('\n').filter(Boolean).slice(0, 20)
      let fixedCount = 0
      for (const f of files) {
        try {
          const currentMode = statSync(f).mode & 0o777
          const hardenedMode = currentMode & ~0o002
          if (hardenedMode !== currentMode) {
            chmodSync(f, hardenedMode)
            fixedCount++
          }
        } catch { /* skip */ }
      }
      if (fixedCount > 0) {
        results.push({ id: 'world_writable', name: 'World-writable files', fixed: true, detail: `Fixed permissions on ${fixedCount} file(s)`, fixSafety: FIX_SAFETY['world_writable'] })
      }
    }
  } catch { /* no world-writable files or find not available */ }

  // Audit log
  try {
    const db = getDatabase()
    db.prepare(
      'INSERT INTO audit_log (action, actor, detail, workspace_id) VALUES (?, ?, ?, ?)'
    ).run('security.auto_fix', auth.user.username, JSON.stringify({ fixes: results.filter(r => r.fixed).map(r => r.id) }), auth.user.workspace_id ?? 1)
  } catch { /* non-critical */ }

  const fixed = results.filter(r => r.fixed).length
  const failed = results.filter(r => !r.fixed).length
  const remainingChecks = getFailingChecks()
  const remainingAutoFixable = remainingChecks.filter((check) => check.id in FIX_SAFETY).length
  const remainingManual = remainingChecks.length - remainingAutoFixable

  logger.info({ fixed, failed, actor: auth.user.username }, 'Security auto-fix completed')

  return NextResponse.json({
    attempted: results.length,
    fixed,
    failed,
    remaining: remainingChecks.length,
    remainingAutoFixable,
    remainingManual,
    results,
    note: remainingChecks.length > 0
      ? 'Some issues require configuration outside this API. Configure credentials in BWS and restart through GLAS.'
      : 'All currently detected auto-fixable issues have been resolved.',
  })
}

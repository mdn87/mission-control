import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { z } from 'zod'

const reportId = z.string().regex(/^report-[a-f0-9]{64}$/)
export const webReportRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('task_review'), args: z.object({}).strict() }).strict(),
  z
    .object({
      action: z.literal('dias'),
      args: z
        .object({
          project: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/),
          since: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          previous: reportId.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('marketplace'),
      args: z
        .object({
          query: z.string().trim().min(1).max(200),
          max_delivered: z
            .string()
            .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/)
            .optional(),
          country: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .optional(),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .optional(),
          condition: z.string().trim().min(1).max(80).optional(),
          pages: z.number().int().min(1).max(10).optional(),
          previous: reportId.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('list'),
      args: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
    })
    .strict(),
  z
    .object({ action: z.literal('open'), args: z.object({ report_id: reportId }).strict() })
    .strict(),
  z
    .object({
      action: z.literal('source'),
      args: z.object({ report_id: reportId, number: z.number().int().min(1).max(2) }).strict(),
    })
    .strict(),
])

export type WebReportRequest = z.infer<typeof webReportRequest>
type Actor = {
  id: number
  workspace_id: number
  tenant_id: number
  is_approved?: number
  agent_id?: number | null
}

export function reportOwner(actor: Actor): string | null {
  const parts = [actor.tenant_id, actor.workspace_id, actor.id]
  return actor.is_approved === 1 &&
    !actor.agent_id &&
    parts.every((v) => Number.isSafeInteger(v) && v > 0)
    ? 'mission-control:' + parts.join(':')
    : null
}

const errorStatus: Record<string, number> = {
  access_denied: 403,
  not_found: 404,
  invalid_request: 400,
  source_unavailable: 502,
  integrity_error: 409,
}
export class WebReportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const timeoutMs = 120_000
const maximumResponse = 8 * 1024 * 1024
const unavailable = () => new WebReportError(502, 'The WEIR report service is unavailable.')

function requestOverSocket(path: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path })
    const chunks: Buffer[] = []
    let length = 0
    const deadline = setTimeout(() => socket.destroy(unavailable()), timeoutMs)
    socket.once('close', () => clearTimeout(deadline))
    socket.once('error', () => reject(unavailable()))
    socket.once('connect', () => socket.end(payload))
    socket.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > maximumResponse) socket.destroy(unavailable())
      else chunks.push(chunk)
    })
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

export async function callWebReport(
  request: WebReportRequest,
  owner: string,
  reviewGrant?: string,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify({
    ...request,
    owner,
    permitted_jobs: ['dias', 'marketplace', 'task_review'],
    ...(request.action === 'task_review' ? { review_grant: reviewGrant } : {}),
  })
  const stdout = process.env.WEIR_REPORT_SOCKET
    ? await requestOverSocket(process.env.WEIR_REPORT_SOCKET, payload)
    : await requestOverStdio(payload)
  let body
  try {
    body = JSON.parse(stdout)
  } catch {
    throw unavailable()
  }
  if (body?.ok === false && Object.hasOwn(errorStatus, body.code)) {
    throw new WebReportError(errorStatus[body.code], String(body.error).slice(0, 240))
  }
  if (
    body?.ok === true &&
    body.result &&
    typeof body.result === 'object' &&
    !Array.isArray(body.result)
  ) {
    return body.result
  }
  throw unavailable()
}

function requestOverStdio(payload: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV }
  for (const name of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'LANG',
    'WEIR_REPORT_DIR',
    'WEIR_DIAS_DISPLAY_ORIGIN',
    'WEIR_DIAS_SSH_HOST',
    'WEIR_EBAY_CLIENT_ID',
    'WEIR_EBAY_CLIENT_SECRET',
    'WEIR_EBAY_MARKETPLACE_ID',
  ]) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.env.WEIR_REPORT_EXECUTABLE || 'weir-operator-rpc',
      [],
      {
        env,
        timeout: timeoutMs,
        maxBuffer: maximumResponse,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout) => {
        if (err && err.code !== 1) reject(unavailable())
        else resolve(stdout)
      },
    )
    child.stdin?.on('error', () => {}) // The exit callback reports early program failures.
    child.stdin?.end(payload)
  })
}

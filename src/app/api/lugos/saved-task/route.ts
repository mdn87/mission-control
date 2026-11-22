import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole, validateSession, type User } from '@/lib/auth'
import { parseMcSessionCookieHeader } from '@/lib/session-cookie'
import {
  assertRemoteDecisionRequestOrigin,
  authenticationOptions,
  consumeStepUpGrant,
  remoteWebAuthnEnabled,
  verifyPasskeyAuthentication,
} from '@/lib/webauthn/remote-passkeys'
import {
  approve,
  bindingDigest,
  commandId,
  configuredSite,
  currentTask,
  fence,
  prepare,
  sha256,
  source,
  titleText,
  withSite,
  type Binding,
} from '@/integrations/lugos/saved-task-store'
import { savedTaskRequest } from '@/integrations/lugos/saved-task-client'

const headers = { 'Cache-Control': 'private, no-store' }
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers })
const job = { command_id: commandId, proposal_hash: sha256 }
const inputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), after: titleText }).strict(),
  z.object({ operation: z.literal('undo'), command_id: commandId }).strict(),
  z.object({ operation: z.literal('options'), ...job }).strict(),
  z.object({ operation: z.literal('decline'), ...job }).strict(),
  z.object({ operation: z.literal('resume'), ...job }).strict(),
  z
    .object({
      operation: z.literal('approve'),
      ...job,
      challenge_id: z.string().min(1).max(256),
      response: z.record(z.string(), z.unknown()),
    })
    .strict(),
])

function access(request: Request): User | Response {
  if (!configuredSite() || !remoteWebAuthnEnabled())
    return json({ error: 'Private task rehearsal disabled.' }, 404)
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return json({ error: auth.error }, auth.status)
  const token = parseMcSessionCookieHeader(request.headers.get('cookie') || '')
  const user = token ? validateSession(token) : null
  if (
    !user ||
    user.provider !== 'local' ||
    !['operator', 'admin'].includes(user.role) ||
    user.is_approved !== 1 ||
    user.id !== auth.user.id ||
    user.workspace_id !== auth.user.workspace_id ||
    user.tenant_id !== auth.user.tenant_id
  ) {
    return json({ error: 'The signed-in rehearsal owner is required.' }, 403)
  }
  return user
}

function owner(user: User, binding: Binding) {
  if (
    binding.actor_id !== 'mc:user:' + user.id ||
    binding.workspace_id !== user.workspace_id ||
    binding.tenant_id !== user.tenant_id
  ) {
    throw new RangeError('Wrong rehearsal owner.')
  }
}

const failure = (error: unknown) =>
  error instanceof RangeError
    ? json({ error: 'The signed-in rehearsal owner is required.' }, 403)
    : json({ error: 'The review or its evidence is unavailable. Reopen the job to check its state.' }, 409)

export async function GET(request: Request) {
  const user = access(request)
  if (user instanceof Response) return user
  try {
    const id = new URL(request.url).searchParams.get('job')
    const snapshot = withSite(false, (db, b) => {
      owner(user, b)
      return db.transaction(() => {
        const jobs = db
          .prepare('SELECT command_id FROM weir_saved_reviews ORDER BY rowid DESC LIMIT 30')
          .all() as Array<{ command_id: string }>
        const history = jobs.map(({ command_id }) => ({ command_id, state: source(db, command_id).state }))
        const hasPasskey = Boolean(
          db.prepare('SELECT 1 FROM remote_decision_passkeys WHERE user_id=? LIMIT 1').get(user.id)
        )
        return {
          task: currentTask(db),
          history,
          hasPasskey,
          review: id ? source(db, commandId.parse(id)) : null,
        }
      })()
    })
    const { review } = snapshot
    const evidence = review
      ? await savedTaskRequest('verify', review.view.command_id).catch(() => ({ state: 'unavailable' }))
      : null
    return json({
      ...snapshot,
      review: review ? { view: review.view, proposal_hash: review.proposal_hash, state: review.state } : null,
      evidence,
    })
  } catch (error) {
    return failure(error)
  }
}

export async function POST(request: Request) {
  const user = access(request)
  if (user instanceof Response) return user
  try {
    assertRemoteDecisionRequestOrigin(request)
    if (Number(request.headers.get('content-length') || '0') > 16_384)
      return json({ error: 'Request is too large.' }, 400)
    const reader = request.body?.getReader()
    if (!reader) return json({ error: 'Invalid private task request.' }, 400)
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 16_384) {
        await reader.cancel()
        return json({ error: 'Request is too large.' }, 400)
      }
      chunks.push(value)
    }
    let data: unknown
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return json({ error: 'Invalid private task request.' }, 400)
    }
    const parsed = inputSchema.safeParse(data)
    if (!parsed.success) return json({ error: 'Invalid private task request.' }, 400)
    const input = parsed.data
    if (input.operation === 'prepare' || input.operation === 'undo') {
      const item = withSite(true, (db, b) => {
        owner(user, b)
        return prepare(
          db,
          b,
          input.operation === 'prepare' ? { after: input.after } : { undo_of: input.command_id }
        )
      })
      return json({ command_id: item.view.command_id, proposal_hash: item.proposal_hash }, 201)
    }
    const item = withSite(false, (db, b) => {
      owner(user, b)
      return source(db, input.command_id)
    })
    if (item.proposal_hash !== input.proposal_hash)
      return json({ error: 'The displayed review changed.' }, 409)
    if (input.operation === 'decline') {
      const state = withSite(true, (db, b) => {
        owner(user, b)
        return fence(db, input.command_id, input.proposal_hash).state
      })
      return json({ state })
    }
    if (input.operation === 'resume' && !['approved', 'committed'].includes(item.state))
      return json({ state: item.state }, 409)
    if (input.operation === 'options' || input.operation === 'approve') {
      if (item.state !== 'pending') return json({ state: item.state }, 409)
      const binding = bindingDigest(item.proposal_hash)
      if (input.operation === 'options') return json(await authenticationOptions(user, binding))
      const grant = await verifyPasskeyAuthentication(user, input.challenge_id, input.response)
      const proof = consumeStepUpGrant(user, binding, grant.step_up_token)
      withSite(true, (db, b) => {
        owner(user, b)
        approve(
          db,
          input.command_id,
          item.proposal_hash,
          proof.step_up_ref,
          Math.floor(Date.parse(grant.expires_at) / 1000)
        )
      })
    }
    try {
      return json(await savedTaskRequest('execute', input.command_id))
    } catch {
      return json({ state: 'outcome_unknown' }, 202)
    }
  } catch (error) {
    return failure(error)
  }
}

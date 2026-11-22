import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  canonicalDigest,
  canonicalJson,
  capsuleSigningBytes,
  remoteDecisionCapsuleSchema,
} from '../integrations/lugos/remote-decision-contract'
import { RemoteRelaySigner } from '../integrations/lugos/relay-signer'
import {
  commandId,
  commitTitle,
  configuredSite,
  grantCurrent,
  initializeSite,
  savedAction,
  savedAudience,
  source,
  withSite,
} from '../integrations/lugos/saved-task-store'

const lookup = z.object({ command_id: commandId }).strict()
const grant = lookup
  .extend({ capsule: remoteDecisionCapsuleSchema, permit: z.record(z.string(), z.unknown()) })
  .strict()
const pinsSchema = z
  .object({
    owner_key: z.string(),
    fade_key: z.string(),
    owner: z.string(),
    deployment: z.string(),
    tenant: z.number().int().positive(),
    workspace: z.number().int().positive(),
  })
  .strict()
const pins = () => pinsSchema.parse(JSON.parse(readFileSync(process.env.MC_WEIR_SAVED_TASK_PINS!, 'utf8')))

function publicKey(raw: string) {
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length !== 32 || bytes.toString('base64') !== raw) throw new Error('Invalid site public key.')
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]),
    format: 'der',
    type: 'spki',
  })
}

export function siteRequest(role: string, request: unknown) {
  if (!configuredSite() || !['reader', 'effect', 'issuer'].includes(role))
    throw new Error('Private site unavailable.')
  const input = role === 'effect' ? grant.parse(request) : lookup.parse(request)
  return withSite(role === 'effect', (db, binding) => {
    if (role === 'reader') return db.transaction(() => source(db, input.command_id))()
    const keys = pins()
    if (
      keys.owner_key === keys.fade_key ||
      keys.deployment !== binding.deployment ||
      keys.tenant !== binding.tenant_id ||
      keys.workspace !== binding.workspace_id ||
      keys.owner !== binding.actor_id
    )
      throw new Error('Wrong private site.')
    if (role === 'issuer') {
      return db.transaction(() => {
        const item = source(db, input.command_id)
        if (item.state !== 'approved' || !item.step_up_ref)
          throw new Error('A current owner approval is required.')
        grantCurrent(db, binding, item)
        const secret = readFileSync(process.env.MC_WEIR_SAVED_TASK_KEY!)
        const privateKey = createPrivateKey(secret)
        if (!createPublicKey(secret).equals(publicKey(keys.owner_key)))
          throw new Error('Wrong private signing key.')
        const signer = new RemoteRelaySigner(
          {
            activeSigningKey: () => ({
              private_key: privateKey,
              issuer_id: 'mc.saved-task',
              key_id: 'mc-saved-task',
            }),
          },
          { enabled: configuredSite }
        )
        return signer.signSavedTaskRehearsal({
          command_id: item.view.command_id,
          actor_id: binding.actor_id,
          device_id: 'saved-task-rehearsal',
          audience: savedAudience,
          decision: 'approve',
          action_id: savedAction,
          proposal_hash: item.proposal_hash,
          work_context_hash: item.view.work_context_hash,
          step_up_ref: item.step_up_ref,
        })
      })()
    }
    const { capsule: cap, permit } = grant.parse(input)
    return commitTitle(db, input.command_id, (item) => {
      grantCurrent(db, binding, item)
      const issued = Date.parse(cap.issued_at),
        expires = Date.parse(cap.expires_at),
        now = Date.now()
      if (
        cap.command_id !== input.command_id ||
        cap.actor_id !== binding.actor_id ||
        cap.audience !== savedAudience ||
        cap.decision !== 'approve' ||
        cap.device_id !== 'saved-task-rehearsal' ||
        cap.action_id !== savedAction ||
        cap.proposal_hash !== item.proposal_hash ||
        cap.work_context_hash !== item.view.work_context_hash ||
        cap.step_up_ref !== item.step_up_ref ||
        cap.issuer_id !== 'mc.saved-task' ||
        cap.key_id !== 'mc-saved-task' ||
        !(issued <= now && now < expires && expires - issued <= 120_000) ||
        !verify(
          null,
          capsuleSigningBytes(cap),
          publicKey(keys.owner_key),
          Buffer.from(cap.signature, 'base64url')
        )
      ) {
        throw new Error('Invalid private owner decision.')
      }
      const expected = {
        schema: 'fade.saved-task-permit/v1',
        issuer: 'fade.saved-task',
        audience: savedAudience,
        command_id: input.command_id,
        proposal_hash: cap.proposal_hash,
        work_context_hash: cap.work_context_hash,
        capsule_hash: canonicalDigest(cap),
        expires_at: cap.expires_at,
        use_limit: 1,
      }
      const { signature, ...body } = permit
      if (
        typeof signature !== 'string' ||
        canonicalJson(expected) !== canonicalJson(body) ||
        !verify(
          null,
          Buffer.from(canonicalJson(expected)),
          publicKey(keys.fade_key),
          Buffer.from(signature, 'base64')
        )
      ) {
        throw new Error('Invalid private Fade permit.')
      }
    })
  })
}

async function cli() {
  const role = process.argv[2]
  if (role === 'init') {
    const settings = pins()
    if (
      !configuredSite() ||
      !process.env.MC_WEIR_SAVED_TASK_DB ||
      process.env.MC_WEIR_SAVED_TASK_DB !== process.env.MISSION_CONTROL_DB_PATH
    )
      throw new Error('Invalid private site.')
    initializeSite(process.env.MC_WEIR_SAVED_TASK_DB, {
      deployment: settings.deployment,
      tenant_id: settings.tenant,
      workspace_id: settings.workspace,
      actor_id: settings.owner,
    })
    return
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    length += bytes.length
    if (length > 32_768) throw new Error('Invalid private request.')
    chunks.push(bytes)
  }
  const result = siteRequest(role, JSON.parse(Buffer.concat(chunks).toString('utf8')))
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n')
}

if (require.main === module) {
  cli().catch(() => {
    process.stdout.write('{"ok":false,"error":"Private task operation unavailable."}\n')
    process.exitCode = 1
  })
}

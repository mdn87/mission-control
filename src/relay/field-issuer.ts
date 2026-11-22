import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { FileRelayKeyProvider } from './file-key-provider'
import { RemoteRelaySigner } from '../integrations/lugos/relay-signer'
import { currentFieldReview, publishedRecord, publishOnce } from '../integrations/lugos/field-review-files'
import { remoteDecisionCapsuleSchema } from '../integrations/lugos/remote-decision-contract'

export function issueCurrentFieldReview(): { state: string; review_hash: string } {
  if (process.env.MC_WEIR_FIELD_REHEARSAL_ENABLED !== 'true') throw new Error('field_issuer_disabled')
  const view = currentFieldReview()
  const uid = process.env.MC_WEIR_FIELD_STEPUP_UID || ''
  const signerUid = process.geteuid?.()
  if (!/^[1-9][0-9]*$/.test(uid) || !signerUid || signerUid === Number(uid)) {
    throw new Error('field_stepup_principal_unconfigured')
  }
  const stepDir = process.env.MC_WEIR_FIELD_STEPUP_DIR || '/run/weir-field-stepups'
  const proof = z.object({ review_hash: z.literal(view.review_hash), actor_id: z.literal(view.actor_id),
    step_up_ref: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict().parse(
    publishedRecord(stepDir, view.review_hash, Number(uid)))
  const output = process.env.MC_WEIR_FIELD_DECISIONS_DIR || '/run/weir-field-decisions'
  function existing() {
    const stored = z.object({ review_hash: z.literal(view.review_hash), capsule: remoteDecisionCapsuleSchema }).strict()
      .parse(publishedRecord(output, view.review_hash, signerUid!))
    const cap = stored.capsule
    if (cap.command_id !== view.command_id || cap.step_up_ref !== proof.step_up_ref || cap.audience !== view.audience
        || cap.actor_id !== view.actor_id || cap.action_id !== view.action_id || cap.device_id !== view.device_id
        || cap.proposal_hash !== view.proposal_hash || cap.work_context_hash !== view.work_context_hash
        || cap.decision !== 'approve' || cap.issuer_id !== process.env.MC_WEIR_FIELD_ISSUER
        || cap.key_id !== process.env.MC_WEIR_FIELD_KEY_ID) throw new Error('field_issuer_record_changed')
    return { state: 'previously_signed', review_hash: view.review_hash }
  }
  try {
    return existing()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const credentials = process.env.CREDENTIALS_DIRECTORY
  const keyId = process.env.MC_WEIR_FIELD_KEY_ID
  const issuerId = process.env.MC_WEIR_FIELD_ISSUER
  if (!credentials || !keyId || !issuerId) throw new Error('field_signer_unconfigured')
  const provider = new FileRelayKeyProvider({ keyPath: join(credentials, 'weir-field-signing-key'),
    credentialsDirectory: credentials, keyId, issuerId })
  const signer = new RemoteRelaySigner(provider, { enabled: () => process.env.MC_WEIR_FIELD_REHEARSAL_ENABLED === 'true' })
  const capsule = signer.signFieldRehearsal({
    command_id: view.command_id, action_id: view.action_id, proposal_hash: view.proposal_hash,
    work_context_hash: view.work_context_hash, actor_id: view.actor_id, device_id: view.device_id,
    audience: view.audience, decision: 'approve', step_up_ref: proof.step_up_ref,
  })
  if (currentFieldReview().review_hash !== view.review_hash) throw new Error('field_review_changed')
  return publishOnce(output, view.review_hash, { review_hash: view.review_hash, capsule })
    ? { state: 'signed', review_hash: view.review_hash } : existing()
}

async function watch(): Promise<void> {
  if (process.env.MC_WEIR_FIELD_REHEARSAL_ENABLED !== 'true') throw new Error('field_issuer_disabled')
  let last = ''
  for (;;) {
    try {
      const result = issueCurrentFieldReview()
      if (result.review_hash !== last) console.log(JSON.stringify(result))
      last = result.review_hash
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && last !== 'unavailable') {
        console.error('The current rehearsal approval is unavailable.')
        last = 'unavailable'
      }
    }
    await delay(750)
  }
}

if (require.main === module) {
  const run = async () => {
    if (process.argv[2] === '--watch' && process.argv.length === 3) await watch()
    else if (process.argv.length === 2) console.log(JSON.stringify(issueCurrentFieldReview()))
    else throw new Error('field_issuer_arguments')
  }
  run().catch(() => { console.error('The rehearsal issuer could not publish the decision.'); process.exitCode = 1 })
}

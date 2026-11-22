import { z } from 'zod'
import { canonicalDigest } from './remote-decision-contract'

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/)
const baseAudience = 'weir.rehearsal.first-fill'
const schema = z.object({
  schema: z.literal('weir.field-review/v1'), phase: z.enum(['enroll', 'fill']),
  actor_id: z.string().regex(/^mc:user:[1-9][0-9]*$/), device_id: identifier,
  audience: z.enum([baseAudience, 'weir.rehearsal.first-fill.enrollment']),
  command_id: identifier, action_id: identifier, proposal_hash: digest, work_context_hash: digest,
  url: z.string().max(2048).url(), field_name: z.string().regex(/^[A-Za-z0-9][ A-Za-z0-9_-]{0,79}$/),
  test_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/), before: z.literal(''), after: z.literal('WEIR-CANARY'),
  use_limit: z.literal(1), discard: z.literal('close-browser-and-read-again'),
  issued_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true }),
  review_hash: digest,
}).strict()

export type FieldReview = z.infer<typeof schema>

export function parseFieldReview(raw: unknown, owner: string, device: string, now = Date.now()): FieldReview {
  const view = schema.parse(raw)
  const { review_hash, command_id, ...body } = view
  const url = new URL(view.url)
  const issued = Date.parse(view.issued_at)
  const expires = Date.parse(view.expires_at)
  if (view.actor_id !== owner || view.device_id !== device
    || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || view.audience !== (view.phase === 'enroll' ? baseAudience + '.enrollment' : baseAudience)
    || (view.phase === 'enroll') !== (view.action_id === 'enroll-first-unsaved-field')
    || !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued
    || expires - issued > 300_000 || issued > now || expires <= now
    || command_id !== 'field-' + view.phase + '-' + canonicalDigest(body).slice(7, 47)
    || review_hash !== canonicalDigest({ ...body, command_id })) {
    throw new Error('field_review_unavailable')
  }
  return view
}

export function passkeyBinding(view: FieldReview): string {
  return canonicalDigest({ purpose: 'weir-field-owner-review', actor_id: view.actor_id, review_hash: view.review_hash })
}

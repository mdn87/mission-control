import { describe, expect, it, vi } from 'vitest'
import { canonicalDigest } from './remote-decision-contract'
import { parseFieldReview, passkeyBinding } from './field-review'
import { RemoteRelaySigner } from './relay-signer'

const now = new Date('2026-11-20T15:00:00.000Z')
function card(overrides: Record<string, unknown> = {}) {
  const body = { schema: 'weir.field-review/v1', phase: 'fill', actor_id: 'mc:user:1', device_id: 'device',
    audience: 'weir.rehearsal.first-fill', action_id: 'field-fill-1', proposal_hash: canonicalDigest('proposal'),
    work_context_hash: canonicalDigest('context'), url: 'https://field.test/field', field_name: 'Text', test_id: 'text',
    before: '', after: 'WEIR-CANARY', use_limit: 1, discard: 'close-browser-and-read-again',
    issued_at: now.toISOString(), expires_at: new Date(+now + 60_000).toISOString(), ...overrides }
  const command_id = 'field-' + body.phase + '-' + canonicalDigest(body).slice(7, 47)
  return { ...body, command_id, review_hash: canonicalDigest({ ...body, command_id }) }
}
const parse = (raw: unknown) => parseFieldReview(raw, 'mc:user:1', 'device', +now)

describe('private field owner review', () => {
  it('binds the visible field, exact registered proposal and phase to the passkey', () => {
    const initial = card()
    expect(() => parse({ ...initial, field_name: 'Edited' })).toThrow()
    expect(passkeyBinding(parse(initial))).not.toEqual(passkeyBinding(parse(card({ field_name: 'Edited' }))))
    expect(passkeyBinding(parse(initial))).not.toEqual(passkeyBinding(parse(card({ proposal_hash: canonicalDigest('changed') }))))
    expect(() => parse(card({ phase: 'enroll' }))).toThrow()
  })
  it('refuses a different owner, device, unsafe edit, stale view or live audience even with a fresh digest', () => {
    for (const change of [{ actor_id: 'mc:user:2' }, { device_id: 'another' }, { before: 'saved' }, { use_limit: 2 },
      { test_id: 'hidden\nfield' }, { audience: 'weir.production.first-fill' }, { expires_at: now.toISOString() }]) {
      expect(() => parse(card(change))).toThrow()
    }
  })
  it('keeps production and Windows requests out of the dedicated signing method', () => {
    const activeSigningKey = vi.fn()
    const signer = new RemoteRelaySigner({ activeSigningKey }, { enabled: () => true })
    const view = card()
    for (const audience of ['weir.production.first-fill', 'fade-weir-remote-decision']) {
      const request = { command_id: view.command_id, action_id: view.action_id, proposal_hash: view.proposal_hash,
        actor_id: view.actor_id, device_id: view.device_id, work_context_hash: view.work_context_hash,
        audience, decision: 'approve', step_up_ref: canonicalDigest('passkey') }
      expect(() => signer.signFieldRehearsal(request as never)).toThrow()
    }
    expect(activeSigningKey).not.toHaveBeenCalled()
  })
})

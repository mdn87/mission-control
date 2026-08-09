import { describe, expect, it } from 'vitest'
import captured from './__tests__/torc-lineage-explanation.captured.json'
import { lineageExplanationSchema } from './torc-contract'

/**
 * Contract test against output captured verbatim from `torc lineage explain`.
 *
 * Hand-written fixtures cannot catch field-name drift, because they get written
 * to match whatever the schema already says. This one is real TORC output, so
 * if TORC renames a field or this schema invents one, the parse fails here
 * instead of silently 502-ing at runtime.
 *
 * Recapture with:
 *   lugos-tool-call torc.lineage.explain \
 *     --arguments '{"lineage":"torc-dev","state_dir":"<state-dir>"}'
 */
describe('lineageExplanationSchema against captured TORC output', () => {
  it('parses a real trusted explanation', () => {
    const parsed = lineageExplanationSchema.safeParse(captured)

    if (!parsed.success) {
      throw new Error(`schema rejected real TORC output: ${parsed.error.message}`)
    }
    expect(parsed.data.trusted).toBe(true)
    expect(parsed.data.report_kind).toBe('lineage_explanation')
  })

  it('preserves the fields the panel renders', () => {
    const data = lineageExplanationSchema.parse(captured)

    expect(data.lineage.lineage_id).toBe('torc-dev')
    expect(data.authority_changes).toHaveLength(2)
    expect(data.authority_changes.map((change) => change.kind)).toEqual([
      'lineage_created',
      'handoff',
    ])

    const [handoff] = data.handoffs
    expect(handoff.state).toBe('accepted')
    expect(handoff.authority_effect).toBe('transferred')

    expect(data.continuity_events.map((event) => event.event_type)).toEqual([
      'lineage_created',
      'checkpoint',
      'handoff_accepted',
    ])
  })

  it('keeps a non-transferring continuity event distinguishable', () => {
    const data = lineageExplanationSchema.parse(captured)
    const checkpoint = data.continuity_events.find(
      (event) => event.event_type === 'checkpoint',
    )

    // A checkpoint advances canonical history without moving authority.
    expect(checkpoint?.authority_changed).toBe(false)
  })
})

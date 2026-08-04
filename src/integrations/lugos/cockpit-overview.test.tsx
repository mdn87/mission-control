import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CockpitDrillIn,
  CockpitExceptionDeck,
  CockpitTrustRail,
} from './cockpit-overview'
import {
  makeBranReadinessProjection,
  makeCockpitSource,
  makeDiagnosticsProjection,
  makeFleetProjection,
} from './__tests__/cockpit-fixtures'

describe('Mission Control cockpit overview', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('renders unknown projection evidence as unknown and opens bounded details', () => {
    const onOpen = vi.fn()
    render(
      <CockpitTrustRail
        fleet={makeFleetProjection({
          sources: {
            ...makeFleetProjection().sources,
            runtime: makeCockpitSource({
              state: 'unknown',
              sourceAt: null,
              observedAt: null,
              lastSuccessAt: null,
              ageSecs: null,
              diagnosticCodes: ['source_not_enabled'],
            }),
          },
        })}
        diagnostics={makeDiagnosticsProjection()}
        branReadiness={makeBranReadinessProjection()}
        onOpen={onOpen}
      />,
    )
    const projection = screen.getByRole('button', { name: /Projection: unknown/i })
    expect(projection).toBeInTheDocument()
    fireEvent.click(projection)
    expect(onOpen).toHaveBeenCalledWith('fleet')
  })

  it('orders blocked source packs before lower-severity repository and mail exceptions', () => {
    const { container } = render(
      <CockpitExceptionDeck
        fleet={makeFleetProjection()}
        diagnostics={makeDiagnosticsProjection()}
        branReadiness={makeBranReadinessProjection({
          summary: {
            total: 1,
            ready: 0,
            stale: 0,
            blocked: 1,
            assigned: 0,
            unknown: 0,
          },
          packs: [{
            ...makeBranReadinessProjection().packs[0],
            readyRef: null,
            status: 'blocked',
            blockingCodes: ['pack_digest_mismatch'],
          }],
        })}
        onOpen={() => {}}
      />,
    )
    const text = container.textContent ?? ''
    expect(text.indexOf('Operator Handbook is blocked'))
      .toBeLessThan(text.indexOf('lugos is not ready'))
    expect(text.indexOf('Operator Handbook is blocked'))
      .toBeLessThan(text.indexOf('Response requested'))
  })

  it('presents Agent Mail as bounded read-only evidence', () => {
    render(
      <CockpitDrillIn
        fleet={makeFleetProjection()}
        diagnostics={makeDiagnosticsProjection()}
        branReadiness={makeBranReadinessProjection()}
        detail="fleet"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/Current unacknowledged inbox only/)).toBeInTheDocument()
    expect(screen.getByText(/no history mutation/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /acknowledge/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reply/i })).not.toBeInTheDocument()
  })

  it('keeps Bran checkout execution outside Mission Control', () => {
    render(
      <CockpitDrillIn
        fleet={makeFleetProjection()}
        diagnostics={makeDiagnosticsProjection()}
        branReadiness={makeBranReadinessProjection()}
        detail="bran"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/Codex owns checkout execution/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /checkout/i })).not.toBeInTheDocument()
    expect(screen.getByText('operator-handbook@2')).toBeInTheDocument()
  })

  it('keeps specialist applications external and uses server-approved links', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schema: 'lugos-cockpit-destinations/v1',
      destinations: [
        { id: 'memory', label: 'Memory', description: 'Sulis and Atlas remain authoritative.', href: null },
        { id: 'traces', label: 'Traces', description: 'Use Jaeger for spans and waterfalls.', href: null },
        { id: 'files', label: 'File operations', description: 'Use Codelink for shares and transfers.', href: 'https://files.newman.foo/' },
        { id: 'vision', label: 'Vision', description: 'Use Remotedesk for screen and vision operations.', href: null },
        { id: 'media', label: 'Media', description: 'Use the media generation tools.', href: null },
        { id: 'workflows', label: 'Workflows', description: 'Use the composed workflow tooling.', href: null },
      ],
    }), { status: 200 })))
    render(
      <CockpitDrillIn
        fleet={makeFleetProjection()}
        diagnostics={makeDiagnosticsProjection()}
        branReadiness={makeBranReadinessProjection()}
        detail="diagnostics"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('Specialist custody')).toBeInTheDocument()
    expect(await screen.findByText(/Use Jaeger for spans and waterfalls/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open specialist' })).toHaveAttribute(
      'href',
      'https://files.newman.foo/',
    )
  })
})

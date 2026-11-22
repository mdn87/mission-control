import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError, apiFetch } from '@/lib/api-client'
import { startAuthentication } from '@simplewebauthn/browser'
import { FieldReviewPanel } from './field-review-panel'

vi.mock('@/lib/api-client', async original => ({ ...await original<typeof import('@/lib/api-client')>(), apiFetch: vi.fn() }))
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

it.each(['enroll', 'fill'])('shows the %s decision and submits the challenge for that view', async phase => {
  const review = { phase, url: 'https://field.test/field', field_name: 'Fixture value', test_id: 'fixture',
    after: 'WEIR-CANARY', review_hash: 'sha256:' + 'a'.repeat(64) }
  vi.mocked(apiFetch).mockResolvedValueOnce({ review, state: 'awaiting_passkey' })
    .mockResolvedValueOnce({ challenge_id: 'qa-challenge', options: { challenge: 'qa' } })
    .mockResolvedValueOnce({ state: 'approved' }).mockResolvedValue({ review, state: 'approved' })
  vi.mocked(startAuthentication).mockResolvedValue({ id: 'qa' } as Awaited<ReturnType<typeof startAuthentication>>)
  render(<FieldReviewPanel canReview />)
  expect(await screen.findByText(review.url)).toBeVisible()
  expect(screen.getByText('WEIR-CANARY')).toBeVisible()
  expect(screen.getByText(/WEIR closes the browser/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: phase === 'enroll' ? 'Approve enrollment with passkey' : 'Approve fill with passkey' }))
  await waitFor(() => expect(screen.getByText('Passkey approval recorded.')).toBeVisible())
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[2][1]?.body as string)).toEqual({
    operation: 'approve', review_hash: review.review_hash, challenge_id: 'qa-challenge', response: { id: 'qa' } })
})

it('hides disabled field reviews', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new ApiError('NOT_FOUND', 404, 'field_review_disabled'))
  render(<FieldReviewPanel canReview />)
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
  expect(screen.queryByRole('region', { name: 'Linux field rehearsal' })).toBeNull()
})

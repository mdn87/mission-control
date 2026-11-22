'use client'

import { useCallback, useEffect, useState } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import { Button } from '@/components/ui/button'
import { ApiError, apiFetch } from '@/lib/api-client'
import type { FieldReview } from './field-review'

const path = '/api/lugos/field-review'
type PendingView = { review: FieldReview; state: 'approved' | 'awaiting_passkey' }

export function FieldReviewPanel({ canReview }: {canReview: boolean}) {
  const [view, setView] = useState<PendingView | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const reload = useCallback(async () => {
    if (!canReview) { setView(null); return }
    try {
      setView(await apiFetch<PendingView>(path))
      setEnabled(true)
    } catch (error) {
      setView(null)
      setEnabled(error instanceof ApiError && error.status === 409)
    }
  }, [canReview])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    if (!canReview || !enabled || busy) return
    const timer = setInterval(() => { void reload() }, 5_000)
    return () => clearInterval(timer)
  }, [canReview, enabled, busy, reload])
  if (!view || !canReview) return null
  const card = view.review
  async function approve() {
    setBusy(true)
    setMessage('')
    try {
      const challenge = await apiFetch<{ challenge_id: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>(
        path, { method: 'POST', body: JSON.stringify({ operation: 'options', review_hash: card.review_hash }) })
      const response = await startAuthentication({ optionsJSON: challenge.options })
      await apiFetch(path, { method: 'POST', body: JSON.stringify({ operation: 'approve',
        review_hash: card.review_hash, challenge_id: challenge.challenge_id, response }) })
      await reload()
    } catch { setMessage('Approval did not finish. Refresh the review before trying again.') }
    finally { setBusy(false) }
  }
  return <section aria-label="Linux field rehearsal" className="space-y-3 rounded-lg border border-border p-4">
    <h3 className="text-sm font-semibold">{card.phase === 'enroll' ? 'Enroll a rehearsal field' : 'Approve one rehearsal fill'}</h3>
    <dl className="grid gap-1 text-sm">
      <dt>Page</dt><dd className="break-all">{card.url}</dd>
      <dt>Text field</dt><dd>{card.field_name} <code>({card.test_id})</code></dd>
      <dt>Proposed edit</dt><dd>Empty → <code>{card.after}</code>, once in the isolated browser.</dd>
      <dt>Discard</dt><dd>WEIR closes the browser and checks that a fresh copy is empty.</dd>
    </dl>
    {card.phase === 'enroll' && <p className="text-sm">The fill requires a second passkey approval.</p>}
    {view.state === 'approved' ? <p role="status">Passkey approval recorded.</p>
      : <Button disabled={busy} onClick={approve}>{busy ? 'Waiting for passkey…' :
        card.phase === 'enroll' ? 'Approve enrollment with passkey' : 'Approve fill with passkey'}</Button>}
    {message && <p role="alert">{message} <button onClick={reload}>Refresh review</button></p>}
  </section>
}

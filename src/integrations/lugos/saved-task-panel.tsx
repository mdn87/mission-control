'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import type { Review } from './saved-task-store'
import type { SavedEvidence } from './saved-task-client'

const path = '/api/lugos/saved-task'
type Snapshot = {
  task: { title: string; revision: number }
  hasPasskey: boolean
  history: Array<{ command_id: string; state: string }>
  review: { view: Review; proposal_hash: string; state: string } | null
  evidence: SavedEvidence | null
}
const outcome: Record<string, string> = {
  pending: 'Waiting for your decision.',
  approved: 'Your passkey approval is recorded.',
  declined: 'You declined this change.',
  withdrawn: 'You withdrew this approval.',
  expired: 'This approval expired.',
  stale: 'Another edit changed the task before this one could be saved.',
  outcome_unknown:
    'WEIR cannot confirm the outcome. Refresh the evidence. The command will not be sent again.',
  unavailable: 'The saved decision is available. WEIR could not verify the destination.',
}
const post = <T,>(body: unknown) => apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) })

export function SavedTaskPanel({ canReview }: { canReview: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [after, setAfter] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [password, setPassword] = useState('')
  const latest = useRef(0)
  const reload = useCallback(async (id?: string) => {
    const seq = ++latest.current
    const result = await apiFetch<Snapshot>(id ? path + '?job=' + encodeURIComponent(id) : path)
    if (seq === latest.current) setSnapshot(result)
  }, [])
  useEffect(() => {
    const link = new URLSearchParams(window.location.search).get('savedTask')
    if (canReview)
      void reload(link && /^saved-[a-f0-9]{32}$/.test(link) ? link : undefined).catch(() => setSnapshot(null))
    else setSnapshot(null)
    const cancel = () => {
      latest.current += 1
    }
    return cancel
  }, [canReview, reload])
  if (!canReview || !snapshot) return null
  const { review, evidence } = snapshot
  const selected = review?.view.command_id
  const binding = { command_id: selected, proposal_hash: review?.proposal_hash }
  async function enroll() {
    const base = '/api/lugos/remote-decisions/passkeys/register/'
    setBusy(true)
    setMessage('')
    try {
      const challenge = await apiFetch<{
        challenge_id: string
        options: Parameters<typeof startRegistration>[0]['optionsJSON']
      }>(base + 'options', { method: 'POST', body: JSON.stringify({ current_password: password }) })
      setPassword('')
      const response = await startRegistration({ optionsJSON: challenge.options })
      await apiFetch(base + 'verify', {
        method: 'POST',
        body: JSON.stringify({ challenge_id: challenge.challenge_id, response }),
      })
      await reload(selected)
    } catch {
      setMessage('Passkey setup did not finish. Check the rehearsal password and try again.')
    } finally {
      setPassword('')
      setBusy(false)
    }
  }
  async function act(operation: 'prepare' | 'approve' | 'decline' | 'undo' | 'resume' | 'open', id?: string) {
    setBusy(true)
    setMessage('')
    let job = id || selected
    try {
      if (operation === 'prepare' || operation === 'undo') {
        const result = await post<{ command_id: string }>(
          operation === 'prepare' ? { operation, after } : { operation, command_id: job }
        )
        job = result.command_id
        if (operation === 'prepare') setAfter('')
      } else if (operation === 'approve') {
        const challenge = await post<{
          challenge_id: string
          options: Parameters<typeof startAuthentication>[0]['optionsJSON']
        }>({ operation: 'options', ...binding })
        const response = await startAuthentication({ optionsJSON: challenge.options })
        await post({ operation, ...binding, challenge_id: challenge.challenge_id, response })
      } else if (operation !== 'open') await post({ operation, ...binding })
      await reload(job)
    } catch {
      setMessage('The request did not finish. Refresh the evidence before making another decision.')
      if (job) await reload(job).catch(() => {})
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Private task rehearsal" className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">Private task rehearsal</h3>
      <p className="text-sm">
        Current title <strong>{snapshot.task.title}</strong>
      </p>
      {!snapshot.hasPasskey && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void enroll()
          }}
        >
          <label className="text-xs">
            Current rehearsal password
            <input
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 block rounded border border-border bg-background p-2"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <Button size="sm" disabled={busy || !password}>
            Set up rehearsal passkey
          </Button>
        </form>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void act('prepare')
        }}
      >
        <label className="text-xs">
          New title
          <input
            className="mt-1 block rounded border border-border bg-background p-2"
            value={after}
            onChange={(e) => setAfter(e.target.value)}
            maxLength={500}
            required
          />
        </label>
        <Button size="sm" disabled={busy || !after || after === snapshot.task.title}>
          Review change
        </Button>
      </form>
      {snapshot.history.length > 0 && (
        <label className="block text-xs">
          Saved jobs
          <select
            value={selected || ''}
            disabled={busy}
            className="mt-1 block max-w-full rounded border border-border bg-background p-2"
            onChange={(e) => void act('open', e.target.value)}
          >
            <option value="" disabled>
              Choose a job
            </option>
            {selected && !snapshot.history.some((r) => r.command_id === selected) && (
              <option value={selected}>{selected}</option>
            )}
            {snapshot.history.map((r) => (
              <option key={r.command_id} value={r.command_id}>
                {r.command_id} · {r.state}
              </option>
            ))}
          </select>
        </label>
      )}
      {review && (
        <div className="space-y-2 text-sm">
          <p>
            Workspace {review.view.workspace_id} · Private rehearsal task · Revision {review.view.revision}
          </p>
          <p>
            Task {review.view.task_id} · Job {review.view.command_id}
          </p>
          <a className="underline" href={'/lugos?savedTask=' + review.view.command_id}>
            Link to this job
          </a>
          <p>Approval expires {new Date(review.view.expires_at * 1000).toLocaleString()}.</p>
          {review.view.undo_of && <p>Undo of {review.view.undo_of}</p>}
          <dl>
            <dt>From</dt>
            <dd className="whitespace-pre-wrap break-words">{review.view.before}</dd>
            <dt>To</dt>
            <dd className="whitespace-pre-wrap break-words">{review.view.after}</dd>
          </dl>
          <p>The new title and receipt stay in this private task site.</p>
          {evidence?.state === 'verified' ? (
            <div role="status">
              <p>
                WEIR verified the saved title <strong>{evidence.receipt.after}</strong> at revision{' '}
                {evidence.receipt.revision}.
              </p>
              {!evidence.current && (
                <p>
                  The current title is <strong>{evidence.current_title}</strong> at revision{' '}
                  {evidence.current_revision}.
                </p>
              )}
            </div>
          ) : (
            <p role="status">
              {review.view.undo_of && review.state === 'stale'
                ? 'Undo refused. A later edit is still in place.'
                : outcome[evidence?.state || review.state]}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {review.state === 'pending' && (
              <Button size="sm" disabled={busy || !snapshot.hasPasskey} onClick={() => void act('approve')}>
                Approve with passkey
              </Button>
            )}
            {['pending', 'approved'].includes(review.state) && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('decline')}>
                {review.state === 'pending' ? 'Decline' : 'Withdraw approval'}
              </Button>
            )}
            {evidence?.state === 'approved' && (
              <Button size="sm" disabled={busy} onClick={() => void act('resume')}>
                Finish approved change
              </Button>
            )}
            {evidence?.state === 'verified' && evidence.current && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('undo')}>
                Review undo
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('open')}>
              Refresh evidence
            </Button>
          </div>
        </div>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  )
}

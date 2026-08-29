'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import type { WeirAction } from './operator-contract'

type RegistrationOptionsJSON = Parameters<typeof startRegistration>[0]['optionsJSON']
type AuthenticationOptionsJSON = Parameters<typeof startAuthentication>[0]['optionsJSON']

interface PasskeyStatus {
  enabled: boolean
  device_id: string
  passkeys: Array<{
    credential_id: string
    device_type: string
    backed_up: boolean
    created_at: string
    last_used_at: string | null
  }>
}

interface Challenge<T> {
  challenge_id: string
  options: T
}

interface StepUpGrant {
  step_up_token: string
  expires_at: string
}

function decisionRequest(
  action: WeirAction,
  deviceId: string,
  decision: 'approve' | 'deny',
) {
  return {
    schema: 'mc.remote-decision-request/v1',
    idempotency_key: [
      'mc-remote',
      decision,
      action.proposal_hash.replace('sha256:', '').slice(0, 32),
    ].join('-'),
    decision,
    proposal_hash: action.proposal_hash,
    action_id: action.action_id,
    work_context_hash: action.work_context_hash,
    device_id: deviceId,
  }
}

function shortDigest(value: string): string {
  return `${value.slice(0, 15)}…${value.slice(-8)}`
}

export function RemoteDecisionPanel({
  actions,
  canCommand,
  reload,
}: {
  actions: WeirAction[]
  canCommand: boolean
  reload(): Promise<void>
}) {
  const [status, setStatus] = useState<PasskeyStatus | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const proposed = actions.filter(action => action.state === 'proposed')

  const loadStatus = useCallback(async () => {
    if (!canCommand) return
    try {
      setStatus(await apiFetch<PasskeyStatus>(
        '/api/lugos/remote-decisions/passkeys',
      ))
    } catch {
      setStatus(null)
    }
  }, [canCommand])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  async function enrollPasskey(event: React.FormEvent) {
    event.preventDefault()
    if (!password || busy !== null) return
    setBusy('enroll')
    setMessage(null)
    try {
      const challenge = await apiFetch<Challenge<RegistrationOptionsJSON>>(
        '/api/lugos/remote-decisions/passkeys/register/options',
        { method: 'POST', body: JSON.stringify({ current_password: password }) },
      )
      setPassword('')
      const response = await startRegistration({ optionsJSON: challenge.options })
      await apiFetch('/api/lugos/remote-decisions/passkeys/register/verify', {
        method: 'POST',
        body: JSON.stringify({ challenge_id: challenge.challenge_id, response }),
      })
      await loadStatus()
      setMessage('Passkey enrolled for remote decisions.')
    } catch {
      setPassword('')
      setMessage('Passkey enrollment failed. Use the HTTPS operator origin and current password.')
    } finally {
      setBusy(null)
    }
  }

  async function removePasskey(credentialId: string) {
    if (!credentialId || !password || busy !== null) return
    setBusy('remove')
    setMessage(null)
    try {
      await apiFetch('/api/lugos/remote-decisions/passkeys', {
        method: 'DELETE',
        body: JSON.stringify({
          credential_id: credentialId,
          current_password: password,
        }),
      })
      setPassword('')
      await loadStatus()
      setMessage('Passkey removed; outstanding step-up grants were revoked.')
    } catch {
      setPassword('')
      setMessage('Passkey removal failed. Check the current password and HTTPS origin.')
    } finally {
      setBusy(null)
    }
  }

  async function decide(action: WeirAction, decision: 'approve' | 'deny') {
    if (!status || status.passkeys.length === 0 || busy !== null) return
    const request = decisionRequest(action, status.device_id, decision)
    setBusy(`${decision}:${action.proposal_hash}`)
    setMessage(null)
    try {
      const challenge = await apiFetch<Challenge<AuthenticationOptionsJSON>>(
        '/api/lugos/remote-decisions/step-up/options',
        { method: 'POST', body: JSON.stringify(request) },
      )
      const response = await startAuthentication({ optionsJSON: challenge.options })
      const grant = await apiFetch<StepUpGrant>(
        '/api/lugos/remote-decisions/step-up/verify',
        {
          method: 'POST',
          body: JSON.stringify({ challenge_id: challenge.challenge_id, response }),
        },
      )
      const capsule = await apiFetch<{ capsule_id: string }>(
        '/api/lugos/remote-decisions',
        {
          method: 'POST',
          headers: { 'x-mc-remote-step-up': grant.step_up_token },
          body: JSON.stringify(request),
        },
      )
      setMessage(
        decision === 'approve'
          ? `Approval queued as ${capsule.capsule_id}.`
          : `Denial recorded as ${capsule.capsule_id}.`,
      )
      await reload()
    } catch {
      setMessage('The remote decision was not accepted; no reusable authority was created.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">WEIR remote decisions</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            A passkey signs one exact, short-lived decision. Action parameters remain on the workstation.
          </p>
        </div>
        <span className="rounded border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">
          {status ? `${status.passkeys.length} passkey${status.passkeys.length === 1 ? '' : 's'}` : 'disabled or unavailable'}
        </span>
      </div>

      {message && (
        <div className="mt-3 rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground">
          {message}
        </div>
      )}

      {canCommand && status && status.passkeys.length === 0 && (
        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={enrollPasskey}>
          <label className="min-w-64 flex-1 text-xs text-muted-foreground">
            Current Mission Control password
            <input
              type="password"
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              value={password}
              onChange={event => setPassword(event.target.value)}
              maxLength={512}
              required
            />
          </label>
          <Button type="submit" size="sm" disabled={busy !== null}>
            {busy === 'enroll' ? 'Enrolling…' : 'Enroll passkey'}
          </Button>
        </form>
      )}

      {canCommand && status && status.passkeys.length > 0 && (
        <div className="mt-4 space-y-2">
          <label className="min-w-64 flex-1 text-xs text-muted-foreground">
            Current password to remove a passkey
            <input
              type="password"
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              value={password}
              onChange={event => setPassword(event.target.value)}
              maxLength={512}
              required
            />
          </label>
          {status.passkeys.map(passkey => (
            <div key={passkey.credential_id} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-mono">
                {passkey.credential_id.slice(0, 16)}… · {passkey.device_type}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!password || busy !== null}
                onClick={() => void removePasskey(passkey.credential_id)}
              >
                {busy === 'remove' ? 'Removing…' : 'Remove'}
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-3">
        {proposed.map(action => (
          <div key={action.proposal_hash} className="rounded-md border border-border bg-background p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-foreground">
                  {action.action_type} · {action.risk}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Session <span className="font-mono text-foreground">{action.session_id}</span>
                  {' · '}{action.parameter_data_class} data
                  {' · '}{action.evidence_ref_count} evidence reference{action.evidence_ref_count === 1 ? '' : 's'}
                </div>
                <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                  {shortDigest(action.proposal_hash)} · {shortDigest(action.work_context_hash)}
                </div>
              </div>
              {canCommand && (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!status || status.passkeys.length === 0 || busy !== null}
                    onClick={() => void decide(action, 'deny')}
                  >
                    {busy === `deny:${action.proposal_hash}` ? 'Verifying…' : 'Deny'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!status || status.passkeys.length === 0 || busy !== null}
                    onClick={() => void decide(action, 'approve')}
                  >
                    {busy === `approve:${action.proposal_hash}` ? 'Verifying…' : 'Approve with passkey'}
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
        {proposed.length === 0 && (
          <div className="rounded-md border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
            No WEIR proposals currently await a decision.
          </div>
        )}
      </div>
    </section>
  )
}

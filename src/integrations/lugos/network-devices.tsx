'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import {
  deviceCategorySchema,
  type DeviceCategory,
  type NetworkDevice,
  type NetworkDevicesProjection,
} from './cockpit-contract'
import {
  OPERATOR_COMMAND_SCHEMA,
  operatorReceiptSchema,
  type OperatorReceipt,
} from './operator-contract'

const CONNECTION_TONE: Record<NetworkDevice['connectionState'], string> = {
  live: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  stale: 'border-orange-400/40 bg-orange-400/10 text-orange-300',
  offline: 'border-slate-500/40 bg-slate-500/10 text-slate-300',
  unknown: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
}

const FLAG_TONE: Record<NetworkDevice['flags'][number], string> = {
  new: 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200',
  changed: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  randomized_mac: 'border-violet-400/40 bg-violet-400/10 text-violet-200',
}

const INVENTORY_TONE: Record<NetworkDevice['inventoryState'], string> = {
  provisional: 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200',
  identified: 'border-border bg-card/70 text-slate-200',
  managed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  merged: 'border-border bg-card/70 text-slate-400',
}

const INPUT_CLASS = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground'

function formatAge(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'age unknown'
  if (value < 60) return `${value}s ago`
  if (value < 3_600) return `${Math.floor(value / 60)}m ago`
  if (value < 86_400) return `${Math.floor(value / 3_600)}h ago`
  return `${Math.floor(value / 86_400)}d ago`
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'unknown'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'unknown'
}

function slugify(value: string | null, fallback: string): string {
  const slug = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[-._]+$/g, '')
    .slice(0, 64)
  return slug || fallback
}

function idempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(16)
  return `mc-${random}`
}

function optional(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseRoles(value: string): string[] {
  return [...new Set(
    value
      .split(',')
      .map(role => role.trim().toLowerCase())
      .filter(role => /^[a-z][a-z0-9._-]{0,63}$/.test(role)),
  )].slice(0, 16)
}

async function postCommand(type: string, payload: Record<string, unknown>): Promise<OperatorReceipt> {
  return operatorReceiptSchema.parse(await apiFetch<OperatorReceipt>('/api/lugos/commands', {
    method: 'POST',
    body: JSON.stringify({
      schema: OPERATOR_COMMAND_SCHEMA,
      type,
      idempotency_key: idempotencyKey(),
      payload,
    }),
  }))
}

function Pill({ label, tone }: { label: string; tone: string }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${tone}`}>
      {label.replaceAll('_', ' ')}
    </span>
  )
}

function Evidence({ device }: { device: NetworkDevice }) {
  return (
    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      {device.interfaces.map(iface => (
        <div key={iface.interfaceId} className="rounded border border-border bg-background/60 px-3 py-2">
          <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {iface.connection}{iface.ssid ? ` · ${iface.ssid}` : ''}{iface.privateAddress ? ' · private MAC' : ''}
          </dt>
          <dd className="mt-1 font-mono text-foreground">{iface.mac}</dd>
          <dd className="text-muted-foreground">
            {iface.currentAddress ?? 'no address'} · {iface.observedHostname ?? 'no hostname'} · {iface.reservation}
          </dd>
          <dd className="text-[10px] text-muted-foreground">
            first {formatTimestamp(iface.firstSeenAt)} · last {formatTimestamp(iface.lastSeenAt)} · {iface.observationCount} observations
          </dd>
        </div>
      ))}
      {device.interfaces.length === 0 && (
        <div className="rounded border border-dashed border-border px-3 py-2 text-muted-foreground">
          No interface evidence retained.
        </div>
      )}
    </dl>
  )
}

interface FormProps {
  device: NetworkDevice
  devices: NetworkDevice[]
  targetSlugs: string[]
  submitting: boolean
  onSubmit: (type: 'device.add' | 'device.merge', payload: Record<string, unknown>) => Promise<void>
  onCancel: () => void
}

function AddDeviceForm({ device, targetSlugs, submitting, onSubmit, onCancel }: FormProps) {
  const [deviceId, setDeviceId] = useState(slugify(device.observedHostname, device.deviceId))
  const [name, setName] = useState(device.observedHostname ?? device.name)
  const [category, setCategory] = useState<DeviceCategory>('computer')
  const [manufacturer, setManufacturer] = useState('')
  const [model, setModel] = useState('')
  const [location, setLocation] = useState('')
  const [roles, setRoles] = useState('')
  const [notes, setNotes] = useState('')
  const [targetSlug, setTargetSlug] = useState('')

  return (
    <form
      className="space-y-3"
      aria-label="Add device"
      onSubmit={event => {
        event.preventDefault()
        void onSubmit('device.add', {
          source_device_id: device.deviceId,
          device_id: deviceId.trim(),
          name: name.trim(),
          category,
          manufacturer: optional(manufacturer),
          model: optional(model),
          location: optional(location),
          roles: parseRoles(roles),
          notes: optional(notes),
          target_slug: targetSlug || null,
        })
      }}
    >
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Router evidence (read-only)
        </div>
        <div className="mt-1"><Evidence device={device} /></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-muted-foreground">
          Device id
          <input className={`${INPUT_CLASS} font-mono`} maxLength={64} pattern="[a-z0-9][a-z0-9._-]*" required value={deviceId} onChange={event => setDeviceId(event.target.value)} />
        </label>
        <label className="block text-xs text-muted-foreground">
          Friendly name
          <input className={INPUT_CLASS} maxLength={96} required value={name} onChange={event => setName(event.target.value)} />
        </label>
        <label className="block text-xs text-muted-foreground">
          Category
          <select className={INPUT_CLASS} value={category} onChange={event => setCategory(deviceCategorySchema.parse(event.target.value))}>
            {deviceCategorySchema.options.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted-foreground">
          Lugos target (operable systems only)
          <select className={INPUT_CLASS} value={targetSlug} onChange={event => setTargetSlug(event.target.value)}>
            <option value="">none · general inventory</option>
            {targetSlugs.map(slug => (
              <option key={slug} value={slug}>{slug}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted-foreground">
          Manufacturer
          <input className={INPUT_CLASS} maxLength={64} value={manufacturer} onChange={event => setManufacturer(event.target.value)} />
        </label>
        <label className="block text-xs text-muted-foreground">
          Model
          <input className={INPUT_CLASS} maxLength={64} value={model} onChange={event => setModel(event.target.value)} />
        </label>
        <label className="block text-xs text-muted-foreground">
          Location
          <input className={INPUT_CLASS} maxLength={64} value={location} onChange={event => setLocation(event.target.value)} />
        </label>
        <label className="block text-xs text-muted-foreground">
          Roles (comma separated)
          <input className={INPUT_CLASS} value={roles} onChange={event => setRoles(event.target.value)} />
        </label>
        <label className="block text-xs text-muted-foreground sm:col-span-2">
          Notes
          <textarea className={`${INPUT_CLASS} min-h-16`} maxLength={500} value={notes} onChange={event => setNotes(event.target.value)} />
        </label>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] text-muted-foreground">
          Add Device records identity only. It never writes a lugos-link target or changes the router.
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="submit" size="sm" disabled={submitting}>{submitting ? 'Adding…' : 'Add device'}</Button>
        </div>
      </div>
    </form>
  )
}

function MergeDeviceForm({ device, devices, submitting, onSubmit, onCancel }: FormProps) {
  const candidates = devices.filter(candidate => (
    candidate.deviceId !== device.deviceId && candidate.inventoryState !== 'merged'
  ))
  const [into, setInto] = useState(candidates[0]?.deviceId ?? '')
  return (
    <form
      className="space-y-3"
      aria-label="Merge device"
      onSubmit={event => {
        event.preventDefault()
        if (!into) return
        void onSubmit('device.merge', {
          source_device_id: device.deviceId,
          into_device_id: into,
        })
      }}
    >
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Interface evidence that will move
        </div>
        <div className="mt-1"><Evidence device={device} /></div>
      </div>
      <label className="block text-xs text-muted-foreground">
        Merge into existing device
        <select className={INPUT_CLASS} value={into} onChange={event => setInto(event.target.value)} required>
          {candidates.map(candidate => (
            <option key={candidate.deviceId} value={candidate.deviceId}>
              {candidate.name} · {candidate.deviceId} · {candidate.inventoryState}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] text-muted-foreground">
          Merge keeps every observation. The provisional record becomes a tombstone; no device is created.
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="submit" size="sm" disabled={submitting || candidates.length === 0}>
            {submitting ? 'Merging…' : 'Merge'}
          </Button>
        </div>
      </div>
    </form>
  )
}

export interface DevicesDetailProps {
  networkDevices: NetworkDevicesProjection
  targetSlugs: string[]
  canCommand: boolean
  onReceipt?: (receipt: OperatorReceipt) => void
  onReload?: () => Promise<void> | void
}

export function DevicesDetail({
  networkDevices,
  targetSlugs,
  canCommand,
  onReceipt,
  onReload,
}: DevicesDetailProps) {
  const [selection, setSelection] = useState<{ mode: 'add' | 'merge'; deviceId: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = useMemo(
    () => networkDevices.devices.find(device => device.deviceId === selection?.deviceId) ?? null,
    [networkDevices, selection],
  )
  const { source, adapter, summary } = networkDevices

  async function submit(type: 'device.add' | 'device.merge', payload: Record<string, unknown>) {
    if (!canCommand || submitting) return
    setSubmitting(true)
    try {
      const receipt = await postCommand(type, payload)
      onReceipt?.(receipt)
      await onReload?.()
      setSelection(null)
      setError(null)
    } catch {
      setError(type === 'device.add'
        ? 'Lugos did not accept the Add Device command.'
        : 'Lugos did not accept the Merge command.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className={`rounded-lg border p-3 ${source.state === 'healthy' ? 'border-border' : 'border-amber-400/40 bg-amber-400/5'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Router evidence · {adapter.router} · {adapter.kind} adapter · mutation {adapter.mutation}
          </span>
          <Pill label={source.state} tone={source.state === 'healthy' ? INVENTORY_TONE.managed : CONNECTION_TONE.unknown} />
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          Observed {formatTimestamp(source.sourceAt)} · {formatAge(source.ageSecs)} · poll {adapter.pollSecs}s · live ≤{adapter.liveAfterSecs}s · stale ≤{adapter.staleAfterSecs}s · revision {networkDevices.revision}
        </div>
        {source.diagnosticCodes.length > 0 && (
          <div className="mt-1 text-[10px] text-amber-300">
            {source.diagnosticCodes.join(' · ').replaceAll('_', ' ')}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-9">
        {(['total', 'new', 'live', 'stale', 'offline', 'unknown', 'changed', 'managed', 'randomized'] as const).map(key => (
          <div key={key} className="rounded-lg border border-border bg-background/50 px-3 py-2">
            <div className="font-mono text-lg font-semibold text-foreground">{summary[key]}</div>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{key}</div>
          </div>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>
      )}

      {!canCommand && (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          Viewer session: device evidence is visible; Add Device and Merge require an operator.
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[64rem] text-left text-xs">
          <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Device</th>
              <th className="px-3 py-2 font-medium">Observed hostname</th>
              <th className="px-3 py-2 font-medium">Address</th>
              <th className="px-3 py-2 font-medium">Connection</th>
              <th className="px-3 py-2 font-medium">First seen</th>
              <th className="px-3 py-2 font-medium">Last seen</th>
              <th className="px-3 py-2 font-medium">Reservation</th>
              <th className="px-3 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {networkDevices.devices.map(device => (
              <tr key={device.deviceId} data-device-id={device.deviceId}>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Pill label={device.connectionState} tone={CONNECTION_TONE[device.connectionState]} />
                    <Pill label={device.inventoryState} tone={INVENTORY_TONE[device.inventoryState]} />
                    {device.flags.map(flag => <Pill key={flag} label={flag} tone={FLAG_TONE[flag]} />)}
                  </div>
                </td>
                <td className="px-3 py-2 text-foreground">
                  <div className="font-semibold">{device.name}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {device.deviceId}{device.targetSlug ? ` · target ${device.targetSlug}` : ''}
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-foreground">{device.observedHostname ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-foreground">{device.currentAddress ?? '—'}</td>
                <td className="px-3 py-2 text-foreground">
                  {device.connection}
                  <div className="text-[10px] text-muted-foreground">
                    {device.interfaces.length} interface{device.interfaces.length === 1 ? '' : 's'}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{formatTimestamp(device.firstSeenAt)}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {formatTimestamp(device.lastSeenAt)}
                  <div className="text-[10px]">{formatAge(device.lastSeenAgeSecs)}</div>
                </td>
                <td className="px-3 py-2 text-foreground">{device.reservation}</td>
                <td className="px-3 py-2">
                  {canCommand && device.inventoryState === 'provisional' ? (
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Add device ${device.name}`}
                        onClick={() => setSelection({ mode: 'add', deviceId: device.deviceId })}
                      >
                        Add device
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Merge device ${device.name}`}
                        onClick={() => setSelection({ mode: 'merge', deviceId: device.deviceId })}
                      >
                        Merge
                      </Button>
                    </div>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">
                      {device.inventoryState === 'provisional' ? 'operator only' : 'identified'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {networkDevices.devices.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-7 text-center text-muted-foreground">
                  {source.state === 'healthy'
                    ? 'No devices observed yet.'
                    : 'No device evidence is available from the router source.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && selection && canCommand && (
        <section className="rounded-lg border border-cyan-400/30 bg-card/90 p-3 sm:p-4" aria-labelledby="device-action-heading">
          <h3 id="device-action-heading" className="text-xs font-semibold text-foreground">
            {selection.mode === 'add' ? 'Add device' : 'Merge device'} · {selected.name}
          </h3>
          <div className="mt-3">
            {selection.mode === 'add' ? (
              <AddDeviceForm
                key={`add:${selected.deviceId}`}
                device={selected}
                devices={networkDevices.devices}
                targetSlugs={targetSlugs}
                submitting={submitting}
                onSubmit={submit}
                onCancel={() => setSelection(null)}
              />
            ) : (
              <MergeDeviceForm
                key={`merge:${selected.deviceId}`}
                device={selected}
                devices={networkDevices.devices}
                targetSlugs={targetSlugs}
                submitting={submitting}
                onSubmit={submit}
                onCancel={() => setSelection(null)}
              />
            )}
          </div>
        </section>
      )}
    </div>
  )
}

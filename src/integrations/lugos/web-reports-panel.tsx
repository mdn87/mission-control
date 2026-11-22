'use client'

import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'

type ReportSummary = { report_id: string; title: string; job: string; created_at: string }
type Chip = {
  chip_id: string
  title: string
  stage: string
  summary: string
  waiting_on: string[]
  unlocks: string[]
  last_note?: string
}
type Money = { amount: string; currency: string } | 'unknown'
type Listing = {
  item_id: string
  title: string
  url: string
  verdict: string
  reasons: string[]
  delivered_price: string | null
  currency: string
  price: Money
  shipping: Money
}
type Report = ReportSummary & {
  milestone?: string
  available?: Chip[]
  waiting?: Chip[]
  later?: Chip[]
  warnings?: string[]
  rows?: Listing[]
  counts?: Record<string, number>
  total?: number
  tasks?: { id: number; title: string }[]
  observed_at?: string
  sources: { url: string; observed_at: string }[]
  criteria?: {
    query: string
    country?: string
    currency: string
    max_delivered?: string
    condition?: string
  }
  pagination?: { truncated: boolean }
  since?: string
  activity?: { at: string; chip_id: string; message: string }[]
  changes?: {
    entered?: string[]
    left?: string[]
    titles?: Record<string, string>
    chips?: { chip_id: string; from: string | null; to: string | null }[]
  }
}

async function request<T>(action: string, args: Record<string, unknown>): Promise<T> {
  return apiFetch<T>('/api/lugos/web-reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args }),
  })
}
const money = (value: Money) =>
  typeof value === 'object' ? value.amount + ' ' + value.currency : 'Unknown'

export function WebReportsPanel({ canRun }: { canRun: boolean }) {
  const [job, setJob] = useState<'dias' | 'marketplace' | 'task_review'>('dias')
  const [history, setHistory] = useState<ReportSummary[]>([])
  const [report, setReport] = useState<Report | null>(null)
  const [evidence, setEvidence] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    request<{ reports: ReportSummary[] }>('list', {})
      .then((x) => {
        if (live) setHistory(x.reports)
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
    return () => {
      live = false
    }
  }, [])
  async function run(action: string, args: Record<string, unknown>) {
    setBusy(true)
    setError('')
    setEvidence(null)
    try {
      if (action === 'source') setEvidence(JSON.stringify(await request(action, args), null, 2))
      else {
        const item = await request<Report>(action, args)
        setReport(item)
        setHistory((items) => [item, ...items.filter((x) => x.report_id !== item.report_id)])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the report.')
    } finally {
      setBusy(false)
    }
  }
  const inputClass = 'mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm'
  return (
    <section
      className="space-y-4 rounded-lg border border-border bg-card p-4"
      aria-label="Web reports"
    >
      <h3 className="font-semibold">Web reports</h3>
      {canRun && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            const args = Object.fromEntries(
              [...new FormData(e.currentTarget)].filter(([, v]) => String(v).trim() !== ''),
            )
            void run(job, args)
          }}
        >
          <label className="text-xs">
            Report type
            <select
              value={job}
              className={inputClass}
              onChange={(e) => setJob(e.target.value as typeof job)}
            >
              <option value="dias">Dias project work</option>
              <option value="marketplace">Marketplace comparison</option>
              <option value="task_review">Tasks in review</option>
            </select>
          </label>
          {job === 'dias' ? (
            <>
              <label className="text-xs">
                Dias project
                <input
                  name="project"
                  defaultValue="weir"
                  required
                  maxLength={64}
                  className={inputClass}
                />
              </label>
              <label className="text-xs">
                Activity since
                <input name="since" type="date" className={inputClass} />
              </label>
            </>
          ) : job === 'marketplace' ? (
            <>
              <label className="grow text-xs">
                Item or search phrase
                <input name="query" required maxLength={200} className={inputClass} />
              </label>
              <label className="text-xs">
                Max including shipping
                <input
                  name="max_delivered"
                  type="number"
                  min="0"
                  step="0.01"
                  className={inputClass}
                />
              </label>
              <label className="text-xs">
                Currency
                <input
                  name="currency"
                  defaultValue="USD"
                  pattern="[A-Z]{3}"
                  maxLength={3}
                  className={inputClass}
                />
              </label>
              <label className="text-xs">
                Item country
                <input
                  name="country"
                  placeholder="US"
                  pattern="[A-Z]{2}"
                  maxLength={2}
                  className={inputClass}
                />
              </label>
              <label className="text-xs">
                Condition
                <input name="condition" placeholder="Used" maxLength={80} className={inputClass} />
              </label>
            </>
          ) : null}
          {job !== 'task_review' && (
            <label className="max-w-72 text-xs">
              Compare with
              <select key={job} name="previous" className={inputClass}>
                <option value="">No previous report</option>
                {history
                  .filter((x) => x.job === job)
                  .map((x) => (
                    <option key={x.report_id} value={x.report_id}>
                      {x.title} · {new Date(x.created_at).toLocaleString()}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <Button disabled={busy} type="submit">
            {busy ? 'Loading…' : 'Run report'}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      {history.length > 0 && (
        <label className="block max-w-lg text-xs">
          Saved reports
          <select
            className={inputClass}
            disabled={busy}
            value={report?.report_id || ''}
            onChange={(e) => {
              if (e.target.value) void run('open', { report_id: e.target.value })
            }}
          >
            <option value="">Open a report</option>
            {history.map((x) => (
              <option key={x.report_id} value={x.report_id}>
                {x.title} · {new Date(x.created_at).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      )}
      {report && (
        <article className="space-y-3 text-sm" aria-live="polite">
          <h4 className="font-semibold">{report.title}</h4>
          <p>
            {new Date(report.observed_at || report.created_at).toLocaleString()}
            {report.counts && ' · '}
            {Object.entries(report.counts ?? {})
              .map(([k, n]) => n + ' ' + k)
              .join(' · ')}
          </p>
          {report.tasks && (
            <>
              <p>
                {report.total === 0
                  ? 'No tasks are in review.'
                  : report.tasks.length !== report.total
                    ? `Showing ${report.tasks.length} of ${report.total} tasks in review.`
                    : `${report.total} ${report.total === 1 ? 'task is' : 'tasks are'} in review.`}
              </p>
              {report.tasks.length > 0 && (
                <ul className="list-disc space-y-1 pl-5">
                  {report.tasks.map((task) => (
                    <li key={task.id}>
                      #{task.id} · {task.title}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {report.milestone && <p>{report.milestone}</p>}
          {report.warnings?.map((w) => (
            <p key={w} className="text-amber-400">
              {w}
            </p>
          ))}
          {(
            [
              ['Work you can do now', report.available],
              ['Waiting', report.waiting],
              ['Later', report.later],
            ] as const
          ).map(
            ([heading, chips]) =>
              chips &&
              chips.length > 0 && (
                <details key={heading} open={heading === 'Work you can do now'}>
                  <summary>
                    {heading} ({chips.length})
                  </summary>
                  <ul className="mt-2 space-y-2 pl-4">
                    {chips.map((c) => (
                      <li key={c.chip_id}>
                        <strong>{c.title}</strong> · {c.stage}
                        <p>{c.summary}</p>
                        {c.waiting_on.length > 0 && <p>Needs {c.waiting_on.join(', ')}</p>}
                        {c.stage === 'blocked' && c.last_note && <p>{c.last_note}</p>}
                        {c.unlocks.length > 0 && <p>Unlocks {c.unlocks.join(', ')}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
              ),
          )}
          {report.criteria && (
            <p>
              {[
                report.criteria.query,
                report.criteria.condition,
                report.criteria.country,
                report.criteria.max_delivered &&
                  'Up to ' +
                    report.criteria.max_delivered +
                    ' ' +
                    report.criteria.currency +
                    ' including shipping',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {report.pagination?.truncated && (
            <p>More listings were available beyond the retrieved pages.</p>
          )}
          {report.rows?.length === 0 && <p>The marketplace returned zero listings.</p>}
          {report.rows && (
            <div className="overflow-auto">
              <table className="w-full text-left text-xs">
                <caption className="text-left">
                  Listing prices include known shipping and exclude tax.
                </caption>
                <thead>
                  <tr>
                    {['Listing', 'Item price', 'Shipping', 'Total', 'Result'].map((k) => (
                      <th key={k} className="p-2">
                        {k}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.item_id} className="border-t border-border">
                      <td className="p-2">
                        {r.url.startsWith('https://') ? (
                          <a href={r.url} target="_blank" rel="noreferrer">
                            {r.title}
                          </a>
                        ) : (
                          r.title
                        )}
                      </td>
                      <td>{money(r.price)}</td>
                      <td>{money(r.shipping)}</td>
                      <td>
                        {r.delivered_price ? r.delivered_price + ' ' + r.currency : 'Unknown'}
                      </td>
                      <td>
                        {r.verdict} · {r.reasons.join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(['entered', 'left'] as const).map((group) => {
            const ids = report.changes?.[group]
            return (
              ids && (
                <details key={group} open={ids.length > 0}>
                  <summary>
                    {ids.length} listings {group} the matches
                  </summary>
                  <ul className="list-disc pl-5">
                    {ids.map((id) => (
                      <li key={id}>{report.changes?.titles?.[id] || id}</li>
                    ))}
                  </ul>
                </details>
              )
            )
          })}
          {report.changes?.chips && (
            <p>
              {report.changes.chips
                .map((c) => c.chip_id + ' ' + (c.from || 'new') + ' → ' + (c.to || 'removed'))
                .join(' · ') || 'No chip stage changed.'}
            </p>
          )}
          {report.activity && report.activity.length > 0 && (
            <details>
              <summary>Recent activity ({report.activity.length})</summary>
              <ul>
                {report.activity.map((a, i) => (
                  <li key={i}>
                    {a.at} · {a.chip_id} · {a.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {report.since && report.activity?.length === 0 && (
            <p>No chip activity recorded since {report.since}.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {report.sources.map((s, i) => (
              <button
                key={s.url + i}
                type="button"
                disabled={busy}
                className="underline"
                onClick={() => void run('source', { report_id: report.report_id, number: i + 1 })}
              >
                Source {i + 1} · {new Date(s.observed_at).toLocaleString()}
              </button>
            ))}
          </div>
          {evidence && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
              {evidence}
            </pre>
          )}
        </article>
      )}
    </section>
  )
}

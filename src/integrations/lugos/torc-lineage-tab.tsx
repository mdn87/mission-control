'use client'

import { useCallback, useEffect, useState } from 'react'
import { ApiError, apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { lineageIndexSchema, type LineageSummary } from './torc-contract'
import { TorcLineagePanel } from './torc-lineage-panel'

/**
 * Lineage tab: pick a lineage, then render its TORC explanation.
 *
 * The index is a stub — TORC cannot enumerate lineages yet — so the operator
 * can also explain a lineage by typing its identifier and state directory.
 */
export function TorcLineageTab() {
  const [lineages, setLineages] = useState<LineageSummary[]>([])
  const [indexError, setIndexError] = useState<string | null>(null)
  const [selected, setSelected] = useState<LineageSummary | null>(null)
  const [manualLineage, setManualLineage] = useState('')
  const [manualStateDir, setManualStateDir] = useState('')

  const loadIndex = useCallback(async () => {
    setIndexError(null)
    try {
      const body = await apiFetch('/api/lugos/lineage/list')
      const parsed = lineageIndexSchema.safeParse(body)
      if (!parsed.success) {
        setIndexError('TORC returned an unrecognized lineage index')
        return
      }
      setLineages(parsed.data.lineages)
      setSelected((current) => current ?? parsed.data.lineages[0] ?? null)
    } catch (caught) {
      setIndexError(
        caught instanceof ApiError ? caught.message : 'TORC lineage index unavailable',
      )
    }
  }, [])

  useEffect(() => {
    void loadIndex()
  }, [loadIndex])

  const explainManual = () => {
    const lineage = manualLineage.trim()
    const stateDir = manualStateDir.trim()
    if (!lineage || !stateDir) return
    setSelected({ lineage, stateDir })
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Lineage</h1>
        <p className="text-sm text-muted-foreground">
          TORC owns lineage provenance. This view is derived and read-only — it cannot
          grant, transfer, or change authority.
        </p>
      </header>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">Known lineages</h2>
          <span className="inline-flex rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
            stub
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          TORC has no enumerate-lineages contract yet, so this list is operator-configured
          via <code>LUGOS_TORC_LINEAGES</code>.
        </p>

        {indexError ? <p className="text-sm text-red-400">{indexError}</p> : null}

        {lineages.length === 0 && !indexError ? (
          <p className="text-sm text-muted-foreground">No lineages configured.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {lineages.map((entry) => {
              const active =
                selected?.lineage === entry.lineage && selected?.stateDir === entry.stateDir
              return (
                <li key={`${entry.lineage}:${entry.stateDir}`}>
                  <Button
                    variant={active ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSelected(entry)}
                  >
                    {entry.label ?? entry.lineage}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Explain a lineage directly</h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Lineage
            <input
              className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
              value={manualLineage}
              onChange={(event) => setManualLineage(event.target.value)}
              placeholder="torc-dev"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            State directory
            <input
              className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
              value={manualStateDir}
              onChange={(event) => setManualStateDir(event.target.value)}
              placeholder="p2-pilot"
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={!manualLineage.trim() || !manualStateDir.trim()}
            onClick={explainManual}
          >
            Explain
          </Button>
        </div>
      </section>

      {selected ? (
        <section className="rounded border border-border p-4">
          <TorcLineagePanel
            key={`${selected.lineage}:${selected.stateDir}`}
            lineage={selected.lineage}
            stateDir={selected.stateDir}
          />
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">Select a lineage to explain.</p>
      )}
    </div>
  )
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import {
  operatorEventSchema,
  type OperatorSnapshot,
} from './operator-contract'
import {
  EMPTY_LUGOS_OPERATOR_STATE,
  applyOperatorEvent,
  stateFromSnapshot,
  type LugosOperatorState,
} from './operator-state'

export type LugosStreamState = 'connecting' | 'live' | 'degraded'
const SNAPSHOT_POLL_MS = 30_000

export function useLugosOperator() {
  const [operatorState, setOperatorState] = useState<LugosOperatorState>(
    EMPTY_LUGOS_OPERATOR_STATE,
  )
  const [loading, setLoading] = useState(true)
  const [streamState, setStreamState] = useState<LugosStreamState>('connecting')
  const [error, setError] = useState<string | null>(null)
  const streamCursor = useRef<string | null>(null)

  const loadSnapshot = useCallback(async () => {
    try {
      const snapshot = await apiFetch<OperatorSnapshot>('/api/lugos/snapshot')
      const next = stateFromSnapshot(snapshot)
      streamCursor.current = next.cursor
      setOperatorState(next)
      setError(null)
    } catch {
      setError('Lugos operator snapshot is unavailable.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSnapshot()
  }, [loadSnapshot])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadSnapshot()
    }, SNAPSHOT_POLL_MS)
    return () => window.clearInterval(timer)
  }, [loadSnapshot])

  useEffect(() => {
    if (loading) return
    const after = streamCursor.current
      ? `?after=${encodeURIComponent(streamCursor.current)}`
      : ''
    const source = new EventSource(`/api/lugos/events${after}`)
    const onOperatorEvent = (message: MessageEvent<string>) => {
      try {
        const event = operatorEventSchema.parse(JSON.parse(message.data))
        streamCursor.current = event.cursor
        setOperatorState(current => applyOperatorEvent(current, event))
        setStreamState('live')
        setError(null)
      } catch {
        setStreamState('degraded')
        setError('The Lugos event stream returned an incompatible contract.')
      }
    }
    const onReset = () => {
      source.close()
      setStreamState('connecting')
      setLoading(true)
      void loadSnapshot()
    }
    source.addEventListener('operator', onOperatorEvent as EventListener)
    source.addEventListener('reset', onReset)
    source.onopen = () => setStreamState('live')
    source.onerror = () => setStreamState('degraded')
    return () => source.close()
  }, [loading, loadSnapshot])

  return {
    operatorState,
    setOperatorState,
    loading,
    streamState,
    error,
    setError,
    reload: loadSnapshot,
  }
}

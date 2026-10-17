'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import {
  operatorEventSchema,
  operatorResetSchema,
  type OperatorEvent,
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
  // A superseded snapshot request has no effects; the latest one applies and
  // replays only the stream events it has not seen (equality on cursors only).
  const requestGeneration = useRef(0)
  const overlap = useRef<{ cursorAtRequest: string | null, events: OperatorEvent[] } | null>(null)
  const [streamGeneration, setStreamGeneration] = useState(0)

  const loadSnapshot = useCallback(async () => {
    const generation = ++requestGeneration.current
    overlap.current = { cursorAtRequest: streamCursor.current, events: [] }
    try {
      const snapshot = await apiFetch<OperatorSnapshot>('/api/lugos/snapshot')
      if (generation !== requestGeneration.current) return
      let next = stateFromSnapshot(snapshot)
      const { cursorAtRequest, events } = overlap.current ?? { cursorAtRequest: null, events: [] }
      const seen = events.findIndex(event => event.cursor === next.cursor)
      const fresher = next.cursor !== cursorAtRequest && seen === -1
      const replay = next.cursor === cursorAtRequest
        ? events
        : fresher ? [] : events.slice(seen + 1)
      for (const event of replay) next = applyOperatorEvent(next, event)
      streamCursor.current = next.cursor
      overlap.current = null
      setOperatorState(next)
      setError(null)
      if (fresher) setStreamGeneration(value => value + 1)
    } catch {
      if (generation !== requestGeneration.current) return
      overlap.current = null
      setError('Lugos operator snapshot is unavailable.')
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
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
        overlap.current?.events.push(event)
        setOperatorState(current => applyOperatorEvent(current, event))
        setStreamState('live')
        setError(null)
      } catch {
        setStreamState('degraded')
        setError('The Lugos event stream returned an incompatible contract.')
      }
    }
    const onReset = (message: MessageEvent<string>) => {
      try {
        operatorResetSchema.parse(JSON.parse(message.data))
        source.close()
        setStreamState('connecting')
        // The server has expired this cursor; reopening with it would only earn
        // another reset. With no cursor the stream replays its whole ring.
        streamCursor.current = null
        setLoading(true)
        void loadSnapshot()
      } catch {
        setStreamState('degraded')
        setError('The Lugos event stream returned an incompatible reset contract.')
      }
    }
    source.addEventListener('operator', onOperatorEvent as EventListener)
    source.addEventListener('reset', onReset as EventListener)
    source.onopen = () => setStreamState('live')
    source.onerror = () => setStreamState('degraded')
    return () => source.close()
  }, [loading, loadSnapshot, streamGeneration])

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

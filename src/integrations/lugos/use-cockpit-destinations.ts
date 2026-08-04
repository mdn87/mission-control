'use client'

import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import {
  cockpitDestinationsSchema,
  type CockpitDestination,
  type CockpitDestinations,
} from './cockpit-destinations'

export function useCockpitDestinations(): CockpitDestination[] {
  const [destinations, setDestinations] = useState<CockpitDestination[]>([])

  useEffect(() => {
    let active = true
    void apiFetch<CockpitDestinations>('/api/lugos/destinations')
      .then(value => cockpitDestinationsSchema.parse(value))
      .then(value => {
        if (active) setDestinations(value.destinations)
      })
      .catch(() => {
        if (active) setDestinations([])
      })
    return () => {
      active = false
    }
  }, [])

  return destinations
}

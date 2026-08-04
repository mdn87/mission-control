import { z } from 'zod'

export const COCKPIT_DESTINATIONS_SCHEMA = 'lugos-cockpit-destinations/v1'

const destinationId = z.enum([
  'memory',
  'traces',
  'files',
  'vision',
  'media',
  'workflows',
])

export const cockpitDestinationsSchema = z.object({
  schema: z.literal(COCKPIT_DESTINATIONS_SCHEMA),
  destinations: z.array(z.object({
    id: destinationId,
    label: z.string().min(1).max(48),
    description: z.string().min(1).max(160),
    href: z.string().url().nullable(),
  }).strict()).length(6),
}).strict()

export type CockpitDestinations = z.infer<typeof cockpitDestinationsSchema>
export type CockpitDestination = CockpitDestinations['destinations'][number]

const DEFINITIONS = [
  {
    id: 'memory',
    label: 'Memory',
    description: 'Sulis and Atlas remain authoritative.',
    env: 'MC_LUGOS_MEMORY_PUBLIC_URL',
  },
  {
    id: 'traces',
    label: 'Traces',
    description: 'Use Jaeger for spans and waterfalls.',
    env: 'MC_LUGOS_TRACES_PUBLIC_URL',
  },
  {
    id: 'files',
    label: 'File operations',
    description: 'Use Codelink for shares and transfers.',
    env: 'MC_LUGOS_FILES_PUBLIC_URL',
  },
  {
    id: 'vision',
    label: 'Vision',
    description: 'Use Remotedesk for screen and vision operations.',
    env: 'MC_LUGOS_VISION_PUBLIC_URL',
  },
  {
    id: 'media',
    label: 'Media',
    description: 'Use the media generation tools.',
    env: 'MC_LUGOS_MEDIA_PUBLIC_URL',
  },
  {
    id: 'workflows',
    label: 'Workflows',
    description: 'Use the composed workflow tooling.',
    env: 'MC_LUGOS_WORKFLOWS_PUBLIC_URL',
  },
] as const

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '::1' || normalized.endsWith('.local')) {
    return true
  }
  const parts = normalized.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return false
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
}

function approvedPublicUrl(value: string | undefined): string | null {
  if (!value) return null
  const url = new URL(value)
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || isPrivateHostname(url.hostname)) {
    throw new TypeError('cockpit destination must be a credential-free public HTTPS URL')
  }
  return url.toString()
}

export function loadCockpitDestinations(
  env: Record<string, string | undefined> = process.env,
): CockpitDestinations {
  return cockpitDestinationsSchema.parse({
    schema: COCKPIT_DESTINATIONS_SCHEMA,
    destinations: DEFINITIONS.map(definition => ({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      href: approvedPublicUrl(env[definition.env]),
    })),
  })
}

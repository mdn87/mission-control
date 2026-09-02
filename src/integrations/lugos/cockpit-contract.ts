import { z } from 'zod'

export const FLEET_PROJECTION_SCHEMA = 'lugos-fleet/v1'
export const DIAGNOSTICS_PROJECTION_SCHEMA = 'lugos-cockpit-diagnostics/v1'
export const BRAN_READINESS_PROJECTION_SCHEMA = 'lugos-bran-checkout-readiness/v1'

const identifier = z.string().min(1).max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/)
const code = z.string().min(1).max(96).regex(/^[a-z][a-z0-9._-]*$/)
const slug = z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._-]*$/)
const timestamp = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
).refine(value => Number.isFinite(Date.parse(value)), 'Invalid UTC timestamp')
const nullableTimestamp = timestamp.nullable()
const nonnegativeInteger = z.number().int().nonnegative()
const nullableInteger = nonnegativeInteger.nullable()
const diagnostics = z.array(code).max(32)

export const cockpitStateSchema = z.enum([
  'ready',
  'healthy',
  'idle',
  'active',
  'attention',
  'stale',
  'degraded',
  'blocked',
  'unavailable',
  'unknown',
])

const sourceState = z.enum(['healthy', 'degraded', 'stale', 'unavailable', 'unknown'])

export const cockpitSourceSchema = z.object({
  state: sourceState,
  sourceAt: nullableTimestamp,
  observedAt: nullableTimestamp,
  lastSuccessAt: nullableTimestamp,
  projectedAt: timestamp,
  ageSecs: nullableInteger,
  staleAfterSecs: z.number().int().positive().nullable(),
  diagnosticCodes: diagnostics,
}).strict()

const fleetAgentSchema = z.object({
  agentAddress: identifier,
  host: identifier,
  tool: identifier,
  sessionId: identifier,
  repo: z.string().min(1).max(128).nullable(),
  branch: z.string().min(1).max(128).nullable(),
  task: z.string().min(1).max(256).nullable(),
  model: z.string().min(1).max(128).nullable(),
  presence: z.enum(['active', 'stale', 'unknown']),
  updatedAt: nullableTimestamp,
  ageSecs: nullableInteger,
}).strict()

const fleetHandoffSchema = z.object({
  messageId: z.number().int().positive(),
  threadId: identifier,
  fromAgent: identifier,
  toAgent: identifier,
  kind: code.nullable(),
  contextId: identifier.nullable(),
  preview: z.string().min(1).max(203),
  responseRequested: z.boolean(),
  createdAt: timestamp,
  ageSecs: nonnegativeInteger,
}).strict()

const expectedServiceSchema = z.object({
  name: identifier,
  expectedState: z.enum(['running', 'ready', 'planned', 'pending', 'unknown']),
}).strict()

const observedServiceSchema = z.object({
  name: identifier,
  state: cockpitStateSchema,
  checkedAt: nullableTimestamp,
  ageSecs: nullableInteger,
  diagnosticCodes: diagnostics,
}).strict()

const fleetTargetSchema = z.object({
  slug,
  label: z.string().min(1).max(128),
  osFamily: code.nullable(),
  roles: z.array(code.max(64)).max(32),
  lanAddress: z.string().min(1).max(64).nullable(),
  state: cockpitStateSchema,
  diagnosticCodes: diagnostics,
  expectedServices: z.array(expectedServiceSchema).max(64),
  observedServices: z.array(observedServiceSchema).max(64),
}).strict()

export const fleetProjectionSchema = z.object({
  schema: z.literal(FLEET_PROJECTION_SCHEMA),
  generatedAt: timestamp,
  sources: z.object({
    agentMail: cockpitSourceSchema,
    inventory: cockpitSourceSchema,
    runtime: cockpitSourceSchema,
  }).strict(),
  summary: z.object({
    connectedAgents: nonnegativeInteger,
    staleAgents: nonnegativeInteger,
    pendingHandoffs: nonnegativeInteger,
    responseRequestedHandoffs: nonnegativeInteger,
    targets: nonnegativeInteger,
    targetExceptions: nonnegativeInteger,
  }).strict(),
  agents: z.array(fleetAgentSchema).max(256),
  handoffScope: z.object({
    mode: z.literal('bounded_unacked_inbox'),
    horizonHours: z.number().nonnegative().nullable(),
    pageLimit: z.number().int().min(1).max(100),
    truncated: z.boolean(),
  }).strict(),
  handoffs: z.array(fleetHandoffSchema).max(100),
  targets: z.array(fleetTargetSchema).max(64),
}).strict()

const governanceSchema = z.object({
  governanceId: z.string().min(1).max(128).nullable(),
  policyVersion: z.string().min(1).max(128).nullable(),
  status: z.string().min(1).max(128).nullable(),
  policyDigest: z.string().min(1).max(128).nullable(),
  warningMultiplier: z.number().nonnegative().nullable(),
  stopMultiplier: z.number().nonnegative().nullable(),
  verticalSliceBudgetFraction: z.number().nonnegative().nullable(),
  maxDesignReviewRounds: nullableInteger,
  scopeChangeApprover: z.string().min(1).max(128).nullable(),
  scopeChangeTriggers: z.array(code).max(32),
  routingPolicy: z.object({
    schemaVersion: z.string().min(1).max(96).nullable(),
    defaultTaskClass: z.string().min(1).max(96).nullable(),
    defaultRiskTier: z.string().min(1).max(96).nullable(),
    outputCharacterLimit: nullableInteger,
    latencyOptInRoute: z.string().min(1).max(96).nullable(),
    routes: z.array(z.object({
      taskClass: z.string().min(1).max(96),
      riskTier: z.string().min(1).max(96),
      route: z.string().min(1).max(96),
      serviceTier: z.string().min(1).max(96),
    }).strict()).max(64),
  }).strict(),
  activeExceptions: z.array(z.object({
    code,
    runId: identifier.nullable(),
    assignmentId: identifier.nullable(),
    state: cockpitStateSchema,
    observedAt: timestamp,
  }).strict()).max(32),
}).strict()

const repositorySchema = z.object({
  repoId: identifier,
  name: z.string().min(1).max(128),
  kind: z.enum(['parent', 'submodule']),
  branch: identifier.nullable(),
  head: identifier.nullable(),
  upstream: identifier.nullable(),
  ahead: nonnegativeInteger,
  behind: nonnegativeInteger,
  dirty: z.boolean(),
  pointerState: z.enum(['match', 'drift', 'unknown', 'not_applicable']),
  checkState: z.enum(['passing', 'failing', 'pending', 'unavailable', 'unknown']),
  signals: diagnostics,
  observedAt: timestamp,
  detailRef: identifier.nullable(),
}).strict()

const monitorSchema = z.object({
  monitorId: identifier,
  name: z.string().min(1).max(128),
  plane: z.enum(['direct', 'public', 'other']),
  targetRef: identifier.nullable(),
  state: cockpitStateSchema,
  uptime24h: z.number().min(0).max(1).nullable(),
  lastHeartbeatAt: nullableTimestamp,
  ageSecs: nullableInteger,
  staleAfterSecs: z.number().int().positive().nullable(),
  diagnosticCodes: diagnostics,
  detailRef: identifier.nullable(),
}).strict()

const modelSummarySchema = z.object({
  state: cockpitStateSchema,
  configured: z.boolean(),
  listed: z.boolean(),
  checkedAt: nullableTimestamp,
  ageSecs: nullableInteger,
  diagnosticCodes: diagnostics,
}).strict()

export const diagnosticsProjectionSchema = z.object({
  schema: z.literal(DIAGNOSTICS_PROJECTION_SCHEMA),
  generatedAt: timestamp,
  sources: z.object({
    autosync: cockpitSourceSchema,
    governance: cockpitSourceSchema,
    repositories: cockpitSourceSchema,
    monitors: cockpitSourceSchema,
    models: cockpitSourceSchema,
  }).strict(),
  autosync: z.object({
    state: cockpitStateSchema,
    lastTickAt: nullableTimestamp,
    lastSuccessAt: nullableTimestamp,
    lastAdvanceAt: nullableTimestamp,
    lastAlertAt: nullableTimestamp,
    ageSecs: nullableInteger,
    nextExpectedAt: nullableTimestamp,
    repositoryRef: identifier.nullable(),
    diagnosticCodes: diagnostics,
  }).strict(),
  governance: governanceSchema,
  repositories: z.object({
    summary: z.object({
      total: nonnegativeInteger,
      ready: nonnegativeInteger,
      attention: nonnegativeInteger,
      dirty: nonnegativeInteger,
      ahead: nonnegativeInteger,
      behind: nonnegativeInteger,
      detached: nonnegativeInteger,
      missingUpstream: nonnegativeInteger,
      pointerDrift: nonnegativeInteger,
      checksFailing: nonnegativeInteger,
      checksPending: nonnegativeInteger,
      unknown: nonnegativeInteger,
    }).strict(),
    exceptions: z.array(repositorySchema).max(128),
  }).strict(),
  monitors: z.object({
    summary: z.object({
      total: nonnegativeInteger,
      healthy: nonnegativeInteger,
      degraded: nonnegativeInteger,
      stale: nonnegativeInteger,
      unavailable: nonnegativeInteger,
      unknown: nonnegativeInteger,
      directState: cockpitStateSchema,
      publicState: cockpitStateSchema,
    }).strict(),
    monitors: z.array(monitorSchema).max(128),
  }).strict(),
  models: z.object({
    gateway: modelSummarySchema,
    ollama: modelSummarySchema,
    gemini: modelSummarySchema,
    aliases: z.array(z.object({
      alias: identifier,
      provider: identifier,
      backendModel: identifier,
      hostRef: identifier,
      configured: z.boolean(),
      listed: z.boolean(),
      state: cockpitStateSchema,
      fallbackAliases: z.array(identifier).max(16),
      diagnosticCodes: diagnostics,
    }).strict()).max(64),
  }).strict(),
}).strict()

export const branReadinessProjectionSchema = z.object({
  schema: z.literal(BRAN_READINESS_PROJECTION_SCHEMA),
  generatedAt: timestamp,
  source: cockpitSourceSchema,
  summary: z.object({
    total: nonnegativeInteger,
    ready: nonnegativeInteger,
    stale: nonnegativeInteger,
    blocked: nonnegativeInteger,
    assigned: nonnegativeInteger,
    unknown: nonnegativeInteger,
  }).strict(),
  packs: z.array(z.object({
    packId: slug,
    title: z.string().min(1).max(160),
    latestRef: z.string().regex(/^[a-z0-9][a-z0-9._-]*@[1-9][0-9]*$/),
    latestVersion: z.number().int().positive(),
    readyRef: z.string().regex(/^[a-z0-9][a-z0-9._-]*@[1-9][0-9]*$/).nullable(),
    versionCount: z.number().int().positive(),
    status: z.enum(['ready', 'stale', 'blocked', 'assigned', 'unknown']),
    sourceType: z.string().min(1).max(96).nullable(),
    sourceAuthority: z.string().min(1).max(96).nullable(),
    trustTier: z.string().min(1).max(96).nullable(),
    freshnessPolicy: z.string().min(1).max(96).nullable(),
    publishedAt: nullableTimestamp,
    importedAt: nullableTimestamp,
    ageSecs: nullableInteger,
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    custodyState: z.enum(['valid', 'invalid', 'missing', 'outside_root', 'unknown']),
    assignmentState: z.enum(['unsupported', 'unassigned', 'assigned', 'unknown']),
    lastCheckoutAt: nullableTimestamp,
    lastCheckoutAgent: identifier.nullable(),
    blockingCodes: diagnostics,
    detailRef: identifier.nullable(),
  }).strict()).max(256),
}).strict()

export const NETWORK_DEVICES_PROJECTION_SCHEMA = 'lugos-network-devices/v1'

const deviceSlug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/)
const macAddress = z.string().regex(/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/)
const ipv4 = z.string().regex(/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/)
const observedHostname = z.string().min(1).max(63).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

export const deviceInventoryStateSchema = z.enum(['provisional', 'identified', 'managed', 'merged'])
export const deviceConnectionStateSchema = z.enum(['live', 'stale', 'offline', 'unknown'])
export const deviceFlagSchema = z.enum(['new', 'changed', 'randomized_mac'])
export const deviceCategorySchema = z.enum([
  'computer',
  'phone',
  'tablet',
  'printer',
  'tv',
  'router',
  'switch',
  'kvm',
  'iot',
  'appliance',
  'other',
])
const reservationState = z.enum(['reserved', 'dynamic', 'unknown'])
const connectionKind = z.enum(['ethernet', 'wifi', 'unknown'])

const networkInterfaceSchema = z.object({
  interfaceId: deviceSlug,
  kind: connectionKind,
  mac: macAddress,
  privateAddress: z.boolean(),
  connectionState: deviceConnectionStateSchema,
  currentAddress: ipv4.nullable(),
  observedHostname: observedHostname.nullable(),
  connection: connectionKind,
  ssid: z.string().min(1).max(32).nullable(),
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
  leaseExpiresAt: nullableTimestamp,
  reservation: reservationState,
  observationCount: z.number().int().positive(),
}).strict()

const networkDeviceSchema = z.object({
  deviceId: deviceSlug,
  name: z.string().min(1).max(96),
  inventoryState: deviceInventoryStateSchema,
  connectionState: deviceConnectionStateSchema,
  flags: z.array(deviceFlagSchema).max(3),
  category: deviceCategorySchema.nullable(),
  manufacturer: z.string().min(1).max(64).nullable(),
  model: z.string().min(1).max(64).nullable(),
  location: z.string().min(1).max(64).nullable(),
  roles: z.array(code.max(64)).max(16),
  targetSlug: deviceSlug.nullable(),
  mergedInto: deviceSlug.nullable(),
  firstSeenAt: nullableTimestamp,
  lastSeenAt: nullableTimestamp,
  lastSeenAgeSecs: nullableInteger,
  currentAddress: ipv4.nullable(),
  observedHostname: observedHostname.nullable(),
  connection: connectionKind,
  reservation: reservationState,
  observationCount: nonnegativeInteger,
  interfaces: z.array(networkInterfaceSchema).max(16),
  diagnosticCodes: diagnostics,
}).strict()

export const networkDevicesProjectionSchema = z.object({
  schema: z.literal(NETWORK_DEVICES_PROJECTION_SCHEMA),
  generatedAt: timestamp,
  revision: nonnegativeInteger,
  source: cockpitSourceSchema,
  adapter: z.object({
    kind: z.enum(['fixture', 'live', 'off']),
    router: deviceSlug,
    pollSecs: z.number().int().positive(),
    liveAfterSecs: z.number().int().positive(),
    staleAfterSecs: z.number().int().positive(),
    mutation: z.literal('none'),
  }).strict(),
  summary: z.object({
    total: nonnegativeInteger,
    new: nonnegativeInteger,
    live: nonnegativeInteger,
    stale: nonnegativeInteger,
    offline: nonnegativeInteger,
    unknown: nonnegativeInteger,
    changed: nonnegativeInteger,
    managed: nonnegativeInteger,
    randomized: nonnegativeInteger,
  }).strict(),
  devices: z.array(networkDeviceSchema).max(512),
}).strict()

export type CockpitState = z.infer<typeof cockpitStateSchema>
export type CockpitSource = z.infer<typeof cockpitSourceSchema>
export type FleetProjection = z.infer<typeof fleetProjectionSchema>
export type DiagnosticsProjection = z.infer<typeof diagnosticsProjectionSchema>
export type BranReadinessProjection = z.infer<typeof branReadinessProjectionSchema>
export type NetworkDevicesProjection = z.infer<typeof networkDevicesProjectionSchema>
export type NetworkDevice = NetworkDevicesProjection['devices'][number]
export type NetworkDeviceInterface = NetworkDevice['interfaces'][number]
export type DeviceCategory = z.infer<typeof deviceCategorySchema>

// @vitest-environment node
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { chromium } from '@playwright/test'
import { expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { createSession, validateSession } from '@/lib/auth'
import { hashPassword } from '@/lib/password'
import { registrationOptions, verifyPasskeyRegistration } from '@/lib/webauthn/remote-passkeys'
import { GET, POST } from '@/app/api/lugos/field-review/route'
import { issueCurrentFieldReview } from '@/relay/field-issuer'
import type { FieldReview } from './field-review'

const { db } = vi.hoisted(() => ({ db: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDatabase: db }))
const exchange = process.env.WEIR_TEST_OWNER_EXCHANGE
const rp = 'field-owner.test'
const origin = 'https://' + rp

it.skipIf(!exchange)('uses two separate Chromium passkey assertions on the private Linux fixture', async () => {
  if (process.platform !== 'linux' || !/^\/var\/tmp\/weir-field-exchange-[a-f0-9]{16}$/.test(exchange!)) {
    throw new Error('This test requires a disposable native fixture')
  }
  const database = new Database(':memory:')
  db.mockReturnValue(database)
  const browser = await chromium.launch({ executablePath: process.env.WEIR_TEST_CHROMIUM, chromiumSandbox: true })
  try {
    vi.stubEnv('MC_WEIR_FIELD_REHEARSAL_ENABLED', 'true')
    vi.stubEnv('MC_REMOTE_WEBAUTHN_ENABLED', 'true')
    vi.stubEnv('MC_WEBAUTHN_RP_ID', rp)
    vi.stubEnv('MC_WEBAUTHN_ORIGIN', origin)
    vi.stubEnv('MC_WEIR_FIELD_OWNER', 'mc:user:1')
    vi.stubEnv('MC_WEIR_FIELD_DEVICE', 'field-rehearsal-linux')
    vi.stubEnv('MC_WEIR_FIELD_REVIEW_DIR', exchange + '/review')
    vi.stubEnv('MC_WEIR_FIELD_STEPUP_DIR', exchange + '/stepups')
    runMigrations(database)
    const password = randomBytes(32).toString('hex')
    database.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, provider, is_approved, workspace_id)
        VALUES (1, 'fixture-owner', 'Fixture owner', ?, 'operator', 'local', 1, 1)`).run(hashPassword(password))
    const token = createSession(1, undefined, undefined, 1).token
    const user = validateSession(token)!
    const request = (body?: unknown, cookie = token) => new Request(origin + '/api/lugos/field-review', {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, host: rp, cookie: '__Host-mc-session=' + cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    vi.stubEnv('MC_WEIR_FIELD_REHEARSAL_ENABLED', 'false')
    expect((await GET(request())).status).toBe(404)
    vi.stubEnv('MC_WEIR_FIELD_REHEARSAL_ENABLED', 'true')
    expect((await GET(request(undefined, 'missing'))).status).toBe(401)
    vi.stubEnv('MC_WEIR_FIELD_OWNER', 'mc:user:2')
    expect((await GET(request())).status).toBe(403)
    vi.stubEnv('MC_WEIR_FIELD_OWNER', 'mc:user:1')
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', route => route.request().url() === origin + '/'
      ? route.fulfill({ contentType: 'text/html', body: '<title>Disposable passkey rehearsal</title>' })
      : route.abort())
    const page = await context.newPage()
    await page.goto(origin)
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
    const create = await registrationOptions(user, password)
    const credential = await page.evaluate(async options => {
      const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options as PublicKeyCredentialCreationOptionsJSON)
      return (await navigator.credentials.create({ publicKey }) as PublicKeyCredential).toJSON()
    }, create.options)
    expect((await verifyPasskeyRegistration(user, create.challenge_id, credential)).verified).toBe(true)
    for (const phase of ['enroll', 'fill']) {
      let review: FieldReview | undefined
      await expect.poll(async () => {
        const result = await GET(request())
        if (result.ok) review = (await result.json()).review
        return review?.phase
      }, { timeout: 85_000, interval: 350 }).toBe(phase)
      const hash = review!.review_hash
      vi.stubEnv('MC_WEIR_FIELD_STEPUP_UID', String(process.geteuid!()))
      expect(() => issueCurrentFieldReview()).toThrow('field_stepup_principal_unconfigured')
      expect(new URL(review!.url).hostname).toBe('field.test')
      const challenge = await POST(request({ operation: 'options', review_hash: hash }))
      expect(challenge.status).toBe(200)
      // An owner can read the proposal for longer than WEIR's 30-second revocation freshness window.
      if (phase === 'fill') await new Promise(resolve => setTimeout(resolve, 32_000))
      const { challenge_id, options } = await challenge.json()
      const assertion = await page.evaluate(async json => {
        const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(json)
        return (await navigator.credentials.get({ publicKey }) as PublicKeyCredential).toJSON()
      }, options)
      const decision = { operation: 'approve', review_hash: hash, challenge_id, response: assertion }
      expect((await POST(request({ ...decision, review_hash: 'sha256:' + '0'.repeat(64) }))).status).toBe(409)
      const approved = await POST(request(decision))
      expect(await approved.json()).toEqual({ state: 'approved', review_hash: hash })
      expect(approved.status).toBe(202)
      expect((await POST(request(decision))).status).not.toBe(202)
    }
    const records = database.prepare('SELECT DISTINCT step_up_ref FROM remote_decision_step_up_grants WHERE consumed_at IS NOT NULL').all()
    expect(records).toHaveLength(2)
  } finally {
    await browser.close()
    database.close()
    vi.unstubAllEnvs()
  }
}, 200_000)

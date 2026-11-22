// @vitest-environment node
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { approve, commitTitle, fence, initializeSite, prepare, source, titleText } from './saved-task-store'

const binding = { deployment: 'fixture-demo', tenant_id: 1, workspace_id: 1, actor_id: 'mc:user:1' }
const step = 'sha256:' + 'a'.repeat(64)
let dir: string, file: string, db: Database.Database
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-saved-task-'))
  file = join(dir, 'fixture.db')
  initializeSite(file, binding)
  db = new Database(file)
})
afterEach(() => {
  vi.useRealTimers()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

it('leaves the old title when the owner has not approved or the signed intent expires', () => {
  const a = prepare(db, binding, { after: 'Updated title' })
  expect(
    commitTitle(db, a.view.command_id, () => {
      throw Error('unexpected')
    })
  ).toEqual({ state: 'pending' })
  approve(db, a.view.command_id, a.proposal_hash, step, a.view.issued_at + 60)
  vi.useFakeTimers()
  vi.setSystemTime(new Date(a.view.expires_at * 1000))
  expect(
    commitTitle(db, a.view.command_id, () => {
      throw Error('expired')
    })
  ).toEqual({ state: 'expired' })
  expect(source(db, a.view.command_id).task.title).toBe('Initial title')
})

it('serializes one change per revision and records a terminal refusal for older approvals', () => {
  const a = prepare(db, binding, { after: 'Updated title' }),
    b = prepare(db, binding, { after: 'Other title' })
  for (const r of [a, b]) approve(db, r.view.command_id, r.proposal_hash, step, r.view.issued_at + 60)
  expect(() =>
    commitTitle(db, a.view.command_id, () => {
      throw Error('bad authority')
    })
  ).toThrow()
  expect(source(db, a.view.command_id).receipt).toBeNull()
  expect(commitTitle(db, a.view.command_id, () => {})).toEqual({ state: 'committed' })
  expect(commitTitle(db, b.view.command_id, () => {})).toEqual({ state: 'stale' })
  db.close()
  db = new Database(file)
  const stored = source(db, a.view.command_id)
  expect(stored.receipt).toMatchObject({ after: 'Updated title', revision: 2 })
  expect(
    commitTitle(db, a.view.command_id, () => {
      throw Error('already done')
    })
  ).toEqual({ state: 'committed' })
  const undo = prepare(db, binding, { undo_of: a.view.command_id })
  expect(undo.view.after).toBe('Initial title')
  expect(undo.state).toBe('pending')
  approve(db, undo.view.command_id, undo.proposal_hash, step, undo.view.issued_at + 60)
  commitTitle(db, undo.view.command_id, () => {})
  expect(source(db, a.view.command_id).task).toMatchObject({ title: 'Initial title', revision: 3 })
  expect(source(db, a.view.command_id).receipt).toEqual(stored.receipt)
  expect(prepare(db, binding, { undo_of: a.view.command_id }).state).toBe('stale')
})

it('fences withdrawal, expiry, malformed text and existing database files', () => {
  expect(() => initializeSite(file, binding)).toThrow()
  const a = prepare(db, binding, { after: 'Changed' })
  approve(db, a.view.command_id, a.proposal_hash, step, a.view.issued_at + 60)
  expect(fence(db, a.view.command_id, a.proposal_hash).state).toBe('withdrawn')
  expect(
    commitTitle(db, a.view.command_id, () => {
      throw Error('withdrawn')
    })
  ).toEqual({ state: 'withdrawn' })
  const b = prepare(db, binding, { after: 'Decline' })
  expect(fence(db, b.view.command_id, b.proposal_hash).state).toBe('declined')
  for (const invalid of ['a '.repeat(2), 'a\u200db', 'e\u0301', 'a'.repeat(501), '\ud800']) {
    expect(titleText.safeParse(invalid).success).toBe(false)
  }
  expect(titleText.safeParse('é'.repeat(500)).success).toBe(true)
})

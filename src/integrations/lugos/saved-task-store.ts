import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { closeSync, openSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { canonicalDigest } from './remote-decision-contract'

export const savedAction = 'rename-private-task-v1'
export const savedAudience = 'weir.rehearsal.saved-task'
export const commandId = z.string().regex(/^saved-[0-9a-f]{32}$/)
export const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/)
export const titleText = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (s) =>
      s === s.trim() &&
      s === s.normalize('NFC') &&
      !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(s),
    'Use a title that can be displayed exactly.'
  )
const marker = 'weir.private-task-site/v1'
type Db = Database.Database
export const seconds = () => Math.floor(Date.now() / 1000)

export type Binding = { deployment: string; tenant_id: number; workspace_id: number; actor_id: string }
type Task = { generation: string; revision: number; title: string }
export type Review = Binding & {
  command_id: string
  schema: string
  action_id: string
  task_id: string
  generation: string
  revision: number
  before: string
  after: string
  undo_of: string | null
  delivery: string
  data_class: string
  use_limit: number
  issued_at: number
  expires_at: number
  work_context_hash: string
}
export type Receipt = Pick<Review, 'command_id' | 'generation' | 'before' | 'after'> & {
  proposal_hash: string
  revision: number
  saved_at: number
}
type Row = {
  proposal_hash: string
  view: string
  state: string
  step_up_ref: string | null
  grant_expires: number | null
  receipt: string | null
}

export function initializeSite(file: string, binding: Binding) {
  z.object({
    deployment: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    actor_id: z.string().regex(/^mc:user:[1-9]\d*$/),
    tenant_id: z.number().int().positive(),
    workspace_id: z.number().int().positive(),
  })
    .strict()
    .parse(binding)
  if (!isAbsolute(file)) throw new Error('A fresh absolute rehearsal database is required.')
  closeSync(openSync(file, 'wx', 0o600))
  const db = new Database(file, { fileMustExist: true })
  try {
    db.transaction(() => {
      db.exec(
        'CREATE TABLE weir_saved_site (id INTEGER PRIMARY KEY CHECK(id=1), schema TEXT, binding TEXT);' +
          'CREATE TABLE weir_saved_task (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT, revision INTEGER, title TEXT);' +
          'CREATE TABLE weir_saved_reviews (command_id TEXT PRIMARY KEY, proposal_hash TEXT UNIQUE NOT NULL, view TEXT NOT NULL,' +
          'state TEXT NOT NULL, step_up_ref TEXT, grant_expires INTEGER, receipt TEXT);'
      )
      db.prepare('INSERT INTO weir_saved_site VALUES (1, ?, ?)').run(marker, JSON.stringify(binding))
      db.prepare('INSERT INTO weir_saved_task VALUES (1, ?, 1, ?)').run(
        randomBytes(16).toString('hex'),
        'Initial title'
      )
    })()
  } finally {
    db.close()
  }
}

export function configuredSite() {
  return (
    process.env.MC_WEIR_SAVED_TASK_REHEARSAL === 'true' &&
    process.env.MC_WEBAUTHN_RP_ID === 'saved-task.test' &&
    process.env.MC_WEBAUTHN_ORIGIN === 'https://saved-task.test'
  )
}

export function withSite<T>(writable: boolean, operation: (db: Db, binding: Binding) => T): T {
  const file = process.env.MC_WEIR_SAVED_TASK_DB
  if (
    !configuredSite() ||
    !file ||
    !isAbsolute(file) ||
    realpathSync(file) !== resolve(file) ||
    process.env.MISSION_CONTROL_DB_PATH !== file
  )
    throw new Error('Private task site unavailable.')
  const db = new Database(file, { readonly: !writable, fileMustExist: true })
  try {
    const row = db.prepare('SELECT schema, binding FROM weir_saved_site WHERE id=1').get() as
      | { schema: string; binding: string }
      | undefined
    if (row?.schema !== marker) throw new Error('Private task site unavailable.')
    return operation(db, JSON.parse(row.binding))
  } finally {
    db.close()
  }
}

export const bindingDigest = (hash: string) =>
  canonicalDigest({ purpose: 'weir-saved-task-owner-review/v1', proposal_hash: hash })
export const currentTask = (db: Db) =>
  db.prepare('SELECT generation, revision, title FROM weir_saved_task WHERE id=1').get() as Task

export function source(db: Db, command: string, persistTerminal = false) {
  const row = db
    .prepare('SELECT * FROM weir_saved_reviews WHERE command_id=?')
    .get(commandId.parse(command)) as Row | undefined
  if (!row) throw new Error('Unknown private review.')
  const view = JSON.parse(row.view) as Review
  if (command !== view.command_id || canonicalDigest(view) !== row.proposal_hash)
    throw new Error('Private review changed.')
  const task = currentTask(db)
  let state = row.state
  if (state === 'pending' || state === 'approved') {
    if (seconds() >= Math.min(view.expires_at, row.grant_expires ?? view.expires_at)) state = 'expired'
    else if (
      task.generation !== view.generation ||
      task.revision !== view.revision ||
      task.title !== view.before
    )
      state = 'stale'
  }
  if (persistTerminal && state !== row.state) {
    db.prepare('UPDATE weir_saved_reviews SET state=? WHERE command_id=? AND state=?').run(
      state,
      command,
      row.state
    )
  }
  return {
    view,
    proposal_hash: row.proposal_hash,
    state,
    step_up_ref: row.step_up_ref,
    receipt: row.receipt ? (JSON.parse(row.receipt) as Receipt) : null,
    task,
  }
}

export function prepare(db: Db, binding: Binding, change: { after: string } | { undo_of: string }) {
  return db
    .transaction(() => {
      let task = currentTask(db)
      let state = 'pending'
      let after: string
      let undo: string | null = null
      if ('undo_of' in change) {
        const previous = source(db, change.undo_of)
        if (!previous.receipt) throw new Error('Only a saved change can be reversed.')
        if (
          previous.receipt.revision !== task.revision ||
          previous.receipt.generation !== task.generation ||
          previous.receipt.after !== task.title
        )
          state = 'stale'
        task = {
          generation: previous.receipt.generation,
          revision: previous.receipt.revision,
          title: previous.receipt.after,
        }
        after = previous.receipt.before
        undo = previous.view.command_id
      } else after = titleText.parse(change.after)
      if (after === task.title) throw new Error('Choose a different title.')
      const scope = { ...binding, command_id: 'saved-' + randomBytes(16).toString('hex') }
      const issued = seconds()
      const view: Review = {
        ...scope,
        schema: 'weir.saved-task-review/v1',
        action_id: savedAction,
        task_id: 'rehearsal-task',
        generation: task.generation,
        revision: task.revision,
        before: titleText.parse(task.title),
        after,
        undo_of: undo,
        delivery: 'private-task-and-owner-receipt',
        data_class: 'internal',
        use_limit: 1,
        issued_at: issued,
        expires_at: issued + 300,
        work_context_hash: canonicalDigest(scope),
      }
      const hash = canonicalDigest(view)
      db.prepare('INSERT INTO weir_saved_reviews(command_id,proposal_hash,view,state) VALUES(?,?,?,?)').run(
        view.command_id,
        hash,
        JSON.stringify(view),
        state
      )
      return source(db, view.command_id)
    })
    .immediate()
}

export function fence(db: Db, command: string, hash: string) {
  return db
    .transaction(() => {
      const current = source(db, command, true)
      if (current.proposal_hash !== hash) throw new Error('The displayed review changed.')
      if (['pending', 'approved'].includes(current.state)) {
        db.prepare('UPDATE weir_saved_reviews SET state=? WHERE command_id=?').run(
          current.state === 'approved' ? 'withdrawn' : 'declined',
          command
        )
      }
      return source(db, command)
    })
    .immediate()
}

export function approve(db: Db, command: string, hash: string, stepUp: string, expires: number) {
  const item = source(db, command, true)
  if (
    item.state !== 'pending' ||
    item.proposal_hash !== hash ||
    !sha256.safeParse(stepUp).success ||
    !Number.isSafeInteger(expires) ||
    expires <= seconds() ||
    db
      .prepare(
        "UPDATE weir_saved_reviews SET state='approved',step_up_ref=?,grant_expires=? WHERE command_id=? AND proposal_hash=? AND state='pending'"
      )
      .run(stepUp, expires, command, hash).changes !== 1
  )
    throw new Error('The approval changed.')
}

export function grantCurrent(db: Db, binding: Binding, item: ReturnType<typeof source>) {
  const id = Number(binding.actor_id.slice('mc:user:'.length))
  const match = db
    .prepare(
      'SELECT 1 FROM remote_decision_step_up_grants g JOIN users u ON u.id=g.user_id ' +
        'JOIN workspaces w ON w.id=u.workspace_id WHERE g.step_up_ref=? AND g.binding_digest=? AND g.consumed_at IS NOT NULL ' +
        "AND g.expires_at>? AND u.id=? AND u.provider='local' AND u.is_approved=1 AND u.role IN ('admin','operator') " +
        'AND u.workspace_id=? AND w.tenant_id=?'
    )
    .get(
      item.step_up_ref,
      bindingDigest(item.proposal_hash),
      seconds(),
      id,
      binding.workspace_id,
      binding.tenant_id
    )
  if (!match || Object.entries(binding).some(([k, v]) => item.view[k as keyof Binding] !== v)) {
    throw new Error('The owner grant is unavailable.')
  }
}

export function commitTitle(db: Db, command: string, verify: (item: ReturnType<typeof source>) => void) {
  return db
    .transaction(() => {
      const item = source(db, command, true)
      if (item.state !== 'approved') return { state: item.state }
      verify(item)
      const { view, task } = item
      const fresh =
        task.revision === view.revision && task.generation === view.generation && task.title === view.before
      if (!fresh) {
        db.prepare("UPDATE weir_saved_reviews SET state='stale' WHERE command_id=?").run(command)
        return { state: 'stale' }
      }
      const receipt: Receipt = {
        command_id: command,
        generation: view.generation,
        before: view.before,
        after: view.after,
        proposal_hash: item.proposal_hash,
        revision: task.revision + 1,
        saved_at: seconds(),
      }
      if (receipt.saved_at >= view.expires_at) return { state: 'expired' }
      db.prepare('UPDATE weir_saved_task SET revision=?, title=? WHERE id=1').run(
        receipt.revision,
        view.after
      )
      db.prepare("UPDATE weir_saved_reviews SET state='committed',receipt=? WHERE command_id=?").run(
        JSON.stringify(receipt),
        command
      )
      return { state: 'committed' }
    })
    .immediate()
}

import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { parseFieldReview } from './field-review'

function safeDirectory(path: string, owner: number): void {
  const info = lstatSync(path)
  if (process.platform !== 'linux' || !Number.isSafeInteger(owner) || owner < 0
    || realpathSync(path) !== resolve(path) || !info.isDirectory() || info.uid !== owner || (info.mode & 0o027)) {
    throw new Error('field_directory_unavailable')
  }
}

export function protectedDocument(path: string, owner: number): unknown {
  safeDirectory(dirname(path), owner)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.uid !== owner || info.nlink !== 1 || (info.mode & 0o027) || info.size > 16_384) {
      throw new Error('field_document_unavailable')
    }
    const data = Buffer.alloc(16_385)
    let size = 0
    while (size < data.length) {
      const count = readSync(fd, data, size, data.length - size, null)
      if (count === 0) break
      size += count
    }
    if (size > 16_384) throw new Error('field_document_too_large')
    return JSON.parse(data.toString('utf8', 0, size))
  } finally { closeSync(fd) }
}

export function currentFieldReview() {
  const source = process.env.MC_WEIR_FIELD_REVIEW_DIR || '/run/weir-field-review'
  return parseFieldReview(protectedDocument(join(source, 'review.json'), 0),
    process.env.MC_WEIR_FIELD_OWNER || '', process.env.MC_WEIR_FIELD_DEVICE || '')
}

export function recordName(hash: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error('field_review_digest_invalid')
  return join(hash.slice(7), 'record.json')
}

function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_DIRECTORY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function publishedRecord(directory: string, hash: string, owner: number): unknown {
  safeDirectory(directory, owner)
  return protectedDocument(join(directory, recordName(hash)), owner)
}

export function publishOnce(directory: string, hash: string, doc: unknown): boolean {
  if (!process.geteuid) throw new Error('field_host_unavailable')
  safeDirectory(directory, process.geteuid())
  const target = dirname(join(directory, recordName(hash)))
  const tmp = join(directory, '.new-' + randomBytes(16).toString('hex'))
  mkdirSync(tmp, { mode: 0o700 })
  const record = join(tmp, 'record.json')
  let published = false
  try {
    const fd = openSync(record, 'wx', 0o440)
    try {
      fchmodSync(fd, 0o440)
      writeFileSync(fd, JSON.stringify(doc))
      fsyncSync(fd)
    } finally { closeSync(fd) }
    chmodSync(tmp, 0o2750)
    syncDirectory(tmp)
    try { renameSync(tmp, target); published = true } catch (error) {
      if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) return false
      throw error
    }
  } finally {
    if (!published) {
      try { unlinkSync(record) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      rmdirSync(tmp)
    }
  }
  syncDirectory(directory)
  return true
}

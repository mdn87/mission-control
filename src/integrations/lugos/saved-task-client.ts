import { createConnection } from 'node:net'
import { z } from 'zod'
import { commandId, sha256 } from './saved-task-store'

const state = z.enum([
  'pending',
  'approved',
  'declined',
  'withdrawn',
  'expired',
  'stale',
  'outcome_unknown',
  'unavailable',
])
const verified = z
  .object({
    state: z.literal('verified'),
    current: z.boolean(),
    current_revision: z.number().int().positive(),
    current_title: z.string(),
    receipt: z
      .object({
        command_id: commandId,
        generation: z.string(),
        before: z.string(),
        after: z.string(),
        proposal_hash: sha256,
        revision: z.number().int().positive(),
        saved_at: z.number().int(),
      })
      .strict(),
  })
  .strict()
const result = z.union([verified, z.object({ state }).strict()])
export type SavedEvidence = z.infer<typeof result>

export function savedTaskRequest(operation: 'execute' | 'verify', id: string): Promise<SavedEvidence> {
  const path = process.env.MC_WEIR_SAVED_TASK_SOCKET
  if (!path || !path.startsWith('/')) throw new Error('Private WEIR service unavailable.')
  const payload = JSON.stringify({ operation, command_id: commandId.parse(id) })
  return new Promise((resolve, reject) => {
    const client = createConnection({ path })
    const chunks: Buffer[] = []
    let count = 0
    const deadline = setTimeout(() => client.destroy(new Error('Private WEIR service timed out.')), 70_000)
    client.once('close', () => clearTimeout(deadline))
    client.once('error', reject)
    client.once('connect', () => client.end(payload))
    client.on('data', (chunk: Buffer) => {
      count += chunk.length
      if (count > 32_768) client.destroy(new Error('Invalid WEIR response.'))
      else chunks.push(chunk)
    })
    client.once('end', () => {
      try {
        const output = z
          .object({ ok: z.literal(true), result })
          .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (output.result.state === 'verified' && output.result.receipt.command_id !== id)
          throw new Error('Wrong private job.')
        resolve(output.result)
      } catch (error) {
        reject(error)
      }
    })
  })
}

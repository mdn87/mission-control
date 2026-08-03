import { afterEach, describe, expect, it } from 'vitest'
import { isLugosOperatorMode } from './operator-mode'

const original = process.env.NEXT_PUBLIC_LUGOS_OPERATOR_MODE

afterEach(() => {
  if (original === undefined) {
    delete process.env.NEXT_PUBLIC_LUGOS_OPERATOR_MODE
  } else {
    process.env.NEXT_PUBLIC_LUGOS_OPERATOR_MODE = original
  }
})

describe('Lugos operator mode', () => {
  it('is explicit and default-off', () => {
    delete process.env.NEXT_PUBLIC_LUGOS_OPERATOR_MODE
    expect(isLugosOperatorMode()).toBe(false)

    process.env.NEXT_PUBLIC_LUGOS_OPERATOR_MODE = '1'
    expect(isLugosOperatorMode()).toBe(true)
  })
})

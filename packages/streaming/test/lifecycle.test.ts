import { expect, test } from 'vitest'
import { type ChunkState, transition } from '../src/index.ts'

const STATES: ChunkState[] = ['unloaded', 'requesting', 'decoding', 'ready', 'unloading', 'failed']
const VALID = [
  'unloaded>requesting',
  'requesting>decoding',
  'requesting>unloaded', // cancelled
  'requesting>failed',
  'decoding>ready',
  'decoding>unloaded', // cancelled
  'decoding>failed',
  'ready>unloading',
  'unloading>unloaded',
  'failed>unloaded',
]

test('every valid transition is accepted and every other pair is rejected', () => {
  for (const from of STATES)
    for (const to of STATES) {
      if (VALID.includes(`${from}>${to}`)) expect(transition(from, to)).toBe(to)
      else expect(() => transition(from, to)).toThrow(`invalid chunk transition: ${from} -> ${to}`)
    }
})

import { describe, expect, it, vi } from 'vitest'

import { InvalidSettingsError } from '../src/errors'
import { startBot } from './scenario/bot'

describe('startLiquidator', () => {
  it('finalizes the journal unclean when its settings are refused', async () => {
    const finalize = vi.fn(async () => {})
    const journal = { sink: { append: async () => {}, finalize }, capacityBytes: 1_000_000 }
    await expect(startBot({ worldValidMs: 0, journal })).rejects.toBeInstanceOf(
      InvalidSettingsError
    )
    expect(finalize).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), { clean: false })
  })
})

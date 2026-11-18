import { describe, expect, it } from 'vitest'

import { delay } from '../../src/helpers/delay'

describe('delay', () => {
  it('resolves after at least the specified duration', async () => {
    const start = performance.now()
    await delay(50)
    const elapsed = performance.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(45)
  })
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'kit',
    // The journal reader's memory test measures what survives a collection.
    execArgv: ['--expose-gc']
  }
})

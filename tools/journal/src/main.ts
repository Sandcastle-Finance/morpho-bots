import { execFileSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { transformSolTemplates } from 'soltag/unplugin'

import { main } from './cli'
import { loadReplayModule } from './replay-module'

const REPOSITORY = fileURLToPath(new URL('../../..', import.meta.url))

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: REPOSITORY, encoding: 'utf8' }).trim()

/** The settings the bots' bundles and tests compile their lenses with, so a lens imports as it runs. */
const SOLTAG = { solc: { optimizer: { enabled: true, runs: 200 } } } as const

// A bot's lens module calls `sol` at import, which throws unless a bundler compiled the template:
// https://github.com/haydenshively/soltag#how-it-works
registerHooks({
  load: (url, context, nextLoad) => {
    const loaded = nextLoad(url, context)
    if (!url.startsWith('file:') || url.includes('/node_modules/') || !loaded.source) return loaded
    const source =
      typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source)
    if (!source.includes('soltag')) return loaded
    const compiled = transformSolTemplates(source, fileURLToPath(url), SOLTAG)
    return compiled ? { ...loaded, source: compiled.code } : loaded
  }
})

process.exitCode = await main(process.argv.slice(2), {
  load: loadReplayModule,
  checkout: () => ({
    revision: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=no') !== ''
  }),
  stdout: line => void process.stdout.write(`${line}\n`),
  stderr: line => void process.stderr.write(`${line}\n`)
})

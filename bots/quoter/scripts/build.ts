import type { Plugin } from 'esbuild'

import { build as esbuild } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSolTemplates } from 'soltag/unplugin'

import { BundleFailedError } from './errors'

// Bundles the bot entrypoint to `dist/` with the soltag `sol``` templates compiled to literal
// ABIs/bytecode, so production runs a plain `node` with no TypeScript or Solidity transform.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = join(ROOT, 'dist')
rmSync(DIST_DIR, { recursive: true, force: true })

const ESCAPED = ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// This bot's own TS sources only — bundled workspace deps ship prebuilt dist and hold no templates.
const INCLUDE = new RegExp(`^${ESCAPED}/src/.*\\.ts$`)

const soltagPlugin: Plugin = {
  name: 'soltag',
  setup(build) {
    build.onLoad({ filter: INCLUDE }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      const transformed = transformSolTemplates(source, path, {
        solc: { optimizer: { enabled: true, runs: 200 } }
      })
      return { contents: transformed?.code ?? source, loader: 'ts' as const }
    })
  }
}

let manifest: { version?: string }
try {
  manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }
} catch {
  throw new BundleFailedError('package.json could not be read or parsed for version stamping')
}

const gitRevision = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}
// The journal names the build that wrote it; the environment still overrides these at runtime.
const revision = process.env.BUILD_REVISION?.trim() || gitRevision()
const imageTag = process.env.BUILD_IMAGE_TAG?.trim() || `quoter-bot-${manifest.version ?? '0.0.0'}`

try {
  await esbuild({
    entryPoints: [join(ROOT, 'src/index.ts')],
    outdir: DIST_DIR,
    outbase: ROOT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // The bundle doubles as the published npm `bin`, so it must open with a shebang; node ignores
    // the line when the bundle is run as `node dist/src/index.js`. CJS deps reaching for require()
    // inside an ESM bundle need a real require.
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    },
    // Stamp the release version into VersionService so built artifacts report their real version.
    define: {
      'process.env.QUOTER_BOT_VERSION': JSON.stringify(manifest.version ?? '0.0.0'),
      'process.env.QUOTER_BOT_BUILD_IMAGE_TAG': JSON.stringify(imageTag),
      ...(revision && { 'process.env.QUOTER_BOT_BUILD_REVISION': JSON.stringify(revision) })
    },
    plugins: [soltagPlugin]
  })
} catch (error) {
  throw new BundleFailedError(error instanceof Error ? error.message : String(error))
}

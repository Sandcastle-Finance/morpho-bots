import { execFileSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// ADR-2026-11-14: Bun installs and runs scripts, Node runs the code, dependency scripts are denied.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8')
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

interface Manifest {
  name: string
  scripts?: Record<string, string>
  trustedDependencies?: string[]
  workspaces?: { packages: string[]; catalog: Record<string, string> }
  [field: string]: unknown
}
const manifest = (dir: string) => JSON.parse(read(join(dir, 'package.json'))) as Manifest
const root = manifest('')
const bunfig = read('bunfig.toml')
const lockfilePackages = Object.values(
  (
    JSON.parse(read('bun.lock').replace(/,(\s*[}\]])/g, '$1')) as {
      packages: Record<string, [string]>
    }
  ).packages
).map(([spec]) => spec)

/** The value of `key` in `bunfig.toml`'s `[section]`, or `undefined`. */
const setting = (section: string, key: string) =>
  new RegExp(`^${key} = (.+)$`, 'm').exec(
    bunfig.split(/^\[/m).find(block => block.startsWith(`${section}]`)) ?? ''
  )?.[1]

const dockerfiles = tracked.filter(file => /^bots\/[^/]+\/Dockerfile$/.test(file))
const finalStage = (file: string) =>
  read(file)
    .split(/^FROM /m)
    .at(-1) ?? ''

describe('dependency lifecycle scripts', () => {
  it('trusts exactly esbuild', () => {
    expect(root.trustedDependencies).toEqual(['esbuild'])
  })
})

describe('install hardening', () => {
  it('holds new releases for three days, in seconds', () => {
    expect(setting('install', 'minimumReleaseAge')).toBe('259200')
  })

  it('excludes every first-party package in the lockfile by exact name', () => {
    const firstParty = [
      ...new Set(
        lockfilePackages
          .filter(spec => spec.startsWith('@morpho-org/') && !spec.includes('@workspace:'))
          .map(spec => spec.slice(0, spec.lastIndexOf('@')))
      )
    ].toSorted()
    const excludes = /minimumReleaseAgeExcludes = \[([^\]]*)\]/.exec(bunfig)?.[1] ?? ''
    expect([...excludes.matchAll(/"([^"]+)"/g)].map(([, name]) => name).toSorted()).toEqual(
      firstParty
    )
  })

  it('saves exact versions', () => {
    expect(setting('install', 'exact')).toBe('true')
  })

  it('installs from a frozen lockfile in CI and images', () => {
    const installers = tracked.filter(
      file => /^\.github\/.*\.ya?ml$/.test(file) || dockerfiles.includes(file)
    )
    const installs = installers.flatMap(file =>
      read(file)
        .split('\n')
        .filter(line => /\bbun install\b/.test(line) && !line.trimStart().startsWith('#'))
        .map(line => ({ file, line: line.trim() }))
    )
    expect(installs.length).toBeGreaterThan(0)
    expect(installs.filter(({ line }) => !line.includes('--frozen-lockfile'))).toEqual([])
  })

  it('leaves no pnpm or npm configuration', () => {
    expect(
      tracked.filter(file =>
        ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'].includes(file.split('/').at(-1) ?? '')
      )
    ).toEqual([])
  })
})

describe('Bun is never a runtime', () => {
  it('uses no Bun APIs in TypeScript code', () => {
    const uses = tracked
      .filter(file => /\.(ts|tsx|mts|cts)$/.test(file))
      .filter(file =>
        read(file)
          .split('\n')
          .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .some(line => /\bBun\.\w|(from |import\(|require\()['"]bun(:\w+)?['"]/.test(line))
      )
    expect(uses).toEqual([])
  })

  it('never aliases node to bun in scripts and never loads .env files', () => {
    expect(setting('run', 'bun')).toBe('false')
    expect(/^env = false$/m.test(bunfig.split(/^\[/m)[0] ?? '')).toBe(true)
  })

  it('keeps Bun out of every image final stage', () => {
    expect(dockerfiles.length).toBeGreaterThan(0)
    expect(dockerfiles.filter(file => /\bbun\b/i.test(finalStage(file)))).toEqual([])
  })
})

describe('images', () => {
  const nvmrc = read('.nvmrc').trim()

  it('run as the unprivileged node user', () => {
    const rootImages = dockerfiles.filter(file => {
      const stage = finalStage(file)
      const user = stage.lastIndexOf('\nUSER node\n')
      return user === -1 || user > stage.indexOf('\nCMD ')
    })
    expect(rootImages).toEqual([])
  })

  it('use the Node version in .nvmrc', () => {
    const tags = dockerfiles.flatMap(file =>
      [...read(file).matchAll(/^FROM node:(\S+)/gm)].map(([, tag]) => ({ file, tag }))
    )
    expect(tags.length).toBeGreaterThan(0)
    expect(tags.filter(({ tag }) => !tag.startsWith(`${nvmrc}-`) && tag !== nvmrc)).toEqual([])
  })
})

it('pins solc exactly', () => {
  expect(root.workspaces?.catalog.solc).toMatch(/^\d+\.\d+\.\d+$/)
})

describe('bot build scripts', () => {
  const dirs = (root.workspaces?.packages ?? []).flatMap(pattern =>
    globSync(`${pattern}/package.json`, { cwd: repoRoot }).map(file => dirname(file))
  )
  const byName = new Map(dirs.map(dir => [manifest(dir).name, manifest(dir)]))
  const workspaceDependencies = (member: Manifest) =>
    ['dependencies', 'devDependencies']
      .flatMap(field => Object.entries((member[field] ?? {}) as Record<string, string>))
      .filter(([, specifier]) => specifier.startsWith('workspace:'))
      .map(([name]) => name)
  const closure = (name: string, seen = new Set<string>()): Set<string> => {
    for (const dependency of workspaceDependencies(byName.get(name) as Manifest)) {
      if (!seen.has(dependency)) closure(dependency, seen.add(dependency))
    }
    return seen
  }

  // Bun has no "this package and its dependencies" filter and orders a filtered run by direct
  // dependencies only, so each self-build first builds the dependencies that have a build script.
  it.each(dirs.filter(dir => dir.startsWith('bots/')))(
    '%s builds exactly its workspace dependencies that have a build script first',
    dir => {
      const { name, scripts = {} } = manifest(dir)
      const expected = [...closure(name)]
        .filter(dependency => byName.get(dependency)?.scripts?.build)
        .toSorted()
      const selfBuilds = Object.values(scripts).filter(script =>
        /(^|&& )bun run build\b/.test(script)
      )
      expect(selfBuilds.length).toBeGreaterThan(0)
      for (const script of selfBuilds) {
        const before = script.slice(0, script.search(/(^|&& )bun run build\b/))
        expect(
          [...before.matchAll(/bun run --filter (\S+) build\b/g)].map(([, f]) => f).toSorted()
        ).toEqual(expected)
      }
    }
  )
})

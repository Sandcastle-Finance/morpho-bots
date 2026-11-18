import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const chartPath = fileURLToPath(new URL('../../helm/blue-liquidation/', import.meta.url))

const claimNameOf = async (release: string) => {
  const { stdout } = await promisify(execFile)('helm', [
    'template',
    release,
    chartPath,
    '--show-only',
    'templates/pvc.yaml',
    '--set',
    'image.repository=example/blue-liquidation',
    '--set',
    'image.tag=deadbeef',
    '--set',
    'serviceAccount.name=blue-liquidation',
    '--set',
    'serviceAccount.roleArn=arn:aws:iam::000000000000:role/blue-liquidation',
    '--set',
    'runtimeSecret.key=blue-liquidation/dev/8453/runtime'
  ])
  return /^ {2}name: "(.+)"$/m.exec(stdout)?.[1]
}

const render = async (...extra: string[]) => {
  const { stdout } = await promisify(execFile)('helm', [
    'template',
    'bot-8453',
    chartPath,
    '--set',
    'image.repository=example/blue-liquidation',
    '--set',
    'image.tag=deadbeef',
    '--set',
    'serviceAccount.name=blue-liquidation',
    '--set',
    'serviceAccount.roleArn=arn:aws:iam::000000000000:role/blue-liquidation',
    '--set',
    'runtimeSecret.key=blue-liquidation/dev/8453/runtime',
    ...extra
  ])
  return stdout
}

const renderStatefulSet = (...extra: string[]) =>
  render('--show-only', 'templates/statefulset.yaml', ...extra)

describe('blue-liquidation Helm chart', () => {
  it('bounds the state claim name to 63 characters without merging long releases', async () => {
    const long = 'a'.repeat(50)
    const [short, first, second] = await Promise.all([
      claimNameOf('bot-8453'),
      claimNameOf(long),
      claimNameOf(`${long.slice(1)}b`)
    ])

    expect(short).toBe('bot-8453-blue-liquidation-state')
    expect(first).toBe(`${'a'.repeat(48)}-ccf410b4-state`)
    expect(second?.length).toBe(63)
    expect(second).not.toBe(first)
  }, 30_000)

  it('renders replicas 0 or 1 and rejects anything else', async () => {
    await expect(renderStatefulSet()).resolves.toContain('  replicas: 1\n')
    await expect(renderStatefulSet('--set-string', 'replicas=0')).resolves.toContain(
      '  replicas: 0\n'
    )
    for (const flag of [
      ['--set', 'replicas=2'],
      ['--set-string', 'replicas=3e0'],
      ['--set-string', 'replicas=1.0']
    ]) {
      await expect(renderStatefulSet(...flag)).rejects.toThrow(
        'blue-liquidation: replicas must be 0 or 1'
      )
    }
  }, 30_000)

  it('keeps the ordered StatefulSet and avoids Deployments', async () => {
    const chart = await render()

    expect(chart).toContain('kind: StatefulSet\nmetadata:\n  name: "bot-8453-blue-liquidation"\n')
    expect(chart).toContain('  podManagementPolicy: OrderedReady\n')
    expect(chart).not.toContain('kind: Deployment')
  }, 30_000)

  it('gives a stopping pod two minutes to settle what the kernel holds', async () => {
    expect(await renderStatefulSet()).toContain('      terminationGracePeriodSeconds: 120\n')
  }, 30_000)

  it('keeps the kernel ledger on a standalone claim that outlives the release', async () => {
    const [chart, pvc] = await Promise.all([render(), render('--show-only', 'templates/pvc.yaml')])

    expect(pvc).toContain('kind: PersistentVolumeClaim')
    expect(pvc).toContain('  name: "bot-8453-blue-liquidation-state"\n')
    expect(pvc).toContain('    helm.sh/resource-policy: keep\n')
    expect(pvc).toContain('    argocd.argoproj.io/sync-options: Delete=false,Prune=false\n')
    expect(pvc).toContain('  storageClassName: "tools-gp3"\n')
    expect(pvc).toContain('      storage: "10Gi"\n')
    expect(chart).not.toContain('volumeClaimTemplates')
    expect(chart).toContain(
      '        - name: state\n' +
        '          persistentVolumeClaim:\n' +
        '            claimName: "bot-8453-blue-liquidation-state"\n'
    )
    await expect(render('--set', 'state.storageClass=null')).rejects.toThrow(
      'state.storageClass is required'
    )
    await expect(render('--set', 'state.size=null')).rejects.toThrow('state.size is required')
  }, 30_000)

  it('mounts the state volume where KERNEL_STATE_DIR points, writable by the bot', async () => {
    const statefulSet = await renderStatefulSet()
    const stateDirectory = /- name: KERNEL_STATE_DIR\n\s+value: "(.+)"/.exec(statefulSet)?.[1]

    expect(stateDirectory).toBeDefined()
    expect(statefulSet).toContain(
      `            - name: state\n              mountPath: "${stateDirectory}"\n`
    )
    expect(statefulSet).toContain(
      '        runAsGroup: 1000\n        fsGroup: 1000\n        fsGroupChangePolicy: OnRootMismatch\n'
    )
    await expect(
      renderStatefulSet('--set', 'env[0].name=KERNEL_STATE_DIR', '--set', 'env[0].value=/elsewhere')
    ).rejects.toThrow('env must not set KERNEL_STATE_DIR')
  }, 30_000)

  it('sets the journal run cap from the state values, and refuses one set in env', async () => {
    const [rendered, raised] = await Promise.all([
      renderStatefulSet(),
      renderStatefulSet('--set-string', 'state.journalRunCapBytes=2147483648')
    ])

    expect(rendered).toContain(
      '            - name: JOURNAL_RUN_CAP_BYTES\n              value: "1073741824"\n'
    )
    expect(raised).toContain('value: "2147483648"')
    await expect(
      renderStatefulSet('--set', 'env[0].name=JOURNAL_RUN_CAP_BYTES', '--set', 'env[0].value=1')
    ).rejects.toThrow('env must not set JOURNAL_RUN_CAP_BYTES')
    await expect(renderStatefulSet('--set', 'state.journalRunCapBytes=null')).rejects.toThrow(
      'state.journalRunCapBytes is required'
    )
    for (const invalid of [
      '--set-json=state.journalRunCapBytes=67108864.5',
      '--set=state.journalRunCapBytes=1073741824',
      '--set-string=state.journalRunCapBytes=1Gi'
    ])
      await expect(renderStatefulSet(invalid)).rejects.toThrow(
        'state.journalRunCapBytes must be a quoted whole number of bytes'
      )
  }, 30_000)
})

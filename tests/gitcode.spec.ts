import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { KV } from '../src/kv.ts'
import { sendGitcode } from '../src/sources/gitcode-channel.ts'
import { commentTrigger, notificationRef, gitcodeThread, gitcodePage } from '../src/sources/gitcode-trigger.ts'
import { gitcodeKind, pollRound } from '../src/sources/gitcode.ts'
import { testGitcodeDeployment } from './fixtures/deployment.ts'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gitcode-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function host() {
  const store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { gitcode: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' },
    sources: { gitcode: { enabled: true, config: { repository: 'acme/widgets', cli: 'gc', host: 'gitcode.com' } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitcodeKind)
  const deployment = testGitcodeDeployment({ gitcode: { cli: 'gc', host: 'gitcode.com', login: 'agent-bot', email: '7+agent-bot@users.noreply.gitcode.com', configDir: '/tmp/gc-agent' } })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive }
  return { ...deps, receive, store, commands, health: board.all, ctx: sourceContextOf(deps, gitcodeKind) }
}

describe('gitcode trigger', () => {
  it('parses a mention notification URL into an Issue or merge request and its comment', () => {
    expect(notificationRef({ id: 'n1', update_at: '2026-11-03T10:00:00+08:00',
      html_url: 'https://gitcode.com/acme/widgets/issues/18?did=9c88#tid-197796534' })).toEqual({ kind: 'issue', number: 18, commentId: '197796534', discussionId: '9c88', url: 'https://gitcode.com/acme/widgets/issues/18?did=9c88#tid-197796534' })
    expect(notificationRef({ id: 'n2', update_at: '2026-11-03T10:00:00+08:00',
      html_url: 'https://gitcode.com/acme/widgets/merge_requests/61?did=7868#tid-197629896' })).toMatchObject({ kind: 'pull', number: 61, commentId: '197629896', discussionId: '7868' })
    expect(notificationRef({ id: 'n3', update_at: '2026-11-03T10:00:00+08:00', html_url: 'https://gitcode.com/acme/widgets/issues/18' })).toBeUndefined()
  })
  it('builds separate Thread ids for Issues and merge requests and addresses a mention', () => {
    expect(gitcodeThread('issue', 1)).toBe('issue:1')
    expect(gitcodeThread('pull', 1)).toBe('pull:1')
    const trigger = commentTrigger({ id: 42, body: '@agent please fix', user: { login: 'alice' }, created_at: '2026-11-03T10:00:00+08:00', discussion_id: 'd1', comment_type: 'pr_comment' },
      { kind: 'pull', number: 1, url: gitcodePage('acme/widgets', 'pull', 1) }, 'agent')!
    expect(trigger).toMatchObject({ source: 'gitcode', threads: [{ source: 'gitcode', id: 'pull:1' }], actor: { source: 'gitcode', id: 'alice' },
      human: true, addressed: 'mention', text: '@agent please fix', channel: { source: 'gitcode', thread: 'gitcode:pull:1',
        address: { kind: 'pull', number: '1', discussion: 'd1' } }, meta: { kind: 'pull', number: 1, commentId: '42', discussionId: 'd1' } })
  })
})

describe('gitcode source', () => {
  it('polls mention notifications, finds the named comment, and ingests it once', async () => {
    const h = host()
    h.store.saveSettings(h.store.settings())
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      const path = args.join(' ')
      if (path.includes('/notifications?')) return JSON.stringify({ total: 1, list: [{ id: 'n1', update_at: '2026-11-03T10:00:00+08:00',
        html_url: 'https://gitcode.com/acme/widgets/issues/1?did=d1#tid-42', actor: { login: 'alice' }, repository: { full_name: 'acme/widgets' } }] })
      if (path.includes('/issues/1/comments')) return JSON.stringify([{ id: 42, body: '@agent-bot please fix', user: { login: 'alice' },
        created_at: '2026-11-03T10:00:00+08:00', discussion_id: 'd1', comment_type: 'pr_comment' }])
      throw new Error(`unexpected ${path}`)
    })
    await pollRound(h.ctx)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ source: 'gitcode', threads: [{ source: 'gitcode', id: 'issue:1' }], actor: { id: 'alice' }, addressed: 'mention' })
    expect(h.store.get(KV.gitcode.since)).toBeTruthy()
  })
  it('replies with an idempotent marker and recognizes an existing reply', async () => {
    const h = host()
    const message = { id: 'op-1', channel: { source: 'gitcode', thread: 'gitcode:issue:1', address: { kind: 'issue', number: '1' } }, text: 'Done', kind: 'reply' as const }
    const api = vi.spyOn(h.commands, 'gitcodeApi').mockResolvedValue([{ id: 1, body: 'existing <!-- dsh-superagent:op-1 -->' }])
    const run = vi.spyOn(h.commands, 'run').mockResolvedValue('')
    expect(await sendGitcode({ commands: h.commands }, message)).toBe('sent')
    expect(run).not.toHaveBeenCalled()
    api.mockResolvedValue([])
    expect(await sendGitcode({ commands: h.commands }, message)).toBe('sent')
    expect(run).toHaveBeenCalledWith('gc', ['--no-interactive', '--no-update-check', 'issue', 'comment', '1', '-R', 'acme/widgets', '--body', 'Done\n\n<!-- dsh-superagent:op-1 -->'])
  })
})

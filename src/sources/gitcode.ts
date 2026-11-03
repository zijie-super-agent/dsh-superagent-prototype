/** GitCode/AtomGit source kind definition, mention polling, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GitcodeAccountsSchema } from '../deployment.ts'
import { validItems } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import { gitcodeLink, sendGitcode } from './gitcode-channel.ts'
import { gitcodePull } from './gitcode-pull.ts'
import { gitcodeThreadContext } from './gitcode-read.ts'
import { branchCiTrigger, ciTrigger, commentTrigger, CommentSchema, gitcodePage, gitcodeThread, IssueSchema, ListedCommentSchema,
  NotificationPageSchema, notificationRef, pullTrigger, issueTrigger, PullSchema, SOURCE, type GitcodeComment, type GitcodeKind } from './gitcode-trigger.ts'
import { pullsOf } from './gitcode-pull.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { ThreadFact } from '../core/index.ts'

const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
const ConfigSchema = GitcodeAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observePulls: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false),
}).strict()
export type GitcodeConfig = z.infer<typeof ConfigSchema>

/** Find a comment by id in a list that nests discussion replies under their root. */
function findComment(comments: GitcodeComment[], id: string): GitcodeComment | undefined {
  for (const comment of comments) {
    if (String(comment.id) === id) return comment
    const reply = (comment.reply ?? []).flatMap(item => { const parsed = CommentSchema.safeParse(item); return parsed.success ? [parsed.data] : [] })
    const found = findComment(reply, id)
    if (found) return found
  }
  return undefined
}

export const gitcodeKind: SourceKind<GitcodeConfig> = {
  kind: SOURCE,
  title: { zh: 'GitCode', en: 'GitCode' },
  description: { zh: '智能体的 GitCode/AtomGit 账号；接收仓库里 @ 它的评论，并在原 Issue 或合并请求线程回复。', en: 'The agent\'s GitCode/AtomGit account; receives comments that mention it in the repository and replies in the original Issue or merge request Thread.' },
  schema: ConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name。保存时用智能体的 gc 账号检查能否读取并推送，然后重启 dsh-superagent。', en: 'Written owner/name. Saving checks with the agent\'s gc account that it can read and push, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitCode CLI', en: 'Agent GitCode CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GC_CONFIG_DIR 登录智能体账号的 gc 包装脚本。执行器以 gc 调用它。', en: 'A command name or absolute path, usually a gc wrapper signed in to the agent account through GC_CONFIG_DIR. The Executor calls it as gc.' } },
    { key: 'host', type: 'text', pattern: '[A-Za-z0-9.\\-]+', label: { zh: 'GitCode 主机', en: 'GitCode host' },
      hint: { zh: 'gitcode.com 或 atomgit.com；API、网页链接和 gc 都按它选择。', en: 'gitcode.com or atomgit.com; API, web links and gc follow it.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new merge requests in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 PR 也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，Issue 和 PR 上没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments on Issues and merge requests that do not mention the agent are received too, and the Policy admission table decides whether they become candidates.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收 PR 和默认分支的 Actions', en: 'Receive Actions on PRs and the default branch' },
      hint: { zh: '打开后，PR 和默认分支的 Actions run 失效/恢复会收到，由策略的接收表决定是否成为候选。只读已有 CI；不负责开启仓库的 Actions。', en: 'Failures and recoveries of PR and default-branch Actions runs are received, and the Policy admission table decides whether they become candidates. Reads existing CI only; does not enable Actions.' } },
  ],
  health: ['gitcode'],
  scope({ meta }, config) {
    const row: Scope | undefined = meta.ci === true ? 'ci'
      : typeof meta.commentId === 'string' || typeof meta.commentId === 'number' ? 'comments'
        : meta.kind === 'issue' ? 'issues' : meta.kind === 'pull' ? 'pulls' : undefined
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  pull: gitcodePull,
  channel: { send: sendGitcode, link: gitcodeLink },
  threadContext: gitcodeThreadContext,
  // `#12` names an Issue and a PR, which GitCode numbers separately; `!12` prefers the PR.
  find: query => {
    const pr = /^!(\d+)$/.exec(query.trim())
    if (pr) return { threads: [`${SOURCE}:${gitcodeThread('pull', pr[1]!)}`], terms: [] }
    const plain = /^#?(\d+)$/.exec(query.trim())
    const page = /gitcode\.com\/[^/]+\/[^/]+\/(issues|merge_requests)\/(\d+)/.exec(query)
    if (page) return { threads: [`${SOURCE}:${gitcodeThread(page[1] === 'issues' ? 'issue' : 'pull', page[2]!)}`], terms: [] }
    return { threads: plain ? [`${SOURCE}:${gitcodeThread('issue', plain[1]!)}`, `${SOURCE}:${gitcodeThread('pull', plain[1]!)}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), name: z.string().trim().max(100).optional() }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), name: z.string().trim().max(100).optional() }).strict()).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitCode 账号', en: 'GitCode accounts that may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
      { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    ],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的 GitCode 账号。', en: 'An account on the list mentions the agent\'s GitCode account in an Issue or a comment.' },
    rows(stored) {
      const config = ConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('pulls', { zh: '新 PR', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        { id: 'ci', label: { zh: 'PR 和默认分支的 Actions', en: 'Actions on PRs and the default branch' },
          note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITCODE_REPOSITORY', description: { zh: '这个来源监听的仓库，owner/name', en: 'The repository this Source watches, as owner/name' } },
      { key: 'DSH_SUPERAGENT_GITCODE_ACCOUNT', description: { zh: '智能体的 GitCode 账号', en: 'The agent\'s GitCode account' } },
      { key: 'DSH_SUPERAGENT_GITCODE_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱；git 没有身份时用它提交', en: 'Commit email of the agent account; use it when git has no identity' } },
      { key: 'DSH_SUPERAGENT_GITCODE_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；不是从 GitCode 来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when it did not start on GitCode' } },
      { key: 'DSH_SUPERAGENT_GITCODE_PR_HEAD', description: { zh: '接下工单的 PR 的 head 引用 refs/merge-requests/<编号>/head；不是 PR 时为空', en: 'Head ref refs/merge-requests/<number>/head of the PR that started the ticket; empty when it was not a PR' } },
      { key: 'DSH_SUPERAGENT_GITCODE_HOST', description: { zh: 'GitCode 主机，gitcode.com 或 atomgit.com', en: 'GitCode host, gitcode.com or atomgit.com' } },
    ],
    values: ({ deployment, trigger }) => {
      const forge = deployment.forge === 'gitcode' ? deployment.gitcode : undefined
      const number = trigger?.source === SOURCE ? Number(trigger.meta.number) || 0 : 0
      return { DSH_SUPERAGENT_GITCODE_REPOSITORY: deployment.repository, DSH_SUPERAGENT_GITCODE_ACCOUNT: forge?.login ?? '',
        DSH_SUPERAGENT_GITCODE_COMMIT_EMAIL: forge?.email ?? '', DSH_SUPERAGENT_GITCODE_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GITCODE_PR_HEAD: number && trigger?.meta.kind === 'pull' ? `refs/merge-requests/${number}/head` : '',
        DSH_SUPERAGENT_GITCODE_HOST: forge?.host ?? '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.forge === 'gitcode' ? { cli: { zh: `当前账号 @${deployment.gitcode.login}`, en: `Current account @${deployment.gitcode.login}` } } : {},
}

export const name = 'dsh-superagent-gitcode'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitcodeKind), 'gitcode: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitcodeKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('gitcode', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

/** One polling interval: read mention notifications since the stored cursor and ingest each named comment. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const started = new Date().toISOString()
  const stored = ctx.state.get(KV.gitcode.since)
  const since = stored ?? started
  if (stored === undefined) ctx.state.set(KV.gitcode.since, since)
  const commands = ctx.commands.withSignal(signal)
  const page = await commands.gitcodeApi(NotificationPageSchema, `notifications?type=referer&per_page=50&since=${encodeURIComponent(since)}`)
  let newest = since
  for (const notification of page.list) {
    if (signal?.aborted) return
    const ref = notificationRef(notification, '')
    if (!ref) continue
    if (notification.actor?.login && ctx.deployment.forge === 'gitcode' && notification.actor.login === ctx.deployment.gitcode.login) continue
    const comments = await commands.gitcodePages(CommentSchema, `${ref.kind === 'issue' ? 'issues' : 'pulls'}/${ref.number}/comments`)
    const comment = findComment(comments, ref.commentId)
    if (!comment) continue
    const trigger = ref.kind === 'issue'
      ? commentTrigger(comment, { kind: 'issue', number: ref.number, url: ref.url, discussion: ref.discussionId }, accountOf(ctx).login)
      : commentTrigger(comment, { kind: 'pull', number: ref.number, url: ref.url, discussion: ref.discussionId }, accountOf(ctx).login)
    if (!trigger) continue
    await ctx.receive(trigger)
    const label = ref.kind === 'issue' ? `Issue #${ref.number}` : `!${ref.number}`
    ctx.threads.describe(`${SOURCE}:${gitcodeThread(ref.kind, ref.number)}`, { label, url: ref.url })
    if (Date.parse(notification.update_at) > Date.parse(newest)) newest = notification.update_at
  }
  ctx.state.set(KV.gitcode.since, cursorAt(newest))
  await pollSubscribed(ctx, signal ?? new AbortController().signal)
  await pollObserved(ctx, signal ?? new AbortController().signal, started)
  await pollCi(ctx, signal ?? new AbortController().signal)
  ctx.report('gitcode', { state: 'ready', detail: `${page.list.length} mention notifications; Threads, streams and Actions polled`, at: started })
}

function accountOf(ctx: SourceContext): { login: string } {
  if (ctx.deployment.forge !== 'gitcode') throw new Error('The GitCode Source requires the GitCode forge')
  return ctx.deployment.gitcode
}

/** Reads one repository-wide stream after its cursor and advances it; a first read starts at `started`, not at history. */
async function readObserved(ctx: SourceContext, signal: AbortSignal, stream: Scope, path: string, started: string,
  take: (value: unknown) => Promise<string | undefined>): Promise<void> {
  const state = ctx.state
  const name = KV.gitcode.stream(stream)
  const stored = state.get(name)
  const since = stored?.since ?? started
  const startedAt = stored?.started?.[stream] ?? since
  const listed = await ctx.commands.withSignal(signal).gitcodePages(z.unknown(), `${path}${path.includes('?') ? '&' : '?'}since=${encodeURIComponent(since)}`)
  let newest = since
  for (const item of listed) {
    if (signal.aborted) return
    const at = await take(item)
    if (at && Date.parse(at) > Date.parse(newest)) newest = at
  }
  state.set(name, { since: newest === since ? since : cursorAt(new Date(newest).toISOString()), started: { ...stored?.started, [stream]: startedAt } })
}

async function pollObserved(ctx: SourceContext, signal: AbortSignal, started: string): Promise<void> {
  const config = ctx.config<GitcodeConfig>(SOURCE)
  if (!config) return
  const account = accountOf(ctx)
  if (config.observeIssues) {
    await readObserved(ctx, signal, 'issues', 'issues?state=all&sort=updated&direction=asc', started, async item => {
      const issue = IssueSchema.safeParse(item)
      if (!issue.success || !issue.data.created_at || Date.parse(issue.data.created_at) < Date.parse(ctx.state.get(KV.gitcode.stream('issues'))?.since ?? started)) return undefined
      if (sameName(issue.data.user.login, account.login)) return issue.data.updated_at ?? issue.data.created_at ?? undefined
      await ctx.receive(issueTrigger(issue.data, account.login))
      const number = Number(issue.data.number)
      ctx.threads.describe(`${SOURCE}:${gitcodeThread('issue', number)}`, { label: `Issue #${number}`, ...(issue.data.html_url ? { url: issue.data.html_url } : {}) })
      return issue.data.updated_at ?? issue.data.created_at ?? undefined
    })
  }
  if (config.observePulls || config.observeComments) {
    await readObserved(ctx, signal, 'pulls', 'pulls?state=all&sort=updated&direction=asc', started, async item => {
      const pull = PullSchema.safeParse(item)
      if (!pull.success) return undefined
      const created = pull.data.created_at ?? ''
      const stream = ctx.state.get(KV.gitcode.stream('pulls'))
      const since = stream?.since ?? started
      if (sameName(pull.data.user.login, account.login)) return pull.data.updated_at ?? created ?? undefined
      if (config.observePulls && Date.parse(created) >= Date.parse(since)) {
        await ctx.receive(pullTrigger(pull.data, account.login))
        ctx.threads.describe(`${SOURCE}:${gitcodeThread('pull', pull.data.number)}`, { label: `!${pull.data.number}`, ...(pull.data.html_url ? { url: pull.data.html_url } : {}) })
      }
      if (config.observeComments) {
        const comments = await ctx.commands.withSignal(signal).gitcodePages(CommentSchema, `pulls/${pull.data.number}/comments`)
        for (const comment of comments) {
          if (Date.parse(comment.updated_at ?? comment.created_at ?? '') < Date.parse(since)) continue
          const trigger = commentTrigger(comment, { kind: 'pull', number: pull.data.number, url: pull.data.html_url ?? undefined }, account.login)
          if (trigger) await ctx.receive(trigger)
          for (const reply of comment.reply ?? []) {
            const parsed = CommentSchema.safeParse(reply)
            if (!parsed.success) continue
            const replyTrigger = commentTrigger(parsed.data, { kind: 'pull', number: pull.data.number, url: pull.data.html_url ?? undefined }, account.login)
            if (replyTrigger) await ctx.receive(replyTrigger)
          }
        }
      }
      return pull.data.updated_at ?? created ?? undefined
    })
  }
  if (config.observeComments) {
    await readObserved(ctx, signal, 'comments', 'issues/comments?sort=updated&direction=asc', started, async item => {
      const comment = ListedCommentSchema.safeParse(item)
      if (!comment.success) return undefined
      const number = Number(comment.data.target?.issue?.number)
      if (!Number.isInteger(number) || number <= 0) return comment.data.updated_at ?? comment.data.created_at ?? undefined
      if (sameName(comment.data.user.login, account.login)) return comment.data.updated_at ?? comment.data.created_at ?? undefined
      const trigger = commentTrigger(comment.data, { kind: 'issue', number, url: gitcodePage(ctx.deployment.repository, 'issue', number, gitcodeHost(ctx)) }, account.login)
      if (trigger) {
        await ctx.receive(trigger)
        ctx.threads.describe(`${SOURCE}:${gitcodeThread('issue', number)}`, { label: `Issue #${number}`, url: gitcodePage(ctx.deployment.repository, 'issue', number, gitcodeHost(ctx)) })
      }
      return comment.data.updated_at ?? comment.data.created_at ?? undefined
    })
  }
}

function gitcodeHost(ctx: SourceContext): string {
  return ctx.deployment.forge === 'gitcode' ? ctx.deployment.gitcode.host : 'gitcode.com'
}

const RunSchema = z.looseObject({ workflow_run_id: z.union([z.string(), z.number()]), workflow_name: z.string().default(''),
  status: z.string().default(''), head_sha: z.string().optional(), pull_request_id: z.union([z.string(), z.number()]).optional() })
const RunsPageSchema = z.looseObject({ workflow_runs: z.array(RunSchema).default([]) })
const RepoInfoSchema = z.looseObject({ default_branch: z.string().optional() })
type Run = z.infer<typeof RunSchema>
const FAILED = new Set(['FAILED', 'CANCELED'])
const RUNNING = new Set(['RUNNING', 'PAUSED', 'SUSPEND'])
const counts = (runs: Run[]) => ({ failed: runs.filter(run => FAILED.has(run.status)).length, running: runs.filter(run => RUNNING.has(run.status)).length })
const failures = (runs: Run[]): string[] => runs.filter(run => FAILED.has(run.status)).map(run => run.workflow_name).filter(Boolean).sort()
function summary(runs: Run[], where: string): string {
  const failed = failures(runs), running = runs.filter(run => RUNNING.has(run.status)).map(run => run.workflow_name).filter(Boolean)
  const at = `on ${where}`
  if (failed.length) return `CI failed ${failed.length}/${runs.length} ${at}: ${failed.slice(0, 5).join(', ')}${running.length ? `; ${running.length} still running` : ''}`
  if (running.length) return `CI running ${running.length}/${runs.length} ${at}: ${running.slice(0, 5).join(', ')}`
  return `CI passed ${runs.length}/${runs.length} ${at}`
}
const fact = (runs: Run[]): ThreadFact => {
  const { failed, running } = counts(runs)
  if (failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(failed), problem: true }
  if (running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(running) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}

/** Polls Actions runs for open-ticket PRs and the default branch; only changes after the first baseline become Triggers. */
async function pollCi(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const config = ctx.config<GitcodeConfig>(SOURCE)
  if (!config?.observeCi) return
  const commands = ctx.commands.withSignal(signal)
  const repository = ctx.deployment.repository
  const host = gitcodeHost(ctx)
  const numbers = [...new Set(ctx.tickets.open().flatMap(ticket => pullsOf(ticket, true)))]
  for (const number of numbers) {
    if (signal.aborted) return
    const page = await commands.gitcodeApi(RunsPageSchema, `/api/v8/repos/${repository}/actions/runs?pull_request_id=${number}&per_page=100`)
    const fingerprint = JSON.stringify(page.workflow_runs.map(run => [run.workflow_run_id, run.status]))
    const previous = ctx.state.get(KV.gitcode.ci(number))
    if (previous?.fingerprint === fingerprint) continue
    const revision = previous ? previous.revision + 1 : 0
    if (previous) await ctx.receive(ciTrigger({ number, html_url: gitcodePage(repository, 'pull', number, host), user: { login: '' } }, revision, summary(page.workflow_runs, `PR !${number}`)))
    ctx.state.set(KV.gitcode.ci(number), { fingerprint, revision })
    ctx.threads.describe(`${SOURCE}:${gitcodeThread('pull', number)}`, { facts: { ci: fact(page.workflow_runs) } })
  }
  const repo = await commands.gitcodeApi(RepoInfoSchema, '')
  const branch = repo.default_branch ?? 'main'
  const page = await commands.gitcodeApi(RunsPageSchema, `/api/v8/repos/${repository}/actions/runs?branch=${encodeURIComponent(branch)}&event=Push&per_page=100`)
  const failed = failures(page.workflow_runs)
  const previous = ctx.state.get(KV.gitcode.branchCi)
  const known = previous?.branch === branch ? previous.failures : undefined
  const now = failed.length || counts(page.workflow_runs).running ? failed : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    const sha = page.workflow_runs[0]?.head_sha ?? ''
    await ctx.receive(branchCiTrigger(branch, sha, revision, summary(page.workflow_runs, branch),
      `https://${host}/${repository}/commit/${sha}`))
    ctx.threads.describe(`${SOURCE}:ci:${branch}`, { label: `CI on ${branch}`, facts: { ci: fact(page.workflow_runs) } })
  }
  ctx.state.set(KV.gitcode.branchCi, { branch, failures: now, revision })
}

/** Polls subscribed Threads for comments that do not mention the agent; a reply is nested in its root comment's `reply`. */
async function pollSubscribed(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const account = accountOf(ctx)
  await pollEach(ctx, SOURCE, () => signal.aborted, async thread => {
    const [kindText, numberText] = thread.ref.id.split(':')
    const kind: GitcodeKind = kindText === 'pull' ? 'pull' : 'issue'
    const number = Number(numberText)
    if (!Number.isInteger(number) || number <= 0) throw new Error(`Unreadable GitCode thread id: ${thread.ref.id}`)
    const commands = ctx.commands.withSignal(signal)
    const path = `${kind === 'pull' ? 'pulls' : 'issues'}/${number}/comments`
    const since = ctx.state.get(KV.gitcode.cursor(thread.key)) ?? thread.createdAt
    const comments = await commands.gitcodePages(CommentSchema, path)
    const url = gitcodePage(ctx.deployment.repository, kind, number, ctx.deployment.forge === 'gitcode' ? ctx.deployment.gitcode.host : 'gitcode.com')
    for (const comment of comments) {
      const at = comment.updated_at ?? comment.created_at ?? ''
      if (Date.parse(at) < Date.parse(since) - 5000) continue
      const trigger = commentTrigger(comment, { kind, number, url }, account.login)
      if (trigger) {
        await ctx.receive(trigger)
        ctx.threads.describe(`${SOURCE}:${gitcodeThread(kind, number)}`, { label: detailLabel(kind, number, comment), url })
      }
      for (const reply of comment.reply ?? []) {
        const parsed = CommentSchema.safeParse(reply)
        if (!parsed.success) continue
        const replyTrigger = commentTrigger(parsed.data, { kind, number, url }, account.login)
        if (replyTrigger) await ctx.receive(replyTrigger)
      }
    }
    ctx.state.set(KV.gitcode.cursor(thread.key), cursorAt(new Date().toISOString()))
  })
}

function detailLabel(kind: GitcodeKind, number: number, comment: GitcodeComment): string {
  return kind === 'pull' ? `!${number}` : `Issue #${number}${comment.body ? '' : ''}`
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitcode', health('paused', 'setupPending')); return }
  if (ctx.deployment.forge !== 'gitcode') { ctx.report('gitcode', health('paused', 'sourceOff')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitcodeConfig>(SOURCE)
    try {
      if (config) await pollRound(ctx, signal)
      else ctx.report('gitcode', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      if (!signal.aborted && failures >= (config?.failuresBeforeError ?? 3)) {
        ctx.report('gitcode', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}

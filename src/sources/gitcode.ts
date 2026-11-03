/** GitCode/AtomGit source kind definition, mention polling, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GitcodeAccountsSchema } from '../deployment.ts'
import { validItems } from '../infra/commands.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import { gitcodeLink, sendGitcode } from './gitcode-channel.ts'
import { gitcodePull } from './gitcode-pull.ts'
import { gitcodeThreadContext } from './gitcode-read.ts'
import { commentTrigger, CommentSchema, gitcodePage, gitcodeThread, NotificationPageSchema, notificationRef,
  SOURCE, type GitcodeComment, type GitcodeKind } from './gitcode-trigger.ts'
import type { Localized, SourceKind } from './kind.ts'

const ConfigSchema = GitcodeAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
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
  ],
  health: ['gitcode'],
  scope: () => ({ listened: true, observed: false, row: 'comments' }),
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
    rows: () => [{ id: 'comments', label: { zh: '评论', en: 'Comments' }, note: { zh: '仅 @', en: '@ only' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
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
  ctx.report('gitcode', { state: 'ready', detail: `${page.list.length} mention notifications; subscribed Threads polled`, at: started })
}

function accountOf(ctx: SourceContext): { login: string } {
  if (ctx.deployment.forge !== 'gitcode') throw new Error('The GitCode Source requires the GitCode forge')
  return ctx.deployment.gitcode
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

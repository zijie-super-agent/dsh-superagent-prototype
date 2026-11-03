/** Normalizes GitCode issues, merge requests, comments and notifications into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp } from '../infra/text.ts'

export const SOURCE = 'gitcode'
export type GitcodeKind = 'issue' | 'pull'
/** GitCode numbers Issues and merge requests independently, so a Thread id names its kind. */
export const gitcodeThread = (kind: GitcodeKind, number: number | string): string => `${kind}:${number}`
/** The page for an Issue or merge request; GitCode uses `merge_requests`, not `pull`. */
export const gitcodePage = (repository: string, kind: GitcodeKind, number: number | string, host = 'gitcode.com'): string =>
  `https://${host}/${repository}/${kind === 'issue' ? 'issues' : 'merge_requests'}/${number}`
/** The reply address: the Issue or PR number, and the discussion when a comment belongs to one. */
export const gitcodeChannel = (kind: GitcodeKind, number: number | string, url?: string, discussion?: string): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${gitcodeThread(kind, number)}`,
    address: { kind, number: String(number), ...(url ? { url } : {}), ...(discussion ? { discussion } : {}) } })

/** A GitCode user as comments and repositories return it; `type` is absent on some responses. */
export const GitcodeUserSchema = z.looseObject({ login: z.string().min(1), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost' })
/** True when the account is a regular user rather than a bot; GitCode bots are listed explicitly in the Policy. */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/i.test(user.login) && (!user.type || user.type === 'User')
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)

/** A comment as `issues/<n>/comments` and `pulls/<n>/comments` return it. Replies are nested under the root comment. */
export const CommentSchema = z.looseObject({
  id: z.union([z.string(), z.number()]), body: z.string().nullish(), user: GitcodeUserSchema,
  created_at: z.string().nullish(), updated_at: z.string().nullish(), discussion_id: z.string().nullish(),
  comment_type: z.string().nullish(), resolved: z.boolean().nullish(), reply: z.array(z.unknown()).nullish(),
  diff_position: z.looseObject({ start_new_line: z.number().nullish(), end_new_line: z.number().nullish() }).nullish(),
})
export type GitcodeComment = z.infer<typeof CommentSchema>
/** An Issue comment from the repository-wide `issues/comments` stream; `target.issue.number` names its Issue. */
export const ListedCommentSchema = CommentSchema.extend({
  target: z.looseObject({ issue: z.looseObject({ number: z.union([z.string(), z.number()]).optional(), title: z.string().optional() }).optional() }).optional(),
})
export type ListedComment = z.infer<typeof ListedCommentSchema>
export const CommentPageSchema = z.array(z.unknown())
/** A GitCode Issue; `number` is a string on some endpoints. */
export const IssueSchema = z.looseObject({
  number: z.union([z.string(), z.number()]), title: z.string().default(''), body: z.string().nullish(), state: z.string().nullish(),
  html_url: z.string().nullish(), user: GitcodeUserSchema, created_at: z.string().nullish(), updated_at: z.string().nullish(),
})
/** A GitCode merge request; numbers are integers and `merged` may be null even after a merge. */
export const PullSchema = z.looseObject({
  number: z.number(), iid: z.number().optional(), title: z.string().default(''), body: z.string().nullish(), state: z.string().nullish(),
  merged: z.boolean().nullish(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), html_url: z.string().nullish(),
  draft: z.boolean().nullish(), user: GitcodeUserSchema, created_at: z.string().nullish(), updated_at: z.string().nullish(),
  head: z.looseObject({ ref: z.string().optional(), sha: z.string().optional(), repo: z.looseObject({ full_name: z.string().optional() }).nullish() }).nullish(),
  base: z.looseObject({ ref: z.string().optional() }).nullish(),
})
export type GitcodePull = z.infer<typeof PullSchema>
/** One notification from `notifications?type=referer`; `html_url` carries the Issue/PR, discussion and comment id. */
export const NotificationSchema = z.looseObject({
  id: z.string(), type: z.string().optional(), unread: z.boolean().optional(), update_at: z.string(),
  html_url: z.string(), actor: z.looseObject({ login: z.string().optional() }).optional(),
  repository: z.looseObject({ full_name: z.string().optional() }).optional(),
})
export type GitcodeNotification = z.infer<typeof NotificationSchema>
export const NotificationPageSchema = z.looseObject({ total: z.number().optional(), list: z.array(NotificationSchema).default([]) })

export interface NotificationRef { kind: GitcodeKind; number: number; commentId: string; discussionId?: string; url: string }
/**
 * Parses a notification's web URL. `...#tid-<comment>` names the comment, and `?did=<discussion>` the discussion for a
 * review comment; both are optional because older notifications may omit them.
 */
export function notificationRef(notification: GitcodeNotification, host = 'gitcode.com'): NotificationRef | undefined {
  let url: URL
  try { url = new URL(notification.html_url) } catch { return undefined }
  if (host && url.hostname !== host && url.hostname !== `www.${host}`) return undefined
  const match = /^\/([^/]+)\/([^/]+)\/(issues|merge_requests)\/(\d+)\/?$/.exec(url.pathname)
  if (!match) return undefined
  const kind: GitcodeKind = match[3] === 'issues' ? 'issue' : 'pull'
  const comment = /#tid-([A-Za-z0-9]+)/.exec(url.hash)?.[1] ?? url.searchParams.get('tid') ?? undefined
  if (!comment) return undefined
  return { kind, number: Number(match[4]), commentId: comment, discussionId: url.searchParams.get('did') ?? undefined, url: notification.html_url }
}

function author(user: { login: string; type?: string }, agent: string) {
  return { actor: { source: SOURCE, id: user.login }, human: isHumanLogin(user) && user.login !== agent }
}
/** Builds a Trigger for a comment on an Issue or merge request; the comment id and updated time make its ID stable. */
export function commentTrigger(comment: GitcodeComment, ref: { kind: GitcodeKind; number: number; url?: string; discussion?: string }, agent: string): Trigger | undefined {
  const body = comment.body ?? ''
  if (!body.trim()) return
  const id = String(comment.id)
  const thread = gitcodeThread(ref.kind, ref.number)
  const at = comment.updated_at ?? comment.created_at ?? new Date().toISOString()
  return { id: key('gitcode-note', thread, String(comment.id), at), source: SOURCE,
    threads: [{ source: SOURCE, id: thread }], ...author(comment.user, agent), at, text: body,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitcodeChannel(ref.kind, ref.number, ref.url, comment.discussion_id ?? ref.discussion),
    ...(ref.url ? { url: ref.url } : {}),
    meta: { kind: ref.kind, number: ref.number, commentId: id, ...(comment.discussion_id ? { discussionId: comment.discussion_id } : {}),
      ...(comment.comment_type ? { commentType: comment.comment_type } : {}) } }
}
/** Builds the Trigger for a newly opened Issue's title and body. */
export function issueTrigger(issue: z.infer<typeof IssueSchema>, agent: string): Trigger {
  const number = Number(issue.number)
  const body = issue.body ?? ''
  return { id: key('gitcode-issue', String(number)), source: SOURCE, threads: [{ source: SOURCE, id: gitcodeThread('issue', number) }],
    ...author(issue.user, agent), at: issue.created_at ?? new Date().toISOString(), text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitcodeChannel('issue', number, issue.html_url ?? undefined), ...(issue.html_url ? { url: issue.html_url } : {}),
    meta: { kind: 'issue', number } }
}
/** Builds the Trigger for a newly opened merge request's title and description. */
export function pullTrigger(pull: GitcodePull, agent: string): Trigger {
  const body = pull.body ?? ''
  return { id: key('gitcode-pull', String(pull.number)), source: SOURCE, threads: [{ source: SOURCE, id: gitcodeThread('pull', pull.number) }],
    ...author(pull.user, agent), at: pull.created_at ?? new Date().toISOString(), text: `${pull.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitcodeChannel('pull', pull.number, pull.html_url ?? undefined), ...(pull.html_url ? { url: pull.html_url } : {}),
    meta: { kind: 'pull', number: pull.number, prAuthor: pull.user.login } }
}


/** Builds a Trigger for a PR's Actions run change; CI has no person, so it has no explicit mention. */
export function ciTrigger(pull: { number: number; html_url?: string | null; user: { login: string } }, revision: number, summary: string): Trigger {
  return { id: key('gitcode-ci', String(pull.number), String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: gitcodeThread('pull', pull.number) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: summary,
    channel: gitcodeChannel('pull', pull.number, pull.html_url ?? undefined), ...(pull.html_url ? { url: pull.html_url } : {}),
    meta: { kind: 'pull', number: pull.number, prAuthor: pull.user.login, ci: true, revision } }
}
/** Builds a Trigger for a default-branch Actions run change; it has no person to reply to, so it has no channel. */
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitcode-ci', `branch:${branch}`, String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: `ci:${branch}` }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: summary, url, meta: { ci: true, branch, sha, revision } }
}

/** Read-only GitCode Issue, merge request, comment and Thread inspection for assessments and workers. */
import { z } from 'zod'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { CommentSchema, IssueSchema, PullSchema, gitcodePage, type GitcodeComment } from './gitcode-trigger.ts'
import type { Trigger } from '../core/index.ts'

const CommentListSchema = z.array(CommentSchema)
const commentText = (comment: GitcodeComment): string => comment.body ?? ''
const commentMessage = (comment: GitcodeComment, replyTo?: string): ContextMessage => ({
  id: String(comment.id), from: comment.user.login, at: comment.created_at ?? comment.updated_at ?? '', text: commentText(comment),
  ...(replyTo ? { reply_to: replyTo } : {}), ...(comment.resolved === true ? {} : {}),
  ...(comment.comment_type === 'diff_comment' && comment.diff_position?.start_new_line != null ? { line: comment.diff_position.start_new_line } : {}),
})
/** Flattens root comments and their `reply[]` arrays, preserving the root as each reply's parent. */
export function commentMessages(comments: GitcodeComment[]): ContextMessage[] {
  return comments.flatMap(comment => [commentMessage(comment), ...(comment.reply ?? []).flatMap(reply => {
    const parsed = CommentSchema.safeParse(reply)
    return parsed.success ? [commentMessage(parsed.data, String(comment.id))] : []
  })])
}
/** Reads an Issue/PR description, a page of comments, or one discussion thread as model-facing messages. */
export async function readGitcode(commands: Commands, resource: string): Promise<unknown> {
  const match = /^gitcode\/(issues|pulls)\/([1-9]\d*)(?:\/(comments|thread)(?:\/([^/]+))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitcode/issues/<number>, gitcode/pulls/<number>, /comments/<page> or /thread/<comment-id>')
  const [, section, rawNumber, part, key] = match
  const number = Number(rawNumber)
  if (!part) {
    if (section === 'issues') {
      const issue = await commands.gitcodeApi(IssueSchema, `issues/${number}`)
      return { number, title: issue.title, state: issue.state, ...(issue.html_url ? { url: issue.html_url } : {}),
        ...commentMessage({ ...issue, id: issue.number, body: issue.body } as GitcodeComment) }
    }
    const pull = await commands.gitcodeApi(PullSchema, `pulls/${number}`)
    return { number, title: pull.title, state: pull.state, ...(pull.html_url ? { url: pull.html_url } : {}),
      ...(pull.head?.ref ? { head: pull.head.ref } : {}), ...(pull.base?.ref ? { base: pull.base.ref } : {}),
      ...commentMessage({ id: pull.number, body: pull.body, user: pull.user, created_at: pull.created_at, updated_at: pull.updated_at } as GitcodeComment) }
  }
  if (part === 'comments') {
    const page = Number(key ?? '1')
    if (!Number.isInteger(page) || page < 1) throw new Error('The comments page must be a positive integer')
    const listed = await commands.gitcodePages(CommentSchema, `${section === 'issues' ? 'issues' : 'pulls'}/${number}/comments`)
    const start = (page - 1) * 20
    const slice = listed.slice(start, start + 20)
    return { messages: commentMessages(slice), ...(start + 20 < listed.length ? { next_resource: `gitcode/${section}/${number}/comments/${page + 1}` } : {}) }
  }
  if (!key) throw new Error('Name the discussion by one of its comments')
  const listed = await commands.gitcodePages(CommentSchema, `${section === 'issues' ? 'issues' : 'pulls'}/${number}/comments`)
  const root = listed.find(comment => String(comment.id) === key || comment.discussion_id === key)
  if (!root) throw new Error('No GitCode comment has that id')
  return { messages: commentMessages([root]) }
}

/**
 * Context reader for a GitCode Trigger: reads the whole Issue/PR conversation, or the discussion of an inline review
 * comment (the root and its replies). GitCode does not expose a file path on a review comment, so `path` stays empty.
 */
export const gitcodeThreadContext: ThreadContext<unknown> = {
  messageId: trigger => String(trigger.meta.commentId ?? ''),
  read: async (commands, trigger, _part, cursor) => {
    const kind = trigger.meta.kind === 'pull' ? 'pulls' : 'issues'
    const number = Number(trigger.meta.number)
    const page = Number(cursor ?? '1')
    const listed = await commands.gitcodePages(CommentSchema, `${kind}/${number}/comments`)
    const start = (Math.max(1, page) - 1) * 20
    const slice = listed.slice(start, start + 20)
    const body = { messages: commentMessages(slice) }
    return { messages: body.messages, ...(start + 20 < listed.length ? { next: String(page + 1) } : {}), body: { status: kind === 'issues' ? 'issue' : 'pull', ...body } }
  },
}

/** The web URL for a Trigger's Issue or merge request. */
export function gitcodeTriggerUrl(trigger: Trigger, repository: string): string {
  const kind = trigger.meta.kind === 'pull' ? 'pull' : 'issue'
  return trigger.url ?? gitcodePage(repository, kind, Number(trigger.meta.number))
}
/** True when an API error means the Issue or PR was deleted. */
export const gitcodeGone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)

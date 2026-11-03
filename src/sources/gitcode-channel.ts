/** GitCode outbound channel: posts Issue comments, PR comments, and discussion replies. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { gitcodePage, type GitcodeKind } from './gitcode-trigger.ts'

const CommentSchema = z.looseObject({ id: z.union([z.string(), z.number()]), body: z.string().nullish(), reply: z.array(z.unknown()).nullish() })
const CommentListSchema = z.array(CommentSchema)
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410 || (error.code === 403 && /locked|forbidden/i.test(error.message)))

/** True when a comment, or any reply nested under it, already carries the marker. */
function carries(value: unknown, marker: string): boolean {
  if (Array.isArray(value)) return value.some(item => carries(item, marker))
  if (value && typeof value === 'object') {
    const item = value as { body?: unknown; reply?: unknown }
    if (typeof item.body === 'string' && item.body.includes(marker)) return true
    return carries(item.reply, marker)
  }
  return false
}

/**
 * Posts a comment once, using a hidden HTML marker so a retry after a successful remote write does not duplicate it.
 * Returns `gone` only when the Issue, PR or discussion can never receive the message.
 */
export async function sendGitcode(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const deployment = commands.deployment
  if (deployment.forge !== 'gitcode') throw new Error('The GitCode Source requires the GitCode forge')
  const { repository, gitcode } = deployment
  const kind = (message.channel.address.kind === 'pull' ? 'pull' : 'issue') as GitcodeKind
  const number = Number(message.channel.address.number)
  const discussion = message.channel.address.discussion
  if (!Number.isInteger(number) || number <= 0) throw new Error('Missing GitCode reply target')
  const marker = `<!-- dsh-superagent:${message.id} -->`
  const body = `${message.text}\n\n${marker}`
  const comments = kind === 'issue' ? `issues/${number}/comments?per_page=100` : `pulls/${number}/comments?per_page=100`
  let listed: z.infer<typeof CommentListSchema>
  try { listed = CommentListSchema.parse(await commands.gitcodeApi(z.array(z.unknown()), comments)) }
  catch (error) { if (gone(error)) return 'gone'; throw error }
  if (carries(listed, marker)) return 'sent'
  try {
    const base = ['--no-interactive', '--no-update-check']
    const target = kind === 'issue'
      ? ['issue', 'comment', String(number), '-R', repository, '--body', body]
      : discussion
        ? ['pr', 'reply', String(number), '-R', repository, '--discussion', discussion, '--body', body]
        : ['pr', 'comment', String(number), '-R', repository, '--body', body]
    await commands.run(gitcode.cli, [...base, ...target])
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}

export function gitcodeLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const kind: GitcodeKind = address.kind === 'pull' ? 'pull' : 'issue'
  const number = address.number ?? ''
  const url = address.url ?? (links.repository ? gitcodePage(links.repository, kind, number) : '')
  return { url, label: kind === 'pull'
    ? { zh: `GitCode 合并请求 !${number}`, en: `GitCode merge request !${number}` }
    : { zh: `GitCode Issue #${number}`, en: `GitCode Issue #${number}` } }
}

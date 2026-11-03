/** GitCode merge request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { GitcodeDeployment } from '../deployment.ts'
import type { PullBinding, PullInfo } from './kind.ts'
import { gitcodePage, gitcodeThread, PullSchema, SOURCE } from './gitcode-trigger.ts'

const pullNumber = (thread: string): number | undefined => {
  const match = /^gitcode:pull:(\d+)$/.exec(thread)
  return match ? Number(match[1]) : undefined
}
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
/** True when the PR was opened by the agent account from a branch in the configured repository (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name?: string } | null } | null },
  deployment: Pick<GitcodeDeployment, 'gitcode' | 'repository'>): boolean =>
  sameName(pr.user.login, deployment.gitcode.login) && sameName(pr.head?.repo?.full_name ?? '', deployment.repository)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const toInfo = (pull: z.infer<typeof PullSchema>): PullInfo => ({ number: pull.number, state: pull.state ?? 'open', merged: pull.merged,
  mergedAt: pull.merged_at, closedAt: pull.closed_at, title: pull.title, url: pull.html_url ?? undefined, user: pull.user,
  head: { ref: pull.head?.ref ?? '', sha: pull.head?.sha, repo: pull.head?.repo ?? null } })
const readPullByCommands = async (commands: Commands, number: number, signal?: AbortSignal): Promise<PullInfo> =>
  toInfo(await commands.withSignal(signal).gitcodeApi(PullSchema, `pulls/${number}`))
const gitcodeDeployment = (ctx: SourceContext): GitcodeDeployment => {
  if (ctx.deployment.forge !== 'gitcode') throw new Error('The GitCode Source requires the GitCode forge')
  return ctx.deployment
}
/**
 * Validates and binds an open merge request to a ticket when it is either the ticket's origin PR or an agent-authored PR
 * on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 */
export function claimPull(ctx: SourceContext, ticketId: string, pull: PullInfo): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.kind === 'pull' && Number(source.meta.number) === pull.number
  const opened = agentPull(pull, gitcodeDeployment(ctx)) && ticketBranch(ticket, pull.head.ref)
  if (!started && !opened) {
    const { login } = gitcodeDeployment(ctx).gitcode
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).includes(pull.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const thread = `${SOURCE}:${gitcodeThread('pull', pull.number)}`
  const follow = ticket.follows?.find(item => item.thread === thread)
  if (pull.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pull, opened)
  return undefined
}
/**
 * Reconciles a polled merge request's open/merged/closed state with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR.
 */
export async function observePull(ctx: SourceContext, pull: PullInfo): Promise<boolean> {
  const ended = pull.state !== 'open' || !!pull.merged
  if (ended) closePull(ctx, pull)
  else {
    const candidates = agentPull(pull, gitcodeDeployment(ctx)) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pull.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:${gitcodeThread('pull', pull.number)}` && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true).every(number => number === pull.number))) claimPull(ctx, ticket.id, pull)
  }
  ctx.threads.describe(`${SOURCE}:${gitcodeThread('pull', pull.number)}`, { label: pull.title ? `!${pull.number} ${pull.title}` : `!${pull.number}`,
    ...(pull.url ? { url: pull.url } : {}) })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pull: PullInfo, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: gitcodeThread('pull', pull.number) }, own)
    ctx.threads.patch(`${SOURCE}:${gitcodeThread('pull', pull.number)}`, { kind: 'pull', number: pull.number, url: pull.url, prAuthor: pull.user.login })
  })
}
/** Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides. */
function closePull(ctx: SourceContext, pull: PullInfo): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).includes(pull.number))) return
  const at = pull.mergedAt ?? pull.closedAt ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: gitcodeThread('pull', pull.number) }, pull.mergedAt || pull.state === 'merged' ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR. GitCode channels are skipped
 * because the merge request page already shows the merge or close.
 */
export function pullEndNotices(ticket: Ticket, request: string, deployment: { repository: string; gitcode: { host: string } }): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = pullNumber(follow.thread)!
  const url = gitcodePage(deployment.repository, 'pull', number, deployment.gitcode.host)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR !${number}](${url}) 已合并。` : `[PR !${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR !${number}](${url}) has merged.` : `[PR !${number}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
/** The GitCode adapter of the generic pull request binding. */
export const gitcodePull: PullBinding = {
  read: readPullByCommands,
  claim: claimPull,
  observe: observePull,
  numbers: pullsOf,
  notice: (ticket, request, deployment) => deployment.forge === 'gitcode' ? pullEndNotices(ticket, request, deployment) : [],
}

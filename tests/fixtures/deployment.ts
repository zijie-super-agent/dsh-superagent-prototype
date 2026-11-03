/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, GithubAccount, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
export const testDeployment = (overrides: Record<string, unknown> = {}): Deployment => ({
  ...testMachine(), forge: 'github', repository: 'acme/widgets',
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
} as Deployment)

/** The GitHub account of a GitHub deployment; tests that need it start from testDeployment(). */
export const githubOf = (deployment: Deployment): GithubAccount => {
  if (deployment.forge !== 'github') throw new Error('The test deployment is not GitHub')
  return deployment.github
}

/** A GitCode deployment for forge-specific tests. */
export const testGitcodeDeployment = (overrides: Record<string, unknown> = {}): Deployment => ({
  ...testMachine(), forge: 'gitcode', repository: 'acme/widgets',
  gitcode: { cli: '/bin/false', host: 'gitcode.com', login: 'agent-bot', email: '7+agent-bot@users.noreply.gitcode.com', configDir: '/tmp/gc-agent' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
} as Deployment)

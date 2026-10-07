import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'
const DRAFT = '# fix(dht): gate the tunnel\n\nIntro.\n\n## Commits\n- abcdef01 — the gate itself\n'
const STACKED = '# feat(dht): use the gate\n<!-- base: fix/x -->\n\nUpper.\n'
const PATCH = 'diff --git a/x.rs b/x.rs\nindex 1..2 100644\n--- a/x.rs\n+++ b/x.rs\n@@ -1,1 +1,1 @@\n-old\n+new\n'

// Only the pane's size matters here; the rest of its props are the engine's.
const PANE_PROPS = { title: 'PR draft', isFocused: true, bodyColumns: 100, placement: 'dock' } as never

const git = (argv: readonly string[], remote = '') => {
  const a = argv.slice(1).join(' ')
  if (a.startsWith('remote get-url')) return remote
  if (a.startsWith('merge-base')) return null
  if (a.startsWith('rev-parse --git-path')) return '.git/praft\n'
  if (a.startsWith('branch')) return 'fix/x\n'
  if (a.startsWith('log')) return `${SHA}\x1ffix(dht): gate\x1fWhy it matters.\x1e\n`
  if (a.startsWith('show --stat')) return ' x.rs | 2 +-\n'
  if (a.startsWith('diff --shortstat')) return ' 3 files changed, 40 insertions(+), 2 deletions(-)\n'
  if (a.startsWith('show --format= --patch')) return PATCH
  return ''
}

type Run = { argv: readonly string[]; env?: Record<string, string> }

const fakeRepo = (on: Parameters<TestBody>[1], files: Record<string, string>, remote = '') => {
  const runs: Run[] = []
  const prompts: string[] = []
  on('process.run', async (_$, e) => {
    runs.push({ argv: e.argv, env: e.init?.env })
    const out = git(e.argv, remote)
    return {
      value: {
        exitCode: out === null ? 1 : 0,
        stdout: out ?? '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('fs.read', async (_$, e) => {
    const text = Object.entries(files).find(([k]) => e.path.endsWith(k))?.[1]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', async () => ({ value: undefined }) as never)
  on(
    'fs.list',
    async () =>
      ({
        value: Object.keys(files).map((p, i) => ({
          name: p.split('/').at(-1),
          kind: 'file',
          size: 1,
          mtimeMs: i,
          isLink: false,
        })),
      }) as never,
  )
  on('prompt.submit', async (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  return { runs, prompts }
}

const mount = ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'praft', surface, component: 'Pane', requestId: 'praft', props: PANE_PROPS })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draft, commit summary, expansion and nudges on ${surface}`, async ($, on) => {
    const { prompts } = fakeRepo(on, { '.git/praft/fix~x.md': DRAFT })
    const ui = await mount($, surface)
    expect((await ui.find({ key: 'title' }))?.props.value).toBe('fix(dht): gate the tunnel')
    expect(await ui.find({ text: 'the gate itself' })).toBeDefined()
    expect(await ui.find({ text: '+40' })).toBeDefined()
    expect(await ui.find({ text: '−2' })).toBeDefined()
    // One branch, no tabs.
    expect(await ui.find({ key: 'b-fix/x' })).toBeUndefined()

    await ui.press({ key: `t-${SHA}` })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(await ui.find({ text: 'Why it matters.' })).toBeDefined()

    await ui.input({ key: `n-${SHA}`, text: 'say what it blocks' })
    expect(prompts[0]).toContain('Reword commit abcdef01')
    await ui.press({ key: 'approve' })
    expect(prompts[1]).toContain('Push fix/x and open')
    expect(prompts[1]).toContain('into origin/main')
  })
}

test('stacked drafts get a tab each, with their own base', async ($, on) => {
  const { runs, prompts } = fakeRepo(on, { '.git/praft/fix~x.md': DRAFT, '.git/praft/feat~y.md': STACKED })
  const ui = await mount($)
  expect(await ui.find({ key: 'b-fix/x' })).toBeDefined()
  await ui.press({ key: 'b-feat/y' })
  expect((await ui.find({ key: 'title' }))?.props.value).toBe('feat(dht): use the gate')
  expect(runs.some(r => r.argv.join(' ') === 'git log --reverse --format=%H%x1f%s%x1f%b%x1e fix/x..feat/y')).toBe(true)
  // Not checked out: no in-place reword pickers.
  await ui.press({ key: `t-${SHA}` })
  expect(await ui.find({ key: `type-${SHA}` })).toBeUndefined()
  await ui.press({ key: 'approve' })
  expect(prompts[0]).toContain('Push feat/y and open the PR into fix/x')
})

test('with no draft, /praft asks Claude to write one', async ($, on) => {
  const clock = mock.clock(on)
  const { prompts } = fakeRepo(on, {})
  on('ui.open', async () => ({ value: { isOpen: true } }) as never)
  await $.command.run({ command: 'praft', args: '' } as never)
  await clock.advance(0)
  expect(prompts[0]).toContain('draft for branch fix/x')
  expect(prompts[0]).toContain('.git/praft/fix~x.md')
  expect(prompts[0]).toContain('## Commits')
})

test('picking a type or topic rewords that commit, subject passed by env', async ($, on) => {
  const { runs } = fakeRepo(on, { '.git/praft/fix~x.md': DRAFT })
  const ui = await mount($)
  expect(await ui.find({ key: `n-${SHA}` })).toBeUndefined()
  await ui.press({ key: `t-${SHA}` })
  await ui.select({ key: `type-${SHA}`, value: 'docs' })
  const rebase = runs.find(r => r.argv[1] === 'rebase')
  expect(rebase?.argv).toEqual(['git', 'rebase', '-i', '--quiet', '--update-refs', `${SHA}^`])
  expect(rebase?.env?.PRAFT_SUBJECT).toBe('docs(dht): gate')

  await ui.select({ key: `scope-${SHA}`, value: '(none)' })
  expect(runs.filter(r => r.argv[1] === 'rebase').at(-1)?.env?.PRAFT_SUBJECT).toBe('fix: gate')
})

test('a GitLab remote says MR, anything else PR', async ($, on) => {
  const { prompts } = fakeRepo(on, { '.git/praft/fix~x.md': DRAFT }, 'git@gitlab.com:team/repo.git\n')
  const ui = await mount($)
  expect(await ui.find({ text: 'Approve and open MR' })).toBeDefined()
  await ui.press({ key: 'approve' })
  expect(prompts[0]).toContain('MR draft for fix/x approved')
  expect(prompts[0]).toContain('open the MR into origin/main')
})

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// One draft per branch, in the git dir: `<git-dir>/praft/<branch>.md` ('/' in the
// branch name stored as '~', which git refuses in ref names, so it round-trips).
// Line 1 `# <title>`; an optional `<!-- base: <ref> -->` line names the branch the
// PR targets (the branch below it, in a stack); then the description; then an
// optional pane-only `## Commits` section of `- <sha> — <what part it solves>`.
// Claude writes it; the pane reads it, and the title can be edited in place.
const PANE = 'praft'
const DIR = 'praft'
const DEFAULT_BASE = 'origin/main'
// One expanded commit draws at most this much diff; the pane's cap is 100k.
const DIFF_BUDGET = 40_000

// Base set by `/praft <base>`, per branch; wins over the draft's own base line.
const bases = atom({ plugin: 'praft', key: 'bases' } as const, {} as Record<string, string>)
// Branch shown in the pane; '' follows the checked-out branch.
const viewing = atom({ plugin: 'praft', key: 'viewing' } as const, '')
const expanded = atom({ plugin: 'praft', key: 'expanded' } as const, [] as string[])
const rev = atom({ plugin: 'praft', key: 'rev' } as const, 0)

type Commit = { sha: string; subject: string; body: string }
type FileDiff = { path: string; hunks: string }

const git = async ($: EngineInterface, args: string[]) => {
  const r = await $.process.run(['git', ...args])
  return r.exitCode === 0 ? r.stdout : ''
}

const draftDir = async ($: EngineInterface) => (await git($, ['rev-parse', '--git-path', DIR])).trim()
const draftPath = async ($: EngineInterface, branch: string) => `${await draftDir($)}/${branch.replaceAll('/', '~')}.md`
const currentBranch = async ($: EngineInterface) => (await git($, ['branch', '--show-current'])).trim()

// Branches with a draft, oldest first, so a stack reads bottom-up.
const draftedBranches = async ($: EngineInterface) => {
  const entries = await $.fs.list(await draftDir($)).catch(() => [])
  return entries
    .filter(f => f.kind === 'file' && f.name.endsWith('.md'))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map(f => f.name.slice(0, -3).replaceAll('~', '/'))
}

const BASE_LINE = /^<!--\s*base:\s*(\S+)\s*-->\s*$/m

const readDraft = async ($: EngineInterface, branch: string) => {
  const text = await $.fs.read(await draftPath($, branch)).catch(() => '')
  const [first = '', ...rest] = text.split('\n')
  const isTitled = first.startsWith('# ')
  const [description = '', commitSection = ''] = (isTitled ? rest : [first, ...rest])
    .join('\n')
    .replace(BASE_LINE, '')
    .split(/^## Commits\s*$/m)
  const summaries = new Map<string, string>()
  for (const m of commitSection.matchAll(/^-\s*`?([0-9a-f]{7,40})`?\s*(?:—|–|-|:)\s*(.+)$/gm)) {
    summaries.set(m[1] ?? '', (m[2] ?? '').trim())
  }
  return {
    exists: text !== '',
    title: isTitled ? first.slice(2).trim() : '',
    base: BASE_LINE.exec(text)?.[1],
    description: description.trim(),
    summaryOf: (sha: string) => [...summaries].find(([k]) => sha.startsWith(k))?.[1],
  }
}

const baseOf = async ($: EngineInterface, branch: string) =>
  (await read($, bases))[branch] ?? (await readDraft($, branch)).base ?? DEFAULT_BASE

const commits = async ($: EngineInterface, ref: string, branch: string): Promise<Commit[]> => {
  const out = await git($, ['log', '--reverse', '--format=%H%x1f%s%x1f%b%x1e', `${ref}..${branch || 'HEAD'}`])
  return out
    .split('\x1e')
    .map(rec => rec.replace(/^\n/, ''))
    .filter(rec => rec.includes('\x1f'))
    .map(rec => {
      const [sha = '', subject = '', body = ''] = rec.split('\x1f')
      return { sha, subject, body: body.trim() }
    })
}

// Code's diff format reads hunks only, so split the patch per file and keep
// each file's lines from its first `@@`.
const fileDiffs = (patch: string): FileDiff[] =>
  patch
    .split(/^diff --git /m)
    .slice(1)
    .map(chunk => {
      const path = /^\+\+\+ b\/(.*)$/m.exec(chunk)?.[1] ?? /^a\/(\S+)/.exec(chunk)?.[1] ?? '?'
      const at = chunk.indexOf('\n@@')
      return { path, hunks: at < 0 ? '' : chunk.slice(at + 1).trimEnd() }
    })

// Conventional subject: `type(scope)!: text`.
const SUBJECT = /^([a-z]+)(?:\(([^)]*)\))?(!?): (.*)$/
const TYPES = ['feat', 'fix', 'docs', 'refactor', 'test', 'perf', 'chore', 'ci', 'build', 'style', 'revert']
const NO_SCOPE = '(none)'

const parseSubject = (subject: string) => {
  const m = SUBJECT.exec(subject)
  return m ? { type: m[1] ?? '', scope: m[2] ?? '', bang: m[3] ?? '', text: m[4] ?? '' } : undefined
}

// Scopes used on the base branch, most used first, so picks match history.
const knownScopes = async ($: EngineInterface, ref: string) => {
  const counts = new Map<string, number>()
  for (const line of (await git($, ['log', '-500', '--format=%s', ref])).split('\n')) {
    const scope = parseSubject(line)?.scope
    if (scope) counts.set(scope, (counts.get(scope) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k)
}

// Rewrites one commit's subject line in place (rebase from its parent), keeping
// its body and content; `--update-refs` carries branches stacked inside the range
// along. The new subject travels by env var, never through a shell string.
// Refuses on a dirty tree; aborts the rebase on any failure.
const rewordSubject = async ($: EngineInterface, sha: string, subject: string): Promise<string | undefined> => {
  if ((await git($, ['status', '--porcelain', '--untracked-files=no'])).trim() !== '') {
    $.ui.toast('praft: commit or stash your changes before changing a commit subject')
    return undefined
  }
  const before = (await git($, ['rev-list', '--reverse', `${sha}^..HEAD`])).split('\n').filter(Boolean)
  const r = await $.process.run(['git', 'rebase', '-i', '--quiet', '--update-refs', `${sha}^`], {
    env: {
      PRAFT_SUBJECT: subject,
      GIT_SEQUENCE_EDITOR: `sed -i -E 's/^pick (${sha.slice(0, 7)}[0-9a-f]*)/reword \\1/'`,
      GIT_EDITOR: `sh -c '{ printf "%s\\n" "$PRAFT_SUBJECT"; tail -n +2 "$1"; } > "$1.praft" && mv "$1.praft" "$1"' sh`,
    },
  })
  if (r.exitCode !== 0) {
    await $.process.run(['git', 'rebase', '--abort'])
    $.ui.toast(`praft: subject not changed; git rebase failed: ${r.stderr.split('\n')[0] ?? ''}`)
    return undefined
  }
  // The reword rewrote every commit after it too: carry every draft's sha refs over.
  const after = (await git($, ['rev-list', '--reverse', `${sha}^..HEAD`])).split('\n').filter(Boolean)
  for (const branch of await draftedBranches($)) {
    const path = await draftPath($, branch)
    const text = await $.fs.read(path).catch(() => '')
    let next = text
    before.forEach((old, i) => (next = next.replaceAll(old.slice(0, 8), (after[i] ?? old).slice(0, 8))))
    if (next !== text) await $.fs.write(path, next)
  }
  return after[0]
}

const subjectOf = (p: { type: string; scope: string; bang: string; text: string }) =>
  `${p.type}${p.scope ? `(${p.scope})` : ''}${p.bang}: ${p.text}`

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'PR draft' })

const askForDraft = async ($: EngineInterface, branch: string, ref: string) => {
  const path = await draftPath($, branch)
  await $.prompt.submit({
    text:
      `Write the pull/merge request draft for branch ${branch} (commits ${ref}..${branch}) to ${path}, ` +
      'for the praft pane. Line 1 `# <conventional title: the outcome>`; line 2 ' +
      `\`<!-- base: ${ref} -->\` (the branch it targets; the branch below it if stacked); ` +
      'then 1–3 sentences (what was wrong, what now holds); ' +
      'then short one-line-bullet sections Changes / Behaviour change / Tests / Gaps; ' +
      'last `## Commits` with one `- <sha8> — <which part of the PR it solves>` per commit. ' +
      'Terse. Do not push or open the PR.',
  })
}

// Pane handlers run detached from the draw; a throw there must not take the mod down.
const guarded =
  <A extends unknown[]>($: EngineInterface, what: string, f: (...a: A) => unknown) =>
  (...a: A) =>
    void Promise.resolve()
      .then(() => f(...a))
      .catch((err: unknown) => $.ui.toast(`praft: ${what} failed: ${err instanceof Error ? err.message : String(err)}`))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'praft',
      description: 'Review the PR draft and its commits in a pane',
      argumentHint: '[base ref; default: the draft’s base, else origin/main]',
    })
    return next(e)
  })

  // No polling: redraw once per finished turn (commits, rewords, draft edits
  // land in turns). Bumping rev only redraws an open pane; closed, nothing runs.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await update($, rev, n => n + 1)
    return result
  }).catch(($, e, next) => next(e))

  // Claude writing a draft is the cue to show it.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const path = e.tool === 'Write' || e.tool === 'Edit' ? e.file_path : ''
    const m = /\/praft\/([^/]+)\.md$/.exec(path)
    if (m) {
      const branch = (m[1] ?? '').replaceAll('~', '/')
      const current = await currentBranch($)
      await update($, viewing, () => (current === branch ? '' : branch))
      await update($, rev, n => n + 1)
      void openPane($)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'praft' }, async ($, e) => {
    const branch = await currentBranch($)
    if (branch === '') return { text: 'praft: HEAD is detached; check out the PR’s branch first.' }
    const arg = (e.args ?? '').trim()
    if (arg !== '') await update($, bases, m => ({ ...m, [branch]: arg }))
    await update($, viewing, () => '')
    const ref = await baseOf($, branch)
    await openPane($)
    if ((await readDraft($, branch)).exists) return { text: `PR draft for ${branch} opened (base ${ref}).` }
    // A command can't submit a prompt while it holds the turn; queue it just after.
    $.clock.after(0, () => void askForDraft($, branch, ref).catch(() => undefined))
    return { text: `No PR draft for ${branch} yet; asked Claude to write one (base ${ref}).` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const { Box, Text, Button, Input, Select, Markdown, Code } = $.ui.resolve(e)
    try {
      await read($, rev)
      const current = await currentBranch($)
      const branch = (await read($, viewing)) || current
      if (branch === '') return <Text dimColor>HEAD is detached. Check out the PR’s branch, then refresh.</Text>
      // Rewording rebases HEAD, so it works on the checked-out branch and on any
      // branch below it in a stack (`--update-refs` moves those along).
      const isCurrent =
        branch === current ||
        (await $.process.run(['git', 'merge-base', '--is-ancestor', branch, 'HEAD'])).exitCode === 0
      const tabs = [...new Set([...(await draftedBranches($)), current].filter(Boolean))]
      const ref = await baseOf($, branch)
      const opened = await read($, expanded)
      const draft = await readDraft($, branch)
      const list = await commits($, ref, branch)
      // Whole-PR size, as the forge will show it (merge-base to the branch).
      const short = await git($, ['diff', '--shortstat', `${ref}...${branch}`])
      const total = {
        files: Number(/(\d+) files? changed/.exec(short)?.[1] ?? 0),
        added: Number(/(\d+) insertion/.exec(short)?.[1] ?? 0),
        removed: Number(/(\d+) deletion/.exec(short)?.[1] ?? 0),
      }
      const path = await draftPath($, branch)
      const ask = guarded($, 'sending to Claude', (text: string) => $.prompt.submit({ text }))
      // One commit open at a time.
      const toggle = guarded($, 'expanding', (sha: string) =>
        update($, expanded, xs => (xs.includes(sha) ? [] : [sha])),
      )
      const show = guarded($, 'switching branch', async (b: string) => {
        await update($, viewing, () => (b === current ? '' : b))
        await update($, expanded, () => [])
      })
      const reword = guarded($, 'changing the subject', async (sha: string, subject: string) => {
        const now = await rewordSubject($, sha, subject)
        if (now !== undefined) await update($, expanded, () => [now])
        await update($, rev, n => n + 1)
      })
      const setTitle = guarded($, 'saving the title', async (title: string) => {
        const text = await $.fs.read(path).catch(() => '')
        const lines = text.split('\n')
        const body = lines[0]?.startsWith('# ') ? lines.slice(1) : lines
        await $.fs.write(path, [`# ${title.trim()}`, ...body].join('\n'))
        await update($, rev, n => n + 1)
      })
      const scopes = opened.length > 0 && isCurrent ? await knownScopes($, ref) : []

      const details = await Promise.all(
        list
          .filter(c => opened.includes(c.sha))
          .map(async c => {
            const stat = await git($, ['show', '--stat', '--format=', c.sha])
            const patch = await git($, ['show', '--format=', '--patch', c.sha])
            const files = fileDiffs(patch)
            let budget = DIFF_BUDGET
            const shown = files.filter(f => (budget -= f.hunks.length) >= 0)
            return { sha: c.sha, stat: stat.trimEnd(), files: shown, hidden: files.length - shown.length }
          }),
      )

      return (
        <Box flexDirection="column" gap={1}>
          {tabs.length > 1 && (
            <Box gap={1} flexWrap="wrap">
              {tabs.map(b => (
                <Button key={`b-${b}`} plain label={b === branch ? `[${b}]` : b} onPress={() => show(b)} />
              ))}
            </Box>
          )}

          {draft.exists ? (
            <Input key="title" value={draft.title} submitLabel="Save title" onSubmit={(v: string) => setTitle(v)} />
          ) : (
            <Box gap={1}>
              <Text>No PR draft for {branch} yet.</Text>
              <Button key="draft" label="Ask Claude to draft it" onPress={() => void askForDraft($, branch, ref)} />
            </Box>
          )}

          <Box gap={1}>
            <Text dimColor>
              {branch} into {ref}, {list.length} commit{list.length === 1 ? '' : 's'}, {total.files} file
              {total.files === 1 ? '' : 's'}
            </Text>
            <Text color="green">+{total.added}</Text>
            <Text color="red">−{total.removed}</Text>
          </Box>

          {draft.exists && (
            <Box flexDirection="column">
              <Markdown key="desc" text={draft.description} />
              <Input
                key="desc-nudge"
                placeholder="Tell Claude what to change in the title or description"
                submitLabel="Send"
                onSubmit={(v: string) => v.trim() && ask(`PR draft ${path}: ${v.trim()}`)}
              />
            </Box>
          )}

          <Box flexDirection="column">
            {list.length === 0 && (
              <Text dimColor>
                No commits on {branch} beyond {ref}.
              </Text>
            )}
            {list.map(c => {
              const sha8 = c.sha.slice(0, 8)
              const isOpen = opened.includes(c.sha)
              const d = details.find(x => x.sha === c.sha)
              const parsed = parseSubject(c.subject)
              return (
                <Box key={`c-${c.sha}`} flexDirection="column">
                  <Box gap={1}>
                    <Button
                      key={`t-${c.sha}`}
                      plain
                      label={`${isOpen ? '▾' : '▸'} ${sha8}`}
                      onPress={() => toggle(c.sha)}
                    />
                    <Text bold={isOpen}>{c.subject}</Text>
                  </Box>
                  {draft.summaryOf(c.sha) && (
                    <Box paddingLeft={2}>
                      <Text dimColor>{draft.summaryOf(c.sha)}</Text>
                    </Box>
                  )}
                  {isOpen && d && (
                    <Box flexDirection="column" paddingLeft={2} gap={1}>
                      {parsed && isCurrent && (
                        <Box gap={2}>
                          <Select
                            key={`type-${c.sha}`}
                            label="type"
                            value={parsed.type}
                            options={[...new Set([parsed.type, ...TYPES])].map(value => ({ value }))}
                            onSelect={(v: string) => {
                              if (v !== parsed.type) reword(c.sha, subjectOf({ ...parsed, type: v }))
                            }}
                          />
                          <Select
                            key={`scope-${c.sha}`}
                            label="topic"
                            value={parsed.scope || NO_SCOPE}
                            options={[...new Set([parsed.scope || NO_SCOPE, NO_SCOPE, ...scopes])].map(value => ({
                              value,
                            }))}
                            onSelect={(v: string) => {
                              const scope = v === NO_SCOPE ? '' : v
                              if (scope !== parsed.scope) reword(c.sha, subjectOf({ ...parsed, scope }))
                            }}
                          />
                        </Box>
                      )}
                      {!isCurrent && (
                        <Text dimColor>
                          Check out {branch} (or a branch stacked on it) to change type or topic here.
                        </Text>
                      )}
                      <Input
                        key={`n-${c.sha}`}
                        placeholder="Tell Claude how to reword this commit"
                        submitLabel="Send"
                        onSubmit={(v: string) =>
                          v.trim() &&
                          ask(`Reword commit ${sha8} "${c.subject}" on ${branch} (keep its content): ${v.trim()}`)
                        }
                      />
                      {c.body !== '' && <Text>{c.body}</Text>}
                      <Text dimColor>{d.stat}</Text>
                      {d.files.map((f, i) => (
                        <Box key={`f-${c.sha}-${i}`} flexDirection="column">
                          <Text bold>{f.path}</Text>
                          {f.hunks === '' ? (
                            <Text dimColor>Binary or mode change; no lines to show.</Text>
                          ) : (
                            <Code source={f.hunks} format="diff" path={f.path} />
                          )}
                        </Box>
                      ))}
                      {d.hidden > 0 && (
                        <Text dimColor>{d.hidden} more file(s) too large to draw here; use the delta command.</Text>
                      )}
                      <Box gap={1}>
                        <Button
                          key={`delta-${c.sha}`}
                          label="Copy delta command"
                          onPress={pe => void $.ui.copy({ text: `git show ${sha8} | delta`, surface: pe.surface })}
                        />
                      </Box>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>

          {draft.exists && (
            <Box gap={2}>
              <Button
                key="approve"
                variant="primary"
                label="Approve and open PR"
                onPress={() =>
                  ask(
                    `PR draft for ${branch} approved in the praft pane (${path}). Push ${branch} and open ` +
                      `the pull/merge request into ${ref} with that title and body (drop the ## Commits section ` +
                      'and the base comment).',
                  )
                }
              />
              <Button key="refresh" label="Refresh" onPress={() => void update($, rev, n => n + 1)} />
            </Box>
          )}
        </Box>
      )
    } catch (err) {
      return (
        <Text color="red">
          praft could not draw this pane: {err instanceof Error ? err.message : String(err)}. Run /praft to retry; if it
          repeats, check the repo for an unfinished rebase or merge.
        </Text>
      )
    }
  })
}

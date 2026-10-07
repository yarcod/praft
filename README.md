# praft

A Claude Code mod that shows a pull/merge request **draft** in a pane before the PR exists:
title (editable), description, the branch's size (`+added −removed`), and its commits.
You can expand a commit to read its message and diff. While it is open you can change its
conventional-commit type or topic in place, or tell Claude how to reword it. Approve when
it reads right, and Claude pushes and opens the PR.

It does no polling: the pane redraws when Claude writes the draft and when a turn ends.

## Install

```
/plugin install praft --marketplace yarcod/praft
```

Or for local development: `ln -s "$PWD" ~/.claude/skills/praft`.

## Forges

It doesn't depend on a forge. Approving asks Claude to push and open the request with
whatever tool your session has (`gh`, `glab`, an MCP server). The pane says **MR** when
`origin` is a GitLab remote and **PR** otherwise.

## Use

- `/praft [base]` opens the pane for the checked-out branch. If there's no draft, it asks
  Claude to write one. `base` defaults to the draft's own base, then `origin/main`.
- Drafts live in the git dir, one per branch: `$(git rev-parse --git-path praft)/<branch>.md`,
  where `/` in the branch name becomes `~`. They are never committed.
- **Stacked PRs**: each branch has its own draft and base (`<!-- base: <branch below> -->`),
  and the pane shows a tab per drafted branch. Changing a commit's type or topic rebases with
  `--update-refs`, so the branches stacked on it move too.

Draft format (Claude writes it; you can add a rule like this to your CLAUDE.md):

```
# <conventional title: the outcome>
<!-- base: origin/main -->
<1–3 sentences: what was wrong, what now holds>
Changes / Behaviour change / Tests / Gaps   (short bullet sections)
## Commits                                 (pane-only; dropped from the PR body)
- <sha8> — <which part of the PR this commit solves>
```

## Limits

- The pane can't render ANSI, so `delta` isn't embedded. "Copy delta command" copies
  `git show <sha> | delta` for a terminal.
- Changing a type or topic refuses on a dirty tree, and aborts the rebase if it fails.
- One expanded commit draws up to 40k characters of diff; the rest are listed by count.

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

MIT

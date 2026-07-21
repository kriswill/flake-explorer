---
name: release
description: Cut a flake-explorer release (patch/minor/major) via the Release workflow — changelog grooming, dispatch, the manual-approval gate, and post-publish verification. Use when the user asks to release, cut/publish a version, or bump the package.
---

# Release

Cut a release: `/release [major|minor|patch]` — defaults to **patch**.

The heavy lifting lives in `.github/workflows/release.yml` (read its header
comment for the full design). It bumps `package.json`, rolls the changelog,
lands the bump on main through an auto-merged PR, tags the merge commit, then
publishes the GitHub release, npm (OIDC trusted publishing — only that
workflow can publish), and FlakeHub. Your job is the preparation, the
dispatch, and shepherding it past the rough edges below.

## 1. Preconditions

- All feature PRs meant for this release are merged; `gh pr list` shows
  nothing you're waiting on. Main's ruleset requires PRs + the four CI
  checks (`test`, `typecheck`, `lint`, `nix`), with strict up-to-date
  branches — merge stacked PRs oldest-first, updating each onto the new
  main after the previous merge.
- Watch the coverage ratchet: octocov requires `current >= prev` against
  main's stored baseline. A PR that adds UI without component tests will
  fail the `test` check even when every test passes — add coverage on the
  PR branch, don't lower the bar.
- Local main is current: `git checkout main && git pull`.

## 2. Groom the changelog

`scripts/release.ts` refuses to release when `[Unreleased]` is empty
("must contain at least one `### ` subsection"), and whatever sits there
becomes the version section AND the GitHub release notes verbatim.

- Collect what shipped since the last release: `git log v<prev>..main
  --oneline` and the merged PR descriptions (`gh pr view <n>`).
- Write prose entries under `### Added` / `### Changed` / `### Fixed`
  (Keep a Changelog style — match the existing sections' voice: full
  sentences, honest about limits, wrapped ~74 columns).
- Do NOT touch version headings or the link refs at the bottom — the
  release script rolls `[Unreleased]` into a new dated section and
  maintains the compare links itself.
- Land the curation as its own PR (main takes no direct pushes), wait for
  checks, merge.

## 3. Dispatch

```bash
gh workflow run Release -f bump=<major|minor|patch>
gh run list --workflow Release --limit 1   # grab the run id
```

The workflow opens `release/v<X>` as a PR, dispatches CI on that branch,
arms auto-merge, and waits **up to 10 minutes** for the merge. Everything
after (tag, GitHub release, npm, FlakeHub) happens only if that wait
succeeds — so the next step is time-sensitive.

## 4. Rough edge: the gated pull_request run

The release PR usually gets TWO CI runs on the same commit: the
workflow's explicit `workflow_dispatch` run (this one satisfies the
required contexts) and a `pull_request` event run that GitHub may hold in
`action_required` (awaiting approval). While that run sits gated, branch
protection reports the PR BLOCKED and auto-merge never fires — even with
the dispatched run fully green.

As soon as the release PR exists, check:

```bash
gh run list --branch release/v<X> --workflow CI \
  --json databaseId,event,status
```

If a run shows `action_required`:

1. Try approving it yourself:
   `gh api -X POST repos/<owner>/<repo>/actions/runs/<id>/approve`
2. If the API call fails or the run stays gated, the approval must happen
   in the browser — use **AskUserQuestion** (do not just print a note; the
   10-minute window is ticking). Include in the question:
   - the release PR link: `https://github.com/<owner>/<repo>/pull/<n>`
     (get `<n>` from `gh pr view release/v<X> --json number,url`)
   - the gated run link:
     `https://github.com/<owner>/<repo>/actions/runs/<id>`
   Offer options like "Approved — continue" / "Cancel the release", and
   after they confirm, verify checks are actually running before moving on.

## 5. Watch and recover

Watch the run in the background (`gh run watch <run-id> --exit-status`),
never with foreground sleeps.

If the run fails at "Wait for the release PR to merge" (timed out or
checks failed), recovery is what the workflow header documents — never
re-dispatch while the old release PR is open, and don't try `gh run
rerun` (the branch/PR state makes the re-run's push and PR collide):

```bash
gh pr merge release/v<X> --disable-auto     # disarm first
gh pr close <n> --delete-branch
gh workflow run Release -f bump=<bump>      # fresh start
```

Then handle step 4 immediately on the new PR. Note the failed run leaves
main untouched (the version bump only lands via the PR), so a fresh
dispatch computes the same version.

## 6. Verify

All of these, not just the tag:

```bash
git fetch --tags && git tag -l v<X>
gh release view v<X> --json tagName,isDraft
npm view @kriswill/flake-explorer version        # expect <X>
gh run list --workflow flakehub-publish --limit 1  # dispatched on the tag
gh run list --branch main --limit 2              # CI + Pages re-dispatched
```

Report the release URL and npm version to the user when done.

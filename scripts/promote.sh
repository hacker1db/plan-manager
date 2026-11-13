#!/bin/sh
# Open the release pull request that promotes `preview` to production (`main`).
#
#   pnpm promote            # open (or show) the release PR
#   pnpm promote --dry-run  # print the title and body without creating it
#
# Feature work merges into `preview` (deployed to the preview site). Merging
# the release PR into `main` deploys production. Merge it with a merge commit,
# not a squash, so `preview` and `main` keep a shared history.
set -eu

base=main
head=preview
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null 2>&1 || { echo "gh (GitHub CLI) is required" >&2; exit 1; }
git fetch --quiet origin "$base" "$head"

count=$(git rev-list --count "origin/$base..origin/$head")
if [ "$count" -eq 0 ]; then
  echo "Nothing to promote: $head has no commits that $base lacks."
  exit 0
fi

existing=$(gh pr list --base "$base" --head "$head" --state open --json url --jq '.[0].url // ""')
if [ -n "$existing" ]; then
  echo "Release PR already open: $existing"
  exit 0
fi

# Pull requests merged into preview since the last release, newest first.
changes=$(git log --first-parent --format='- %s' "origin/$base..origin/$head")
prs=$(git log --first-parent --format='%s' "origin/$base..origin/$head" | grep -oE '#[0-9]+' | tr -d '#' | sort -un || true)

# GitHub closes issues only when a PR lands on the default branch, so carry the
# closing keywords of every included PR into the release PR.
closes=""
refs=""
for pr in $prs; do
  body=$(gh pr view "$pr" --json body --jq '.body' 2>/dev/null || true)
  [ -n "$body" ] || continue
  closes="$closes $(printf '%s\n' "$body" | grep -oiE '(close[sd]?|fix(e[sd])?|resolve[sd]?) #[0-9]+' | grep -oE '[0-9]+' || true)"
  refs="$refs $(printf '%s\n' "$body" | grep -oiE 'refs #[0-9]+' | grep -oE '[0-9]+' || true)"
done
closes=$(printf '%s\n' $closes | sort -un | sed '/^$/d' | sed 's/^/Closes #/')
refs=$(printf '%s\n' $refs | sort -un | sed '/^$/d' | sed 's/^/Refs #/')

title="release: promote preview to production ($(date +%Y-%m-%d))"
body=$(cat <<EOF
Promotes \`$head\` to production. Merging deploys https://planmanager.hacker1db.dev.

**Merge with "Create a merge commit"**, not squash, so \`$head\` and \`$base\` keep a shared history.

## Changes ($count commits)

$changes

## Issues

${closes:-No closing issue references found.}
$refs

## Before merging

- [ ] Verified on https://preview.planmanager.hacker1db.dev (sign-in, plan list, plan detail, \`plan push\`)
EOF
)

if [ "$dry_run" -eq 1 ]; then
  printf '%s\n\n%s\n' "$title" "$body"
  exit 0
fi

gh pr create --base "$base" --head "$head" --title "$title" --body "$body"

---
name: promote
description: Promote the preview branch to production by opening the release pull request from preview into main. Use only when the owner asks to promote, release, or ship preview to production.
---

# Promote preview to production

1. Run `pnpm promote --dry-run` from the repository and show the owner the title, the
   change list, and the issues it will close.
2. Run `pnpm promote` to open the release PR (`preview` → `main`). If one is already
   open, the script prints its URL instead.
3. Report the PR URL. Remind the owner to verify https://preview.planmanager.hacker1db.dev
   and to merge with **Create a merge commit** (not squash).

Never merge the release PR, push to `main`, or open any other PR into `main`.

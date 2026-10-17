---
name: visual-recap
description: >-
  Turn a PR, branch, commit, or working-tree diff into an MDX recap in Plan
  Manager: a file tree with change stats, diff-aware data models and endpoint
  contracts, architecture blocks, and annotated key-change diffs. Use for large
  or multi-file changes; skip small obvious diffs.
---

# Visual Recap (MDX)

A recap is a plan built **from** a diff, not toward one. It shows the shape of a
change at a higher altitude than line-by-line review, so a reviewer scans the
structure before spending attention on the literal lines. The output is an
`.mdx` plan, rendered by the Plan Manager dashboards and checked into Git next
to the change it describes.

Adapted from Builder.io's [visual-recap skill](https://github.com/BuilderIO/skills/blob/main/skills/visual-recap/SKILL.md).
The block vocabulary and authoring rules are shared with the `visual-plan`
skill. Read its **Authoring rules** section before writing.

## When to use

Use it when a PR or commit is large, multi-file, or touches schema, API
contracts, or architecture. Skip it for small, single-file, or obvious diffs.
A recap is review overhead, and a tiny change reviews faster as a plain diff.

## Scope: the whole work unit

When invoked after work in a conversation, recap the whole thread's work:
implementation, later fixes, tests, docs, and config. Do not recap only the last
message. Exclude unrelated changes that were already dirty before the thread
started. If the scope is genuinely ambiguous, state your assumption or ask one
concise question. When updating a recap after feedback, keep the full scope and
add the correction.

## Workflow

1. **Collect the diff once**, then work from your notes:
   `git diff --numstat <base>...HEAD` for stats and `git diff <base>...HEAD` for
   hunks. For uncommitted work, use `git add -N . && git diff --numstat`.
   Inventory the changed routes, types and schemas, commands, UI surfaces, and
   shared abstractions before writing.
2. **Load the catalog**: `plan blocks` (or `--json`).
3. **Write the recap.** For a repo check-in, use
   `docs/recaps/<branch-or-topic>.mdx` with full frontmatter
   (`format: mdx`, `tags: [recap]`). Otherwise use
   `plan create --title "Recap: …" --format mdx --stdin --json`.
4. **Validate** with `plan check <file>` until it prints `ok`.
5. **Report** the file path, and the dashboard URL if it was created through
   `plan`. When the recap is committed with the change, link it from the PR
   body.

## Canonical shape and budgets

1. **Outcome narrative** (prose, 1–3 paragraphs): what changed and why, the
   decisions visible in the diff, and the risks a reviewer should weigh. This is
   the only free-form writing.
2. **Architecture shift**: `<Layers>` or `<Flow>` when the structure changed.
   Use `<Columns>` with `Before` / `After` columns when the comparison is the
   point.
3. **Contracts**: `<DataModel>` for type, schema, or migration changes (with
   per-field `change` and `was`), and `<Endpoint>` for each changed route
   (`change` on the root for a wholly added route, `deprecated` for a removed
   one).
4. **Footprint**: a `<FileTree>` of every changed file, with `change`,
   `additions`, `deletions`, and a short `note` on the important ones.
5. **`## Key changes`**: one `<Tabs>` block of 3–8 tabs, one file per tab. Each
   tab holds a split `<Diff>` (true before/after) or an `<AnnotatedCode>` (new
   file), with a one-line `summary` and a few `annotations` on the load-bearing
   lines. Keep each excerpt under about 150 lines.

Do not add boilerplate: no "this recap is an aid" or provenance paragraphs, and
no restating the file count. The title and file tree already carry that.

**Good:** A 25-file change gets a two-paragraph narrative, a diff-aware
`<DataModel>`, an `<Endpoint>` for the new route, a full `<FileTree>`, and five
focused key-change tabs with annotations.
**Bad:** One giant unsegmented diff, or three thin blocks for a 40-file change
that force the reviewer back into the raw diff.

## Grounding rule

`<Diff>`, `<DataModel>`, `<Endpoint>`, and `<FileTree>` must come
mechanically from the actual diff. That means real paths, fields, methods,
before/after text, and numstat counts. Never infer, round, or invent them. Build
the code props with `JSON.stringify` from the real hunk text. If the diff does
not contain a fact, leave it out, and mark anything inferred as inferred in the
prose. A confidently wrong recap is worse than none: reviewers skip the lines
they think the summary covered.

## Security

- Never transcribe secrets, tokens, `.env` values, or credential-looking
  literals into any block. Redact them as `<redacted>`.
- A recap of a private repo exposes unreleased schema and internal routes.
  Treat it like the source it summarizes. Push it to the hosted site only on
  request.

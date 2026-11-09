---
name: visual-plan
description: >-
  Write a reviewable implementation plan as an MDX plan in Plan Manager, with
  file maps, data models, endpoint contracts, diagrams, diffs, and open
  questions as typed blocks. Use for non-trivial plans that need review before
  code; skip trivial one-step changes.
---

# Visual Plan (MDX)

Build the plan you would normally write in Markdown, but as an `.mdx` plan whose
structured parts are typed blocks the Plan Manager dashboards render: file maps,
data models, API contracts, flows, layered architecture, before/after columns,
and a single open-questions block. The MDX source is plain text, so it diffs and
reviews cleanly in Git. Nothing is uploaded unless the user runs `plan push`.

Adapted from Builder.io's [visual-plan skill](https://github.com/BuilderIO/skills/blob/main/skills/visual-plan/SKILL.md).
The workflow is local and file-based: no hosted Plan MCP, and no HTML export.

## When to use

Use it when the user needs to see, compare, or approve a direction before code
is written. That includes multi-file, risky, or ambiguous work, and smaller
changes with a real data-shape, API, or architecture decision. Skip it for
typos, one-line fixes, or anything whose diff fits in one sentence. Never pad a
plan or ship a single-step plan.

## Plan discipline

- **Research before drafting.** Read the real files, schema, routes, and
  patterns first. Name actual paths, symbols, and data shapes. For each step,
  say what it reuses before what it adds.
- **Decide the hard-to-reverse bets first.** Wire formats, public ids,
  data-model shape, and auth/ownership boundaries get settled in the plan, even
  if most of the feature ships later. Then scope the smallest first cut and say
  explicitly what is deferred.
- **Planning is read-only.** Make no source edits while drafting. The plan is
  the approval gate. Present it, name the files it touches, and ask for sign-off
  in the same message.
- **Clarify only what changes the design.** Explore instead of asking how to
  build it. Ask 2–4 batched questions only when an ambiguity changes the design
  and the code cannot settle it. Everything else goes in the bottom
  `<Questions>` block with a recommended default.
- **The document is the source of truth.** When scope shifts, edit the plan
  file, not just the chat. Keep it standalone and never write "unlike the
  previous draft".
- **Stay at the right altitude.** Separate the core abstraction from
  motivating examples, and label examples as examples.

## Workflow

1. **Load the block catalog.** Run `plan blocks`, or `plan blocks --json` for
   the full prop schema. It is generated from the same registry the renderer
   validates against, so never author tags from memory.
2. **Choose where the plan lives.**
   - Default: `plan create --title "<title>" --format mdx --stdin --json` with
     the body on stdin. The plan lands in `$PLAN_HOME` as `<slug>.mdx`.
   - When the user wants it checked into the repo, write
     `docs/plans/<slug>.mdx` with full frontmatter (see below). They can browse
     it with `plan import docs/plans/<slug>.mdx`, or with
     `PLAN_HOME=docs/plans plan serve`.
   - Revising: `plan update <id> --file <path> --if-revision <rev>`. Use the
     revision from `plan show <id> --json` so you never overwrite concurrent
     edits.
3. **Write the document** (shape below).
4. **Validate.** Run `plan check <file-or-id>`. It exits 2 and lists every block
   error: unknown tag, missing prop, wrong type, expression, or a parse failure.
   Fix the errors and re-run until it prints `ok`.
5. **Hand off.** Give the plan path and dashboard URL from the `--json`
   envelope, name the files the work will touch, and ask for approval.

## Document shape

Outcome first and prose first. Blocks sit next to the prose they support:

1. **Goal**: one or two paragraphs on the user outcome and success criteria.
   For abstract or shared plans, open with one concrete example.
2. **Context**: verified current state, with real paths. Use `<Layers>` when
   ownership or layering matters.
3. **Approach**: the decision and why. Use `<Callout tone="decision">` for
   each hard-to-reverse bet. Use `<Columns>` with `Before` / `After` columns for
   a structured comparison. Use `<Flow>` only for genuinely sequential
   mechanics.
4. **Contracts**: `<DataModel>` for schema and type changes (flag fields with
   `change`, and old types with `was`), and `<Endpoint>` for routes. Put each
   example in as a single valid JSON value.
5. **File plan**: a `<FileTree>` of the files to add or modify, each with a
   `change` flag and a short `note`.
6. **Steps**: GFM task list (`- [ ] …`) in dependency order. The dashboard
   toggles these in place.
7. **Validation**: commands and observable checks.
8. **Risks and rollback**: use `<Callout tone="risk">` for each real risk.
9. **Open questions**: exactly one `<Questions>` block, at the bottom, each item
   with a `recommendation`.

Use `<AnnotatedCode>` for a proposed new function or interface sketch, and
`<Diff>` for a proposed edit to an existing hunk. Keep excerpts short.

## Authoring rules

- **Frontmatter** (when writing a file directly):
  ```yaml
  ---
  id: <21-char nanoid; reuse it on every revision>
  title: <≤70 chars>
  status: active
  created: <ISO timestamp>
  updated: <ISO timestamp>
  tags: [plan]
  format: mdx
  ---
  ```
  Quote titles that contain a colon (`title: "Recap: auth"`).
  `format: mdx` is what makes the hosted site render the blocks after
  `plan push`. `plan create` and `plan update` write it automatically.
- **Blocks go on their own lines.** Put opening and closing tags on separate
  lines, with blank lines around Markdown children. A capitalized tag written
  inline in a paragraph is an error.
- **Props are static literals**: strings, numbers, booleans, arrays, and plain
  objects. Variables, function calls, `${}` interpolation, spreads, `import`,
  `export`, and `{expressions}` are all rejected.
- **Code-bearing props** (`Diff.before/after`, `AnnotatedCode.code`) are JSON
  strings such as `code={"line one\n  line two"}`. Build them with
  `JSON.stringify`, not by hand.
- **Escape MDX-significant characters in prose.** `{`, `}`, and `<` need a
  backslash or a code span.
- **Tabs and Columns** contain only `<Tab label>` and `<Column label>`
  children.
- **Never transcribe secrets** into any block. Use `<redacted>`.

## Self-review (high-stakes plans only)

For irreversible migrations, security-sensitive work, or when the user asks for
rigor, hand off first. Then run one skeptical reviewer pass over the written
plan, not a re-research. Look for implicit hard-to-reverse decisions, steps not
anchored to real files, option menus where the plan should commit, and filler.
Fix clear-cut issues in the file and re-run `plan check`. Move judgment calls
into `<Questions>`.

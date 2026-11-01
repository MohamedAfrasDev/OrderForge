<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Spec-first workflow (OrderForge)

`SPEC.md` is the index: the capability map, build order and project-wide conventions. Each module has its own spec in `doc/spec/SPEC-<module-id>.md`. Work on one module at a time, in the build order from `SPEC.md`. For each module, in this order:

1. **Spec.** Write or update `doc/spec/SPEC-<module-id>.md` covering objective, commands, structure, code style, testing, boundaries and success criteria. Get the human's approval before moving on.
2. **Tasks.** Break the approved spec into small tasks in `tasks/<module-id>/plan.md` and `tasks/<module-id>/todo.md`. Each task has acceptance criteria, a verify step and its files, and touches roughly five files or fewer. Order tasks by dependency and get the human's approval.
3. **Build.** Implement tasks one at a time, verify each, and tick it off in `todo.md`. Do not build anything the spec and task list don't cover.
4. **Next module.** Start the next module's spec only when the current module's success criteria are met, or the human says to continue. Then repeat from step 1.

Rules:
- Never start a module's code before its spec and task list exist and are approved.
- A module may be built only after the modules it depends on in `SPEC.md` are done. If a dependency isn't done, say so and stop.
- If a decision changes during build, update the spec first, then the code. Keep `SPEC.md` status lines current.
- The specs may be drafted ahead of the build, but each is approved in build order. Later specs may be revised after earlier modules land.
- Cut order and tripwires in `SPEC.md` still apply: when time is short, cut features, never payment, approval or agreement-integrity correctness.

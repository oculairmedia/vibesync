# TypeScript Conversion Playbook

Migration phases follow the dependency chain under `vibesync-kdb`.

## File-move pattern

```
git mv lib/X.js src/X.ts
```

Keep git history intact. Replace JSDoc `@param`/`@returns` with TS signatures.
Delete JSDoc tags only once the TS signature is equivalent — JSDoc can remain
during transition and be cleaned up in a final pass.

## Import extension rules

- Bun resolves bare specifiers and extensionless imports.
- During transition: JS importers of TS modules use `./module` (no extension).
- Once all callers in a subtree are TS, drop any `.js` extension shims.
- `verbatimModuleSyntax: true` is enforced in `tsconfig.json` — use `import type`
  for type-only imports.

## Type safety rules (mandatory)

- Never paper over with `as any`, `// @ts-ignore`, or `@ts-expect-error`.
- Every catch block: `catch (err) { if (err instanceof Error) ... }`.
- All function parameters must have explicit types (no implicit `any`).
- Return types are required on all exported functions.
- Use `z.infer<typeof schema>` for zod-backed config instead of hand-writing.

## .d.ts shim retirement order

1. `lib/LettaMemoryBuilders.d.ts` — retire after Phase 3a (Letta)
2. `lib/AgentsMdGenerator.d.ts` — retire after Phase 4 (sync/watchers)
3. `lib/database.d.ts` — retire after Phase 2 (database)

Each shim is deleted only when its replacement `.ts` source carries equivalent
or better types and no importer still references the `.d.ts`.

## Verification after every batch

```
bun run type-check          # strict TS gate (src/**/*.ts)
bun run type-check:runtime-js  # legacy JS gate (lib/**/*.js)
bun run temporal:build      # Temporal package
bun run build               # Bun bundle
bunx vitest run tests/unit/<area>  # touched-area tests
```

As modules move from `lib/` to `src/`, shrink `tsconfig.runtime-js.json`'s
`include` list so the relaxed gate covers progressively fewer files.

## Phase gates

| Phase | After completion |
|-------|-----------------|
| 0 | `@types/better-sqlite3` installed; `src/types/` populated; playbook exists |
| 1 | Cross-cutting modules in `src/`; `lib/` no longer contains logger, utils, config, http, runtimePaths |
| 2 | Database layer in `src/database/`; `lib/database.d.ts` deleted |
| 3a-3f | Integration modules in `src/`; `lib/LettaMemoryBuilders.d.ts` deleted |
| 4 | Sync/watchers/registry in `src/`; `lib/AgentsMdGenerator.d.ts` deleted |
| 5 | API server + routes in `src/api/` |
| 6 | `src/index.ts` and `src/cli.ts` are real entrypoints; `index.js` and `cli.js` deleted |
| 7 | `tsconfig.runtime-js.json` deleted; `tsconfig.json` is pure TS; all `.d.ts` shims gone; `find lib -name '*.js'` is empty |
| 8 | Test suite is `.ts` |
| 9 | One-shot scripts converted or archived |

## Commit guidelines

- Commits use semantic prefixes matching the repo: `feat(runtime):`, `refactor(db):`, `fix(types):`, `build(config):`, `docs(playbook):`
- Test + implementation in same commit
- Different directories in different commits
- Push regularly — do not batch more than 3-4 commits before pushing

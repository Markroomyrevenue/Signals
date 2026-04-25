# Review notes — data-foundations

## Cross-cutting findings

- `npm run lint` errors with "ESLint couldn't determine the plugin '@next/next' uniquely" because the worktree picks up both the worktree's local `node_modules/@next/eslint-plugin-next` AND the parent repo's `node_modules/@next/eslint-plugin-next`. This is a worktree+npm install artifact, not a code issue. Workaround: run `npm run lint` from the main repo path, OR remove the worktree's local node_modules and rely on the parent's. Subagent 1 worked around this by relying on `npm run typecheck` (which is unaffected) per the brief.

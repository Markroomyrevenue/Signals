# Review notes

## Cross-cutting findings

### From subagent 1 (data-foundations)

- `npm run lint` errors with "ESLint couldn't determine the plugin '@next/next' uniquely" because the worktree picks up both the worktree's local `node_modules/@next/eslint-plugin-next` AND the parent repo's `node_modules/@next/eslint-plugin-next`. This is a worktree+npm install artifact, not a code issue. Workaround: run `npm run lint` from the main repo path, OR remove the worktree's local node_modules and rely on the parent's. (Subagent 3 has since added `"root": true` to `.eslintrc.json` to mitigate.)

### From subagent 2 (security)

- Page-level admin gates on `/dashboard/select-client/new[/provisioning]` and `/dashboard/settings` would tighten UX (viewers can land on those pages today; API-side is now safely 403). Defer to UI subagent.
- `src/lib/login-rate-limit.ts` uses an in-memory `Map`. If/when the deployment scales beyond one Railway replica, swap to a Redis-backed counter. Acceptable today on single replica.
- `assertUniqueHostawayConnection` runs as a separate query before the orphan-cleanup pass in `app/api/tenants/clients/route.ts`. Two concurrent re-adds with the same key could theoretically both pass the cleanup gate. Not exploitable today (admin-only, single human user) but worth folding into one transaction when other write paths land.
- `src/lib/crypto.ts` falls back to `NEXTAUTH_SECRET` then to the literal `"insecure-dev-key-change-me"` if `API_ENCRYPTION_KEY` is unset. The fallback should never be reached in production — confirm `API_ENCRYPTION_KEY` is in the Railway env.

### From subagent 4 (calendar)

- Workspace header button labelled "Duplicate Tab ↗" — jargon. "Open in new tab" is clearer. (Workspace shell, not calendar grid.)
- Branding string "Roomy Recommended" appears throughout pricing/calendar code; product is Signals. Whoever owns the rename should grep for `ROOMY_RECOMMENDED_LABEL` and the literal "Roomy".
- Top of calendar workspace eyebrow reads "Calendar Workspace" — duplicates the H1 that says "Calendar". Could be removed for cleaner header (subagent 3 territory if it touches header copy).

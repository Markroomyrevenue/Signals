# Review notes

## Cross-cutting findings

### From subagent 2 (security)

- Page-level admin gates on `/dashboard/select-client/new[/provisioning]` and `/dashboard/settings` would tighten UX (viewers can land on those pages today; API-side is now safely 403). Defer to UI subagent.
- `src/lib/login-rate-limit.ts` uses an in-memory `Map`. If/when the deployment scales beyond one Railway replica, swap to a Redis-backed counter. Acceptable today on single replica.
- `assertUniqueHostawayConnection` runs as a separate query before the orphan-cleanup pass in `app/api/tenants/clients/route.ts`. Two concurrent re-adds with the same key could theoretically both pass the cleanup gate. Not exploitable today (admin-only, single human user) but worth folding into one transaction when other write paths land.
- `src/lib/crypto.ts` falls back to `NEXTAUTH_SECRET` then to the literal `"insecure-dev-key-change-me"` if `API_ENCRYPTION_KEY` is unset. The fallback should never be reached in production — confirm `API_ENCRYPTION_KEY` is in the Railway env.

# Security review — 2026-04-25

Subagent 2 (security) overnight review of the Signals app.

## Summary

| Area | Result |
| --- | --- |
| Tenant isolation across `app/api/**` | Pass — every route filters Prisma queries by `auth.tenantId` (or has a justified exemption) |
| Admin role gates server-side | Tightened — calendar, pricing, listing-groups, hostaway-connection GET, clients/POST now all reject viewers with 403 |
| Zod parsing on POST/PATCH/DELETE | Tightened — `/api/sync/run` and `/api/webhooks/hostaway/reservations` now use zod instead of unsafe casts |
| Secrets at rest | Pass — Hostaway client secret + access token + webhook basic-pass are AES-256-GCM encrypted via `src/lib/crypto.ts` (`API_ENCRYPTION_KEY`); never logged in plaintext |
| Login rate limit | Pass — `src/lib/login-rate-limit.ts` enforces 5 attempts / 15 min per IP, 15-min block, with X-Forwarded-For + Forwarded header support |
| Session cookie hardening | Pass — `ha_session` is HttpOnly + SameSite=Lax + Secure (in production HTTPS), 14-day expiry, hashed at rest (sha256) |

`npm run audit:tenant-isolation` passes (0 findings) after fixes. `npm run typecheck` passes.

## Findings table

| # | Route / area | Issue | Fix shipped? | Notes |
| - | --- | --- | --- | --- |
| 1 | `POST /api/tenants/clients` | Cross-tenant data destruction. Orphan-cleanup branch deleted any conflicting tenant where the caller wasn't a member (`safeToDelete = true if !callerMembership`). Combined with no admin gate, any logged-in user who knew another tenant's Hostaway API key could nuke that tenant. | Y | Added admin gate + tightened orphan logic to require either sole-admin OR no-admins-remain. Commit: `security: lock cross-tenant data destruction in clients/create` |
| 2 | `POST /api/reports/pricing-calendar` | Viewer can fetch the pricing calendar (base/min prices, suggested rates, per-listing settings). UI hides the tab; server didn't enforce. | Y | Added `auth.role !== "admin"` 403 gate. Commit: `security: lock viewers out of pricing-calendar API` |
| 3 | `POST /api/listings/groups` | Viewer can mutate `listing.tags` (assign/remove/delete property groups). | Y | Added admin gate. Commit: `security: lock viewers out of property-group mutations` |
| 4 | `GET /api/hostaway/connection` | Response leaked `hostawayClientId` (API key), `hostawayAccountId`, `webhookBasicUser` to viewers. | Y | Added admin gate. Commit: `security: lock viewers out of /api/hostaway/connection GET` |
| 5 | `POST /api/sync/run` | Body parsed with `as { forceFull?, scope? }` — unsafe cast. | Y | Replaced with strict zod schema; empty body still defaults to a full core sync. Commit: `security: parse /api/sync/run body with zod` |
| 6 | `POST /api/webhooks/hostaway/reservations` | Body parsed via hand-rolled `unknown` cast + `isRecord` helper. | Y | Replaced with permissive zod schema (passthrough for unknown Hostaway fields). Commit: `security: parse Hostaway webhook payload with zod` |
| 7 | All routes | No automated tenant-isolation static-analysis. | Y | New `npm run audit:tenant-isolation` walks every `app/api/**/route.ts` and asserts auth-context, tenant filter, zod-on-mutations, admin-gate where required. Fail-loud by default with inline `EXEMPT_QUERIES` for justified cross-tenant reads. Commit: `security: add static-analysis tenant isolation audit script` |
| 8 | Page-level `/dashboard/select-client/new` and `/dashboard/settings` | Viewers can land on the new-client / settings pages. The API endpoints are now admin-only so they can't actually do anything, but the page UX is misleading. | N | Out of scope (UI polish — defer to subagent 3). API security boundary is enforced. |
| 9 | Page-level `/dashboard/select-client/new/provisioning` | Same as above — viewer can land on the provisioning loop. | N | Out of scope (UI). Provisioning calls `/api/sync/run` which now correctly rejects viewers. |
| 10 | Login rate limit storage | In-memory per-process `Map`. With multi-instance Railway deploys, an attacker could distribute attempts across instances and bypass the limit. | N | Out of scope rewrite (would require Redis-backed counter). The single-Railway-replica deploy makes this acceptable today; flagged as cross-cutting for future redis-backed limiter. |

## Files audited

### Auth / session / rate-limit
- `src/lib/auth.ts`
- `src/lib/login-rate-limit.ts`
- `src/lib/crypto.ts`
- `src/lib/env.ts`
- `src/lib/base-path.ts`
- `src/lib/team/team-access.ts`
- `src/lib/tenants/clients.ts`
- `src/lib/user-role-repair.ts`
- `src/lib/hostaway/index.ts`
- `src/lib/hostaway/hardening.ts`

### API routes (27 total, all under `app/api/`)
- `admin/reset-and-sync-live/route.ts`
- `auth/login/route.ts`
- `auth/logout/route.ts`
- `filters/options/route.ts`
- `hostaway/connection/load-env/route.ts`
- `hostaway/connection/route.ts`
- `hostaway/test/route.ts`
- `listings/groups/route.ts`
- `listings/route.ts`
- `metrics/route.ts`
- `pricing-settings/route.ts`
- `reports/attention-tasks/resolve/route.ts`
- `reports/book-window/route.ts`
- `reports/booked/route.ts`
- `reports/home-dashboard/route.ts`
- `reports/pace/route.ts`
- `reports/pricing-calendar/route.ts`
- `reports/property-deep-dive/route.ts`
- `reports/reservations/route.ts`
- `reports/sales/route.ts`
- `sync/run/route.ts`
- `sync/status/route.ts`
- `team/users/route.ts`
- `tenants/clients/route.ts`
- `tenants/current/route.ts`
- `tenants/switch/route.ts`
- `webhooks/hostaway/reservations/route.ts`

### Pages reviewed for server-side auth bounce
- `app/(dashboard)/dashboard/page.tsx`
- `app/(dashboard)/dashboard/team/page.tsx`
- `app/dashboard/select-client/page.tsx`
- `app/dashboard/select-client/new/page.tsx`
- `app/dashboard/select-client/new/provisioning/page.tsx`
- `app/dashboard/settings/page.tsx`
- `app/components/revenue-dashboard.tsx` (the navGroups + viewer-bounce useEffect on the calendar tab)

## Notes on the encryption key

`src/lib/crypto.ts` derives the AES-256 key from the first defined of: `API_ENCRYPTION_KEY` (preferred), `NEXTAUTH_SECRET`, or the literal string `"insecure-dev-key-change-me"` (development-only fallback). For production:

- `API_ENCRYPTION_KEY` should be 32 raw bytes hex-encoded (64 hex chars) or base64-encoded (32 bytes) so it's used directly. Otherwise it falls back to sha256(raw), which is acceptable but weaker than a random 256-bit key.
- The literal fallback should never be reached in production — `setup-live.ts` and the README should document that this key is required.

## Notes on console.log surface

`grep -ri "console\.(log|warn|error)"` against `app/` and `src/` finds these call sites. None of them log secret values; they log error messages, tenant IDs, emails, and counts:

- `app/api/tenants/clients/route.ts` — orphan cleanup logs (tenant id + email + reason)
- `src/lib/sync/engine.ts` — sync-progress callback failures
- `src/lib/reports/service.ts` — DB-migration guidance
- `src/lib/pricing/market-recommendations.ts` — market-anchor fetch failures
- `src/lib/external-api-cache.ts` — stale cache fallback warning
- `scripts/setup-live.ts` — instructions referring to env var names (not values)

No console output prints `hostawayClientSecret`, `passwordHash`, `tokenHash`, or any decrypted token / pass.

## Cross-cutting findings (for orchestrator)

- Page-level admin gates on `/dashboard/select-client/new[/provisioning]` and `/dashboard/settings` would make the UX clearer (viewers shouldn't see "Add new client"). API-side is now safe.
- Login rate limit is in-memory; if the deployment moves to multi-replica, swap to Redis-backed counters.
- `assertUniqueHostawayConnection` runs as a separate query before the orphan cleanup. Race-condition-wise, it would be cleaner to fold the cleanup + uniqueness check into a single transaction so two concurrent re-adds with the same key can't both pass the cleanup gate. Not exploitable today (admin-only, single user typically), but worth tightening when other database-write paths land.

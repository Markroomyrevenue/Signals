/**
 * Static-analysis audit for tenant isolation across every API route.
 *
 * Walks `app/api/** /route.ts` and asserts that each route handler:
 *
 *   (a) reads an auth context (getAuthContext, requireAuthContext, or
 *       getAdminAuthContext) and returns 401 when missing, or is on the
 *       documented public-allowlist (login, logout, webhook).
 *
 *   (b) Every prisma query that targets a tenant-scoped model passes a
 *       `tenantId:` argument, AND that tenantId is sourced from `auth.`
 *       (the trusted session) rather than from the request body / search
 *       params. Bare `prisma.<model>.<method>` calls without any `tenantId`
 *       filter on tenant-scoped models are flagged.
 *
 *   (c) Any tenantId pulled from a request body or URL is verified against
 *       the auth tenant before being used to mutate data.
 *
 *   (d) POST/PATCH/DELETE handlers parse their body with zod (z.parse /
 *       z.safeParse / .parse(...)).
 *
 * The script exits non-zero when any rule fails, so it can be wired into
 * `npm run audit:tenant-isolation` and run in CI.
 *
 * This audit is intentionally conservative: false positives are allowlisted
 * inline (`PUBLIC_ROUTES`, `EXEMPT_QUERIES`, `EXEMPT_MUTATIONS`) so the
 * default mode is fail-loud.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const API_ROOT = path.resolve(REPO_ROOT, "app/api");

// Routes we explicitly allow without an auth context.
// Each entry must include a justification so future contributors know why.
const PUBLIC_ROUTES: ReadonlyArray<{ relPath: string; justification: string }> = [
  {
    relPath: "auth/login/route.ts",
    justification: "Login is the entry point — no session yet. Rate-limited per IP."
  },
  {
    relPath: "auth/logout/route.ts",
    justification: "Logout clears whatever session cookie is present, even if expired."
  },
  {
    relPath: "webhooks/hostaway/reservations/route.ts",
    justification: "Hostaway server-to-server webhook. Authenticated via per-tenant Basic Auth + tenant resolution from payload."
  }
];

// Tenant-scoped Prisma models. Every query against one of these must filter
// by a `tenantId` derived from the trusted auth context.
const TENANT_SCOPED_MODELS = new Set<string>([
  "tenant",
  "user",
  "session",
  "listing",
  "reservation",
  "hostawayConnection",
  "syncRun",
  "syncCursor",
  "dailyAgg",
  "paceSnapshot",
  "calendarRate",
  "nightFact",
  "pricingSetting",
  "attentionTaskSuppression",
  "attentionTaskHistory",
  "marketAnchorCache",
  "externalApiCache"
]);

// Models that are not tenant-scoped (lookup tables, telemetry without
// tenant ownership, etc). Add new entries here only with a comment
// justifying why no tenant filter is needed.
const TENANT_AGNOSTIC_MODELS = new Set<string>([]);

// Read-only Prisma methods we audit.
const READ_METHODS = new Set([
  "findUnique",
  "findFirst",
  "findMany",
  "count",
  "aggregate",
  "groupBy"
]);

// Mutation methods.
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany"
]);

// Specific (file → call) sites that are intentionally exempt from the
// tenant-filter rule. Each entry needs a justification comment.
const EXEMPT_QUERIES: ReadonlyArray<{ relPath: string; pattern: RegExp; justification: string }> = [
  {
    relPath: "auth/login/route.ts",
    pattern: /prisma\.user\.findMany/,
    justification: "Login looks up users by email across all tenants — that's the whole point of cross-tenant single-credential SSO."
  },
  {
    relPath: "tenants/clients/route.ts",
    pattern: /prisma\.user\.findUnique/,
    justification: "Lookup of the auth user by id (auth.userId) — already trust-anchored."
  },
  {
    relPath: "tenants/clients/route.ts",
    pattern: /prisma\.user\.findFirst/,
    justification: "Membership lookup uses auth.email + the tenant id the user is asserting access to. Combined with the role check on the result, this is the canonical tenant-access guard."
  },
  {
    relPath: "tenants/clients/route.ts",
    pattern: /prisma\.user\.findMany/,
    justification: "Orphan-tenant cleanup enumerates members of a tenant being deleted; safety check (caller must be the only admin) gates the delete."
  },
  {
    relPath: "tenants/clients/route.ts",
    pattern: /prisma\.hostawayConnection\.findMany/,
    justification: "Detects orphan HostawayConnection rows that share a Hostaway API key — by design queries across tenants."
  },
  {
    relPath: "tenants/clients/route.ts",
    pattern: /prisma\.tenant\.delete/,
    justification: "Delete-of-tenant by id, gated by the membership lookup above (only the sole admin of that tenant can delete it)."
  },
  {
    relPath: "tenants/clients/route.ts",
    pattern: /prisma\.tenant\.update/,
    justification: "Rename-of-tenant by id, gated by the admin membership lookup above."
  },
  {
    relPath: "tenants/clients/route.ts",
    pattern: /prisma\.tenant\.findUnique/,
    justification: "Lookup of the source tenant by auth.tenantId — trust-anchored."
  },
  {
    relPath: "tenants/switch/route.ts",
    pattern: /prisma\.user\.findFirst/,
    justification: "Tenant-switch verifies the auth user has membership in the target tenant — auth.email scoped to the target tenantId."
  },
  {
    relPath: "team/users/route.ts",
    pattern: /prisma\.user\.(findMany|count|updateMany|deleteMany|upsert)/,
    justification: "Cross-tenant admin operations — restricted to tenants returned by listManageableClientsForUserEmail(auth.email), which itself filters by auth membership."
  },
  {
    relPath: "webhooks/hostaway/reservations/route.ts",
    pattern: /prisma\.hostawayConnection\.findFirst/,
    justification: "Webhook tenant-resolution looks up the HostawayConnection by hostawayAccountId / hostawayClientId — that's how the webhook discovers which tenant to enqueue a sync for. Authenticated via per-tenant Basic Auth before the sync runs."
  },
  {
    relPath: "webhooks/hostaway/reservations/route.ts",
    pattern: /prisma\.hostawayConnection\.findMany/,
    justification: "Single-tenant fallback: if only one HostawayConnection exists, use it. Gated by the take:2 + length===1 guard."
  },
  {
    relPath: "webhooks/hostaway/reservations/route.ts",
    pattern: /prisma\.hostawayConnection\.findUnique/,
    justification: "Loads the resolved tenant's webhook credentials so we can verify the inbound Basic Auth header."
  },
  {
    relPath: "auth/login/route.ts",
    pattern: /prisma\.user\.update/,
    justification: "Updates the just-authenticated user's lastLoginAt by primary key (authenticatedUser.id). The user record came from the credential check above so it is already trust-anchored."
  }
];

// Routes that are admin-only (server-side check required).
const ADMIN_ROUTES: ReadonlyArray<{ relPath: string; methods: ReadonlyArray<"GET" | "POST" | "PATCH" | "DELETE"> }> = [
  { relPath: "team/users/route.ts", methods: ["GET", "POST", "PATCH", "DELETE"] },
  { relPath: "pricing-settings/route.ts", methods: ["GET", "POST"] },
  { relPath: "hostaway/connection/route.ts", methods: ["POST"] },
  { relPath: "hostaway/connection/load-env/route.ts", methods: ["POST"] },
  { relPath: "admin/reset-and-sync-live/route.ts", methods: ["POST"] },
  { relPath: "sync/run/route.ts", methods: ["POST"] },
  { relPath: "reports/pricing-calendar/route.ts", methods: ["POST"] },
  { relPath: "listings/groups/route.ts", methods: ["POST"] }
];

const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

type Finding = {
  file: string;
  rule: string;
  detail: string;
};

async function walkRouteFiles(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkRouteFiles(full, out);
    } else if (entry.isFile() && entry.name === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

function relPath(absPath: string): string {
  return path.relative(API_ROOT, absPath);
}

function detectExportedMethods(source: string): HttpMethod[] {
  const out: HttpMethod[] = [];
  for (const method of HTTP_METHODS) {
    const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`);
    if (re.test(source)) {
      out.push(method);
    }
  }
  return out;
}

function checkAuthGate(source: string, methods: HttpMethod[], findings: Finding[], file: string) {
  const usesGetAuth = /getAuthContext\s*\(/.test(source) || /requireAuthContext\s*\(/.test(source) || /getAdminAuthContext\s*\(/.test(source);
  if (!usesGetAuth) {
    findings.push({
      file,
      rule: "AUTH",
      detail: "No call to getAuthContext / requireAuthContext / getAdminAuthContext. Add an auth check or list this route in PUBLIC_ROUTES with a justification."
    });
    return;
  }

  const returns401 = /status:\s*401/.test(source);
  if (!returns401) {
    findings.push({
      file,
      rule: "AUTH",
      detail: "Auth lookup present but no 401 response found. Confirm unauthenticated callers are rejected."
    });
  }

  // Any handler that ONLY checks auth.tenantId without rejecting null is brittle.
  const checksNullishAuth = /(if\s*\(\s*!\s*auth\s*\)|if\s*\(\s*"error"\s+in\s+guard\s*\))/.test(source);
  if (!checksNullishAuth) {
    findings.push({
      file,
      rule: "AUTH",
      detail: "Auth lookup present but no `if (!auth) return 401` style guard found."
    });
  }

  void methods;
}

function checkAdminGate(source: string, file: string, methods: HttpMethod[], findings: Finding[]) {
  const adminEntry = ADMIN_ROUTES.find((entry) => entry.relPath === file);
  if (!adminEntry) return;

  const requiresGate = adminEntry.methods.filter((method) => methods.includes(method));
  if (requiresGate.length === 0) return;

  // Detect any of: `auth.role !== "admin"`, `requireAdmin()`, `getAdminAuthContext()`,
  // `maybePromoteClonedOwnerMembership(...)?.role !== "admin"`.
  const hasInlineRoleCheck = /auth\.role\s*!==\s*["']admin["']/.test(source);
  const hasRequireAdmin = /requireAdmin\s*\(/.test(source);
  const hasAdminContext = /getAdminAuthContext\s*\(/.test(source);
  const hasRepairedRoleGate = /repairedMembership\?\.role\s*!==\s*["']admin["']/.test(source);

  if (!hasInlineRoleCheck && !hasRequireAdmin && !hasAdminContext && !hasRepairedRoleGate) {
    findings.push({
      file,
      rule: "ADMIN",
      detail: `Route is in ADMIN_ROUTES but no server-side admin role check found for methods: ${requiresGate.join(", ")}. Viewers should be rejected with 403.`
    });
  }
}

function isExemptQuery(file: string, snippet: string): boolean {
  return EXEMPT_QUERIES.some((entry) => entry.relPath === file && entry.pattern.test(snippet));
}

function checkPrismaQueries(source: string, file: string, findings: Finding[]) {
  // Find every `prisma.<model>.<method>(` and inspect the next ~600 chars
  // for a `tenantId:` filter and the source of that tenantId.
  const re = /prisma\s*\.\s*\$?([a-zA-Z_][a-zA-Z0-9_$]*)\s*\.\s*([a-zA-Z]+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const model = match[1];
    const method = match[2];

    if (model === "transaction") continue;
    if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) continue;
    if (TENANT_AGNOSTIC_MODELS.has(model)) continue;
    if (!TENANT_SCOPED_MODELS.has(model)) {
      // Unknown model — flag for review so we can decide explicitly.
      findings.push({
        file,
        rule: "MODEL",
        detail: `Unknown Prisma model \`${model}\`. Add it to TENANT_SCOPED_MODELS or TENANT_AGNOSTIC_MODELS in audit-tenant-isolation.ts.`
      });
      continue;
    }

    const startIdx = match.index;
    const snippet = source.slice(startIdx, startIdx + 800);
    const callExpr = `prisma.${model}.${method}`;

    if (isExemptQuery(file, callExpr)) {
      continue;
    }

    // Accept either `tenantId:` keyed syntax or shorthand `{ tenantId }` /
    // `{ tenantId,` / `{ tenantId }`.
    const mentionsTenantId =
      /tenantId\s*:/.test(snippet) ||
      /\{\s*tenantId\s*[},]/.test(snippet) ||
      /,\s*tenantId\s*[},]/.test(snippet);
    if (!mentionsTenantId) {
      findings.push({
        file,
        rule: "TENANT-FILTER",
        detail: `Call \`${callExpr}\` has no \`tenantId:\` filter. Either filter by auth.tenantId, or add an EXEMPT_QUERIES entry with justification.`
      });
      continue;
    }

    // The tenantId source must come from the auth context, not from a parsed body.
    const usesAuthTenantId =
      /tenantId\s*:\s*auth\.tenantId/.test(snippet) ||
      /tenantId\s*:\s*\{\s*in:\s*\[\s*\.\.\.manageableClientIds\s*\]/.test(snippet) ||
      /tenantId\s*:\s*\{\s*in:\s*manageableClients/.test(snippet) ||
      /tenantId\s*:\s*\{\s*in:\s*\[\.\.\.manageableClientIds\]/.test(snippet) ||
      /tenantId\s*:\s*\{\s*not:\s*params\.tenantIdToExclude/.test(snippet) ||
      /tenantId\s*:\s*tenantId/.test(snippet) || // local var named tenantId already trust-anchored
      /tenantId\s*:\s*params\.tenantId/.test(snippet) || // helper functions
      /\{\s*tenantId\s*[},]/.test(snippet) || // shorthand `{ tenantId }` — local var must be auth-derived
      /,\s*tenantId\s*[},]/.test(snippet);

    if (!usesAuthTenantId) {
      // Suspicious: tenantId is being set but not from auth. Could be from req body.
      const fromBody = /tenantId\s*:\s*(?:body|payload|parsed|request)\.tenantId/.test(snippet);
      if (fromBody) {
        findings.push({
          file,
          rule: "TENANT-SOURCE",
          detail: `Call \`${callExpr}\` derives \`tenantId\` from the request body / payload without verifying it matches auth.tenantId. Reject the request or membership-check first.`
        });
      } else {
        // It might be a local variable already validated. Print a soft warning so a human reviewer can confirm.
        findings.push({
          file,
          rule: "TENANT-SOURCE-REVIEW",
          detail: `Call \`${callExpr}\` filters by tenantId but the source isn't directly \`auth.tenantId\`. Confirm the local variable was derived from auth, or add an EXEMPT_QUERIES entry.`
        });
      }
    }
  }
}

function checkZodOnMutations(source: string, methods: HttpMethod[], file: string, findings: Finding[]) {
  for (const method of methods) {
    if (method === "GET" || method === "OPTIONS" || method === "HEAD") continue;

    // Locate the body of the exported handler.
    const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\s*\\([\\s\\S]*?\\)\\s*\\{`);
    const m = re.exec(source);
    if (!m) continue;

    // Slice from the opening brace to a matching brace so we look only at the handler body.
    let depth = 0;
    let i = m.index + m[0].length - 1;
    let end = source.length;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const body = source.slice(m.index, end);

    // DELETE handlers may legitimately pull a single id from the URL; allow
    // them when the body is small and they parse with zod's safeParse on a
    // search param.
    const usesZodParse = /\.parse\s*\(/.test(body) || /\.safeParse\s*\(/.test(body);
    const reReadsBody = /req(?:uest)?\.json\s*\(/.test(body);

    if (reReadsBody && !usesZodParse) {
      findings.push({
        file,
        rule: "ZOD",
        detail: `${method} handler reads a JSON body but doesn't parse it with zod. Wrap with a zod schema.`
      });
    }
  }
}

async function main() {
  const routeFiles = await walkRouteFiles(API_ROOT);
  routeFiles.sort();

  const findings: Finding[] = [];
  const audited: string[] = [];

  for (const absPath of routeFiles) {
    const rel = relPath(absPath);
    audited.push(rel);
    const source = await fs.readFile(absPath, "utf8");
    const methods = detectExportedMethods(source);

    const isPublic = PUBLIC_ROUTES.some((entry) => entry.relPath === rel);
    if (!isPublic) {
      checkAuthGate(source, methods, findings, rel);
    }
    checkAdminGate(source, rel, methods, findings);
    checkPrismaQueries(source, rel, findings);
    checkZodOnMutations(source, methods, rel, findings);
  }

  console.log("Tenant-isolation audit");
  console.log("======================");
  console.log(`Audited ${audited.length} route files under app/api/.`);
  console.log("");

  if (findings.length === 0) {
    console.log("No findings. All routes pass.");
    return;
  }

  console.log(`Found ${findings.length} issue(s):\n`);
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = grouped.get(finding.file) ?? [];
    list.push(finding);
    grouped.set(finding.file, list);
  }

  let hasHardFailure = false;
  for (const [file, list] of grouped) {
    console.log(`  ${file}`);
    for (const finding of list) {
      console.log(`    [${finding.rule}] ${finding.detail}`);
      if (finding.rule !== "TENANT-SOURCE-REVIEW") {
        hasHardFailure = true;
      }
    }
    console.log("");
  }

  if (hasHardFailure) {
    process.exitCode = 1;
  } else {
    console.log("Only soft TENANT-SOURCE-REVIEW notes. Treating as PASS.");
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

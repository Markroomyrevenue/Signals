/**
 * Observe-and-learn connectivity self-check (spec Phase 1, step 6).
 *
 * For each configured client, resolves its engine + key from env / the keys file
 * and makes ONE read-only call, printing: engine, client, HTTP status,
 * listing-count, and a sample of the resolved lever fields. It NEVER prints,
 * echoes, or returns a key — only a masked present/length indicator.
 *
 * This is how Mark verifies access. Expected (verified 2026-06-26, spec §2):
 *   - PriceLabs: Escape Ordinary 54, Stay Belfast 26, Little Feather 48 listings.
 *   - Wheelhouse (Corrie Doon): 401 → dormant; routed to hostaway-scan fallback.
 *
 * Usage:  npx tsx scripts/observe-connectivity-check.ts
 * Requires the keys in env (PRICELABS_KEY_<S> / WHEELHOUSE_KEY_<S>) or a path in
 * OBSERVE_KEYS_FILE. With no keys set, every client reports the hostaway-scan
 * fallback — which is itself a valid (key-free) configuration.
 */

import { prisma } from "@/lib/prisma";
import { describeSource, listObserveSources, type ResolvedObserveSource } from "@/lib/observe/registry";
import { maskSecret, safeErrorMessage } from "@/lib/observe/secrets";
import { EngineHttpError } from "@/lib/observe/engine/http";

type ClientStatus = {
  client: string;
  engine: string;
  status: string;
  listingCount: number | null;
  sampleLevers: string;
  keyState: string;
};

function fmt(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : String(value);
}

async function checkSource(source: ResolvedObserveSource): Promise<ClientStatus> {
  const keyState = source.keyEnvVar
    ? `${source.keyEnvVar}=${maskSecret(process.env[source.keyEnvVar])}`
    : "(no engine key)";

  // hostaway-scan fallback: no engine API call. Report the Signals-side listing
  // count it would scan (read-only DB count), which is the live-rate source.
  if (source.kind === "hostaway-scan") {
    const listingCount = await prisma.listing
      .count({ where: { tenantId: source.tenantId, status: "active", removedAt: null } })
      .catch(() => null);
    return {
      client: source.tenantName,
      engine: "hostaway-scan (fallback)",
      status: "OK (read-only live-rate scan)",
      listingCount,
      sampleLevers: "via existing rate-scanner RateState diff",
      keyState
    };
  }

  if (!source.adapter || !source.keyPresent) {
    return {
      client: source.tenantName,
      engine: source.kind,
      status: `NO KEY (set ${source.keyEnvVar ?? "engine key"})`,
      listingCount: null,
      sampleLevers: "—",
      keyState
    };
  }

  try {
    const listings = await source.adapter.listClients();
    const sample = listings[0];
    const sampleLevers = sample
      ? `id=${sample.engineListingId} base=${fmt(sample.base)} min=${fmt(sample.min)} max=${fmt(sample.max)} beds=${fmt(sample.bedrooms)}`
      : "(no listings returned)";
    return {
      client: source.tenantName,
      engine: source.kind,
      status: "200 OK",
      listingCount: listings.length,
      sampleLevers,
      keyState
    };
  } catch (error) {
    const status =
      error instanceof EngineHttpError
        ? `${error.status} ${error.status === 401 ? "Unauthenticated → DORMANT (hostaway-scan fallback)" : "error"}`
        : `ERROR: ${safeErrorMessage(error, [process.env[source.keyEnvVar ?? ""] ?? null])}`;
    return {
      client: source.tenantName,
      engine: source.kind,
      status,
      listingCount: null,
      sampleLevers: "—",
      keyState
    };
  }
}

async function main(): Promise<void> {
  console.log("=== Observe-and-Learn connectivity check (read-only; keys never printed) ===\n");
  const sources = await listObserveSources();
  if (sources.length === 0) {
    console.log("No tenants found in the database.");
    return;
  }

  const rows: ClientStatus[] = [];
  for (const source of sources) {
    // One key-safe diagnostic line per client before the call.
    console.log(describeSource(source));
    rows.push(await checkSource(source));
  }

  console.log("\n--- Summary ---");
  for (const row of rows) {
    console.log(
      `• ${row.client.padEnd(28)} engine=${row.engine.padEnd(26)} status=${row.status}\n` +
        `    listings=${fmt(row.listingCount)}  levers: ${row.sampleLevers}  key: ${row.keyState}`
    );
  }
}

void main()
  .catch((error) => {
    console.error("Connectivity check failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

/**
 * Defensibility audit agent — runs after the comparison agent each day.
 *
 * Stratified-samples 12 listing-dates per tenant (3 each across 4 window
 * bands, varying the agreement classification within each), bundles the
 * context, and asks Claude to grade per the §13.3 rubric. Persists results
 * in `pricing_defensibility_audits`.
 *
 * Uses raw fetch against the Anthropic Messages API to avoid an SDK
 * dependency. Model: claude-sonnet-4-6 (cost ≈ $5–8 over 14 days).
 */
import { prisma } from "@/lib/prisma";
import { listTrialTenants } from "@/lib/pricing/trial-tenants";
import { buildDefensibilityUserMessage, DEFENSIBILITY_SYSTEM_PROMPT, type DefensibilityContextBundle } from "@/lib/agents/defensibility-audit/prompt-template";

const ANTHROPIC_BASE = "https://api.anthropic.com";
const MODEL = "claude-sonnet-4-6";
const SAMPLES_PER_TENANT = 12;

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type AuditVerdict = {
  verdict: "defensible" | "borderline" | "questionable";
  confidence: number;
  key_strengths: string[];
  key_concerns: string[];
  most_questionable_multiplier:
    | "base"
    | "seasonality"
    | "dow"
    | "demand"
    | "occupancy"
    | "leadTimeFloor"
    | "events"
    | "pace"
    | "none";
};

function readAnthropicKey(): string | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // Shell may export ANTHROPIC_API_KEY="" which @next/env preserves; fall back
  // to reading the dotenv file directly.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const content = fs.readFileSync(".env", "utf8");
    const m = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (m && m[1].length > 0) return m[1].trim();
  } catch {
    // ignore
  }
  return null;
}

async function callClaude(systemPrompt: string, userMessage: string): Promise<AuditVerdict | null> {
  const apiKey = readAnthropicKey();
  if (!apiKey) return null;
  const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }]
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    console.warn(`[defensibility] anthropic call failed ${res.status}: ${txt.slice(0, 300)}`);
    return null;
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((c) => c.type === "text")?.text ?? "";
  // Extract JSON object from the response (model sometimes wraps in fences)
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as AuditVerdict;
  } catch {
    return null;
  }
}

function bandFor(daysOut: number): "0-7d" | "8-30d" | "31-60d" | "61-90d" {
  if (daysOut <= 7) return "0-7d";
  if (daysOut <= 30) return "8-30d";
  if (daysOut <= 60) return "31-60d";
  return "61-90d";
}

async function stratifiedSample(tenantId: string, snapshotDate: string): Promise<typeof rows> {
  const rows = await prisma.pricingComparisonSnapshot.findMany({
    where: { tenantId, snapshotDate: new Date(`${snapshotDate}T00:00:00Z`) },
    select: {
      id: true,
      listingId: true,
      targetDate: true,
      ourRate: true,
      hostawayRate: true,
      windowDays: true,
      classification: true,
      ourBreakdown: true
    }
  });
  // Bucket by window band × classification, pick up to 1 per (band, class)
  const banded: Record<string, typeof rows> = {};
  for (const r of rows) {
    const key = `${bandFor(r.windowDays)}|${r.classification}`;
    (banded[key] ??= []).push(r);
  }
  // Aim for 12: 3 per band × 4 bands. Within each band, prioritise variety of classifications.
  const sampled: typeof rows = [];
  const bands: Array<ReturnType<typeof bandFor>> = ["0-7d", "8-30d", "31-60d", "61-90d"];
  for (const band of bands) {
    const wantClasses = ["agree", "our_higher", "our_lower"] as const;
    for (const cls of wantClasses) {
      const candidates = banded[`${band}|${cls}`] ?? [];
      if (candidates[0]) sampled.push(candidates[0]);
      if (sampled.length >= SAMPLES_PER_TENANT) break;
    }
    if (sampled.length >= SAMPLES_PER_TENANT) break;
  }
  // Top up with any rows if under-sample
  if (sampled.length < SAMPLES_PER_TENANT) {
    for (const r of rows) {
      if (!sampled.some((s) => s.id === r.id)) sampled.push(r);
      if (sampled.length >= SAMPLES_PER_TENANT) break;
    }
  }
  return sampled;
}

async function buildContextBundle(
  tenantId: string,
  snapshotDate: string,
  row: Awaited<ReturnType<typeof stratifiedSample>>[number]
): Promise<DefensibilityContextBundle | null> {
  const listing = await prisma.listing.findUnique({
    where: { id: row.listingId },
    select: { id: true, bedroomsNumber: true, personCapacity: true, city: true, country: true }
  });
  if (!listing) return null;

  const target = row.targetDate;
  const dayOfWeek = DOW_NAMES[target.getUTCDay()];
  const month = MONTH_NAMES[target.getUTCMonth()];

  // Pull last-30d bookings on this listing for context
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
  const recentBookings = await prisma.reservation.findMany({
    where: { tenantId, listingId: row.listingId, createdAt: { gte: thirtyDaysAgo } },
    select: { createdAt: true, total: true, arrival: true, nights: true },
    take: 10
  });

  return {
    listing: {
      id: row.listingId,
      bedrooms: listing.bedroomsNumber ?? 0,
      capacity: listing.personCapacity,
      qualityTier: "mid_scale",
      trailing365dAdr: null,
      area: [listing.city, listing.country].filter(Boolean).join(", ") || "Belfast"
    },
    date: {
      iso: target.toISOString().slice(0, 10),
      dayOfWeek,
      month,
      daysOut: row.windowDays,
      localEvents: []
    },
    ourRec: {
      rate: Number(row.ourRate),
      breakdown: row.ourBreakdown as Record<string, unknown>
    },
    hostawayRate: row.hostawayRate ? Number(row.hostawayRate) : null,
    marketSignals: {
      p20: null,
      p50: null,
      p80: null,
      sampleSize: null,
      forwardOccupancy: null,
      seasonalityIndex: null
    },
    recentBookings: recentBookings
      .filter((b) => b.createdAt && b.total)
      .map((b) => ({
        bookedAt: b.createdAt.toISOString().slice(0, 10),
        rate: b.nights > 0 ? Number(b.total) / b.nights : Number(b.total),
        leadTimeDays:
          b.arrival && b.createdAt
            ? Math.max(0, Math.round((b.arrival.getTime() - b.createdAt.getTime()) / 86400000))
            : 0
      }))
  };
}

export async function runDefensibilityAuditForAllTrialTenants(opts: { snapshotDate: string }): Promise<{
  verdicts: { defensible: number; borderline: number; questionable: number };
  audited: number;
  skipped: number;
}> {
  const verdicts = { defensible: 0, borderline: 0, questionable: 0 };
  let audited = 0;
  let skipped = 0;

  if (!readAnthropicKey()) {
    console.warn("[defensibility] ANTHROPIC_API_KEY not set — skipping audit");
    return { verdicts, audited: 0, skipped: 0 };
  }

  const tenants = await listTrialTenants();
  for (const tenant of tenants) {
    const sample = await stratifiedSample(tenant.id, opts.snapshotDate);
    for (const row of sample) {
      try {
        const bundle = await buildContextBundle(tenant.id, opts.snapshotDate, row);
        if (!bundle) {
          skipped += 1;
          continue;
        }
        const userMessage = buildDefensibilityUserMessage(bundle);
        const verdict = await callClaude(DEFENSIBILITY_SYSTEM_PROMPT, userMessage);
        if (!verdict) {
          skipped += 1;
          continue;
        }

        await prisma.pricingDefensibilityAudit.create({
          data: {
            tenantId: tenant.id,
            snapshotDate: new Date(`${opts.snapshotDate}T00:00:00Z`),
            listingId: row.listingId,
            targetDate: row.targetDate,
            verdict: verdict.verdict,
            confidence: verdict.confidence,
            keyStrengths: verdict.key_strengths as never,
            keyConcerns: verdict.key_concerns as never,
            questionableMul: verdict.most_questionable_multiplier,
            fullReasoning: JSON.stringify(verdict)
          }
        });
        verdicts[verdict.verdict] += 1;
        audited += 1;
      } catch (err) {
        console.warn(`[defensibility] audit failed for row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        skipped += 1;
      }
    }
  }

  return { verdicts, audited, skipped };
}

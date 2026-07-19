/**
 * Apply the learner-fidelity agent's low-confidence rule (2026-07-18 review)
 * to each tenant's warm-start evidence and write `fidelity-note` rows the recs
 * page renders as banners. Run AFTER `recs-warmstart.ts` against the same DB.
 *
 * Predicate per client (thresholds tied to the code's own bars — DOSE_MIN_N /
 * WARMSTART_MIN_MATCHED = 20, MARK_PRIOR_FULL_N = 20/bucket):
 *   R1  episodesTotal < 50 OR settledTreated < 30  → history too thin to seed a prior
 *   R2  no cell with matchedTreatedNights >= 20 and a fill delta               → no usable outcome evidence
 *   R3  usable cells exist but none carries fill information (0% vs 0%)        → informationless
 *   R4  the engine autoposts prices on this account (Coorie Doon / Wheelhouse) → the prior is the
 *       engine's pattern, not the operator's
 * Clients tripping nothing get their stale fidelity-note removed (confidence restored).
 *
 * Usage: npx tsx scripts/recs-fidelity-notes.ts [--prod]
 */

import { PrismaClient } from "@prisma/client";

import { ensureEnvLoaded } from "@/lib/load-env";
import { resolveObserveSource } from "@/lib/observe/registry";
import type { DropOutcomesPayload, MarkPriorPayload } from "@/lib/recs/warmstart";

const MIN_EPISODES = 50;
const MIN_SETTLED = 30;
const MIN_MATCHED = 20;

type Verdict = { lowConfidence: boolean; rules: string[]; note: string; question: string | null };

function judge(args: {
  tenantName: string;
  engine: string;
  markPrior: MarkPriorPayload | null;
  dropOutcomes: DropOutcomesPayload | null;
}): Verdict {
  const rules: string[] = [];
  const episodes = args.markPrior?.episodesTotal ?? 0;
  const settled = args.dropOutcomes?.treatedNightsSettled ?? 0;
  const cells = args.dropOutcomes?.cells ?? [];
  const usable = cells.filter((c) => c.matchedTreatedNights >= MIN_MATCHED && c.fillDeltaPp !== null);
  const informative = usable.filter((c) => (c.treatedFillRateMatched ?? 0) > 0 || (c.controlFillRate ?? 0) > 0);
  const engineAutoposts = args.engine === "wheelhouse";

  if (episodes < MIN_EPISODES || settled < MIN_SETTLED) rules.push("R1");
  if (usable.length === 0) rules.push("R2");
  if (usable.length > 0 && informative.length === 0) rules.push("R3");
  if (engineAutoposts) rules.push("R4");

  if (rules.length === 0) {
    return { lowConfidence: false, rules, note: "", question: null };
  }

  let note: string;
  let question: string | null;
  if (rules.includes("R4")) {
    // Mark's answer 2026-07-19: he makes manual changes in EVERY client, so
    // the mined moves are a MIX of his hand and the engine's autoposts — the
    // record cannot separate which is which per move.
    note =
      `The prior bands here are mined from ~${episodes} rate moves that mix your manual changes with ` +
      `Wheelhouse's autoposts — the record can't separate which is which per move, so read them as the ` +
      `account's combined pattern` +
      (rules.includes("R3") ? ", and the measured outcome cells carry no fill information either way" : "") +
      ".";
    question = null;
  } else if (rules.includes("R1")) {
    note =
      episodes === 0
        ? "No ≥3% drop history in the scan record — recs here are curve + market only; there is no learned prior for this account yet."
        : `Drop history is thin (${episodes} episodes, ${settled} settled treated nights) — recs lean on the booking curve; the prior and outcome evidence are weak.`;
    question =
      "This account shows little-to-no observed price-drop history — do you actually drop here (perhaps the engine does it invisibly to us), or is holding steady the strategy?";
  } else {
    // R2/R3: prior seeded, but outcome evidence below the bar / informationless.
    note =
      `Prior is seeded (n=${episodes} moves — a mix of your manual changes and the engine's, per your ` +
      `2026-07-19 answer) but no outcome cell reaches the n=${MIN_MATCHED} evidence bar — sizes lean on ` +
      `the account prior + curve; measured outcomes are not being used yet.`;
    question = null;
  }
  return { lowConfidence: true, rules, note, question };
}

async function main(): Promise<void> {
  ensureEnvLoaded();
  const prod = process.argv.includes("--prod");
  const url = prod ? process.env.DATABASE_PUBLIC_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(prod ? "DATABASE_PUBLIC_URL is not set" : "DATABASE_URL is not set");
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const tenants = await db.tenant.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
    for (const tenant of tenants) {
      const evidence = await db.recsEvidence.findMany({
        where: { tenantId: tenant.id, kind: { in: ["mark-prior", "drop-outcomes"] } },
        select: { kind: true, payload: true }
      });
      const markPrior = (evidence.find((r) => r.kind === "mark-prior")?.payload ?? null) as MarkPriorPayload | null;
      const dropOutcomes = (evidence.find((r) => r.kind === "drop-outcomes")?.payload ?? null) as DropOutcomesPayload | null;
      const engine = resolveObserveSource({ id: tenant.id, name: tenant.name }).kind;
      const verdict = judge({ tenantName: tenant.name, engine, markPrior, dropOutcomes });

      if (verdict.lowConfidence) {
        await db.recsEvidence.upsert({
          where: { tenantId_clientKey_kind: { tenantId: tenant.id, clientKey: tenant.id, kind: "fidelity-note" } },
          create: {
            tenantId: tenant.id,
            clientKey: tenant.id,
            kind: "fidelity-note",
            provenance: "warm-start",
            payload: { lowConfidence: true, rules: verdict.rules, note: verdict.note, question: verdict.question }
          },
          update: {
            payload: { lowConfidence: true, rules: verdict.rules, note: verdict.note, question: verdict.question },
            computedAt: new Date()
          }
        });
        console.log(`[fidelity] ${tenant.name}: LOW-CONFIDENCE [${verdict.rules.join(",")}] — ${verdict.note.slice(0, 90)}…`);
      } else {
        await db.recsEvidence.deleteMany({
          where: { tenantId: tenant.id, clientKey: tenant.id, kind: "fidelity-note" }
        });
        console.log(`[fidelity] ${tenant.name}: confident (no note)`);
      }
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(`[fidelity] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

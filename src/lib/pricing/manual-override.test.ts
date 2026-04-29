import test from "node:test";
import assert from "node:assert/strict";

import {
  applyManualOverride,
  planSupersedeForOverlap,
  type PricingManualOverrideDto
} from "@/lib/pricing/manual-override";

function dummyDto(input: {
  id: string;
  startDate: string;
  endDate: string;
  type?: "fixed" | "percentage_delta";
  value?: number;
  notes?: string | null;
}): PricingManualOverrideDto {
  return {
    id: input.id,
    tenantId: "t1",
    listingId: "l1",
    startDate: input.startDate,
    endDate: input.endDate,
    overrideType: input.type ?? "fixed",
    overrideValue: input.value ?? 100,
    notes: input.notes ?? null,
    createdBy: "u1",
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T00:00:00.000Z",
    removedAt: null,
    removedBy: null
  };
}

test("applyManualOverride: fixed override below user min still wins (no floor enforcement)", () => {
  const r = applyManualOverride({
    override: dummyDto({ id: "o1", startDate: "2026-05-01", endDate: "2026-05-01", type: "fixed", value: 50 }),
    dynamicRate: 100,
    recommendedMinimum: 80,
    userMinimumOverride: 80,
    roundingIncrement: 1
  });
  assert.equal(r.finalRate, 50);
  assert.equal(r.overrideApplied?.type, "fixed");
  assert.equal(r.reason, "fixed override");
});

test("applyManualOverride: percentage override hits min floor when result would go lower", () => {
  // 100 × (1 - 0.5) = 50, but min is 80 → 80.
  const r = applyManualOverride({
    override: dummyDto({
      id: "o1",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
      type: "percentage_delta",
      value: -0.5
    }),
    dynamicRate: 100,
    recommendedMinimum: 80,
    userMinimumOverride: 80,
    roundingIncrement: 1
  });
  assert.equal(r.finalRate, 80);
  assert.equal(r.overrideApplied?.type, "percentage_delta");
});

test("applyManualOverride: no override returns dynamic rate unchanged", () => {
  const r = applyManualOverride({
    override: null,
    dynamicRate: 123.45,
    recommendedMinimum: 80,
    userMinimumOverride: 80,
    roundingIncrement: 1
  });
  assert.equal(r.finalRate, 123.45);
  assert.equal(r.overrideApplied, null);
});

test("applyManualOverride: percentage override is rounded to roundingIncrement", () => {
  // 100 × (1 + 0.155) = 115.5 → rounded to nearest £5 = 115.
  const r = applyManualOverride({
    override: dummyDto({
      id: "o1",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
      type: "percentage_delta",
      value: 0.155
    }),
    dynamicRate: 100,
    recommendedMinimum: 80,
    userMinimumOverride: null,
    roundingIncrement: 5
  });
  assert.equal(r.finalRate, 115);
});

test("planSupersede: fully-contained existing override is soft-deleted", () => {
  const plan = planSupersedeForOverlap({
    existing: [
      dummyDto({ id: "old", startDate: "2026-05-05", endDate: "2026-05-09" })
    ],
    newStartDate: "2026-05-01",
    newEndDate: "2026-05-15"
  });
  assert.equal(plan.mutations.length, 1);
  assert.equal(plan.mutations[0]?.kind, "soft-delete");
  assert.match(plan.summary, /1 existing override/);
});

test("planSupersede: partial overlap at start → trim-start", () => {
  // existing 05-10 → 05-20 ; new 05-01 → 05-12 ; existing trims to 05-13 → 05-20
  const plan = planSupersedeForOverlap({
    existing: [dummyDto({ id: "old", startDate: "2026-05-10", endDate: "2026-05-20" })],
    newStartDate: "2026-05-01",
    newEndDate: "2026-05-12"
  });
  assert.equal(plan.mutations.length, 1);
  const m = plan.mutations[0];
  assert.equal(m?.kind, "trim-start");
  if (m?.kind !== "trim-start") return;
  assert.equal(m.newStartDate, "2026-05-13");
});

test("planSupersede: partial overlap at end → trim-end", () => {
  // existing 05-01 → 05-10 ; new 05-08 → 05-15 ; existing trims to 05-01 → 05-07
  const plan = planSupersedeForOverlap({
    existing: [dummyDto({ id: "old", startDate: "2026-05-01", endDate: "2026-05-10" })],
    newStartDate: "2026-05-08",
    newEndDate: "2026-05-15"
  });
  assert.equal(plan.mutations.length, 1);
  const m = plan.mutations[0];
  assert.equal(m?.kind, "trim-end");
  if (m?.kind !== "trim-end") return;
  assert.equal(m.newEndDate, "2026-05-07");
});

test("planSupersede: existing fully contains new → split", () => {
  // existing 05-01 → 05-30 ; new 05-10 → 05-20 ;
  // → trim existing to 05-01 → 05-09, create right wing 05-21 → 05-30.
  const plan = planSupersedeForOverlap({
    existing: [
      dummyDto({
        id: "old",
        startDate: "2026-05-01",
        endDate: "2026-05-30",
        type: "percentage_delta",
        value: -0.1,
        notes: "Spring discount"
      })
    ],
    newStartDate: "2026-05-10",
    newEndDate: "2026-05-20"
  });
  assert.equal(plan.mutations.length, 1);
  const m = plan.mutations[0];
  assert.equal(m?.kind, "split");
  if (m?.kind !== "split") return;
  assert.equal(m.leftEndDate, "2026-05-09");
  assert.equal(m.rightStartDate, "2026-05-21");
  assert.equal(m.rightEndDate, "2026-05-30");
  assert.equal(m.rightOverrideType, "percentage_delta");
  assert.equal(m.rightOverrideValue, -0.1);
  assert.equal(m.rightNotes, "Spring discount");
});

test("planSupersede: no overlap → no mutations, empty summary", () => {
  const plan = planSupersedeForOverlap({
    existing: [dummyDto({ id: "old", startDate: "2026-04-01", endDate: "2026-04-10" })],
    newStartDate: "2026-05-01",
    newEndDate: "2026-05-10"
  });
  assert.equal(plan.mutations.length, 0);
  assert.equal(plan.summary, "");
});

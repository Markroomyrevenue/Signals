import assert from "node:assert/strict";
import test from "node:test";

import {
  type RecsAdapterFactory,
  type RecsPushLogRecord,
  type RecsPushLogStore,
  type RecsSuggestionRow,
  type RecsSuggestionStore
} from "./push-service";
import { revertPushedNight } from "./revert-service";
import type { RecsEnginePushAdapter } from "./types";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

function appliedSuggestion(overrides: Partial<RecsSuggestionRow> = {}): RecsSuggestionRow {
  return {
    id: "sug-1",
    tenantId: "t1",
    clientKey: "little-feather",
    listingId: "l1",
    engineListingId: "12345",
    date: "2026-12-01",
    status: "applied",
    oldValue: 110,
    proposedValue: 120,
    approvedPrice: null,
    pushRef: "log-push-1",
    detail: {
      floor: 90,
      push: { pushedAt: "2026-07-18T09:00:00.000Z", verified: true, observedPrice: 120 }
    },
    ...overrides
  };
}

function makeStores(initial: RecsSuggestionRow | null) {
  let suggestion = initial;
  const pushLogs: RecsPushLogRecord[] = [];
  const updates: unknown[] = [];
  let nextId = 1;

  const suggestionStore: RecsSuggestionStore = {
    async load({ tenantId, suggestionId }) {
      if (!suggestion || suggestion.tenantId !== tenantId || suggestion.id !== suggestionId) {
        return null;
      }
      return { ...suggestion, detail: suggestion.detail ? { ...suggestion.detail } : null };
    },
    async update(args) {
      updates.push(args);
      if (!suggestion) return;
      if (args.status !== undefined) suggestion = { ...suggestion, status: args.status };
      if (args.pushRef !== undefined) suggestion = { ...suggestion, pushRef: args.pushRef };
      if (args.detail !== undefined) suggestion = { ...suggestion, detail: args.detail };
    }
  };
  const pushLogStore: RecsPushLogStore = {
    async record(row) {
      pushLogs.push(row);
      return { id: `log-${nextId++}` };
    }
  };
  return {
    suggestionStore,
    pushLogStore,
    pushLogs,
    updates,
    get suggestion() {
      return suggestion;
    }
  };
}

function fakeAdapter(overrides: Partial<RecsEnginePushAdapter> = {}): RecsEnginePushAdapter & {
  readonly revertCalls: number;
} {
  let revertCalls = 0;
  const defaults: RecsEnginePushAdapter = {
    engine: "pricelabs",
    preview: async () => ({ ok: true }),
    execute: async () => ({ ok: true }),
    verify: async () => ({ attempted: true, verified: true }),
    revert: async () => {
      revertCalls += 1;
      return { ok: true };
    },
    verifyReverted: async () => ({ attempted: true, verified: true, observedPrice: null })
  };
  const merged = { ...defaults, ...overrides };
  Object.defineProperty(merged, "revertCalls", { get: () => revertCalls });
  return merged as RecsEnginePushAdapter & { readonly revertCalls: number };
}

const factoryFor =
  (adapter: RecsEnginePushAdapter): RecsAdapterFactory =>
  async () => ({ ok: true, adapter });

const ARGS = {
  tenantId: "t1",
  tenantName: "Little Feather",
  suggestionId: "sug-1",
  engine: "pricelabs",
  actorEmail: "mark@roomyrevenue.com"
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("verified revert: PushLog kind=revert, status STAYS applied, pushRef kept, detail.push.reverted set", async () => {
  const stores = makeStores(appliedSuggestion());
  const adapter = fakeAdapter();
  const outcome = await revertPushedNight(ARGS, {
    ...stores,
    adapterFactory: factoryFor(adapter),
    now: () => new Date("2026-07-18T12:00:00Z")
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.result, "success");
  assert.equal(adapter.revertCalls, 1);

  assert.equal(stores.pushLogs.length, 1);
  const log = stores.pushLogs[0];
  assert.equal(log.detail.kind, "revert");
  assert.equal(log.result, "success");
  assert.equal(log.oldValue, 120, "oldValue records the price being removed");
  assert.equal(log.newValue, null, "newValue is null — the engine takes back control");
  assert.equal(log.reason, "recs-revert by mark@roomyrevenue.com");

  assert.equal(stores.suggestion?.status, "applied", "status must NOT change on revert");
  assert.equal(stores.suggestion?.pushRef, "log-push-1", "pushRef stays — push-once holds");
  const push = (stores.suggestion?.detail?.push ?? {}) as Record<string, unknown>;
  const reverted = push.reverted as Record<string, unknown>;
  assert.equal(reverted.verified, true);
  assert.equal(reverted.by, "mark@roomyrevenue.com");
  assert.equal(reverted.at, "2026-07-18T12:00:00.000Z");
  assert.equal(push.observedPrice, 120, "the original push evidence survives the merge");
});

test("gate: status not applied → skipped not_applied, engine untouched", async () => {
  const stores = makeStores(appliedSuggestion({ status: "approved" }));
  const adapter = fakeAdapter();
  const outcome = await revertPushedNight(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "not_applied");
  assert.equal(adapter.revertCalls, 0);
  assert.equal(stores.pushLogs[0].detail.kind, "revert");
  assert.equal(stores.updates.length, 0);
});

test("gate: missing pushRef → skipped no_push_ref", async () => {
  const stores = makeStores(appliedSuggestion({ pushRef: null }));
  const adapter = fakeAdapter();
  const outcome = await revertPushedNight(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "no_push_ref");
  assert.equal(adapter.revertCalls, 0);
});

test("gate: already reverted → skipped already_reverted (revert is once too)", async () => {
  const stores = makeStores(
    appliedSuggestion({
      detail: {
        push: {
          pushedAt: "2026-07-18T09:00:00.000Z",
          verified: true,
          reverted: { at: "2026-07-18T10:00:00.000Z", by: "mark@roomyrevenue.com", verified: true }
        }
      }
    })
  );
  const adapter = fakeAdapter();
  const outcome = await revertPushedNight(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "already_reverted");
  assert.equal(adapter.revertCalls, 0);
});

test("gate: unknown engine → skipped engine_not_allowed", async () => {
  const stores = makeStores(appliedSuggestion());
  const outcome = await revertPushedNight(
    { ...ARGS, engine: "hostaway" },
    { ...stores, adapterFactory: factoryFor(fakeAdapter()) }
  );
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "engine_not_allowed");
});

test("verify-gone mismatch: failed revert_verify_mismatch, suggestion left untouched", async () => {
  const stores = makeStores(appliedSuggestion());
  const adapter = fakeAdapter({
    verifyReverted: async () => ({ attempted: true, verified: false, observedPrice: 120 })
  });
  const outcome = await revertPushedNight(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "revert_verify_mismatch");
  assert.equal(stores.pushLogs[0].result, "failed");
  assert.equal(stores.updates.length, 0, "an unverified revert must not flag the suggestion");
  const push = (stores.suggestion?.detail?.push ?? {}) as Record<string, unknown>;
  assert.equal(push.reverted, undefined);
});

test("engine throw during revert → failed engine_error, suggestion untouched, one PushLog row", async () => {
  const stores = makeStores(appliedSuggestion());
  const adapter = fakeAdapter({
    revert: async () => {
      throw new Error("HTTP 502 from engine: gateway sad");
    }
  });
  const outcome = await revertPushedNight(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });
  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "engine_error");
  assert.equal(stores.pushLogs.length, 1);
  assert.equal(stores.updates.length, 0);
});

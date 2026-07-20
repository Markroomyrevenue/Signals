import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDefaultAdapterFactory,
  executeApprovedPush,
  type RecsAdapterFactory,
  type RecsPushLogRecord,
  type RecsPushLogStore,
  type RecsSuggestionRow,
  type RecsSuggestionStore
} from "./push-service";
import type { RecsEnginePushAdapter } from "./types";

const FAKE_KEY = "pl_live_secret_value_1234567890"; // not real

// ---------------------------------------------------------------------------
// In-memory fakes — the tests hit no DB and no network.
// ---------------------------------------------------------------------------

function baseSuggestion(overrides: Partial<RecsSuggestionRow> = {}): RecsSuggestionRow {
  return {
    id: "sug-1",
    tenantId: "t1",
    clientKey: "little-feather",
    listingId: "l1",
    engineListingId: "12345",
    date: "2026-12-01",
    status: "approved",
    oldValue: 110,
    proposedValue: 120,
    approvedPrice: null,
    pushRef: null,
    detail: { floor: 90 },
    ...overrides
  };
}

function makeStores(initial: RecsSuggestionRow | null) {
  let suggestion = initial;
  const pushLogs: RecsPushLogRecord[] = [];
  const updates: Array<{
    tenantId: string;
    suggestionId: string;
    status?: "applied";
    pushRef?: string;
    detail?: Record<string, unknown>;
  }> = [];
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
    },
    async claimForPush({ tenantId, suggestionId, claimRef }) {
      // Mirrors the conditional updateMany: claim only an approved, unclaimed row.
      if (!suggestion || suggestion.tenantId !== tenantId || suggestion.id !== suggestionId) return false;
      if (suggestion.status !== "approved" || (suggestion.pushRef ?? "").length > 0) return false;
      suggestion = { ...suggestion, pushRef: claimRef };
      return true;
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

type FakeAdapter = RecsEnginePushAdapter & { readonly executeCalls: number };

function fakeAdapter(overrides: Partial<RecsEnginePushAdapter> = {}): FakeAdapter {
  let executeCalls = 0;
  const defaults: RecsEnginePushAdapter = {
    engine: "pricelabs",
    preview: async () => ({ ok: true }),
    execute: async () => {
      executeCalls += 1;
      return { ok: true };
    },
    verify: async () => ({ attempted: true, verified: true, observedPrice: 120 }),
    revert: async () => ({ ok: true }),
    verifyReverted: async () => ({ attempted: true, verified: true })
  };
  const merged = { ...defaults, ...overrides };
  Object.defineProperty(merged, "executeCalls", { get: () => executeCalls });
  return merged as FakeAdapter;
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
// Hard gates
// ---------------------------------------------------------------------------

test("gate: suggestion not found → skipped, one PushLog row, engine untouched", async () => {
  const stores = makeStores(null);
  const adapter = fakeAdapter();
  const outcome = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });

  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "suggestion_not_found");
  assert.equal(stores.pushLogs.length, 1);
  assert.equal(stores.pushLogs[0].result, "skipped");
  assert.equal(adapter.executeCalls, 0);
});

test("gate: status not exactly 'approved' → skipped not_approved (pending, applied, rejected)", async () => {
  for (const status of ["pending", "applied", "rejected", "shadow", "superseded"]) {
    const stores = makeStores(baseSuggestion({ status }));
    const adapter = fakeAdapter();
    const outcome = await executeApprovedPush(ARGS, {
      ...stores,
      adapterFactory: factoryFor(adapter)
    });
    assert.equal(outcome.result, "skipped", status);
    assert.equal(outcome.reason, "not_approved", status);
    assert.equal(adapter.executeCalls, 0, status);
    assert.equal(stores.pushLogs.length, 1, status);
    assert.equal(stores.updates.length, 0, `${status}: gates must not touch the suggestion`);
  }
});

test("gate: pushRef already set → skipped already_pushed (push-once idempotency)", async () => {
  const stores = makeStores(baseSuggestion({ pushRef: "log-earlier" }));
  const adapter = fakeAdapter();
  const outcome = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });

  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "already_pushed");
  assert.equal(adapter.executeCalls, 0);
  assert.equal(stores.pushLogs[0].detail.gate, "already_pushed");
});

test("gate: no usable price → skipped invalid_price", async () => {
  for (const overrides of [
    { proposedValue: null, approvedPrice: null },
    { proposedValue: 0, approvedPrice: null },
    { proposedValue: -5, approvedPrice: null }
  ]) {
    const stores = makeStores(baseSuggestion(overrides));
    const adapter = fakeAdapter();
    const outcome = await executeApprovedPush(ARGS, {
      ...stores,
      adapterFactory: factoryFor(adapter)
    });
    assert.equal(outcome.result, "skipped");
    assert.equal(outcome.reason, "invalid_price");
    assert.equal(adapter.executeCalls, 0);
  }
});

test("gate: price below floor → skipped below_floor — unless the price was TYPED by the operator", async () => {
  // Proposed (engine-recommended) price below floor.
  const proposed = makeStores(baseSuggestion({ proposedValue: 85, detail: { floor: 90 } }));
  const adapterA = fakeAdapter();
  const a = await executeApprovedPush(ARGS, { ...proposed, adapterFactory: factoryFor(adapterA) });
  assert.equal(a.reason, "below_floor");
  assert.equal(adapterA.executeCalls, 0);

  // Legacy edited approvedPrice below floor with NO typedPrice stamp: still
  // blocked (rows approved before 2026-07-20 carry no stamp — stay safe).
  const edited = makeStores(
    baseSuggestion({ proposedValue: 120, approvedPrice: 80, detail: { floor: 90 } })
  );
  const adapterB = fakeAdapter();
  const b = await executeApprovedPush(ARGS, { ...edited, adapterFactory: factoryFor(adapterB) });
  assert.equal(b.result, "skipped");
  assert.equal(b.reason, "below_floor");
  assert.equal(adapterB.executeCalls, 0);
  assert.equal(edited.pushLogs[0].detail.floor, 90);
  assert.equal(edited.pushLogs[0].detail.price, 80);

  // Operator-TYPED price below floor (detail.typedPrice stamped at approve
  // time): the operator's call — pushes (Mark, 2026-07-20).
  const typed = makeStores(
    baseSuggestion({ proposedValue: 120, approvedPrice: 80, detail: { floor: 90, typedPrice: true } })
  );
  const adapterT = fakeAdapter();
  const t = await executeApprovedPush(ARGS, { ...typed, adapterFactory: factoryFor(adapterT) });
  assert.equal(t.result, "success");
  assert.equal(adapterT.executeCalls, 1);

  // floorUnknown (floor null) does NOT block — there is nothing to compare.
  const unknown = makeStores(baseSuggestion({ detail: { floorUnknown: true } }));
  const adapterC = fakeAdapter();
  const c = await executeApprovedPush(ARGS, { ...unknown, adapterFactory: factoryFor(adapterC) });
  assert.equal(c.result, "success");
});

test("gate: engine not on the allowlist → skipped engine_not_allowed", async () => {
  for (const engine of ["hostaway", "beyond", "", "PriceLabs"]) {
    const stores = makeStores(baseSuggestion());
    const adapter = fakeAdapter();
    const outcome = await executeApprovedPush(
      { ...ARGS, engine },
      { ...stores, adapterFactory: factoryFor(adapter) }
    );
    assert.equal(outcome.result, "skipped", engine);
    assert.equal(outcome.reason, "engine_not_allowed", engine);
    assert.equal(adapter.executeCalls, 0, engine);
  }
});

test("gate: missing engineListingId → skipped missing_engine_listing_id", async () => {
  const stores = makeStores(baseSuggestion({ engineListingId: null }));
  const outcome = await executeApprovedPush(ARGS, {
    ...stores,
    adapterFactory: factoryFor(fakeAdapter())
  });
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "missing_engine_listing_id");
});

// ---------------------------------------------------------------------------
// Keys, preview, execute, verify
// ---------------------------------------------------------------------------

test("missing key → result failed, reason key_missing, message masks the key state", async () => {
  const stores = makeStores(baseSuggestion());
  // Real default factory with an EMPTY env: no key anywhere.
  const outcome = await executeApprovedPush(ARGS, {
    ...stores,
    adapterFactory: buildDefaultAdapterFactory({ env: {}, overlay: {} })
  });

  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "key_missing");
  assert.equal(stores.pushLogs.length, 1);
  assert.equal(stores.pushLogs[0].result, "failed");
  const message = String(stores.pushLogs[0].detail.message);
  assert.ok(message.includes("PRICELABS_KEY_LITTLE_FEATHER"), "message should name the env var");
  assert.ok(message.includes("(unset)"), "message should carry masked state only");
  assert.equal(stores.updates.length, 0, "no suggestion mutation on key_missing");
});

test("wheelhouse needs BOTH read + write keys — one alone is key_missing", async () => {
  const stores = makeStores(baseSuggestion());
  const outcome = await executeApprovedPush(
    { ...ARGS, engine: "wheelhouse" },
    {
      ...stores,
      adapterFactory: buildDefaultAdapterFactory({
        env: { WHEELHOUSE_KEY_LITTLE_FEATHER: FAKE_KEY },
        overlay: {}
      })
    }
  );
  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "key_missing");
  const message = String(stores.pushLogs[0].detail.message);
  assert.ok(message.includes("WHEELHOUSE_WRITE_KEY_LITTLE_FEATHER"));
  assert.ok(!message.includes(FAKE_KEY), "the present key's value must never appear");
});

test("preview blocked (owner_custom_rate_conflict) → skipped, execute never called", async () => {
  const stores = makeStores(baseSuggestion());
  const adapter = fakeAdapter({
    preview: async () => ({ ok: false, blockedReason: "owner_custom_rate_conflict" })
  });
  const outcome = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });

  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "owner_custom_rate_conflict");
  assert.equal(adapter.executeCalls, 0);
  assert.equal(stores.pushLogs.length, 1);
  assert.equal(stores.updates.length, 0, "a blocked preview must leave the suggestion untouched");
});

test("success: verified push flips status to applied, sets pushRef, writes ONE success PushLog row", async () => {
  const stores = makeStores(baseSuggestion());
  const adapter = fakeAdapter();
  const outcome = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.result, "success");
  assert.equal(outcome.pushLogId, "log-1");
  assert.deepEqual(outcome.verify, { attempted: true, verified: true, observedPrice: 120 });

  assert.equal(stores.pushLogs.length, 1, "exactly one PushLog row per attempt");
  const log = stores.pushLogs[0];
  assert.equal(log.result, "success");
  assert.equal(log.newValue, 120);
  assert.equal(log.oldValue, 110);
  assert.equal(log.date, "2026-12-01");
  assert.equal(log.lever, "price");
  assert.equal(log.reason, "recs-approve by mark@roomyrevenue.com");
  assert.equal(log.detail.kind, "push");
  assert.equal(log.detail.suggestionId, "sug-1");
  assert.equal(log.detail.actor, "mark@roomyrevenue.com");

  assert.equal(stores.suggestion?.status, "applied");
  assert.equal(stores.suggestion?.pushRef, "log-1");
  const push = (stores.suggestion?.detail?.push ?? {}) as Record<string, unknown>;
  assert.equal(push.verified, true);
  assert.equal(push.observedPrice, 120);
  assert.ok(typeof push.pushedAt === "string" && push.pushedAt.length > 0);
  // Pre-existing detail keys survive the merge.
  assert.equal(stores.suggestion?.detail?.floor, 90);
});

test("edited approvedPrice above the floor is the value pushed (not proposedValue)", async () => {
  const stores = makeStores(baseSuggestion({ proposedValue: 120, approvedPrice: 111 }));
  let pushedPrice: number | null = null;
  const adapter = fakeAdapter({
    execute: async (t) => {
      pushedPrice = t.price;
      return { ok: true };
    },
    verify: async () => ({ attempted: true, verified: true, observedPrice: 111 })
  });
  const outcome = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });
  assert.equal(outcome.result, "success");
  assert.equal(pushedPrice, 111);
  assert.equal(stores.pushLogs[0].newValue, 111);
});

test("verify_mismatch: result failed, suggestion STAYS approved but pushRef is SET (no double-fire)", async () => {
  const stores = makeStores(baseSuggestion());
  const adapter = fakeAdapter({
    verify: async () => ({ attempted: true, verified: false, observedPrice: 105 })
  });
  const outcome = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "verify_mismatch");

  assert.equal(stores.pushLogs.length, 1);
  assert.equal(stores.pushLogs[0].result, "failed");
  assert.equal(stores.pushLogs[0].detail.reason, "verify_mismatch");

  assert.equal(stores.suggestion?.status, "approved", "verify mismatch must NOT mark applied");
  assert.equal(stores.suggestion?.pushRef, "log-1", "pushRef must be set so it cannot re-fire");
  const push = (stores.suggestion?.detail?.push ?? {}) as Record<string, unknown>;
  assert.equal(push.verified, false);
  assert.equal(push.observedPrice, 105);

  // A second call now hits the already_pushed gate.
  const second = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });
  assert.equal(second.reason, "already_pushed");
});

test("engine throw during execute → failed engine_error, pushRef still set, one PushLog row", async () => {
  const stores = makeStores(baseSuggestion());
  const adapter = fakeAdapter({
    execute: async () => {
      throw new Error("HTTP 500 from engine: ***REDACTED*** exploded");
    }
  });
  const outcome = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });

  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "engine_error");
  assert.ok(outcome.engineError?.includes("HTTP 500"));
  assert.equal(stores.pushLogs.length, 1);
  assert.equal(stores.pushLogs[0].result, "failed");
  assert.equal(stores.suggestion?.status, "approved");
  assert.equal(stores.suggestion?.pushRef, "log-1", "an attempted execute always sets pushRef");
  assert.equal(outcome.verify?.attempted, false, "verify never ran");
});

test("no key leak: a real adapter + 500 body echoing the key never leaks it into the outcome or PushLog", async () => {
  const stores = makeStores(baseSuggestion());
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? "GET") === "GET" && u.endsWith("/listings")) {
      return new Response(JSON.stringify({ listings: [{ id: 12345, pms: "hostaway" }] }), {
        status: 200
      });
    }
    return new Response(`server error, your key ${FAKE_KEY} is angry`, { status: 500 });
  }) as unknown as typeof fetch;

  const outcome = await executeApprovedPush(ARGS, {
    ...stores,
    adapterFactory: buildDefaultAdapterFactory({
      env: { PRICELABS_KEY_LITTLE_FEATHER: FAKE_KEY },
      overlay: {},
      fetchImpl,
      sleepImpl: async () => undefined
    })
  });

  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "engine_error");
  const outcomeJson = JSON.stringify(outcome);
  assert.ok(!outcomeJson.includes(FAKE_KEY), "outcome leaked the key");
  const logsJson = JSON.stringify(stores.pushLogs);
  assert.ok(!logsJson.includes(FAKE_KEY), "PushLog detail leaked the key");
  assert.ok(logsJson.includes("***REDACTED***"), "the redaction marker should be present");
});

test("a PushLog write failure never masks the push result; a sentinel pushRef still blocks re-push", async () => {
  const stores = makeStores(baseSuggestion());
  const failingPushLogStore: RecsPushLogStore = {
    async record() {
      throw new Error("db down");
    }
  };
  const adapter = fakeAdapter();
  const outcome = await executeApprovedPush(ARGS, {
    suggestionStore: stores.suggestionStore,
    pushLogStore: failingPushLogStore,
    adapterFactory: factoryFor(adapter),
    now: () => new Date("2026-07-18T10:00:00Z")
  });

  assert.equal(outcome.ok, true, "the push DID succeed — audit failure must not mask that");
  assert.equal(outcome.result, "success");
  assert.equal(outcome.pushLogId, null);
  assert.equal(stores.suggestion?.status, "applied");
  assert.ok(
    stores.suggestion?.pushRef?.startsWith("pushlog-write-failed:"),
    "sentinel pushRef must still block a re-push"
  );
});

// ---------------------------------------------------------------------------
// Adversarial push-safety review additions (2026-07-18 overnight audit).
// Tests named "KNOWN RACE"/"KNOWN GAP" document CURRENT behaviour that the
// review flagged — they are evidence, not endorsement. See the review report.
// ---------------------------------------------------------------------------

test("RACE FIXED: two CONCURRENT pushes of one suggestion — the atomic claimForPush lets exactly one reach the engine", async () => {
  const stores = makeStores(baseSuggestion());

  // Deterministic interleave: hold BOTH loads open until both have read the
  // pre-push row (status approved, pushRef null) — exactly what two racing
  // /api/recs approvals produce, since actions.ts flips pending→approved and
  // never re-checks the updateMany count before calling executeApprovedPush.
  let loads = 0;
  let releaseLoads!: () => void;
  const bothLoaded = new Promise<void>((resolve) => {
    releaseLoads = resolve;
  });
  const racingStore: RecsSuggestionStore = {
    async load(args) {
      loads += 1;
      if (loads >= 2) releaseLoads();
      await bothLoaded;
      return stores.suggestionStore.load(args);
    },
    update: (args) => stores.suggestionStore.update(args),
    claimForPush: (args) => stores.suggestionStore.claimForPush(args)
  };

  const adapter = fakeAdapter();
  const deps = {
    suggestionStore: racingStore,
    pushLogStore: stores.pushLogStore,
    adapterFactory: factoryFor(adapter)
  };
  const [a, b] = await Promise.all([
    executeApprovedPush(ARGS, deps),
    executeApprovedPush(ARGS, deps)
  ]);

  // FIXED (2026-07-18): the atomic claimForPush serialises the racers —
  // exactly ONE engine write; the loser skips as already_pushed.
  assert.equal(adapter.executeCalls, 1, "the atomic claim allows exactly one engine write");
  const results = [a.result, b.result].sort();
  assert.deepEqual(results, ["skipped", "success"]);
  const loser = a.result === "skipped" ? a : b;
  assert.equal(loser.reason, "already_pushed");
  assert.equal(
    stores.pushLogs.filter((l) => l.result === "success").length,
    1,
    "the audit trail records exactly one success push"
  );
});

test("sequential double-push is safe: both a VERIFIED push (applied) and an UNVERIFIED one skip re-push via already_pushed (pushRef gate first)", async () => {
  // Path A: verified success → status flipped to applied → status gate fires first.
  const verified = makeStores(baseSuggestion());
  const adapterA = fakeAdapter();
  const depsA = { ...verified, adapterFactory: factoryFor(adapterA) };
  assert.equal((await executeApprovedPush(ARGS, depsA)).result, "success");
  const secondA = await executeApprovedPush(ARGS, depsA);
  assert.equal(secondA.result, "skipped");
  assert.equal(secondA.reason, "already_pushed");
  assert.equal(adapterA.executeCalls, 1, "sequentially the status gate holds");

  // Path B: verify mismatch → status stays approved, pushRef gate fires.
  const mismatched = makeStores(baseSuggestion());
  const adapterB = fakeAdapter({
    verify: async () => ({ attempted: true, verified: false, observedPrice: 99 })
  });
  const depsB = { ...mismatched, adapterFactory: factoryFor(adapterB) };
  assert.equal((await executeApprovedPush(ARGS, depsB)).reason, "verify_mismatch");
  const secondB = await executeApprovedPush(ARGS, depsB);
  assert.equal(secondB.result, "skipped");
  assert.equal(secondB.reason, "already_pushed");
  assert.equal(adapterB.executeCalls, 1, "sequentially the pushRef gate holds");
});

test("KNOWN GAP (documented): an edited approvedPrice on a floorUnknown row has NO floor check anywhere — £1 pushes", async () => {
  const stores = makeStores(
    baseSuggestion({ proposedValue: 120, approvedPrice: 1, detail: { floorUnknown: true } })
  );
  let pushedPrice: number | null = null;
  const adapter = fakeAdapter({
    execute: async (t) => {
      pushedPrice = t.price;
      return { ok: true };
    },
    verify: async () => ({ attempted: true, verified: true, observedPrice: 1 })
  });
  const outcome = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });

  // HONEST ANSWER: the only guard on a floorUnknown row is price > 0. The
  // generator's draft-time clamp never sees a human EDIT, so a fat-fingered
  // £1 goes straight to the engine. actions.ts also skips its floor check
  // when detail.floor is absent.
  assert.equal(outcome.result, "success");
  assert.equal(pushedPrice, 1);
});

test("price exactly AT the floor is allowed (the gate is strictly below)", async () => {
  const stores = makeStores(baseSuggestion({ proposedValue: 90, detail: { floor: 90 } }));
  const adapter = fakeAdapter({
    verify: async () => ({ attempted: true, verified: true, observedPrice: 90 })
  });
  const outcome = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });
  assert.equal(outcome.result, "success");
});

test("verify THROW → failed verify_error, exactly one PushLog row, pushRef still set, status stays approved", async () => {
  const stores = makeStores(baseSuggestion());
  const adapter = fakeAdapter({
    verify: async () => {
      throw new Error("HTTP 500 from engine: verify read exploded");
    }
  });
  const outcome = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });

  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "verify_error");
  assert.equal(outcome.verify?.attempted, true);
  assert.equal(outcome.verify?.verified, false);
  assert.equal(stores.pushLogs.length, 1, "exactly one PushLog row on a verify throw");
  assert.equal(stores.pushLogs[0].result, "failed");
  assert.equal(stores.suggestion?.status, "approved", "an unverified push must not be applied");
  assert.equal(stores.suggestion?.pushRef, "log-1", "pushRef set — no re-fire after a verify throw");
});

test("preview THROW → failed preview_error, one PushLog row, engine never written, suggestion untouched", async () => {
  const stores = makeStores(baseSuggestion());
  const adapter = fakeAdapter({
    preview: async () => {
      throw new Error("HTTP 503 from engine: preview read down");
    }
  });
  const outcome = await executeApprovedPush(ARGS, { ...stores, adapterFactory: factoryFor(adapter) });

  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "preview_error");
  assert.equal(adapter.executeCalls, 0, "a failed preview must never reach execute");
  assert.equal(stores.pushLogs.length, 1);
  assert.equal(stores.updates.length, 0, "no pushRef/status mutation when nothing was written");
});

test("wheelhouse end to end: a 500 body echoing BOTH keys never leaks into the outcome or PushLog", async () => {
  const WH_READ = "wh_read_secret_value_1234567890"; // not real
  const WH_WRITE = "wh_write_secret_value_0987654321"; // not real
  const stores = makeStores(baseSuggestion());
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(JSON.stringify([]), { status: 200 }); // preview: no owner rows
    return new Response(`gateway sad, saw ${WH_READ} and ${WH_WRITE}`, { status: 500 });
  }) as unknown as typeof fetch;

  const outcome = await executeApprovedPush(
    { ...ARGS, engine: "wheelhouse" },
    {
      ...stores,
      adapterFactory: buildDefaultAdapterFactory({
        env: {
          WHEELHOUSE_KEY_LITTLE_FEATHER: WH_READ,
          WHEELHOUSE_WRITE_KEY_LITTLE_FEATHER: WH_WRITE
        },
        overlay: {},
        fetchImpl,
        sleepImpl: async () => undefined
      })
    }
  );

  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "engine_error");
  const everything = JSON.stringify({ outcome, logs: stores.pushLogs, suggestion: stores.suggestion });
  assert.ok(!everything.includes(WH_READ), "read key leaked");
  assert.ok(!everything.includes(WH_WRITE), "write key leaked");
  assert.ok(JSON.stringify(stores.pushLogs).includes("***REDACTED***"));
});

test("pms resolution including 'guesty' flows through a real PriceLabs adapter end to end", async () => {
  const stores = makeStores(baseSuggestion({ engineListingId: "555" }));
  const overridesByListing = new Map<string, Array<{ date: string; price: string }>>();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && u.endsWith("/listings")) {
      return new Response(JSON.stringify({ listings: [{ id: 555, pms: "guesty" }] }), {
        status: 200
      });
    }
    if (method === "POST" && u.includes("/listings/555/overrides")) {
      const body = JSON.parse(String(init?.body)) as {
        overrides: Array<{ date: string; price: number }>;
        pms: string;
      };
      assert.equal(body.pms, "guesty", "Cityscape-style listing must push with pms=guesty");
      overridesByListing.set(
        "555",
        body.overrides.map((o) => ({ date: o.date, price: String(o.price) }))
      );
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (method === "GET" && u.includes("/listings/555/overrides?")) {
      assert.ok(u.includes("pms=guesty"));
      return new Response(JSON.stringify({ overrides: overridesByListing.get("555") ?? [] }), {
        status: 200
      });
    }
    throw new Error(`unexpected call ${method} ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await executeApprovedPush(ARGS, {
    ...stores,
    adapterFactory: buildDefaultAdapterFactory({
      env: { PRICELABS_KEY_LITTLE_FEATHER: FAKE_KEY },
      overlay: {},
      fetchImpl,
      sleepImpl: async () => undefined
    })
  });

  assert.equal(outcome.result, "success");
  assert.equal(outcome.verify?.observedPrice, 120);
  assert.equal(stores.suggestion?.status, "applied");
});

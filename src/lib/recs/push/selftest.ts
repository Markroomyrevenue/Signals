/**
 * Guarded live self-test for the recs push path. The LEAD runs this manually
 * via `scripts/recs-push-selftest.ts` — nothing in the product calls it.
 *
 * What it does, end to end, against ONE listing on ONE far-future date:
 *   read current price → push that SAME value (a no-op for guests) → verify →
 *   revert/delete → verify-gone — printing a full evidence trail and writing
 *   PushLog rows whose detail.kind is "selftest".
 *
 * Refusals (throws before any write):
 *   - `confirmLive` not set (the CLI's --confirm-live flag);
 *   - target date under 180 days out (default is ~260);
 *   - engine keys missing (message masks the key state, never the value);
 *   - the engine has no current price for the date (a no-op push needs one);
 *   - preview blocked (e.g. a Wheelhouse owner custom-rate range on the date).
 *
 * If the pushed value lands but then anything fails, the revert STILL runs —
 * the self-test never leaves its override on the engine on purpose.
 */

import { addUtcDays, toDateOnly } from "@/lib/metrics/helpers";
import { lookupKeyForTenantName } from "@/lib/observe/registry";
import { maskSecret } from "@/lib/observe/secrets";

import { createPriceLabsPushAdapter } from "./pricelabs";
import { createWheelhousePushAdapter } from "./wheelhouse";
import { DEFAULT_PUSH_LOG_STORE, type RecsPushLogStore } from "./push-service";
import type {
  RecsEnginePushAdapter,
  RecsPushEngine,
  RecsPushTarget,
  RecsSelfTestReads,
  RecsVerifyResult
} from "./types";

export const SELFTEST_MIN_DAYS_OUT = 180;
export const SELFTEST_DEFAULT_DAYS_OUT = 260;

export type SelfTestArgs = {
  engine: RecsPushEngine;
  tenantId: string;
  tenantName: string;
  engineListingId: string;
  /** Must be true — the CLI's --confirm-live flag. */
  confirmLive: boolean;
  /** Days from today for the test date. Default 260; refused below 180. */
  daysOut?: number;
  currency?: string;
};

export type SelfTestDeps = {
  pushLogStore?: RecsPushLogStore;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
  /** Env override for key lookups (tests only). */
  env?: Record<string, string | undefined>;
};

export type SelfTestEvidence = {
  engine: RecsPushEngine;
  tenantName: string;
  engineListingId: string;
  date: string;
  currentPrice: number;
  pushVerify: RecsVerifyResult;
  revertVerify: RecsVerifyResult;
  pushLogIds: { push: string | null; revert: string | null };
  ok: boolean;
};

export async function runRecsPushSelfTest(
  args: SelfTestArgs,
  deps: SelfTestDeps = {}
): Promise<SelfTestEvidence> {
  const pushLogStore = deps.pushLogStore ?? DEFAULT_PUSH_LOG_STORE;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));

  if (args.confirmLive !== true) {
    throw new Error(
      "recs-push-selftest: refusing to run without --confirm-live. This test performs LIVE writes (push + delete) against the engine."
    );
  }
  const daysOut = args.daysOut ?? SELFTEST_DEFAULT_DAYS_OUT;
  if (!Number.isFinite(daysOut) || daysOut < SELFTEST_MIN_DAYS_OUT) {
    throw new Error(
      `recs-push-selftest: refusing a test date under ${SELFTEST_MIN_DAYS_OUT} days out (asked for ${daysOut}). Far-future only.`
    );
  }
  const date = toDateOnly(addUtcDays(now(), Math.round(daysOut)));

  const adapter = resolveAdapter(args, deps);
  log(`[selftest] engine=${args.engine} tenant="${args.tenantName}" listing=${args.engineListingId} date=${date} (${daysOut} days out)`);

  const currentPrice = await adapter.readCurrentPrice(args.engineListingId, date);
  if (currentPrice === null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error(
      `recs-push-selftest: could not read a current price for ${date} (got ${currentPrice}) — refusing, a no-op push needs the live value.`
    );
  }
  log(`[selftest] current engine price for ${date}: ${currentPrice} — pushing the SAME value (no-op)`);

  const suggestionId = `selftest-${now().getTime()}`;
  const target: RecsPushTarget = {
    tenantId: args.tenantId,
    tenantName: args.tenantName,
    clientKey: "selftest",
    suggestionId,
    listingId: "selftest",
    engineListingId: args.engineListingId,
    date,
    price: currentPrice,
    currency: args.currency ?? "GBP",
    floor: null,
    floorUnknown: false,
    oldValue: currentPrice
  };

  const preview = await adapter.preview(target);
  if (!preview.ok) {
    throw new Error(
      `recs-push-selftest: preview blocked (${preview.blockedReason ?? "unknown"}) — nothing was written. Pick another listing/date.`
    );
  }
  log("[selftest] preview: ok (no owner conflicts / listing present in account)");

  const pushLogIds: SelfTestEvidence["pushLogIds"] = { push: null, revert: null };
  let pushVerify: RecsVerifyResult = { attempted: false, verified: false };
  let revertVerify: RecsVerifyResult = { attempted: false, verified: false };
  let pushError: string | null = null;
  let revertError: string | null = null;
  let executed = false;

  try {
    await adapter.execute(target);
    executed = true;
    log(`[selftest] execute: accepted (pushed ${currentPrice} for ${date})`);
    pushVerify = await adapter.verify(target);
    log(
      `[selftest] verify: verified=${pushVerify.verified} observedPrice=${pushVerify.observedPrice ?? "null"}`
    );
  } catch (error) {
    pushError = error instanceof Error ? error.message : String(error);
    log(`[selftest] push phase FAILED: ${pushError}`);
  } finally {
    pushLogIds.push = await recordSelfTestLog(pushLogStore, args, target, {
      phase: "push",
      result: pushVerify.verified ? "success" : "failed",
      newValue: currentPrice,
      verify: pushVerify,
      engineError: pushError
    });
  }

  // Cleanup ALWAYS runs once execute was attempted — the self-test must not
  // leave its override on the engine even when verify failed.
  if (executed) {
    try {
      await adapter.revert(target);
      log(`[selftest] revert: accepted (deleted the ${date} override/custom rate)`);
      revertVerify = await adapter.verifyReverted(target);
      log(
        `[selftest] verify-gone: verified=${revertVerify.verified} observedPrice=${revertVerify.observedPrice ?? "null"}`
      );
    } catch (error) {
      revertError = error instanceof Error ? error.message : String(error);
      log(`[selftest] revert phase FAILED: ${revertError} — MANUAL CLEANUP MAY BE NEEDED for ${date}`);
    } finally {
      pushLogIds.revert = await recordSelfTestLog(pushLogStore, args, target, {
        phase: "revert",
        result: revertVerify.verified ? "success" : "failed",
        newValue: null,
        verify: revertVerify,
        engineError: revertError
      });
    }
  }

  const ok = pushVerify.verified && revertVerify.verified;
  log(
    ok
      ? "[selftest] PASS — pushed, verified, reverted, verified-gone. Engine state is exactly as before."
      : "[selftest] FAIL — see the trail above. Check the engine calendar for the test date before re-running."
  );

  return {
    engine: args.engine,
    tenantName: args.tenantName,
    engineListingId: args.engineListingId,
    date,
    currentPrice,
    pushVerify,
    revertVerify,
    pushLogIds,
    ok
  };
}

function resolveAdapter(
  args: SelfTestArgs,
  deps: SelfTestDeps
): RecsEnginePushAdapter & RecsSelfTestReads {
  // An injected env (tests) gets a hermetic lookup — no keys-file overlay;
  // production (env undefined) uses process.env + OBSERVE_KEYS_FILE as usual.
  const lookupOptions = {
    env: deps.env,
    overlay: deps.env !== undefined ? {} : undefined,
    fetchImpl: deps.fetchImpl
  };
  if (args.engine === "pricelabs") {
    const key = lookupKeyForTenantName("PRICELABS_KEY", args.tenantName, lookupOptions);
    if (key.value === null) {
      throw new Error(
        `recs-push-selftest: PriceLabs key missing: ${key.envVar}=${maskSecret(key.value)}`
      );
    }
    return createPriceLabsPushAdapter({
      apiKey: key.value,
      fetchImpl: deps.fetchImpl,
      sleepImpl: deps.sleepImpl
    });
  }
  const readKey = lookupKeyForTenantName("WHEELHOUSE_KEY", args.tenantName, lookupOptions);
  const writeKey = lookupKeyForTenantName("WHEELHOUSE_WRITE_KEY", args.tenantName, lookupOptions);
  if (readKey.value === null || writeKey.value === null) {
    throw new Error(
      `recs-push-selftest: Wheelhouse keys incomplete: ${readKey.envVar}=${maskSecret(readKey.value)}, ` +
        `${writeKey.envVar}=${maskSecret(writeKey.value)} (writes need BOTH)`
    );
  }
  return createWheelhousePushAdapter({
    readKey: readKey.value,
    writeKey: writeKey.value,
    fetchImpl: deps.fetchImpl,
    sleepImpl: deps.sleepImpl
  });
}

async function recordSelfTestLog(
  store: RecsPushLogStore,
  args: SelfTestArgs,
  target: RecsPushTarget,
  entry: {
    phase: "push" | "revert";
    result: "success" | "failed";
    newValue: number | null;
    verify: RecsVerifyResult;
    engineError: string | null;
  }
): Promise<string | null> {
  try {
    const row = await store.record({
      tenantId: args.tenantId,
      clientKey: null,
      listingId: null,
      engineListingId: args.engineListingId,
      engine: args.engine,
      date: target.date,
      lever: "price",
      oldValue: target.oldValue,
      newValue: entry.newValue,
      reason: `recs-push-selftest ${entry.phase}`,
      result: entry.result,
      detail: {
        kind: "selftest",
        phase: entry.phase,
        suggestionId: target.suggestionId,
        verify: entry.verify,
        ...(entry.engineError !== null ? { engineError: entry.engineError } : {})
      }
    });
    return row.id;
  } catch (logError) {
    console.error(
      "[selftest] PushLog write failed (evidence above still stands)",
      JSON.stringify({
        phase: entry.phase,
        message: logError instanceof Error ? logError.message : String(logError)
      })
    );
    return null;
  }
}

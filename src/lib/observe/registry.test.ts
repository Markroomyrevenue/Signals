import assert from "node:assert/strict";
import test from "node:test";

import {
  describeSource,
  envSlug,
  observeSlug,
  parseKeysFile,
  resolveObserveSource,
  type EnvLike
} from "./registry";

const FAKE_PL = "pl_live_aaaaaaaaaaaaaaaa"; // not real
const FAKE_WH = "wh_int_bbbbbbbbbbbbbbbb"; // not real

test("observeSlug + envSlug derive stable identifiers from the tenant name", () => {
  assert.equal(observeSlug("Stay Belfast"), "stay-belfast");
  assert.equal(observeSlug("Little Feather Management"), "little-feather-management");
  assert.equal(envSlug("Stay Belfast"), "STAY_BELFAST");
  assert.equal(envSlug("Corrie Doon"), "CORRIE_DOON");
});

test("resolves to pricelabs when a PriceLabs key is present", () => {
  const env: EnvLike = { PRICELABS_KEY_STAY_BELFAST: FAKE_PL };
  const r = resolveObserveSource({ id: "t1", name: "Stay Belfast" }, { env, overlay: {} });
  assert.equal(r.kind, "pricelabs");
  assert.equal(r.keyPresent, true);
  assert.equal(r.keyEnvVar, "PRICELABS_KEY_STAY_BELFAST");
  assert.ok(r.adapter && r.adapter.engine === "pricelabs");
});

test("resolves to wheelhouse when only a Wheelhouse key is present", () => {
  const env: EnvLike = { WHEELHOUSE_KEY_CORRIE_DOON: FAKE_WH };
  const r = resolveObserveSource({ id: "t2", name: "Corrie Doon" }, { env, overlay: {} });
  assert.equal(r.kind, "wheelhouse");
  assert.equal(r.keyPresent, true);
  assert.ok(r.adapter && r.adapter.engine === "wheelhouse");
});

test("explicit OBSERVE_ENGINE pin routes Corrie Doon to hostaway-scan even with a WH key", () => {
  const env: EnvLike = {
    WHEELHOUSE_KEY_CORRIE_DOON: FAKE_WH,
    OBSERVE_ENGINE_CORRIE_DOON: "hostaway-scan"
  };
  const r = resolveObserveSource({ id: "t2", name: "Corrie Doon" }, { env, overlay: {} });
  assert.equal(r.kind, "hostaway-scan");
  assert.equal(r.adapter, null);
  assert.equal(r.keyPresent, false);
  assert.equal(r.keyEnvVar, null);
  assert.equal(r.pinned, true);
});

test("falls back to hostaway-scan when no key and no pin is present", () => {
  const r = resolveObserveSource({ id: "t3", name: "New Client" }, { env: {}, overlay: {} });
  assert.equal(r.kind, "hostaway-scan");
  assert.equal(r.adapter, null);
  assert.equal(r.keyPresent, false);
});

test("segment-prefix matching: a short key var resolves a longer tenant name", () => {
  // Real dev-DB name is "Stay Belfast Apartments"; the short STAY_BELFAST wins.
  const env: EnvLike = { PRICELABS_KEY_STAY_BELFAST: FAKE_PL };
  const r = resolveObserveSource({ id: "t5", name: "Stay Belfast Apartments" }, { env, overlay: {} });
  assert.equal(r.kind, "pricelabs");
  assert.equal(r.keyPresent, true);
  assert.equal(r.keyEnvVar, "PRICELABS_KEY_STAY_BELFAST");
});

test("segment-prefix matching: OBSERVE_ENGINE pin resolves the longer Coorie Doon name", () => {
  const env: EnvLike = { OBSERVE_ENGINE_COORIE_DOON: "hostaway-scan" };
  const r = resolveObserveSource({ id: "t6", name: "Coorie Doon Stays" }, { env, overlay: {} });
  assert.equal(r.kind, "hostaway-scan");
  assert.equal(r.pinned, true);
});

test("a fully-qualified key var still resolves and wins", () => {
  const env: EnvLike = { PRICELABS_KEY_LITTLE_FEATHER_MANAGEMENT: FAKE_PL };
  const r = resolveObserveSource({ id: "t7", name: "Little Feather Management" }, { env, overlay: {} });
  assert.equal(r.kind, "pricelabs");
  assert.equal(r.keyEnvVar, "PRICELABS_KEY_LITTLE_FEATHER_MANAGEMENT");
});

test("keys-file overlay supplies a key when the env var is unset", () => {
  const overlay = parseKeysFile(
    `# RMS keys\nPRICELABS_KEY_ESCAPE_ORDINARY="${FAKE_PL}"\n` + `WHEELHOUSE_KEY_CORRIE_DOON=${FAKE_WH}\n`
  );
  const r = resolveObserveSource({ id: "t4", name: "Escape Ordinary" }, { env: {}, overlay });
  assert.equal(r.kind, "pricelabs");
  assert.equal(r.keyPresent, true);
});

test("describeSource never includes the raw key value", () => {
  const env: EnvLike = { PRICELABS_KEY_STAY_BELFAST: FAKE_PL };
  const r = resolveObserveSource({ id: "t1", name: "Stay Belfast" }, { env, overlay: {} });
  const line = describeSource(r, env);
  assert.ok(!line.includes(FAKE_PL), "describeSource leaked the key");
  assert.ok(line.includes("PRICELABS_KEY_STAY_BELFAST"));
});

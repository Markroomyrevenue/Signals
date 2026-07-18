/**
 * Client → engine → key registry (SIGNALS-OBSERVE-LEARN-SPEC.md §2.3 / §11).
 *
 * Resolution is fully env-backed; no client identity or key is ever hard-coded.
 * For a tenant slug `<S>` (UPPER_SNAKE of the tenant name):
 *   - `PRICELABS_KEY_<S>`   — PriceLabs read key
 *   - `WHEELHOUSE_KEY_<S>`  — Wheelhouse read key
 *   - `OBSERVE_ENGINE_<S>`  — explicit engine pin (pricelabs|wheelhouse|hostaway-scan)
 * Keys may instead live in a plain-text file at `OBSERVE_KEYS_FILE` (one
 * `KEY=value` per line) so the supplied RMS keys file can be pointed at directly.
 *
 * Engine choice, when not pinned: PriceLabs key present → pricelabs; else
 * Wheelhouse key present → wheelhouse; else → hostaway-scan (every tenant has a
 * Hostaway connection, so the scan fallback is always available). Corrie Doon's
 * Wheelhouse key 401s, so it is pinned to hostaway-scan via
 * `OBSERVE_ENGINE_CORRIE_DOON=hostaway-scan` (spec §2 decision box).
 *
 * The key VALUE is never logged or returned — only its env-var NAME and a masked
 * present/length indicator leave this module.
 */

import { readFileSync } from "node:fs";

import { prisma } from "@/lib/prisma";

import { createPriceLabsAdapter } from "./engine/pricelabs";
import { createWheelhouseAdapter } from "./engine/wheelhouse";
import type { PricingEngineAdapter } from "./engine/adapter";
import type { EngineKind } from "./engine/types";
import { maskSecret } from "./secrets";

export type EnvLike = Record<string, string | undefined>;

/** Lowercase, spaces→`-`, strip non-alphanumerics. Matches the trial slug rule. */
export function observeSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/** UPPER_SNAKE form used to build env-var names: "Stay Belfast" → "STAY_BELFAST". */
export function envSlug(name: string): string {
  return observeSlug(name).replace(/-/g, "_").toUpperCase();
}

export type ResolvedObserveSource = {
  tenantId: string;
  tenantName: string;
  slug: string;
  kind: EngineKind;
  /** Engine adapter for pricelabs/wheelhouse; null for hostaway-scan. */
  adapter: PricingEngineAdapter | null;
  /** Whether the resolved engine's key is present (false → dormant / fallback). */
  keyPresent: boolean;
  /** The env-var name that holds (or should hold) the key — never the value. */
  keyEnvVar: string | null;
  /** True when the engine was explicitly pinned via OBSERVE_ENGINE_<S>. */
  pinned: boolean;
};

let keysFileOverlayCache: EnvLike | null = null;

/** Parse a plain-text `KEY=value` keys file into an overlay map. Pure-ish (fs read). */
export function parseKeysFile(contents: string): EnvLike {
  const overlay: EnvLike = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) overlay[key] = value;
  }
  return overlay;
}

function loadKeysFileOverlay(env: EnvLike): EnvLike {
  if (keysFileOverlayCache) return keysFileOverlayCache;
  const path = env.OBSERVE_KEYS_FILE;
  if (!path) {
    keysFileOverlayCache = {};
    return keysFileOverlayCache;
  }
  try {
    keysFileOverlayCache = parseKeysFile(readFileSync(path, "utf8"));
  } catch {
    // A missing/unreadable keys file is non-fatal — fall back to env vars only.
    keysFileOverlayCache = {};
  }
  return keysFileOverlayCache;
}

/** Read a value from env first, then the keys-file overlay. Never logs it. */
function readKey(name: string, env: EnvLike, overlay: EnvLike): string | null {
  const raw = env[name] ?? overlay[name];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * UPPER_SNAKE suffix candidates from longest to shortest segment-prefix, so a
 * short env var resolves a longer tenant name: "Stay Belfast Apartments" →
 * ["STAY_BELFAST_APARTMENTS", "STAY_BELFAST", "STAY"]. Mirrors the established
 * `isTrialTenant` prefix rule. Longest match wins, so a fully-qualified env var
 * always beats a shared first segment.
 */
function slugSuffixCandidates(slug: string): string[] {
  const segs = slug.split("-").filter((s) => s.length > 0);
  const out: string[] = [];
  for (let n = segs.length; n >= 1; n -= 1) {
    out.push(segs.slice(0, n).join("_").toUpperCase());
  }
  return out.length > 0 ? out : [slug.toUpperCase()];
}

/** Look up `<PREFIX>_<suffix>` across the slug's prefix candidates. */
function lookupForSlug(
  prefix: string,
  slug: string,
  env: EnvLike,
  overlay: EnvLike
): { value: string | null; envVar: string } {
  const candidates = slugSuffixCandidates(slug);
  for (const suffix of candidates) {
    const name = `${prefix}_${suffix}`;
    const value = readKey(name, env, overlay);
    if (value !== null) return { value, envVar: name };
  }
  // No value set — report the fully-qualified name for diagnostics.
  return { value: null, envVar: `${prefix}_${candidates[0]}` };
}

/** Look up an OBSERVE_ENGINE_<suffix> pin across the slug's prefix candidates. */
function lookupEnginePin(slug: string, env: EnvLike): EngineKind | null {
  for (const suffix of slugSuffixCandidates(slug)) {
    const kind = normaliseEngineKind(env[`OBSERVE_ENGINE_${suffix}`]);
    if (kind) return kind;
  }
  return null;
}

function normaliseEngineKind(value: string | undefined): EngineKind | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "pricelabs" || v === "wheelhouse" || v === "hostaway-scan") return v;
  if (v === "hostaway" || v === "hostaway_scan" || v === "scan") return "hostaway-scan";
  return null;
}

export type ResolveOptions = {
  env?: EnvLike;
  overlay?: EnvLike;
  /** Injected for tests so adapters can be stubbed without network. */
  fetchImpl?: typeof fetch;
};

/**
 * Resolve an arbitrary `<PREFIX>_<slug>` env key with the same longest-prefix
 * rule the engine keys use. Used by the recs push module to find
 * WHEELHOUSE_WRITE_KEY_* alongside the read key. Never logs the value.
 */
export function lookupKeyForTenantName(
  prefix: string,
  tenantName: string,
  options: ResolveOptions = {}
): { value: string | null; envVar: string } {
  const env = options.env ?? (process.env as EnvLike);
  const overlay = options.overlay ?? loadKeysFileOverlay(env);
  return lookupForSlug(prefix, observeSlug(tenantName), env, overlay);
}

/**
 * Resolve one tenant to its observation source. Pure w.r.t. the DB — reads env +
 * keys-file overlay only, so it is unit-testable by injecting `env`/`overlay`.
 * Creating an adapter does not touch the network (it fetches lazily on first use).
 */
export function resolveObserveSource(
  tenant: { id: string; name: string },
  options: ResolveOptions = {}
): ResolvedObserveSource {
  const env = options.env ?? (process.env as EnvLike);
  const overlay = options.overlay ?? loadKeysFileOverlay(env);
  const fetchImpl = options.fetchImpl;

  const slug = observeSlug(tenant.name);
  const priceLabs = lookupForSlug("PRICELABS_KEY", slug, env, overlay);
  const wheelhouse = lookupForSlug("WHEELHOUSE_KEY", slug, env, overlay);
  const priceLabsKey = priceLabs.value;
  const wheelhouseKey = wheelhouse.value;
  const priceLabsEnvVar = priceLabs.envVar;
  const wheelhouseEnvVar = wheelhouse.envVar;

  const pinnedKind = lookupEnginePin(slug, env);
  const kind: EngineKind =
    pinnedKind ?? (priceLabsKey ? "pricelabs" : wheelhouseKey ? "wheelhouse" : "hostaway-scan");

  const base = { tenantId: tenant.id, tenantName: tenant.name, slug, pinned: pinnedKind !== null };

  if (kind === "pricelabs") {
    return {
      ...base,
      kind,
      adapter: priceLabsKey ? createPriceLabsAdapter({ apiKey: priceLabsKey, fetchImpl }) : null,
      keyPresent: priceLabsKey !== null,
      keyEnvVar: priceLabsEnvVar
    };
  }
  if (kind === "wheelhouse") {
    return {
      ...base,
      kind,
      adapter: wheelhouseKey ? createWheelhouseAdapter({ apiKey: wheelhouseKey, fetchImpl }) : null,
      keyPresent: wheelhouseKey !== null,
      keyEnvVar: wheelhouseEnvVar
    };
  }
  // hostaway-scan fallback — no engine key, reads live Hostaway rates downstream.
  return { ...base, kind, adapter: null, keyPresent: false, keyEnvVar: null };
}

/** A one-line, key-safe description of a resolved source for logs/diagnostics. */
export function describeSource(source: ResolvedObserveSource, env: EnvLike = process.env): string {
  const keyState = source.keyEnvVar
    ? `${source.keyEnvVar}=${maskSecret(readKey(source.keyEnvVar, env, loadKeysFileOverlay(env)))}`
    : "(no engine key — hostaway-scan)";
  return `tenant="${source.tenantName}" slug=${source.slug} engine=${source.kind}${
    source.pinned ? " (pinned)" : ""
  } keyPresent=${source.keyPresent} ${keyState}`;
}

/** Resolve every tenant in the DB to its observation source. */
export async function listObserveSources(options: ResolveOptions = {}): Promise<ResolvedObserveSource[]> {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  return tenants.map((tenant) => resolveObserveSource(tenant, options));
}

/** Test seam: reset the cached keys-file overlay between unit tests. */
export function __resetKeysFileOverlayCacheForTests(): void {
  keysFileOverlayCache = null;
}

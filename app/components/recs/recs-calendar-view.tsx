"use client";

/**
 * Pricing Recommendations — master calendar view (grid + agenda).
 *
 * Faithful React port of the approved prototype (recs-calendar-proto.html,
 * 2026-07-20) wired to the real API:
 *   - GET  /api/recs/calendar        payload (fetched on mount + after pushes)
 *   - POST /api/recs/user-set        operator-set price on an open night
 *   - POST /api/recs/action          approve (→ push) / reject per night
 *   - POST /api/recs/run-action      run-level approve with an edited TOTAL
 *   - POST /api/recs/client-settings allow-below-minimum toggle
 *
 * Staging stays client-side (the basket); nothing touches an engine until
 * Review & Push confirms — then each staged night is executed SEQUENTIALLY
 * (engine rate limits) with per-row outcome marks, a "Stop after current
 * night" control, and a refetch/reconcile once the run completes. The one
 * intentional departure from the prototype: committing an edited run TOTAL
 * calls /api/recs/run-action immediately (the server distributes the total
 * and refuses a fat-fingered figure atomically — its 400 is surfaced
 * verbatim) instead of staging distributed per-night edits.
 */

import Link from "next/link";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { withBasePath } from "@/lib/base-path";

import { currencySymbol, formatDateShort } from "./format";

import "./recs-calendar.css";

// ---------------------------------------------------------------------------
// Payload types (the /api/recs/calendar contract)
// ---------------------------------------------------------------------------

type CalOversight = { verdict: string; reason: string | null; narrative: string | null };

type CalNight = {
  id: string;
  date: string;
  dow: string;
  cur: number;
  rec: number | null;
  pct: number | null;
  kind: string;
  sup: string | null;
  why: string;
  whyFull: string;
  comp: string[];
  floor: number | null;
  floorUnknown: boolean;
  status: string;
  actionedAt?: string | null;
  push?: { pushed: boolean; verified: boolean | null; reverted: boolean; error: string | null } | null;
  ov: CalOversight | null;
  /** `cur` is the hourly live rate ("live") or the 05:30 fallback ("generated").
   * Optional: synthetic user-set tiles are built client-side without it. */
  curSrc?: "live" | "generated";
  /** The 05:30 price when the live rate has since moved off it. */
  curWas?: number | null;
  /** The live price moved past the rec — number is current, advice is not. */
  superseded?: boolean;
};

type CalRun = {
  ids: string[];
  from: string;
  to: string;
  n: number;
  runKind: string;
  seg: string;
  totCur: number;
  totRec: number;
  uniformPct: number | null;
  why: string[];
};

type CalHistory = {
  recommended: number | null;
  decided: number | null;
  outcome: "pushed" | "ignored" | "skipped";
  edited: boolean;
  at: string | null;
};

type CalListing = {
  id: string;
  name: string;
  tags: string[];
  min: number | null;
  base: number | null;
  snoozedUntil: string | null;
  nights: CalNight[];
  runs: CalRun[];
  booked: Record<string, number>;
  bookedAt?: Record<string, string>;
  history?: Record<string, CalHistory>;
  minStay: Record<string, number>;
  live: Record<string, number>;
};

type CalClient = {
  id: string;
  name: string;
  currency: string;
  engine: string;
  allowBelowFloor: boolean;
  listings: CalListing[];
};

type CalPayload = { today: string; settableDays: number; clients: CalClient[] };

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

type ActionResultShape = {
  ok: boolean;
  status: string;
  error?: string | null;
  push?: { result: string; verified: boolean | null; reason?: string | null } | null;
};

type RunActionResponse = {
  ok: boolean;
  okCount: number;
  total: number;
  distributionNotes?: string[];
  results?: Array<{ suggestionId: string } & ActionResultShape>;
};

type UserSetResponse = { ok: boolean; suggestionId: string; reused: boolean };

// ---------------------------------------------------------------------------
// Derived structures
// ---------------------------------------------------------------------------

type DRun = CalRun & { key: string; lid: string };

type DListing = Omit<CalListing, "runs"> & {
  runs: DRun[];
  byDate: Map<string, CalNight>;
  clientId: string;
  clientName: string;
  currency: string;
  engine: string;
};

type NightRef = { n: CalNight; l: DListing; cl: CalClient };

type CalIndex = {
  nights: Map<string, NightRef>;
  runOfNight: Map<string, DRun>;
  runByKey: Map<string, { r: DRun; l: DListing; cl: CalClient }>;
  listings: Map<string, { l: DListing; cl: CalClient }>;
  listingsByClient: Map<string, DListing[]>;
  seededFin: Map<string, string>;
};

type UserNightSeed = { lid: string; date: string; cur: number };

type PopAnchor = { left: number; top: number; bottom: number };

type PopState =
  | { kind: "night"; id: string; anchor: PopAnchor }
  | { kind: "run"; runKey: string; anchor: PopAnchor }
  | { kind: "user"; lid: string; date: string; anchor: PopAnchor }
  | { kind: "bulk"; lid: string; from: string; to: string; anchor: PopAnchor };

/** Bulk apply mode for a drag-selected span: an exact price, or a % drop off
 * each night's own current price. */
type BulkMode = { kind: "price"; value: number } | { kind: "pct"; pct: number };

type RowMark = { label: string; cls: "ok" | "warn" | "run" | "fail" };

type ModalEntry = {
  id: string;
  act: string;
  isUser: boolean;
  sendEdited: boolean;
  edited: boolean;
  price: number;
  cur: number;
  date: string;
  dow: string;
  kind: string;
  listingId: string;
  listingName: string;
  clientId: string;
  clientName: string;
  engine: string;
  currency: string;
};

type CalApi = {
  today: string;
  days: string[];
  stKey: (id: string) => string;
  finKey: (id: string) => string;
  priceOf: (id: string, fb: number) => number;
  finPriceOf: (id: string) => number | undefined;
  isPending: (n: CalNight) => boolean;
  runOfNight: Map<string, DRun>;
  runAllStaged: (r: DRun) => boolean;
  runShownTotal: (r: DRun) => number;
  stageNight: (id: string, act: string) => void;
  editFromActs: (id: string, rect: DOMRect) => void;
  stageRun: (r: DRun, on: boolean) => void;
  openNightPop: (id: string, rect: DOMRect) => void;
  openUserPop: (lid: string, date: string, rect: DOMRect) => void;
  openRunPop: (r: DRun, rect: DOMRect) => void;
  userNightFor: (lid: string, date: string) => { id: string; n: CalNight } | null;
  listingPending: (l: DListing) => number;
  /** True when `date` is inside the operator-settable window (today..today+
   * settableDays-1). Beyond it the calendar cannot track a pushed price, so
   * open cells there are read-only context, never click-to-set. */
  settable: (date: string) => boolean;
  /** True when the engine already holds an override for this listing+date. */
  hasOverride: (listingId: string, date: string) => boolean;
  // ---- drag-select (bulk price / % drop across a listing's day cells) ----
  /** Mouse-down on a cell: arm a potential drag from this listing+date. */
  beginDrag: (listingId: string, date: string, rect: DOMRect) => void;
  /** Mouse-enter a cell while dragging: extend the selection to here. */
  extendDrag: (listingId: string, date: string, rect: DOMRect) => void;
  /** True when this cell is inside the active drag selection (for highlight). */
  cellSelected: (listingId: string, date: string) => boolean;
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Gap between nights in a push run — paces the engine so a long run does not
 * burst into a rate limit (each night is several PriceLabs/Wheelhouse calls). */
const PUSH_PACE_MS = 1200;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function addDays(dateOnly: string, n: number): string {
  const t = new Date(`${dateOnly}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function dowOf(dateOnly: string): string {
  return DOW_NAMES[new Date(`${dateOnly}T00:00:00Z`).getUTCDay()] ?? "";
}

function monthOf(dateOnly: string): string {
  return MONTH_NAMES[new Date(`${dateOnly}T00:00:00Z`).getUTCMonth()] ?? "";
}

const fmtD = formatDateShort;

/** "pushed 20 Jul" when the push date is known, else a plain "pushed ✓". */
function pushedLabel(actionedAt?: string | null): string {
  if (!actionedAt || actionedAt.length < 10) return "pushed ✓";
  const dateOnly = actionedAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? `pushed ${fmtD(dateOnly)}` : "pushed ✓";
}

function whenOf(iso: string | null): string {
  return iso && iso.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(iso) ? fmtD(iso.slice(0, 10)) : "recently";
}

/** Blue-dot hover: "Recommended £180 on 20 Jul — Pushed £175 (edited)". */
function historyTip(h: CalHistory, cur: string): string {
  const rec = h.recommended !== null ? money(h.recommended, cur) : "a change";
  const outcome =
    h.outcome === "ignored"
      ? "Ignored"
      : h.outcome === "skipped"
        ? "Skipped"
        : h.edited && h.decided !== null
          ? `Pushed ${money(h.decided, cur)} (edited)`
          : "Pushed";
  return `Recommended ${rec} on ${whenOf(h.at)} — ${outcome}`;
}

/** Green-dot hover on a booking that landed after a pushed rec. */
function bookedAfterTip(paid: number, h: CalHistory, bookedAt: string | null, cur: string): string {
  const price = h.decided !== null ? money(h.decided, cur) : h.recommended !== null ? money(h.recommended, cur) : "a price";
  return `Pushed ${price} on ${whenOf(h.at)} → booked ${whenOf(bookedAt)}, earned ${money(paid, cur)}`;
}

function money(value: number, currency: string): string {
  return `${currencySymbol(currency)}${Math.round(value)}`;
}

function engineLabel(engine: string): string {
  if (engine === "wheelhouse") return "Wheelhouse";
  if (engine === "pricelabs") return "PriceLabs";
  return engine;
}

function shortClientName(name: string): string {
  return name.replace(/ Management| Apartments| Stays|& Short Stay Harrogate/g, "").trim();
}

function shortListingName(name: string): string {
  return name.replace(/^Apt (\d+) Fitzrovia Belfast - /, "Apt $1 · ");
}

function userNightId(lid: string, date: string): string {
  return `usr:${lid}:${date}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(withBasePath(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const parsed = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(parsed.error ?? "Request failed");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Presentational bits
// ---------------------------------------------------------------------------

function FinTag({ fin }: { fin: string }) {
  if (fin === "pushed") return <div className="rcal-fin-tag rcal-ok">pushed ✓</div>;
  if (fin === "ignored") return <div className="rcal-fin-tag rcal-quiet">ignored</div>;
  if (fin === "mismatch") return <div className="rcal-fin-tag rcal-warn">mismatch ⚠</div>;
  // Approved but not verified-pushed (skipped/no-op) — a recorded decision, not
  // a live change. Neutral, never green.
  if (fin === "recorded") return <div className="rcal-fin-tag rcal-quiet">recorded</div>;
  return null;
}

function ActsStrip({ id, api }: { id: string; api: CalApi }) {
  const st = api.stKey(id);
  return (
    <div className="rcal-acts" role="group" aria-label="Actions">
      <button
        type="button"
        title="Approve"
        data-on={st === "approve" ? "" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          api.stageNight(id, "approve");
        }}
      >
        ✓
      </button>
      <button
        type="button"
        title="Edit price"
        data-on={st === "edit" ? "" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          api.editFromActs(id, event.currentTarget.getBoundingClientRect());
        }}
      >
        Edit
      </button>
      <button
        type="button"
        title="Ignore (remembered)"
        data-on={st === "ignore" ? "" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          api.stageNight(id, "ignore");
        }}
      >
        ✕
      </button>
    </div>
  );
}

function BminBtn({ cl, count, onToggle }: { cl: CalClient; count: number; onToggle: (cl: CalClient) => void }) {
  const on = cl.allowBelowFloor;
  const red = count > 0;
  const title = red
    ? `Red because ${count} price${count > 1 ? "s" : ""} on screen ${count > 1 ? "are" : "is"} below this client's minimum — your edits or below-min recommendations. Clicking still toggles whether FUTURE engine recommendations may go below the minimum (sized from landed rates + market data).`
    : on
      ? "On — from the next generation the engine may recommend below listing minimums for this client, still sized from landed rates and market data."
      : "Off — future engine recommendations will not go below listing minimums. Prices you type yourself always can.";
  return (
    <button
      type="button"
      className={`rcal-bmin${red ? " rcal-red" : ""}`}
      data-on={on ? "" : undefined}
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(cl);
      }}
    >
      {on ? "✓ " : ""}allow recs below minimum{red ? ` · ${count} below` : ""}
    </button>
  );
}

// ---------------------------------------------------------------------------
// RunRibbon — ONE continuous bar under a run's nights (lane 3 of each cell)
// ---------------------------------------------------------------------------

function RunRibbon({ r, n, d, ds, currency, api }: { r: DRun; n: CalNight; d: string; ds: string[]; currency: string; api: CalApi }) {
  const lastDay = ds[ds.length - 1];
  const firstDay = ds[0];
  if (!(r.from <= lastDay && r.to >= firstDay)) return null;
  const isStart = n.date === r.from || d === firstDay;
  const isEnd = n.date === r.to || d === lastDay;
  const on = api.runAllStaged(r);
  const shown = api.runShownTotal(r);
  let label: React.ReactNode = null;
  if (n.date === r.from) {
    const visTo = r.to <= lastDay ? r.to : lastDay;
    const visN =
      Math.round((new Date(`${visTo}T00:00:00Z`).getTime() - new Date(`${r.from}T00:00:00Z`).getTime()) / 864e5) + 1;
    label = (
      <span className="rcal-riblabel" style={{ maxWidth: `calc(${visN * 100}% - 18px)` }}>
        <span
          className="rcal-tick"
          onClick={(event) => {
            event.stopPropagation();
            api.stageRun(r, !on);
          }}
        >
          {on ? "✓" : ""}
        </span>
        <span className="rcal-rtxt">
          Select all · {money(r.totCur, currency)}→{money(shown, currency)} · {r.n}n
        </span>
      </span>
    );
  }
  return (
    <div
      className={`rcal-rib${isStart ? " rcal-start" : ""}${isEnd ? " rcal-end" : ""}`}
      data-all={on ? "" : undefined}
      title={`${r.n} nights · ${money(r.totCur, currency)} → ${money(shown, currency)}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest(".rcal-tick")) return;
        api.openRunPop(r, event.currentTarget.getBoundingClientRect());
      }}
    >
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NightTile — one grid cell (3 lanes: min-stay / tile / run ribbon)
// ---------------------------------------------------------------------------

function NightTile({ l, d, ds, api }: { l: DListing; d: string; ds: string[]; api: CalApi }) {
  const today = api.today;
  const wk = dowOf(d) === "Fri" || dowOf(d) === "Sat";
  const td = d === today;
  const n = l.byDate.get(d);
  const paid = l.booked[d];
  const ms = l.minStay[d];
  const cur = l.currency;
  // Prior decision on this night (blue-dot history) + whether a booking landed
  // after a rec we pushed (green dot).
  const hist = l.history?.[d] ?? null;
  const bookedAt = l.bookedAt?.[d] ?? null;
  const bookedAfterPush =
    paid !== undefined && hist !== null && hist.outcome === "pushed" && bookedAt !== null && hist.at !== null && bookedAt > hist.at;

  let cls = `rcal-cell${wk ? " rcal-wkndcol" : ""}${td ? " rcal-todaycol" : ""}`;
  // The engine moved this night's price past the recommendation since the recs
  // were generated — the number is live, but the advice is out of date.
  if (n?.superseded) cls += " rcal-superseded";

  const msSpan =
    ms !== undefined && ms > 1 ? (
      <span
        className="rcal-ms"
        data-block={ms > 2 ? "" : undefined}
        title={ms > 2 ? `${ms}-night min stay — a drop may not unlock this night` : undefined}
      >
        ·{ms}n
      </span>
    ) : null;

  let l1: React.ReactNode = <div className="rcal-l1">{msSpan}</div>;
  let l2: React.ReactNode;

  // Every decided tile is clickable — including a pushed one, so a night dropped
  // yesterday can be re-priced today (daily recs). The popover decides what to
  // offer per state.
  const decHandlers = (id: string) => ({
    tabIndex: 0,
    role: "button",
    onClick: (event: React.MouseEvent<HTMLDivElement>) => {
      api.openNightPop(id, event.currentTarget.getBoundingClientRect());
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      api.openNightPop(id, event.currentTarget.getBoundingClientRect());
    }
  });

  if (paid !== undefined && !n) {
    // Booked reads as booked — and now that a cleanly-decided night drops to
    // history (no live row), a night booked AFTER a pushed rec correctly lands
    // here too (Mark, 2026-07-22). A still-live rec (a multi-unit date with
    // sellable released stock, or a mismatch awaiting review) keeps its tile.
    cls += " rcal-booked-cell";
    l1 = <div className="rcal-l1" />;
    l2 = (
      <div className="rcal-l2">
        <div
          className="rcal-booked-earn"
          data-tip={
            bookedAfterPush && hist
              ? bookedAfterTip(paid, hist, bookedAt, cur)
              : `Booked — earned ${money(paid, cur)} (net allocation)`
          }
        >
          <b>{money(paid, cur)}</b>
          <span>booked</span>
        </div>
      </div>
    );
  } else if (!n) {
    const lv = l.live[d];
    const user = api.userNightFor(l.id, d);
    if (user) {
      const uid = user.id;
      const ufin = api.finKey(uid);
      const upr = api.priceOf(uid, user.n.rec ?? user.n.cur);
      l1 = <div className="rcal-l1" />;
      if (ufin === "mismatch") {
        l2 = (
          <div className="rcal-l2">
            <div className="rcal-dec" data-fin="mismatch" data-tip="Verify mismatch — click for detail" {...decHandlers(uid)}>
              <div className="rcal-live">{money(user.n.cur, cur)}</div>
              <div className="rcal-fin-tag rcal-warn">mismatch ⚠</div>
            </div>
          </div>
        );
      } else if (ufin === "ignored") {
        l2 = (
          <div className="rcal-l2">
            <div className="rcal-dec" data-fin="ignored" data-tip="Ignored — live rate stays. Click for detail." {...decHandlers(uid)}>
              <div className="rcal-live">{money(user.n.cur, cur)}</div>
              <div className="rcal-fin-tag rcal-quiet">ignored</div>
            </div>
          </div>
        );
      } else if (ufin === "pushed") {
        l2 = (
          <div className="rcal-l2">
            <div className="rcal-dec" data-fin="pushed" data-tip="You set this price — pushed and verified">
              <div className="rcal-live">{money(api.finPriceOf(uid) ?? upr, cur)}</div>
              <div className="rcal-fin-tag rcal-ok">pushed ✓</div>
            </div>
          </div>
        );
      } else {
        l2 = (
          <div className="rcal-l2">
            <div className="rcal-dec" data-st="edit" data-tip={`You set ${money(upr, cur)} for this night — in the basket`} {...decHandlers(uid)}>
              <div className="rcal-live">{money(user.n.cur, cur)}</div>
              <span className="rcal-rpill">
                <span className="rcal-arr">→</span>
                {money(upr, cur)}
              </span>
              <div className="rcal-fin-tag rcal-quiet">you set</div>
            </div>
          </div>
        );
      }
    } else if (lv !== undefined && api.settable(d)) {
      l1 = <div className="rcal-l1" />;
      l2 = (
        <div className="rcal-l2">
          <div
            className="rcal-dec rcal-norec rcal-ctx"
            tabIndex={0}
            role="button"
            data-tip={`Open at ${money(lv, cur)} — click to set a price`}
            onClick={(event) => api.openUserPop(l.id, d, event.currentTarget.getBoundingClientRect())}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              api.openUserPop(l.id, d, event.currentTarget.getBoundingClientRect());
            }}
          >
            <div className="rcal-live">{money(lv, cur)}</div>
          </div>
        </div>
      );
    } else if (lv !== undefined) {
      // Beyond the settable window — live rate shown as read-only context (no
      // click-to-set; the calendar can't track a pushed price out here).
      l1 = <div className="rcal-l1" />;
      l2 = (
        <div className="rcal-l2">
          <div className="rcal-dec rcal-norec rcal-ctx rcal-readonly" data-tip={`Open at ${money(lv, cur)} — beyond the tracked window, context only`}>
            <div className="rcal-live">{money(lv, cur)}</div>
          </div>
        </div>
      );
    } else {
      l1 = <div className="rcal-l1">–</div>;
      l2 = (
        <div className="rcal-l2">
          <div className="rcal-dash-q" data-tip="No calendar data">
            ·
          </div>
        </div>
      );
    }
  } else if (n.kind === "hold" && !n.sup) {
    const hst = api.stKey(n.id);
    const hfin = api.finKey(n.id);
    if (hfin === "mismatch") {
      l2 = (
        <div className="rcal-l2">
          <div className="rcal-dec" data-fin="mismatch" data-tip="Verify mismatch — click for detail" {...decHandlers(n.id)}>
            <div className="rcal-live">{money(n.cur, cur)}</div>
            <div className="rcal-fin-tag rcal-warn">mismatch ⚠</div>
          </div>
        </div>
      );
    } else if (hfin === "pushed") {
      l2 = (
        <div className="rcal-l2">
          <div
            className="rcal-dec"
            data-fin="pushed"
            data-tip="You set this price — pushed and verified. Click to set a new price."
            {...decHandlers(n.id)}
          >
            <div className="rcal-live">{money(api.finPriceOf(n.id) ?? api.priceOf(n.id, n.cur), cur)}</div>
            <div className="rcal-fin-tag rcal-ok">{pushedLabel(n.actionedAt)}</div>
          </div>
        </div>
      );
    } else if (hst === "edit") {
      l2 = (
        <div className="rcal-l2">
          <div className="rcal-dec" data-st="edit" data-tip={`You set ${money(api.priceOf(n.id, n.cur), cur)} — in the basket`} {...decHandlers(n.id)}>
            <div className="rcal-live">{money(n.cur, cur)}</div>
            <span className="rcal-rpill">
              <span className="rcal-arr">→</span>
              {money(api.priceOf(n.id, n.cur), cur)}
            </span>
            <div className="rcal-fin-tag rcal-quiet">you set</div>
          </div>
        </div>
      );
    } else {
      // No box = nothing to do. The live rate above is the whole story.
      l2 = (
        <div className="rcal-l2">
          <div
            className="rcal-dec rcal-norec"
            data-tip={`Available at ${money(n.cur, cur)} — holding this rate is the plan`}
            {...decHandlers(n.id)}
          >
            <div className="rcal-live">{money(n.cur, cur)}</div>
          </div>
        </div>
      );
    }
  } else if (n.kind === "hold" && n.sup) {
    const sst = api.stKey(n.id);
    const sfin = api.finKey(n.id);
    if (sfin === "pushed") {
      l2 = (
        <div className="rcal-l2">
          <div
            className="rcal-dec"
            data-fin="pushed"
            data-tip="You set this price — pushed and verified. Click to set a new price."
            {...decHandlers(n.id)}
          >
            <div className="rcal-live">{money(api.finPriceOf(n.id) ?? api.priceOf(n.id, n.cur), cur)}</div>
            <div className="rcal-fin-tag rcal-ok">{pushedLabel(n.actionedAt)}</div>
          </div>
        </div>
      );
    } else if (sfin === "mismatch") {
      l2 = (
        <div className="rcal-l2">
          <div className="rcal-dec" data-fin="mismatch" data-tip="Verify mismatch — click for detail" {...decHandlers(n.id)}>
            <div className="rcal-live">{money(n.cur, cur)}</div>
            <div className="rcal-fin-tag rcal-warn">mismatch ⚠</div>
          </div>
        </div>
      );
    } else if (sst === "edit") {
      l2 = (
        <div className="rcal-l2">
          <div className="rcal-dec" data-st="edit" data-tip={`You set ${money(api.priceOf(n.id, n.cur), cur)} — in the basket`} {...decHandlers(n.id)}>
            <div className="rcal-live">{money(n.cur, cur)}</div>
            <span className="rcal-rpill">
              <span className="rcal-arr">→</span>
              {money(api.priceOf(n.id, n.cur), cur)}
            </span>
            <div className="rcal-fin-tag rcal-quiet">you set</div>
          </div>
        </div>
      );
    } else {
      l2 = (
        <div className="rcal-l2">
          <div className="rcal-dec rcal-norec" data-tip={`Drop held back: ${n.sup.replace(/_/g, " ")}`} {...decHandlers(n.id)}>
            <div className="rcal-live">{money(n.cur, cur)}</div>
            <div className="rcal-fin-tag rcal-quiet">held back</div>
          </div>
        </div>
      );
    }
  } else {
    const st = api.stKey(n.id);
    const fin = api.finKey(n.id);
    const priceNow = api.priceOf(n.id, n.rec ?? n.cur);
    const pct = n.cur > 0 ? Math.round(((priceNow - n.cur) / n.cur) * 100) : 0;
    if (fin === "pushed") {
      const shown = api.finPriceOf(n.id) ?? priceNow;
      l2 = (
        <div className="rcal-l2">
          <div
            className="rcal-dec"
            data-fin="pushed"
            data-tip={`Pushed and verified at ${money(shown, cur)} — click to set a new price`}
            {...decHandlers(n.id)}
          >
            <div className="rcal-live">{money(shown, cur)}</div>
            <div className="rcal-fin-tag rcal-ok">{pushedLabel(n.actionedAt)}</div>
          </div>
        </div>
      );
    } else if (fin === "ignored") {
      l2 = (
        <div className="rcal-l2">
          <div className="rcal-dec" data-fin="ignored" data-tip="Ignored — live rate stays. Click for detail." {...decHandlers(n.id)}>
            <div className="rcal-live">{money(n.cur, cur)}</div>
            <div className="rcal-fin-tag rcal-quiet">ignored</div>
          </div>
        </div>
      );
    } else if (fin === "mismatch") {
      l2 = (
        <div className="rcal-l2">
          <div className="rcal-dec" data-fin="mismatch" data-tip="Verify mismatch — click for detail" {...decHandlers(n.id)}>
            <div className="rcal-live">{money(n.cur, cur)}</div>
            <div className="rcal-fin-tag rcal-warn">mismatch ⚠</div>
          </div>
        </div>
      );
    } else if (fin === "recorded") {
      const shown = api.finPriceOf(n.id) ?? priceNow;
      l2 = (
        <div className="rcal-l2">
          <div className="rcal-dec" data-fin="recorded" data-tip="Approved — recorded, not pushed live" {...decHandlers(n.id)}>
            <div className="rcal-live">{money(shown, cur)}</div>
            <div className="rcal-fin-tag rcal-quiet">recorded</div>
          </div>
        </div>
      );
    } else {
      const fl = n.floor !== null && n.floor !== undefined ? n.floor : l.min;
      const below = Boolean(fl && priceNow < fl);
      l2 = (
        <div className="rcal-l2">
          <div className="rcal-dec" data-st={st || undefined} data-tip={n.why || ""} {...decHandlers(n.id)}>
            {n.ov && n.ov.verdict === "flag" ? <span className="rcal-ovflag" /> : null}
            <div className="rcal-live">{money(n.cur, cur)}</div>
            <span className={`rcal-rpill${below ? " rcal-below" : ""}`} title={`${pct}%`}>
              <span className="rcal-arr">↘</span>
              {money(priceNow, cur)}
            </span>
            {api.isPending(n) ? <ActsStrip id={n.id} api={api} /> : null}
          </div>
        </div>
      );
    }
  }

  const r = n ? api.runOfNight.get(n.id) : undefined;
  // Small red dot when the engine already holds an override for this night —
  // approving a rec replaces it (for this one night only). Not shown on booked
  // nights (nothing to push there).
  const override = paid === undefined && api.hasOverride(l.id, d);
  // Green dot: booked after a rec we pushed. Blue dot: a prior decision on this
  // night (returns as history the moment it is actioned). Only one shows — a
  // booked-after-push night is green (it carries the same push info).
  const greenDot = bookedAfterPush && hist;
  const blueDot = !greenDot && hist !== null;
  const selected = api.cellSelected(l.id, d);

  return (
    <div
      className={`${cls}${selected ? " rcal-selected" : ""}`}
      onMouseDown={(event) => {
        // Left button only; never start a drag from a real control (the acts
        // ✓/Edit/✕ buttons or any input) so their own clicks keep working.
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest("button, input, select")) return;
        api.beginDrag(l.id, d, event.currentTarget.getBoundingClientRect());
      }}
      onMouseEnter={(event) => {
        if (event.buttons !== 1) return; // only while the left button is held
        api.extendDrag(l.id, d, event.currentTarget.getBoundingClientRect());
      }}
    >
      {n?.superseded ? (
        <span
          className="rcal-supmark"
          data-tip={`The price moved to ${money(n.cur, cur)} after this rec was worked out${
            n.curWas != null ? ` (it was ${money(n.curWas, cur)})` : ""
          } — the recommendation is out of date, regenerate before pushing`}
        />
      ) : null}
      {override ? <span className="rcal-ovrmark" data-tip="An override already exists on the engine for this night — approving replaces it for this night only" /> : null}
      {greenDot && hist ? <span className="rcal-bookmark" data-tip={bookedAfterTip(paid as number, hist, bookedAt, cur)} /> : null}
      {blueDot && hist ? <span className="rcal-histmark" data-tip={historyTip(hist, cur)} /> : null}
      {l1}
      {l2}
      <div className="rcal-l3">{r && n ? <RunRibbon r={r} n={n} d={d} ds={ds} currency={cur} api={api} /> : null}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgendaCard — one listing's agenda rows (with on-pace stretches collapsed)
// ---------------------------------------------------------------------------

function AgendaCard({ l, api }: { l: DListing; api: CalApi }) {
  const cur = l.currency;
  const rows: React.ReactNode[] = [];
  let paceStart: string | null = null;
  let paceEnd: string | null = null;
  const flush = () => {
    if (paceStart) {
      rows.push(
        <div className="rcal-apace" key={`pace-${paceStart}`}>
          {fmtD(paceStart)}
          {paceEnd !== paceStart ? `–${fmtD(paceEnd ?? paceStart)}` : ""} · on pace / hold — nothing to do
        </div>
      );
      paceStart = null;
    }
  };

  for (const d of api.days) {
    const n = l.byDate.get(d);
    const paid = l.booked[d];
    const ms = l.minStay[d];
    if (paid !== undefined && !n) {
      flush();
      const h = l.history?.[d] ?? null;
      const bAt = l.bookedAt?.[d] ?? null;
      const afterPush = h !== null && h.outcome === "pushed" && bAt !== null && h.at !== null && bAt > h.at;
      rows.push(
        <div className="rcal-arow rcal-bkd" key={d} data-tip={afterPush && h ? bookedAfterTip(paid, h, bAt, cur) : undefined}>
          <span className="rcal-d">
            {fmtD(d)} <small>{dowOf(d)}</small>
          </span>
          <span className="rcal-r">{money(paid, cur)}</span>
          <span style={{ fontSize: 9, textTransform: "uppercase" }}>
            booked · earned{afterPush ? " ·" : ""}
            {afterPush ? <b style={{ color: "var(--rcal-staged)" }}> after push</b> : null}
          </span>
        </div>
      );
      continue;
    }
    if (!n) {
      const user = api.userNightFor(l.id, d);
      if (user) {
        flush();
        const uid = user.id;
        const ufin = api.finKey(uid);
        const upx = api.priceOf(uid, user.n.rec ?? user.n.cur);
        const shown = ufin === "pushed" ? (api.finPriceOf(uid) ?? upx) : upx;
        rows.push(
          <div
            className="rcal-arow"
            key={d}
            onClick={(event) => {
              if (ufin === "pushed") return;
              api.openNightPop(uid, event.currentTarget.getBoundingClientRect());
            }}
          >
            <span className="rcal-d">
              {fmtD(d)} <small>{dowOf(d)}</small>
            </span>
            <span className="rcal-c">{money(user.n.cur, cur)}</span>
            <span className="rcal-r">{money(shown, cur)}</span>
            <span className="rcal-pct" style={{ color: "var(--rcal-muted)" }}>
              set
            </span>
            <FinTag fin={ufin} />
          </div>
        );
        continue;
      }
      const lv = l.live[d];
      if (lv !== undefined && paid === undefined && api.settable(d)) {
        flush();
        rows.push(
          <div
            className="rcal-arow rcal-uopen"
            key={d}
            onClick={(event) => api.openUserPop(l.id, d, event.currentTarget.getBoundingClientRect())}
          >
            <span className="rcal-d">
              {fmtD(d)} <small>{dowOf(d)}</small>
            </span>
            <span className="rcal-c">{money(lv, cur)}</span>
            <span style={{ fontSize: 9, textTransform: "uppercase", color: "var(--rcal-muted)" }}>open · tap to set a price</span>
          </div>
        );
        continue;
      }
      if (lv !== undefined && paid === undefined) {
        // Beyond the settable window — read-only context row, no tap-to-set.
        flush();
        rows.push(
          <div className="rcal-arow" key={d}>
            <span className="rcal-d">
              {fmtD(d)} <small>{dowOf(d)}</small>
            </span>
            <span className="rcal-c">{money(lv, cur)}</span>
            <span style={{ fontSize: 9, textTransform: "uppercase", color: "var(--rcal-faint)" }}>open · context only</span>
          </div>
        );
        continue;
      }
      flush();
      continue;
    }
    if (n.kind === "hold") {
      const hst = api.stKey(n.id);
      const hfin = api.finKey(n.id);
      if (!hst && !hfin && !n.sup) {
        if (!paceStart) paceStart = d;
        paceEnd = d;
        continue;
      }
      flush();
      const shown = api.priceOf(n.id, n.cur);
      const right = hfin === "pushed" && api.finPriceOf(n.id) !== undefined ? (api.finPriceOf(n.id) as number) : shown;
      rows.push(
        <div
          className="rcal-arow"
          key={d}
          onClick={(event) => {
            api.openNightPop(n.id, event.currentTarget.getBoundingClientRect());
          }}
        >
          <span className="rcal-d">
            {fmtD(d)} <small>{dowOf(d)}</small>
          </span>
          <span className="rcal-c">{money(n.cur, cur)}</span>
          <span className="rcal-r">{money(right, cur)}</span>
          <span className="rcal-pct" style={{ color: "var(--rcal-muted)" }}>
            {hst === "edit" && !hfin ? "set" : n.sup ? "held" : "hold"}
          </span>
          <FinTag fin={hfin} />
        </div>
      );
      continue;
    }
    flush();
    const fin = api.finKey(n.id);
    const priceNow = api.priceOf(n.id, n.rec ?? n.cur);
    const fl = n.floor !== null && n.floor !== undefined ? n.floor : l.min;
    const below = Boolean(fl && priceNow < fl);
    rows.push(
      <div
        className="rcal-arow"
        key={d}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest(".rcal-acts")) return;
          api.openNightPop(n.id, event.currentTarget.getBoundingClientRect());
        }}
      >
        <span className="rcal-d">
          {fmtD(d)} <small>{dowOf(d)}</small>
        </span>
        <span className="rcal-c">{money(n.cur, cur)}</span>
        <span className={`rcal-r${below ? " rcal-below" : ""}`}>{money(priceNow, cur)}</span>
        <span className="rcal-pct">{n.cur > 0 ? Math.round(((priceNow - n.cur) / n.cur) * 100) : 0}%</span>
        {ms !== undefined && ms > 1 ? <span className="rcal-ms2">·{ms}n</span> : null}
        <FinTag fin={fin} />
        {api.isPending(n) && !fin ? <ActsStrip id={n.id} api={api} /> : null}
      </div>
    );
  }
  flush();

  return (
    <div className="rcal-acard">
      <h4>
        <span>{l.name}</span>
        <small>
          {l.min ? `min ${money(l.min, cur)} · ` : ""}
          {l.base ? `base ${money(l.base, cur)} · ` : ""}
          {api.listingPending(l)} to review
        </small>
      </h4>
      {rows}
    </div>
  );
}

// ---------------------------------------------------------------------------
// UserSetForm — set your own price on an open night (single or through-span)
// ---------------------------------------------------------------------------

function UserSetForm({
  lid,
  date,
  lead,
  initial,
  days,
  onSubmit
}: {
  lid: string;
  date: string;
  lead: string | null;
  initial: number;
  days: string[];
  onSubmit: (lid: string, date: string, through: string, value: number) => string | null;
}) {
  const [err, setErr] = useState<string | null>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const throughRef = useRef<HTMLSelectElement>(null);
  let list = days;
  let from = list.indexOf(date);
  if (from === -1) {
    list = [date];
    from = 0;
  }
  const options = list.slice(from).map((d2, i) => (
    <option key={d2} value={d2}>
      {i === 0 ? "this night only" : `through ${fmtD(d2)}`}
    </option>
  ));
  return (
    <div className="rcal-usr-set">
      {lead ? <div className="rcal-why">{lead}</div> : null}
      <div className="rcal-editrow">
        <input
          ref={priceRef}
          type="number"
          inputMode="decimal"
          defaultValue={Math.round(initial)}
          aria-label="New price"
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
        />
        <select ref={throughRef} aria-label="Apply through" defaultValue={list[from]}>
          {options}
        </select>
        <button
          type="button"
          className="rcal-ok"
          onClick={() => {
            const value = Number(priceRef.current?.value);
            const through = throughRef.current?.value ?? date;
            const problem = onSubmit(lid, date, through, value);
            setErr(problem);
          }}
        >
          Set
        </button>
      </div>
      <div className="rcal-err">{err}</div>
      <div className="rcal-why" style={{ fontSize: 10 }}>
        Pick a later date to set every open night in between — booked and already-pushed nights are skipped. Your own price can
        go below the listing minimum.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BulkSetForm — apply an exact price OR a % drop to a drag-selected span
// ---------------------------------------------------------------------------

function BulkSetForm({
  lid,
  from,
  to,
  currency,
  onSubmit
}: {
  lid: string;
  from: string;
  to: string;
  currency: string;
  onSubmit: (lid: string, from: string, to: string, mode: BulkMode) => string | null;
}) {
  const [mode, setMode] = useState<"pct" | "price">("pct");
  const [err, setErr] = useState<string | null>(null);
  const valRef = useRef<HTMLInputElement>(null);
  const apply = () => {
    const value = Number(valRef.current?.value);
    const problem = onSubmit(lid, from, to, mode === "price" ? { kind: "price", value } : { kind: "pct", pct: value });
    setErr(problem);
  };
  return (
    <div className="rcal-usr-set">
      <div className="rcal-bulk-modes" role="group" aria-label="Apply mode">
        <button type="button" className="rcal-bulk-mode" data-on={mode === "pct" ? "" : undefined} onClick={() => setMode("pct")}>
          % drop
        </button>
        <button
          type="button"
          className="rcal-bulk-mode"
          data-on={mode === "price" ? "" : undefined}
          onClick={() => setMode("price")}
        >
          Set price
        </button>
      </div>
      <div className="rcal-editrow">
        {mode === "pct" ? <span className="rcal-bulk-affix">−</span> : <span className="rcal-bulk-affix">{currencySymbol(currency)}</span>}
        <input
          ref={valRef}
          type="number"
          inputMode="decimal"
          key={mode}
          defaultValue={mode === "pct" ? 10 : ""}
          placeholder={mode === "price" ? "price" : undefined}
          aria-label={mode === "pct" ? "Percent drop" : "New price"}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") apply();
          }}
        />
        {mode === "pct" ? <span className="rcal-bulk-affix">%</span> : null}
        <button type="button" className="rcal-ok" onClick={apply}>
          Apply
        </button>
      </div>
      <div className="rcal-err">{err}</div>
      <div className="rcal-why" style={{ fontSize: 10 }}>
        {mode === "pct"
          ? "Each night comes down by this % from its own current price. Deeper than 49% is blocked (fat-finger guard)."
          : "Every night in the span is set to this exact price. Your own price can go below the listing minimum."}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PushModal — Review & Push (grouped by client, sequential outcomes)
// ---------------------------------------------------------------------------

function PushModal({
  entries,
  rowMarks,
  pushing,
  stopRequested,
  progressVisible,
  progress,
  summary,
  subText,
  confirmVisible,
  onRemove,
  onCancel,
  onConfirm
}: {
  entries: ModalEntry[];
  rowMarks: Record<string, RowMark>;
  pushing: boolean;
  stopRequested: boolean;
  progressVisible: boolean;
  progress: number;
  summary: string | null;
  subText: string;
  confirmVisible: boolean;
  onRemove: (id: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const groups: Array<{ clientName: string; engine: string; rows: ModalEntry[] }> = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.clientName === entry.clientName) last.rows.push(entry);
    else groups.push({ clientName: entry.clientName, engine: entry.engine, rows: [entry] });
  }
  const cancelLabel = pushing ? "Stop after current night" : summary ? "Done" : "Back";
  return (
    <div className="rcal-modal" role="dialog" aria-modal="true">
      <div className="rcal-modal-in">
        <h3>Confirm</h3>
        <div className="rcal-sub">{subText}</div>
        {progressVisible ? (
          <div className="rcal-prog">
            <i style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        <div>
          {groups.map((group) => (
            <div className="rcal-mgroup" key={group.clientName}>
              <header>
                {group.clientName}
                <span className="rcal-eng">{engineLabel(group.engine)}</span>
              </header>
              {group.rows.map((x) => {
                const mark = rowMarks[x.id];
                const priceBit =
                  x.act === "ignore"
                    ? `${money(x.cur, x.currency)} stays`
                    : `${money(x.cur, x.currency)} → ${money(x.price, x.currency)}${x.kind === "user" ? " (you set)" : x.edited ? " (edited)" : ""}`;
                return (
                  <div className="rcal-mrow" key={x.id}>
                    {x.act === "ignore" ? (
                      <span className="rcal-verb rcal-ign">skip</span>
                    ) : (
                      <span className="rcal-verb rcal-push">push</span>
                    )}
                    <span>
                      {x.dow} {fmtD(x.date)}
                    </span>
                    <span className="rcal-mlist">{x.listingName}</span>
                    <span>{priceBit}</span>
                    {mark ? (
                      <span className={`rcal-st rcal-${mark.cls}`} title={mark.label}>
                        {mark.label}
                      </span>
                    ) : (
                      <button type="button" className="rcal-rm" aria-label="Remove from push" onClick={() => onRemove(x.id)}>
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {summary ? <div className="rcal-msummary">{summary}</div> : null}
        <div className="rcal-mbtns">
          <button type="button" className="rcal-btn rcal-ghost" disabled={pushing && stopRequested} onClick={onCancel}>
            {cancelLabel}
          </button>
          {confirmVisible ? (
            <button type="button" className="rcal-btn" onClick={onConfirm}>
              Push now
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The main view
// ---------------------------------------------------------------------------

export default function RecsCalendarView() {
  const [data, setData] = useState<CalPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [staged, setStaged] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [fin, setFin] = useState<Record<string, string>>({});
  const [finPrice, setFinPrice] = useState<Record<string, number>>({});
  const [userNights, setUserNights] = useState<Record<string, UserNightSeed>>({});
  // listingId → dates that already carry an engine override (lazy per client).
  const [overrideDates, setOverrideDates] = useState<Record<string, string[]>>({});

  const [clientSel, setClientSel] = useState("all");
  const [range, setRange] = useState(14);
  const [customOn, setCustomOn] = useState(false);
  const [customShown, setCustomShown] = useState(false);
  const [customVal, setCustomVal] = useState("21");
  const [view, setView] = useState<"grid" | "agenda">("grid");
  const [needsOnly, setNeedsOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [fGroups, setFGroups] = useState<Record<string, boolean>>({});
  const [fTags, setFTags] = useState<Record<string, boolean>>({});
  const [openMenu, setOpenMenu] = useState<"groups" | "tags" | null>(null);

  const [pop, setPop] = useState<PopState | null>(null);
  const [popRunEditing, setPopRunEditing] = useState(false);
  const [popErr, setPopErr] = useState<string | null>(null);
  const [popBusy, setPopBusy] = useState(false);

  // Drag-select: highlight span (state, for render) + interaction refs (logic,
  // no re-render needed). Selection is bounded to ONE listing's row.
  const [dragSel, setDragSel] = useState<{ lid: string; anchor: string; over: string } | null>(null);
  const dragStartRef = useRef<{ lid: string; date: string } | null>(null);
  const dragMovedRef = useRef(false);
  const dragRectRef = useRef<DOMRect | null>(null);
  const dragOverRef = useRef<{ lid: string; date: string } | null>(null);
  const dragConsumeClickRef = useRef(false);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [clearArmed, setClearArmed] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalEntries, setModalEntries] = useState<ModalEntry[]>([]);
  const [rowMarks, setRowMarks] = useState<Record<string, RowMark>>({});
  const [pushing, setPushing] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const stopRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);

  const popRef = useRef<HTMLDivElement>(null);
  const groupsSumRef = useRef<HTMLElement>(null);
  const tagsSumRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const customRef = useRef<HTMLInputElement>(null);

  const [tip, setTip] = useState<{ text: string; left: number; top: number } | null>(null);

  // ---- data loading -------------------------------------------------------

  const applyPayload = useCallback((body: CalPayload, reconcile: boolean) => {
    setData(body);
    setClientSel((prev) => (prev === "all" || body.clients.some((c) => c.id === prev) ? prev : "all"));
    if (!reconcile) return;
    const allIds = new Set<string>();
    const pendingIds = new Set<string>();
    for (const cl of body.clients) {
      for (const l of cl.listings) {
        for (const n of l.nights) {
          allIds.add(n.id);
          if (n.status === "pending") pendingIds.add(n.id);
        }
      }
    }
    // Server statuses win: synthetic user nights and locally recorded outcomes
    // are dropped in favour of the fresh payload; only verify-mismatch marks
    // survive (the server keeps those rows "approved", which would otherwise
    // render as pushed).
    setUserNights({});
    setStaged((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => pendingIds.has(id))));
    setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => pendingIds.has(id))));
    setFin((prev) => Object.fromEntries(Object.entries(prev).filter(([id, v]) => v === "mismatch" && allIds.has(id))));
    setFinPrice((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => allIds.has(id))));
  }, []);

  const loadCalendar = useCallback(
    async (reconcile: boolean) => {
      setLoadError(null);
      if (!reconcile) setLoading(true);
      try {
        const response = await fetch(withBasePath("/api/recs/calendar"));
        const body = (await response.json().catch(() => ({}))) as Partial<CalPayload> & { error?: string };
        if (!response.ok || !body.clients || typeof body.today !== "string") {
          throw new Error(body.error ?? "Failed to load the calendar");
        }
        applyPayload(body as CalPayload, reconcile);
      } catch (error) {
        if (!reconcile) setLoadError(error instanceof Error ? error.message : "Failed to load the calendar");
        else showToastRef.current(error instanceof Error ? `Refresh failed — ${error.message}` : "Refresh failed");
      } finally {
        setLoading(false);
      }
    },
    [applyPayload]
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  // Mount: restore persisted prefs (client pick, view, range), default the
  // view to agenda on small screens, then fetch.
  useEffect(() => {
    try {
      const v = window.localStorage.getItem("recsCalView");
      if (v === "grid" || v === "agenda") setView(v);
      else if (window.matchMedia("(max-width: 720px)").matches) setView("agenda");
      const c = window.localStorage.getItem("recsCalClient");
      if (c) setClientSel(c);
      const r = Number(window.localStorage.getItem("recsCalRange"));
      if (Number.isFinite(r) && r >= 2 && r <= 30) {
        setRange(r);
        if (r !== 7 && r !== 14 && r !== 30) {
          setCustomOn(true);
          setCustomShown(true);
          setCustomVal(String(r));
        }
      }
    } catch {
      // localStorage unavailable — defaults stand
    }
    void loadCalendar(false);
  }, [loadCalendar]);

  // Lazily fetch which nights already carry an engine override, for the
  // SELECTED single client only. Never for "all clients" — fetching every
  // client's listings live would burst the engines into a rate limit (the
  // exact thing the pacing fix avoids). Non-blocking: the grid renders first,
  // the red dots fill in when this resolves (server-cached ~10min).
  useEffect(() => {
    if (clientSel === "all") {
      setOverrideDates({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/recs/overrides?tenantId=${encodeURIComponent(clientSel)}`);
        if (!res.ok) return;
        const body = (await res.json()) as { overrides?: Record<string, string[]> };
        if (!cancelled && body && body.overrides) setOverrideDates(body.overrides);
      } catch {
        // Non-blocking — the mark is an aid, not load-bearing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientSel]);

  useEffect(() => {
    try {
      window.localStorage.setItem("recsCalView", view);
    } catch {
      /* ignore */
    }
  }, [view]);
  useEffect(() => {
    try {
      window.localStorage.setItem("recsCalClient", clientSel);
    } catch {
      /* ignore */
    }
  }, [clientSel]);
  useEffect(() => {
    try {
      window.localStorage.setItem("recsCalRange", String(range));
    } catch {
      /* ignore */
    }
  }, [range]);

  // ---- derived index ------------------------------------------------------

  const idx: CalIndex = useMemo(() => {
    const nights = new Map<string, NightRef>();
    const runOfNight = new Map<string, DRun>();
    const runByKey = new Map<string, { r: DRun; l: DListing; cl: CalClient }>();
    const listings = new Map<string, { l: DListing; cl: CalClient }>();
    const listingsByClient = new Map<string, DListing[]>();
    const seededFin = new Map<string, string>();
    if (data) {
      for (const cl of data.clients) {
        const ls: DListing[] = [];
        for (const raw of cl.listings) {
          const byDate = new Map<string, CalNight>();
          for (const n of raw.nights) byDate.set(n.date, n);
          // Merge adjacent drop runs into one continuous ribbon; hold runs are
          // not drawn (holds are automatic).
          const drops = raw.runs
            .filter((r) => r.runKind !== "hold")
            .slice()
            .sort((a, b) => (a.from < b.from ? -1 : 1));
          const merged: DRun[] = [];
          let cursor: DRun | null = null;
          for (const r of drops) {
            if (cursor && addDays(cursor.to, 1) === r.from) {
              cursor.to = r.to;
              cursor.n += r.n;
              cursor.ids = cursor.ids.concat(r.ids);
              cursor.totCur += r.totCur;
              cursor.totRec += r.totRec;
              cursor.seg = "mixed";
              cursor.uniformPct = null;
            } else {
              cursor = { ...r, ids: [...r.ids], key: "", lid: raw.id };
              merged.push(cursor);
            }
          }
          for (const r of merged) r.key = `run:${r.ids.join(",")}`;
          const l: DListing = {
            ...raw,
            runs: merged,
            byDate,
            clientId: cl.id,
            clientName: cl.name,
            currency: cl.currency,
            engine: cl.engine
          };
          ls.push(l);
          listings.set(l.id, { l, cl });
          for (const n of raw.nights) {
            nights.set(n.id, { n, l, cl });
            // Cold-load fin MUST reflect the real push outcome, never a guess
            // from status: a verify mismatch / push error / pre-push skip all
            // leave status "approved" (only a verified success becomes
            // "applied"). Paint green ONLY when the engine confirmed the write;
            // an unverified/failed push shows as "mismatch" (left for review);
            // an actioned drop with no successful push is a neutral "recorded".
            const p = n.push;
            if (n.status === "applied" || (p && p.pushed && p.verified === true && !p.reverted)) {
              seededFin.set(n.id, "pushed");
            } else if (p && p.pushed && (p.verified === false || p.error) && !p.reverted) {
              seededFin.set(n.id, "mismatch");
            } else if (n.status === "rejected") {
              seededFin.set(n.id, "ignored");
            } else if (n.status === "approved" && n.kind !== "hold") {
              seededFin.set(n.id, "recorded");
            }
          }
          for (const r of merged) {
            runByKey.set(r.key, { r, l, cl });
            for (const id of r.ids) runOfNight.set(id, r);
          }
        }
        listingsByClient.set(cl.id, ls);
      }
      // Synthetic operator-set nights (client-side until Review & Push creates
      // the real suggestion via /api/recs/user-set).
      for (const [uid, seed] of Object.entries(userNights)) {
        const hit = listings.get(seed.lid);
        if (!hit) continue;
        const n: CalNight = {
          id: uid,
          date: seed.date,
          dow: dowOf(seed.date),
          cur: seed.cur,
          rec: seed.cur,
          pct: 0,
          kind: "user",
          sup: null,
          why: "price set by you",
          whyFull: "",
          comp: [],
          floor: hit.l.min ?? null,
          floorUnknown: hit.l.min === null || hit.l.min === undefined,
          status: "pending",
          ov: null
        };
        nights.set(uid, { n, l: hit.l, cl: hit.cl });
      }
    }
    return { nights, runOfNight, runByKey, listings, listingsByClient, seededFin };
  }, [data, userNights]);

  const today = data?.today ?? "";
  const days = useMemo(() => {
    if (!today) return [] as string[];
    const out: string[] = [];
    for (let i = 0; i < range; i++) out.push(addDays(today, i));
    return out;
  }, [today, range]);
  // Operator price-setting is bounded to the window the recs pipeline surfaces
  // and tracks; the first date PAST it is the read-only boundary. A price set
  // beyond would push live yet vanish from the calendar (and could re-push).
  const settableDays = data?.settableDays ?? 14;
  const settableBoundary = today ? addDays(today, settableDays) : "";
  const settable = useCallback(
    (date: string): boolean => Boolean(settableBoundary) && date < settableBoundary,
    [settableBoundary]
  );
  // The through-date span options must never offer a date the calendar can't
  // track — the user-set form picks its end date from this clamped list.
  const settableRange = useMemo(() => days.filter(settable), [days, settable]);

  // ---- tiny state helpers (plain closures — recreated per render) ---------

  const stKey = (id: string): string => staged[id] ?? "";
  const finKey = (id: string): string => fin[id] ?? idx.seededFin.get(id) ?? "";
  const isPending = (n: CalNight): boolean => n.status === "pending" && !finKey(n.id);
  const isDropRec = (n: CalNight): boolean => n.kind === "drop" && !n.sup;
  const priceOf = (id: string, fb: number): number => {
    if (finPrice[id] !== undefined) return finPrice[id];
    if (edits[id] !== undefined) return edits[id];
    return fb;
  };
  const finPriceOf = (id: string): number | undefined => finPrice[id];
  const runAllStaged = (r: DRun): boolean => r.ids.every((id) => stKey(id) === "approve" || stKey(id) === "edit");
  const runShownTotal = (r: DRun): number => {
    let t = 0;
    for (const id of r.ids) {
      const ref = idx.nights.get(id);
      if (ref) t += priceOf(id, ref.n.rec ?? ref.n.cur);
    }
    return Math.round(t);
  };
  const listingPending = (l: DListing): number => {
    let c = 0;
    for (const n of l.nights) if (isDropRec(n) && isPending(n)) c++;
    return c;
  };

  const setFinEntry = (id: string, value: string) => setFin((prev) => ({ ...prev, [id]: value }));
  const setFinPriceEntry = (id: string, value: number) => setFinPrice((prev) => ({ ...prev, [id]: value }));
  const clearStagedEntry = (id: string) => {
    setStaged((prev) => {
      if (prev[id] === undefined) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setEdits((prev) => {
      if (prev[id] === undefined) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // ---- staging ------------------------------------------------------------

  const stageNight = (id: string, act: string) => {
    if (stKey(id) === act) {
      clearStagedEntry(id);
    } else {
      setStaged((prev) => ({ ...prev, [id]: act }));
      if (act !== "edit") {
        setEdits((prev) => {
          if (prev[id] === undefined) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    }
  };

  const stageRun = (r: DRun, on: boolean) => {
    for (const id of r.ids) {
      const ref = idx.nights.get(id);
      if (!ref || !isPending(ref.n)) continue;
      if (on) {
        if (stKey(id) !== "edit") setStaged((prev) => ({ ...prev, [id]: "approve" }));
      } else {
        clearStagedEntry(id);
      }
    }
  };

  // ---- popover ------------------------------------------------------------

  const rectAnchor = (rect: DOMRect): PopAnchor => ({ left: rect.left, top: rect.top, bottom: rect.bottom });

  const openNightPop = (id: string, rect: DOMRect) => {
    setPopErr(null);
    setPopRunEditing(false);
    setDragSel(null); // opening another popover clears a leftover drag highlight
    setPop({ kind: "night", id, anchor: rectAnchor(rect) });
  };
  const openRunPop = (r: DRun, rect: DOMRect) => {
    setPopErr(null);
    setPopRunEditing(false);
    setDragSel(null);
    setPop({ kind: "run", runKey: r.key, anchor: rectAnchor(rect) });
  };
  const openUserPop = (lid: string, date: string, rect: DOMRect) => {
    setPopErr(null);
    setPopRunEditing(false);
    setDragSel(null);
    setPop({ kind: "user", lid, date, anchor: rectAnchor(rect) });
  };
  const closePop = useCallback(() => {
    setPop(null);
    setPopRunEditing(false);
    setPopErr(null);
    setDragSel(null); // drop the drag-select highlight when its popover closes
  }, []);

  const editFromActs = (id: string, rect: DOMRect) => {
    setStaged((prev) => ({ ...prev, [id]: "edit" }));
    openNightPop(id, rect);
  };

  useLayoutEffect(() => {
    if (!pop || !popRef.current) return;
    const el = popRef.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = Math.max(10, Math.min(pop.anchor.left, window.innerWidth - w - 10));
    let y = pop.anchor.bottom + 6;
    if (y + h > window.innerHeight - 10) y = Math.max(10, pop.anchor.top - h - 6);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [pop, staged, edits, popRunEditing, popErr, popBusy]);

  // Global listeners: Escape closes the popover; clicks outside close the
  // popover and the filter menus; any scroll/resize closes floating chrome.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePop();
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.isConnected) return;
      if (!target.closest(".rcal-fdrop")) setOpenMenu(null);
      if (
        popRef.current &&
        !target.closest(".rcal-pop") &&
        !target.closest(".rcal-dec,.rcal-rib,.rcal-arow,.rcal-acts")
      ) {
        closePop();
      }
    };
    const onScroll = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target && typeof target.closest === "function" && target.closest(".rcal-fmenu")) return;
      setOpenMenu(null);
      if (popRef.current && !(document.activeElement && popRef.current.contains(document.activeElement))) closePop();
    };
    const onResize = () => {
      setOpenMenu(null);
      closePop();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
    };
  }, [closePop]);

  // Filter menu positioning (fixed, under its summary pill).
  useLayoutEffect(() => {
    if (!openMenu || !menuRef.current) return;
    const sum = openMenu === "groups" ? groupsSumRef.current : tagsSumRef.current;
    if (!sum) return;
    const r = sum.getBoundingClientRect();
    menuRef.current.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 228))}px`;
    menuRef.current.style.top = `${r.bottom + 6}px`;
  }, [openMenu, fGroups, fTags, clientSel]);

  // ---- user-set span ------------------------------------------------------

  const commitUserSpan = (lid: string, fromDate: string, throughDate: string, price: number): { set: number; skipped: number } => {
    const hit = idx.listings.get(lid);
    if (!hit) return { set: 0, skipped: 0 };
    let set = 0;
    let skipped = 0;
    let d = fromDate;
    const stagedAdd: Record<string, string> = {};
    const editsAdd: Record<string, number> = {};
    const userAdd: Record<string, UserNightSeed> = {};
    for (let guard = 0; guard < 31; guard++) {
      // Never set a price past the tracked window — a through-span stops at the
      // boundary even if the operator picked a later end date.
      if (!settable(d)) break;
      const n = hit.l.byDate.get(d);
      const paid = hit.l.booked[d];
      const lv = hit.l.live[d];
      if (n && isPending(n)) {
        if (n.cur && price < n.cur * 0.5) skipped++;
        else {
          stagedAdd[n.id] = "edit";
          editsAdd[n.id] = price;
          set++;
        }
      } else if (n && !isPending(n)) {
        skipped++;
      } else if (paid !== undefined) {
        skipped++;
      } else if (lv !== undefined) {
        if (lv && price < lv * 0.5) skipped++;
        else {
          const uid = userNightId(lid, d);
          if (!idx.nights.has(uid) && !userAdd[uid]) userAdd[uid] = { lid, date: d, cur: lv };
          if (!finKey(uid)) {
            stagedAdd[uid] = "edit";
            editsAdd[uid] = price;
            set++;
          } else skipped++;
        }
      } else skipped++;
      if (d === throughDate) break;
      d = addDays(d, 1);
    }
    if (Object.keys(userAdd).length) setUserNights((prev) => ({ ...prev, ...userAdd }));
    if (Object.keys(stagedAdd).length) setStaged((prev) => ({ ...prev, ...stagedAdd }));
    if (Object.keys(editsAdd).length) setEdits((prev) => ({ ...prev, ...editsAdd }));
    return { set, skipped };
  };

  /** Returns an error string (form stays open) or null on success. */
  const submitUserSet = (lid: string, date: string, through: string, rawValue: number): string | null => {
    const hit = idx.listings.get(lid);
    if (!hit) return "Listing not found";
    if (!Number.isFinite(rawValue) || rawValue <= 0) return "Enter a price above £0.";
    const lvHere = hit.l.live[date];
    const nightHere = hit.l.byDate.get(date);
    const basisHere = nightHere?.cur ?? lvHere;
    if (basisHere && rawValue < basisHere * 0.5) {
      return `Under half the current ${money(basisHere, hit.l.currency)} — blocked (fat-finger guard).`;
    }
    const res = commitUserSpan(lid, date, through, Math.round(rawValue));
    if (res.set === 0) return "Nothing set — every night in that range is booked or already decided.";
    const belowNote =
      hit.l.min && rawValue < hit.l.min ? ` · below the ${money(hit.l.min, hit.l.currency)} minimum (your call)` : "";
    closePop();
    showToast(
      `${res.set} night${res.set > 1 ? "s" : ""} set at ${money(Math.round(rawValue), hit.l.currency)}${belowNote}${
        res.skipped ? ` · ${res.skipped} skipped (booked, already decided, or under half the going rate)` : ""
      }`
    );
    return null;
  };

  // ---- drag-select bulk apply --------------------------------------------

  /** Stage EITHER an exact price OR a per-night % drop across a drag-selected
   * span of one listing. Each night is staged the same way single edits are —
   * a pending rec becomes an edit, an open night becomes a user-set — so it all
   * rides the existing Review & Push pipeline. Booked / already-decided /
   * beyond-window nights are skipped, and the ≥50%-of-basis fat-finger bound is
   * enforced per night (a % drop ≥ 50 trips it). For "% off", the basis is each
   * night's OWN current price (the live/rec rate the tile shows). */
  const commitBulkCells = (lid: string, fromDate: string, toDate: string, mode: BulkMode): { set: number; skipped: number } => {
    const hit = idx.listings.get(lid);
    if (!hit) return { set: 0, skipped: 0 };
    const lo = fromDate <= toDate ? fromDate : toDate;
    const hi = fromDate <= toDate ? toDate : fromDate;
    let set = 0;
    let skipped = 0;
    const stagedAdd: Record<string, string> = {};
    const editsAdd: Record<string, number> = {};
    const userAdd: Record<string, UserNightSeed> = {};
    const targetFor = (basis: number): number =>
      mode.kind === "price" ? Math.round(mode.value) : Math.round(basis * (1 - mode.pct / 100));
    let d = lo;
    for (let guard = 0; guard < 32; guard++) {
      // Never stage past the tracked window — the calendar can't follow a price
      // set out there (it could silently double-push).
      if (settable(d)) {
        const n = hit.l.byDate.get(d);
        const paid = hit.l.booked[d];
        const lv = hit.l.live[d];
        if (n && isPending(n)) {
          const price = targetFor(n.cur);
          if (!(price > 0) || (n.cur && price < n.cur * 0.5)) skipped++;
          else {
            stagedAdd[n.id] = "edit";
            editsAdd[n.id] = price;
            set++;
          }
        } else if (n && !isPending(n)) {
          skipped++;
        } else if (paid !== undefined) {
          skipped++;
        } else if (lv !== undefined) {
          const price = targetFor(lv);
          if (!(price > 0) || (lv && price < lv * 0.5)) skipped++;
          else {
            const uid = userNightId(lid, d);
            if (!idx.nights.has(uid) && !userAdd[uid]) userAdd[uid] = { lid, date: d, cur: lv };
            if (!finKey(uid)) {
              stagedAdd[uid] = "edit";
              editsAdd[uid] = price;
              set++;
            } else skipped++;
          }
        } else skipped++;
      }
      if (d === hi) break;
      d = addDays(d, 1);
    }
    if (Object.keys(userAdd).length) setUserNights((prev) => ({ ...prev, ...userAdd }));
    if (Object.keys(stagedAdd).length) setStaged((prev) => ({ ...prev, ...stagedAdd }));
    if (Object.keys(editsAdd).length) setEdits((prev) => ({ ...prev, ...editsAdd }));
    return { set, skipped };
  };

  /** Returns an error string (form stays open) or null on success. */
  const submitBulk = (lid: string, from: string, to: string, mode: BulkMode): string | null => {
    const hit = idx.listings.get(lid);
    if (!hit) return "Listing not found";
    if (mode.kind === "price" && (!Number.isFinite(mode.value) || mode.value <= 0)) return "Enter a price above £0.";
    if (mode.kind === "pct" && (!Number.isFinite(mode.pct) || mode.pct <= 0 || mode.pct >= 50)) {
      return "Enter a drop between 1% and 49% (deeper cuts are blocked as a fat-finger guard).";
    }
    const res = commitBulkCells(lid, from, to, mode);
    if (res.set === 0) return "Nothing set — every night in that span is booked, already decided, or beyond the tracked window.";
    const what = mode.kind === "price" ? `at ${money(Math.round(mode.value), hit.l.currency)}` : `down ${mode.pct}%`;
    closePop();
    showToast(
      `${res.set} night${res.set > 1 ? "s" : ""} set ${what}${res.skipped ? ` · ${res.skipped} skipped (booked, already decided, or out of window)` : ""}`
    );
    return null;
  };

  // ---- drag-select interaction -------------------------------------------

  const beginDrag = (lid: string, date: string, rect: DOMRect) => {
    // Arm a potential drag. The highlight only appears once the pointer moves to
    // another cell (first extendDrag), so a plain click never flashes a span.
    dragStartRef.current = { lid, date };
    dragOverRef.current = { lid, date };
    dragMovedRef.current = false;
    dragRectRef.current = rect;
  };
  const extendDrag = (lid: string, date: string, rect: DOMRect) => {
    const s = dragStartRef.current;
    if (!s || s.lid !== lid) return; // selection stays inside the anchor's row
    dragOverRef.current = { lid, date };
    dragRectRef.current = rect;
    if (date !== s.date) dragMovedRef.current = true;
    setDragSel({ lid, anchor: s.date, over: date });
  };
  const endDrag = useCallback(() => {
    const s = dragStartRef.current;
    const over = dragOverRef.current;
    const moved = dragMovedRef.current;
    dragStartRef.current = null;
    if (!s || !over || !moved) {
      // A plain click (no span) — leave any open popover alone.
      if (moved) setDragSel(null);
      dragMovedRef.current = false;
      return;
    }
    // A real span: swallow the click that follows this mouseup, then open the
    // bulk popover anchored on the last cell entered. The highlight persists
    // until the popover closes (closePop clears it).
    dragConsumeClickRef.current = true;
    const from = s.date <= over.date ? s.date : over.date;
    const to = s.date <= over.date ? over.date : s.date;
    const rect = dragRectRef.current;
    const anchor: PopAnchor = rect
      ? { left: rect.left, top: rect.top, bottom: rect.bottom }
      : { left: 240, top: 240, bottom: 260 };
    setPopErr(null);
    setPop({ kind: "bulk", lid: s.lid, from, to, anchor });
    dragMovedRef.current = false;
  }, []);
  // Catch the release even if it lands outside the grid (dragged off the edge).
  useEffect(() => {
    window.addEventListener("mouseup", endDrag);
    return () => window.removeEventListener("mouseup", endDrag);
  }, [endDrag]);
  const cellSelected = (lid: string, date: string): boolean => {
    if (!dragSel || dragSel.lid !== lid) return false;
    const lo = dragSel.anchor <= dragSel.over ? dragSel.anchor : dragSel.over;
    const hi = dragSel.anchor <= dragSel.over ? dragSel.over : dragSel.anchor;
    return date >= lo && date <= hi;
  };

  // ---- single-night edited price -----------------------------------------

  const commitSingleEdit = (id: string, raw: number) => {
    const ref = idx.nights.get(id);
    if (!ref) return;
    const n = ref.n;
    if (!Number.isFinite(raw) || raw <= 0) {
      setPopErr("Enter a positive number");
      return;
    }
    if (!n.floor && raw < n.cur * 0.5) {
      setPopErr("Floor unknown — under half the live rate is blocked");
      return;
    }
    setEdits((prev) => ({ ...prev, [id]: Math.round(raw) }));
    setStaged((prev) => ({ ...prev, [id]: "edit" }));
    if (n.floor && raw < n.floor) showToast(`Set below the ${money(n.floor, ref.l.currency)} floor — your call`);
    closePop();
  };

  // ---- run edited TOTAL → /api/recs/run-action (immediate, atomic) --------

  const commitRunTotal = async (r: DRun, raw: number) => {
    const hit = idx.runByKey.get(r.key);
    if (!hit) return;
    if (!Number.isFinite(raw) || raw <= 0) {
      setPopErr("Enter a positive number");
      return;
    }
    let anyFloor = false;
    let curSum = 0;
    for (const id of r.ids) {
      const ref = idx.nights.get(id);
      if (!ref) continue;
      curSum += ref.n.cur;
      if (ref.n.floor) anyFloor = true;
    }
    if (!anyFloor && raw < curSum * 0.5) {
      setPopErr("Floors unknown — under half the live total is blocked");
      return;
    }
    setPopErr(null);
    setPopBusy(true);
    try {
      const res = await postJson<RunActionResponse>("/api/recs/run-action", {
        tenantId: hit.cl.id,
        suggestionIds: r.ids,
        action: "approve",
        editedTotal: Math.round(raw)
      });
      let pushedN = 0;
      let mismatchN = 0;
      let failedN = 0;
      for (const result of res.results ?? []) {
        if (result.push && result.push.reason === "verify_mismatch") {
          mismatchN++;
          setFinEntry(result.suggestionId, "mismatch");
        } else if (result.ok && result.push && result.push.result === "success" && result.push.verified === true) {
          pushedN++;
          setFinEntry(result.suggestionId, "pushed");
        } else if (!result.ok) {
          failedN++;
        }
        clearStagedEntry(result.suggestionId);
      }
      const bits = [`${pushedN} pushed ✓`];
      if (mismatchN) bits.push(`${mismatchN} verify mismatch ⚠`);
      if (failedN) bits.push(`${failedN} failed`);
      for (const note of res.distributionNotes ?? []) bits.push(note);
      showToast(bits.join(" · "));
      closePop();
      await loadCalendar(true);
    } catch (error) {
      // The route's 400 (atomic fat-finger refusal) is surfaced verbatim.
      setPopErr(error instanceof Error ? error.message : "Run action failed");
    } finally {
      setPopBusy(false);
    }
  };

  // ---- allow-below-minimum toggle ----------------------------------------

  const toggleBelowMin = async (cl: CalClient) => {
    const next = !cl.allowBelowFloor;
    setData((prev) =>
      prev
        ? { ...prev, clients: prev.clients.map((c) => (c.id === cl.id ? { ...c, allowBelowFloor: next } : c)) }
        : prev
    );
    try {
      await postJson<{ ok: boolean }>("/api/recs/client-settings", { tenantId: cl.id, allowBelowFloor: next });
      showToast(
        next
          ? `Saved — future recommendations for ${cl.name} may go below listing minimums (still sized from landed rates + market data)`
          : `Saved — recommendations for ${cl.name} will not go below listing minimums`
      );
    } catch (error) {
      setData((prev) =>
        prev
          ? { ...prev, clients: prev.clients.map((c) => (c.id === cl.id ? { ...c, allowBelowFloor: !next } : c)) }
          : prev
      );
      showToast(error instanceof Error ? `Could not save — ${error.message}` : "Could not save the setting");
    }
  };

  const clientBelowMinCount = (cl: CalClient): number => {
    let count = 0;
    for (const l of idx.listingsByClient.get(cl.id) ?? []) {
      for (const n of l.nights) {
        if (!isPending(n)) continue;
        const fl = n.floor !== null && n.floor !== undefined ? n.floor : l.min;
        if (!fl) continue;
        const shown = priceOf(n.id, n.kind === "hold" ? n.cur : (n.rec ?? n.cur));
        const isShown = (n.kind === "drop" && !n.sup) || stKey(n.id) === "edit";
        if (isShown && shown < fl) count++;
      }
      for (const id of Object.keys(staged)) {
        if (!id.startsWith(`usr:${l.id}:`)) continue;
        if (finKey(id)) continue;
        const fl2 = l.min;
        if (fl2 && edits[id] !== undefined && edits[id] < fl2) count++;
      }
    }
    return count;
  };

  // ---- basket + Review & Push --------------------------------------------

  const collectEntries = (): ModalEntry[] => {
    const out: ModalEntry[] = [];
    for (const id of Object.keys(staged)) {
      if (id.startsWith("run:")) continue;
      const ref = idx.nights.get(id);
      if (!ref) continue;
      const act = staged[id];
      const price = Math.round(priceOf(id, ref.n.rec ?? ref.n.cur));
      out.push({
        id,
        act,
        isUser: id.startsWith("usr:"),
        sendEdited: act === "edit" || ref.n.kind === "user",
        edited: edits[id] !== undefined,
        price,
        cur: ref.n.cur,
        date: ref.n.date,
        dow: dowOf(ref.n.date),
        kind: ref.n.kind,
        listingId: ref.l.id,
        listingName: ref.l.name,
        clientId: ref.cl.id,
        clientName: ref.cl.name,
        engine: ref.cl.engine,
        currency: ref.cl.currency
      });
    }
    out.sort((a, b) => {
      if (a.clientName !== b.clientName) return a.clientName < b.clientName ? -1 : 1;
      if (a.listingName !== b.listingName) return a.listingName < b.listingName ? -1 : 1;
      return a.date < b.date ? -1 : 1;
    });
    return out;
  };

  const stagedNightIds = Object.keys(staged).filter((id) => !id.startsWith("run:") && idx.nights.has(id));
  const basketPush = stagedNightIds.filter((id) => staged[id] !== "ignore").length;
  const basketIgnore = stagedNightIds.length - basketPush;

  const modalSub = (() => {
    const engines: Record<string, true> = {};
    for (const x of modalEntries) if (x.act !== "ignore") engines[engineLabel(x.engine)] = true;
    const names = Object.keys(engines);
    return `Pushes go to the pricing engine (${names.length ? names.join(" + ") : "the engine"}) — never Hostaway.`;
  })();

  const openReviewModal = () => {
    const entries = collectEntries();
    if (!entries.length) return;
    setModalEntries(entries);
    setRowMarks({});
    setSummary(null);
    setProgress(0);
    setStopRequested(false);
    stopRef.current = false;
    setPushing(false);
    setModalOpen(true);
  };

  const removeModalRow = (id: string) => {
    if (pushing) return;
    setModalEntries((prev) => prev.filter((x) => x.id !== id));
    clearStagedEntry(id);
  };

  const handleModalCancel = () => {
    if (pushing) {
      stopRef.current = true;
      setStopRequested(true);
      return;
    }
    setModalOpen(false);
  };

  const runPushQueue = async () => {
    const entries = modalEntries;
    if (!entries.length) return;
    setPushing(true);
    setStopRequested(false);
    stopRef.current = false;
    setSummary(null);
    setProgress(0);
    let pushed = 0;
    let ignoredN = 0;
    let mismatches = 0;
    let failedN = 0;
    let skippedN = 0;
    let recorded = 0;
    let stopped = false;
    const total = entries.length;
    for (let i = 0; i < total; i++) {
      if (stopRef.current) {
        stopped = true;
        break;
      }
      const x = entries[i];
      const mark = (label: string, cls: RowMark["cls"]) => setRowMarks((prev) => ({ ...prev, [x.id]: { label, cls } }));
      try {
        if (x.act === "ignore") {
          const res = await postJson<ActionResultShape>("/api/recs/action", {
            tenantId: x.clientId,
            suggestionId: x.id,
            action: "reject"
          });
          if (res.ok) {
            ignoredN++;
            setFinEntry(x.id, "ignored");
            mark("ignored", "run");
          } else {
            failedN++;
            mark(res.error ?? "failed", "fail");
          }
        } else {
          let suggestionId = x.id;
          if (x.isUser) {
            // Synthetic operator-set night: create the real suggestion first,
            // then approve it at the typed price (normal push pipeline).
            const created = await postJson<UserSetResponse>("/api/recs/user-set", {
              tenantId: x.clientId,
              listingId: x.listingId,
              date: x.date,
              price: x.price
            });
            suggestionId = created.suggestionId;
          }
          const res = await postJson<ActionResultShape>("/api/recs/action", {
            tenantId: x.clientId,
            suggestionId,
            action: "approve",
            ...(x.sendEdited ? { editedPrice: x.price } : {})
          });
          if (res.push && res.push.reason === "verify_mismatch") {
            mismatches++;
            setFinEntry(x.id, "mismatch");
            if (suggestionId !== x.id) setFinEntry(suggestionId, "mismatch");
            mark("mismatch ⚠", "warn");
          } else if (res.ok && res.push && res.push.result === "success" && res.push.verified === true) {
            pushed++;
            setFinEntry(x.id, "pushed");
            setFinPriceEntry(x.id, x.price);
            if (suggestionId !== x.id) {
              setFinEntry(suggestionId, "pushed");
              setFinPriceEntry(suggestionId, x.price);
            }
            mark("pushed ✓ verified", "ok");
          } else if (res.push && res.push.result === "skipped") {
            skippedN++;
            mark(
              res.push.reason === "no_push_engine"
                ? "approved — no push engine"
                : `skipped — ${(res.push.reason ?? "not pushed").replace(/_/g, " ")}`,
              "run"
            );
          } else if (res.ok && !res.push) {
            recorded++;
            mark("recorded ✓ (no price change)", "ok");
          } else {
            failedN++;
            mark(res.error ?? "failed", "fail");
          }
        }
      } catch (error) {
        failedN++;
        mark(error instanceof Error ? error.message : "failed", "fail");
      }
      clearStagedEntry(x.id);
      setProgress(Math.round(((i + 1) / total) * 100));
      // Pace the run so a long push does not burst the engine into a rate
      // limit (PriceLabs 429'd Escape Ordinary at ~20 nights — each night is
      // several engine calls). A short gap between nights keeps a big run under
      // the limit; the whole run still completes, just steadily.
      if (i < total - 1 && !stopRef.current) await sleep(PUSH_PACE_MS);
    }
    const bits = [`${pushed} pushed ✓`, `${ignoredN} ignored`];
    if (recorded) bits.push(`${recorded} recorded`);
    if (skippedN) bits.push(`${skippedN} skipped`);
    if (mismatches) bits.push(`${mismatches} verify mismatch ⚠ (left for review)`);
    if (failedN) bits.push(`${failedN} failed`);
    if (stopped) bits.push("stopped early");
    setSummary(bits.join(" · "));
    setPushing(false);
    // Reconcile against the server — its statuses win; the summary stays up.
    await loadCalendar(true);
  };

  // Re-push an APPROVED-but-not-live night (a skipped, rate-limited, or
  // verify-mismatched push). A single immediate /api/recs/action "retry" — not
  // a staged basket item — so the operator can clear a stuck night on the spot.
  const [retrying, setRetrying] = useState<string | null>(null);
  const retryNight = async (tenantId: string, suggestionId: string) => {
    setRetrying(suggestionId);
    try {
      const res = await postJson<ActionResultShape>("/api/recs/action", {
        tenantId,
        suggestionId,
        action: "retry"
      });
      if (res.push && res.push.reason === "verify_mismatch") {
        setFinEntry(suggestionId, "mismatch");
        showToast("Pushed, but the engine read back a different price — left for review.");
      } else if (res.ok && res.push && res.push.result === "success" && res.push.verified === true) {
        setFinEntry(suggestionId, "pushed");
        showToast("Pushed ✓ verified.");
      } else if (res.push && res.push.result === "skipped") {
        showToast(`Still not pushed — ${(res.push.reason ?? "skipped").replace(/_/g, " ")}.`);
      } else {
        showToast(res.error ?? "Push failed — try again.");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Push failed.");
    } finally {
      setRetrying(null);
      closePop();
      await loadCalendar(true);
    }
  };

  // Manual "Refresh recs" — regenerate the selected client scope (the client
  // dropdown IS the "All / one client" selector, Mark 2026-07-22) on demand,
  // then reload. Each client is its own request so the batch never trips one
  // request's timeout; a fresh generation supersedes stale pending rows and
  // re-evaluates every night against today's data.
  const [refreshing, setRefreshing] = useState(false);
  const refreshRecs = async () => {
    if (refreshing) return;
    const targets =
      clientSel === "all" ? (data?.clients ?? []).map((c) => c.id) : [clientSel];
    if (targets.length === 0) return;
    setRefreshing(true);
    let ok = 0;
    let failed = 0;
    for (const tid of targets) {
      if (targets.length > 1) showToast(`Refreshing ${ok + failed + 1}/${targets.length}…`);
      // Bound each regenerate so one hung client can't wedge the button or stall
      // the rest of an "all clients" batch.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      try {
        const res = await fetch(withBasePath("/api/recs/regenerate"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId: tid }),
          signal: controller.signal
        });
        if (res.ok) ok += 1;
        else failed += 1;
      } catch {
        failed += 1;
      } finally {
        clearTimeout(timer);
      }
    }
    await loadCalendar(true);
    setRefreshing(false);
    showToast(`Refreshed ${ok} client${ok === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`);
  };

  // Re-price an already-pushed night (daily recs — drop it again today). Goes
  // straight through user-set → approve → push, so it supersedes yesterday's
  // override immediately (no staging limbo, where the applied row would shadow
  // a fresh pending one). The reload then surfaces the newest push.
  const [repricing, setRepricing] = useState(false);
  const pushNewPrice = async (tenantId: string, listingId: string, date: string, price: number) => {
    setRepricing(true);
    try {
      const created = await postJson<UserSetResponse>("/api/recs/user-set", {
        tenantId,
        listingId,
        date,
        price
      });
      const res = await postJson<ActionResultShape>("/api/recs/action", {
        tenantId,
        suggestionId: created.suggestionId,
        action: "approve",
        editedPrice: price
      });
      if (res.push && res.push.reason === "verify_mismatch") {
        showToast("Pushed, but the engine read back a different price — left for review.");
      } else if (res.ok && res.push && res.push.result === "success" && res.push.verified === true) {
        showToast("New price pushed ✓ verified.");
      } else if (res.push && res.push.result === "skipped") {
        showToast(`Not pushed — ${(res.push.reason ?? "skipped").replace(/_/g, " ")}.`);
      } else {
        showToast(res.error ?? "Push failed — try again.");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Push failed.");
    } finally {
      setRepricing(false);
      closePop();
      await loadCalendar(true);
    }
  };

  const clearBasket = () => {
    if (clearArmed) {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      setClearArmed(false);
      setStaged({});
      setEdits({});
      return;
    }
    setClearArmed(true);
    clearTimer.current = setTimeout(() => setClearArmed(false), 3000);
  };

  // ---- filters + visibility ----------------------------------------------

  const activeClients: CalClient[] = data
    ? clientSel === "all"
      ? data.clients
      : data.clients.filter((c) => c.id === clientSel)
    : [];

  const allGroups = (() => {
    const out: Record<string, true> = {};
    for (const c of activeClients)
      for (const l of c.listings) for (const t of l.tags ?? []) if (/^group:/i.test(t)) out[t] = true;
    return Object.keys(out).sort();
  })();
  const allTags = (() => {
    const out: Record<string, true> = {};
    for (const c of activeClients)
      for (const l of c.listings) for (const t of l.tags ?? []) if (!/^group:/i.test(t)) out[t] = true;
    return Object.keys(out).sort();
  })();
  const gSel = allGroups.filter((g) => fGroups[g]);
  const tSel = allTags.filter((t) => fTags[t]);

  const listingVisible = (l: DListing): boolean => {
    if (search && !l.name.toLowerCase().includes(search)) return false;
    const tags = l.tags ?? [];
    if (gSel.length && !gSel.some((g) => tags.includes(g))) return false;
    if (tSel.length && !tSel.some((t) => tags.includes(t))) return false;
    if (needsOnly && listingPending(l) === 0) return false;
    return true;
  };

  const groups = activeClients
    .map((cl) => ({ cl, ls: (idx.listingsByClient.get(cl.id) ?? []).filter(listingVisible) }))
    .filter((g) => g.ls.length > 0);
  const multi = groups.length > 1;

  let pendCount = 0;
  let doneCount = 0;
  let hiddenCount = 0;
  for (const cl of activeClients) {
    for (const l of idx.listingsByClient.get(cl.id) ?? []) {
      if (!listingVisible(l)) hiddenCount++;
      for (const n of l.nights) {
        if (!isDropRec(n)) continue;
        if (isPending(n) && !stKey(n.id)) pendCount++;
        else doneCount++;
      }
    }
  }
  const who = clientSel === "all" ? "All clients" : activeClients.map((c) => c.name).join(" + ");
  const visClients = activeClients.filter((c) => (idx.listingsByClient.get(c.id) ?? []).some(listingVisible));

  // ---- api bundle for subcomponents --------------------------------------

  const api: CalApi = {
    today,
    days,
    stKey,
    finKey,
    priceOf,
    finPriceOf,
    isPending,
    runOfNight: idx.runOfNight,
    runAllStaged,
    runShownTotal,
    stageNight,
    editFromActs,
    stageRun,
    openNightPop,
    openUserPop,
    openRunPop,
    userNightFor: (lid: string, date: string) => {
      const uid = userNightId(lid, date);
      const ref = idx.nights.get(uid);
      if (!ref) return null;
      if (!stKey(uid) && !finKey(uid)) return null;
      return { id: uid, n: ref.n };
    },
    listingPending,
    settable,
    hasOverride: (listingId: string, date: string) => (overrideDates[listingId] ?? []).includes(date),
    beginDrag,
    extendDrag,
    cellSelected
  };

  // ---- popover content ----------------------------------------------------

  const renderPopContent = (): React.ReactNode => {
    if (!pop) return null;
    if (pop.kind === "bulk") {
      const hit = idx.listings.get(pop.lid);
      if (!hit) return null;
      const span =
        Math.round((new Date(`${pop.to}T00:00:00Z`).getTime() - new Date(`${pop.from}T00:00:00Z`).getTime()) / 864e5) + 1;
      return (
        <>
          <button type="button" className="rcal-close" aria-label="Close" onClick={closePop}>
            ×
          </button>
          <h5>
            {shortListingName(hit.l.name)} · {fmtD(pop.from)}–{fmtD(pop.to)} ({span} night{span > 1 ? "s" : ""})
          </h5>
          <div className="rcal-why">
            Apply one change to every open or recommended night in this span — an exact price, or a % off each
            night&apos;s own current price. Booked and already-decided nights are skipped. It all joins the basket for
            Review &amp; Push.
          </div>
          <BulkSetForm lid={pop.lid} from={pop.from} to={pop.to} currency={hit.l.currency} onSubmit={submitBulk} />
        </>
      );
    }
    if (pop.kind === "user") {
      const hit = idx.listings.get(pop.lid);
      if (!hit) return null;
      const lv = hit.l.live[pop.date];
      const far = pop.date > addDays(today, 13);
      return (
        <>
          <button type="button" className="rcal-close" aria-label="Close" onClick={closePop}>
            ×
          </button>
          <h5>
            {fmtD(pop.date)} {dowOf(pop.date)}
            {lv !== undefined ? ` · open at ${money(lv, hit.l.currency)}` : ""}
          </h5>
          <div className="rcal-why">
            {far
              ? "No recommendation for this night — recommendations generate 14 days out. Set your own price and it joins the basket like any other decision."
              : "The engine has no recommendation for this night. Set your own price and it joins the basket like any other decision."}
          </div>
          <UserSetForm
            lid={pop.lid}
            date={pop.date}
            lead={null}
            initial={lv !== undefined ? lv : (hit.l.base ?? 100)}
            days={settableRange}
            onSubmit={submitUserSet}
          />
        </>
      );
    }
    if (pop.kind === "run") {
      const hit = idx.runByKey.get(pop.runKey);
      if (!hit) return null;
      const r = hit.r;
      const on = runAllStaged(r);
      const editing = popRunEditing || edits[r.key] !== undefined;
      return (
        <>
          <button type="button" className="rcal-close" aria-label="Close" onClick={closePop}>
            ×
          </button>
          <h5>
            {fmtD(r.from)}–{fmtD(r.to)} · {r.n} nights · {money(r.totCur, hit.l.currency)} →{" "}
            {money(runShownTotal(r), hit.l.currency)}
          </h5>
          <div className="rcal-why">{r.why.join(" · ")}</div>
          <div className="rcal-nights">
            {r.ids.map((id) => {
              const ref = idx.nights.get(id);
              if (!ref) return null;
              return (
                <div key={id}>
                  <span>
                    {fmtD(ref.n.date)} {dowOf(ref.n.date)}
                  </span>
                  <span>
                    {money(ref.n.cur, hit.l.currency)} → {money(priceOf(id, ref.n.rec ?? ref.n.cur), hit.l.currency)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="rcal-btns">
            <button
              type="button"
              className="rcal-b-app"
              data-on={on ? "" : undefined}
              onClick={() => {
                stageRun(r, !on);
                closePop();
              }}
            >
              {on ? "Unselect all" : `Approve all ${r.n}`}
            </button>
            <button type="button" className="rcal-b-edit" onClick={() => setPopRunEditing(true)}>
              Edit total
            </button>
          </div>
          {editing ? (
            <>
              <div className="rcal-why" style={{ fontSize: 10 }}>
                A typed total pushes immediately — distributed across the {r.n} nights server-side; a mistyped figure is
                refused before anything is approved.
              </div>
              <div className="rcal-editrow">
                <input
                  type="number"
                  inputMode="decimal"
                  defaultValue={priceOf(r.key, r.totRec)}
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !popBusy) {
                      void commitRunTotal(r, Number(event.currentTarget.value));
                    }
                  }}
                  id="rcal-run-total"
                  aria-label="Edited run total"
                />
                <button
                  type="button"
                  className="rcal-ok"
                  disabled={popBusy}
                  onClick={(event) => {
                    const input = (event.currentTarget.parentElement?.querySelector("input") ?? null) as HTMLInputElement | null;
                    if (input) void commitRunTotal(r, Number(input.value));
                  }}
                >
                  {popBusy ? "Pushing…" : "Set & push"}
                </button>
              </div>
              <div className="rcal-err">{popErr}</div>
            </>
          ) : null}
        </>
      );
    }
    const ref = idx.nights.get(pop.id);
    if (!ref) return null;
    const n = ref.n;
    const l = ref.l;
    const ms = l.minStay[n.date];
    const st = stKey(n.id);
    const finState = finKey(n.id);
    const editingNight = st === "edit" || edits[n.id] !== undefined;
    return (
      <>
        <button type="button" className="rcal-close" aria-label="Close" onClick={closePop}>
          ×
        </button>
        <h5>
          {fmtD(n.date)} {dowOf(n.date)} · live {money(n.cur, l.currency)}
          {n.kind === "hold" ? " · hold" : ` → ${money(priceOf(n.id, n.rec ?? n.cur), l.currency)}`}
          {ms !== undefined && ms > 0 ? ` · min stay ${ms}n` : ""}
        </h5>
        <div className="rcal-why">{n.why || ""}</div>
        {ms !== undefined && ms > 2 && n.kind === "drop" ? (
          <div className="rcal-why" style={{ color: "var(--rcal-warn)" }}>
            ⚠ {ms}-night minimum stay — a price drop may not unlock this night on its own.
          </div>
        ) : null}
        {n.comp && n.comp.length ? (
          <ul>
            {n.comp.slice(0, 3).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : null}
        {n.whyFull && n.whyFull !== n.why ? (
          <details className="rcal-full">
            <summary>full detail</summary>
            <div className="rcal-why">{n.whyFull}</div>
          </details>
        ) : null}
        {n.ov && n.ov.verdict === "flag" ? (
          <div className="rcal-why" style={{ color: "var(--rcal-edited)" }}>
            ⚑ Claude: {n.ov.reason || "flagged"}
          </div>
        ) : null}
        {n.floor ? <div className="rcal-floor">floor {money(n.floor, l.currency)}</div> : null}
        {finState === "mismatch" ? (
          <div className="rcal-floor" style={{ color: "var(--rcal-warn)" }}>
            ⚠ push verify mismatch — the engine accepted the update but read back a different price. Nothing was changed
            blindly; this night is left for review. Signals retries hourly.
          </div>
        ) : null}
        {finState === "recorded" ? (
          <div className="rcal-why">
            Approved but not pushed live (the last attempt was skipped or rate-limited). Push it now to send it to the
            engine.
          </div>
        ) : null}
        {finState === "mismatch" || finState === "recorded" ? (
          <div className="rcal-btns">
            <button
              type="button"
              className="rcal-b-app"
              disabled={retrying === n.id}
              onClick={() => void retryNight(l.clientId, n.id)}
            >
              {retrying === n.id ? "Pushing…" : "Push now"}
            </button>
          </div>
        ) : null}
        {finState === "pushed" ? (
          <>
            <div className="rcal-why">
              {pushedLabel(n.actionedAt)} at {money(finPriceOf(n.id) ?? priceOf(n.id, n.rec ?? n.cur), l.currency)}. Set a
              new price to drop it again (replaces the current override for this night).
            </div>
            <div className="rcal-editrow">
              <input
                type="number"
                inputMode="decimal"
                defaultValue={Math.round(finPriceOf(n.id) ?? priceOf(n.id, n.rec ?? n.cur))}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !repricing) {
                    void pushNewPrice(l.clientId, l.id, n.date, Number(event.currentTarget.value));
                  }
                }}
                aria-label="New price"
              />
              <button
                type="button"
                className="rcal-ok"
                disabled={repricing}
                onClick={(event) => {
                  const input = (event.currentTarget.parentElement?.querySelector("input") ?? null) as HTMLInputElement | null;
                  if (input) void pushNewPrice(l.clientId, l.id, n.date, Number(input.value));
                }}
              >
                {repricing ? "Pushing…" : "Push new price"}
              </button>
            </div>
          </>
        ) : null}
        {finState === "ignored" ? (
          <div className="rcal-why">
            Ignored — the live rate stays. The rejection is recorded in decision memory and this night resurfaces in a later
            generation.
          </div>
        ) : isPending(n) && n.kind === "user" ? (
          <>
            <UserSetForm
              lid={l.id}
              date={n.date}
              lead="You set this price — change it or take it out:"
              initial={priceOf(n.id, n.rec ?? n.cur)}
              days={settableRange}
              onSubmit={submitUserSet}
            />
            <div className="rcal-btns">
              <button
                type="button"
                className="rcal-b-ign"
                onClick={() => {
                  clearStagedEntry(n.id);
                  closePop();
                }}
              >
                Remove from basket
              </button>
            </div>
          </>
        ) : isPending(n) && n.kind === "hold" ? (
          <>
            <UserSetForm
              lid={l.id}
              date={n.date}
              lead={
                st === "edit"
                  ? "You set this price — change it or take it out:"
                  : "Holding is the plan — but you can set your own price:"
              }
              initial={priceOf(n.id, n.cur)}
              days={settableRange}
              onSubmit={submitUserSet}
            />
            {st === "edit" ? (
              <div className="rcal-btns">
                <button
                  type="button"
                  className="rcal-b-ign"
                  onClick={() => {
                    clearStagedEntry(n.id);
                    closePop();
                  }}
                >
                  Remove from basket
                </button>
              </div>
            ) : null}
          </>
        ) : isPending(n) && isDropRec(n) ? (
          <>
            <div className="rcal-btns">
              <button
                type="button"
                className="rcal-b-app"
                data-on={st === "approve" ? "" : undefined}
                onClick={() => {
                  stageNight(n.id, "approve");
                  closePop();
                }}
              >
                Approve
              </button>
              <button
                type="button"
                className="rcal-b-edit"
                data-on={st === "edit" ? "" : undefined}
                onClick={() => setStaged((prev) => ({ ...prev, [n.id]: "edit" }))}
              >
                Edit
              </button>
              <button
                type="button"
                className="rcal-b-ign"
                data-on={st === "ignore" ? "" : undefined}
                onClick={() => {
                  stageNight(n.id, "ignore");
                  closePop();
                }}
              >
                Ignore
              </button>
            </div>
            {editingNight ? (
              <>
                <div className="rcal-editrow">
                  <input
                    type="number"
                    inputMode="decimal"
                    defaultValue={priceOf(n.id, n.rec ?? n.cur)}
                    autoFocus
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitSingleEdit(n.id, Number(event.currentTarget.value));
                    }}
                    aria-label="Edited price"
                  />
                  <button
                    type="button"
                    className="rcal-ok"
                    onClick={(event) => {
                      const input = (event.currentTarget.parentElement?.querySelector("input") ?? null) as HTMLInputElement | null;
                      if (input) commitSingleEdit(n.id, Number(input.value));
                    }}
                  >
                    Set
                  </button>
                </div>
                <div className="rcal-err">{popErr}</div>
              </>
            ) : null}
          </>
        ) : null}
      </>
    );
  };

  // ---- render -------------------------------------------------------------

  const ds = days;

  return (
    <main className="app-shell relative min-h-screen">
      <div className="rcal" data-view={view} onMouseOver={(event) => {
        if (typeof window !== "undefined" && window.matchMedia("(hover: none)").matches) return;
        const el = (event.target as HTMLElement).closest("[data-tip]");
        if (!el) {
          setTip(null);
          return;
        }
        const r = el.getBoundingClientRect();
        setTip({
          text: el.getAttribute("data-tip") ?? "",
          left: Math.min(r.left, window.innerWidth - 310),
          top: r.bottom + 4
        });
      }} onMouseOut={() => setTip(null)}>
        <div className="rcal-wrap">
          <Link href="/dashboard/recommendations" className="rcal-sub" style={{ display: "inline-block", marginBottom: 4 }}>
            ← Recommendations
          </Link>
          <h1 className="rcal-h1">Pricing Recommendations</h1>
          <div className="rcal-sub">
            Master calendar{data ? <> · {data.clients.length} clients · today <b>{fmtD(today)}</b></> : null}
          </div>

          {loadError ? (
            <div className="rcal-counts" style={{ color: "var(--rcal-neg)" }}>
              {loadError}{" "}
              <button type="button" className="rcal-chip" onClick={() => void loadCalendar(false)}>
                Retry
              </button>
            </div>
          ) : null}
          {loading && !data ? <div className="rcal-counts">Loading calendar…</div> : null}

          {data ? (
            <>
              <div className="rcal-bar" role="toolbar" aria-label="Clients">
                <button
                  type="button"
                  className="rcal-chip"
                  data-on={clientSel === "all" ? "" : undefined}
                  onClick={() => setClientSel("all")}
                >
                  All clients
                </button>
                <select
                  className="rcal-csel"
                  aria-label="Pick one client"
                  data-on={clientSel !== "all" ? "" : undefined}
                  value={clientSel === "all" ? "" : clientSel}
                  onChange={(event) => setClientSel(event.target.value || "all")}
                >
                  <option value="">One client…</option>
                  {data.clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {shortClientName(c.name)}
                    </option>
                  ))}
                </select>
                <span className="rcal-gap" />
                <span className="rcal-seg" role="group" aria-label="Range">
                  {[7, 14, 30].map((r) => (
                    <button
                      key={r}
                      type="button"
                      data-on={!customOn && range === r ? "" : undefined}
                      onClick={() => {
                        setCustomOn(false);
                        setRange(r);
                      }}
                    >
                      {r}d
                    </button>
                  ))}
                  <button
                    type="button"
                    data-on={customOn ? "" : undefined}
                    onClick={() => {
                      setCustomShown(true);
                      setTimeout(() => {
                        customRef.current?.focus();
                        customRef.current?.select();
                      }, 0);
                    }}
                  >
                    Custom
                  </button>
                  {customShown ? (
                    <input
                      ref={customRef}
                      className="rcal-custom-days"
                      type="number"
                      min={2}
                      max={30}
                      value={customVal}
                      aria-label="Custom days"
                      onChange={(event) => setCustomVal(event.target.value)}
                      onBlur={() => {
                        const v = Math.max(2, Math.min(30, Number(customVal) || 14));
                        setCustomVal(String(v));
                        setCustomOn(true);
                        setRange(v);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                  ) : null}
                </span>
              </div>

              <div className="rcal-bar">
                <span className="rcal-seg" role="group" aria-label="View">
                  <button type="button" data-on={view === "grid" ? "" : undefined} onClick={() => setView("grid")}>
                    Grid
                  </button>
                  <button type="button" data-on={view === "agenda" ? "" : undefined} onClick={() => setView("agenda")}>
                    Agenda
                  </button>
                </span>
                <button
                  type="button"
                  className="rcal-pill"
                  data-on={needsOnly ? "" : undefined}
                  onClick={() => setNeedsOnly((v) => !v)}
                >
                  Needs action only
                </button>
                <button
                  type="button"
                  className="rcal-pill"
                  disabled={refreshing}
                  title="Regenerate recommendations for the selected client(s) and reload"
                  onClick={() => void refreshRecs()}
                >
                  {refreshing
                    ? "Refreshing…"
                    : clientSel === "all"
                      ? "↻ Refresh all"
                      : "↻ Refresh recs"}
                </button>
                <input
                  className="rcal-search"
                  type="search"
                  placeholder="Search listings…"
                  aria-label="Search listings"
                  value={search}
                  onChange={(event) => setSearch(event.target.value.trim().toLowerCase())}
                />
                <details
                  className="rcal-fdrop"
                  open={openMenu === "groups"}
                  data-active={allGroups.some((g) => fGroups[g]) ? "" : undefined}
                >
                  <summary
                    className="rcal-pill"
                    ref={groupsSumRef}
                    onClick={(event) => {
                      event.preventDefault();
                      setOpenMenu((cur) => (cur === "groups" ? null : "groups"));
                    }}
                  >
                    Signals Groups
                  </summary>
                  {openMenu === "groups" ? (
                    <div className="rcal-fmenu" ref={menuRef}>
                      {allGroups.length ? (
                        allGroups.map((g) => (
                          <label key={g}>
                            <input
                              type="checkbox"
                              checked={Boolean(fGroups[g])}
                              onChange={(event) => setFGroups((prev) => ({ ...prev, [g]: event.target.checked }))}
                            />
                            {g.replace(/^group:/i, "")}
                          </label>
                        ))
                      ) : (
                        <div className="rcal-fempty">No Signals groups on these listings</div>
                      )}
                    </div>
                  ) : null}
                </details>
                <details
                  className="rcal-fdrop"
                  open={openMenu === "tags"}
                  data-active={allTags.some((t) => fTags[t]) ? "" : undefined}
                >
                  <summary
                    className="rcal-pill"
                    ref={tagsSumRef}
                    onClick={(event) => {
                      event.preventDefault();
                      setOpenMenu((cur) => (cur === "tags" ? null : "tags"));
                    }}
                  >
                    Hostaway Tags
                  </summary>
                  {openMenu === "tags" ? (
                    <div className="rcal-fmenu" ref={menuRef}>
                      {allTags.length ? (
                        allTags.map((t) => (
                          <label key={t}>
                            <input
                              type="checkbox"
                              checked={Boolean(fTags[t])}
                              onChange={(event) => setFTags((prev) => ({ ...prev, [t]: event.target.checked }))}
                            />
                            {t}
                          </label>
                        ))
                      ) : (
                        <div className="rcal-fempty">No Hostaway tags on these listings</div>
                      )}
                    </div>
                  ) : null}
                </details>
              </div>

              <div className="rcal-counts">
                <b>{who}</b> — <b>{pendCount}</b> drops need review · <b>{doneCount}</b> done · holds are automatic
                {hiddenCount ? ` · ${hiddenCount} listing(s) filtered out` : ""}
                {range > 14 ? " · recommendations generate 14 days out — later dates are context only" : ""}
                {visClients.length === 1 ? (
                  <>
                    {" "}
                    <BminBtn cl={visClients[0]} count={clientBelowMinCount(visClients[0])} onToggle={(cl) => void toggleBelowMin(cl)} />
                  </>
                ) : null}
              </div>

              <details className="rcal-legend">
                <summary>Legend</summary>
                <div className="rcal-items">
                  <span>
                    <b className="rcal-sw" style={{ background: "var(--rcal-avail-soft)", border: "1px solid rgba(46,125,84,.4)" }} />
                    live rate — available night
                  </span>
                  <span>
                    <b
                      className="rcal-sw"
                      style={{ background: "rgba(176,122,36,.15)", border: "1px solid var(--rcal-drop)", borderRadius: 8 }}
                    />
                    ↘ recommended drop
                  </span>
                  <span>
                    <b className="rcal-sw" style={{ background: "var(--rcal-booked-bg)" }} />
                    booked — what it earned
                  </span>
                  <span>
                    <b className="rcal-sw" style={{ border: "1.5px dashed var(--rcal-staged)" }} />
                    staged — will push
                  </span>
                  <span>
                    <b
                      className="rcal-sw"
                      style={{ background: "var(--rcal-neg)", borderRadius: "50%", width: 9, height: 9 }}
                    />
                    existing override — approving replaces it
                  </span>
                  <span>
                    <b className="rcal-sw" style={{ background: "#2b6cb0", borderRadius: "50%", width: 9, height: 9 }} />
                    prior decision — hover for what/when
                  </span>
                  <span>
                    <b
                      className="rcal-sw"
                      style={{ background: "var(--rcal-staged)", borderRadius: "50%", width: 9, height: 9 }}
                    />
                    booked after a pushed rec
                  </span>
                  <span style={{ color: "var(--rcal-muted)" }}>·2n = min stay</span>
                </div>
              </details>

              <div className="rcal-board">
                <div
                  className="rcal-grid"
                  style={{ "--rcal-days": String(ds.length) } as React.CSSProperties}
                  // Drag-select click plumbing (handled once, at the grid): a
                  // new gesture clears any stale "swallow" flag; the click that
                  // trails a real drag is swallowed so it doesn't also open a
                  // night popover. A cross-cell drag's click targets the row, so
                  // catching it here (an ancestor of every cell) is reliable.
                  onMouseDownCapture={() => {
                    dragConsumeClickRef.current = false;
                  }}
                  onClickCapture={(event) => {
                    if (dragConsumeClickRef.current) {
                      dragConsumeClickRef.current = false;
                      event.stopPropagation();
                      event.preventDefault();
                    }
                  }}
                >
                  <div className="rcal-hdr">
                    <div className="rcal-hcell rcal-corner" />
                    <div className="rcal-hcell rcal-vhead rcal-vmin">Min</div>
                    <div className="rcal-hcell rcal-vhead rcal-vbase">Base</div>
                    {ds.map((d, i) => {
                      const wk = dowOf(d) === "Fri" || dowOf(d) === "Sat";
                      return (
                        <div key={d} className={`rcal-hcell${wk ? " rcal-wkndcol" : ""}${d === today ? " rcal-todaycol" : ""}`}>
                          {i === 0 || d.slice(8) === "01" ? <span className="rcal-mon">{monthOf(d)}</span> : null}
                          {dowOf(d)}
                          <small>{d.slice(8).replace(/^0/, "")}</small>
                        </div>
                      );
                    })}
                  </div>
                  {groups.map((g) => (
                    <Fragment key={g.cl.id}>
                      {multi ? (
                        <div className="rcal-cdivider">
                          <span className="rcal-pin">
                            {g.cl.name}
                            <small>
                              {g.cl.engine} · {g.ls.length} listings
                            </small>
                            <BminBtn cl={g.cl} count={clientBelowMinCount(g.cl)} onToggle={(cl) => void toggleBelowMin(cl)} />
                          </span>
                        </div>
                      ) : null}
                      {g.ls.map((l) => (
                        <div className="rcal-lrow" key={l.id}>
                          <div className="rcal-lname">
                            {shortListingName(l.name)}
                            {l.snoozedUntil ? <small>ignored 30d</small> : null}
                          </div>
                          <div className="rcal-lmin">{l.min ? money(l.min, l.currency) : "—"}</div>
                          <div className="rcal-lbase">{l.base ? money(l.base, l.currency) : "—"}</div>
                          {ds.map((d) => (
                            <NightTile key={d} l={l} d={d} ds={ds} api={api} />
                          ))}
                        </div>
                      ))}
                    </Fragment>
                  ))}
                </div>
              </div>

              <div className="rcal-agenda">
                {groups.map((g) => (
                  <Fragment key={g.cl.id}>
                    {multi ? (
                      <div className="rcal-adivider">
                        {g.cl.name}
                        <small>{g.cl.engine}</small>
                        <BminBtn cl={g.cl} count={clientBelowMinCount(g.cl)} onToggle={(cl) => void toggleBelowMin(cl)} />
                      </div>
                    ) : null}
                    {g.ls.map((l) => (
                      <AgendaCard key={l.id} l={l} api={api} />
                    ))}
                  </Fragment>
                ))}
              </div>
            </>
          ) : null}
        </div>

        {tip ? (
          <div className="rcal-tipmini" style={{ left: tip.left, top: tip.top }}>
            {tip.text}
          </div>
        ) : null}

        {pop ? (
          <div className="rcal-pop" ref={popRef} role="dialog" aria-modal="false">
            {renderPopContent()}
          </div>
        ) : null}

        {stagedNightIds.length > 0 ? (
          <div className="rcal-basket">
            <div className="rcal-basket-in">
              <div className="rcal-basket-top">
                <span>
                  <b>{stagedNightIds.length}</b> nights — <b>{basketPush}</b> to push · <b>{basketIgnore}</b> to ignore
                </span>
                <button type="button" className="rcal-clear" onClick={clearBasket}>
                  {clearArmed ? "tap again to clear" : "clear all"}
                </button>
              </div>
              <button type="button" className="rcal-go" onClick={openReviewModal}>
                Review &amp; Push ({stagedNightIds.length})
              </button>
            </div>
          </div>
        ) : null}

        {modalOpen ? (
          <PushModal
            entries={modalEntries}
            rowMarks={rowMarks}
            pushing={pushing}
            stopRequested={stopRequested}
            progressVisible={pushing || summary !== null}
            progress={progress}
            summary={summary}
            subText={modalSub}
            confirmVisible={!pushing && summary === null}
            onRemove={removeModalRow}
            onCancel={handleModalCancel}
            onConfirm={() => void runPushQueue()}
          />
        ) : null}

        {toast ? <div className="rcal-toast">{toast}</div> : null}
      </div>
    </main>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";

import { withBasePath } from "@/lib/base-path";
import type { RecsClientViewResult, RecsListingView, RecsNightView } from "@/lib/recs/data";
import type { RecsRunView } from "@/lib/recs/runs";

import { formatDateShort, formatDateTime, formatMoney, formatPct, formatRanking } from "./format";

type ActionResultShape = {
  ok: boolean;
  status: string;
  error?: string | null;
  push?: { result: string; verified: boolean | null; reason?: string | null } | null;
};

type BulkOutcome = { ok: boolean; status: string; error?: string | null };

type ExplainState = { loading: boolean; narrative: string | null; error: string | null };

const CHIP_STYLES: Record<"green" | "amber" | "red" | "grey", React.CSSProperties> = {
  green: { borderColor: "rgba(22,71,51,0.2)", background: "rgba(31,122,77,0.08)", color: "var(--green-dark)" },
  amber: { borderColor: "rgba(180,120,20,0.28)", background: "rgba(214,158,46,0.1)", color: "#8a5a12" },
  red: { borderColor: "rgba(187,75,82,0.25)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" },
  grey: { borderColor: "var(--border)", background: "rgba(20,42,34,0.04)", color: "var(--muted-text)" }
};

function Chip({ children, tone, title }: { children: React.ReactNode; tone: keyof typeof CHIP_STYLES; title?: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold"
      style={CHIP_STYLES[tone]}
      title={title}
    >
      {children}
    </span>
  );
}

function PushChip({ push }: { push: RecsNightView["push"] }) {
  if (!push || !push.pushed) return null;
  if (push.reverted) return <Chip tone="grey">reverted</Chip>;
  if (push.error) return <Chip tone="red" title={push.error}>push error</Chip>;
  if (push.verified === true) return <Chip tone="green">pushed ✓ verified</Chip>;
  if (push.verified === false) return <Chip tone="amber">pushed — verify mismatch</Chip>;
  return <Chip tone="grey">pushed — verify pending</Chip>;
}

function OversightNightChip({ oversight }: { oversight: RecsNightView["oversight"] }) {
  if (!oversight) return null;
  if (oversight.verdict === "endorse") return <Chip tone="green" title="Claude endorses this night">✓ Claude</Chip>;
  return (
    <Chip tone="amber" title={oversight.reason ?? "flagged"}>
      Claude flag{oversight.reason ? `: ${oversight.reason}` : ""}
    </Chip>
  );
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

function NightRow({
  night,
  currency,
  busy,
  selected,
  dismissed,
  bulkOutcome,
  explain,
  onToggleSelect,
  onAction,
  onExplain,
  onLeave,
  onUndoLeave
}: {
  night: RecsNightView;
  currency: string;
  busy: boolean;
  selected: boolean;
  dismissed: boolean;
  bulkOutcome: BulkOutcome | undefined;
  explain: ExplainState | undefined;
  onToggleSelect: () => void;
  onAction: (action: "approve" | "reject" | "revert", editedPrice?: number) => void;
  onExplain: () => void;
  onLeave: () => void;
  onUndoLeave: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [sizingOpen, setSizingOpen] = useState(false);

  const pending = night.status === "pending";
  const applied = night.status === "applied";
  const isDrop = night.kind === "drop";

  if (dismissed) {
    return (
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs" style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}>
        <span>
          {formatDateShort(night.date)} {night.dow} — left for now
        </span>
        <button type="button" className="font-semibold underline" onClick={onUndoLeave}>
          undo
        </button>
      </div>
    );
  }

  function startEdit() {
    setEditValue(night.recommendedPrice !== null ? String(Math.round(night.recommendedPrice)) : "");
    setEditError(null);
    setEditing(true);
  }

  function submitEdit() {
    const value = Number(editValue);
    if (!Number.isFinite(value) || value <= 0) {
      setEditError("Enter a positive price");
      return;
    }
    if (night.floor !== null && value < night.floor && !night.allowBelowFloor) {
      setEditError(`Below floor ${formatMoney(night.floor, currency)}`);
      return;
    }
    setEditError(null);
    setEditing(false);
    onAction("approve", value);
  }

  return (
    <div className="border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {pending ? (
          <input type="checkbox" className="h-4 w-4 accent-emerald-800" checked={selected} onChange={onToggleSelect} disabled={busy} />
        ) : null}

        <span className="w-20 text-sm font-semibold">
          {formatDateShort(night.date)}
          <span className="ml-1 text-xs font-normal" style={{ color: "var(--muted-text)" }}>{night.dow}</span>
        </span>

        <span className="w-16 text-sm" style={{ color: "var(--muted-text)" }}>{formatMoney(night.currentPrice, currency)}</span>

        {night.kind === "hold" ? (
          <Chip tone="grey">hold</Chip>
        ) : (
          <span className="w-16 text-sm font-bold">{formatMoney(night.recommendedPrice, currency)}</span>
        )}

        {isDrop && night.changePct !== null ? <Chip tone="red">{formatPct(night.changePct)}</Chip> : null}
        {night.kind === "hold" && night.changePct !== null && night.changePct !== 0 ? (
          <Chip tone="grey">{formatPct(night.changePct)}</Chip>
        ) : null}

        {night.revenueAtRisk !== null ? (
          <span className="text-xs" style={{ color: "var(--muted-text)" }}>
            at risk {formatMoney(night.revenueAtRisk, currency)}
          </span>
        ) : null}

        {night.floor !== null && night.recommendedPrice !== null && night.recommendedPrice < night.floor ? (
          <Chip tone="amber" title="This client allows recommendations below the floor">below floor</Chip>
        ) : null}
        {night.floorUnknown ? (
          <Chip tone="amber">floor unknown</Chip>
        ) : night.floor !== null ? (
          <span className="text-[11px]" style={{ color: "var(--muted-text)" }}>floor {formatMoney(night.floor, currency)}</span>
        ) : null}

        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {night.provenance ? <Chip tone={night.provenance === "live-observed" ? "green" : "amber"}>{night.provenance}</Chip> : null}
          {night.provisional ? <Chip tone="amber">provisional</Chip> : null}
          {night.suppressed ? <Chip tone="grey" title={night.suppressed}>held back: {night.suppressed}</Chip> : null}
          {night.soloReason ? <Chip tone="grey" title={night.soloReason}>kept individual</Chip> : null}
          <OversightNightChip oversight={night.oversight} />
          <PushChip push={night.push} />
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1 pl-1 text-xs" style={{ color: "var(--muted-text)" }}>
        <span className="max-w-xl">{night.whyShort || night.why}</span>
        {night.sizingComponents.length > 0 || night.why !== night.whyShort ? (
          <button type="button" className="font-semibold underline" onClick={() => setSizingOpen((open) => !open)}>
            {sizingOpen ? "hide sizing" : "how this was sized"}
          </button>
        ) : null}
        {night.kind !== "hold" && formatRanking(night.confidence) ? (
          <span>
            {formatRanking(night.confidence)}
            {night.curveCohort ? ` (${night.curveCohort.rung} curve, n=${night.curveCohort.n})` : ""}
          </span>
        ) : night.curveCohort ? (
          <span>({night.curveCohort.rung} curve, n={night.curveCohort.n})</span>
        ) : null}
        <button type="button" className="font-semibold underline" onClick={onExplain} disabled={explain?.loading}>
          {explain?.loading ? "explaining…" : "explain this night"}
        </button>
      </div>

      {sizingOpen ? (
        <div className="mt-2 pl-8 text-xs" style={{ color: "var(--muted-text)" }}>
          {night.sizingComponents.length > 0 ? (
            <ul className="list-disc space-y-0.5">
              {night.sizingComponents.map((component, index) => (
                <li key={index}>{component}</li>
              ))}
            </ul>
          ) : null}
          {night.why !== night.whyShort ? <p className="mt-1 italic">{night.why}</p> : null}
        </div>
      ) : null}

      {night.oversight?.narrative ? (
        <p className="mt-2 rounded-xl border px-3 py-2 text-xs" style={{ borderColor: "rgba(180,120,20,0.2)", background: "rgba(214,158,46,0.06)", color: "#8a5a12" }}>
          {night.oversight.narrative}
        </p>
      ) : null}

      {explain?.narrative ? (
        <p className="mt-2 rounded-xl border px-3 py-2 text-xs" style={{ borderColor: "var(--border)", background: "rgba(20,42,34,0.03)" }}>
          {explain.narrative}
        </p>
      ) : null}
      {explain?.error ? (
        <p className="mt-2 text-xs" style={{ color: "var(--delta-negative)" }}>{explain.error}</p>
      ) : null}

      {bulkOutcome ? (
        <p className="mt-2 text-xs font-semibold" style={{ color: bulkOutcome.ok ? "var(--green-dark)" : "var(--delta-negative)" }}>
          {bulkOutcome.ok ? "Approved" : `Failed: ${bulkOutcome.error ?? bulkOutcome.status}`}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2 pl-1">
        {pending ? (
          editing ? (
            <>
              <input
                type="number"
                className="w-24 rounded-full border px-3 py-1.5 text-xs outline-none focus-visible:border-emerald-700"
                style={{ borderColor: "var(--border-strong)" }}
                value={editValue}
                min={1}
                onChange={(event) => setEditValue(event.target.value)}
              />
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                style={{ background: "var(--green-dark)" }}
                disabled={busy}
                onClick={submitEdit}
              >
                Approve at {editValue ? formatMoney(Number(editValue), currency) : "…"}
              </button>
              <button
                type="button"
                className="rounded-full border px-3 py-1.5 text-xs font-semibold"
                style={{ borderColor: "var(--border-strong)", color: "var(--muted-text)" }}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              {editError ? <span className="text-xs font-semibold" style={{ color: "var(--delta-negative)" }}>{editError}</span> : null}
            </>
          ) : (
            <>
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                style={{ background: "var(--green-dark)" }}
                disabled={busy}
                onClick={() => onAction("approve")}
              >
                {busy ? "…" : "Approve"}
              </button>
              <button
                type="button"
                className="rounded-full border px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                disabled={busy}
                onClick={startEdit}
              >
                Edit
              </button>
              <button
                type="button"
                className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-60"
                disabled={busy}
                onClick={() => onAction("reject")}
              >
                Reject
              </button>
              <button
                type="button"
                className="rounded-full border px-3 py-1.5 text-xs font-semibold"
                style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}
                onClick={onLeave}
              >
                Leave
              </button>
            </>
          )
        ) : (
          <>
            <Chip tone={night.status === "rejected" ? "grey" : "green"}>
              {night.status}
              {night.approvedPrice !== null ? ` at ${formatMoney(night.approvedPrice, currency)}` : ""}
            </Chip>
            <span className="text-xs" style={{ color: "var(--muted-text)" }}>
              {night.actionedByEmail ?? "—"} · {formatDateTime(night.actionedAt)}
            </span>
            {applied && night.push?.pushed && !night.push.reverted ? (
              <button
                type="button"
                className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-60"
                disabled={busy}
                onClick={() => onAction("revert")}
              >
                {busy ? "…" : "Revert"}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function RunCard({
  run,
  currency,
  busy,
  onRunAction
}: {
  run: RecsRunView;
  currency: string;
  busy: boolean;
  onRunAction: (run: RecsRunView, action: "approve" | "reject", editedTotal?: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const pct = run.totalCurrent > 0 ? (run.totalProposed - run.totalCurrent) / run.totalCurrent : null;

  function submitEditTotal() {
    const value = Number(editValue);
    if (!Number.isFinite(value) || value <= 0) {
      setEditError("Enter a positive total");
      return;
    }
    setEditError(null);
    setEditing(false);
    onRunAction(run, "approve", value);
  }

  return (
    <div className="border-b px-3 py-3" style={{ borderColor: "var(--border)", background: "rgba(22,71,51,0.03)" }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-sm font-semibold">
          {formatDateShort(run.dateFrom)} – {formatDateShort(run.dateTo)}
          <span className="ml-1 text-xs font-normal" style={{ color: "var(--muted-text)" }}>
            {run.nightsCount} nights
          </span>
        </span>
        {run.segment !== "mixed" ? <Chip tone="grey">{run.segment}</Chip> : null}
        {run.uniformPct !== null ? (
          <Chip tone="red">{formatPct(run.uniformPct)} across {run.nightsCount} nights</Chip>
        ) : null}
        <span className="text-sm" style={{ color: "var(--muted-text)" }}>{formatMoney(run.totalCurrent, currency)}</span>
        <span className="text-sm font-bold">→ {formatMoney(run.totalProposed, currency)}</span>
        {run.uniformPct === null && pct !== null ? <Chip tone="red">{formatPct(pct)}</Chip> : null}
        <button
          type="button"
          className="ml-auto text-xs font-semibold underline"
          style={{ color: "var(--muted-text)" }}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "hide nights" : "see the nights"}
        </button>
      </div>
      <div className="mt-1.5 pl-1 text-xs" style={{ color: "var(--muted-text)" }}>
        {run.why.join(" · ")}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-full px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
          style={{ background: "var(--green-dark)" }}
          disabled={busy}
          onClick={() => onRunAction(run, "approve")}
        >
          Approve run
        </button>
        {editing ? (
          <span className="flex items-center gap-1.5">
            <input
              type="number"
              className="w-24 rounded-full border bg-white px-3 py-1.5 text-xs outline-none"
              style={{ borderColor: "var(--border-strong)" }}
              value={editValue}
              onChange={(event) => setEditValue(event.target.value)}
              autoFocus
            />
            <button type="button" className="rounded-full px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60" style={{ background: "var(--green-dark)" }} disabled={busy} onClick={submitEditTotal}>
              Approve at total
            </button>
            <button type="button" className="text-xs font-semibold underline" onClick={() => setEditing(false)}>
              cancel
            </button>
            {editError ? <span className="text-xs" style={{ color: "var(--delta-negative)" }}>{editError}</span> : null}
          </span>
        ) : (
          <button
            type="button"
            className="rounded-full border px-4 py-2 text-xs font-semibold disabled:opacity-60"
            style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
            disabled={busy}
            onClick={() => {
              setEditValue(String(run.totalProposed));
              setEditError(null);
              setEditing(true);
            }}
            title="Approve the run at a different TOTAL — the system spreads it across the nights (floors respected)"
          >
            Edit total
          </button>
        )}
        <button
          type="button"
          className="rounded-full border px-4 py-2 text-xs font-semibold disabled:opacity-60"
          style={{ borderColor: "rgba(187,75,82,0.4)", color: "var(--delta-negative)" }}
          disabled={busy}
          onClick={() => onRunAction(run, "reject")}
        >
          Reject run
        </button>
      </div>
      {expanded ? (
        <div className="mt-2 rounded-2xl border" style={{ borderColor: "var(--border)" }}>
          {run.nights.map((night) => (
            <div key={night.suggestionId} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-2 text-xs last:border-b-0" style={{ borderColor: "var(--border)" }}>
              <span className="w-20 font-semibold">{formatDateShort(night.date)} <span className="font-normal" style={{ color: "var(--muted-text)" }}>{night.dow}</span></span>
              <span style={{ color: "var(--muted-text)" }}>{formatMoney(night.currentPrice, currency)}</span>
              <span className="font-bold">→ {formatMoney(night.recommendedPrice, currency)}</span>
              {night.changePct !== null ? <Chip tone="red">{formatPct(night.changePct)}</Chip> : null}
              <span className="max-w-md" style={{ color: "var(--muted-text)" }}>{night.whyShort || night.why}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ListingSection({
  listing,
  currency,
  collapsed,
  onToggleCollapsed,
  selectedIds,
  busyId,
  bulkOutcomes,
  explains,
  dismissedIds,
  onToggleSelect,
  onOpenBulkConfirm,
  onAction,
  onExplain,
  onLeave,
  onUndoLeave,
  onSnooze,
  onRunAction
}: {
  listing: RecsListingView;
  currency: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  selectedIds: Set<string>;
  busyId: string | null;
  bulkOutcomes: Record<string, BulkOutcome>;
  explains: Record<string, ExplainState>;
  dismissedIds: Set<string>;
  onToggleSelect: (suggestionId: string) => void;
  onOpenBulkConfirm: (listingId: string) => void;
  onAction: (suggestionId: string, action: "approve" | "reject" | "revert", editedPrice?: number) => void;
  onExplain: (suggestionId: string) => void;
  onLeave: (suggestionId: string) => void;
  onUndoLeave: (suggestionId: string) => void;
  onSnooze: (listingId: string, action: "snooze" | "unsnooze") => void;
  onRunAction: (run: RecsRunView, action: "approve" | "reject", editedTotal?: number) => void;
}) {
  const selectedHere = listing.nights.filter((night) => selectedIds.has(night.suggestionId)).length;
  if (listing.snoozedUntil) {
    // Snoozed: one quiet bar — ignorable but never forgotten (auto-expires).
    return (
      <section className="glass-panel rounded-[24px] border px-4 py-3" style={{ borderColor: "var(--border)" }}>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm" style={{ color: "var(--muted-text)" }}>
          <span>
            <span className="font-display text-base" style={{ color: "var(--text)" }}>{listing.name}</span>
            {"  "}snoozed until {formatDateShort(listing.snoozedUntil.slice(0, 10))} — recommendations hidden
          </span>
          <button
            type="button"
            className="rounded-full border px-3 py-1.5 text-xs font-semibold"
            style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
            onClick={() => onSnooze(listing.listingId, "unsnooze")}
          >
            Unsnooze
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="glass-panel rounded-[24px] border" style={{ borderColor: "var(--border)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <button type="button" className="flex items-center gap-2 text-left" onClick={onToggleCollapsed}>
          <span className="text-sm" style={{ color: "var(--muted-text)" }}>{collapsed ? "▸" : "▾"}</span>
          <span className="font-display text-lg">{listing.name}</span>
          {listing.unitCount > 1 ? <Chip tone="grey">{listing.unitCount} units</Chip> : null}
          <span className="text-xs" style={{ color: "var(--muted-text)" }}>{listing.nights.length} nights</span>
        </button>
        {selectedHere > 0 ? (
          <button
            type="button"
            className="rounded-full px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
            style={{ background: "var(--green-dark)" }}
            disabled={busyId !== null}
            onClick={() => onOpenBulkConfirm(listing.listingId)}
          >
            Approve selected ({selectedHere})
          </button>
        ) : null}
        <button
          type="button"
          className="rounded-full border px-3 py-1.5 text-xs font-semibold"
          style={{ borderColor: "var(--border-strong)", color: "var(--muted-text)" }}
          title="Hide this listing's recommendations for 30 days; it resurfaces automatically"
          onClick={() => onSnooze(listing.listingId, "snooze")}
        >
          Ignore 30 days
        </button>
      </div>
      {!collapsed ? (
        <div className="border-t" style={{ borderColor: "var(--border)" }}>
          {listing.runs.map((run) => (
            <RunCard
              key={run.suggestionIds.join("|")}
              run={run}
              currency={currency}
              busy={busyId !== null}
              onRunAction={onRunAction}
            />
          ))}
          {listing.nights.filter((night) => !night.groupedInRun).map((night) => (
            <NightRow
              key={night.suggestionId}
              night={night}
              currency={currency}
              busy={busyId === night.suggestionId || busyId === "bulk"}
              selected={selectedIds.has(night.suggestionId)}
              dismissed={dismissedIds.has(night.suggestionId)}
              bulkOutcome={bulkOutcomes[night.suggestionId]}
              explain={explains[night.suggestionId]}
              onToggleSelect={() => onToggleSelect(night.suggestionId)}
              onAction={(action, editedPrice) => onAction(night.suggestionId, action, editedPrice)}
              onExplain={() => onExplain(night.suggestionId)}
              onLeave={() => onLeave(night.suggestionId)}
              onUndoLeave={() => onUndoLeave(night.suggestionId)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default function RecsClientView({ initialData }: { initialData: RecsClientViewResult }) {
  const [data, setData] = useState<RecsClientViewResult>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [allHolds, setAllHolds] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [bulkOutcomes, setBulkOutcomes] = useState<Record<string, BulkOutcome>>({});
  const [explains, setExplains] = useState<Record<string, ExplainState>>({});
  const [confirmListingId, setConfirmListingId] = useState<string | null>(null);

  async function handleRunAction(run: RecsRunView, action: "approve" | "reject", editedTotal?: number) {
    setBusyId("bulk");
    setError(null);
    try {
      const body = await postJson<{ ok: boolean; okCount: number; total: number; distributionNotes: string[]; results: Array<{ suggestionId: string; ok: boolean; error?: string | null }> }>(
        "/api/recs/run-action",
        { tenantId: data.tenantId, suggestionIds: run.suggestionIds, action, ...(editedTotal !== undefined ? { editedTotal } : {}) }
      );
      if (!body.ok) {
        const firstError = body.results.find((r) => !r.ok)?.error ?? null;
        setError(`Run ${action}: ${body.okCount}/${body.total} nights succeeded${firstError ? ` — ${firstError}` : ""}`);
      } else if (body.distributionNotes.length > 0) {
        setError(body.distributionNotes.join(" · "));
      }
      await refetch();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Run action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleSnooze(listingId: string, action: "snooze" | "unsnooze") {
    try {
      await postJson<Record<string, unknown>>("/api/recs/snooze", { tenantId: data.tenantId, listingId, action });
      await refetch();
    } catch (snoozeError) {
      setError(snoozeError instanceof Error ? snoozeError.message : "Failed to update snooze");
    }
  }

  async function refetch(showAllHolds = allHolds) {
    try {
      const response = await fetch(
        withBasePath(
          `/api/recs/client/${encodeURIComponent(data.tenantId)}${showAllHolds ? "?allHolds=1" : ""}`
        )
      );
      const body = (await response.json().catch(() => ({}))) as RecsClientViewResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Failed to reload");
      setData(body);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to reload");
    }
  }

  async function handleAction(suggestionId: string, action: "approve" | "reject" | "revert", editedPrice?: number) {
    setBusyId(suggestionId);
    setError(null);
    try {
      const result = await postJson<ActionResultShape>("/api/recs/action", {
        tenantId: data.tenantId,
        suggestionId,
        action,
        ...(editedPrice !== undefined ? { editedPrice } : {})
      });
      if (!result.ok) {
        setError(result.error ?? `${action} failed (${result.status})`);
      }
      await refetch();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `${action} failed`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleBulkApprove(listingId: string) {
    const listing = data.listings.find((entry) => entry.listingId === listingId);
    if (!listing) return;
    const ids = listing.nights.filter((night) => selectedIds.has(night.suggestionId)).map((night) => night.suggestionId);
    if (ids.length === 0) return;
    setConfirmListingId(null);
    setBusyId("bulk");
    setError(null);
    try {
      const body = await postJson<{ results: Array<{ suggestionId: string } & BulkOutcome> }>("/api/recs/bulk-approve", {
        tenantId: data.tenantId,
        suggestionIds: ids
      });
      const outcomes: Record<string, BulkOutcome> = {};
      for (const result of body.results) {
        outcomes[result.suggestionId] = { ok: result.ok, status: result.status, error: result.error ?? null };
      }
      setBulkOutcomes((current) => ({ ...current, ...outcomes }));
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      await refetch();
    } catch (bulkError) {
      setError(bulkError instanceof Error ? bulkError.message : "Bulk approve failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRegenerate() {
    setRegenerating(true);
    setError(null);
    try {
      await postJson<Record<string, unknown>>("/api/recs/regenerate", { tenantId: data.tenantId });
      await refetch();
    } catch (regenError) {
      setError(regenError instanceof Error ? regenError.message : "Regeneration failed");
    } finally {
      setRegenerating(false);
    }
  }

  async function handleExplain(suggestionId: string) {
    setExplains((current) => ({ ...current, [suggestionId]: { loading: true, narrative: null, error: null } }));
    try {
      const result = await postJson<{ ok: boolean; narrative?: string | null; error?: string | null }>("/api/recs/explain", {
        tenantId: data.tenantId,
        suggestionId
      });
      setExplains((current) => ({
        ...current,
        [suggestionId]: {
          loading: false,
          narrative: result.ok ? (result.narrative ?? null) : null,
          error: result.ok ? null : (result.error ?? "Explain failed")
        }
      }));
    } catch (explainError) {
      setExplains((current) => ({
        ...current,
        [suggestionId]: {
          loading: false,
          narrative: null,
          error: explainError instanceof Error ? explainError.message : "Explain failed"
        }
      }));
    }
  }

  function toggleSelect(suggestionId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(suggestionId)) next.delete(suggestionId);
      else next.add(suggestionId);
      return next;
    });
  }

  function toggleCollapsed(listingId: string) {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(listingId)) next.delete(listingId);
      else next.add(listingId);
      return next;
    });
  }

  function markLeft(suggestionId: string, left: boolean) {
    setDismissedIds((current) => {
      const next = new Set(current);
      if (left) next.add(suggestionId);
      else next.delete(suggestionId);
      return next;
    });
  }

  const confirmListing = confirmListingId ? data.listings.find((entry) => entry.listingId === confirmListingId) : null;
  const confirmNights = confirmListing
    ? confirmListing.nights.filter((night) => selectedIds.has(night.suggestionId))
    : [];

  return (
    <main className="app-shell relative min-h-screen px-5 py-10 sm:px-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link
              href="/dashboard/recommendations"
              className="mb-2 inline-flex items-center gap-1 text-sm font-semibold"
              style={{ color: "var(--green-dark)" }}
            >
              ← All clients
            </Link>
            <h1 className="font-display text-3xl sm:text-4xl">{data.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Chip tone={data.engine === "hostaway-scan" ? "grey" : "green"}>
                {data.engine === "hostaway-scan" ? "hostaway-scan · read-only" : data.engine}
              </Chip>
              {data.provenance ? (
                <Chip tone={data.provenance === "live-observed" ? "green" : "amber"}>{data.provenance}</Chip>
              ) : null}
              {data.provisional ? <Chip tone="amber">provisional</Chip> : null}
              {data.generatedAt ? (
                <span className="text-xs" style={{ color: "var(--muted-text)" }}>
                  generated {formatDateTime(data.generatedAt)}
                </span>
              ) : null}
            </div>
          </div>
          {data.hiddenHolds > 0 || allHolds ? (
            <button
              type="button"
              className="rounded-full border px-4 py-2 text-sm font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
              onClick={() => {
                const next = !allHolds;
                setAllHolds(next);
                void refetch(next);
              }}
            >
              {allHolds ? "Hide far-out holds" : `Show all holds (${data.hiddenHolds} hidden)`}
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: "var(--green-dark)" }}
            disabled={regenerating || busyId !== null}
            onClick={() => void handleRegenerate()}
          >
            {regenerating ? "Regenerating…" : "Regenerate now"}
          </button>
        </div>

        {data.stale ? (
          <p className="rounded-2xl border px-4 py-3 text-sm font-medium" style={{ borderColor: "rgba(180,120,20,0.28)", background: "rgba(214,158,46,0.1)", color: "#8a5a12" }}>
            Calendar data is {data.calendarFreshHours}h old; current prices may not reflect Hostaway right now.
          </p>
        ) : null}

        {data.lowConfidence ? (
          <div className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(180,120,20,0.28)", background: "rgba(214,158,46,0.08)", color: "#8a5a12" }}>
            <p className="font-semibold">{data.lowConfidence.note}</p>
            {data.lowConfidence.question ? <p className="mt-1">{data.lowConfidence.question}</p> : null}
          </div>
        ) : null}

        {error ? (
          <p className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(187,75,82,0.2)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" }}>
            {error}
          </p>
        ) : null}

        {data.oversightRead ? (
          <section className="glass-panel rounded-[24px] border p-4" style={{ borderColor: "var(--border)" }}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
              Claude read
            </p>
            {data.oversightRead.status === "ok" ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {data.oversightRead.bullets.map((bullet, index) => (
                  <li key={index}>{bullet}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm" style={{ color: "var(--muted-text)" }}>
                Oversight unavailable — latest run status: {data.oversightRead.status}.
              </p>
            )}
            <p className="mt-2 text-[11px]" style={{ color: "var(--muted-text)" }}>
              {data.oversightRead.model} · {formatDateTime(data.oversightRead.runAt)}
            </p>
          </section>
        ) : null}

        {data.listings.length === 0 ? (
          <p className="glass-panel rounded-[24px] border px-5 py-6 text-sm" style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}>
            No recommendations in the next 14 days.
          </p>
        ) : (
          data.listings.map((listing) => (
            <ListingSection
              onSnooze={(listingId, action) => void handleSnooze(listingId, action)}
              onRunAction={(run, action, editedTotal) => void handleRunAction(run, action, editedTotal)}
              key={listing.listingId}
              listing={listing}
              currency={data.currency}
              collapsed={collapsedIds.has(listing.listingId)}
              onToggleCollapsed={() => toggleCollapsed(listing.listingId)}
              selectedIds={selectedIds}
              busyId={busyId}
              bulkOutcomes={bulkOutcomes}
              explains={explains}
              dismissedIds={dismissedIds}
              onToggleSelect={toggleSelect}
              onOpenBulkConfirm={setConfirmListingId}
              onAction={(suggestionId, action, editedPrice) => void handleAction(suggestionId, action, editedPrice)}
              onExplain={(suggestionId) => void handleExplain(suggestionId)}
              onLeave={(suggestionId) => markLeft(suggestionId, true)}
              onUndoLeave={(suggestionId) => markLeft(suggestionId, false)}
            />
          ))
        )}

        <section className="glass-panel rounded-[24px] border p-4" style={{ borderColor: "var(--border)" }}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
            Decision memory — last 7 days
          </p>
          {data.decisions.length === 0 ? (
            <p className="mt-2 text-sm" style={{ color: "var(--muted-text)" }}>No decisions in the last 7 days.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                    <th className="py-2 pr-4">Listing</th>
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4">Action</th>
                    <th className="py-2 pr-4">By</th>
                    <th className="py-2 pr-4">When</th>
                    <th className="py-2 pr-4">Price</th>
                    <th className="py-2">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {data.decisions.map((decision) => (
                    <tr key={decision.suggestionId} className="border-t" style={{ borderColor: "var(--border)" }}>
                      <td className="py-2 pr-4">{decision.listingName}</td>
                      <td className="py-2 pr-4">{formatDateShort(decision.date)}</td>
                      <td className="py-2 pr-4">{decision.action}</td>
                      <td className="py-2 pr-4">{decision.actionedByEmail ?? "—"}</td>
                      <td className="py-2 pr-4">{formatDateTime(decision.actionedAt)}</td>
                      <td className="py-2 pr-4">
                        {formatMoney(decision.oldValue, data.currency)} → {formatMoney(decision.approvedPrice, data.currency)}
                      </td>
                      <td className="py-2">{decision.outcomeSoFar ? <Chip tone="grey">{decision.outcomeSoFar}</Chip> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {confirmListing && confirmNights.length > 0 ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4">
          <div className="w-full max-w-md rounded-[28px] border bg-white p-5 shadow-2xl" style={{ borderColor: "var(--border-strong)" }}>
            <h2 className="font-display text-[1.6rem]">Approve {confirmNights.length} {confirmNights.length === 1 ? "night" : "nights"}</h2>
            <p className="mt-1 text-sm" style={{ color: "var(--muted-text)" }}>{confirmListing.name}</p>
            <ul className="mt-4 max-h-64 space-y-1 overflow-y-auto text-sm">
              {confirmNights.map((night) => (
                <li key={night.suggestionId} className="flex items-center justify-between gap-3 border-b py-1.5" style={{ borderColor: "var(--border)" }}>
                  <span className="font-semibold">{formatDateShort(night.date)} {night.dow}</span>
                  <span>
                    {formatMoney(night.currentPrice, data.currency)} → <strong>{formatMoney(night.recommendedPrice, data.currency)}</strong>
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-full border px-4 py-2 text-sm font-semibold"
                style={{ borderColor: "var(--border-strong)", color: "var(--muted-text)" }}
                onClick={() => setConfirmListingId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style={{ background: "var(--green-dark)" }}
                disabled={busyId !== null}
                onClick={() => void handleBulkApprove(confirmListing.listingId)}
              >
                Approve {confirmNights.length}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

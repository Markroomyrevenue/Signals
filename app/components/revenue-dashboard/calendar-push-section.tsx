"use client";

import { useCallback, useEffect, useState } from "react";

import { withBasePath } from "@/lib/base-path";

import type { PricingCalendarRow } from "./calendar-utils";

// Push UI lives in a self-contained component file so its edits stay
// isolated from the rest of the calendar-grid-panel during parallel
// development. CalendarInspector mounts this only when the listing's
// resolved settings have hostawayPushEnabled === true.

type PushPreviewItem = {
  date: string;
  currentRate: number | null;
  recommendedRate: number;
};

type PushPreview = {
  listingId: string;
  hostawayId: string;
  dateFrom: string;
  dateTo: string;
  count: number;
  dates: PushPreviewItem[];
  displayCurrency: string;
};

type LastEvent = {
  id: string;
  dateCount: number;
  status: string;
  pushedBy: string;
  createdAt: string;
};

type DryRunResponse = {
  ok: boolean;
  dryRun: true;
  preview: PushPreview;
  lastEvent: LastEvent | null;
};

type PushResponse = {
  ok: boolean;
  dryRun: false;
  pushedCount?: number;
  eventId?: string;
  errorMessage?: string;
  preview: PushPreview;
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(withBasePath(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: unknown };
  if (!response.ok) {
    const errorMessage =
      typeof json.error === "string"
        ? json.error
        : json && "errorMessage" in (json as Record<string, unknown>)
          ? String((json as Record<string, unknown>).errorMessage)
          : "Request failed";
    throw new Error(errorMessage);
  }
  return json;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatPushDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

function formatPushCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${Math.round(value)}`;
  }
}

export function CalendarPushSection({
  row
}: {
  row: PricingCalendarRow;
}) {
  const listingId = row.listingId;
  const [showCustomRange, setShowCustomRange] = useState(false);
  const [customFrom, setCustomFrom] = useState<string>(todayIso());
  const [customTo, setCustomTo] = useState<string>(plusDaysIso(todayIso(), 29));
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [confirmPreview, setConfirmPreview] = useState<PushPreview | null>(null);
  const [pushResult, setPushResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [lastEvent, setLastEvent] = useState<LastEvent | null>(null);
  const [hasLoadedLastEvent, setHasLoadedLastEvent] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const onError = setLocalError;

  const refreshLastEvent = useCallback(async () => {
    try {
      // Reuse the dry-run endpoint with a tiny window to fetch lastEvent
      // cheaply. The preview list is discarded — we only need the
      // lastEvent meta — so the cost on the server is bounded.
      const today = todayIso();
      const data = await postJson<DryRunResponse>("/api/hostaway/push-rates", {
        listingId,
        dateFrom: today,
        dateTo: today,
        dryRun: true
      });
      setLastEvent(data.lastEvent);
    } catch {
      // Non-fatal: simply don't show the "last push" line.
      setLastEvent(null);
    } finally {
      setHasLoadedLastEvent(true);
    }
  }, [listingId]);

  useEffect(() => {
    if (!hasLoadedLastEvent) {
      void refreshLastEvent();
    }
  }, [hasLoadedLastEvent, refreshLastEvent]);

  async function startNext30() {
    const dateFrom = todayIso();
    const dateTo = plusDaysIso(dateFrom, 29);
    await openPreview(dateFrom, dateTo);
  }

  async function startCustomRange() {
    if (!customFrom || !customTo) {
      onError("Choose both a start and end date.");
      return;
    }
    if (customFrom > customTo) {
      onError("Start date must be on or before end date.");
      return;
    }
    await openPreview(customFrom, customTo);
  }

  async function openPreview(dateFrom: string, dateTo: string) {
    setPushResult(null);
    onError(null);
    setPreviewLoading(true);
    try {
      const data = await postJson<DryRunResponse>("/api/hostaway/push-rates", {
        listingId,
        dateFrom,
        dateTo,
        dryRun: true
      });
      setConfirmPreview(data.preview);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to build preview");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirmPush() {
    if (!confirmPreview) return;
    setPushing(true);
    onError(null);
    try {
      const data = await postJson<PushResponse>("/api/hostaway/push-rates", {
        listingId,
        dateFrom: confirmPreview.dateFrom,
        dateTo: confirmPreview.dateTo,
        dryRun: false
      });
      setPushResult({
        ok: true,
        message: `Pushed ${data.pushedCount ?? confirmPreview.count} ${(data.pushedCount ?? confirmPreview.count) === 1 ? "date" : "dates"} to Hostaway.`
      });
      setConfirmPreview(null);
      // Refresh the "last push" line.
      setHasLoadedLastEvent(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Push failed";
      setPushResult({ ok: false, message });
    } finally {
      setPushing(false);
    }
  }

  function cancelConfirm() {
    setConfirmPreview(null);
  }

  return (
    <div className="rounded-[18px] border bg-white/94 p-4" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
            Live rates to Hostaway
          </p>
          <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
            Push the recommended nightly rates for this property up to your channel manager.
            Booked nights are skipped automatically.
          </p>
        </div>
      </div>

      {confirmPreview ? (
        <PushConfirmDialog
          preview={confirmPreview}
          pushing={pushing}
          onConfirm={confirmPush}
          onCancel={cancelConfirm}
        />
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-full px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            style={{ background: "var(--green-dark)" }}
            disabled={previewLoading || pushing}
            onClick={() => void startNext30()}
          >
            {previewLoading ? "Preparing…" : "Push next 30 days"}
          </button>
          <button
            type="button"
            className="rounded-full border px-3.5 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
            disabled={previewLoading || pushing}
            onClick={() => setShowCustomRange((v) => !v)}
          >
            {showCustomRange ? "Hide custom range" : "Custom range"}
          </button>
        </div>
      )}

      {showCustomRange && !confirmPreview ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr,1fr,auto] sm:items-end">
          <label className="text-xs font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
            From
            <input
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
              className="mt-1 w-full rounded-[10px] border px-2 py-1.5 text-sm font-semibold normal-case tracking-normal"
              style={{ borderColor: "var(--border)", color: "var(--navy-dark)" }}
            />
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
            To
            <input
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
              className="mt-1 w-full rounded-[10px] border px-2 py-1.5 text-sm font-semibold normal-case tracking-normal"
              style={{ borderColor: "var(--border)", color: "var(--navy-dark)" }}
            />
          </label>
          <button
            type="button"
            className="rounded-full px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            style={{ background: "var(--green-dark)" }}
            disabled={previewLoading || pushing}
            onClick={() => void startCustomRange()}
          >
            {previewLoading ? "Preparing…" : "Preview push"}
          </button>
        </div>
      ) : null}

      {pushResult ? (
        <div
          className="mt-3 rounded-[10px] border px-3 py-2 text-[13px] leading-5"
          style={{
            borderColor: pushResult.ok ? "rgba(31,122,77,0.3)" : "rgba(187,75,82,0.3)",
            background: pushResult.ok ? "rgba(31,122,77,0.08)" : "rgba(187,75,82,0.08)",
            color: pushResult.ok ? "var(--green-dark)" : "var(--delta-negative)"
          }}
        >
          {pushResult.message}
        </div>
      ) : null}

      {localError ? (
        <div
          className="mt-3 rounded-[10px] border px-3 py-2 text-[13px] leading-5"
          style={{
            borderColor: "rgba(187,75,82,0.3)",
            background: "rgba(187,75,82,0.08)",
            color: "var(--delta-negative)"
          }}
        >
          {localError}
        </div>
      ) : null}

      {lastEvent ? (
        <div className="mt-3 text-[12px] leading-5" style={{ color: "var(--muted-text)" }}>
          {lastEventLine(lastEvent)}
        </div>
      ) : null}
    </div>
  );
}

function PushConfirmDialog({
  preview,
  pushing,
  onConfirm,
  onCancel
}: {
  preview: PushPreview;
  pushing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const sample = preview.dates.slice(0, 5);
  const remaining = Math.max(0, preview.count - sample.length);
  return (
    <div className="mt-3 rounded-[14px] border px-3 py-3" style={{ borderColor: "var(--border)", background: "rgba(248,250,249,0.86)" }}>
      <div className="text-sm font-semibold" style={{ color: "var(--navy-dark)" }}>
        Push {preview.count} {preview.count === 1 ? "date" : "dates"} to Hostaway?
      </div>
      <div className="mt-2 grid gap-1 text-[13px] leading-5">
        {sample.length === 0 ? (
          <div style={{ color: "var(--muted-text)" }}>
            No dates with a recommended rate were found in the chosen range.
          </div>
        ) : (
          <>
            {sample.map((entry) => (
              <div key={entry.date} className="flex items-center justify-between gap-2">
                <span style={{ color: "var(--navy-dark)" }}>{formatPushDate(entry.date)}</span>
                <span className="font-semibold" style={{ color: "var(--green-dark)" }}>
                  {formatPushCurrency(entry.recommendedRate, preview.displayCurrency)}
                </span>
              </div>
            ))}
            {remaining > 0 ? (
              <div style={{ color: "var(--muted-text)" }}>and {remaining} more…</div>
            ) : null}
          </>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-full px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          style={{ background: "var(--green-dark)" }}
          disabled={pushing || preview.count === 0}
          onClick={onConfirm}
        >
          {pushing ? "Pushing…" : "Confirm push"}
        </button>
        <button
          type="button"
          className="rounded-full border px-3.5 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
          style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
          disabled={pushing}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function lastEventLine(event: LastEvent): string {
  const time = formatRelativeTime(event.createdAt);
  const who = event.pushedBy;
  if (event.status === "success") {
    return `Last push: ${event.dateCount} ${event.dateCount === 1 ? "date" : "dates"} pushed at ${time} by ${who}`;
  }
  if (event.status === "skipped") {
    return `Last attempt: skipped at ${time} by ${who} — no recommendable dates`;
  }
  return `Last attempt: failed at ${time} by ${who}`;
}

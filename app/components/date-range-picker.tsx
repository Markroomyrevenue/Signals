"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type DateRangePreset =
  | "today"
  | "yesterday"
  | "last_7_days"
  | "last_30_days"
  | "this_week"
  | "this_month"
  | "this_year"
  | "last_year"
  | "custom";

export type DateRangeValue = {
  preset: DateRangePreset;
  from: string;
  to: string;
};

export type DateRangePickerOption = {
  id: DateRangePreset;
  label: string;
};

// ---------------------------------------------------------------------------
// Preset date math (Europe/London-anchored)
// ---------------------------------------------------------------------------
// The app is UK-facing (Europe/London is the stated app timezone in CLAUDE.md).
// `new Date().toISOString().slice(0,10)` truncates to the *UTC* calendar date,
// so during BST (UTC+1, the whole summer) the window between 00:00 and 01:00
// London time still reads as *yesterday* — "Today"/"Yesterday" and every
// `today-N` window silently shift by one day for a UK user in the early hours.
//
// `londonTodayDateOnly()` returns "today" as the user in London sees it, and
// `resolvePreset(preset, today)` is the single shared resolver every dated tab
// should route through so the preset math lives in exactly one place.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date (YYYY-MM-DD) as seen in Europe/London, regardless of
 * the host machine's timezone. en-CA renders ISO-shaped `YYYY-MM-DD`. */
export function londonTodayDateOnly(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

/** Parse a `YYYY-MM-DD` date-only string into a UTC-midnight Date. Date math
 * below is done purely in UTC so it never re-introduces a timezone shift. */
function dateOnlyToUtc(dateOnly: string): Date {
  const [year, month, day] = dateOnly.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
}

function utcToDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export type ResolvedRange = { from: string; to: string };

/**
 * Resolve a preset into inclusive `{from,to}` date-only bounds, anchored on a
 * Europe/London "today" (`anchor`, a `YYYY-MM-DD` string; defaults to
 * `londonTodayDateOnly()`). Returns `null` for `custom` (the caller supplies
 * those bounds) and for any unknown preset.
 */
export function resolvePreset(
  preset: DateRangePreset,
  anchor: string = londonTodayDateOnly()
): ResolvedRange | null {
  if (preset === "custom") return null;
  if (!ISO_DATE_RE.test(anchor)) return null;
  const today = dateOnlyToUtc(anchor);
  const t = utcToDateOnly(today);

  switch (preset) {
    case "today":
      return { from: t, to: t };
    case "yesterday": {
      const y = utcToDateOnly(addUtcDays(today, -1));
      return { from: y, to: y };
    }
    case "last_7_days":
      return { from: utcToDateOnly(addUtcDays(today, -6)), to: t };
    case "last_30_days":
      return { from: utcToDateOnly(addUtcDays(today, -29)), to: t };
    case "this_week": {
      // Week-to-date: Monday → today (ISO week starts Monday).
      const dow = today.getUTCDay(); // 0=Sun … 6=Sat
      const sinceMonday = (dow + 6) % 7;
      return { from: utcToDateOnly(addUtcDays(today, -sinceMonday)), to: t };
    }
    case "this_month":
      return {
        from: `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`,
        to: t
      };
    case "this_year":
      return { from: `${today.getUTCFullYear()}-01-01`, to: t };
    case "last_year":
      return { from: utcToDateOnly(addUtcDays(today, -364)), to: t };
    default:
      return null;
  }
}

const DEFAULT_OPTIONS: DateRangePickerOption[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last_7_days", label: "Last 7 days" },
  { id: "this_month", label: "This month" },
  { id: "custom", label: "Custom range" }
];

function formatDisplayDate(iso: string): string {
  if (!iso) return "";
  try {
    const [year, month, day] = iso.split("-").map((part) => Number.parseInt(part, 10));
    const date = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
  } catch {
    return iso;
  }
}

export function describeDateRange(value: DateRangeValue, options: DateRangePickerOption[] = DEFAULT_OPTIONS): string {
  if (value.preset !== "custom") {
    return options.find((option) => option.id === value.preset)?.label ?? "Custom range";
  }
  if (value.from && value.to) {
    return `${formatDisplayDate(value.from)} – ${formatDisplayDate(value.to)}`;
  }
  if (value.from || value.to) {
    return formatDisplayDate(value.from || value.to);
  }
  return "Custom range";
}

type DateRangePickerProps = {
  label?: string;
  value: DateRangeValue;
  options?: DateRangePickerOption[];
  onChange: (next: DateRangeValue) => void;
  className?: string;
  /**
   * Optional label rendered as a small kicker above the trigger button.
   * Pass an empty string or omit to hide.
   */
  kicker?: string;
};

export default function DateRangePicker({
  label,
  value,
  options = DEFAULT_OPTIONS,
  onChange,
  className,
  kicker
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const [popupPosition, setPopupPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const triggerId = useId();

  useEffect(() => {
    setHasMounted(true);
  }, []);

  // Recompute popup position from the trigger button's viewport rect. Called
  // when the dropdown opens; outside-click + scroll/resize handlers below
  // close the dropdown instead of trying to chase the trigger.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setPopupPosition(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const desiredWidth = 280;
    const margin = 8;
    const vw = typeof window === "undefined" ? rect.right + desiredWidth : window.innerWidth;
    let left = rect.left;
    if (left + desiredWidth > vw - margin) left = Math.max(margin, vw - desiredWidth - margin);
    setPopupPosition({ top: rect.bottom + margin, left, width: desiredWidth });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function handleViewportShift() {
      // Trigger has moved (page scroll, sticky header collapse, window resize)
      // — close rather than try to follow it. Re-tap shows the current value.
      setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("scroll", handleViewportShift, true);
    window.addEventListener("resize", handleViewportShift);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("scroll", handleViewportShift, true);
      window.removeEventListener("resize", handleViewportShift);
    };
  }, [open]);

  const summary = describeDateRange(value, options);
  const showCustomFields = value.preset === "custom";

  function selectPreset(preset: DateRangePreset) {
    onChange({ ...value, preset });
    if (preset !== "custom") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className={`relative inline-flex flex-col ${className ?? ""}`}>
      {kicker ? (
        <label
          htmlFor={triggerId}
          className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: "var(--muted-text)" }}
        >
          {kicker}
        </label>
      ) : null}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-9 items-center justify-between gap-2 rounded-full border bg-white px-3 text-sm font-semibold"
        style={{ borderColor: "var(--border)", color: "var(--navy-dark)" }}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="truncate">
          {label ? <span className="mr-2 text-xs font-normal" style={{ color: "var(--muted-text)" }}>{label}</span> : null}
          {summary}
        </span>
        <svg
          aria-hidden
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M1 3 L5 7 L9 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {hasMounted && open && popupPosition && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popupRef}
              role="dialog"
              className="rounded-2xl border bg-white p-2 shadow-lg"
              style={{
                position: "fixed",
                top: popupPosition.top,
                left: popupPosition.left,
                width: popupPosition.width,
                zIndex: 1000,
                borderColor: "var(--border-strong)"
              }}
            >
              <div className="space-y-1">
                {options.map((option) => {
                  const active = value.preset === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-medium"
                      style={
                        active
                          ? { background: "rgba(31,122,77,0.10)", color: "var(--green-dark)" }
                          : { background: "transparent", color: "var(--navy-dark)" }
                      }
                      onClick={() => selectPreset(option.id)}
                    >
                      <span>{option.label}</span>
                      {active ? (
                        <svg aria-hidden width="14" height="14" viewBox="0 0 14 14">
                          <path d="M2 7 L6 11 L12 3" stroke="currentColor" strokeWidth="1.75" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {showCustomFields ? (
                <div className="mt-2 grid gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
                  <label className="block text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                    From
                    <input
                      type="date"
                      className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm"
                      style={{ borderColor: "var(--border)" }}
                      value={value.from}
                      onChange={(event) => onChange({ ...value, preset: "custom", from: event.target.value })}
                    />
                  </label>
                  <label className="block text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                    To
                    <input
                      type="date"
                      className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm"
                      style={{ borderColor: "var(--border)" }}
                      value={value.to}
                      onChange={(event) => onChange({ ...value, preset: "custom", to: event.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    className="mt-1 self-end rounded-full px-3 py-1.5 text-xs font-semibold text-white"
                    style={{ background: "var(--green-dark)" }}
                    onClick={() => setOpen(false)}
                  >
                    Done
                  </button>
                </div>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

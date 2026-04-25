"use client";

import { useEffect, useId, useRef, useState } from "react";

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerId = useId();

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      setOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
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

      {open ? (
        <div
          role="dialog"
          className="absolute left-0 right-auto top-full z-30 mt-2 w-[260px] rounded-2xl border bg-white p-2 shadow-lg sm:w-[280px]"
          style={{ borderColor: "var(--border-strong)" }}
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
        </div>
      ) : null}
    </div>
  );
}

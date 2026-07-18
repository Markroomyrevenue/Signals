/**
 * Pure formatting helpers for the internal Pricing Recommendations surface.
 *
 * Money: whole units only (no decimals), currency symbol from the client's
 * `currency` field (GBP → £, EUR → €, anything else renders the code).
 * Dates: the data layer emits date-only strings (Europe/London business
 * dates) and ISO timestamps; timestamps format in Europe/London.
 */

export function currencySymbol(code: string | null | undefined): string {
  const c = (code ?? "").trim().toUpperCase();
  if (c === "GBP") return "£";
  if (c === "EUR") return "€";
  return c ? `${c} ` : "£";
}

export function formatMoney(value: number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  const abs = Math.abs(rounded).toLocaleString("en-GB");
  return `${rounded < 0 ? "-" : ""}${currencySymbol(currency)}${abs}`;
}

/** changePct is a fraction: -0.12 → "-12%", +0.05 → "+5%". */
export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const pct = Math.round(value * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

/** Ranking signal 0..1 → "ranking 0.72" (never presented as a probability). */
export function formatRanking(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `ranking ${value.toFixed(2)}`;
}

export function formatHoursOld(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return "no calendar data";
  return `calendar ${hours}h old`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Date-only string "2026-07-19" → "19 Jul". Timezone-free by design. */
export function formatDateShort(dateOnly: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly ?? "");
  if (!m) return dateOnly ?? "—";
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${Number(m[3])} ${month}`;
}

/** ISO timestamp → "18 Jul, 14:02" in Europe/London. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

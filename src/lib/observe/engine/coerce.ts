/**
 * Defensive coercion helpers shared by the engine mappers.
 *
 * Engine JSON is loosely typed and fields drift between API versions, so every
 * mapper coerces through these rather than trusting the raw value. All pure.
 */

/** Read a property from an unknown record, or undefined. */
export function pick(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

/** First present (non-undefined, non-null) value among several keys. */
export function pickFirst(obj: unknown, keys: string[]): unknown {
  for (const key of keys) {
    const value = pick(obj, key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Coerce to a finite number, or null. Strips currency symbols / commas. */
export function toNum(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.+-]/g, "");
    if (cleaned === "" || cleaned === "+" || cleaned === "-" || cleaned === ".") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Coerce to a positive integer (e.g. min-stay), or null. */
export function toPosInt(value: unknown): number | null {
  const n = toNum(value);
  if (n === null) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

/** Coerce to a trimmed non-empty string, or null. */
export function toStr(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Coerce common truthy/falsey encodings to a boolean, or null when absent. */
export function toBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "enabled", "on"].includes(t)) return true;
    if (["false", "0", "no", "n", "disabled", "off", ""].includes(t)) return false;
  }
  return null;
}

/** Coerce to a Date, or null. Accepts ISO strings and epoch numbers. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: seconds vs milliseconds epoch.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (t.length === 0) return null;
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce to a `yyyy-mm-dd` date-only string, or null. */
export function toDateOnly(value: unknown): string | null {
  if (typeof value === "string") {
    const head = value.trim().slice(0, 10);
    return DATE_ONLY.test(head) ? head : null;
  }
  const d = toDate(value);
  return d ? d.toISOString().slice(0, 10) : null;
}

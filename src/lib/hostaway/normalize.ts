type ChannelNormalizeInput = {
  channel?: string | null;
  channelName?: string | null;
  source?: string | null;
  channelId?: number | null;
};

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function compactToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toFiniteNumber(value: number | null | undefined): number | null {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) ? value : null;
}

const VRBO_TOKENS = new Set([
  "vrbo",
  "homeaway",
  "homeawayapi",
  "homeawayca",
  "homeawayuk",
  "homeawaynz",
  "stayz",
  "abritel"
]);

const CHANNEL_ALIAS_MAP: Record<string, string[]> = {
  "booking.com": ["booking.com", "bookingcom", "booking_com"],
  airbnb: ["airbnb", "airbnbofficial"],
  "booking engine": ["booking engine", "bookingengine", "cooridoonstays"],
  direct: ["direct", "reservation"],
  google: ["google"],
  vrbo: ["vrbo", "homeaway", "homeaway_uk", "homeaway_ca", "homeaway_nz", "stayz", "abritel"]
};

export function normalizeReservationChannel(input: ChannelNormalizeInput): string {
  const channelName = normalizeText(input.channelName);
  const channel = normalizeText(input.channel);
  const source = normalizeText(input.source);
  const selected = channelName || channel || source;
  const selectedToken = compactToken(selected);
  const sourceToken = compactToken(source);
  const channelId = toFiniteNumber(input.channelId);

  if (channelId === 2005 || selectedToken.includes("bookingcom") || selectedToken === "booking") {
    return "booking.com";
  }

  if (channelId === 2018 || selectedToken.includes("airbnb")) {
    return "airbnb";
  }

  if (channelId === 2013 || selectedToken.includes("bookingengine")) {
    return "booking engine";
  }

  if (selectedToken === "direct" || selectedToken === "reservation" || channelId === 2000) {
    return "direct";
  }

  if (selectedToken.includes("google") || sourceToken.includes("google")) {
    return "google";
  }

  if (VRBO_TOKENS.has(selectedToken) || VRBO_TOKENS.has(sourceToken)) {
    return "vrbo";
  }

  if (!selected) {
    return "unknown";
  }

  return selected.toLowerCase();
}

export function normalizeReservationStatus(value: string | null | undefined): string {
  return normalizeText(value).toLowerCase().replace(/\s+/g, "");
}

export function expandChannelFilterValues(channels: string[]): string[] {
  const output = new Set<string>();

  for (const value of channels) {
    const normalized = normalizeReservationChannel({ channel: value });
    const aliases = CHANNEL_ALIAS_MAP[normalized];
    if (aliases) {
      for (const alias of aliases) {
        output.add(alias.toLowerCase());
      }
      continue;
    }

    output.add(normalized.toLowerCase());
  }

  return [...output];
}

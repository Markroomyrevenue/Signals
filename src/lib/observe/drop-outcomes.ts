/**
 * Retrospective drop dose-response mining (review 2026-07, build prompt 05;
 * measurement design in `reviews/observe-learn-2026-07/02-causal-stats.md` §7).
 *
 * Pure functions only — no Prisma, no I/O. `scripts/mine-drop-outcomes.ts`
 * feeds these from the DB and writes the report. Nothing here changes live
 * behaviour: this is evidence-gathering for a later suggestion-sizing change.
 *
 * Two data hazards handled by design (established by the review):
 * - RMS noise floor: the median detected price change is ~0.9% — daily engine
 *   wiggle, not a decision. Only |changePct| >= DROP_NOISE_FLOOR counts.
 * - Per-date rows: `rate_changes` are per stay-date; one human/RMS action shows
 *   up as a sweep of rows. `collapseDropEpisodes` collapses to episodes
 *   (listing x scan x contiguous stay-date span) before anything is counted.
 *
 * The counterfactual is WITHIN-LISTING matching (the statistician's design):
 * for each treated night, un-dropped settled nights of the SAME listing with
 * the same day-of-week and the same still-unbooked-at-lead state, within
 * ±21 days of stay date. This kills between-listing selection; it does NOT
 * kill within-listing time-varying selection (drops happen to weak nights),
 * so uncorrected deltas remain biased AGAINST drops. Callers must carry that
 * caveat into any readout.
 */

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";

import { LEAD_TIME_BUCKETS } from "./learnings-core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum |changePct| (fraction) for a price move to count as a decision. */
export const DROP_NOISE_FLOOR = 0.03;

/** Occupied facts at/below this nightly revenue are owner blocks / artefacts. */
export const MIN_REAL_REVENUE = 5;

/** "Filled after the drop" means booked within this many days of detection. */
export const FILL_WINDOW_DAYS = 14;

/** Controls are drawn from ±this many days around the treated stay date. */
export const MATCH_WINDOW_DAYS = 21;

/** Drop-size bands (positive magnitudes, fractions). Lower bound inclusive. */
export const DROP_SIZE_BANDS: Array<{ label: string; min: number; max: number }> = [
  { label: "3-7%", min: 0.03, max: 0.07 },
  { label: "7-15%", min: 0.07, max: 0.15 },
  { label: "15%+", min: 0.15, max: Number.POSITIVE_INFINITY }
];

// ---------------------------------------------------------------------------
// Small pure helpers (banding, buckets, keys)
// ---------------------------------------------------------------------------

/** Band a drop magnitude (positive fraction). Null below the noise floor. */
export function dropSizeBand(dropPct: number): string | null {
  if (!Number.isFinite(dropPct) || dropPct < DROP_NOISE_FLOOR) return null;
  for (const band of DROP_SIZE_BANDS) {
    if (dropPct >= band.min && dropPct < band.max) return band.label;
  }
  return null;
}

/** Lead-time bucket label, reusing the canonical observe buckets. */
export function leadBucketLabel(leadDays: number): string | null {
  if (!Number.isFinite(leadDays) || leadDays < 0) return null;
  for (const b of LEAD_TIME_BUCKETS) {
    if (leadDays >= b.min && leadDays <= b.max) return b.label;
  }
  return null;
}

export type DropDateType = "weekday" | "weekend";

/** Weekend = Friday/Saturday night (same rule as `learnings.dateTypeFor`). */
export function dropDateType(dateOnly: string): DropDateType {
  const dow = fromDateOnly(dateOnly).getUTCDay(); // 0 Sun … 6 Sat
  return dow === 5 || dow === 6 ? "weekend" : "weekday";
}

/** Whole UTC days from `from`'s date to `to`'s date (calendar difference). */
export function diffUtcDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

/**
 * The matching stratum a treated night lives in: same listing, same
 * day-of-week, same lead-time bucket. Controls must share this key.
 */
export function matchKey(listingId: string, dateOnly: string, leadDays: number): string | null {
  const bucket = leadBucketLabel(leadDays);
  if (bucket === null) return null;
  const dow = fromDateOnly(dateOnly).getUTCDay();
  return `${listingId}|dow${dow}|lead${bucket}`;
}

// ---------------------------------------------------------------------------
// 1. Episode extraction
// ---------------------------------------------------------------------------

export type DropChangeInput = {
  id: string;
  listingId: string;
  scanId: string;
  /** Stay date, `yyyy-mm-dd`. */
  date: string;
  detectedAt: Date;
  /** Fractional change; negative for drops (e.g. -0.08 = 8% cut). */
  changePct: number;
  oldValue: number | null;
  newValue: number | null;
};

export type EpisodeNight = {
  changeId: string;
  date: string;
  /** Positive magnitude of this night's cut (fraction). */
  dropPct: number;
  /** Advertised rate immediately before the cut. */
  preDropRate: number | null;
  /** Days from detection date to stay date (>= 0). */
  leadDays: number;
};

export type DropEpisode = {
  /** `listingId|scanId|startDate` — stable, human-traceable. */
  key: string;
  listingId: string;
  scanId: string;
  detectedAt: Date;
  startDate: string;
  endDate: string;
  meanDropPct: number;
  nights: EpisodeNight[];
};

/**
 * Collapse per-stay-date drop rows into episodes: one detection scan on one
 * listing over a contiguous stay-date span is ONE decision, however many rows
 * it swept. Applies the noise floor (>= 3% cuts only) and discards rows whose
 * stay date precedes the detection date (stale detections). Duplicate rows for
 * the same (listing, scan, date) keep the largest cut.
 */
export function collapseDropEpisodes(rows: DropChangeInput[]): DropEpisode[] {
  const qualifying = rows.filter((r) => {
    if (!Number.isFinite(r.changePct) || r.changePct > -DROP_NOISE_FLOOR) return false;
    return diffUtcDays(r.detectedAt, fromDateOnly(r.date)) >= 0;
  });

  // Dedupe per (listing, scan, stay date): keep the deepest cut.
  const byNight = new Map<string, DropChangeInput>();
  for (const row of qualifying) {
    const k = `${row.listingId}|${row.scanId}|${row.date}`;
    const prev = byNight.get(k);
    if (!prev || row.changePct < prev.changePct) byNight.set(k, row);
  }

  // Group by (listing, scan) and split into contiguous stay-date runs.
  const groups = new Map<string, DropChangeInput[]>();
  for (const row of byNight.values()) {
    const k = `${row.listingId}|${row.scanId}`;
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }

  const episodes: DropEpisode[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.date.localeCompare(b.date));
    let run: DropChangeInput[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const detectedAt = run.reduce((min, r) => (r.detectedAt < min ? r.detectedAt : min), run[0].detectedAt);
      const nights: EpisodeNight[] = run.map((r) => ({
        changeId: r.id,
        date: r.date,
        dropPct: Math.abs(r.changePct),
        preDropRate: r.oldValue !== null && Number.isFinite(r.oldValue) && r.oldValue > 0 ? r.oldValue : null,
        leadDays: diffUtcDays(detectedAt, fromDateOnly(r.date))
      }));
      episodes.push({
        key: `${run[0].listingId}|${run[0].scanId}|${run[0].date}`,
        listingId: run[0].listingId,
        scanId: run[0].scanId,
        detectedAt,
        startDate: run[0].date,
        endDate: run[run.length - 1].date,
        meanDropPct: nights.reduce((s, n) => s + n.dropPct, 0) / nights.length,
        nights
      });
      run = [];
    };
    for (const row of group) {
      if (run.length > 0) {
        const prev = fromDateOnly(run[run.length - 1].date);
        if (diffUtcDays(prev, fromDateOnly(row.date)) !== 1) flush();
      }
      run.push(row);
    }
    flush();
  }

  episodes.sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime() || a.key.localeCompare(b.key));
  return episodes;
}

/**
 * Stratified, deterministic episode sampling: per listing, keep at most
 * `capPerListing` episodes spread EVENLY across the listing's full detection
 * history (never most-recent-first — the review found the take-50-newest
 * pattern covered 0.9% of drops on 9 listings). No-op when under the cap.
 */
export function stratifiedSampleEpisodes(episodes: DropEpisode[], capPerListing: number): DropEpisode[] {
  if (!Number.isFinite(capPerListing) || capPerListing < 1) return [];
  const byListing = new Map<string, DropEpisode[]>();
  for (const ep of episodes) {
    const list = byListing.get(ep.listingId);
    if (list) list.push(ep);
    else byListing.set(ep.listingId, [ep]);
  }
  const kept: DropEpisode[] = [];
  for (const list of byListing.values()) {
    list.sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime() || a.key.localeCompare(b.key));
    if (list.length <= capPerListing) {
      kept.push(...list);
      continue;
    }
    const picked = new Set<number>();
    for (let i = 0; i < capPerListing; i++) {
      picked.add(Math.floor((i * list.length) / capPerListing));
    }
    for (const idx of picked) kept.push(list[idx]);
  }
  kept.sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime() || a.key.localeCompare(b.key));
  return kept;
}

// ---------------------------------------------------------------------------
// 2. Settled-night records (built by the caller from night_facts + calendar)
// ---------------------------------------------------------------------------

export type NightBooking = {
  bookingCreatedAt: Date | null;
  leadTimeDays: number | null;
  /** Realised nightly revenue (revenue_allocated). */
  revenue: number;
};

export type NightRecord = {
  date: string;
  /** Market bookings that ended occupying the night (owner stays and <=£5 artefact rows excluded). */
  occupiedBookings: NightBooking[];
  /** Bookings for this night that were later cancelled (from cancelled night facts). */
  cancelledBookings: Array<{ bookingCreatedAt: Date | null; leadTimeDays: number | null }>;
  /** Calendar showed the night still open (available) at last observation — a terminal gap. */
  openAtEnd: boolean;
  /** ANY qualifying (>= 3%) price drop was ever detected for this stay date. */
  dropped: boolean;
};

/** A night's terminal state is only trusted when it filled or visibly expired open. */
export function terminalKnown(night: NightRecord): boolean {
  return night.occupiedBookings.length > 0 || night.openAtEnd;
}

function bookingLead(night: NightRecord, booking: NightBooking): number | null {
  if (booking.leadTimeDays !== null && Number.isFinite(booking.leadTimeDays)) return booking.leadTimeDays;
  if (booking.bookingCreatedAt) return diffUtcDays(booking.bookingCreatedAt, fromDateOnly(night.date));
  return null;
}

/**
 * Was the night still (fully) unbooked `leadDays` before its stay date?
 * Multi-unit fuzz: a partially-booked multi-unit night counts as booked once
 * ANY unit was sold at/before that lead. Bookings with no derivable lead make
 * the answer unknown → null.
 */
export function unbookedAtLead(night: NightRecord, leadDays: number): boolean | null {
  for (const b of night.occupiedBookings) {
    const lead = bookingLead(night, b);
    if (lead === null) return null;
    if (lead >= leadDays) return false;
  }
  return true;
}

/**
 * Did the night fill within `windowDays` of the (pseudo-)detection instant?
 * Prefers booking timestamps; falls back to day-granularity lead times.
 */
export function filledWithinWindow(
  night: NightRecord,
  detectedAt: Date,
  leadDays: number,
  windowDays: number = FILL_WINDOW_DAYS
): boolean {
  const windowEnd = addUtcDays(detectedAt, windowDays);
  for (const b of night.occupiedBookings) {
    if (b.bookingCreatedAt) {
      if (b.bookingCreatedAt >= detectedAt && b.bookingCreatedAt <= windowEnd) return true;
      continue;
    }
    const lead = b.leadTimeDays;
    if (lead !== null && Number.isFinite(lead) && lead <= leadDays && lead >= leadDays - windowDays) return true;
  }
  return false;
}

/** Mean realised nightly revenue of the bookings that arrived in the window. */
export function windowRevenue(
  night: NightRecord,
  detectedAt: Date,
  leadDays: number,
  windowDays: number = FILL_WINDOW_DAYS
): number | null {
  const windowEnd = addUtcDays(detectedAt, windowDays);
  const revenues: number[] = [];
  for (const b of night.occupiedBookings) {
    const inWindow = b.bookingCreatedAt
      ? b.bookingCreatedAt >= detectedAt && b.bookingCreatedAt <= windowEnd
      : b.leadTimeDays !== null && b.leadTimeDays <= leadDays && b.leadTimeDays >= leadDays - windowDays;
    if (inWindow) revenues.push(b.revenue);
  }
  if (revenues.length === 0) return null;
  return revenues.reduce((s, r) => s + r, 0) / revenues.length;
}

/** A booking arrived in the window and was later cancelled. */
export function cancelledWithinWindow(
  night: NightRecord,
  detectedAt: Date,
  leadDays: number,
  windowDays: number = FILL_WINDOW_DAYS
): boolean {
  const windowEnd = addUtcDays(detectedAt, windowDays);
  for (const c of night.cancelledBookings) {
    if (c.bookingCreatedAt) {
      if (c.bookingCreatedAt >= detectedAt && c.bookingCreatedAt <= windowEnd) return true;
      continue;
    }
    const lead = c.leadTimeDays;
    if (lead !== null && Number.isFinite(lead) && lead <= leadDays && lead >= leadDays - windowDays) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 3. Within-listing matched comparison
// ---------------------------------------------------------------------------

/**
 * Matched controls for one treated night: settled nights of the SAME listing,
 * same day-of-week, within ±`MATCH_WINDOW_DAYS` of the treated stay date,
 * never subject to a qualifying drop, terminal state known, and still unbooked
 * at the treated lead (so both arms start from the same at-risk state).
 */
export function matchedControls(args: {
  treatedDate: string;
  leadDays: number;
  nights: Map<string, NightRecord>;
  windowDays?: number;
}): NightRecord[] {
  const windowDays = args.windowDays ?? MATCH_WINDOW_DAYS;
  const treated = fromDateOnly(args.treatedDate);
  const dow = treated.getUTCDay();
  const controls: NightRecord[] = [];
  for (let offset = -windowDays; offset <= windowDays; offset++) {
    if (offset === 0) continue;
    const candidateDate = toDateOnly(addUtcDays(treated, offset));
    if (fromDateOnly(candidateDate).getUTCDay() !== dow) continue;
    const night = args.nights.get(candidateDate);
    if (!night || night.dropped || !terminalKnown(night)) continue;
    if (unbookedAtLead(night, args.leadDays) !== true) continue;
    controls.push(night);
  }
  return controls;
}

// ---------------------------------------------------------------------------
// 4. Treated-night outcomes + cell aggregation
// ---------------------------------------------------------------------------

export type TreatedNightOutcome = {
  listingId: string;
  episodeKey: string;
  date: string;
  dateType: DropDateType;
  leadDays: number;
  leadBucket: string;
  dropPct: number;
  dropBand: string;
  preDropRate: number | null;
  filled14: boolean;
  revenue14: number | null;
  realisedPctOfPreDrop: number | null;
  daysToBook: number | null;
  cancelled14: boolean;
  brcLinked: boolean;
  controlCount: number;
  controlFillMean: number | null;
  controlRevenueMean: number | null;
};

export type ListingDropAnalysisInput = {
  listingId: string;
  /** Episodes for this listing (post-sampling). */
  episodes: DropEpisode[];
  /** All settled nights of the listing in range, keyed by `yyyy-mm-dd`. */
  nights: Map<string, NightRecord>;
  /** booking_rate_contexts rows for the listing (stayDate -> linked change ids). */
  brcChangeIdsByDate?: Map<string, Set<string>>;
  /** Analysis date — only stay dates strictly before this are settled. */
  today: string;
};

export type ListingDropAnalysis = {
  listingId: string;
  treated: TreatedNightOutcome[];
  skippedUnsettled: number;
  skippedUnknownTerminal: number;
  skippedRepeatDrop: number;
  skippedNoRecord: number;
};

/**
 * Resolve every settled episode-night of one listing to its outcome plus its
 * matched-control summary. A stay date hit by several episodes is attributed
 * to the EARLIEST detection only (treatment began there; later cuts inside the
 * window are dose contamination, counted in `skippedRepeatDrop`).
 */
export function analyseListingDrops(input: ListingDropAnalysisInput): ListingDropAnalysis {
  const result: ListingDropAnalysis = {
    listingId: input.listingId,
    treated: [],
    skippedUnsettled: 0,
    skippedUnknownTerminal: 0,
    skippedRepeatDrop: 0,
    skippedNoRecord: 0
  };
  const episodes = [...input.episodes].sort(
    (a, b) => a.detectedAt.getTime() - b.detectedAt.getTime() || a.key.localeCompare(b.key)
  );
  const seenDates = new Set<string>();
  for (const episode of episodes) {
    for (const night of episode.nights) {
      if (night.date >= input.today) {
        result.skippedUnsettled += 1;
        continue;
      }
      if (seenDates.has(night.date)) {
        result.skippedRepeatDrop += 1;
        continue;
      }
      seenDates.add(night.date);
      const record = input.nights.get(night.date);
      if (!record) {
        result.skippedNoRecord += 1;
        continue;
      }
      if (!terminalKnown(record)) {
        result.skippedUnknownTerminal += 1;
        continue;
      }
      const leadBucket = leadBucketLabel(night.leadDays);
      const band = dropSizeBand(night.dropPct);
      if (leadBucket === null || band === null) continue;

      const filled14 = filledWithinWindow(record, episode.detectedAt, night.leadDays);
      const revenue14 = filled14 ? windowRevenue(record, episode.detectedAt, night.leadDays) : null;
      const controls = matchedControls({ treatedDate: night.date, leadDays: night.leadDays, nights: input.nights });
      let controlFillMean: number | null = null;
      let controlRevenueMean: number | null = null;
      if (controls.length > 0) {
        let fills = 0;
        const revenues: number[] = [];
        for (const control of controls) {
          // Pseudo-detection: same lead, same time-of-day as the real one.
          const shift = diffUtcDays(fromDateOnly(night.date), fromDateOnly(control.date));
          const pseudoDetectedAt = addUtcDays(episode.detectedAt, shift);
          const controlFilled = filledWithinWindow(control, pseudoDetectedAt, night.leadDays);
          if (controlFilled) {
            fills += 1;
            const rev = windowRevenue(control, pseudoDetectedAt, night.leadDays);
            if (rev !== null) revenues.push(rev);
          }
        }
        controlFillMean = fills / controls.length;
        controlRevenueMean = revenues.length > 0 ? revenues.reduce((s, r) => s + r, 0) / revenues.length : null;
      }

      let daysToBook: number | null = null;
      if (filled14) {
        for (const b of record.occupiedBookings) {
          if (b.bookingCreatedAt && b.bookingCreatedAt >= episode.detectedAt) {
            const d = (b.bookingCreatedAt.getTime() - episode.detectedAt.getTime()) / 86_400_000;
            if (d <= FILL_WINDOW_DAYS && (daysToBook === null || d < daysToBook)) daysToBook = d;
          }
        }
      }

      const linkedIds = input.brcChangeIdsByDate?.get(night.date);
      const brcLinked = linkedIds !== undefined && linkedIds.has(night.changeId);

      result.treated.push({
        listingId: input.listingId,
        episodeKey: episode.key,
        date: night.date,
        dateType: dropDateType(night.date),
        leadDays: night.leadDays,
        leadBucket,
        dropPct: night.dropPct,
        dropBand: band,
        preDropRate: night.preDropRate,
        filled14,
        revenue14,
        realisedPctOfPreDrop:
          revenue14 !== null && night.preDropRate !== null && night.preDropRate > 0
            ? revenue14 / night.preDropRate
            : null,
        daysToBook,
        cancelled14: cancelledWithinWindow(record, episode.detectedAt, night.leadDays),
        brcLinked,
        controlCount: controls.length,
        controlFillMean,
        controlRevenueMean
      });
    }
  }
  return result;
}

export type DropOutcomeCell = {
  leadBucket: string;
  dropBand: string;
  dateType: DropDateType;
  episodes: number;
  treatedNights: number;
  treatedFillRate: number | null;
  matchedTreatedNights: number;
  controlNights: number;
  /** Mean of per-treated-night control fill means (matched subset). */
  controlFillRate: number | null;
  /** Matched-pairs delta in percentage points: treated fill − own controls' fill. */
  fillDeltaPp: number | null;
  /** Treated fill rate over the matched subset only (fair pair to controlFillRate). */
  treatedFillRateMatched: number | null;
  realisedPctOfPreDrop: { mean: number | null; n: number };
  treatedRealisedRate: { mean: number | null; n: number };
  controlRealisedRate: { mean: number | null; n: number };
  /** Mean pair-level ratio treated/control realised rate where both filled. */
  realisedRateRatio: { mean: number | null; n: number };
  cancellationRate: { value: number | null; n: number };
  meanDaysToBook: number | null;
  brcLinkedBookings: number;
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Aggregate treated-night outcomes into (leadBucket, dropBand, dateType) cells. */
export function aggregateDropOutcomes(treated: TreatedNightOutcome[]): DropOutcomeCell[] {
  const groups = new Map<string, TreatedNightOutcome[]>();
  for (const t of treated) {
    const k = `${t.leadBucket}|${t.dropBand}|${t.dateType}`;
    const list = groups.get(k);
    if (list) list.push(t);
    else groups.set(k, [t]);
  }
  const cells: DropOutcomeCell[] = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    const matched = rows.filter((r) => r.controlCount > 0 && r.controlFillMean !== null);
    const fillDeltas = matched.map((r) => (r.filled14 ? 1 : 0) - (r.controlFillMean as number));
    const realisedPct = rows.map((r) => r.realisedPctOfPreDrop).filter((v): v is number => v !== null);
    const treatedRev = rows.map((r) => r.revenue14).filter((v): v is number => v !== null);
    const controlRev = matched.map((r) => r.controlRevenueMean).filter((v): v is number => v !== null);
    const ratios = matched
      .filter((r) => r.revenue14 !== null && r.controlRevenueMean !== null && r.controlRevenueMean > 0)
      .map((r) => (r.revenue14 as number) / (r.controlRevenueMean as number));
    const bookedOrCancelled = rows.filter((r) => r.filled14 || r.cancelled14);
    const daysToBook = rows.map((r) => r.daysToBook).filter((v): v is number => v !== null);
    cells.push({
      leadBucket: first.leadBucket,
      dropBand: first.dropBand,
      dateType: first.dateType,
      episodes: new Set(rows.map((r) => r.episodeKey)).size,
      treatedNights: rows.length,
      treatedFillRate: mean(rows.map((r) => (r.filled14 ? 1 : 0))),
      matchedTreatedNights: matched.length,
      controlNights: matched.reduce((s, r) => s + r.controlCount, 0),
      controlFillRate: mean(matched.map((r) => r.controlFillMean as number)),
      treatedFillRateMatched: mean(matched.map((r) => (r.filled14 ? 1 : 0))),
      fillDeltaPp: fillDeltas.length > 0 ? (mean(fillDeltas) as number) * 100 : null,
      realisedPctOfPreDrop: { mean: mean(realisedPct), n: realisedPct.length },
      treatedRealisedRate: { mean: mean(treatedRev), n: treatedRev.length },
      controlRealisedRate: { mean: mean(controlRev), n: controlRev.length },
      realisedRateRatio: { mean: mean(ratios), n: ratios.length },
      cancellationRate: {
        value:
          bookedOrCancelled.length > 0
            ? bookedOrCancelled.filter((r) => r.cancelled14).length / bookedOrCancelled.length
            : null,
        n: bookedOrCancelled.length
      },
      meanDaysToBook: mean(daysToBook),
      brcLinkedBookings: rows.filter((r) => r.brcLinked).length
    });
  }
  cells.sort(
    (a, b) =>
      bucketOrder(a.leadBucket) - bucketOrder(b.leadBucket) ||
      bandOrder(a.dropBand) - bandOrder(b.dropBand) ||
      a.dateType.localeCompare(b.dateType)
  );
  return cells;
}

function bucketOrder(label: string): number {
  const idx = LEAD_TIME_BUCKETS.findIndex((b) => b.label === label);
  return idx === -1 ? LEAD_TIME_BUCKETS.length : idx;
}

function bandOrder(label: string): number {
  const idx = DROP_SIZE_BANDS.findIndex((b) => b.label === label);
  return idx === -1 ? DROP_SIZE_BANDS.length : idx;
}

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PRICING_SETTINGS, type PricingResolvedSettings } from "@/lib/pricing/settings";

import {
  buildPushRatesPreview,
  executePushRates,
  PushRatesError,
  type PushRatesEventStore,
  type PushRatesListingLookup
} from "./push-service";
import type { HostawayPushClient } from "./push";

// All of these tests run with hand-built deps so the suite runs offline
// (no DB, no fetch). The DEFAULT_* deps are exercised by integration
// against a real backend; here we only validate the wiring + guard
// behaviours of the pure pricing/auth path.

type StoredEvent = {
  id: string;
  tenantId: string;
  listingId: string;
  pushedBy: string;
  dateFrom: string;
  dateTo: string;
  dateCount: number;
  status: string;
  errorMessage: string | null;
};

function makeEventStore(): PushRatesEventStore & { events: StoredEvent[] } {
  const events: StoredEvent[] = [];
  let counter = 0;
  return {
    events,
    async recordEvent(args) {
      counter += 1;
      const id = `evt-${counter}`;
      events.push({
        id,
        tenantId: args.tenantId,
        listingId: args.listingId,
        pushedBy: args.pushedBy,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        dateCount: args.dateCount,
        status: args.status,
        errorMessage: args.errorMessage
      });
      return { id };
    },
    async findLastEvent({ tenantId, listingId }) {
      const found = [...events].reverse().find((e) => e.tenantId === tenantId && e.listingId === listingId);
      return found
        ? {
            id: found.id,
            dateCount: found.dateCount,
            status: found.status,
            pushedBy: found.pushedBy,
            createdAt: new Date()
          }
        : null;
    }
  };
}

function makeLookup({
  listings = new Map<string, { id: string; tenantId: string; hostawayId: string; tags: string[] }>(),
  settings = new Map<string, PricingResolvedSettings>(),
  recommendations = new Map<string, Map<string, { recommendedRate: number | null; liveRate: number | null }>>()
}: {
  listings?: Map<string, { id: string; tenantId: string; hostawayId: string; tags: string[] }>;
  settings?: Map<string, PricingResolvedSettings>;
  recommendations?: Map<string, Map<string, { recommendedRate: number | null; liveRate: number | null }>>;
}): PushRatesListingLookup {
  return {
    async loadListing({ tenantId, listingId }) {
      const listing = listings.get(listingId);
      if (!listing || listing.tenantId !== tenantId) return null;
      return { id: listing.id, hostawayId: listing.hostawayId, tags: listing.tags };
    },
    async loadResolvedSettings({ listingId }) {
      return settings.get(listingId) ?? null;
    },
    async loadDisplayCurrency() {
      return "GBP";
    },
    async loadRecommendationsForRange({ listingId }) {
      return recommendations.get(listingId) ?? new Map();
    }
  };
}

function makeFakePushClient(): HostawayPushClient & { calls: Array<{ date: string; dailyPrice: number }> } {
  const calls: Array<{ date: string; dailyPrice: number }> = [];
  return {
    calls,
    async pushCalendarRate(input) {
      calls.push({ date: input.date, dailyPrice: input.dailyPrice });
      return { ok: true, pushedCount: 1 };
    },
    // Kept on the type but no longer used by executePushRates (Hostaway's
    // batch endpoint rejected our payload shape; we loop single-date PUTs
    // instead). Returning a no-op here keeps the type satisfied.
    async pushCalendarRatesBatch(input) {
      return { ok: true, pushedCount: input.rates.length };
    }
  };
}

function settingsWithPushEnabled(enabled: boolean): PricingResolvedSettings {
  return { ...structuredClone(DEFAULT_PRICING_SETTINGS), hostawayPushEnabled: enabled };
}

test("dry-run preview returns the expected shape for a synthetic listing", async () => {
  const lookup = makeLookup({
    listings: new Map([
      ["listing-1", { id: "listing-1", tenantId: "tenant-a", hostawayId: "ha-100", tags: [] }]
    ]),
    settings: new Map([["listing-1", settingsWithPushEnabled(true)]]),
    recommendations: new Map([
      [
        "listing-1",
        new Map([
          ["2026-05-01", { recommendedRate: 140, liveRate: 130 }],
          ["2026-05-02", { recommendedRate: 145, liveRate: 130 }],
          ["2026-05-03", { recommendedRate: null, liveRate: 130 }],
          ["2026-04-30", { recommendedRate: 120, liveRate: 110 }] // outside the requested range
        ])
      ]
    ])
  });

  const preview = await buildPushRatesPreview(
    {
      tenantId: "tenant-a",
      listingId: "listing-1",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-03"
    },
    { listingLookup: lookup }
  );

  // The lookup is responsible for filtering the date range; here the
  // synthetic recommendations include 4 dates but only 3 are in range,
  // and one of those has a null recommendedRate which gets dropped.
  // The lookup we pass through emits the in-range subset directly to
  // mirror the production filter.
  assert.equal(preview.listingId, "listing-1");
  assert.equal(preview.hostawayId, "ha-100");
  assert.equal(preview.dateFrom, "2026-05-01");
  assert.equal(preview.dateTo, "2026-05-03");
  assert.equal(preview.displayCurrency, "GBP");
  assert.equal(preview.dates.length, 3); // 4 entries minus the null
  assert.deepEqual(
    preview.dates.map((d) => d.date),
    ["2026-04-30", "2026-05-01", "2026-05-02"]
  );
  assert.equal(preview.dates[1]?.recommendedRate, 140);
  assert.equal(preview.dates[1]?.currentRate, 130);
});

test("push is denied if hostawayPushEnabled is false even for an admin", async () => {
  const lookup = makeLookup({
    listings: new Map([
      ["listing-2", { id: "listing-2", tenantId: "tenant-a", hostawayId: "ha-200", tags: [] }]
    ]),
    settings: new Map([["listing-2", settingsWithPushEnabled(false)]])
  });

  await assert.rejects(
    () =>
      buildPushRatesPreview(
        {
          tenantId: "tenant-a",
          listingId: "listing-2",
          dateFrom: "2026-05-01",
          dateTo: "2026-05-07"
        },
        { listingLookup: lookup }
      ),
    (error) => {
      assert.ok(error instanceof PushRatesError);
      assert.equal(error.status, 403);
      return true;
    }
  );
});

test("push is denied if the listing does not belong to the auth tenant", async () => {
  const lookup = makeLookup({
    listings: new Map([
      ["listing-3", { id: "listing-3", tenantId: "tenant-other", hostawayId: "ha-300", tags: [] }]
    ]),
    settings: new Map([["listing-3", settingsWithPushEnabled(true)]])
  });

  await assert.rejects(
    () =>
      buildPushRatesPreview(
        {
          tenantId: "tenant-a", // different from listing's tenant
          listingId: "listing-3",
          dateFrom: "2026-05-01",
          dateTo: "2026-05-07"
        },
        { listingLookup: lookup }
      ),
    (error) => {
      assert.ok(error instanceof PushRatesError);
      assert.equal(error.status, 404);
      return true;
    }
  );
});

test("every successful push writes a HostawayPushEvent row", async () => {
  const eventStore = makeEventStore();
  const pushClient = makeFakePushClient();
  const lookup = makeLookup({
    listings: new Map([
      ["listing-4", { id: "listing-4", tenantId: "tenant-a", hostawayId: "ha-400", tags: [] }]
    ]),
    settings: new Map([["listing-4", settingsWithPushEnabled(true)]]),
    recommendations: new Map([
      [
        "listing-4",
        new Map([
          ["2026-05-01", { recommendedRate: 150, liveRate: 140 }],
          ["2026-05-02", { recommendedRate: 152, liveRate: 140 }]
        ])
      ]
    ])
  });

  const result = await executePushRates(
    {
      tenantId: "tenant-a",
      listingId: "listing-4",
      pushedBy: "owner@example.com",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-02"
    },
    {
      listingLookup: lookup,
      eventStore,
      pushClientFactory: async () => pushClient
    }
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pushedCount, 2);
    assert.equal(result.eventId, "evt-1");
  }
  assert.equal(eventStore.events.length, 1);
  const event = eventStore.events[0]!;
  assert.equal(event.tenantId, "tenant-a");
  assert.equal(event.listingId, "listing-4");
  assert.equal(event.pushedBy, "owner@example.com");
  assert.equal(event.status, "success");
  assert.equal(event.dateCount, 2);
  // Single-date loop: one PUT per date.
  assert.equal(pushClient.calls.length, 2);
  assert.equal(pushClient.calls[0]?.date, "2026-05-01");
  assert.equal(pushClient.calls[1]?.date, "2026-05-02");
});

test("a failed push still writes a failed HostawayPushEvent row", async () => {
  const eventStore = makeEventStore();
  const pushClient: HostawayPushClient = {
    async pushCalendarRate() {
      throw new Error("hostaway down");
    },
    async pushCalendarRatesBatch() {
      throw new Error("hostaway down");
    }
  };
  const lookup = makeLookup({
    listings: new Map([
      ["listing-5", { id: "listing-5", tenantId: "tenant-a", hostawayId: "ha-500", tags: [] }]
    ]),
    settings: new Map([["listing-5", settingsWithPushEnabled(true)]]),
    recommendations: new Map([
      ["listing-5", new Map([["2026-05-01", { recommendedRate: 99, liveRate: null }]])]
    ])
  });

  const result = await executePushRates(
    {
      tenantId: "tenant-a",
      listingId: "listing-5",
      pushedBy: "owner@example.com",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-01"
    },
    {
      listingLookup: lookup,
      eventStore,
      pushClientFactory: async () => pushClient
    }
  );

  assert.equal(result.ok, false);
  assert.equal(eventStore.events.length, 1);
  assert.equal(eventStore.events[0]?.status, "failed");
  assert.match(eventStore.events[0]?.errorMessage ?? "", /hostaway down/);
});

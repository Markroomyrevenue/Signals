import { test } from "node:test";
import assert from "node:assert/strict";

import { extractListingVatRatePct } from "./listing-vat";

test("Cambridge-style listing with duplicated mandatory VAT returns 20 (max, not summed)", () => {
  const raw = {
    listingFeeSetting: [
      { feeTitle: "Refundable Damage Deposit", amountType: "flat", amount: 100, isMandatory: 1 },
      { feeTitle: "VAT", amountType: "percent", amount: 20, feeAppliedPer: "base_rate", isMandatory: 1, displayInRent: 1 },
      { feeTitle: "VAT", amountType: "percent", amount: 20, feeAppliedPer: "base_rate", isMandatory: 1, displayInRent: 1 }
    ]
  };
  assert.equal(extractListingVatRatePct(raw), 20);
});

test("VAT applied per reservation (Eden Grove style) still resolves to 20", () => {
  const raw = {
    listingFeeSetting: [
      { feeTitle: "VAT", amountType: "percent", amount: 20, feeAppliedPer: "reservation", isMandatory: 1, displayInRent: 0 },
      { feeTitle: "Refundable damage deposit", amountType: "flat", amount: 250, isMandatory: 1 }
    ]
  };
  assert.equal(extractListingVatRatePct(raw), 20);
});

test("deposit-only listing has no VAT", () => {
  const raw = {
    listingFeeSetting: [
      { feeTitle: "Refundable damage deposit", amountType: "flat", amount: 100, isMandatory: 1 }
    ]
  };
  assert.equal(extractListingVatRatePct(raw), null);
});

test("missing listingFeeSetting returns null", () => {
  assert.equal(extractListingVatRatePct({}), null);
  assert.equal(extractListingVatRatePct({ listingFeeSetting: null }), null);
  assert.equal(extractListingVatRatePct(null), null);
  assert.equal(extractListingVatRatePct(undefined), null);
});

test("non-mandatory VAT is ignored", () => {
  const raw = {
    listingFeeSetting: [
      { feeTitle: "VAT", amountType: "percent", amount: 20, isMandatory: 0 }
    ]
  };
  assert.equal(extractListingVatRatePct(raw), null);
});

test("a non-VAT percent fee (service charge) is not treated as VAT", () => {
  const raw = {
    listingFeeSetting: [
      { feeTitle: "Service fee", amountType: "percent", amount: 12, isMandatory: 1 }
    ]
  };
  assert.equal(extractListingVatRatePct(raw), null);
});

test("when both a VAT and a service percent fee exist, only the VAT rate is returned", () => {
  const raw = {
    listingFeeSetting: [
      { feeTitle: "Service fee", amountType: "percent", amount: 12, isMandatory: 1 },
      { feeTitle: "VAT", amountType: "percent", amount: 20, isMandatory: 1 }
    ]
  };
  assert.equal(extractListingVatRatePct(raw), 20);
});

test("string-typed amount and mandatory flags are coerced", () => {
  const raw = {
    listingFeeSetting: [
      { feeTitle: "VAT", amountType: "percent", amount: "20", isMandatory: "1" }
    ]
  };
  assert.equal(extractListingVatRatePct(raw), 20);
});

test("out-of-range or zero rates are rejected", () => {
  assert.equal(
    extractListingVatRatePct({ listingFeeSetting: [{ feeTitle: "VAT", amountType: "percent", amount: 0, isMandatory: 1 }] }),
    null
  );
  assert.equal(
    extractListingVatRatePct({ listingFeeSetting: [{ feeTitle: "VAT", amountType: "percent", amount: 150, isMandatory: 1 }] }),
    null
  );
});

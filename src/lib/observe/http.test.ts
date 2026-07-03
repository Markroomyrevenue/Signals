import assert from "node:assert/strict";
import test from "node:test";

import { observeResponse } from "./http";

test("observeResponse defaults to a JSON response", async () => {
  const res = observeResponse({ a: 1 }, null);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { a: 1 });
});

test("observeResponse format=text returns the same payload as text/plain", async () => {
  const res = observeResponse({ clients: [{ client: "Stay Belfast" }] }, "text");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  const body = await res.text();
  assert.deepEqual(JSON.parse(body), { clients: [{ client: "Stay Belfast" }] });
});

test("observeResponse format=html wraps the payload in an HTML page, escaped", async () => {
  const res = observeResponse({ client: "A & B <Ltd>" }, "html");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  const body = await res.text();
  assert.ok(body.startsWith("<!doctype html>"));
  assert.ok(body.includes("A &amp; B &lt;Ltd&gt;"));
  assert.ok(!body.includes("<Ltd>"));
});

test("observeResponse ignores unknown formats", async () => {
  const res = observeResponse({ a: 1 }, "csv");
  assert.equal(res.headers.get("content-type"), "application/json");
});

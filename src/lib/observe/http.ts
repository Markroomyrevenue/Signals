import { NextResponse } from "next/server";

/**
 * Response formatting shared by the key-gated observe routes
 * (`/api/observe/readout`, `/api/observe/suggestions`).
 *
 * Automated fetchers (the weekly Cowork check-in task) render
 * `application/json` bodies to an empty page, so two alternate formats exist
 * purely so scheduled read-only checks can see the data:
 *   - `?format=text` — the payload pretty-printed as `text/plain`.
 *   - `?format=html` — the same pretty-printed payload wrapped in a minimal
 *     HTML page (for fetchers that only render HTML documents).
 * The payload is identical in every mode — no extra fields, never a key.
 */
export function observeResponse(data: unknown, format: string | null): NextResponse {
  if (format === "text") {
    return new NextResponse(JSON.stringify(data, null, 2), {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
  if (format === "html") {
    const pretty = JSON.stringify(data, null, 2)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Observe readout</title></head><body><pre>${pretty}</pre></body></html>`;
    return new NextResponse(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
  return NextResponse.json(data);
}

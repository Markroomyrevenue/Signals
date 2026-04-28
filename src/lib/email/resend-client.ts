/**
 * Thin wrapper around the Resend HTTP API. Uses raw fetch so we don't have to
 * add a dependency on the resend SDK. Returns { messageId } on success.
 *
 * Configure via env: RESEND_API_KEY, TRIAL_REPORT_EMAIL_FROM, TRIAL_REPORT_EMAIL_TO.
 */

const RESEND_BASE = "https://api.resend.com";

export type ResendSendInput = {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
};

export type ResendSendResult = {
  messageId: string;
};

export async function resendSend(input: ResendSendInput): Promise<ResendSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");

  const res = await fetch(`${RESEND_BASE}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: input.from,
      to: Array.isArray(input.to) ? input.to : [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text
    })
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`Resend send failed (${res.status}): ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  }
  const id = (data as { id?: string } | null)?.id;
  return { messageId: id ?? "unknown" };
}

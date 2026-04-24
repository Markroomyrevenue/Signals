import crypto from "node:crypto";

function resolveKey(): Buffer {
  const raw = process.env.API_ENCRYPTION_KEY ?? process.env.NEXTAUTH_SECRET ?? "insecure-dev-key-change-me";

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  const base64Candidate = Buffer.from(raw, "base64");
  if (base64Candidate.length === 32) {
    return base64Candidate;
  }

  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptText(value: string): string {
  const key = resolveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptText(payload: string): string {
  const [ivHex, tagHex, encryptedHex] = payload.split(":");
  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error("Invalid encrypted payload");
  }

  const key = resolveKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

// Author: Harsha Gundala
// vault.ts — AES-256-GCM secrets vault for org env vars and MCP auth headers.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
  const hex = process.env.ENV_VAULT_MASTER_KEY;
  if (!hex || hex.length !== 64) throw new Error("ENV_VAULT_MASTER_KEY missing/invalid");
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(":");
}

export function decryptSecret(encoded: string): string {
  const [iv, tag, ct] = encoded.split(":").map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + Array.from(value, canonicalJson).join(",") + "]";
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  throw new Error("Canonical JSON requires finite JSON values");
}

export function digestBytes(bytes: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

export function digestJson(value: unknown): string { return digestBytes(canonicalJson(value)); }

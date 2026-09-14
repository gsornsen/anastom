import { createHash } from "node:crypto";

/**
 * Serialize JSON with sorted object keys and preserved array order for stable content digests.
 * @throws If a value contains undefined, non-finite numbers, sparse arrays, or non-plain objects.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + Array.from(value, canonicalJson).join(",") + "]";
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  }
  throw new Error("Canonical JSON requires finite JSON values");
}

/**
 * Return a sha256-prefixed hex digest of exact UTF-8 text or byte content.
 */
export function digestBytes(bytes: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/**
 * Digest canonical JSON; object insertion order does not affect the result.
 */
export function digestJson(value: unknown): string {
  return digestBytes(canonicalJson(value));
}

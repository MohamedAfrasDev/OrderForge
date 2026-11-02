import { createHash } from "node:crypto";

/** Lowercase hex SHA-256 of the UTF-8 bytes. Kept out of `domain/` so the domain stays free of Node imports. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

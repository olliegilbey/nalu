/**
 * Casual obfuscation of the MC correct-index sent to the client. NOT a
 * security primitive — a determined cheater can decode the base64 in their
 * browser console. The trade-off is intentional: keeping the correct answer
 * off the wire as plaintext deters trivial inspection, and bypassing it
 * costs the cheater their own learning. See spec §7.8.
 *
 * The questionId binding prevents replay across questions: an encoded value
 * from question A only decodes when paired with question A's id.
 */
export function encodeCorrect(questionId: string, index: number): string {
  return Buffer.from(`${questionId}:${index}`, "utf8").toString("base64");
}

/**
 * Decode a `correctEnc` blob bound to `questionId`. Returns the correct
 * index, or `null` if the blob is malformed, mismatched, or carries a
 * non-integer / negative payload.
 *
 * Split on the LAST `":"` so the binding holds even if `questionId` itself
 * contains colons (e.g. namespaced ids like `"baseline:q-1"`).
 */
export function decodeCorrect(questionId: string, encoded: string): number | null {
  // Node's `Buffer.from(_, "base64")` is lenient — it does not throw on
  // garbage input, it just yields garbage bytes. The downstream qid match
  // and `Number.isInteger` guard catch those cases, so no try/catch is
  // needed here.
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const sepIdx = decoded.lastIndexOf(":");
  if (sepIdx === -1) return null;
  const qid = decoded.slice(0, sepIdx);
  const idxStr = decoded.slice(sepIdx + 1);
  if (qid !== questionId) return null;
  const n = Number.parseInt(idxStr, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

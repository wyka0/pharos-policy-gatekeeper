/**
 * Exact decimal helpers for native PHRS (18 decimals).
 * All arithmetic is BigInt / string based — floating point is never used.
 */

const PHRS_DECIMALS = 18;

/** Parses a decimal PHRS amount (e.g. "0.001") into wei exactly. Rejects malformed input. */
export function parsePhrsToWei(value: string): bigint {
  if (typeof value !== "string") {
    throw new Error(`Invalid PHRS amount ${JSON.stringify(value)}: expected a decimal string`);
  }
  const trimmed = value.trim();
  const match = /^(\d+)(\.(\d{1,18}))?$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid PHRS amount "${trimmed}": use a plain decimal with at most ${PHRS_DECIMALS} fractional digits (e.g. "0.001"). Scientific notation, signs, thousands separators, and extra precision are rejected.`
    );
  }
  const intPart = match[1] ?? "0";
  const fracPart = (match[3] ?? "").padEnd(PHRS_DECIMALS, "0");
  const wei = BigInt(intPart + fracPart);
  if (wei <= 0n) {
    throw new Error(`Invalid PHRS amount "${trimmed}": must be greater than zero`);
  }
  return wei;
}

/** Formats a wei amount as a decimal PHRS string (exact, no floating point). */
export function formatWeiToPhrs(wei: bigint): string {
  const negative = wei < 0n;
  const digits = (negative ? -wei : wei).toString().padStart(PHRS_DECIMALS + 1, "0");
  const cut = digits.length - PHRS_DECIMALS;
  const intPart = digits.slice(0, cut);
  const fracPart = digits.slice(cut).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

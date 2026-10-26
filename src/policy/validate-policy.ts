/**
 * Strict, fail-closed policy validation.
 *
 * Missing, malformed, or invalid policy configuration prevents execution.
 * No permissive defaults are ever substituted.
 */
import { getAddress, isAddress } from "viem";
import type { AllowlistPolicy, Policy, SpendLimitPolicy, TimeWindow, TimeWindowPolicy } from "../types.js";

export class PolicyValidationError extends Error {
  override readonly name = "PolicyValidationError";
  readonly code = "POLICY_INVALID";
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid policy configuration (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${issues.join("; ")}`);
    this.issues = issues;
  }
}

/** Decimal integer string for wei. No sign, no decimals, no exponent, no leading zeros (single "0" allowed). */
export const WEI_PATTERN = /^(0|[1-9][0-9]*)$/;

/** "HH:mm" 24-hour clock. "24:00" is additionally allowed as an end-of-day value for window ends. */
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const END_OF_DAY = "24:00";

export function parseWeiAmount(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !WEI_PATTERN.test(value)) {
    throw new PolicyValidationError([
      `${label}: expected a decimal integer wei string (e.g. "1000000000000000000"), got ${describe(value)}`
    ]);
  }
  return BigInt(value);
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return Array.isArray(value) ? "an array" : "an object";
}

/** Validates EVM address syntax (including EIP-55 checksum when mixed-case) and returns the checksummed form. */
export function normalizeAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new PolicyValidationError([
      `${label}: invalid EVM address ${describe(value)} — expected 0x followed by 40 hex characters`
    ]);
  }
  if (!isAddress(value, { strict: true })) {
    throw new PolicyValidationError([
      `${label}: address ${value} has an invalid EIP-55 checksum (mixed-case input must match the checksum)`
    ]);
  }
  return getAddress(value);
}

export function parseTimeToMinutes(value: string, label: string, allowEndOfDay: boolean): number {
  const isEndOfDay = value === END_OF_DAY;
  if (isEndOfDay && allowEndOfDay) return 24 * 60;
  if (!TIME_PATTERN.test(value)) {
    throw new PolicyValidationError([
      `${label}: invalid time ${JSON.stringify(value)} — expected "HH:mm" in 24-hour local time${allowEndOfDay ? ' (or "24:00" for end of day)' : ""}`
    ]);
  }
  const [h, m] = value.split(":") as [string, string];
  return Number(h) * 60 + Number(m);
}

function assertAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[], label: string, issues: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      issues.push(`${label}: unknown key "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
}

function validateSpendLimit(raw: Record<string, unknown>, issues: string[]): SpendLimitPolicy {
  assertAllowedKeys(raw, ["maxAmountWei"], "spendLimit", issues);
  const max = parseWeiAmount(raw["maxAmountWei"], "spendLimit.maxAmountWei");
  if (max <= 0n) {
    issues.push("spendLimit.maxAmountWei: must be greater than zero (a zero limit would deny every action; remove the policy instead)");
  }
  return { maxAmountWei: max.toString() };
}

function validateAllowlist(raw: Record<string, unknown>, issues: string[]): AllowlistPolicy {
  assertAllowedKeys(raw, ["recipients", "contracts"], "allowlist", issues);
  const recipients: string[] = [];
  const contracts: string[] = [];
  const recRaw = raw["recipients"];
  const conRaw = raw["contracts"];
  if (!Array.isArray(recRaw)) {
    issues.push("allowlist.recipients: must be an array of addresses (may be empty, which denies all transfers)");
  } else {
    for (const [i, entry] of recRaw.entries()) {
      try {
        recipients.push(normalizeAddress(entry, `allowlist.recipients[${i}]`));
      } catch (err) {
        issues.push((err as PolicyValidationError).issues[0] ?? String(err));
      }
    }
  }
  if (!Array.isArray(conRaw)) {
    issues.push("allowlist.contracts: must be an array of addresses (may be empty, which denies all contract calls)");
  } else {
    for (const [i, entry] of conRaw.entries()) {
      try {
        contracts.push(normalizeAddress(entry, `allowlist.contracts[${i}]`));
      } catch (err) {
        issues.push((err as PolicyValidationError).issues[0] ?? String(err));
      }
    }
  }
  return { recipients, contracts };
}

function validateTimeWindow(raw: Record<string, unknown>, issues: string[]): TimeWindowPolicy {
  assertAllowedKeys(raw, ["timezone", "windows", "boundary"], "timeWindow", issues);

  const tz = raw["timezone"];
  if (typeof tz !== "string" || tz.length === 0) {
    issues.push("timeWindow.timezone: must be a non-empty IANA timezone string (e.g. \"UTC\")");
  } else {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      issues.push(`timeWindow.timezone: "${tz}" is not a recognized IANA timezone`);
    }
  }

  const windowsRaw = raw["windows"];
  if (!Array.isArray(windowsRaw) || windowsRaw.length === 0) {
    issues.push("timeWindow.windows: must be a non-empty array of { start, end, daysOfWeek? } windows");
  }
  const windows: TimeWindow[] = [];
  if (Array.isArray(windowsRaw)) {
    for (const [i, entry] of windowsRaw.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        issues.push(`timeWindow.windows[${i}]: must be an object with start and end times`);
        continue;
      }
      const w = entry as Record<string, unknown>;
      assertAllowedKeys(w, ["start", "end", "daysOfWeek"], `timeWindow.windows[${i}]`, issues);
      let startOk = true;
      try {
        parseTimeToMinutes(typeof w["start"] === "string" ? w["start"] : "", `timeWindow.windows[${i}].start`, false);
      } catch (err) {
        issues.push((err as PolicyValidationError).issues[0] ?? String(err));
        startOk = false;
      }
      try {
        parseTimeToMinutes(typeof w["end"] === "string" ? w["end"] : "", `timeWindow.windows[${i}].end`, true);
      } catch (err) {
        issues.push((err as PolicyValidationError).issues[0] ?? String(err));
        startOk = false;
      }
      if (startOk && typeof w["start"] === "string" && typeof w["end"] === "string") {
        const start = parseTimeToMinutes(w["start"], `timeWindow.windows[${i}].start`, false);
        const end = parseTimeToMinutes(w["end"], `timeWindow.windows[${i}].end`, true);
        if (start === end) {
          issues.push(`timeWindow.windows[${i}]: start and end must differ (use two windows to span midnight)`);
        }
      }
      let days: number[] | undefined;
      const daysRaw = w["daysOfWeek"];
      if (daysRaw !== undefined) {
        if (!Array.isArray(daysRaw) || daysRaw.length === 0 || daysRaw.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) {
          issues.push(`timeWindow.windows[${i}].daysOfWeek: must be a non-empty array of integers 0 (Sunday) through 6 (Saturday)`);
        } else {
          days = [...daysRaw] as number[];
        }
      }
      if (typeof w["start"] === "string" && typeof w["end"] === "string") {
        windows.push({ start: w["start"], end: w["end"], ...(days ? { daysOfWeek: days } : {}) });
      }
    }
  }

  let boundary: TimeWindowPolicy["boundary"] = { startInclusive: true, endInclusive: false };
  const boundaryRaw = raw["boundary"];
  if (boundaryRaw !== undefined) {
    if (typeof boundaryRaw !== "object" || boundaryRaw === null || Array.isArray(boundaryRaw)) {
      issues.push("timeWindow.boundary: must be an object with optional startInclusive / endInclusive booleans");
    } else {
      const b = boundaryRaw as Record<string, unknown>;
      assertAllowedKeys(b, ["startInclusive", "endInclusive"], "timeWindow.boundary", issues);
      const startInclusive = b["startInclusive"] ?? true;
      const endInclusive = b["endInclusive"] ?? false;
      if (typeof startInclusive !== "boolean" || typeof endInclusive !== "boolean") {
        issues.push("timeWindow.boundary: startInclusive and endInclusive must be booleans");
      } else {
        boundary = { startInclusive, endInclusive };
      }
    }
  }

  return {
    timezone: typeof tz === "string" ? tz : "UTC",
    windows: windows.length > 0 ? windows : [{ start: "00:00", end: "24:00" }],
    boundary
  };
}

/**
 * Validates an unknown raw value (e.g. parsed JSON) into a `Policy`.
 * Throws `PolicyValidationError` listing every problem found. Fail closed.
 */
export function validatePolicy(raw: unknown): Policy {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PolicyValidationError(["policy: root must be a JSON object"]);
  }
  const obj = raw as Record<string, unknown>;
  assertAllowedKeys(obj, ["policyId", "version", "spendLimit", "allowlist", "timeWindow"], "policy", issues);

  const policyId = obj["policyId"];
  if (typeof policyId !== "string" || policyId.trim().length === 0) {
    issues.push("policyId: must be a non-empty string");
  }
  const version = obj["version"];
  if (typeof version !== "string" || version.trim().length === 0) {
    issues.push("version: must be a non-empty string");
  }

  const requiredSections: Array<[string, unknown]> = [
    ["spendLimit", obj["spendLimit"]],
    ["allowlist", obj["allowlist"]],
    ["timeWindow", obj["timeWindow"]]
  ];
  for (const [name, section] of requiredSections) {
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      issues.push(`${name}: missing or malformed — this section is required and the policy will not run without it`);
    }
  }
  if (issues.length > 0 && requiredSections.some(([, s]) => typeof s !== "object" || s === null || Array.isArray(s))) {
    // Do not attempt deeper validation when a required section is missing entirely.
    throw new PolicyValidationError(issues);
  }

  const spendLimit = validateSpendLimit(obj["spendLimit"] as Record<string, unknown>, issues);
  const allowlist = validateAllowlist(obj["allowlist"] as Record<string, unknown>, issues);
  const timeWindow = validateTimeWindow(obj["timeWindow"] as Record<string, unknown>, issues);

  if (issues.length > 0) {
    throw new PolicyValidationError(issues);
  }

  return {
    policyId: (policyId as string).trim(),
    version: (version as string).trim(),
    spendLimit,
    allowlist,
    timeWindow
  };
}

/** Reads and validates a policy JSON file. Throws `PolicyValidationError` on any problem. */
export async function loadPolicyFile(filePath: string): Promise<Policy> {
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    throw new PolicyValidationError([`policy file "${filePath}" could not be read: ${(err as Error).message}`]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PolicyValidationError([`policy file "${filePath}" is not valid JSON: ${(err as Error).message}`]);
  }
  return validatePolicy(parsed);
}

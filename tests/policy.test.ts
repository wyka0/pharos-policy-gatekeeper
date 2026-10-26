/**
 * Policy engine tests: rule outcomes, BigInt spend boundaries, address
 * validation, time-window boundaries/timezones, and fail-closed validation.
 */
import { describe, expect, it } from "vitest";
import {
  PolicyValidationError,
  evaluateRequest,
  getZonedParts,
  normalizeAddress,
  parseTimeToMinutes,
  parseWeiAmount,
  validatePolicy
} from "../src/index.js";
import { makePolicy, ONE_PHRS, RECIPIENT, SENDER, UNKNOWN_ADDRESS } from "./helpers.js";
import type { PolicyRequest } from "../src/types.js";

const CLOCK = () => new Date("2026-10-27T12:00:00.000Z"); // 12:00 UTC

function req(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    requestId: "req-1",
    kind: "native_transfer",
    from: SENDER,
    to: RECIPIENT,
    valueWei: "10000000000000000", // 0.01 PHRS
    ...overrides
  };
}

describe("policy validation (fail-closed)", () => {
  it("accepts a valid policy and normalizes addresses to checksum form", () => {
    const policy = validatePolicy({
      policyId: "p",
      version: "1",
      spendLimit: { maxAmountWei: "1000000000000000000" },
      allowlist: { recipients: [RECIPIENT.toLowerCase()], contracts: [] },
      timeWindow: { timezone: "UTC", windows: [{ start: "09:00", end: "17:00" }] }
    });
    expect(policy.allowlist.recipients[0]).toBe("0x2222222222222222222222222222222222222222"); // digits-only address: checksum form unchanged
    expect(policy.spendLimit.maxAmountWei).toBe("1000000000000000000");
  });

  it("rejects missing required sections entirely", () => {
    expect(() => validatePolicy({ policyId: "p", version: "1" })).toThrow(PolicyValidationError);
    expect(() => validatePolicy({ policyId: "p", version: "1", spendLimit: { maxAmountWei: "1" } })).toThrow(/allowlist/);
  });

  it("rejects malformed, negative, and non-integer wei amounts", () => {
    for (const bad of ["-1", "1.5", "1e18", "abc", "", " 1", "01", "0x10", 12, null]) {
      expect(() => parseWeiAmount(bad, "amount"), `value ${JSON.stringify(bad)}`).toThrow(PolicyValidationError);
    }
    expect(parseWeiAmount("0", "amount")).toBe(0n);
  });

  it("rejects a zero or negative spend limit", () => {
    expect(() => validatePolicy({ ...makePolicy(), spendLimit: { maxAmountWei: "0" } })).toThrow(/greater than zero/);
  });

  it("rejects invalid EVM addresses in allowlists", () => {
    expect(() => validatePolicy(makePolicy({ allowlist: { recipients: ["0x123"], contracts: [] } }))).toThrow(/allowlist.recipients\[0\]/);
    // Wrong EIP-55 checksum (mixed case, invalid): valid form is 0x5aAeb605...Aed
    expect(() =>
      validatePolicy(makePolicy({ allowlist: { recipients: ["0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed"], contracts: [] } }))
    ).toThrow(/checksum/);
  });

  it("rejects unknown configuration keys (strict schema)", () => {
    expect(() => validatePolicy({ ...makePolicy(), extra: true })).toThrow(/unknown key "extra"/);
  });

  it("rejects invalid timezones and malformed windows", () => {
    expect(() => validatePolicy(makePolicy({ timeWindow: { timezone: "Mars/Olympus", windows: [{ start: "09:00", end: "17:00" }] } }))).toThrow(/timezone/);
    expect(() => validatePolicy(makePolicy({ timeWindow: { timezone: "UTC", windows: [{ start: "25:00", end: "17:00" }] } }))).toThrow(/windows\[0\]\.start/);
    expect(() => validatePolicy(makePolicy({ timeWindow: { timezone: "UTC", windows: [] } }))).toThrow(/non-empty/);
    expect(() => validatePolicy(makePolicy({ timeWindow: { timezone: "UTC", windows: [{ start: "12:00", end: "12:00" }] } }))).toThrow(/must differ/);
  });

  it("rejects invalid daysOfWeek values", () => {
    expect(() =>
      validatePolicy(makePolicy({ timeWindow: { timezone: "UTC", windows: [{ start: "09:00", end: "17:00", daysOfWeek: [7] }] } }))
    ).toThrow(/daysOfWeek/);
  });

  it("normalizes addresses and rejects invalid syntax via normalizeAddress", () => {
    expect(normalizeAddress(RECIPIENT.toLowerCase(), "x")).toBe("0x2222222222222222222222222222222222222222");
    expect(() => normalizeAddress("nothex", "x")).toThrow(PolicyValidationError);
    expect(() => normalizeAddress("0x2222", "x")).toThrow(PolicyValidationError);
  });
});

describe("SPEND_LIMIT rule (BigInt arithmetic)", () => {
  const policy = makePolicy(); // max 0.1 PHRS = 100000000000000000 wei

  it("allows amounts equal to the limit (inclusive boundary)", () => {
    const d = evaluateRequest(policy, req({ valueWei: "100000000000000000" }), { clock: CLOCK });
    expect(d.decision).toBe("ALLOW");
    expect(d.ruleResults.find((r) => r.ruleId === "SPEND_LIMIT")?.passed).toBe(true);
  });

  it("denies amounts one wei above the limit", () => {
    const d = evaluateRequest(policy, req({ valueWei: "100000000000000001" }), { clock: CLOCK });
    expect(d.decision).toBe("DENY");
    expect(d.decidingRuleIds).toEqual(["SPEND_LIMIT"]);
    expect(d.reasons[0]).toContain("exceeds the policy maximum");
  });

  it("handles amounts far beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const huge = "123456789012345678901234567890"; // ~1.23e29 — unrepresentable as float
    const d = evaluateRequest(policy, req({ valueWei: huge }), { clock: CLOCK });
    expect(d.decision).toBe("DENY");
    expect(d.reasons[0]).toContain(huge);
  });

  it("denies malformed amounts with a specific reason (never a generic denial)", () => {
    for (const bad of ["-1", "0.5", "1e18", ""]) {
      const d = evaluateRequest(policy, req({ valueWei: bad }), { clock: CLOCK });
      expect(d.decision).toBe("DENY");
      expect(d.decidingRuleIds).toContain("SPEND_LIMIT");
      expect(d.reasons[0]).toMatch(/Invalid amount/);
    }
  });

  it("allows zero-value contract calls", () => {
    const d = evaluateRequest(policy, req({ kind: "contract_call", to: "0x3333333333333333333333333333333333333333", valueWei: "0" }), { clock: CLOCK });
    expect(d.decision).toBe("ALLOW");
  });
});

describe("ADDRESS_ALLOWLIST rule", () => {
  const policy = makePolicy();

  it("allows approved recipients and denies unapproved ones with a specific reason", () => {
    const ok = evaluateRequest(policy, req({ to: RECIPIENT }), { clock: CLOCK });
    expect(ok.decision).toBe("ALLOW");
    const bad = evaluateRequest(policy, req({ to: UNKNOWN_ADDRESS }), { clock: CLOCK });
    expect(bad.decision).toBe("DENY");
    expect(bad.decidingRuleIds).toEqual(["ADDRESS_ALLOWLIST"]);
    expect(bad.reasons[0]).toContain("not on the approved recipient allowlist");
  });

  it("accepts lowercase (non-checksummed) input and normalizes it", () => {
    const d = evaluateRequest(policy, req({ to: RECIPIENT.toLowerCase() }), { clock: CLOCK });
    expect(d.decision).toBe("ALLOW");
  });

  it("denies invalid destination address syntax", () => {
    const d = evaluateRequest(policy, req({ to: "0xnotanaddress" }), { clock: CLOCK });
    expect(d.decision).toBe("DENY");
    expect(d.reasons[0]).toContain("not a valid EVM address");
  });

  it("checks the contracts list for contract calls — recipient list is not consulted", () => {
    const ok = evaluateRequest(policy, req({ kind: "contract_call", to: "0x3333333333333333333333333333333333333333" }), { clock: CLOCK });
    expect(ok.decision).toBe("ALLOW");
    // A contract call to an address that is an approved RECIPIENT but not an approved CONTRACT must fail.
    const d = evaluateRequest(policy, req({ kind: "contract_call", to: RECIPIENT }), { clock: CLOCK });
    expect(d.decision).toBe("DENY");
    expect(d.reasons[0]).toContain("not on the approved contract allowlist");
  });

  it("denies invalid sender address", () => {
    const d = evaluateRequest(policy, req({ from: "0xzz" }), { clock: CLOCK });
    expect(d.decision).toBe("DENY");
    expect(d.reasons[0]).toContain("Sender address");
  });
});

describe("TIME_WINDOW rule", () => {
  const policy = makePolicy({
    timeWindow: {
      timezone: "UTC",
      windows: [{ start: "09:00", end: "17:00" }],
      boundary: { startInclusive: true, endInclusive: false }
    }
  });

  it("allows a request inside the window", () => {
    const d = evaluateRequest(policy, req(), { clock: () => new Date("2026-10-27T12:00:00Z") });
    expect(d.decision).toBe("ALLOW");
    expect(d.decidingRuleIds.length).toBe(3); // all rules jointly allowed
  });

  it("treats the start boundary as inclusive and the end boundary as exclusive by default", () => {
    const atStart = evaluateRequest(policy, req(), { clock: () => new Date("2026-10-27T09:00:00Z") });
    expect(atStart.decision).toBe("ALLOW");
    const atEnd = evaluateRequest(policy, req(), { clock: () => new Date("2026-10-27T17:00:00Z") });
    expect(atEnd.decision).toBe("DENY");
    expect(atEnd.decidingRuleIds).toEqual(["TIME_WINDOW"]);
  });

  it("supports an inclusive end boundary", () => {
    const p = makePolicy({ timeWindow: { timezone: "UTC", windows: [{ start: "09:00", end: "17:00" }], boundary: { startInclusive: true, endInclusive: true } } });
    const d = evaluateRequest(p, req(), { clock: () => new Date("2026-10-27T17:00:00Z") });
    expect(d.decision).toBe("ALLOW");
  });

  it("supports overnight windows (22:00–06:00)", () => {
    const p = makePolicy({ timeWindow: { timezone: "UTC", windows: [{ start: "22:00", end: "06:00" }] } });
    for (const t of ["2026-10-27T23:00:00Z", "2026-10-27T05:59:00Z", "2026-10-27T00:00:00Z"]) {
      expect(evaluateRequest(p, req(), { clock: () => new Date(t) }).decision, t).toBe("ALLOW");
    }
    for (const t of ["2026-10-27T12:00:00Z", "2026-10-27T21:59:00Z", "2026-10-27T06:00:00Z"]) {
      const d = evaluateRequest(p, req(), { clock: () => new Date(t) });
      expect(d.decision, t).toBe("DENY");
      expect(d.reasons[0]).toContain("outside all allowed windows");
    }
  });

  it("respects daysOfWeek filters in the policy timezone", () => {
    // 2026-10-27 is a Tuesday (weekday 2).
    const p = makePolicy({ timeWindow: { timezone: "UTC", windows: [{ start: "00:00", end: "23:59", daysOfWeek: [1] }] } });
    const d = evaluateRequest(p, req(), { clock: () => new Date("2026-10-27T12:00:00Z") });
    expect(d.decision).toBe("DENY"); // Tuesday, window only on Mondays
    expect(d.reasons[0]).toContain("outside all allowed windows");
    const p2 = makePolicy({ timeWindow: { timezone: "UTC", windows: [{ start: "00:00", end: "23:59", daysOfWeek: [2] }] } });
    expect(evaluateRequest(p2, req(), { clock: () => new Date("2026-10-27T12:00:00Z") }).decision).toBe("ALLOW");
  });

  it("evaluates windows in the policy timezone, not the machine timezone", () => {
    // 12:00 UTC is 08:00 in New York (EDT, October) — inside a UTC window, outside a NY window.
    const utcPolicy = makePolicy({ timeWindow: { timezone: "UTC", windows: [{ start: "09:00", end: "17:00" }] } });
    const nyPolicy = makePolicy({ timeWindow: { timezone: "America/New_York", windows: [{ start: "09:00", end: "17:00" }] } });
    expect(evaluateRequest(utcPolicy, req(), { clock: () => new Date("2026-10-27T12:00:00Z") }).decision).toBe("ALLOW");
    const d = evaluateRequest(nyPolicy, req(), { clock: () => new Date("2026-10-27T12:00:00Z") });
    expect(d.decision).toBe("DENY");
    expect(d.reasons[0]).toContain("America/New_York");
  });

  it("produces zoned parts for a named timezone", () => {
    const parts = getZonedParts(new Date("2026-10-27T12:00:00Z"), "Asia/Tokyo");
    expect(parts.localTimeLabel).toBe("21:00");
    expect(parts.weekday).toBe(2); // Tuesday
  });

  it("parses 24:00 as end of day only for window ends", () => {
    expect(parseTimeToMinutes("24:00", "end", true)).toBe(1440);
    expect(() => parseTimeToMinutes("24:00", "start", false)).toThrow(PolicyValidationError);
    expect(() => parseTimeToMinutes("24:30", "end", true)).toThrow(PolicyValidationError);
  });
});

describe("decision shape", () => {
  it("always evaluates all three rules and reports every failure", () => {
    const policy = makePolicy({
      spendLimit: { maxAmountWei: "1000" },
      allowlist: { recipients: [], contracts: [] },
      timeWindow: { timezone: "UTC", windows: [{ start: "01:00", end: "02:00" }] }
    });
    const d = evaluateRequest(policy, req(), { clock: CLOCK });
    expect(d.decision).toBe("DENY");
    expect(d.ruleResults).toHaveLength(3);
    expect(d.ruleResults.every((r) => !r.passed)).toBe(true);
    expect(d.decidingRuleIds).toEqual(["SPEND_LIMIT", "ADDRESS_ALLOWLIST", "TIME_WINDOW"]);
    expect(d.reasons).toHaveLength(3);
    expect(d.reasons.every((r) => r.length > 0)).toBe(true);
    expect(d.executionAttempted).toBe(false);
    expect(d.auditRecordId).toBeNull();
  });

  it("returns ISO 8601 timestamps and injectable decision IDs", () => {
    const d = evaluateRequest(makePolicy(), req(), { clock: CLOCK, decisionIdFactory: () => "dec-fixed" });
    expect(d.decisionId).toBe("dec-fixed");
    expect(d.timestamp).toBe("2026-10-27T12:00:00.000Z");
  });

  it("carries the execution mode through to the decision", () => {
    expect(evaluateRequest(makePolicy(), req(), { clock: CLOCK, mode: "live" }).mode).toBe("live");
    expect(evaluateRequest(makePolicy(), req(), { clock: CLOCK, mode: "simulation" }).mode).toBe("simulation");
  });

  it("keeps ONE_PHRS arithmetic exact", () => {
    expect(ONE_PHRS).toBe(1_000_000_000_000_000_000n);
    expect(BigInt("100000000000000000") < ONE_PHRS).toBe(true);
  });
});

/**
 * Execution boundary tests: every DENY must produce zero adapter calls and
 * zero transaction submissions; ALLOW must invoke the adapter exactly once;
 * audit-write failures must fail closed; the live path must never sign or
 * submit without explicit BROADCAST confirmation and successful revalidation.
 */
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditLogger,
  MockTransferAdapter,
  PolicyGuard,
  canonicalRequestHash,
  evaluateRequest
} from "../src/index.js";
import type { AuditRecord, PolicyDecision, PolicyRequest } from "../src/types.js";
import { AuditWriteError } from "../src/audit/logger.js";
import { makePolicy, RECIPIENT, SENDER, UNKNOWN_ADDRESS } from "./helpers.js";

const CLOCK = () => new Date("2026-10-27T12:00:00.000Z");

function req(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    requestId: "req-1",
    kind: "native_transfer",
    from: SENDER,
    to: RECIPIENT,
    valueWei: "10000000000000000",
    ...overrides
  };
}

function makeGuard(overrides: {
  policy?: unknown;
  audit?: InMemoryAuditLogger;
  clock?: () => Date;
  mode?: "mock" | "live" | "simulation";
  failAudit?: boolean;
} = {}): { guard: PolicyGuard; adapter: MockTransferAdapter; audit: InMemoryAuditLogger } {
  const audit = overrides.audit ?? new InMemoryAuditLogger();
  if (overrides.failAudit) audit.failNext = true;
  const guard = new PolicyGuard({
    policyProvider: () => ("policy" in overrides ? overrides.policy : makePolicy()),
    audit,
    mode: overrides.mode ?? "mock",
    clock: overrides.clock ?? CLOCK,
    decisionIdFactory: (() => {
      let n = 0;
      return () => `dec-${++n}`;
    })(),
    auditIdFactory: (() => {
      let n = 0;
      return () => `aud-${++n}`;
    })()
  });
  return { guard, adapter: new MockTransferAdapter(), audit };
}

describe("mock execution boundary", () => {
  it("allowed action: adapter invoked exactly once, execution attempted, audit written", async () => {
    const { guard, adapter, audit } = makeGuard();
    const result = await guard.executeGuarded(req(), adapter);
    expect(result.decision.decision).toBe("ALLOW");
    expect(result.executionAttempted).toBe(true);
    expect(result.execution?.status).toBe("executed");
    expect(adapter.callCount).toBe(1);
    expect(adapter.callCountFor("req-1")).toBe(1);
    // Two audit records: the decision and the execution result.
    expect(audit.records.filter((r) => r.kind === "policy_decision")).toHaveLength(1);
    expect(audit.records.filter((r) => r.kind === "execution_result")).toHaveLength(1);
  });

  it("spend-limit denial: zero adapter calls and zero submissions", async () => {
    const { guard, adapter } = makeGuard();
    const result = await guard.executeGuarded(req({ valueWei: "1000000000000000001" }), adapter);
    expect(result.decision.decision).toBe("DENY");
    expect(result.decision.decidingRuleIds).toEqual(["SPEND_LIMIT"]);
    expect(adapter.callCount).toBe(0);
    expect(result.executionAttempted).toBe(false);
  });

  it("allowlist denial: zero adapter calls and zero submissions", async () => {
    const { guard, adapter } = makeGuard();
    const result = await guard.executeGuarded(req({ to: UNKNOWN_ADDRESS }), adapter);
    expect(result.decision.decision).toBe("DENY");
    expect(result.decision.decidingRuleIds).toEqual(["ADDRESS_ALLOWLIST"]);
    expect(adapter.callCount).toBe(0);
  });

  it("time-window denial: zero adapter calls and zero submissions", async () => {
    const policy = makePolicy({
      timeWindow: { timezone: "UTC", windows: [{ start: "09:00", end: "17:00" }], boundary: { startInclusive: true, endInclusive: false } }
    });
    const { guard, adapter } = makeGuard({ policy, clock: () => new Date("2026-10-27T20:00:00Z") });
    const result = await guard.executeGuarded(req(), adapter);
    expect(result.decision.decision).toBe("DENY");
    expect(result.decision.decidingRuleIds).toEqual(["TIME_WINDOW"]);
    expect(adapter.callCount).toBe(0);
  });

  it("multiple-rule denial: no execution and all failed rules reported", async () => {
    const { guard, adapter } = makeGuard();
    const result = await guard.executeGuarded(req({ to: UNKNOWN_ADDRESS, valueWei: "999999999999999999" }), adapter);
    expect(result.decision.decision).toBe("DENY");
    expect(result.decision.decidingRuleIds).toEqual(["SPEND_LIMIT", "ADDRESS_ALLOWLIST"]);
    expect(result.decision.reasons).toHaveLength(2);
    expect(adapter.callCount).toBe(0);
    expect(result.executionAttempted).toBe(false);
  });

  it("invalid policy: fail-closed DENY decision, no execution, audited", async () => {
    const { guard, adapter, audit } = makeGuard({ policy: { policyId: "broken" } });
    const result = await guard.executeGuarded(req(), adapter);
    expect(result.decision.decision).toBe("DENY");
    expect(result.decision.reasons.join(" ")).toMatch(/POLICY_INVALID/);
    expect(result.decision.reasons.join(" ")).toContain("allowlist");
    expect(adapter.callCount).toBe(0);
    expect(audit.records.filter((r) => r.kind === "policy_decision" && r.decision === "DENY")).toHaveLength(1);
    expect(result.decision.auditRecordId).toBe("aud-1");
  });

  it("unreadable policy provider throwing: fail-closed DENY, no execution", async () => {
    const { guard, adapter } = makeGuard();
    const throwing = new PolicyGuard({
      policyProvider: () => {
        throw new Error("ENOENT: policy file missing");
      },
      audit: new InMemoryAuditLogger(),
      mode: "mock",
      clock: CLOCK
    });
    const result = await throwing.executeGuarded(req(), adapter);
    expect(result.decision.decision).toBe("DENY");
    expect(result.decision.reasons[0]).toContain("ENOENT");
    expect(adapter.callCount).toBe(0);
    void guard;
  });

  it("audit-write failure: fail closed, no execution attempted", async () => {
    const { guard, adapter } = makeGuard({ failAudit: true });
    await expect(guard.executeGuarded(req(), adapter)).rejects.toBeInstanceOf(AuditWriteError);
    expect(adapter.callCount).toBe(0);
  });

  it("execution failure is reported honestly as status 'failed'", async () => {
    const { guard, adapter } = makeGuard();
    const result = await guard.executeGuarded(req(), {
      mode: "mock",
      execute: async () => {
        throw new Error("simulated execution failure");
      }
    });
    expect(result.decision.decision).toBe("ALLOW");
    expect(result.executionAttempted).toBe(true);
    expect(result.execution?.status).toBe("failed");
    expect(result.execution?.detail).toContain("simulated execution failure");
    void adapter;
  });

  it("the execution handler is never called on DENY (spy)", async () => {
    const handler = vi.fn(async () => ({ status: "executed" as const, detail: "should not run" }));
    const { guard } = makeGuard();
    const result = await guard.executeGuarded(req({ valueWei: "999999999999999999" }), { mode: "mock", execute: handler });
    expect(result.decision.decision).toBe("DENY");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("canonical request hash (parameter-drift detection)", () => {
  it("is stable for identical requests and case-insensitive on addresses", () => {
    const a = canonicalRequestHash(req());
    const b = canonicalRequestHash(req({ from: SENDER.toLowerCase(), to: RECIPIENT.toLowerCase() }));
    expect(a).toBe(b);
  });

  it("changes when any transaction parameter changes", () => {
    const base = canonicalRequestHash(req());
    expect(canonicalRequestHash(req({ valueWei: "10000000000000001" }))).not.toBe(base);
    expect(canonicalRequestHash(req({ to: UNKNOWN_ADDRESS }))).not.toBe(base);
    expect(canonicalRequestHash(req({ data: "0xdeadbeef" }))).not.toBe(base);
    expect(canonicalRequestHash(req({ kind: "contract_call" }))).not.toBe(base);
  });
});

describe("live revalidation boundary", () => {
  it("blocks when transaction parameters changed after approval", async () => {
    const { guard } = makeGuard({ mode: "live" });
    const approved = canonicalRequestHash(req());
    const drifted = req({ valueWei: "10000000000000001" });
    const result = await guard.revalidateForSigning(drifted, approved);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("parameters changed after policy approval");
      expect(result.decision?.decision).toBeDefined();
    }
  });

  it("blocks when the policy no longer allows the request at revalidation time", async () => {
    const audit = new InMemoryAuditLogger();
    const policies = [makePolicy(), makePolicy({ spendLimit: { maxAmountWei: "1" } })]; // limit lowered mid-flight
    let call = 0;
    const guard = new PolicyGuard({
      policyProvider: () => policies[Math.min(call++, 1)],
      audit,
      mode: "live",
      clock: CLOCK,
      decisionIdFactory: (() => { let n = 0; return () => `dec-${++n}`; })(),
      auditIdFactory: (() => { let n = 0; return () => `aud-${++n}`; })()
    });
    const initial = await guard.evaluateAndRecord(req());
    expect(initial.decision.decision).toBe("ALLOW");
    const revalidation = await guard.revalidateForSigning(req(), canonicalRequestHash(req()));
    expect(revalidation.ok).toBe(false);
    if (!revalidation.ok) {
      expect(revalidation.reason).toContain("no longer allows");
      expect(revalidation.decision?.decidingRuleIds).toContain("SPEND_LIMIT");
    }
  });

  it("blocks when the time window expired between approval and signing (injectable clock)", async () => {
    let tick = 0;
    const clock = (): Date => (tick++ === 0 ? new Date("2026-10-27T16:59:00Z") : new Date("2026-10-27T17:30:00Z"));
    const policy = makePolicy({
      timeWindow: { timezone: "UTC", windows: [{ start: "09:00", end: "17:00" }], boundary: { startInclusive: true, endInclusive: false } }
    });
    const guard = new PolicyGuard({
      policyProvider: () => policy,
      audit: new InMemoryAuditLogger(),
      mode: "live",
      clock,
      decisionIdFactory: (() => { let n = 0; return () => `dec-${++n}`; })(),
      auditIdFactory: (() => { let n = 0; return () => `aud-${++n}`; })()
    });
    const approvedHash = canonicalRequestHash(req());
    const first = await guard.evaluateAndRecord(req());
    expect(first.decision.decision).toBe("ALLOW");
    const revalidation = await guard.revalidateForSigning(req(), approvedHash);
    expect(revalidation.ok).toBe(false);
    if (!revalidation.ok) expect(revalidation.decision?.decidingRuleIds).toContain("TIME_WINDOW");
  });

  it("passes revalidation when nothing changed", async () => {
    const { guard } = makeGuard({ mode: "live" });
    const result = await guard.revalidateForSigning(req(), canonicalRequestHash(req()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decision.decision).toBe("ALLOW");
  });
});

describe("decision and audit linkage", () => {
  it("sets auditRecordId on the decision and records rule outcomes", async () => {
    const { guard, audit } = makeGuard();
    const { decision } = await guard.evaluateAndRecord(req({ to: UNKNOWN_ADDRESS }));
    expect(decision.auditRecordId).toBe("aud-1");
    const record = audit.records.find((r) => r.auditId === decision.auditRecordId) as AuditRecord;
    expect(record.decision).toBe("DENY");
    expect(record.decisionId).toBe(decision.decisionId);
    expect(record.ruleOutcomes).toHaveLength(3);
    expect(record.executionAttempted).toBe(false);
    expect(record.mode).toBe("mock");
  });

  it("records the mode in decisions (live path uses mode 'live')", async () => {
    const { guard, audit } = makeGuard({ mode: "live" });
    const { decision } = await guard.evaluateAndRecord(req());
    expect(decision.mode).toBe("live");
    expect(audit.records[0]?.mode).toBe("live");
  });

  it("evaluateRequest remains a pure evaluator (no audit side effects)", () => {
    const d: PolicyDecision = evaluateRequest(makePolicy(), req(), { clock: CLOCK });
    expect(d.auditRecordId).toBeNull();
    expect(d.executionAttempted).toBe(false);
  });
});

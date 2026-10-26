/**
 * Audit log tests: JSON Lines format, append-only behavior, allowed and
 * denied decisions both logged, fail-closed on write errors, and no secrets
 * ever recorded.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAuditLogger, JsonLinesAuditLogger, PolicyGuard, readAuditFile } from "../src/index.js";
import type { AuditRecord } from "../src/types.js";
import { makePolicy, RECIPIENT, SENDER } from "./helpers.js";

const CLOCK = () => new Date("2026-10-27T12:00:00.000Z");

import type { PolicyRequest } from "../src/types.js";

function req(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return { requestId: "req-a", kind: "native_transfer", from: SENDER, to: RECIPIENT, valueWei: "10000000000000000", ...overrides };
}

function guardWith(audit: InMemoryAuditLogger): PolicyGuard {
  return new PolicyGuard({
    policyProvider: () => makePolicy(),
    audit,
    mode: "mock",
    clock: CLOCK,
    decisionIdFactory: (() => { let n = 0; return () => `dec-${++n}`; })(),
    auditIdFactory: (() => { let n = 0; return () => `aud-${++n}`; })()
  });
}

describe("InMemoryAuditLogger", () => {
  it("logs both allowed and denied decisions", async () => {
    const audit = new InMemoryAuditLogger();
    const guard = guardWith(audit);
    const allowed = await guard.executeGuarded(req(), new (await import("../src/index.js")).MockTransferAdapter());
    const denied = await guard.executeGuarded(req({ to: "0x9999999999999999999999999999999999999999" }), new (await import("../src/index.js")).MockTransferAdapter());
    expect(allowed.decision.decision).toBe("ALLOW");
    expect(denied.decision.decision).toBe("DENY");
    const decisions = audit.records.filter((r) => r.kind === "policy_decision");
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.decision).sort()).toEqual(["ALLOW", "DENY"]);
    // The denied decision must also be in the log, with its reasons.
    const deniedRecord = decisions.find((d) => d.decision === "DENY") as AuditRecord;
    expect(deniedRecord.reasons?.length).toBeGreaterThan(0);
    expect(deniedRecord.decidingRuleIds).toContain("ADDRESS_ALLOWLIST");
  });

  it("records execution results with the linked decision ID", async () => {
    const audit = new InMemoryAuditLogger();
    const guard = guardWith(audit);
    const result = await guard.executeGuarded(req(), new (await import("../src/index.js")).MockTransferAdapter());
    const exec = audit.records.find((r) => r.kind === "execution_result") as AuditRecord;
    expect(exec.decisionId).toBe(result.decision.decisionId);
    expect(exec.execution?.status).toBe("executed");
    expect(exec.transactionHash).toBeUndefined(); // no transaction hash exists in mock mode
  });

  it("failNext triggers AuditWriteError exactly once (fail-closed trigger)", async () => {
    const audit = new InMemoryAuditLogger();
    audit.failNext = true;
    await expect(audit.append(audit.records.length ? audit.records[0]! : { auditId: "x", timestamp: "t", kind: "policy_decision", requestId: "r", policyId: "p", policyVersion: "1", mode: "mock" })).rejects.toThrow(/simulated audit failure/);
    expect(audit.records).toHaveLength(0);
  });
});

describe("JsonLinesAuditLogger", () => {
  it("appends one JSON object per line and reads back identically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gatekeeper-audit-"));
    const file = join(dir, "audit.jsonl");
    const logger = new JsonLinesAuditLogger(file);
    const record: AuditRecord = {
      auditId: "aud-1",
      timestamp: "2026-10-27T12:00:00.000Z",
      kind: "policy_decision",
      requestId: "req-1",
      policyId: "p",
      policyVersion: "1",
      mode: "mock",
      decision: "ALLOW",
      decisionId: "dec-1",
      ruleOutcomes: [{ ruleId: "SPEND_LIMIT", passed: true, reason: "ok" }],
      decidingRuleIds: ["SPEND_LIMIT"],
      reasons: [],
      executionAttempted: false
    };
    await expect(logger.append(record)).resolves.toBe("aud-1");
    await expect(logger.append({ ...record, auditId: "aud-2", decision: "DENY" })).resolves.toBe("aud-2");

    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow();
    const readBack = await readAuditFile(file);
    expect(readBack).toHaveLength(2);
    expect(readBack[0]?.auditId).toBe("aud-1");
    expect(readBack[1]?.decision).toBe("DENY");
    await rm(dir, { recursive: true, force: true });
  });

  it("creates missing parent directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gatekeeper-audit-"));
    const file = join(dir, "nested", "deeper", "audit.jsonl");
    const logger = new JsonLinesAuditLogger(file);
    await expect(logger.append({ auditId: "aud-9", timestamp: "t", kind: "policy_decision", requestId: "r", policyId: "p", policyVersion: "1", mode: "mock" })).resolves.toBe("aud-9");
    expect(await readFile(file, "utf8")).toContain("aud-9");
    await rm(dir, { recursive: true, force: true });
  });

  it("throws AuditWriteError when the target is unwritable (fail-closed signal)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gatekeeper-audit-"));
    const file = join(dir, "blocker");
    await writeFile(file, "x", "utf8");
    // Windows: writing to a path that is actually a directory fails.
    const logger = new JsonLinesAuditLogger(join(file, "child", "audit.jsonl"));
    await expect(
      logger.append({ auditId: "aud-1", timestamp: "t", kind: "policy_decision", requestId: "r", policyId: "p", policyVersion: "1", mode: "mock" })
    ).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it("end-to-end: guard writes decisions to the file for ALLOW and DENY", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gatekeeper-audit-"));
    const file = join(dir, "audit.jsonl");
    const audit = new JsonLinesAuditLogger(file);
    const guard = new PolicyGuard({
      policyProvider: () => makePolicy(),
      audit,
      mode: "mock",
      clock: CLOCK,
      decisionIdFactory: (() => { let n = 0; return () => `dec-${++n}`; })(),
      auditIdFactory: (() => { let n = 0; return () => `aud-${++n}`; })()
    });
    const mockAdapter = new (await import("../src/index.js")).MockTransferAdapter();
    await guard.executeGuarded(req(), mockAdapter);
    await guard.executeGuarded(req({ valueWei: "999999999999999999" }), mockAdapter);
    const records = await readAuditFile(file);
    expect(records.filter((r) => r.kind === "policy_decision")).toHaveLength(2);
    expect(records.filter((r) => r.decision === "DENY")).toHaveLength(1);
    // Denied action produced exactly one audit record (decision) — no execution record.
    const deniedRecord = records.find((r) => r.decision === "DENY") as AuditRecord;
    expect(records.some((r) => r.kind === "execution_result" && r.decisionId === deniedRecord.decisionId)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("audit content safety", () => {
  it("never stores private keys, seed phrases, or signed raw transaction bytes", async () => {
    const audit = new InMemoryAuditLogger();
    const guard = guardWith(audit);
    const request = req();
    request.data = "0x" + "ab".repeat(100); // even calldata is fine — but no signed tx bytes exist at this layer
    await guard.executeGuarded(request, new (await import("../src/index.js")).MockTransferAdapter());
    for (const record of audit.records) {
      const json = JSON.stringify(record);
      expect(json).not.toMatch(/0x[0-9a-fA-F]{64}/); // 64-hex = private key or signature shape
      expect(json.toLowerCase()).not.toContain("privat");
      expect(json.toLowerCase()).not.toContain("seed");
      expect(json.toLowerCase()).not.toContain("mnemonic");
    }
  });
});

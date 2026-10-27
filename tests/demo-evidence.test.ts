/**
 * Demo evidence isolation tests: each `npm run demo` run must describe
 * exactly that run — 8 decisions (2 ALLOW / 6 DENY), 10 audit records
 * (8 policy_decision + 2 execution_result) — with no accumulation across
 * runs, and no touching of audit logs outside the demo evidence path.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuditFile, runDemo } from "../src/index.js";

const auditPathOf = (dir: string): string => `${dir}/demo-audit.jsonl`;

describe("demo evidence isolation", () => {
  it("one run produces exactly 10 audit records (8 decisions + 2 execution results)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gatekeeper-demo-"));
    const results = await runDemo(dir);
    const records = await readAuditFile(auditPathOf(dir));

    expect(results.totals).toEqual({
      decisions: 8,
      allowed: 2,
      denied: 6,
      adapterCallsTotal: 2,
      adapterCallsOnDenied: 0
    });
    expect(results.audit.records).toBe(10);
    expect(results.audit.allowedDecisions).toBe(2);
    expect(results.audit.deniedDecisions).toBe(6);

    expect(records).toHaveLength(10);
    expect(records.filter((r) => r.kind === "policy_decision")).toHaveLength(8);
    expect(records.filter((r) => r.kind === "execution_result")).toHaveLength(2);

    // Preserved invariant: every DENY has zero adapter calls and no execution attempt.
    for (const c of results.cases) {
      if (c.decision === "DENY") {
        expect(c.adapterCallsForCase, `case ${c.id}`).toBe(0);
        expect(c.executionAttempted, `case ${c.id}`).toBe(false);
      } else {
        expect(c.adapterCallsForCase, `case ${c.id}`).toBe(1);
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("does not accumulate evidence across consecutive runs in the same directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gatekeeper-demo-"));
    const first = await runDemo(dir);
    const afterFirst = await readAuditFile(auditPathOf(dir));
    expect(afterFirst).toHaveLength(10);

    // Simulate a stale accumulated file left by an older version to prove the reset wins.
    await writeFile(auditPathOf(dir), '{"stale":true}\n', "utf8");
    const second = await runDemo(dir);
    const afterSecond = await readAuditFile(auditPathOf(dir));

    expect(afterSecond).toHaveLength(10);
    expect(afterSecond.some((r) => (r as { stale?: unknown }).stale)).toBe(false);
    expect(second.audit.records).toBe(10);
    expect(second.audit.allowedDecisions).toBe(2);
    expect(second.audit.deniedDecisions).toBe(6);
    expect(first.audit.records).toBe(10);
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves audit logs outside the demo evidence path untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gatekeeper-demo-"));
    const runtimeLog = join(dir, "audit.jsonl");
    await writeFile(runtimeLog, '{"runtime":true}\n', "utf8");
    await runDemo(dir);
    expect(await readFile(runtimeLog, "utf8")).toBe('{"runtime":true}\n');
    await rm(dir, { recursive: true, force: true });
  });
});

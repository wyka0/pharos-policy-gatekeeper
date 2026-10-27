/**
 * Mode A — deterministic mock demo.
 *
 * Runs entirely on the MockTransferAdapter. No wallet is accessed, no RPC is
 * contacted, and no transaction is ever broadcast in this mode. An injected
 * clock makes the time-window cases deterministic.
 *
 * Evidence is generated from the ACTUAL results of this run.
 */
import { writeFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { PolicyRequest } from "./types.js";
import { validatePolicy } from "./policy/validate-policy.js";
import { PolicyGuard } from "./execution/guard.js";
import { MockTransferAdapter } from "./execution/mock-adapter.js";
import { InMemoryAuditLogger, JsonLinesAuditLogger } from "./audit/logger.js";
import { formatWeiToPhrs } from "./units.js";

const DEMO_POLICY_RAW = {
  policyId: "demo-policy",
  version: "1.0.0",
  spendLimit: { maxAmountWei: "100000000000000000" }, // 0.1 PHRS
  allowlist: {
    recipients: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222"
    ],
    contracts: ["0x3333333333333333333333333333333333333333"]
  },
  timeWindow: {
    timezone: "UTC",
    windows: [{ start: "09:00", end: "17:00" }],
    boundary: { startInclusive: true, endInclusive: false }
  }
};

const RECIPIENT_APPROVED = "0x1111111111111111111111111111111111111111";
const RECIPIENT_UNKNOWN = "0x9999999999999999999999999999999999999999";
const CONTRACT_APPROVED = "0x3333333333333333333333333333333333333333";

// Deterministic injected clock: inside the window for most cases,
// outside the window for the time-window denial cases.
const CLOCK_INSIDE = () => new Date("2026-10-27T12:00:00.000Z"); // 12:00 UTC (inside 09:00–17:00)
const CLOCK_OUTSIDE = () => new Date("2026-10-27T20:00:00.000Z"); // 20:00 UTC (outside window)

interface DemoCase {
  id: string;
  name: string;
  clock: () => Date;
  request: PolicyRequest;
  /** When set, the policy provider intentionally returns invalid configuration. */
  breakPolicy?: boolean;
  expect: "ALLOW" | "DENY";
}

interface DemoCaseResult {
  id: string;
  name: string;
  requestId: string;
  decision: string;
  policyId: string;
  policyVersion: string;
  decidingRuleIds: string[];
  reasons: string[];
  ruleResults: Array<{ ruleId: string; passed: boolean; reason: string }>;
  executionAttempted: boolean;
  adapterCallsForCase: number;
  auditRecordId: string | null;
  timestamp: string;
}

const A: bigint = 10_000_000_000_000_000n; // 0.01 PHRS
const TOO_MUCH: bigint = 500_000_000_000_000_000n; // 0.5 PHRS (> 0.1 limit)

const CASES: DemoCase[] = [
  {
    id: "A",
    name: "Allowed action — within spend limit, approved recipient, inside window",
    clock: CLOCK_INSIDE,
    request: { requestId: "demo-A", kind: "native_transfer", from: "0x4444444444444444444444444444444444444444", to: RECIPIENT_APPROVED, valueWei: A.toString() },
    expect: "ALLOW"
  },
  {
    id: "B",
    name: "Spend-limit denial — 0.5 PHRS exceeds the 0.1 PHRS maximum",
    clock: CLOCK_INSIDE,
    request: { requestId: "demo-B", kind: "native_transfer", from: "0x4444444444444444444444444444444444444444", to: RECIPIENT_APPROVED, valueWei: TOO_MUCH.toString() },
    expect: "DENY"
  },
  {
    id: "C",
    name: "Allowlist denial — recipient is not approved",
    clock: CLOCK_INSIDE,
    request: { requestId: "demo-C", kind: "native_transfer", from: "0x4444444444444444444444444444444444444444", to: RECIPIENT_UNKNOWN, valueWei: A.toString() },
    expect: "DENY"
  },
  {
    id: "D",
    name: "Time-window denial — 20:00 UTC is outside the 09:00–17:00 UTC window",
    clock: CLOCK_OUTSIDE,
    request: { requestId: "demo-D", kind: "native_transfer", from: "0x4444444444444444444444444444444444444444", to: RECIPIENT_APPROVED, valueWei: A.toString() },
    expect: "DENY"
  },
  {
    id: "E",
    name: "Multiple-rule denial — over limit AND unapproved recipient AND outside window",
    clock: CLOCK_OUTSIDE,
    request: { requestId: "demo-E", kind: "native_transfer", from: "0x4444444444444444444444444444444444444444", to: RECIPIENT_UNKNOWN, valueWei: TOO_MUCH.toString() },
    expect: "DENY"
  },
  {
    id: "F1",
    name: "Invalid request — malformed amount (negative with decimals) is denied and never executed",
    clock: CLOCK_INSIDE,
    request: { requestId: "demo-F1", kind: "native_transfer", from: "0x4444444444444444444444444444444444444444", to: RECIPIENT_APPROVED, valueWei: "-1.5" },
    expect: "DENY"
  },
  {
    id: "F2",
    name: "Invalid policy — policy missing the allowlist section fails closed and is never executed",
    clock: CLOCK_INSIDE,
    request: { requestId: "demo-F2", kind: "native_transfer", from: "0x4444444444444444444444444444444444444444", to: RECIPIENT_APPROVED, valueWei: A.toString() },
    breakPolicy: true,
    expect: "DENY"
  },
  {
    id: "G",
    name: "Allowed contract call — target contract is on the contracts allowlist",
    clock: CLOCK_INSIDE,
    request: {
      requestId: "demo-G",
      kind: "contract_call",
      from: "0x4444444444444444444444444444444444444444",
      to: CONTRACT_APPROVED,
      valueWei: "0",
      data: "0x"
    },
    expect: "ALLOW"
  }
];

let idCounter = 0;
function deterministicIds(prefix: string): () => string {
  return () => `${prefix}-${String(++idCounter).padStart(3, "0")}`;
}

export interface DemoResults {
  mode: "mock-demo";
  generatedAt: string;
  deterministic: true;
  blockchainInteraction: false;
  policy: { policyId: string; version: string; spendLimit: string; window: string; timezone: string; recipients: number; contracts: number };
  cases: DemoCaseResult[];
  totals: {
    decisions: number;
    allowed: number;
    denied: number;
    adapterCallsTotal: number;
    adapterCallsOnDenied: number;
  };
  audit: { path: string; records: number; allowedDecisions: number; deniedDecisions: number };
  notes: string[];
}

/** Runs the full demo and writes evidence files from the actual results. */
export async function runDemo(evidenceDir = "evidence"): Promise<DemoResults> {
  idCounter = 0;
  const adapter = new MockTransferAdapter();
  const auditMemory = new InMemoryAuditLogger();
  const auditPath = `${evidenceDir}/demo-audit.jsonl`;
  // Evidence isolation: remove any previous demo audit file so the append-only
  // JSONL reflects exactly THIS run. Runtime audit logs outside the demo
  // evidence path (e.g. audit/audit.jsonl) are never touched.
  await rm(auditPath, { force: true });
  const auditFile = new JsonLinesAuditLogger(auditPath);
  // Dual-write: keep an in-memory copy for this run's summary while also
  // appending to the JSON Lines evidence file. A file write failure stops the
  // demo (fail closed).
  const audit = {
    append: async (record: Parameters<InMemoryAuditLogger["append"]>[0]): Promise<string> => {
      await auditMemory.append(record);
      return auditFile.append(record);
    }
  };

  const validPolicy = validatePolicy(DEMO_POLICY_RAW);
  const brokenPolicyRaw = { ...DEMO_POLICY_RAW } as Record<string, unknown>;
  delete brokenPolicyRaw["allowlist"];

  const caseResults: DemoCaseResult[] = [];
  const expectedMismatches: string[] = [];

  for (const demoCase of CASES) {
    const guard = new PolicyGuard({
      policyProvider: () => (demoCase.breakPolicy ? brokenPolicyRaw : DEMO_POLICY_RAW),
      audit,
      mode: "mock",
      clock: demoCase.clock,
      decisionIdFactory: deterministicIds("dec"),
      auditIdFactory: deterministicIds("aud")
    });
    const guarded = await guard.executeGuarded(demoCase.request, adapter);
    const decision = guarded.decision;
    const result: DemoCaseResult = {
      id: demoCase.id,
      name: demoCase.name,
      requestId: decision.requestId,
      decision: decision.decision,
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      decidingRuleIds: decision.decidingRuleIds,
      reasons: decision.reasons,
      ruleResults: decision.ruleResults.map((r) => ({ ruleId: r.ruleId, passed: r.passed, reason: r.reason })),
      executionAttempted: guarded.executionAttempted,
      adapterCallsForCase: adapter.callCountFor(demoCase.request.requestId),
      auditRecordId: decision.auditRecordId,
      timestamp: decision.timestamp
    };
    if (result.decision !== demoCase.expect) {
      expectedMismatches.push(`case ${demoCase.id}: expected ${demoCase.expect}, got ${result.decision}`);
    }
    if (result.decision === "DENY" && (result.adapterCallsForCase !== 0 || result.executionAttempted)) {
      expectedMismatches.push(`case ${demoCase.id}: DENY reached execution (calls=${result.adapterCallsForCase}, attempted=${result.executionAttempted})`);
    }
    caseResults.push(result);
  }

  if (expectedMismatches.length > 0) {
    throw new Error(`Demo invariant violated — refusing to write evidence: ${expectedMismatches.join("; ")}`);
  }

  const deniedCases = caseResults.filter((c) => c.decision === "DENY");
  const allowedCases = caseResults.filter((c) => c.decision === "ALLOW");
  // Summary counts come from THIS run's in-memory records, never from the
  // accumulated file, so the evidence always describes exactly one run.
  const records = auditMemory.records;

  const results: DemoResults = {
    mode: "mock-demo",
    generatedAt: new Date().toISOString(),
    deterministic: true,
    blockchainInteraction: false,
    policy: {
      policyId: validPolicy.policyId,
      version: validPolicy.version,
      spendLimit: `${validPolicy.spendLimit.maxAmountWei} wei (${formatWeiToPhrs(BigInt(validPolicy.spendLimit.maxAmountWei))} PHRS)`,
      window: validPolicy.timeWindow.windows.map((w) => `${w.start}–${w.end}`).join("; "),
      timezone: validPolicy.timeWindow.timezone,
      recipients: validPolicy.allowlist.recipients.length,
      contracts: validPolicy.allowlist.contracts.length
    },
    cases: caseResults,
    totals: {
      decisions: caseResults.length,
      allowed: allowedCases.length,
      denied: deniedCases.length,
      adapterCallsTotal: adapter.callCount,
      adapterCallsOnDenied: deniedCases.reduce((sum, c) => sum + c.adapterCallsForCase, 0)
    },
    audit: {
      path: `${evidenceDir}/demo-audit.jsonl`,
      records: records.length,
      allowedDecisions: records.filter((r) => r.kind === "policy_decision" && r.decision === "ALLOW").length,
      deniedDecisions: records.filter((r) => r.kind === "policy_decision" && r.decision === "DENY").length
    },
    notes: [
      "Mock demo only: the mock adapter holds no wallet and cannot broadcast anything.",
      "Every denied action produced zero adapter calls.",
      "Only allowed actions reached the mock adapter.",
      "Time-window cases use an injected clock (12:00 UTC inside / 20:00 UTC outside the 09:00–17:00 UTC window).",
      "Evidence is isolated to this run: demo-audit.jsonl is reset at the start of each run (8 decisions + 2 execution results = 10 records)."
    ]
  };

  await mkdirSafe(evidenceDir);
  await writeFile(`${evidenceDir}/demo-results.json`, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  await writeFile(`${evidenceDir}/demo-results.md`, renderDemoMarkdown(results), "utf8");
  return results;
}

async function mkdirSafe(dir: string): Promise<void> {
  const d = dirname(`${dir}/x`);
  if (d && d !== ".") await mkdir(d, { recursive: true });
}

export function renderDemoMarkdown(r: DemoResults): string {
  const lines: string[] = [
    `# Mock Demo Results`,
    ``,
    `Mode: **mock demo** — deterministic, no blockchain interaction, no wallet access.`,
    `Generated from actual execution at ${r.generatedAt}.`,
    ``,
    `## Policy used`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Policy | ${r.policy.policyId} v${r.policy.version} |`,
    `| Spend limit | ${r.policy.spendLimit} |`,
    `| Time window | ${r.policy.window} (${r.policy.timezone}) |`,
    `| Approved recipients | ${r.policy.recipients} |`,
    `| Approved contracts | ${r.policy.contracts} |`,
    ``,
    `## Cases`,
    ``
  ];
  for (const c of r.cases) {
    lines.push(
      `### Case ${c.id} — ${c.name}`,
      ``,
      `- Request \`${c.requestId}\`: **${c.decision}** (policy ${c.policyId} v${c.policyVersion}, timestamp ${c.timestamp})`,
      `- Deciding rules: ${c.decidingRuleIds.length > 0 ? c.decidingRuleIds.join(", ") : "(policy validation failure — fail-closed)"}`,
      `- Execution attempted: ${c.executionAttempted}`,
      `- Mock adapter calls for this case: **${c.adapterCallsForCase}**`,
      `- Audit record: ${c.auditRecordId ?? "(none)"}`,
      ``
    );
    for (const rr of c.ruleResults) {
      lines.push(`  - **${rr.ruleId}**: ${rr.passed ? "PASS" : "FAIL"} — ${rr.reason}`);
    }
    if (c.ruleResults.length === 0) {
      for (const reason of c.reasons) {
        lines.push(`  - ${reason}`);
      }
    }
    lines.push(``);
  }
  lines.push(
    `## Totals (actual counts)`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Decisions | ${r.totals.decisions} |`,
    `| Allowed | ${r.totals.allowed} |`,
    `| Denied | ${r.totals.denied} |`,
    `| Mock adapter calls (total) | ${r.totals.adapterCallsTotal} |`,
    `| Mock adapter calls from denied actions | **${r.totals.adapterCallsOnDenied}** |`,
    `| Audit records (${r.audit.path}) | ${r.audit.records} (${r.audit.allowedDecisions} ALLOW, ${r.audit.deniedDecisions} DENY decisions) |`,
    ``,
    `## Notes`,
    ``,
    ...r.notes.map((n) => `- ${n}`),
    ``
  );
  return lines.join("\n");
}

// CLI entry point: `npm run demo`
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("src/demo.ts") === true;
if (invokedDirectly) {
  runDemo()
    .then((results) => {
      console.log(renderDemoMarkdown(results));
      console.log(`Evidence written: evidence/demo-results.json, evidence/demo-results.md, ${results.audit.path}`);
    })
    .catch((err) => {
      console.error(`Demo failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}

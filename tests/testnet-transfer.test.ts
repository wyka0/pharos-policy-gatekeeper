/**
 * Live transaction path tests (all RPC mocked — nothing is ever broadcast):
 * the full safety sequence, confirmation gating, revalidation, duplicate-send
 * protection, single submission attempt, receipt verification, and honest
 * handling of unresolved receipts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BROADCAST_CONFIRMATION_PHRASE,
  InMemoryAuditLogger,
  PolicyGuard,
  runLiveTransfer,
  canonicalRequestHash
} from "../src/index.js";
import type { PolicyRequest } from "../src/types.js";
import { AuditWriteError } from "../src/audit/logger.js";
import { makeLocalAccount, makePolicy, MockRpc, RECIPIENT, SENDER } from "./helpers.js";

const CLOCK = () => new Date("2026-10-27T12:00:00.000Z");
const VALUE_WEI = 1_000_000_000_000_000n; // 0.001 PHRS

interface Fixture {
  rpc: MockRpc;
  account: ReturnType<typeof makeLocalAccount>;
  audit: InMemoryAuditLogger;
  policies: () => unknown;
  deps: Parameters<typeof runLiveTransfer>[0];
}

function makeFixture(overrides: {
  policy?: unknown;
  confirm?: (summary: string) => Promise<string>;
  clock?: () => Date;
  mode?: "mock" | "live" | "simulation";
} = {}): Fixture {
  const rpc = new MockRpc();
  const account = makeLocalAccount();
  const audit = new InMemoryAuditLogger();
  let counter = 0;
  const deps = {
    rpc,
    account,
    policyProvider: () => ("policy" in overrides ? overrides.policy : makePolicy({ allowlist: { recipients: [RECIPIENT], contracts: [] } })),
    audit,
    confirm: overrides.confirm ?? (async () => BROADCAST_CONFIRMATION_PHRASE),
    output: (_line: string) => {},
    clock: overrides.clock ?? CLOCK,
    decisionIdFactory: () => `dec-live-${++counter}`,
    auditIdFactory: () => `aud-live-${++counter}`,
    hooks: {}
  } as unknown as Parameters<typeof runLiveTransfer>[0];
  return { rpc, account, audit, policies: () => deps.policyProvider, deps };
}

function target() {
  return { recipient: RECIPIENT, valueWei: VALUE_WEI };
}

function signedTxOf(rpc: MockRpc): string {
  return rpc.signedTransactions[0] ?? "";
}

describe("policy gating on the live path", () => {
  it("DENY (spend limit): no signing, no submission, no broadcast", async () => {
    const f = makeFixture({ policy: makePolicy({ spendLimit: { maxAmountWei: "1" }, allowlist: { recipients: [RECIPIENT], contracts: [] } }) });
    const signSpy = vi.spyOn(f.account, "signTransaction");
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("Policy DENY");
    expect(result.policyDecision?.decidingRuleIds).toContain("SPEND_LIMIT");
    expect(signSpy).not.toHaveBeenCalled();
    expect(f.rpc.sendRawCount).toBe(0);
  });

  it("DENY (allowlist): no signing, no submission", async () => {
    const f = makeFixture({ policy: makePolicy({ allowlist: { recipients: [], contracts: [] } }) });
    const signSpy = vi.spyOn(f.account, "signTransaction");
    const result = await runLiveTransfer(f.deps, { recipient: RECIPIENT, valueWei: VALUE_WEI });
    expect(result.status).toBe("blocked");
    expect(signSpy).not.toHaveBeenCalled();
    expect(f.rpc.sendRawCount).toBe(0);
  });

  it("DENY (time window expired): no signing, no submission", async () => {
    const f = makeFixture({
      policy: makePolicy({
        allowlist: { recipients: [RECIPIENT], contracts: [] },
        timeWindow: { timezone: "UTC", windows: [{ start: "09:00", end: "17:00" }], boundary: { startInclusive: true, endInclusive: false } }
      }),
      clock: () => new Date("2026-10-27T20:00:00Z")
    });
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.policyDecision?.decidingRuleIds).toContain("TIME_WINDOW");
    expect(f.rpc.sendRawCount).toBe(0);
  });

  it("invalid policy on the live path: fail-closed blocked, no signing, no submission", async () => {
    const f = makeFixture({ policy: { policyId: "broken" } });
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.policyDecision?.reasons.join(" ")).toContain("POLICY_INVALID");
    expect(f.rpc.sendRawCount).toBe(0);
  });

  it("audit-write failure on the live path: fail closed before signing", async () => {
    const f = makeFixture();
    f.audit.failNext = true;
    await expect(runLiveTransfer(f.deps, target())).rejects.toBeInstanceOf(AuditWriteError);
    expect(f.rpc.sendRawCount).toBe(0);
    expect(f.rpc.signedTransactions).toHaveLength(0);
  });
});

describe("confirmation gating", () => {
  it("no signing or submission before the user types exactly BROADCAST", async () => {
    const f = makeFixture({ confirm: async () => "yes" });
    const signSpy = vi.spyOn(f.account, "signTransaction");
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("did not type BROADCAST");
    expect(signSpy).not.toHaveBeenCalled();
    expect(f.rpc.sendRawCount).toBe(0);
  });

  it("whitespace-padded BROADCAST is accepted after trimming; case is NOT accepted", async () => {
    const f1 = makeFixture({ confirm: async () => "  BROADCAST  " });
    const r1 = await runLiveTransfer(f1.deps, target());
    expect(r1.status).toBe("confirmed");

    const f2 = makeFixture({ confirm: async () => "broadcast" });
    const r2 = await runLiveTransfer(f2.deps, target());
    expect(r2.status).toBe("blocked");
    expect(f2.rpc.sendRawCount).toBe(0);
  });

  it("the confirmation summary contains network, chain ID, sender, recipient, amount, gas, gas price, fee, and the policy decision", async () => {
    let captured = "";
    const f = makeFixture({ confirm: async (summary) => { captured = summary; return BROADCAST_CONFIRMATION_PHRASE; } });
    await runLiveTransfer(f.deps, target());
    expect(captured).toContain("Pharos Atlantic Testnet");
    expect(captured).toContain("688689");
    expect(captured).toContain(f.account.address); // locally derived sender
    expect(captured).toContain(RECIPIENT);
    expect(captured).toContain(VALUE_WEI.toString());
    expect(captured).toContain("estimated gas");
    expect(captured).toContain("gas price");
    expect(captured).toContain("estimated fee");
    expect(captured).toContain("ALLOW");
  });
});

describe("revalidation immediately before signing", () => {
  it("blocks when the policy changed after approval (limit lowered mid-flight)", async () => {
    const strict = makePolicy({ spendLimit: { maxAmountWei: "1" }, allowlist: { recipients: [RECIPIENT], contracts: [] } });
    const permissive = makePolicy({ allowlist: { recipients: [RECIPIENT], contracts: [] } });
    let call = 0;
    const f = makeFixture();
    (f.deps as { policyProvider: () => unknown }).policyProvider = () => (call++ === 0 ? permissive : strict);
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("no longer allows");
    expect(f.rpc.sendRawCount).toBe(0);
    expect(f.rpc.signedTransactions).toHaveLength(0);
  });

  it("blocks when the time window expired between approval and signing", async () => {
    const policy = makePolicy({
      allowlist: { recipients: [RECIPIENT], contracts: [] },
      timeWindow: { timezone: "UTC", windows: [{ start: "11:00", end: "13:00" }], boundary: { startInclusive: true, endInclusive: false } }
    });
    let tick = 0;
    const f = makeFixture({ policy, clock: () => (tick++ === 0 ? new Date("2026-10-27T12:00:00Z") : new Date("2026-10-27T13:30:00Z")) });
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.revalidationDecision?.decidingRuleIds).toContain("TIME_WINDOW");
    expect(f.rpc.sendRawCount).toBe(0);
  });

  it("blocks when transaction parameters drift between approval and signing", async () => {
    const f = makeFixture();
    const approvedHash = canonicalRequestHash({
      requestId: "probe",
      kind: "native_transfer",
      from: SENDER,
      to: RECIPIENT,
      valueWei: VALUE_WEI.toString()
    } as PolicyRequest);
    const guard = new PolicyGuard({ policyProvider: f.deps.policyProvider, audit: f.audit, mode: "live", clock: CLOCK });
    const drifted = { requestId: "probe", kind: "native_transfer", from: SENDER, to: RECIPIENT, valueWei: (VALUE_WEI + 1n).toString() } as PolicyRequest;
    const result = await guard.revalidateForSigning(drifted, approvedHash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("parameters changed");
  });
});

describe("network safety checks", () => {
  it("chain-ID mismatch blocks before any policy execution or submission", async () => {
    const f = makeFixture();
    f.rpc.chainIdValue = 1;
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("Chain ID mismatch");
    expect(f.rpc.sendRawCount).toBe(0);
    expect(f.audit.records.filter((r) => r.kind === "policy_decision")).toHaveLength(0); // stopped before policy evaluation
  });

  it("RPC unreachable blocks fail-closed", async () => {
    const f = makeFixture();
    f.rpc.failMethods.add("getChainId");
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("RPC unreachable");
    expect(f.rpc.sendRawCount).toBe(0);
  });

  it("insufficient balance blocks before simulation and submission", async () => {
    const f = makeFixture();
    f.rpc.balances.set(f.account.address.toLowerCase(), 1n);
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("Insufficient funds");
    expect(f.rpc.sendRawCount).toBe(0);
  });

  it("a predicted simulation revert blocks the broadcast", async () => {
    const f = makeFixture();
    f.rpc.callBehavior = "revert";
    f.rpc.revertData = "0x";
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("simulation predicts a revert");
    expect(f.rpc.sendRawCount).toBe(0);
  });

  it("gas estimation failure blocks the broadcast", async () => {
    const f = makeFixture();
    f.rpc.failMethods.add("estimateGas");
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("Gas estimation failed");
    expect(f.rpc.sendRawCount).toBe(0);
  });
});

describe("duplicate-send protection", () => {
  it("aborts when a pending transaction makes the nonce ambiguous (no signing, no sending)", async () => {
    const f = makeFixture();
    f.rpc.nonceLatest = 5;
    f.rpc.noncePending = 6;
    const signSpy = vi.spyOn(f.account, "signTransaction");
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("pending");
    expect(signSpy).not.toHaveBeenCalled();
    expect(f.rpc.sendRawCount).toBe(0);
  });

  it("aborts when pending nonce is LOWER than latest (RPC inconsistency)", async () => {
    const f = makeFixture();
    f.rpc.nonceLatest = 6;
    f.rpc.noncePending = 5;
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("blocked");
    expect(f.rpc.sendRawCount).toBe(0);
  });

  it("a submission error after a possible broadcast is NEVER retried and reported as ambiguous", async () => {
    const f = makeFixture();
    let attempts = 0;
    (f.rpc as unknown as { sendRawTransaction: (tx: `0x${string}`) => Promise<`0x${string}`> }).sendRawTransaction = async () => {
      attempts += 1;
      throw new Error("connection reset while submitting");
    };
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("ambiguous");
    expect(attempts).toBe(1); // exactly one attempt — no automatic retry
    expect(result.notice).toContain("AMBIGUOUS");
    expect(result.notice).toContain("No transaction hash was returned");
    expect(result.transactionHash).toBeUndefined();
  });
});

describe("successful live transfer with receipt verification", () => {
  it("signs locally, submits raw bytes once, verifies receipt fields, and records the tx hash in the audit log", async () => {
    const f = makeFixture();
    const signSpy = vi.spyOn(f.account, "signTransaction");
    const result = await runLiveTransfer(f.deps, target());

    // Local signing happened exactly once, with the right fields.
    expect(signSpy).toHaveBeenCalledTimes(1);
    const txArg = signSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(txArg["type"]).toBe("legacy");
    expect(txArg["chainId"]).toBe(688689);
    expect(txArg["to"]).toBe(RECIPIENT);
    expect(txArg["value"]).toBe(VALUE_WEI);
    expect(txArg["nonce"]).toBe(0);
    expect(txArg["gas"]).toBe(21000n);
    expect(txArg["gasPrice"]).toBe(1_000_000_000n);

    // Submission used ONLY sendRawTransaction with the locally signed bytes.
    expect(f.rpc.sendRawCount).toBe(1);
    expect(signedTxOf(f.rpc)).toMatch(/^0x[0-9a-fA-F]+$/);

    expect(result.status).toBe("confirmed");
    expect(result.transactionHash).toBeTruthy();
    const receipt = result.receipt!;
    expect(receipt.status).toBe("success");
    expect(receipt.chainId).toBe(688689);
    expect(receipt.valueWei).toBe(VALUE_WEI.toString());
    expect(receipt.actualFeeWei).toBe((21_000n * 1_000_000_000n).toString());
    expect(receipt.actualFeePhrs).toBe("0.000021");
    expect(receipt.confirmationsChecked).toBe(2); // head 1002 − receipt block 1001 + 1
    expect(receipt.explorerUrl).toContain("atlantic.pharosscan.xyz/tx/");
    expect(receipt.fieldVerification.find((v) => v.field === "to")?.match).toBe(true);
    expect(receipt.fieldVerification.find((v) => v.field === "value (wei)")?.match).toBe(true);

    // Audit: decision + execution with the real hash.
    const execRecord = f.audit.records.find((r) => r.kind === "execution_result");
    expect(execRecord?.transactionHash).toBe(result.transactionHash);
    expect(JSON.stringify(f.audit.records)).not.toMatch(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/);
  }, 15000);

  it("registers the transaction so value verification works against the mock chain state", async () => {
    const f = makeFixture();
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("confirmed");
    expect(result.receipt?.fieldVerification.every((v) => v.match)).toBe(true);
  });

  it("reports an on-chain revert honestly as failed-onchain", async () => {
    const f = makeFixture();
    f.rpc.receiptStatus = "reverted";
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("failed-onchain");
    expect(result.receipt?.status).toBe("reverted");
  });
});

describe("honest unresolved-receipt handling", () => {
  it("a submitted hash without a receipt is PENDING, never 'confirmed'", async () => {
    const f = makeFixture();
    f.rpc.waitForReceiptError = new Error("receipt timeout after 120000ms");
    f.rpc.receiptStatus = null; // the receipt does not exist on-chain yet
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("pending");
    expect(result.transactionHash).toBeTruthy(); // broadcast happened
    expect(result.receipt).toBeUndefined();
    expect(result.notice).toContain("PENDING / UNRESOLVED");
    expect(result.notice).toContain("NOT confirmed");
    // The audit log must not claim execution success.
    const exec = f.audit.records.find((r) => r.kind === "execution_result");
    expect(exec).toBeUndefined();
  });

  it("recovers via an explicit manual receipt lookup when the wait times out but the receipt exists", async () => {
    const f = makeFixture();
    f.rpc.waitForReceiptError = new Error("receipt timeout after 120000ms");
    const result = await runLiveTransfer(f.deps, target());
    expect(result.status).toBe("confirmed");
    expect(result.receipt?.transactionHash).toBeTruthy();
    expect(result.receipt?.transactionHash).toBe(result.transactionHash);
  });
});

describe("source-level guarantees", () => {
  it("the string eth_sendTransaction never appears in application source", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "..", "src");
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else if (entry.name.endsWith(".ts")) files.push(p);
      }
    }
    await walk(root);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text, `${file} must not reference the wallet-managed send RPC`).not.toContain("eth_sendTransaction");
    }
  });
});

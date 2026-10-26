/**
 * Mode C — real Pharos Atlantic testnet transfer.
 *
 * This module is the ONLY normal application entry point capable of
 * broadcasting a transaction, and it can do so only after:
 *   policy approval (PolicyGuard) → pre-broadcast safety checks → read-only
 *   simulation → explicit user confirmation (typing exactly "BROADCAST") →
 *   full revalidation immediately before signing → local signing with viem →
 *   eth_sendRawTransaction.
 *
 * Never uses the wallet-managed send RPC (the JSON-RPC method that lets a node
 * assemble and sign the transaction). Never retries after a possible broadcast.
 * A submitted hash without a receipt is reported as pending/unresolved,
 * never as confirmed.
 */
import { getAddress, type PrivateKeyAccount } from "viem";
import type { PolicyDecision, PolicyRequest } from "../types.js";
import type { AuditLogger } from "../audit/logger.js";
import { PolicyGuard, canonicalRequestHash, sanitize } from "../execution/guard.js";
import { simulateTransfer, type SimulationResult } from "./simulate.js";
import type { TestnetRpc } from "./client.js";
import { ATLANTIC_CHAIN_ID, ATLANTIC_EXPLORER_URL } from "./client.js";
import { formatWeiToPhrs } from "../units.js";

export const BROADCAST_CONFIRMATION_PHRASE = "BROADCAST";

export interface LiveTransferTarget {
  recipient: string;
  valueWei: bigint;
}

export interface LiveTransferDeps {
  rpc: TestnetRpc;
  /** Locally derived viem account (private key never leaves this machine). */
  account: Pick<PrivateKeyAccount, "address" | "signTransaction">;
  /** Returns the raw policy; called on EVERY evaluation so changes are always observed. */
  policyProvider: () => unknown;
  audit: AuditLogger;
  /** Confirmation prompt. Must return the exact phrase BROADCAST to proceed. */
  confirm: (summary: string) => Promise<string>;
  /** Output sink (defaults to console.log). Injectable for tests. */
  output?: (line: string) => void;
  clock?: () => Date;
  decisionIdFactory?: () => string;
  receiptTimeoutMs?: number;
  /** Test hooks. Not used in normal operation. */
  hooks?: {
    afterConfirm?: () => Promise<void> | void;
    beforeSign?: () => Promise<void> | void;
  };
}

export interface StageRecord {
  step: number;
  name: string;
  status: "ok" | "blocked" | "failed" | "pending" | "executed";
  detail: string;
}

export interface LiveTransferReceiptReport {
  transactionHash: string;
  chainId: number;
  networkName: string;
  from: string;
  to: string | null;
  valueWei: string;
  valuePhrs: string;
  blockNumber: string;
  status: "success" | "reverted";
  gasUsed: string;
  effectiveGasPriceWei: string | null;
  actualFeeWei: string | null;
  actualFeePhrs: string | null;
  /** Included only when actually computed from current block number. */
  confirmationsChecked: number | null;
  explorerUrl: string;
  fieldVerification: Array<{ field: string; expected: string; actual: string; match: boolean }>;
}

export interface LiveTransferResult {
  status: "confirmed" | "pending" | "failed-onchain" | "blocked" | "ambiguous";
  blockedReason?: string;
  policyDecision?: PolicyDecision;
  revalidationDecision?: PolicyDecision;
  simulation?: SimulationResult;
  transactionHash?: string;
  receipt?: LiveTransferReceiptReport;
  stages: StageRecord[];
  explorerUrl?: string;
  /** Present when the outcome after submission could not be determined. */
  notice?: string;
  requestHash: string;
}

function summarizeSimulation(sim: SimulationResult): string {
  const lines = [
    `eth_call: ${sim.ethCall.status}`,
    sim.ethCall.revert ? `revert: ${sim.ethCall.revert.description}` : null,
    sim.gasEstimateWei !== null ? `gas estimate: ${sim.gasEstimateWei.toString()}` : null,
    sim.gasPriceWei !== null ? `gas price: ${sim.gasPriceWei.toString()} wei` : null,
    sim.estimatedFeeWei !== null ? `estimated fee: ${sim.estimatedFeeWei.toString()} wei (${sim.estimatedFeePhrs} PHRS)` : null,
    sim.senderBalanceWei !== null ? `sender balance: ${sim.senderBalanceWei.toString()} wei` : null
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

/**
 * Runs the complete live-transfer safety sequence. Any DENY, failed check,
 * missing confirmation, or revalidation drift stops BEFORE signing.
 */
export async function runLiveTransfer(deps: LiveTransferDeps, target: LiveTransferTarget): Promise<LiveTransferResult> {
  const out = deps.output ?? ((line: string) => console.log(line));
  const stages: StageRecord[] = [];
  const record = (step: number, name: string, status: StageRecord["status"], detail: string): void => {
    stages.push({ step, name, status, detail });
  };

  const sender = getAddress(deps.account.address);
  const recipient = getAddress(target.recipient);

  const guard = new PolicyGuard({
    policyProvider: deps.policyProvider,
    audit: deps.audit,
    mode: "live",
    clock: deps.clock,
    decisionIdFactory: deps.decisionIdFactory
  });

  const request: PolicyRequest = {
    requestId: `live-transfer-${Date.now()}`,
    kind: "native_transfer",
    from: sender,
    to: recipient,
    valueWei: target.valueWei.toString()
  };
  const requestHash = canonicalRequestHash(request);

  // Step 1: sender derived locally. Step 2: verify RPC chain ID.
  let actualChainId: number | null = null;
  try {
    actualChainId = await deps.rpc.getChainId();
    record(2, "chain-id-verification", actualChainId === ATLANTIC_CHAIN_ID ? "ok" : "blocked", `RPC reports chain ID ${actualChainId}; expected ${ATLANTIC_CHAIN_ID}.`);
    if (actualChainId !== ATLANTIC_CHAIN_ID) {
      return {
        status: "blocked",
        blockedReason: `Chain ID mismatch: RPC reports ${actualChainId}, expected ${ATLANTIC_CHAIN_ID}. No transaction was signed or broadcast.`,
        stages,
        requestHash
      };
    }
  } catch (err) {
    record(2, "chain-id-verification", "failed", `Could not query chain ID: ${sanitize((err as Error).message)}`);
    return {
      status: "blocked",
      blockedReason: `RPC unreachable: ${sanitize((err as Error).message)}. No transaction was signed or broadcast.`,
      stages,
      requestHash
    };
  }

  // Steps 3 (policy evaluation) + audit of the decision.
  const { decision } = await guard.evaluateAndRecord(request);
  record(
    3,
    "policy-decision",
    decision.decision === "ALLOW" ? "ok" : "blocked",
    `Policy ${decision.policyId} v${decision.policyVersion} → ${decision.decision}` +
      (decision.reasons.length > 0 ? ` — ${decision.reasons.join(" | ")}` : "")
  );
  if (decision.decision === "DENY") {
    return {
      status: "blocked",
      blockedReason: `Policy DENY: ${decision.reasons.join(" | ")} No transaction was signed or broadcast.`,
      policyDecision: decision,
      stages,
      requestHash
    };
  }

  // Step 4/5: funds + gas reads (all read-only, all fail-closed).
  let gasEstimate: bigint | null = null;
  let gasPrice: bigint | null = null;
  let balance: bigint | null = null;
  try {
    gasEstimate = await deps.rpc.estimateGas({ from: sender, to: recipient, value: target.valueWei });
    record(4, "gas-estimation", "ok", `eth_estimateGas → ${gasEstimate.toString()}`);
  } catch (err) {
    record(4, "gas-estimation", "failed", sanitize((err as Error).message));
    return blockedAfterDecision(decision, `Gas estimation failed: ${sanitize((err as Error).message)}`, stages, requestHash);
  }
  try {
    gasPrice = await deps.rpc.getGasPrice();
    record(5, "gas-price", "ok", `gas price → ${gasPrice.toString()} wei`);
  } catch (err) {
    record(5, "gas-price", "failed", sanitize((err as Error).message));
    return blockedAfterDecision(decision, `Gas price query failed: ${sanitize((err as Error).message)}`, stages, requestHash);
  }
  try {
    balance = await deps.rpc.getBalance(sender);
    record(6, "sender-balance", "ok", `balance → ${balance.toString()} wei (${formatWeiToPhrs(balance)} PHRS)`);
  } catch (err) {
    record(6, "sender-balance", "failed", sanitize((err as Error).message));
    return blockedAfterDecision(decision, `Balance query failed: ${sanitize((err as Error).message)}`, stages, requestHash);
  }
  const fee = (gasEstimate ?? 0n) * (gasPrice ?? 0n);
  const totalNeeded = target.valueWei + fee;
  if (balance === null || balance < totalNeeded) {
    record(6, "balance-sufficiency", "blocked", `balance ${balance?.toString() ?? "unknown"} < value + fee ${totalNeeded.toString()}`);
    return blockedAfterDecision(
      decision,
      `Insufficient funds: balance ${balance?.toString() ?? "unknown"} wei is below value + estimated fee (${totalNeeded.toString()} wei). No transaction was signed or broadcast.`,
      stages,
      requestHash
    );
  }

  // Step 6: read-only simulation (never broadcasts).
  const simulation = await simulateTransfer({
    rpc: deps.rpc,
    sender,
    recipient,
    valueWei: target.valueWei,
    expectedChainId: ATLANTIC_CHAIN_ID
  });
  record(
    7,
    "pre-broadcast-simulation",
    simulation.ok && simulation.ethCall.status === "success" ? "ok" : "blocked",
    summarizeSimulation(simulation)
  );
  if (!simulation.ok) {
    return blockedAfterDecision(decision, `Pre-broadcast simulation failed (${simulation.errorCode}): ${simulation.errorMessage ?? "unknown error"}. No transaction was signed or broadcast.`, stages, requestHash, simulation);
  }
  if (simulation.ethCall.status !== "success") {
    return blockedAfterDecision(
      decision,
      `Pre-broadcast simulation predicts a revert: ${simulation.ethCall.revert?.description ?? "no revert data"}. No transaction was signed or broadcast.`,
      stages,
      requestHash,
      simulation
    );
  }

  // Step 7: exact transaction summary + explicit confirmation.
  const summary = [
    "=== LIVE TESTNET TRANSACTION — REQUIRES EXPLICIT CONFIRMATION ===",
    `network:            Pharos Atlantic Testnet`,
    `chain ID:           ${ATLANTIC_CHAIN_ID} (verified against RPC)`,
    `sender:             ${sender}`,
    `recipient:          ${recipient}`,
    `amount:             ${target.valueWei.toString()} wei (${formatWeiToPhrs(target.valueWei)} PHRS)`,
    `estimated gas:      ${gasEstimate?.toString() ?? "unknown"}`,
    `gas price:          ${gasPrice?.toString() ?? "unknown"} wei`,
    `estimated fee:      ${fee.toString()} wei (${formatWeiToPhrs(fee)} PHRS)`,
    `policy decision:    ALLOW (decision ${decision.decisionId}, policy ${decision.policyId} v${decision.policyVersion})`,
    `pre-broadcast sim:  eth_call succeeded; ${simulation.gasEstimateWei?.toString() ?? "?"} gas`,
    ``,
    `This will broadcast a REAL transaction on the Pharos Atlantic testnet.`,
    `Type exactly ${BROADCAST_CONFIRMATION_PHRASE} to confirm. Anything else aborts.`
  ].join("\n");
  out(summary);
  const answer = (await deps.confirm(summary)).trim();
  record(8, "user-confirmation", answer === BROADCAST_CONFIRMATION_PHRASE ? "ok" : "blocked", `user typed ${answer === BROADCAST_CONFIRMATION_PHRASE ? "BROADCAST" : "something other than BROADCAST"}`);
  if (answer !== BROADCAST_CONFIRMATION_PHRASE) {
    await recordBlockedExecution(deps.audit, decision, "User did not type BROADCAST; transaction not signed or broadcast.");
    return {
      status: "blocked",
      blockedReason: "User did not type BROADCAST. No transaction was signed or broadcast.",
      policyDecision: decision,
      simulation,
      stages,
      requestHash
    };
  }
  if (deps.hooks?.afterConfirm) await deps.hooks.afterConfirm();

  // Step 9: revalidation immediately before signing (fresh policy + clock, unchanged parameters).
  const revalidation = await guard.revalidateForSigning(request, requestHash);
  record(
    9,
    "pre-sign-revalidation",
    revalidation.ok ? "ok" : "blocked",
    revalidation.ok
      ? `Policy re-evaluated: ALLOW (decision ${revalidation.decision.decisionId}); transaction parameters unchanged (hash ${requestHash.slice(0, 16)}…).`
      : revalidation.reason
  );
  if (!revalidation.ok) {
    await recordBlockedExecution(deps.audit, decision, `Blocked at pre-sign revalidation: ${revalidation.reason}`);
    return {
      status: "blocked",
      blockedReason: revalidation.reason,
      policyDecision: decision,
      revalidationDecision: revalidation.decision,
      simulation,
      stages,
      requestHash
    };
  }

  // Step 10: duplicate-send protection — pending nonce must not be ahead of latest.
  let latestNonce: number;
  let pendingNonce: number;
  try {
    latestNonce = await deps.rpc.getTransactionCount(sender, "latest");
    pendingNonce = await deps.rpc.getTransactionCount(sender, "pending");
    record(
      10,
      "nonce-check",
      pendingNonce === latestNonce ? "ok" : "blocked",
      `latest=${latestNonce} pending=${pendingNonce}`
    );
    if (pendingNonce !== latestNonce) {
      await recordBlockedExecution(deps.audit, decision, `Blocked by duplicate-send protection: pending nonce (${pendingNonce}) differs from latest (${latestNonce}).`);
      return {
        status: "blocked",
        blockedReason: `Duplicate-send protection: sender has an unexpected pending transaction (pending nonce ${pendingNonce} != latest ${latestNonce}). The outcome of a new send would be ambiguous — resolve the pending transaction first. No transaction was signed or broadcast.`,
        policyDecision: decision,
        revalidationDecision: revalidation.decision,
        simulation,
        stages,
        requestHash
      };
    }
  } catch (err) {
    record(10, "nonce-check", "failed", sanitize((err as Error).message));
    return blockedAfterDecision(decision, `Nonce check failed: ${sanitize((err as Error).message)}`, stages, requestHash, simulation);
  }

  // Step 11: local signing with viem (private key never leaves this machine).
  if (deps.hooks?.beforeSign) await deps.hooks.beforeSign();
  let signedTx: `0x${string}`;
  try {
    signedTx = await deps.account.signTransaction({
      type: "legacy",
      chainId: ATLANTIC_CHAIN_ID,
      to: recipient,
      value: target.valueWei,
      nonce: latestNonce,
      gas: gasEstimate ?? 21000n,
      gasPrice: gasPrice ?? 0n
    });
    record(11, "local-signing", "ok", "transaction signed locally (viem private-key account).");
  } catch (err) {
    record(11, "local-signing", "failed", sanitize((err as Error).message));
    await recordBlockedExecution(deps.audit, decision, `Signing failed before any submission: ${sanitize((err as Error).message)}`);
    return {
      status: "blocked",
      blockedReason: `Signing failed: ${sanitize((err as Error).message)}. Nothing was submitted.`,
      policyDecision: decision,
      revalidationDecision: revalidation.decision,
      simulation,
      stages,
      requestHash
    };
  }

  // Step 12: single submission attempt via eth_sendRawTransaction. Never retried.
  let hash: `0x${string}` | null = null;
  try {
    hash = await deps.rpc.sendRawTransaction(signedTx);
    record(12, "broadcast", "executed", `eth_sendRawTransaction → ${hash}`);
  } catch (err) {
    record(12, "broadcast", "failed", sanitize((err as Error).message));
    await recordBlockedExecution(deps.audit, decision, `Submission error after possible broadcast (NOT retried): ${sanitize((err as Error).message)}`);
    return {
      status: "ambiguous",
      policyDecision: decision,
      revalidationDecision: revalidation.decision,
      simulation,
      stages,
      requestHash,
      notice:
        "Submission returned an error after the signed transaction may already have been broadcast. Per duplicate-send protection, no retry was attempted. The outcome is AMBIGUOUS: inspect the explorer and the sender's nonce/transaction list before doing anything else. No transaction hash was returned by the RPC, so none is reported."
    };
  }

  // Step 13: wait for the real receipt.
  try {
    const receipt = await deps.rpc.waitForTransactionReceipt(hash, { timeoutMs: deps.receiptTimeoutMs ?? 120_000 });
    record(13, "receipt", receipt.status === "success" ? "ok" : "failed", `status=${receipt.status} block=${receipt.blockNumber.toString()} gasUsed=${receipt.gasUsed.toString()}`);
    return await finalizeReceipt(deps, {
      decision,
      revalidationDecision: revalidation.decision,
      simulation,
      stages,
      requestHash,
      hash,
      receipt,
      recipient,
      valueWei: target.valueWei
    });
  } catch (err) {
    record(13, "receipt", "pending", `Receipt not available within timeout: ${sanitize((err as Error).message)}`);
    // One honest manual check before declaring unresolved.
    const receipt = await deps.rpc.getTransactionReceipt(hash);
    if (receipt) {
      return await finalizeReceipt(deps, {
        decision,
        revalidationDecision: revalidation.decision,
        simulation,
        stages,
        requestHash,
        hash,
        receipt,
        recipient,
        valueWei: target.valueWei
      });
    }
    return {
      status: "pending",
      policyDecision: decision,
      revalidationDecision: revalidation.decision,
      simulation,
      transactionHash: hash,
      explorerUrl: `${ATLANTIC_EXPLORER_URL}/tx/${hash}`,
      stages,
      requestHash,
      notice:
        "Transaction was broadcast and a hash was returned, but no receipt has been observed yet. The transaction is PENDING / UNRESOLVED — it is NOT confirmed. Re-check the explorer or run a receipt lookup later."
    };
  }
}

async function finalizeReceipt(
  deps: LiveTransferDeps,
  ctx: {
    decision: PolicyDecision;
    revalidationDecision?: PolicyDecision;
    simulation?: SimulationResult;
    stages: StageRecord[];
    requestHash: string;
    hash: `0x${string}`;
    receipt: NonNullable<Awaited<ReturnType<TestnetRpc["getTransactionReceipt"]>>>;
    recipient: string;
    valueWei: bigint;
  }
): Promise<LiveTransferResult> {
  const receipt = ctx.receipt;
  const sender = getAddress(deps.account.address);
  const tx = await deps.rpc.getTransaction(ctx.hash);

  const fieldVerification: LiveTransferReceiptReport["fieldVerification"] = [
    { field: "from", expected: sender, actual: receipt.from, match: receipt.from.toLowerCase() === sender.toLowerCase() },
    {
      field: "to",
      expected: ctx.recipient,
      actual: receipt.to ?? "(null)",
      match: receipt.to !== null && receipt.to.toLowerCase() === ctx.recipient.toLowerCase()
    },
    {
      field: "value (wei)",
      expected: ctx.valueWei.toString(),
      actual: tx ? tx.value.toString() : "(transaction not found)",
      match: tx !== null && tx.value === ctx.valueWei && tx.to !== null && tx.to.toLowerCase() === ctx.recipient.toLowerCase()
    }
  ];

  let confirmationsChecked: number | null = null;
  try {
    const head = await deps.rpc.getBlockNumber();
    confirmationsChecked = Number(head - receipt.blockNumber) + 1;
  } catch {
    confirmationsChecked = null; // Only report confirmations when actually checked.
  }

  const actualFeeWei = receipt.effectiveGasPrice !== null ? receipt.gasUsed * receipt.effectiveGasPrice : null;

  const report: LiveTransferReceiptReport = {
    transactionHash: receipt.transactionHash,
    chainId: ATLANTIC_CHAIN_ID,
    networkName: "Pharos Atlantic Testnet",
    from: receipt.from,
    to: receipt.to,
    valueWei: tx ? tx.value.toString() : "unknown",
    valuePhrs: tx ? formatWeiToPhrs(tx.value) : "unknown",
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPriceWei: receipt.effectiveGasPrice !== null ? receipt.effectiveGasPrice.toString() : null,
    actualFeeWei: actualFeeWei !== null ? actualFeeWei.toString() : null,
    actualFeePhrs: actualFeeWei !== null ? formatWeiToPhrs(actualFeeWei) : null,
    confirmationsChecked,
    explorerUrl: `${ATLANTIC_EXPLORER_URL}/tx/${receipt.transactionHash}`,
    fieldVerification
  };

  await deps.audit.append({
    auditId: `aud-${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    kind: "execution_result",
    requestId: ctx.decision.requestId,
    policyId: ctx.decision.policyId,
    policyVersion: ctx.decision.policyVersion,
    mode: "live",
    decisionId: ctx.decision.decisionId,
    executionAttempted: true,
    execution: {
      status: receipt.status === "success" ? "executed" : "failed",
      detail: `Broadcast ${receipt.transactionHash}; receipt status ${receipt.status}; block ${receipt.blockNumber.toString()}; gasUsed ${receipt.gasUsed.toString()}.`,
      transactionHash: receipt.transactionHash
    },
    transactionHash: receipt.transactionHash
  });

  return {
    status: receipt.status === "success" ? "confirmed" : "failed-onchain",
    policyDecision: ctx.decision,
    revalidationDecision: ctx.revalidationDecision,
    simulation: ctx.simulation,
    transactionHash: receipt.transactionHash,
    receipt: report,
    explorerUrl: report.explorerUrl,
    stages: ctx.stages,
    requestHash: ctx.requestHash
  };
}

async function recordBlockedExecution(audit: AuditLogger, decision: PolicyDecision, detail: string): Promise<void> {
  await audit.append({
    auditId: `aud-${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    kind: "execution_result",
    requestId: decision.requestId,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    mode: "live",
    decisionId: decision.decisionId,
    executionAttempted: false,
    execution: { status: "failed", detail: sanitize(detail) }
  });
}

function blockedAfterDecision(
  decision: PolicyDecision,
  reason: string,
  stages: StageRecord[],
  requestHash: string,
  simulation?: SimulationResult
): LiveTransferResult {
  return {
    status: "blocked",
    blockedReason: reason,
    policyDecision: decision,
    simulation,
    stages,
    requestHash
  };
}

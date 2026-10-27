/**
 * CLI entry points.
 *
 *   npm run simulate:testnet   → `tsx src/cli.ts simulate`  (Mode B, read-only)
 *   npm run testnet:transfer   → `tsx src/cli.ts transfer`  (Mode C, live, explicit confirmation)
 *
 * There is no other normal entry point that can broadcast a transaction.
 */
import { readFileSync } from "node:fs";
import * as readline from "node:readline/promises";
import { privateKeyToAccount } from "viem/accounts";
import { loadDotEnv, loadLiveTransferEnv, loadSimulationEnv } from "./config.js";
import { createTestnetRpc } from "./testnet/client.js";
import { simulateTransfer, type SimulationResult } from "./testnet/simulate.js";
import { runLiveTransfer, BROADCAST_CONFIRMATION_PHRASE, type LiveTransferResult } from "./testnet/transfer.js";
import { buildSimulationEvidence, writeSimulationEvidence, writeLiveTransactionEvidence } from "./testnet/evidence.js";
import { PolicyGuard } from "./execution/guard.js";
import { JsonLinesAuditLogger } from "./audit/logger.js";
import { parsePhrsToWei } from "./units.js";
import type { PolicyDecision, PolicyRequest } from "./types.js";

const HELP = `Policy Gatekeeper — Pharos SkillEngine skill

Commands:
  npm run demo               Deterministic mock demo (no blockchain interaction)
  npm run simulate:testnet   Read-only Pharos Atlantic testnet simulation
                             (real RPC eth_call / eth_estimateGas; NEVER signs or broadcasts)
  npm run testnet:transfer   LIVE transfer on Pharos Atlantic testnet
                             (requires wallet env config and typing BROADCAST to confirm)

See README.md and skills/policy-gatekeeper/SKILL.md for details.`;

export function printSimulationReport(result: SimulationResult, decision: PolicyDecision | null): void {
  console.log("=== READ-ONLY TESTNET SIMULATION — NO TRANSACTION BROADCAST ===");
  console.log(`network chain ID (expected/actual): ${result.chainId.expected}/${result.chainId.actual ?? "unavailable"} ${result.chainId.verified ? "(verified)" : "(NOT verified)"}`);
  if (decision) {
    console.log(`policy decision: ${decision.decision} (decision ${decision.decisionId}, policy ${decision.policyId} v${decision.policyVersion})`);
    for (const r of decision.ruleResults) console.log(`  - ${r.ruleId}: ${r.passed ? "PASS" : "FAIL"} — ${r.reason}`);
    for (const reason of decision.reasons) console.log(`  - ${reason}`);
  }
  console.log(`value: ${result.valueWei} wei (${result.valuePhrs} PHRS)`);
  if (result.ok) {
    console.log(`eth_call: ${result.ethCall.status}`);
    if (result.ethCall.revert) console.log(`revert reason: ${result.ethCall.revert.description} (raw: ${result.ethCall.revert.rawData})`);
    if (result.ethCall.returnData && result.ethCall.returnData !== "0x") console.log(`return data: ${result.ethCall.returnData}`);
    console.log(`gas estimate (eth_estimateGas): ${result.gasEstimateWei?.toString() ?? "unavailable"}`);
    console.log(`gas price: ${result.gasPriceWei?.toString() ?? "unavailable"} wei`);
    console.log(`estimated fee (BigInt): ${result.estimatedFeeWei?.toString() ?? "unavailable"} wei (${result.estimatedFeePhrs ?? "unavailable"} PHRS)`);
    console.log(`sender balance: ${result.senderBalanceWei?.toString() ?? "unavailable"} wei`);
    console.log(
      result.balancePredictionReliable
        ? `predicted sender balance after: ${result.predictedSenderBalanceAfterWei?.toString()} wei (read-only prediction)`
        : "predicted sender balance after: not reliable (omitted)"
    );
    if (result.ethCall.status === "reverted") {
      console.log("PREDICTED OUTCOME: the transaction would REVERT if submitted. Nothing was broadcast.");
    } else {
      console.log("PREDICTED OUTCOME: simulation succeeded. This does NOT guarantee a later broadcast will succeed.");
    }
  } else {
    console.log(`RESULT: fail-closed error at stage "${result.stage}" (${result.errorCode})`);
    console.log(`error: ${result.errorMessage ?? "unknown"}`);
  }
  for (const note of result.notes) console.log(`note: ${note}`);
}

async function runSimulate(): Promise<number> {
  loadDotEnv();
  const env = loadSimulationEnv();
  if (!env.ok) {
    console.error("Simulation configuration is incomplete (fail-closed):");
    for (const e of env.errors) console.error(`  - ${e}`);
    return 1;
  }
  const cfg = env.config;

  let sender = cfg.sender;
  if (sender === "DERIVE_FROM_KEY") {
    const { privateKeyToAccount } = await import("viem/accounts");
    const key = (process.env["PHAROS_TESTNET_PRIVATE_KEY"] ?? "").trim() as `0x${string}`;
    sender = privateKeyToAccount(key).address;
    console.log("Sender derived locally from PHAROS_TESTNET_PRIVATE_KEY (key never printed).");
  }

  // Policy decision (mode "simulation") — evaluated and audited like every other path.
  const audit = new JsonLinesAuditLogger(cfg.auditPath);
  const guard = new PolicyGuard({ policyProvider: () => JSON.parse(readFileSync(cfg.policyPath, "utf8")), audit, mode: "simulation" });
  const request: PolicyRequest = {
    requestId: `sim-${Date.now()}`,
    kind: "native_transfer",
    from: sender,
    to: cfg.recipient,
    valueWei: parsePhrsToWei(cfg.amountPhrs).toString()
  };
  let decision: PolicyDecision | null = null;
  try {
    decision = (await guard.evaluateAndRecord(request)).decision;
  } catch (err) {
    console.error(`Policy decision could not be recorded (fail-closed): ${(err as Error).message}`);
    return 1;
  }

  const rpc = createTestnetRpc(cfg.rpcUrl);
  const result = await simulateTransfer({
    rpc,
    sender: sender as `0x${string}`,
    recipient: cfg.recipient as `0x${string}`,
    valueWei: parsePhrsToWei(cfg.amountPhrs),
    expectedChainId: cfg.chainId
  });

  printSimulationReport(result, decision);

  const evidence = buildSimulationEvidence({
    result,
    rpcUrl: cfg.rpcUrl,
    sender,
    recipient: cfg.recipient,
    generatedAt: new Date(),
    decision
  });
  await writeSimulationEvidence(evidence, "evidence/testnet-simulation");
  console.log("");
  console.log(`Evidence written: evidence/testnet-simulation.json, evidence/testnet-simulation.md (labeled ${result.label}).`);
  console.log("No transaction was signed or broadcast.");
  return result.ok ? 0 : 1;
}

function askConfirmation(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(prompt).finally(() => rl.close());
}

function printLiveResult(result: LiveTransferResult): void {
  console.log("");
  console.log(`=== LIVE TRANSFER RESULT: ${result.status.toUpperCase()} ===`);
  if (result.blockedReason) console.log(`blocked: ${result.blockedReason}`);
  if (result.notice) console.log(`notice: ${result.notice}`);
  if (result.auditPersistenceError) {
    console.log(`audit persistence failure (transaction result above is real and unaffected; no retry was attempted): ${result.auditPersistenceError}`);
  }
  if (result.transactionHash) console.log(`transaction hash: ${result.transactionHash}`);
  const r = result.receipt;
  if (r) {
    console.log(`network: ${r.networkName} (chain ID ${r.chainId})`);
    console.log(`sender: ${r.from}`);
    console.log(`recipient: ${r.to ?? "(null)"}`);
    console.log(`value: ${r.valueWei} wei (${r.valuePhrs} PHRS)`);
    console.log(`block number: ${r.blockNumber}`);
    console.log(`receipt status: ${r.status}`);
    console.log(`gas used: ${r.gasUsed}`);
    console.log(`effective gas price: ${r.effectiveGasPriceWei ?? "unavailable"} wei`);
    console.log(`actual fee (gasUsed × effectiveGasPrice): ${r.actualFeeWei ?? "unavailable"} wei (${r.actualFeePhrs ?? "unavailable"} PHRS)`);
    console.log(`confirmations at report time: ${r.confirmationsChecked ?? "not checked"}`);
    console.log(`explorer: ${r.explorerUrl} (official URL from Pharos docs)`);
    for (const f of r.fieldVerification) {
      console.log(`verify ${f.field}: expected=${f.expected} actual=${f.actual} match=${f.match ? "YES" : "NO"}`);
    }
  } else if (result.status === "pending") {
    console.log("The transaction is PENDING / UNRESOLVED — a submitted hash without a receipt is NOT confirmed.");
  }
}

async function runTransfer(): Promise<number> {
  loadDotEnv();
  const env = loadLiveTransferEnv();
  if (!env.ok) {
    console.error("Live transfer is not configured. Nothing was signed or broadcast. To proceed:");
    for (const e of env.errors) console.error(`  - ${e}`);
    console.error("Then add the recipient to the policy allowlist (POLICY_PATH) before retrying.");
    return 1;
  }
  const cfg = env.config;

  const account = privateKeyToAccount(cfg.privateKey);
  console.log(`Sender address derived locally: ${account.address} (private key never printed or logged).`);
  console.log(`RPC: ${cfg.rpcUrl} — chain ID must be ${cfg.chainId}.`);

  // Fresh policy read on every evaluation so mid-flight policy changes are detected.
  const policyProvider = (): unknown => JSON.parse(readFileSync(cfg.policyPath, "utf8"));
  const audit = new JsonLinesAuditLogger(cfg.auditPath);
  const rpc = createTestnetRpc(cfg.rpcUrl);

  let result: LiveTransferResult;
  try {
    result = await runLiveTransfer(
      {
        rpc,
        account,
        policyProvider,
        audit,
        confirm: (_summary) => askConfirmation(`\nType ${BROADCAST_CONFIRMATION_PHRASE} to broadcast, or anything else to abort: `),
        receiptTimeoutMs: 120_000
      },
      { recipient: cfg.recipient, valueWei: parsePhrsToWei(cfg.amountPhrs) }
    );
  } catch (err) {
    console.error(`Live transfer aborted with an unexpected error (fail-closed): ${(err as Error).message}`);
    return 1;
  }

  printLiveResult(result);
  // Live evidence files are written only when a real broadcast produced a transaction hash.
  if (result.transactionHash) {
    await writeLiveTransactionEvidence(result, "evidence/live-testnet-transaction", new Date());
    console.log("Evidence written: evidence/live-testnet-transaction.json, evidence/live-testnet-transaction.md");
  } else {
    console.log("No broadcast occurred, so no live-transaction evidence files were written.");
  }

  if (result.status === "confirmed" || result.status === "failed-onchain") {
    return 0; // The run completed; an on-chain revert is an honest, reported outcome.
  }
  if (result.status === "pending" || result.status === "ambiguous") {
    return 2; // Outcome unresolved — investigate before any further action.
  }
  return 1; // blocked
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[2] ?? "help";
  switch (command) {
    case "simulate":
      return runSimulate();
    case "transfer":
      return runTransfer();
    case "help":
    default:
      console.log(HELP);
      return command === "help" ? 0 : 1;
  }
}

const invokedDirectly = /src[\\/]cli\.(ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (invokedDirectly) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}

/**
 * Evidence writers. Every value written comes from actual program results —
 * nothing is fabricated. Evidence files contain no secrets (messages are
 * sanitized and private keys are never accepted here).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PolicyDecision } from "../types.js";
import { ATLANTIC_EXPLORER_URL } from "./client.js";
import type { SimulationResult } from "./simulate.js";
import { SIMULATION_LABEL } from "./simulate.js";
import type { LiveTransferResult, LiveTransferReceiptReport } from "./transfer.js";

async function writeFileChecked(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  if (dir && dir !== ".") await mkdir(dir, { recursive: true });
  await writeFile(path, content, "utf8");
}

/* ---------------------------------- JSON ---------------------------------- */

export interface SimulationEvidence {
  label: typeof SIMULATION_LABEL;
  generatedAt: string;
  broadcasted: false;
  signed: false;
  network: { name: string; chainIdExpected: number; chainIdActual: number | null; chainIdVerified: boolean; rpcUrl: string };
  policy?: { decisionId: string; decision: string; policyId: string; policyVersion: string; ruleResults: unknown[]; reasons: string[] };
  request: { kind: string; sender: string; recipient: string; valueWei: string; valuePhrs: string };
  simulation: {
    ok: boolean;
    stage?: string;
    errorCode?: string;
    errorMessage?: string;
    ethCall: { method: string; status: string; returnData: string | null; revert: unknown };
    gasEstimateWei: string | null;
    gasPriceWei: string | null;
    estimatedFeeWei: string | null;
    estimatedFeePhrs: string | null;
    senderBalanceWei: string | null;
    predictedSenderBalanceAfterWei: string | null;
    balancePredictionReliable: boolean;
  };
  notes: string[];
  disclaimer: string[];
}

export function buildSimulationEvidence(args: {
  result: SimulationResult;
  rpcUrl: string;
  sender: string;
  recipient: string;
  generatedAt: Date;
  decision?: PolicyDecision;
}): SimulationEvidence {
  const r = args.result;
  return {
    label: SIMULATION_LABEL,
    generatedAt: args.generatedAt.toISOString(),
    broadcasted: false,
    signed: false,
    network: {
      name: "Pharos Atlantic Testnet",
      chainIdExpected: r.chainId.expected,
      chainIdActual: r.chainId.actual,
      chainIdVerified: r.chainId.verified,
      rpcUrl: args.rpcUrl
    },
    policy: args.decision
      ? {
          decisionId: args.decision.decisionId,
          decision: args.decision.decision,
          policyId: args.decision.policyId,
          policyVersion: args.decision.policyVersion,
          ruleResults: args.decision.ruleResults,
          reasons: args.decision.reasons
        }
      : undefined,
    request: {
      kind: "native_transfer",
      sender: args.sender,
      recipient: args.recipient,
      valueWei: r.valueWei,
      valuePhrs: r.valuePhrs
    },
    simulation: {
      ok: r.ok,
      stage: r.stage,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      ethCall: {
        method: r.ethCall.method,
        status: r.ethCall.status,
        returnData: r.ethCall.returnData,
        revert: r.ethCall.revert
      },
      gasEstimateWei: r.gasEstimateWei?.toString() ?? null,
      gasPriceWei: r.gasPriceWei?.toString() ?? null,
      estimatedFeeWei: r.estimatedFeeWei?.toString() ?? null,
      estimatedFeePhrs: r.estimatedFeePhrs,
      senderBalanceWei: r.senderBalanceWei?.toString() ?? null,
      predictedSenderBalanceAfterWei: r.predictedSenderBalanceAfterWei?.toString() ?? null,
      balancePredictionReliable: r.balancePredictionReliable
    },
    notes: r.notes,
    disclaimer: [
      "This file records a READ-ONLY simulation. No transaction was signed or broadcast.",
      "Simulation never proves that a transaction submitted later will succeed."
    ]
  };
}

export async function writeSimulationEvidence(evidence: SimulationEvidence, basePath: string): Promise<void> {
  await writeFileChecked(`${basePath}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFileChecked(`${basePath}.md`, renderSimulationMarkdown(evidence));
}

/* ----------------------------------- MD ----------------------------------- */

export function renderSimulationMarkdown(e: SimulationEvidence): string {
  const lines: (string | null)[] = [
    `# Testnet Simulation Evidence`,
    ``,
    `> **${e.label}**`,
    ``,
    `Generated: ${e.generatedAt}`,
    ``,
    `## Network`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Network | ${e.network.name} |`,
    `| Chain ID (expected) | ${e.network.chainIdExpected} |`,
    `| Chain ID (RPC) | ${e.network.chainIdActual ?? "unavailable"} |`,
    `| Chain ID verified | ${e.network.chainIdVerified} |`,
    `| RPC URL | ${e.network.rpcUrl} |`,
    ``,
    `## Request`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Sender | ${e.request.sender} |`,
    `| Recipient | ${e.request.recipient} |`,
    `| Value | ${e.request.valueWei} wei (${e.request.valuePhrs} PHRS) |`,
    ``
  ];

  if (e.policy) {
    lines.push(
      `## Policy decision`,
      ``,
      `| Field | Value |`,
      `|---|---|`,
      `| Decision | ${e.policy.decision} |`,
      `| Decision ID | ${e.policy.decisionId} |`,
      `| Policy | ${e.policy.policyId} v${e.policy.policyVersion} |`,
      ``,
      `Rule results:`,
      ``,
      ...e.policy.ruleResults.map((r) => {
        const rr = r as { ruleId: string; passed: boolean; reason: string };
        return `- **${rr.ruleId}**: ${rr.passed ? "PASS" : "FAIL"} — ${rr.reason}`;
      }),
      ``
    );
  }

  lines.push(
    `## Simulation result`,
    ``,
    `| Field | Value |`,
    `|---|---|`
  );
  const s = e.simulation;
  if (s.ok) {
    lines.push(
      `| eth_call status | ${s.ethCall.status} |`,
      `| eth_call return data | ${s.ethCall.returnData ?? "(empty)"} |`,
      s.ethCall.revert ? `| Revert | ${JSON.stringify(s.ethCall.revert)} |` : null,
      `| Gas estimate (eth_estimateGas) | ${s.gasEstimateWei} |`,
      `| Gas price | ${s.gasPriceWei} wei |`,
      `| Estimated fee | ${s.estimatedFeeWei} wei (${s.estimatedFeePhrs} PHRS) |`,
      `| Sender balance | ${s.senderBalanceWei} wei |`,
      `| Predicted balance after | ${s.predictedSenderBalanceAfterWei ?? "not reliable"} |`,
      `| Balance prediction reliable | ${s.balancePredictionReliable} |`
    );
  } else {
    lines.push(
      `| Result | FAIL-CLOSED (error) |`,
      `| Stage | ${s.stage ?? "unknown"} |`,
      `| Error code | ${s.errorCode ?? ""} |`,
      `| Error | ${s.errorMessage ?? ""} |`
    );
  }
  lines.push(``, `### Notes`, ``, ...e.notes.map((n) => `- ${n}`), ``, `### Disclaimers`, ``, ...e.disclaimer.map((d) => `- ${d}`), ``);
  return lines.filter((l): l is string => l !== null).join("\n");
}

/* ------------------------------- live transfer ---------------------------- */

export interface LiveTransactionEvidence {
  label: "LIVE TESTNET TRANSACTION — REAL BROADCAST";
  generatedAt: string;
  status: LiveTransferResult["status"];
  network: { name: string; chainId: number };
  timeline: Array<{ phase: string; state: string }>;
  policy: {
    decisionId: string;
    decision: string;
    policyId: string;
    policyVersion: string;
    ruleResults: unknown[];
    reasons: string[];
  } | null;
  revalidation: { decisionId: string; decision: string } | null;
  preBroadcastSimulation: { ethCallStatus: string; gasEstimateWei: string | null; label: string } | null;
  broadcast: { transactionHash: string; explorerUrl: string } | null;
  receipt: LiveTransferReceiptReport | null;
  stages: LiveTransferResult["stages"];
  notice?: string;
  secrets: "none — private keys and signed raw transaction bytes are never written to evidence";
}

export function buildLiveTransactionEvidence(result: LiveTransferResult, generatedAt: Date): LiveTransactionEvidence {
  return {
    label: "LIVE TESTNET TRANSACTION — REAL BROADCAST",
    generatedAt: generatedAt.toISOString(),
    status: result.status,
    network: { name: "Pharos Atlantic Testnet", chainId: 688689 },
    timeline: [
      { phase: "Policy approval", state: result.policyDecision ? `${result.policyDecision.decision} (${result.policyDecision.decisionId})` : "not reached" },
      { phase: "Pre-broadcast simulation", state: result.simulation ? `${result.simulation.ethCall.status} (read-only)` : result.status === "blocked" ? "not reached" : "unknown" },
      { phase: "Actual broadcast", state: result.transactionHash ? `broadcast: ${result.transactionHash}` : "NOT broadcast" },
      { phase: "Receipt confirmation", state: result.receipt ? `receipt status ${result.receipt.status} in block ${result.receipt.blockNumber}` : result.status === "pending" ? "PENDING — no receipt yet (unresolved)" : "no receipt" }
    ],
    policy: result.policyDecision
      ? {
          decisionId: result.policyDecision.decisionId,
          decision: result.policyDecision.decision,
          policyId: result.policyDecision.policyId,
          policyVersion: result.policyDecision.policyVersion,
          ruleResults: result.policyDecision.ruleResults,
          reasons: result.policyDecision.reasons
        }
      : null,
    revalidation: result.revalidationDecision
      ? { decisionId: result.revalidationDecision.decisionId, decision: result.revalidationDecision.decision }
      : null,
    preBroadcastSimulation: result.simulation
      ? {
          ethCallStatus: result.simulation.ethCall.status,
          gasEstimateWei: result.simulation.gasEstimateWei?.toString() ?? null,
          label: SIMULATION_LABEL
        }
      : null,
    broadcast: result.transactionHash
      ? { transactionHash: result.transactionHash, explorerUrl: `${ATLANTIC_EXPLORER_URL}/tx/${result.transactionHash}` }
      : null,
    receipt: result.receipt ?? null,
    stages: result.stages,
    notice: result.notice,
    secrets: "none — private keys and signed raw transaction bytes are never written to evidence"
  };
}

export async function writeLiveTransactionEvidence(result: LiveTransferResult, basePath: string, generatedAt: Date): Promise<void> {
  const evidence = buildLiveTransactionEvidence(result, generatedAt);
  await writeFileChecked(`${basePath}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFileChecked(`${basePath}.md`, renderLiveTransactionMarkdown(evidence));
}

export function renderLiveTransactionMarkdown(e: LiveTransactionEvidence): string {
  const lines: string[] = [
    `# Live Testnet Transaction Evidence`,
    ``,
    `> **${e.label}**`,
    ``,
    `Generated: ${e.generatedAt}`,
    `Status: **${e.status}**`,
    `Secrets in this file: ${e.secrets}`,
    ``,
    `## Timeline`,
    ``,
    `| Phase | State |`,
    `|---|---|`,
    ...e.timeline.map((t) => `| ${t.phase} | ${t.state} |`),
    ``
  ];

  if (e.policy) {
    lines.push(
      `## Policy decision associated with the transaction`,
      ``,
      `- Decision: **${e.policy.decision}** (ID ${e.policy.decisionId})`,
      `- Policy: ${e.policy.policyId} v${e.policy.policyVersion}`,
      ``,
      ...e.policy.ruleResults.map((r) => {
        const rr = r as { ruleId: string; passed: boolean; reason: string };
        return `- **${rr.ruleId}**: ${rr.passed ? "PASS" : "FAIL"} — ${rr.reason}`;
      }),
      ``
    );
  }
  if (e.revalidation) {
    lines.push(`- Pre-sign revalidation decision: **${e.revalidation.decision}** (ID ${e.revalidation.decisionId})`, ``);
  }
  if (e.preBroadcastSimulation) {
    lines.push(
      `## Pre-broadcast simulation (read-only)`,
      ``,
      `- Label: ${e.preBroadcastSimulation.label}`,
      `- eth_call status: ${e.preBroadcastSimulation.ethCallStatus}`,
      `- Gas estimate: ${e.preBroadcastSimulation.gasEstimateWei ?? "unavailable"}`,
      ``
    );
  }
  if (e.broadcast) {
    lines.push(`## Actual broadcast`, ``, `- Transaction hash: \`${e.broadcast.transactionHash}\``, `- Explorer: ${e.broadcast.explorerUrl}`, ``);
  } else {
    lines.push(`## Actual broadcast`, ``, `- NOT broadcast. No transaction hash exists.`, ``);
  }
  const r = e.receipt;
  if (r) {
    lines.push(
      `## Receipt (verified)`,
      ``,
      `| Field | Value |`,
      `|---|---|`,
      `| Transaction hash | \`${r.transactionHash}\` |`,
      `| Network | ${r.networkName} (chain ID ${r.chainId}) |`,
      `| Sender | ${r.from} |`,
      `| Recipient | ${r.to ?? "(null)"} |`,
      `| Value | ${r.valueWei} wei (${r.valuePhrs} PHRS) |`,
      `| Block number | ${r.blockNumber} |`,
      `| Receipt status | ${r.status} |`,
      `| Gas used | ${r.gasUsed} |`,
      `| Effective gas price | ${r.effectiveGasPriceWei ?? "unavailable"} wei |`,
      `| Actual fee (gasUsed × effectiveGasPrice) | ${r.actualFeeWei ?? "unavailable"} wei (${r.actualFeePhrs ?? "unavailable"} PHRS) |`,
      `| Confirmations (checked at evidence time) | ${r.confirmationsChecked ?? "not checked"} |`,
      `| Explorer URL (official, from Pharos docs) | ${r.explorerUrl} |`,
      ``,
      `### Field verification`,
      ``,
      `| Field | Expected | Actual | Match |`,
      `|---|---|---|---|`,
      ...r.fieldVerification.map((f) => `| ${f.field} | ${f.expected} | ${f.actual} | ${f.match ? "YES" : "NO"} |`),
      ``
    );
  } else {
    lines.push(
      `## Receipt`,
      ``,
      e.status === "pending"
        ? `No receipt yet. The transaction is **pending / unresolved — NOT confirmed**.`
        : `No receipt. The transaction was not broadcast.`,
      ``
    );
  }
  if (e.notice) {
    lines.push(`## Notice`, ``, e.notice, ``);
  }
  lines.push(
    `## Execution stages`,
    ``,
    `| Step | Name | Status | Detail |`,
    `|---|---|---|---|`,
    ...e.stages.map((s) => `| ${s.step} | ${s.name} | ${s.status} | ${s.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    ``
  );
  return lines.join("\n");
}

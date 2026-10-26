/**
 * Read-only Pharos Atlantic testnet simulation (Mode B).
 *
 * Performs REAL RPC requests (eth_call, eth_estimateGas, balance, gas price)
 * but NEVER signs or broadcasts a transaction. Results are clearly labeled
 * "SIMULATION — NO TRANSACTION BROADCAST" and never constitute a claim that
 * a later real transaction would succeed.
 *
 * Every simulation, RPC, network, or gas-estimation error produces a
 * fail-closed structured result.
 */
import { decodeAbiParameters, type AbiParameter } from "viem";
import type { TestnetRpc } from "./client.js";
import { ChainIdMismatchError } from "./client.js";
import { formatWeiToPhrs } from "../units.js";

export const SIMULATION_LABEL = "SIMULATION — NO TRANSACTION BROADCAST";

export interface SimulationInput {
  rpc: TestnetRpc;
  sender: `0x${string}`;
  recipient: `0x${string}`;
  valueWei: bigint;
  data?: `0x${string}`;
  expectedChainId: number;
}

export interface RevertReason {
  /** Decoded classification, or "unknown" when the reason could not be decoded. */
  kind: "Error(string)" | "Panic(uint256)" | "empty" | "unknown";
  /** Human-readable description; for "unknown" this is NOT invented. */
  description: string;
  /** Raw revert data, always preserved. */
  rawData: string;
}

export interface SimulationResult {
  simulated: true;
  broadcasted: false;
  signed: false;
  label: typeof SIMULATION_LABEL;
  ok: boolean;
  /** Stage that failed, when ok === false. */
  stage?: "chain-id-verification" | "eth_call" | "gas-estimation" | "balance" | "gas-price";
  errorCode?: string;
  errorMessage?: string;
  chainId: { expected: number; actual: number | null; verified: boolean };
  ethCall: {
    method: "eth_call";
    status: "success" | "reverted" | "not-run";
    returnData: string | null;
    revert: RevertReason | null;
  };
  gasEstimateWei: bigint | null;
  gasPriceWei: bigint | null;
  estimatedFeeWei: bigint | null;
  estimatedFeePhrs: string | null;
  senderBalanceWei: bigint | null;
  /** balance - value - fee; present only when the calculation is reliable. */
  predictedSenderBalanceAfterWei: bigint | null;
  balancePredictionReliable: boolean;
  /** Value expressed in PHRS for readability. */
  valueWei: string;
  valuePhrs: string;
  notes: string[];
}

const PANIC_REASONS: Record<string, string> = {
  "1": "assert() condition failed",
  "17": "arithmetic operation underflowed or overflowed",
  "18": "division or modulo by zero",
  "33": "attempted to convert to an invalid enum type",
  "34": "attempted to access a storage byte array that is incorrectly encoded",
  "49": "performed .pop() on an empty storage array",
  "50": "array index out of bounds",
  "65": "allocated too much memory or created an array that is too large",
  "81": "attempted to call a zero-initialized variable of internal function type"
};

const ERROR_STRING_SELECTOR = "0x08c379a0"; // keccak256("Error(string)")[:4]
const PANIC_SELECTOR = "0x4e487b71"; // keccak256("Panic(uint256)")[:4]

/** Decodes Solidity Error(string)/Panic(uint256) revert data; otherwise preserves raw data without inventing a reason. */
export function decodeRevertData(rawData: string): RevertReason {
  const data = (rawData ?? "0x").toLowerCase();
  if (data === "0x" || data === "") {
    return { kind: "empty", description: "Reverted without revert data (no reason string available).", rawData };
  }
  if (data.startsWith(ERROR_STRING_SELECTOR)) {
    try {
      const args = (`0x${data.slice(10)}`) as `0x${string}`;
      const [message] = decodeAbiParameters([{ type: "string" } as AbiParameter], args) as [string];
      return { kind: "Error(string)", description: `Contract reverted: "${message}"`, rawData };
    } catch {
      return { kind: "unknown", description: `Revert data could not be decoded as Error(string); raw data preserved.`, rawData };
    }
  }
  if (data.startsWith(PANIC_SELECTOR)) {
    try {
      const args = (`0x${data.slice(10)}`) as `0x${string}`;
      const [code] = decodeAbiParameters([{ type: "uint256" } as AbiParameter], args) as [bigint];
      const known = PANIC_REASONS[code.toString()];
      return {
        kind: "Panic(uint256)",
        description: known
          ? `Panic (assert/overflow family), code ${code.toString()}: ${known}.`
          : `Panic with unrecognized code ${code.toString()} (raw data preserved).`,
        rawData
      };
    } catch {
      return { kind: "unknown", description: `Revert data could not be decoded as Panic(uint256); raw data preserved.`, rawData };
    }
  }
  return {
    kind: "unknown",
    description: `Revert reason is not Error(string)/Panic(uint256) — no reason invented; raw revert data preserved.`,
    rawData
  };
}

/** Walks an error object chain looking for JSON-RPC revert `data` (0x-prefixed hex). */
export function extractRevertData(err: unknown, depth = 0): string | null {
  if (depth > 6 || typeof err !== "object" || err === null) return null;
  const candidate = err as { data?: unknown; cause?: unknown; details?: unknown };
  if (typeof candidate.data === "string" && candidate.data.startsWith("0x")) {
    return candidate.data;
  }
  if (typeof candidate.details === "string") {
    const m = /(0x[0-9a-fA-F]+)/.exec(candidate.details);
    if (m?.[1]) return m[1];
  }
  return extractRevertData(candidate.cause, depth + 1);
}

function fail(
  input: SimulationInput,
  stage: SimulationResult["stage"] & string,
  errorCode: string,
  errorMessage: string,
  partial?: Partial<SimulationResult>
): SimulationResult {
  return {
    simulated: true,
    broadcasted: false,
    signed: false,
    label: SIMULATION_LABEL,
    ok: false,
    stage: stage as SimulationResult["stage"],
    errorCode,
    errorMessage,
    chainId: { expected: input.expectedChainId, actual: null, verified: false },
    ethCall: { method: "eth_call", status: "not-run", returnData: null, revert: null },
    gasEstimateWei: null,
    gasPriceWei: null,
    estimatedFeeWei: null,
    estimatedFeePhrs: null,
    senderBalanceWei: null,
    predictedSenderBalanceAfterWei: null,
    balancePredictionReliable: false,
    valueWei: input.valueWei.toString(),
    valuePhrs: formatWeiToPhrs(input.valueWei),
    notes: [],
    ...partial
  };
}

const STATE_CHANGE_CAVEAT =
  "Simulation executes read-only (eth_call) and does not persist state. Contract state changes that a real broadcast would cause cannot be predicted from simulation.";

/**
 * Runs the read-only simulation. Never signs, never broadcasts.
 * Returns a fail-closed result on chain-ID mismatch or any RPC/gas error.
 */
export async function simulateTransfer(input: SimulationInput): Promise<SimulationResult> {
  const notes: string[] = [];
  let actualChainId: number | null = null;

  try {
    actualChainId = await input.rpc.getChainId();
  } catch (err) {
    return fail(input, "chain-id-verification", "RPC_ERROR", `Could not query chain ID: ${(err as Error).message}`);
  }
  if (actualChainId !== input.expectedChainId) {
    return fail(
      input,
      "chain-id-verification",
      "CHAIN_ID_MISMATCH",
      new ChainIdMismatchError(input.expectedChainId, actualChainId).message,
      { chainId: { expected: input.expectedChainId, actual: actualChainId, verified: false } }
    );
  }

  let gasEstimate: bigint | null = null;
  try {
    gasEstimate = await input.rpc.estimateGas({
      from: input.sender,
      to: input.recipient,
      value: input.valueWei,
      ...(input.data !== undefined ? { data: input.data } : {})
    });
  } catch (err) {
    const revertData = extractRevertData(err);
    return fail(input, "gas-estimation", "GAS_ESTIMATION_FAILED", `eth_estimateGas failed: ${(err as Error).message}`, {
      chainId: { expected: input.expectedChainId, actual: actualChainId, verified: true },
      ethCall: {
        method: "eth_call",
        status: "not-run",
        returnData: null,
        revert: revertData ? decodeRevertData(revertData) : null
      }
    });
  }

  let callResult: { data: `0x${string}` } | null = null;
  let revert: RevertReason | null = null;
  try {
    callResult = await input.rpc.call({
      from: input.sender,
      to: input.recipient,
      value: input.valueWei,
      ...(input.data !== undefined ? { data: input.data } : {})
    });
  } catch (err) {
    const revertData = extractRevertData(err);
    revert = revertData ? decodeRevertData(revertData) : { kind: "unknown", description: `eth_call failed without revert data: ${(err as Error).message}`, rawData: "0x" };
    callResult = null;
  }

  let balance: bigint | null = null;
  try {
    balance = await input.rpc.getBalance(input.sender);
  } catch (err) {
    return fail(input, "balance", "RPC_ERROR", `Could not query sender balance: ${(err as Error).message}`, {
      chainId: { expected: input.expectedChainId, actual: actualChainId, verified: true },
      gasEstimateWei: gasEstimate,
      ethCall: callResult
        ? { method: "eth_call", status: "success", returnData: callResult.data, revert: null }
        : { method: "eth_call", status: "reverted", returnData: null, revert }
    });
  }

  let gasPrice: bigint | null = null;
  try {
    gasPrice = await input.rpc.getGasPrice();
  } catch (err) {
    return fail(input, "gas-price", "RPC_ERROR", `Could not query gas price: ${(err as Error).message}`, {
      chainId: { expected: input.expectedChainId, actual: actualChainId, verified: true },
      gasEstimateWei: gasEstimate,
      senderBalanceWei: balance,
      ethCall: callResult
        ? { method: "eth_call", status: "success", returnData: callResult.data, revert: null }
        : { method: "eth_call", status: "reverted", returnData: null, revert }
    });
  }

  const fee = gasEstimate !== null && gasPrice !== null ? gasEstimate * gasPrice : null;

  let predictedAfter: bigint | null = null;
  let balancePredictionReliable = false;
  if (balance !== null && fee !== null && callResult !== null) {
    const totalNeeded = input.valueWei + fee;
    if (balance >= totalNeeded) {
      predictedAfter = balance - totalNeeded;
      balancePredictionReliable = true;
    } else {
      notes.push(
        `Sender balance (${balance.toString()} wei) is insufficient for value + estimated fee (${totalNeeded.toString()} wei); a real transfer would likely fail. Balance-after prediction omitted.`
      );
    }
  }
  if (callResult === null) {
    balancePredictionReliable = false;
    notes.push("eth_call reverted: no successful execution to base a balance prediction on.");
  }
  notes.push(STATE_CHANGE_CAVEAT);
  notes.push("A successful simulation does not prove that a transaction submitted later will succeed.");

  return {
    simulated: true,
    broadcasted: false,
    signed: false,
    label: SIMULATION_LABEL,
    ok: true,
    chainId: { expected: input.expectedChainId, actual: actualChainId, verified: true },
    ethCall: callResult
      ? { method: "eth_call", status: "success", returnData: callResult.data, revert: null }
      : { method: "eth_call", status: "reverted", returnData: null, revert },
    gasEstimateWei: gasEstimate,
    gasPriceWei: gasPrice,
    estimatedFeeWei: fee,
    estimatedFeePhrs: fee !== null ? formatWeiToPhrs(fee) : null,
    senderBalanceWei: balance,
    predictedSenderBalanceAfterWei: predictedAfter,
    balancePredictionReliable,
    valueWei: input.valueWei.toString(),
    valuePhrs: formatWeiToPhrs(input.valueWei),
    notes
  };
}

/**
 * Testnet simulation tests (mocked RPC): verify chain-ID enforcement,
 * eth_call/eth_estimateGas handling, revert decoding, BigInt fee math,
 * balance-prediction reliability, and that simulation NEVER broadcasts.
 */
import { describe, expect, it } from "vitest";
import { decodeRevertData, extractRevertData, simulateTransfer } from "../src/index.js";
import { MockRpc, ONE_PHRS, RECIPIENT, SENDER } from "./helpers.js";

const baseInput = (rpc: MockRpc, overrides: Record<string, unknown> = {}) => ({
  rpc,
  sender: SENDER as `0x${string}`,
  recipient: RECIPIENT as `0x${string}`,
  valueWei: 1_000_000_000_000_000n, // 0.001 PHRS
  expectedChainId: 688689,
  ...overrides
});

describe("successful simulation", () => {
  it("verifies the chain ID and reports gas, fee, and balance predictions with BigInt math", async () => {
    const rpc = new MockRpc(); // gas 21000 @ 1 gwei = 21000000000000 wei fee
    const result = await simulateTransfer(baseInput(rpc));
    expect(result.ok).toBe(true);
    expect(result.simulated).toBe(true);
    expect(result.broadcasted).toBe(false);
    expect(result.signed).toBe(false);
    expect(result.label).toBe("SIMULATION — NO TRANSACTION BROADCAST");
    expect(result.chainId).toEqual({ expected: 688689, actual: 688689, verified: true });
    expect(result.ethCall.status).toBe("success");
    expect(result.gasEstimateWei).toBe(21000n);
    expect(result.gasPriceWei).toBe(1_000_000_000n);
    expect(result.estimatedFeeWei).toBe(21_000n * 1_000_000_000n);
    expect(result.senderBalanceWei).toBe(ONE_PHRS);
    expect(result.predictedSenderBalanceAfterWei).toBe(ONE_PHRS - 1_000_000_000_000_000n - 21_000n * 1_000_000_000n);
    expect(result.balancePredictionReliable).toBe(true);
    expect(rpc.sendRawCount).toBe(0); // never submits anything
    expect(rpc.ethCallCount).toBe(1);
    expect(rpc.estimateGasCount).toBe(1);
  });

  it("reports predicted success without ever claiming a later broadcast will succeed", async () => {
    const result = await simulateTransfer(baseInput(new MockRpc()));
    expect(result.ethCall.status).toBe("success");
    expect(result.notes.join(" ")).toContain("does not prove");
    expect(result.notes.join(" ")).toContain("does not persist state");
  });
});

/** ABI-encodes an Error(string) revert: selector + offset(0x20) + length + data padded to 32 bytes. */
function encodeErrorString(message: string): string {
  const dataHex = Buffer.from(message, "utf8").toString("hex").padEnd(Math.ceil((message.length * 2) / 64) * 64 || 64, "0");
  return `0x08c379a0${"0".repeat(62)}20${message.length.toString(16).padStart(64, "0")}${dataHex}`;
}

describe("revert decoding", () => {
  it("decodes Error(string) revert data", () => {
    const decoded = decodeRevertData(encodeErrorString("insufficient funds"));
    expect(decoded.kind).toBe("Error(string)");
    expect(decoded.description).toContain("insufficient funds");
    expect(decoded.rawData).toBe(encodeErrorString("insufficient funds"));
  });

  it("decodes Panic(uint256) revert data with the known code table", () => {
    const encoded = `0x4e487b71${"0".repeat(62)}11`; // code 0x11 = 17 (arithmetic overflow)
    const decoded = decodeRevertData(encoded);
    expect(decoded.kind).toBe("Panic(uint256)");
    expect(decoded.description).toContain("17");
    expect(decoded.description).toContain("underflowed or overflowed");
  });

  it("preserves raw data for unknown selectors without inventing a reason", () => {
    const raw = "0xdeadbeef" + "ff".repeat(32);
    const decoded = decodeRevertData(raw);
    expect(decoded.kind).toBe("unknown");
    expect(decoded.description).toContain("no reason invented");
    expect(decoded.rawData).toBe(raw);
  });

  it("handles empty revert data", () => {
    const decoded = decodeRevertData("0x");
    expect(decoded.kind).toBe("empty");
    expect(decoded.rawData).toBe("0x");
  });

  it("extracts revert data from nested viem-style error objects", () => {
    const err = new Error("execution reverted") as Error & { cause?: unknown };
    (err as { data?: string }).data = "0x08c379a0";
    expect(extractRevertData(err)).toBe("0x08c379a0");
    const nested = new Error("outer") as Error & { cause?: unknown };
    (nested as { cause?: unknown }).cause = { cause: { data: "0x4e487b71" } };
    expect(extractRevertData(nested)).toBe("0x4e487b71");
    expect(extractRevertData(new Error("no data"))).toBeNull();
  });

  it("fail-closes with the decoded revert when eth_call reverts", async () => {
    const rpc = new MockRpc();
    rpc.callBehavior = "revert";
    rpc.revertData = encodeErrorString("blocked by contract");
    const result = await simulateTransfer(baseInput(rpc));
    expect(result.ok).toBe(true); // simulation completed — with a predicted revert
    expect(result.ethCall.status).toBe("reverted");
    expect(result.ethCall.revert?.kind).toBe("Error(string)");
    expect(result.ethCall.revert?.description).toContain("blocked by contract");
    expect(result.balancePredictionReliable).toBe(false);
    expect(result.predictedSenderBalanceAfterWei).toBeNull();
    expect(rpc.sendRawCount).toBe(0);
  });
});

describe("fail-closed behavior", () => {
  it("blocks on chain ID mismatch before any other call", async () => {
    const rpc = new MockRpc();
    rpc.chainIdValue = 1; // wrong network
    const result = await simulateTransfer(baseInput(rpc));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("CHAIN_ID_MISMATCH");
    expect(result.stage).toBe("chain-id-verification");
    expect(result.chainId.verified).toBe(false);
    expect(result.ethCall.status).toBe("not-run");
    expect(rpc.ethCallCount).toBe(0);
    expect(rpc.estimateGasCount).toBe(0);
    expect(rpc.sendRawCount).toBe(0);
  });

  it("fail-closes when the RPC chain ID query itself fails", async () => {
    const rpc = new MockRpc();
    rpc.failMethods.add("getChainId");
    const result = await simulateTransfer(baseInput(rpc));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("RPC_ERROR");
    expect(result.stage).toBe("chain-id-verification");
  });

  it("fail-closes on gas estimation failure", async () => {
    const rpc = new MockRpc();
    rpc.failMethods.add("estimateGas");
    const result = await simulateTransfer(baseInput(rpc));
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("gas-estimation");
    expect(result.errorCode).toBe("GAS_ESTIMATION_FAILED");
    expect(rpc.ethCallCount).toBe(0);
  });

  it("fail-closes on eth_call network errors while preserving the gas estimate", async () => {
    const rpc = new MockRpc();
    rpc.callBehavior = "throw";
    const result = await simulateTransfer(baseInput(rpc));
    expect(result.ok).toBe(true);
    expect(result.ethCall.status).toBe("reverted");
    expect(result.ethCall.revert?.kind).toBe("unknown");
    expect(result.ethCall.revert?.description).toContain("mock eth_call network error");
    expect(result.gasEstimateWei).toBe(21000n);
    expect(result.balancePredictionReliable).toBe(false);
  });

  it("fail-closes on balance query failure", async () => {
    const rpc = new MockRpc();
    rpc.failMethods.add("getBalance");
    const result = await simulateTransfer(baseInput(rpc));
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("balance");
    expect(result.senderBalanceWei).toBeNull();
  });

  it("fail-closes on gas-price query failure", async () => {
    const rpc = new MockRpc();
    rpc.failMethods.add("getGasPrice");
    const result = await simulateTransfer(baseInput(rpc));
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("gas-price");
  });

  it("flags insufficient balance instead of producing an unreliable prediction", async () => {
    const rpc = new MockRpc();
    rpc.balances.set(SENDER.toLowerCase(), 1n); // 1 wei balance
    const result = await simulateTransfer(baseInput(rpc));
    expect(result.ok).toBe(true);
    expect(result.balancePredictionReliable).toBe(false);
    expect(result.predictedSenderBalanceAfterWei).toBeNull();
    expect(result.notes.join(" ")).toContain("insufficient");
  });
});

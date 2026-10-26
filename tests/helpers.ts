/**
 * Shared test helpers: a fully in-memory TestnetRpc mock and policy/request
 * factories. No test ever touches the real network.
 */
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { parseTransaction, recoverTransactionAddress } from "viem";
import type { TestnetRpc, RpcReceipt } from "../src/testnet/client.js";
import type { Policy } from "../src/types.js";

export const SENDER = "0x1111111111111111111111111111111111111111" as const;
export const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
export const UNKNOWN_ADDRESS = "0x9999999999999999999999999999999999999999" as const;

export const ONE_PHRS = 1_000_000_000_000_000_000n;

export function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    policyId: "test-policy",
    version: "1.0.0",
    spendLimit: { maxAmountWei: "100000000000000000" }, // 0.1 PHRS
    allowlist: { recipients: [RECIPIENT], contracts: ["0x3333333333333333333333333333333333333333"] },
    timeWindow: {
      timezone: "UTC",
      windows: [{ start: "00:00", end: "23:59" }],
      boundary: { startInclusive: true, endInclusive: true }
    },
    ...overrides
  };
}

type CallBehavior = "success" | "revert" | "throw";

export class MockRpc implements TestnetRpc {
  chainIdValue = 688689;
  callBehavior: CallBehavior = "success";
  revertData = "0x";
  gasEstimateValue = 21_000n;
  gasPriceValue = 1_000_000_000n;
  /** Testnet-style faucet default: any address without an explicit balance is funded. */
  defaultBalance = ONE_PHRS;
  balances = new Map<string, bigint>();
  nonceLatest = 0;
  noncePending = 0;
  /** Method names that should throw to simulate RPC/network failures. */
  failMethods = new Set<string>();
  /** Receipts: null = no receipt observable yet (pending/timeout). */
  receiptStatus: "success" | "reverted" | null = "success";
  waitForReceiptError: Error | null = null;
  blockNumber = 1002n;
  signedTransactions: string[] = [];
  ethCallCount = 0;
  estimateGasCount = 0;
  sendRawCount = 0;
  waitForReceiptCount = 0;
  getTransactionReceiptCount = 0;
  transactions = new Map<string, { from: string; to: string; value: bigint; nonce: number }>();

  private fail(method: string): void {
    if (this.failMethods.has(method)) throw new Error(`mock RPC failure in ${method}`);
  }

  async getChainId(): Promise<number> {
    this.fail("getChainId");
    return this.chainIdValue;
  }

  async call(_args: { from: `0x${string}`; to: `0x${string}`; value?: bigint; data?: `0x${string}` }): Promise<{ data: `0x${string}` }> {
    this.fail("call");
    this.ethCallCount += 1;
    if (this.callBehavior === "revert") {
      const err = new Error("execution reverted") as Error & { data?: string };
      err.data = this.revertData;
      throw err;
    }
    if (this.callBehavior === "throw") throw new Error("mock eth_call network error");
    return { data: "0x" };
  }

  async estimateGas(_args: { from: `0x${string}`; to: `0x${string}`; value?: bigint; data?: `0x${string}` }): Promise<bigint> {
    this.fail("estimateGas");
    this.estimateGasCount += 1;
    return this.gasEstimateValue;
  }

  async getBalance(address: string): Promise<bigint> {
    this.fail("getBalance");
    return this.balances.get(address.toLowerCase()) ?? this.defaultBalance;
  }

  async getGasPrice(): Promise<bigint> {
    this.fail("getGasPrice");
    return this.gasPriceValue;
  }

  async getTransactionCount(_address: string, blockTag: "latest" | "pending"): Promise<number> {
    this.fail("getTransactionCount");
    return blockTag === "latest" ? this.nonceLatest : this.noncePending;
  }

  async getBlockNumber(): Promise<bigint> {
    this.fail("getBlockNumber");
    return this.blockNumber;
  }

  async sendRawTransaction(signedTx: `0x${string}`): Promise<`0x${string}`> {
    this.fail("sendRawTransaction");
    this.sendRawCount += 1;
    this.signedTransactions.push(signedTx);
    const hash = `0xdeadbeef${String(this.sendRawCount).padStart(48, "0")}` as `0x${string}`;
    // Locally parse the signed transaction (pure, no network), recover the
    // signer, and register it as the chain would see it.
    const parsed = parseTransaction(signedTx);
    let from: `0x${string}` = SENDER;
    try {
      const serialized = signedTx as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"];
      from = (await recoverTransactionAddress({ serializedTransaction: serialized })) as `0x${string}`;
    } catch {
      from = SENDER;
    }
    this.transactions.set(hash, {
      from,
      to: parsed.to ?? RECIPIENT,
      value: parsed.value ?? 0n,
      nonce: parsed.nonce ?? 0
    });
    return hash;
  }

  registerTransaction(hash: string, tx: { from: string; to: string; value: bigint; nonce: number }): void {
    this.transactions.set(hash, tx);
  }

  async getTransaction(hash: `0x${string}`): Promise<{ hash: string; from: string; to: string; value: bigint; nonce: number; blockNumber: bigint; gas: bigint; gasPrice: bigint; input: string } | null> {
    this.fail("getTransaction");
    const tx = this.transactions.get(hash);
    return tx ? { hash, ...tx, blockNumber: 1001n, gas: 21000n, gasPrice: this.gasPriceValue, input: "0x" } : null;
  }

  private buildReceipt(hash: `0x${string}`): RpcReceipt {
    const tx = this.transactions.get(hash);
    return {
      transactionHash: hash,
      status: this.receiptStatus === "reverted" ? "reverted" : "success",
      blockNumber: 1001n,
      gasUsed: 21_000n,
      effectiveGasPrice: this.gasPriceValue,
      from: tx?.from ?? SENDER,
      to: tx?.to ?? RECIPIENT,
      contractAddress: null,
      logsCount: 0
    };
  }

  async getTransactionReceipt(hash: `0x${string}`): Promise<RpcReceipt | null> {
    this.fail("getTransactionReceipt");
    this.getTransactionReceiptCount += 1;
    if (this.receiptStatus === null) return null;
    return this.buildReceipt(hash);
  }

  async waitForTransactionReceipt(hash: `0x${string}`): Promise<RpcReceipt> {
    this.fail("waitForTransactionReceipt");
    this.waitForReceiptCount += 1;
    if (this.waitForReceiptError !== null) throw this.waitForReceiptError;
    if (this.receiptStatus === null) throw new Error("mock: no receipt available (timeout)");
    return this.buildReceipt(hash);
  }
}

/** A real (locally generated) viem account for signing tests — never funded, never broadcast. */
export function makeLocalAccount() {
  const account = privateKeyToAccount(generatePrivateKey());
  return account;
}

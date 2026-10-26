/**
 * Pharos Atlantic testnet RPC access.
 *
 * Network parameters verified against the official documentation:
 *   - Chain ID:  688689
 *   - RPC:       https://atlantic.dplabs-internal.com
 *   - Explorer:  https://atlantic.pharosscan.xyz/
 *   (https://docs.pharos.xyz/getting-started/network/atlantic-testnet.md)
 *
 * The RPC surface exposed to the rest of the application deliberately has NO
 * wallet-managed send equivalent. The only submission method is
 * sendRawTransaction (eth_sendRawTransaction), which takes locally signed
 * transaction bytes.
 */
import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";

export const ATLANTIC_RPC_URL = "https://atlantic.dplabs-internal.com";
export const ATLANTIC_CHAIN_ID = 688689;
/** Explorer URL from the official Atlantic testnet documentation page. */
export const ATLANTIC_EXPLORER_URL = "https://atlantic.pharosscan.xyz";

export const pharosAtlanticChain: Chain = defineChain({
  id: ATLANTIC_CHAIN_ID,
  name: "Pharos Atlantic Testnet",
  nativeCurrency: { name: "Pharos", symbol: "PHRS", decimals: 18 },
  rpcUrls: { default: { http: [ATLANTIC_RPC_URL] } },
  blockExplorers: { default: { name: "Pharos Scan", url: ATLANTIC_EXPLORER_URL } }
});

export interface RpcCallArgs {
  from: `0x${string}`;
  to: `0x${string}`;
  value?: bigint;
  data?: `0x${string}`;
}

export interface RpcGasArgs {
  from: `0x${string}`;
  to: `0x${string}`;
  value?: bigint;
  data?: `0x${string}`;
}

export interface RpcTransaction {
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
  nonce: number;
  blockNumber: bigint | null;
  gas: bigint;
  gasPrice: bigint | null;
  input: string;
}

export interface RpcReceipt {
  transactionHash: string;
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint | null;
  from: string;
  to: string | null;
  contractAddress: string | null;
  logsCount: number;
}

/**
 * Minimal RPC surface used by the simulation and live-transfer modules.
 * Dependency injection makes both fully mockable in automated tests.
 */
export interface TestnetRpc {
  getChainId(): Promise<number>;
  /** eth_call — read-only state machine execution; never persists anything. */
  call(args: RpcCallArgs): Promise<{ data: `0x${string}` }>;
  /** eth_estimateGas — read-only. */
  estimateGas(args: RpcGasArgs): Promise<bigint>;
  getBalance(address: string): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  getTransactionCount(address: string, blockTag: "latest" | "pending"): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  /** The ONLY submission method: eth_sendRawTransaction with locally signed bytes. */
  sendRawTransaction(signedTx: `0x${string}`): Promise<`0x${string}`>;
  getTransaction(hash: `0x${string}`): Promise<RpcTransaction | null>;
  getTransactionReceipt(hash: `0x${string}`): Promise<RpcReceipt | null>;
  waitForTransactionReceipt(
    hash: `0x${string}`,
    options?: { timeoutMs?: number; pollingIntervalMs?: number }
  ): Promise<RpcReceipt>;
}

export class RpcUnavailableError extends Error {
  override readonly name = "RpcUnavailableError";
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

export class ChainIdMismatchError extends Error {
  override readonly name = "ChainIdMismatchError";
  constructor(readonly expected: number, readonly actual: number) {
    super(`Chain ID mismatch: RPC reports ${actual}, expected ${expected}. Refusing to continue (fail-closed).`);
  }
}

export function createTestnetRpc(rpcUrl: string = ATLANTIC_RPC_URL): TestnetRpc {
  const client: PublicClient = createPublicClient({
    chain: pharosAtlanticChain,
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 0 })
  });

  return {
    async getChainId() {
      return client.getChainId();
    },
    async call(args) {
      const tx: Record<string, unknown> = { from: args.from, to: args.to };
      if (args.value !== undefined) tx["value"] = `0x${args.value.toString(16)}`;
      if (args.data !== undefined && args.data !== "0x") tx["data"] = args.data;
      const result = (await client.request({
        method: "eth_call",
        params: [tx as never, "latest"]
      })) as `0x${string}`;
      return { data: result ?? "0x" };
    },
    async estimateGas(args) {
      return client.estimateGas({
        account: args.from,
        to: args.to,
        ...(args.value !== undefined ? { value: args.value } : {}),
        ...(args.data !== undefined ? { data: args.data } : {})
      });
    },
    async getBalance(address) {
      return client.getBalance({ address: address as `0x${string}` });
    },
    async getGasPrice() {
      return client.getGasPrice();
    },
    async getTransactionCount(address, blockTag) {
      return client.getTransactionCount({ address: address as `0x${string}`, blockTag });
    },
    async getBlockNumber() {
      return client.getBlockNumber();
    },
    async sendRawTransaction(signedTx) {
      return client.sendRawTransaction({ serializedTransaction: signedTx });
    },
    async getTransaction(hash) {
      try {
        const tx = await client.getTransaction({ hash });
        return {
          hash: tx.hash,
          from: tx.from,
          to: tx.to ?? null,
          value: tx.value,
          nonce: tx.nonce,
          blockNumber: tx.blockNumber ?? null,
          gas: tx.gas,
          gasPrice: tx.gasPrice ?? null,
          input: tx.input
        };
      } catch {
        return null; // Not found (yet) — callers treat this as "unknown".
      }
    },
    async getTransactionReceipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return toReceipt(r);
      } catch {
        return null;
      }
    },
    async waitForTransactionReceipt(hash, options) {
      const r = await client.waitForTransactionReceipt({
        hash,
        timeout: options?.timeoutMs ?? 120_000,
        pollingInterval: options?.pollingIntervalMs ?? 2_000
      });
      return toReceipt(r);
    }
  };
}

function toReceipt(r: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>): RpcReceipt {
  return {
    transactionHash: r.transactionHash,
    status: r.status === "success" ? "success" : "reverted",
    blockNumber: r.blockNumber,
    gasUsed: r.gasUsed,
    effectiveGasPrice: r.effectiveGasPrice ?? null,
    from: r.from,
    to: r.to ?? null,
    contractAddress: r.contractAddress ?? null,
    logsCount: r.logs.length
  };
}

/**
 * Environment configuration for the live Pharos Atlantic testnet path.
 *
 * Fail-closed: any missing or malformed required value stops the command
 * with a clear explanation instead of guessing.
 *
 * Secrets policy: the private key is read locally, never printed, never
 * logged, never written to evidence, and never committed.
 */
import { getAddress } from "viem";
import { readFileSync } from "node:fs";
import { ATLANTIC_CHAIN_ID, ATLANTIC_RPC_URL } from "./testnet/client.js";
import { parsePhrsToWei } from "./units.js";

export interface LiveTransferEnv {
  privateKey: `0x${string}`;
  recipient: string;
  amountPhrs: string;
  rpcUrl: string;
  chainId: number;
  policyPath: string;
  auditPath: string;
}

export type EnvLoadResult =
  | { ok: true; config: LiveTransferEnv }
  | { ok: false; errors: string[] };

/** Minimal .env loader. Existing process environment variables always win. */
export function loadDotEnv(path = ".env"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // No .env file — rely on process env.
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Validates live-transfer environment. Returns every problem found (fail closed). */
export function loadLiveTransferEnv(env: NodeJS.ProcessEnv = process.env): EnvLoadResult {
  const errors: string[] = [];

  const rawKey = env["PHAROS_TESTNET_PRIVATE_KEY"];
  if (rawKey === undefined || rawKey.trim().length === 0) {
    errors.push(
      "PHAROS_TESTNET_PRIVATE_KEY is not set. Add it to your local .env (see .env.example) or export it in your shell: set PHAROS_TESTNET_PRIVATE_KEY=0x<64 hex characters>. The key stays on this machine and is never printed or logged."
    );
  } else if (!PRIVATE_KEY_PATTERN.test(rawKey.trim())) {
    errors.push("PHAROS_TESTNET_PRIVATE_KEY is malformed: expected 0x followed by exactly 64 hex characters.");
  }

  const rawRecipient = env["PHAROS_TESTNET_RECIPIENT"];
  let recipient = "";
  if (rawRecipient === undefined || rawRecipient.trim().length === 0) {
    errors.push("PHAROS_TESTNET_RECIPIENT is not set. Set it to the 0x address that should receive the transfer.");
  } else {
    try {
      recipient = getAddress(rawRecipient.trim());
    } catch {
      errors.push(`PHAROS_TESTNET_RECIPIENT "${rawRecipient}" is not a valid EVM address (0x + 40 hex characters).`);
    }
  }

  const rawAmount = env["PHAROS_TESTNET_AMOUNT"];
  const amountPhrs = rawAmount === undefined || rawAmount.trim().length === 0 ? "0.001" : rawAmount.trim();
  try {
    parsePhrsToWei(amountPhrs);
  } catch (err) {
    errors.push(`PHAROS_TESTNET_AMOUNT is invalid: ${(err as Error).message}`);
  }

  const rawRpc = env["PHAROS_TESTNET_RPC_URL"];
  let rpcUrl = ATLANTIC_RPC_URL;
  if (rawRpc !== undefined && rawRpc.trim().length > 0) {
    const trimmed = rawRpc.trim();
    if (!/^https?:\/\//.test(trimmed)) {
      errors.push(`PHAROS_TESTNET_RPC_URL "${trimmed}" must be an http(s) URL.`);
    } else {
      rpcUrl = trimmed;
    }
  }

  const rawChainId = env["PHAROS_TESTNET_CHAIN_ID"];
  if (rawChainId === undefined || rawChainId.trim().length === 0) {
    errors.push(
      `PHAROS_TESTNET_CHAIN_ID is not set. It must be exactly ${ATLANTIC_CHAIN_ID} (Pharos Atlantic testnet).`
    );
  } else if (rawChainId.trim() !== String(ATLANTIC_CHAIN_ID)) {
    errors.push(
      `PHAROS_TESTNET_CHAIN_ID is "${rawChainId.trim()}" but this command only operates on Pharos Atlantic testnet (chain ID ${ATLANTIC_CHAIN_ID}). Refusing to continue.`
    );
  }

  const policyPath = env["POLICY_PATH"]?.trim() || "examples/policy.example.json";
  const auditPath = env["AUDIT_PATH"]?.trim() || "audit/audit.jsonl";

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    config: {
      privateKey: rawKey!.trim() as `0x${string}`,
      recipient,
      amountPhrs,
      rpcUrl,
      chainId: ATLANTIC_CHAIN_ID,
      policyPath,
      auditPath
    }
  };
}

/** Environment for the read-only simulation mode: sender from key OR plain address. */
export function loadSimulationEnv(env: NodeJS.ProcessEnv = process.env):
  | { ok: true; config: { sender: string; recipient: string; amountPhrs: string; rpcUrl: string; chainId: number; policyPath: string; auditPath: string } }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let sender = "";

  const rawSender = env["PHAROS_TESTNET_SENDER"];
  const rawKey = env["PHAROS_TESTNET_PRIVATE_KEY"];
  if (rawSender !== undefined && rawSender.trim().length > 0) {
    try {
      sender = getAddress(rawSender.trim());
    } catch {
      errors.push(`PHAROS_TESTNET_SENDER "${rawSender}" is not a valid EVM address (0x + 40 hex characters).`);
    }
  } else if (rawKey !== undefined && rawKey.trim().length > 0 && PRIVATE_KEY_PATTERN.test(rawKey.trim())) {
    // Deriving the address from the local key does not expose the key.
    // Import is dynamic so this module never requires viem/accounts at static load.
    sender = "DERIVE_FROM_KEY";
  } else {
    errors.push(
      "No sender configured for simulation. Set PHAROS_TESTNET_SENDER (a plain 0x address, no secret) or PHAROS_TESTNET_PRIVATE_KEY (used only to derive the sender address locally)."
    );
  }

  const rawRecipient = env["PHAROS_TESTNET_RECIPIENT"];
  let recipient = "";
  if (rawRecipient === undefined || rawRecipient.trim().length === 0) {
    errors.push("PHAROS_TESTNET_RECIPIENT is not set. Set it to the 0x address to simulate the transfer to.");
  } else {
    try {
      recipient = getAddress(rawRecipient.trim());
    } catch {
      errors.push(`PHAROS_TESTNET_RECIPIENT "${rawRecipient}" is not a valid EVM address.`);
    }
  }

  const rawAmount = env["PHAROS_TESTNET_AMOUNT"];
  const amountPhrs = rawAmount === undefined || rawAmount.trim().length === 0 ? "0.001" : rawAmount.trim();
  try {
    parsePhrsToWei(amountPhrs);
  } catch (err) {
    errors.push(`PHAROS_TESTNET_AMOUNT is invalid: ${(err as Error).message}`);
  }

  const rawRpc = env["PHAROS_TESTNET_RPC_URL"];
  let rpcUrl = ATLANTIC_RPC_URL;
  if (rawRpc !== undefined && rawRpc.trim().length > 0 && /^https?:\/\//.test(rawRpc.trim())) {
    rpcUrl = rawRpc.trim();
  }

  const policyPath = env["POLICY_PATH"]?.trim() || "examples/policy.example.json";
  const auditPath = env["AUDIT_PATH"]?.trim() || "audit/audit.jsonl";

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: { sender, recipient, amountPhrs, rpcUrl, chainId: ATLANTIC_CHAIN_ID, policyPath, auditPath }
  };
}

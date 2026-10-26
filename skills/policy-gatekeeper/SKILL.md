---
name: policy-gatekeeper
description: >
  REQUIRED for any Pharos action that must pass a spending policy before
  execution. Evaluates every requested action (native transfers, contract
  calls) against a validated policy — spend limits in wei (BigInt only),
  recipient/contract allowlists, and allowed time windows — and returns an
  explicit ALLOW or DENY with rule IDs, reasons, and an append-only audit
  record. Invoke whenever the user mentions "policy", "spend limit",
  "allowlist", "gatekeeper", "guard", "audit trail", or wants to check, gate,
  simulate, or send a PHRS transfer on Pharos with spending controls. Denied
  actions never reach execution; simulated transactions never broadcast; live
  transfers require typing BROADCAST to confirm.
version: 0.1.0
requires:
  anyBins:
  - node
  - npm
---

# Policy Gatekeeper

A SkillEngine skill for the Pharos network that sits between an AI agent and
transaction execution. Every action is validated, evaluated against a
policy, audited, and only then — if ALLOWED and explicitly confirmed —
executed through one guarded boundary.

## Prerequisites

1. **Install Node.js 20+** (MANDATORY): verify with `node --version`.
   If Node.js is not installed, install it from https://nodejs.org and retry.
   Do not proceed without it.
2. **Install project dependencies** (run once, from the project root):
   ```bash
   npm install
   ```
3. **Build once before programmatic use** (the demo runs via `tsx` and does
   not need a build):
   ```bash
   npm run build
   ```
4. **Live transfer configuration** (only needed for `npm run testnet:transfer`):
   copy `.env.example` to `.env` and set `PHAROS_TESTNET_PRIVATE_KEY`,
   `PHAROS_TESTNET_RECIPIENT`, and `PHAROS_TESTNET_CHAIN_ID=688689`.
   The private key is read locally only — never print it, never send it in
   chat, never commit `.env`.

## Network Configuration

Network parameters are verified against the official Pharos documentation
(`https://docs.pharos.xyz/getting-started/network/atlantic-testnet.md`):

| Parameter | Value |
|-----------|-------|
| Network | Pharos Atlantic Testnet |
| Chain ID | `688689` |
| RPC URL | `https://atlantic.dplabs-internal.com` |
| Explorer | `https://atlantic.pharosscan.xyz/` |
| Native token | PHRS (18 decimals) |

The chain ID is verified against the RPC before every simulation and live
transfer; a mismatch aborts fail-closed.

## Capability Index

Load the corresponding reference or run the listed command. Commands are run
from the project root.

| User Need | Capability | Detailed Instructions |
|-----------|------------|----------------------|
| Run the policy demo / see example ALLOW and DENY decisions | `npm run demo` (deterministic mock adapter, no blockchain interaction) | → `references/policy-guide.md#mock-demo-mode` |
| Evaluate an action against a policy (ALLOW/DENY + reasons) | `evaluateRequest` from `dist/index.js`, or a guarded call | → `references/policy-guide.md#evaluating-requests` |
| Configure a spend limit / change the spending cap | Edit the policy JSON `spendLimit.maxAmountWei` (wei decimal string) | → `references/policy-guide.md#policy-configuration` |
| Approve or revoke recipients / contracts | Edit the policy JSON `allowlist.recipients` / `allowlist.contracts` | → `references/policy-guide.md#policy-configuration` |
| Restrict when actions may run | Edit the policy JSON `timeWindow` (IANA timezone + windows) | → `references/policy-guide.md#time-window-semantics` |
| Simulate a Pharos testnet transfer (read-only, no broadcast) | `npm run simulate:testnet` (real RPC: eth_chainId, eth_call, eth_estimateGas, balance, gas price) | → `references/policy-guide.md#read-only-testnet-simulation-mode` |
| Send a real PHRS transfer on Atlantic testnet under policy control | `npm run testnet:transfer` (requires .env wallet config + typing `BROADCAST`) | → `references/policy-guide.md#live-transaction-mode` |
| Inspect past decisions / audit trail | Read the audit JSONL (default `audit/audit.jsonl`; demo: `evidence/demo-audit.jsonl`) | → `references/policy-guide.md#audit-log` |
| Explain why an action was denied | Read `decidingRuleIds` + `reasons` on the decision / audit record | → `references/policy-guide.md#decisions` |
| Verify nothing broadcasts outside confirmation | The only submission path is `eth_sendRawTransaction` after `BROADCAST`; enforced by tests | → `references/policy-guide.md#execution-boundary` |

## General Error Handling

| Error Scenario | Signature | Handling |
|---------------|-----------|----------|
| Policy file missing/malformed | `PolicyValidationError` / reason prefix `POLICY_INVALID` | Fail closed: a DENY decision is recorded, nothing executes. Fix the policy JSON (see reference). |
| Amount malformed (sign/decimals/exponent) | Reason "Invalid amount: valueWei …" | Use plain decimal integer wei strings, e.g. `"1000000000000000000"` = 1 PHRS. |
| Recipient/contract not approved | Reason "… not on the approved … allowlist" | Add the address to `allowlist.recipients` (transfers) or `allowlist.contracts` (calls). |
| Outside time window | Reason "… outside all allowed windows" | Wait, or adjust `timeWindow` in the policy. |
| Chain ID mismatch | `CHAIN_ID_MISMATCH` / "Chain ID mismatch" | Verify `PHAROS_TESTNET_CHAIN_ID=688689` and the RPC URL. Refuses to continue. |
| RPC unreachable | `RPC_ERROR`, "RPC unreachable" | Check network/RPC URL; simulation and transfer both fail closed. |
| Insufficient funds | "Insufficient funds: balance … below value + estimated fee" | Fund the sender with testnet PHRS. |
| Pending nonce ambiguity | "Duplicate-send protection" | A pending transaction exists; resolve it before sending again. Never retry automatically. |
| Simulation predicts revert | "simulation predicts a revert" + decoded `Error(string)`/`Panic(uint256)` | Fix the cause; a live broadcast is blocked. |
| Receipt not observed | Status `pending` / "PENDING / UNRESOLVED" | A submitted hash without a receipt is NOT confirmed. Re-check the explorer later. |

## Security Reminders

- **Private key protection**: the key lives only in the local environment
  (`.env` or shell). It is never printed, logged, or written to evidence or
  audit files. Signing happens locally with viem; only signed bytes leave the
  machine, via `eth_sendRawTransaction`.
- **No hidden execution paths**: the mock adapter and the live adapter are
  separate. Only `npm run testnet:transfer` can broadcast, and only after an
  ALLOW decision + explicit `BROADCAST` confirmation + fresh revalidation.
- **Simulation is not execution**: `npm run simulate:testnet` never signs or
  broadcasts. A successful simulation does not prove a later broadcast will
  succeed.
- **Fail-closed everywhere**: invalid policy, audit-write failure, chain-ID
  mismatch, or any validation failure stops the action before execution.
- **Never** send real funds without reviewing the transaction summary shown
  before confirmation.

## Write Operation Pre-checks (Required Before Any Broadcast)

`npm run testnet:transfer` performs these checks automatically, in order.
If any check fails, the command stops BEFORE signing — do not attempt to
bypass it.

1. **Private key check**: `PHAROS_TESTNET_PRIVATE_KEY` present and
   well-formed (0x + 64 hex). Missing → the command explains exactly what is
   needed and exits without contacting the network.
2. **Sender derivation**: the sender address is derived locally
   (never printed with the key).
3. **Network confirmation**: the RPC chain ID is fetched and must equal
   `688689`; the summary names the network explicitly (Atlantic testnet).
4. **Policy evaluation**: spend limit, allowlist, and time window are
   evaluated and the decision is appended to the audit log.
5. **Balance check**: sender balance must cover value + estimated fee.
6. **Read-only simulation**: eth_call must succeed or the broadcast is blocked.
7. **Explicit confirmation**: the exact transaction summary is displayed and
   the user must type exactly `BROADCAST`.
8. **Revalidation**: the policy is re-evaluated and transaction parameters
   are re-hashed immediately before signing; any drift aborts.
9. **Nonce check**: pending nonce must equal latest nonce (duplicate-send
   protection).
10. **Submission**: one `eth_sendRawTransaction` attempt — never retried;
    ambiguous outcomes are reported, not retried.

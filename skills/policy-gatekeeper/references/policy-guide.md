# Policy Gatekeeper — Policy and Usage Guide

This reference contains the policy schema, request examples, decision output,
audit format, and the exact commands for the three operating modes. All
amounts are wei decimal strings handled with BigInt — floating point is never
used for monetary values.

---

## Policy Configuration

The policy is a JSON file (default: `examples/policy.example.json`, override
with `POLICY_PATH`). It is validated strictly and fail-closed: any missing,
malformed, or invalid value prevents execution. Unknown keys are rejected.

```json
{
  "policyId": "pharos-atlantic-default",
  "version": "1.0.0",
  "spendLimit": {
    "maxAmountWei": "10000000000000000"
  },
  "allowlist": {
    "recipients": ["0x2222222222222222222222222222222222222222"],
    "contracts": ["0x3333333333333333333333333333333333333333"]
  },
  "timeWindow": {
    "timezone": "UTC",
    "windows": [{ "start": "09:00", "end": "17:00" }],
    "boundary": { "startInclusive": true, "endInclusive": false }
  }
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `policyId`, `version` | yes | Identifiers copied into every decision and audit record. |
| `spendLimit.maxAmountWei` | yes | Maximum permitted amount per action, in wei, as a decimal integer string. Must be > 0. Comparisons are exact BigInt; the limit itself is inclusive. |
| `allowlist.recipients` | yes | Addresses allowed as **native transfer** recipients. Empty array = deny all transfers. |
| `allowlist.contracts` | yes | Addresses allowed as **contract call** targets. Empty array = deny all contract calls. |
| `timeWindow.timezone` | yes | IANA timezone, e.g. `"UTC"`, `"America/New_York"`, `"Asia/Tokyo"`. |
| `timeWindow.windows` | yes | One or more `{ start, end, daysOfWeek? }` windows. `start`/`end` are `"HH:mm"` local times in the policy timezone; `end` may be `"24:00"` (end of day). `daysOfWeek` is 0 (Sunday) … 6 (Saturday); omit for every day. Overnight windows (`start > end`) are supported. |
| `timeWindow.boundary` | no | Defaults: `startInclusive: true`, `endInclusive: false`. |

### Validation rules (fail-closed)

- Amounts must match `^(0|[1-9][0-9]*)$` — no signs, decimals, exponents, or
  leading zeros. `-1`, `1.5`, `1e18`, `01` are all rejected.
- Addresses must be `0x` + 40 hex characters; mixed-case input must match its
  EIP-55 checksum. All comparisons use the checksummed form (case-insensitive
  in effect).
- A zero spend limit is invalid configuration (it would deny everything
  silently — remove the policy instead).
- Invalid timezones, malformed windows, empty `windows`, or `start == end`
  are rejected.

### Time window semantics

- A request is inside a window when the clock — rendered in the policy
  timezone — satisfies the window (with the configured boundary inclusivity).
- Requests at exactly `start` are inside when `startInclusive` is true;
  requests at exactly `end` are inside only when `endInclusive` is true.
- Overnight example: `{ "start": "22:00", "end": "06:00" }` allows 23:30 and
  05:00, denies 12:00 and 21:59.
- All automated tests and the demo use an **injectable clock**; production
  uses the wall clock.

---

## Requests

```json
{
  "requestId": "req-allowed-001",
  "kind": "native_transfer",
  "from": "0x4444444444444444444444444444444444444444",
  "to": "0x2222222222222222222222222222222222222222",
  "valueWei": "10000000000000000"
}
```

- `kind` is `native_transfer` (checked against `allowlist.recipients`) or
  `contract_call` (checked against `allowlist.contracts`).
- `valueWei` is `"0"` for value-less contract calls.
- `data` (optional calldata) is recorded for audit; the allowlist check uses
  `to`.

### Evaluating requests (programmatic)

```bash
npm run build
node --input-type=module -e "
import { validatePolicy, evaluateRequest, readFileSync } from './dist/index.js';
import { readFileSync as rf } from 'node:fs';
const policy = validatePolicy(JSON.parse(rf('examples/policy.example.json','utf8')));
const decision = evaluateRequest(policy, {
  requestId: 'req-001', kind: 'native_transfer',
  from: '0x4444444444444444444444444444444444444444',
  to: '0x2222222222222222222222222222222222222222',
  valueWei: '1000000000000000'
}, { clock: () => new Date() });
console.log(JSON.stringify(decision, null, 2));
"
```

---

## Decisions

Every request produces a typed decision. Rules are identified as
`SPEND_LIMIT`, `ADDRESS_ALLOWLIST`, and `TIME_WINDOW`. **All three rules are
always evaluated**; if any fails, the decision is DENY.

### Example ALLOW output

```json
{
  "decisionId": "dec-…",
  "requestId": "req-allowed-001",
  "decision": "ALLOW",
  "timestamp": "2026-10-27T12:00:00.000Z",
  "policyId": "pharos-atlantic-default",
  "policyVersion": "1.0.0",
  "ruleResults": [
    { "ruleId": "SPEND_LIMIT", "passed": true, "reason": "Requested 1000000000000000 wei is within the policy maximum 10000000000000000 wei (inclusive)." },
    { "ruleId": "ADDRESS_ALLOWLIST", "passed": true, "reason": "Recipient 0x2222… is approved for native transfers (sender 0x4444…)." },
    { "ruleId": "TIME_WINDOW", "passed": true, "reason": "Request local time 12:00 on 2026-10-27 (Tue) in UTC is inside allowed window \"00:00-23:59\" (start inclusive, end inclusive)." }
  ],
  "decidingRuleIds": ["SPEND_LIMIT", "ADDRESS_ALLOWLIST", "TIME_WINDOW"],
  "reasons": [],
  "executionAttempted": false,
  "auditRecordId": "aud-…",
  "mode": "mock"
}
```

### Example DENY output (multiple rules)

```json
{
  "decisionId": "dec-…",
  "requestId": "req-denied-002",
  "decision": "DENY",
  "decidingRuleIds": ["SPEND_LIMIT", "ADDRESS_ALLOWLIST", "TIME_WINDOW"],
  "reasons": [
    "Spend limit exceeded: requested 500000000000000000 wei exceeds the policy maximum 100000000000000000 wei.",
    "Recipient 0x9999… is not on the approved recipient allowlist (2 approved).",
    "Request local time 20:00 on 2026-10-27 (Tue) in UTC is outside all allowed windows: 09:00-17:00."
  ],
  "executionAttempted": false
}
```

`decidingRuleIds` lists the failed rules for DENY and all evaluated rules for
ALLOW. A DENY never has an empty `reasons` array — invalid policy or requests
produce a specific `POLICY_INVALID` / malformed-input reason.

---

## Execution Boundary

There is exactly one guarded execution path:

1. Validate policy (fail closed on any problem).
2. Evaluate all rules → typed decision.
3. Append the decision to the audit log (an audit-write failure aborts).
4. DENY → stop. Zero adapter calls, zero signatures, zero submissions.
5. ALLOW → hand approval to the next guarded step:
   - **mock**: the deterministic mock adapter runs (no wallet, no network).
   - **live**: transaction summary → user types exactly `BROADCAST` →
     re-evaluate policy + re-hash parameters → nonce check → local signing →
     single `eth_sendRawTransaction` → receipt verification.

A test asserts the literal wallet-managed send RPC never appears in the
source, and the guarded tests assert zero executions for every denial type.

---

## Mock Demo Mode

```bash
npm run demo
```

Deterministic, no wallet access, no blockchain interaction. Demonstrates:

- **A** allowed transfer, **B** spend-limit denial, **C** allowlist denial,
  **D** time-window denial, **E** multiple-rule denial, **F1** invalid
  request, **F2** invalid policy, **G** allowed contract call.

The demo prints each decision with its deciding rules and the actual mock
adapter call counts, and writes `evidence/demo-results.json`,
`evidence/demo-results.md`, and `evidence/demo-audit.jsonl` from the actual
run. Only allowed actions reach the adapter.

---

## Read-Only Testnet Simulation Mode

```bash
npm run simulate:testnet
```

Performs REAL read-only RPC calls to `https://atlantic.dplabs-internal.com`:
`eth_chainId` (must be 688689), `eth_call` (predicted outcome),
`eth_estimateGas`, `eth_getBalance`, `eth_gasPrice`. It never signs or
broadcasts anything.

Configuration (environment, no secrets required): `PHAROS_TESTNET_SENDER`
(plain address) or `PHAROS_TESTNET_PRIVATE_KEY` (used only to derive the
sender locally), `PHAROS_TESTNET_RECIPIENT`, `PHAROS_TESTNET_AMOUNT`
(default `0.001`), optional `PHAROS_TESTNET_RPC_URL`.

Output/evidence:

- Predicted success or revert, with `Error(string)` / `Panic(uint256)`
  decoded when possible; raw revert data is preserved otherwise — no reason
  is ever invented.
- Estimated fee computed with BigInt (`gasEstimate × gasPrice`).
- Predicted sender balance after the transfer, shown only when reliable.
- Clear statement that contract state changes cannot be predicted from
  simulation and that simulation never proves a later broadcast will succeed.
- Fail-closed structured result on chain-ID mismatch or any RPC/gas error.
- Evidence: `evidence/testnet-simulation.json` and
  `evidence/testnet-simulation.md`, labeled `SIMULATION — NO TRANSACTION
  BROADCAST`.

The policy is also evaluated in this mode (mode `simulation`) and the
decision is audited, so reviewers can see gating applied consistently.
The simulation itself still completes because it is read-only.

---

## Live Transaction Mode

```bash
npm run testnet:transfer
```

This is the ONLY normal entry point that can broadcast a transaction.
Requires local wallet configuration (`.env`, see `.env.example`):

- `PHAROS_TESTNET_PRIVATE_KEY` — 0x + 64 hex; read locally, never printed.
- `PHAROS_TESTNET_RECIPIENT` — must also be added to the policy allowlist or
  the send is DENY.
- `PHAROS_TESTNET_AMOUNT` — PHRS decimal, default `0.001`.
- `PHAROS_TESTNET_CHAIN_ID` — must be exactly `688689`.
- `PHAROS_TESTNET_RPC_URL` — optional; defaults to the Atlantic RPC.

If configuration is missing, the command prints exactly what is needed and
stops before contacting the network.

Safety sequence: chain-ID verification → policy evaluation + audit → balance
sufficiency → gas estimation → read-only simulation → summary → type exactly
`BROADCAST` → revalidation (fresh policy + parameter hash) → pending-nonce
check → local signing (viem) → single `eth_sendRawTransaction` → receipt
verification. Submission errors are never retried; ambiguous outcomes are
reported as ambiguous. A submitted hash without a receipt is reported as
pending/unresolved, never confirmed.

Evidence is written to `evidence/live-testnet-transaction.json` and `.md`
only when an actual broadcast produced a transaction hash, and it contains
the policy decision, rule results, timeline (approval → simulation →
broadcast → receipt), and verified receipt fields — never secrets.

---

## Audit Log

Append-only JSON Lines. Default path `audit/audit.jsonl` (override with
`AUDIT_PATH`; the demo writes `evidence/demo-audit.jsonl`). One record per
policy decision and one per execution result. Retention: records are never
modified or deleted and the file grows without rotation — archive or
truncate it externally to manage retention.

```json
{
  "auditId": "aud-…",
  "timestamp": "2026-10-27T12:00:00.000Z",
  "kind": "policy_decision",
  "requestId": "req-allowed-001",
  "policyId": "pharos-atlantic-default",
  "policyVersion": "1.0.0",
  "mode": "live",
  "decision": "ALLOW",
  "decisionId": "dec-…",
  "ruleOutcomes": [
    { "ruleId": "SPEND_LIMIT", "passed": true, "reason": "…" }
  ],
  "decidingRuleIds": ["SPEND_LIMIT", "ADDRESS_ALLOWLIST", "TIME_WINDOW"],
  "reasons": [],
  "executionAttempted": false
}
```

Execution records (`kind: "execution_result"`) add `execution` (status,
detail) and `transactionHash` — only when a hash was actually returned by a
submission. The log never contains private keys, seed phrases, credentials,
or signed raw transaction bytes; error messages are sanitized.

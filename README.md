# Policy Gatekeeper — Pharos SkillEngine Skill

A working, SkillEngine-compatible skill for the Pharos network that gates
every requested action behind a validated policy: **spend limits** (exact
BigInt wei arithmetic), **recipient/contract allowlists**, and **allowed time
windows**. Every evaluation returns an explicit `ALLOW` or `DENY` with rule
IDs, specific reasons, and an append-only audit record. Denied actions never
reach execution.

Three strictly separated operating modes:

| Mode | Command | Blockchain interaction |
|------|---------|------------------------|
| **A — Mock demo** | `npm run demo` | None. Deterministic mock adapter only. |
| **B — Testnet simulation** | `npm run simulate:testnet` | Real **read-only** RPC (`eth_chainId`, `eth_call`, `eth_estimateGas`, balances, gas price). Never signs or broadcasts. |
| **C — Live testnet transfer** | `npm run testnet:transfer` | Real broadcast — **only** after policy approval, an explicit `BROADCAST` confirmation, and pre-sign revalidation. |

> ⚠️ **Warning:** `npm run testnet:transfer` sends a **real transaction** on
> the Pharos Atlantic testnet. It requires local wallet configuration and
> interactive confirmation — you must type exactly `BROADCAST` after
> reviewing the transaction summary. Never run it with a key that holds
> mainnet funds.

## Verified SkillEngine integration

The Pharos Skill Engine format was verified against two official sources:

1. **Official documentation** — `https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide.md`
   (linked from `https://ai.pharos.xyz/`, page "Skill Engine"):
   - A skill is a package with `SKILL.md` as the AI-agent entry point,
     `references/*.md` files containing per-operation instructions (command
     template → parameters → output parsing → error handling → agent
     guidelines), and optional `assets/`.
   - `SKILL.md` contains YAML frontmatter (`name`, `description`, `version`,
     `requires`), Prerequisites, Network Configuration, a **Capability
     Index** table mapping natural-language user needs to capabilities and
     reference anchors, General Error Handling, Security Reminders, and
     Write Operation Pre-checks.
   - Skills are installed into agent clients with the agent-skills CLI:
     `npx skills add <repo-url>` (the official engine is installed via
     `npx skills add https://github.com/PharosNetwork/pharos-skill-engine`).
2. **The official engine's own SKILL.md**
   (`https://raw.githubusercontent.com/PharosNetwork/pharos-skill-engine/main/SKILL.md`)
   — used as the concrete reference for frontmatter and section structure.

This repository implements the same format in
[`skills/policy-gatekeeper/SKILL.md`](skills/policy-gatekeeper/SKILL.md)
(with `references/policy-guide.md`), and every Capability Index row invokes
the real implementation (npm commands and the programmatic API in
`dist/index.js`) rather than describing hypothetical behavior. The skill has
not been registered or published anywhere; the integration target is the
documented local skill-package format.

## Network (verified from official docs)

| Parameter | Value | Source |
|-----------|-------|--------|
| Network | Pharos Atlantic Testnet | `docs.pharos.xyz/getting-started/network/atlantic-testnet.md` |
| Chain ID | `688689` | same page |
| RPC | `https://atlantic.dplabs-internal.com` | same page |
| Explorer | `https://atlantic.pharosscan.xyz/` | same page |

The application re-verifies the chain ID against the live RPC on every
simulation and live transfer and aborts fail-closed on mismatch.

## Policy configuration

See [`skills/policy-gatekeeper/references/policy-guide.md`](skills/policy-gatekeeper/references/policy-guide.md)
and [`examples/policy.example.json`](examples/policy.example.json). Summary:

- `spendLimit.maxAmountWei` — decimal wei string, exact BigInt comparison,
  limit inclusive. Malformed/negative/over-limit amounts are rejected.
- `allowlist.recipients` / `allowlist.contracts` — separate typed lists;
  addresses are syntax-validated (EIP-55 strict for mixed case) and
  normalized to checksummed form before comparison.
- `timeWindow` — IANA timezone + `HH:mm` windows (overnight supported,
  `24:00` end-of-day, optional `daysOfWeek`), explicit boundary semantics
  (start inclusive, end exclusive by default), injectable clock for tests.
- **Fail-closed**: missing/malformed/invalid policy (or unknown keys) prevents
  execution; a `POLICY_INVALID` DENY is recorded in the audit log. No
  permissive defaults are ever substituted.

## Example decision outputs

ALLOW (all rules pass — `decidingRuleIds` lists all evaluated rules):

```json
{
  "decision": "ALLOW",
  "decidingRuleIds": ["SPEND_LIMIT", "ADDRESS_ALLOWLIST", "TIME_WINDOW"],
  "ruleResults": [
    { "ruleId": "SPEND_LIMIT", "passed": true, "reason": "Requested 10000000000000000 wei is within the policy maximum 100000000000000000 wei (inclusive)." },
    { "ruleId": "ADDRESS_ALLOWLIST", "passed": true, "reason": "Recipient 0x2222… is approved for native transfers (sender 0x4444…)." },
    { "ruleId": "TIME_WINDOW", "passed": true, "reason": "Request local time 12:00 on 2026-10-27 (Tue) in UTC is inside allowed window \"00:00-23:59\" (start inclusive, end inclusive)." }
  ],
  "reasons": [],
  "executionAttempted": false,
  "auditRecordId": "aud-…"
}
```

DENY (every applicable rule is reported):

```json
{
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

A generic DENY without a reason is impossible by construction; even invalid
policy produces a specific `POLICY_INVALID: …` reason.

## Audit log format

Append-only JSON Lines (default `audit/audit.jsonl`; demo:
`evidence/demo-audit.jsonl`). One `policy_decision` record per decision and
one `execution_result` record when execution was attempted **or a live
attempt was blocked before signing** (including failed safety checks and
revalidation blocks; the demo evidence file is reset at the start of each
demo run so it describes exactly one run). Records carry
timestamps, decision/request/policy IDs, rule outcomes, deciding rule IDs,
reasons, mode (`mock`/`simulation`/`live`), execution outcome, and the
transaction hash **only** when one was actually returned. Private keys, seed
phrases, credentials, and signed raw transaction bytes are never written;
error strings are sanitized. Retention: append-only, no rotation — archive
or truncate externally.

## Architecture and security boundaries

```
src/
├── policy/validate-policy.ts   Strict fail-closed policy validation
├── policy/evaluate.ts          Decision engine (SPEND_LIMIT / ADDRESS_ALLOWLIST / TIME_WINDOW)
├── audit/logger.ts             Append-only JSONL audit log (fail-closed on write errors)
├── execution/guard.ts          THE single enforced execution boundary
├── execution/mock-adapter.ts   Deterministic mock adapter (no wallet, no network)
├── testnet/client.ts           RPC surface — only eth_sendRawTransaction for submission
├── testnet/simulate.ts         Read-only simulation + Error/Panic decoding
├── testnet/transfer.ts         Live path: full safety sequence (Mode C)
├── testnet/evidence.ts         Evidence writers (actual results only)
├── config.ts, units.ts, cli.ts, demo.ts, index.ts
```

Key properties:

- **One boundary.** Mock and live execution both pass through `PolicyGuard`.
  There is no alternate unguarded path; a test asserts the literal
  wallet-managed send RPC (`eth_sendTransaction`) never appears in `src/`.
- **Fail closed.** Invalid policy, audit-write failure, chain-ID mismatch,
  gas/balance/simulation errors — all stop before any execution.
- **Live safety sequence.** policy decision → balance/fee checks → read-only
  simulation → summary → type `BROADCAST` → re-evaluate policy + re-hash
  transaction parameters → pending-nonce check → local viem signing →
  single `eth_sendRawTransaction` (never retried) → receipt verification.
- **Honest reporting.** A submitted hash without a receipt is
  pending/unresolved, never "confirmed". Ambiguous submission outcomes are
  reported as ambiguous. Simulation never claims a future broadcast will
  succeed.
- **Dependency injection** throughout (clock, RPC, adapters, audit logger,
  confirmation prompt) — which is how every safety property is tested
  without touching the network.

## Setup

```bash
npm install
npm run build        # optional; demo/tests/simulation run via tsx
```

### Mode A — Mock demo

```bash
npm run demo
```

Writes `evidence/demo-results.json`, `evidence/demo-results.md`,
`evidence/demo-audit.jsonl` from the actual run.

### Mode B — Read-only testnet simulation

```bash
# No secrets required; a plain sender address is enough.
# PowerShell:
$env:PHAROS_TESTNET_SENDER = "0x1111111111111111111111111111111111111111"
$env:PHAROS_TESTNET_RECIPIENT = "0x2222222222222222222222222222222222222222"
npm run simulate:testnet
```

Writes `evidence/testnet-simulation.json` and `evidence/testnet-simulation.md`,
labeled `SIMULATION — NO TRANSACTION BROADCAST`.

### Mode C — Live testnet transfer

```bash
# Copy .env.example to .env and fill in:
#   PHAROS_TESTNET_PRIVATE_KEY=0x…        (local only; never commit)
#   PHAROS_TESTNET_RECIPIENT=0x…          (add to the policy allowlist too!)
#   PHAROS_TESTNET_CHAIN_ID=688689
#   PHAROS_TESTNET_AMOUNT=0.001           (optional)
npm run testnet:transfer
```

The command stops safely with instructions when configuration is missing.
After policy approval and safety checks it prints the exact transaction
summary and waits for you to type `BROADCAST`. Anything else aborts. Evidence
is written only when a real broadcast returned a transaction hash.

## Test results

Latest full run (98 automated tests, all mocked — no network, no broadcast):

| Command | Result |
|---------|--------|
| `npm test` | **98/98 passed** (5 files) — exit code 0 |
| `npm run typecheck` | clean — exit code 0 |
| `npm run lint` | clean — exit code 0 |
| `npm run build` | clean — exit code 0 |
| `npm run demo` | 8 decisions (2 ALLOW / 6 DENY), 2 adapter calls total, **0 adapter calls from denied actions** — exit code 0 |

Coverage highlights: BigInt spend boundaries (inclusive limit, +1 wei denial,
beyond-Number.MAX_SAFE_INTEGER amounts), address validation/checksums,
time-window boundaries and timezones (including overnight windows and
`daysOfWeek`), malformed/missing configuration, audit logging for ALLOW and
DENY, audit-write failure → fail-closed, zero executions for every denial
type, exactly one adapter call for allowed mock actions, live confirmation
gating (no signing/submission without `BROADCAST`), policy change/expiry
between approval and signing, parameter-drift detection, chain-ID mismatch
blocking, duplicate-send (nonce) protection, single submission attempt with
no retry on ambiguous errors, on-chain revert reporting, and honest
pending/unresolved receipt handling.

## Known limitations

- Time-window granularity is whole minutes (`HH:mm`).
- Simulation predicts native-transfer outcomes; for contract calls it
  reflects the current chain state only — future state changes cannot be
  predicted (stated explicitly in all simulation output).
- The audit log has no built-in rotation or remote shipping.
- `npm run testnet:transfer` uses legacy (gas-price) transactions; EIP-1559
  fields are not used.
- No GUI — the skill is CLI/programmatic, per the SkillEngine model.
- Live-transfer evidence exists only after a real broadcast; none is
  fabricated when the command is blocked or unconfigured.

## License

MIT-style placeholder for evaluation purposes; adjust before publishing.

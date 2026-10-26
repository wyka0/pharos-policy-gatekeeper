# Testnet Simulation Evidence

> **SIMULATION — NO TRANSACTION BROADCAST**

Generated: 2026-10-26T23:21:15.728Z

## Network

| Field | Value |
|---|---|
| Network | Pharos Atlantic Testnet |
| Chain ID (expected) | 688689 |
| Chain ID (RPC) | 688689 |
| Chain ID verified | true |
| RPC URL | https://atlantic.dplabs-internal.com |

## Request

| Field | Value |
|---|---|
| Sender | 0x1111111111111111111111111111111111111111 |
| Recipient | 0x2222222222222222222222222222222222222222 |
| Value | 1000000000000000 wei (0.001 PHRS) |

## Policy decision

| Field | Value |
|---|---|
| Decision | DENY |
| Decision ID | dec-e0dbff9e-412d-4518-8aa5-561be7b18924 |
| Policy | pharos-atlantic-default v1.0.0 |

Rule results:

- **SPEND_LIMIT**: PASS — Requested 1000000000000000 wei is within the policy maximum 10000000000000000 wei (inclusive).
- **ADDRESS_ALLOWLIST**: FAIL — Recipient 0x2222222222222222222222222222222222222222 is not on the approved recipient allowlist (1 approved).
- **TIME_WINDOW**: PASS — Request local time 23:21 on 2026-10-26 (Mon) in UTC is inside allowed window "00:00-23:59" (start inclusive, end inclusive).

## Simulation result

| Field | Value |
|---|---|
| eth_call status | success |
| eth_call return data | 0x |
| Gas estimate (eth_estimateGas) | 21000 |
| Gas price | 10000000000 wei |
| Estimated fee | 210000000000000 wei (0.00021 PHRS) |
| Sender balance | 204868297450154497 wei |
| Predicted balance after | 203658297450154497 |
| Balance prediction reliable | true |

### Notes

- Simulation executes read-only (eth_call) and does not persist state. Contract state changes that a real broadcast would cause cannot be predicted from simulation.
- A successful simulation does not prove that a transaction submitted later will succeed.

### Disclaimers

- This file records a READ-ONLY simulation. No transaction was signed or broadcast.
- Simulation never proves that a transaction submitted later will succeed.

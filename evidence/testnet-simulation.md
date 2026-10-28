# Testnet Simulation Evidence

> **SIMULATION — NO TRANSACTION BROADCAST**

Generated: 2026-10-27T05:57:50.536Z

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
| Sender | 0x299Ce4113abF88F4997737184aa8A7a3D58AC15C |
| Recipient | 0xB0f7681668f916eEd97dA066D31aA295D34727c0 |
| Value | 1000000000000000 wei (0.001 PHRS) |

## Policy decision

| Field | Value |
|---|---|
| Decision | ALLOW |
| Decision ID | dec-b6a1b1a7-2c3b-4509-a48a-31ca79dc2a1e |
| Policy | pharos-atlantic-default v1.0.0 |

Rule results:

- **SPEND_LIMIT**: PASS — Requested 1000000000000000 wei is within the policy maximum 10000000000000000 wei (inclusive).
- **ADDRESS_ALLOWLIST**: PASS — Recipient 0xB0f7681668f916eEd97dA066D31aA295D34727c0 is approved for native transfers (sender 0x299Ce4113abF88F4997737184aa8A7a3D58AC15C).
- **TIME_WINDOW**: PASS — Request local time 05:57 on 2026-10-27 (Tue) in UTC is inside allowed window "00:00-23:59" (start inclusive, end inclusive).

## Simulation result

| Field | Value |
|---|---|
| eth_call status | success |
| eth_call return data | 0x |
| Gas estimate (eth_estimateGas) | 21000 |
| Gas price | 10000000000 wei |
| Estimated fee | 210000000000000 wei (0.00021 PHRS) |
| Sender balance | 109080000000000000 wei |
| Predicted balance after | 107870000000000000 |
| Balance prediction reliable | true |

### Notes

- Simulation executes read-only (eth_call) and does not persist state. Contract state changes that a real broadcast would cause cannot be predicted from simulation.
- A successful simulation does not prove that a transaction submitted later will succeed.

### Disclaimers

- This file records a READ-ONLY simulation. No transaction was signed or broadcast.
- Simulation never proves that a transaction submitted later will succeed.

# Live Testnet Transaction Evidence

> **LIVE TESTNET TRANSACTION — REAL BROADCAST**

Generated: 2026-10-27T05:58:48.366Z
Status: **confirmed**
Secrets in this file: none — private keys and signed raw transaction bytes are never written to evidence

## Timeline

| Phase | State |
|---|---|
| Policy approval | ALLOW (dec-f35eee31-d490-4b8e-bfd8-69a755d468d6) |
| Pre-broadcast simulation | success (read-only) |
| Actual broadcast | broadcast: 0xba90d4192c4c3a39aa2889ed27fe9648938abb7d73d6ef8677dad3915a484235 |
| Receipt confirmation | receipt status success in block 31933688 |

## Policy decision associated with the transaction

- Decision: **ALLOW** (ID dec-f35eee31-d490-4b8e-bfd8-69a755d468d6)
- Policy: pharos-atlantic-default v1.0.0

- **SPEND_LIMIT**: PASS — Requested 1000000000000000 wei is within the policy maximum 10000000000000000 wei (inclusive).
- **ADDRESS_ALLOWLIST**: PASS — Recipient 0xB0f7681668f916eEd97dA066D31aA295D34727c0 is approved for native transfers (sender 0x299Ce4113abF88F4997737184aa8A7a3D58AC15C).
- **TIME_WINDOW**: PASS — Request local time 05:58 on 2026-10-27 (Tue) in UTC is inside allowed window "00:00-23:59" (start inclusive, end inclusive).

- Pre-sign revalidation decision: **ALLOW** (ID dec-a08ee939-02d8-49f7-b3e3-b50f134896f1)

## Pre-broadcast simulation (read-only)

- Label: SIMULATION — NO TRANSACTION BROADCAST
- eth_call status: success
- Gas estimate: 21000

## Actual broadcast

- Transaction hash: `0xba90d4192c4c3a39aa2889ed27fe9648938abb7d73d6ef8677dad3915a484235`
- Explorer: https://atlantic.pharosscan.xyz/tx/0xba90d4192c4c3a39aa2889ed27fe9648938abb7d73d6ef8677dad3915a484235

## Receipt (verified)

| Field | Value |
|---|---|
| Transaction hash | `0xba90d4192c4c3a39aa2889ed27fe9648938abb7d73d6ef8677dad3915a484235` |
| Network | Pharos Atlantic Testnet (chain ID 688689) |
| Sender | 0x299ce4113abf88f4997737184aa8a7a3d58ac15c |
| Recipient | 0xb0f7681668f916eed97da066d31aa295d34727c0 |
| Value | 1000000000000000 wei (0.001 PHRS) |
| Block number | 31933688 |
| Receipt status | success |
| Gas used | 21000 |
| Effective gas price | 10000000000 wei |
| Actual fee (gasUsed × effectiveGasPrice) | 210000000000000 wei (0.00021 PHRS) |
| Confirmations (checked at evidence time) | 2 |
| Explorer URL (official, from Pharos docs) | https://atlantic.pharosscan.xyz/tx/0xba90d4192c4c3a39aa2889ed27fe9648938abb7d73d6ef8677dad3915a484235 |

### Field verification

| Field | Expected | Actual | Match |
|---|---|---|---|
| from | 0x299Ce4113abF88F4997737184aa8A7a3D58AC15C | 0x299ce4113abf88f4997737184aa8a7a3d58ac15c | YES |
| to | 0xB0f7681668f916eEd97dA066D31aA295D34727c0 | 0xb0f7681668f916eed97da066d31aa295d34727c0 | YES |
| value (wei) | 1000000000000000 | 1000000000000000 | YES |

## Execution stages

| Step | Name | Status | Detail |
|---|---|---|---|
| 1 | chain-id-verification | ok | RPC reports chain ID 688689; expected 688689. |
| 2 | policy-decision | ok | Policy pharos-atlantic-default v1.0.0 → ALLOW |
| 3 | gas-estimation | ok | eth_estimateGas → 21000 |
| 4 | gas-price | ok | gas price → 10000000000 wei |
| 5 | sender-balance | ok | balance → 109080000000000000 wei (0.10908 PHRS) |
| 6 | pre-broadcast-simulation | ok | eth_call: success gas estimate: 21000 gas price: 10000000000 wei estimated fee: 210000000000000 wei (0.00021 PHRS) sender balance: 109080000000000000 wei |
| 7 | user-confirmation | ok | user typed BROADCAST |
| 8 | pre-sign-revalidation | ok | Policy re-evaluated: ALLOW (decision dec-a08ee939-02d8-49f7-b3e3-b50f134896f1); transaction parameters unchanged (hash 33af40dec1cb4791…). |
| 9 | nonce-check | ok | latest=2 pending=2 |
| 10 | local-signing | ok | transaction signed locally (viem private-key account). |
| 11 | broadcast | executed | eth_sendRawTransaction → 0xba90d4192c4c3a39aa2889ed27fe9648938abb7d73d6ef8677dad3915a484235 |
| 12 | receipt | ok | status=success block=31933688 gasUsed=21000 |

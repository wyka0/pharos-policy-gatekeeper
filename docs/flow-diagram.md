# Request Flow and Security Boundaries

## End-to-end flow

```
                        ┌─────────────────────────┐
                        │  Request                │
                        │  (transfer/contract op) │
                        └───────────┬─────────────┘
                                    │
                        ┌───────────▼─────────────┐
                        │  1. Validate            │
                        │  policy JSON (strict,   │
                        │  fail-closed)           │
                        └───────────┬─────────────┘
                                    │
                        ┌───────────▼─────────────┐
                        │  2. Evaluate policy     │
                        │  SPEND_LIMIT            │
                        │  ADDRESS_ALLOWLIST      │
                        │  TIME_WINDOW            │
                        │  (every rule, every     │
                        │  time — BigInt only)    │
                        └───────────┬─────────────┘
                                    │
                        ┌───────────▼─────────────┐
                        │  3. Record decision in  │
                        │  audit log (JSONL,      │
                        │  append-only)           │
                        └───────────┬─────────────┘
                                    │
                 ┌──────────────────┴──────────────────┐
                 │                                     │
            DENY ▼                                ALLOW ▼
   ┌─────────────────────┐              ┌──────────────────────────┐
   │ 4. Record reason    │              │ 5. Return approval to    │
   │    (rule IDs +      │              │    the next guarded step │
   │    specific reason) │              └────────────┬─────────────┘
   └──────────┬──────────┘                           │
              │                          ┌───────────▼───────────────┐
   ┌──────────▼──────────┐               │ 6. Final safety checks    │
   │  STOP.              │               │  mock: none needed        │
   │  No adapter call.   │               │  live: chainId=688689 →   │
   │  No signing.        │               │  balance ≥ value+fee →    │
   │  No submission.     │               │  eth_call simulation →    │
   └─────────────────────┘               │  summary shown            │
                                         └───────────┬───────────────┘
                                                     │
                                        live only: type exactly `BROADCAST`
                                                     │
                                         ┌───────────▼───────────────┐
                                         │ 7. Revalidate BEFORE      │
                                         │ signing: policy re-read + │
                                         │ re-evaluated, request     │
                                         │ re-hashed, nonce checked  │
                                         └───────────┬───────────────┘
                                                     │
                                    ┌────────────────┴────────────────┐
                                    │                                 │
                             drift/DENY ▼                      still ALLOW ▼
                        ┌────────────────┐          ┌────────────────────────────┐
                        │ Abort: no      │          │ 8. Sign locally (viem) →   │
                        │ signing, no    │          │ ONE eth_sendRawTransaction │
                        │ submission     │          │ (never retried) → wait for │
                        └────────────────┘          │ receipt → verify fields    │
                                                    └────────────────────────────┘
```

## Boundary guarantees (all enforced by tests)

| Guarantee | Where enforced |
|-----------|----------------|
| DENY → zero adapter calls / zero submissions | `tests/execution-guard.test.ts`, `tests/testnet-transfer.test.ts` |
| Invalid policy → no execution, audited `POLICY_INVALID` DENY | `PolicyGuard.evaluateAndRecord` |
| Audit-write failure → no execution (fail closed) | `PolicyGuard` + `tests/execution-guard.test.ts` |
| No signing/submission without typing `BROADCAST` | `src/testnet/transfer.ts` |
| Policy/parameter revalidation immediately before signing | `PolicyGuard.revalidateForSigning` |
| Pending-nonce ambiguity aborts before signing | duplicate-send protection in `transfer.ts` |
| Exactly one submission attempt; ambiguous outcomes never retried | `transfer.ts` broadcast step |
| The wallet-managed send RPC never appears in source | `tests/testnet-transfer.test.ts` source scan |
| Simulation never signs or broadcasts | `src/testnet/simulate.ts` (RPC surface has no send method except raw) |
| Hash without receipt = pending/unresolved, never confirmed | `transfer.ts` receipt step + tests |
| Mock adapter isolated from live adapter | separate modules; demo uses mock only |

## Mode separation

- **mock** (`npm run demo`): `MockTransferAdapter` — no wallet, no RPC.
- **simulation** (`npm run simulate:testnet`): real RPC, read-only methods
  only (`eth_chainId`, `eth_call`, `eth_estimateGas`, `eth_getBalance`,
  `eth_gasPrice`).
- **live** (`npm run testnet:transfer`): the only entry point that calls
  `eth_sendRawTransaction`, behind the full sequence above.

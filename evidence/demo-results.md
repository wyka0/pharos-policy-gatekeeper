# Mock Demo Results

Mode: **mock demo** — deterministic, no blockchain interaction, no wallet access.
Generated from actual execution at 2026-10-26T23:24:22.398Z.

## Policy used

| Field | Value |
|---|---|
| Policy | demo-policy v1.0.0 |
| Spend limit | 100000000000000000 wei (0.1 PHRS) |
| Time window | 09:00–17:00 (UTC) |
| Approved recipients | 2 |
| Approved contracts | 1 |

## Cases

### Case A — Allowed action — within spend limit, approved recipient, inside window

- Request `demo-A`: **ALLOW** (policy demo-policy v1.0.0, timestamp 2026-10-27T12:00:00.000Z)
- Deciding rules: SPEND_LIMIT, ADDRESS_ALLOWLIST, TIME_WINDOW
- Execution attempted: true
- Mock adapter calls for this case: **1**
- Audit record: aud-001

  - **SPEND_LIMIT**: PASS — Requested 10000000000000000 wei is within the policy maximum 100000000000000000 wei (inclusive).
  - **ADDRESS_ALLOWLIST**: PASS — Recipient 0x1111111111111111111111111111111111111111 is approved for native transfers (sender 0x4444444444444444444444444444444444444444).
  - **TIME_WINDOW**: PASS — Request local time 12:00 on 2026-10-27 (Tue) in UTC is inside allowed window "09:00-17:00" (start inclusive, end exclusive).

### Case B — Spend-limit denial — 0.5 PHRS exceeds the 0.1 PHRS maximum

- Request `demo-B`: **DENY** (policy demo-policy v1.0.0, timestamp 2026-10-27T12:00:00.000Z)
- Deciding rules: SPEND_LIMIT
- Execution attempted: false
- Mock adapter calls for this case: **0**
- Audit record: aud-004

  - **SPEND_LIMIT**: FAIL — Spend limit exceeded: requested 500000000000000000 wei exceeds the policy maximum 100000000000000000 wei.
  - **ADDRESS_ALLOWLIST**: PASS — Recipient 0x1111111111111111111111111111111111111111 is approved for native transfers (sender 0x4444444444444444444444444444444444444444).
  - **TIME_WINDOW**: PASS — Request local time 12:00 on 2026-10-27 (Tue) in UTC is inside allowed window "09:00-17:00" (start inclusive, end exclusive).

### Case C — Allowlist denial — recipient is not approved

- Request `demo-C`: **DENY** (policy demo-policy v1.0.0, timestamp 2026-10-27T12:00:00.000Z)
- Deciding rules: ADDRESS_ALLOWLIST
- Execution attempted: false
- Mock adapter calls for this case: **0**
- Audit record: aud-006

  - **SPEND_LIMIT**: PASS — Requested 10000000000000000 wei is within the policy maximum 100000000000000000 wei (inclusive).
  - **ADDRESS_ALLOWLIST**: FAIL — Recipient 0x9999999999999999999999999999999999999999 is not on the approved recipient allowlist (2 approved).
  - **TIME_WINDOW**: PASS — Request local time 12:00 on 2026-10-27 (Tue) in UTC is inside allowed window "09:00-17:00" (start inclusive, end exclusive).

### Case D — Time-window denial — 20:00 UTC is outside the 09:00–17:00 UTC window

- Request `demo-D`: **DENY** (policy demo-policy v1.0.0, timestamp 2026-10-27T20:00:00.000Z)
- Deciding rules: TIME_WINDOW
- Execution attempted: false
- Mock adapter calls for this case: **0**
- Audit record: aud-008

  - **SPEND_LIMIT**: PASS — Requested 10000000000000000 wei is within the policy maximum 100000000000000000 wei (inclusive).
  - **ADDRESS_ALLOWLIST**: PASS — Recipient 0x1111111111111111111111111111111111111111 is approved for native transfers (sender 0x4444444444444444444444444444444444444444).
  - **TIME_WINDOW**: FAIL — Request local time 20:00 on 2026-10-27 (Tue) in UTC is outside all allowed windows: 09:00-17:00.

### Case E — Multiple-rule denial — over limit AND unapproved recipient AND outside window

- Request `demo-E`: **DENY** (policy demo-policy v1.0.0, timestamp 2026-10-27T20:00:00.000Z)
- Deciding rules: SPEND_LIMIT, ADDRESS_ALLOWLIST, TIME_WINDOW
- Execution attempted: false
- Mock adapter calls for this case: **0**
- Audit record: aud-010

  - **SPEND_LIMIT**: FAIL — Spend limit exceeded: requested 500000000000000000 wei exceeds the policy maximum 100000000000000000 wei.
  - **ADDRESS_ALLOWLIST**: FAIL — Recipient 0x9999999999999999999999999999999999999999 is not on the approved recipient allowlist (2 approved).
  - **TIME_WINDOW**: FAIL — Request local time 20:00 on 2026-10-27 (Tue) in UTC is outside all allowed windows: 09:00-17:00.

### Case F1 — Invalid request — malformed amount (negative with decimals) is denied and never executed

- Request `demo-F1`: **DENY** (policy demo-policy v1.0.0, timestamp 2026-10-27T12:00:00.000Z)
- Deciding rules: SPEND_LIMIT
- Execution attempted: false
- Mock adapter calls for this case: **0**
- Audit record: aud-012

  - **SPEND_LIMIT**: FAIL — Invalid amount: valueWei "-1.5" is not a decimal integer wei string (no sign, no decimals, no exponent).
  - **ADDRESS_ALLOWLIST**: PASS — Recipient 0x1111111111111111111111111111111111111111 is approved for native transfers (sender 0x4444444444444444444444444444444444444444).
  - **TIME_WINDOW**: PASS — Request local time 12:00 on 2026-10-27 (Tue) in UTC is inside allowed window "09:00-17:00" (start inclusive, end exclusive).

### Case F2 — Invalid policy — policy missing the allowlist section fails closed and is never executed

- Request `demo-F2`: **DENY** (policy unknown vunknown, timestamp 2026-10-27T12:00:00.000Z)
- Deciding rules: (policy validation failure — fail-closed)
- Execution attempted: false
- Mock adapter calls for this case: **0**
- Audit record: aud-014

  - POLICY_INVALID: allowlist: missing or malformed — this section is required and the policy will not run without it (fail-closed; no execution attempted)

### Case G — Allowed contract call — target contract is on the contracts allowlist

- Request `demo-G`: **ALLOW** (policy demo-policy v1.0.0, timestamp 2026-10-27T12:00:00.000Z)
- Deciding rules: SPEND_LIMIT, ADDRESS_ALLOWLIST, TIME_WINDOW
- Execution attempted: true
- Mock adapter calls for this case: **1**
- Audit record: aud-016

  - **SPEND_LIMIT**: PASS — Requested 0 wei is within the policy maximum 100000000000000000 wei (inclusive).
  - **ADDRESS_ALLOWLIST**: PASS — Contract 0x3333333333333333333333333333333333333333 is approved for contract interactions (sender 0x4444444444444444444444444444444444444444).
  - **TIME_WINDOW**: PASS — Request local time 12:00 on 2026-10-27 (Tue) in UTC is inside allowed window "09:00-17:00" (start inclusive, end exclusive).

## Totals (actual counts)

| Metric | Value |
|---|---|
| Decisions | 8 |
| Allowed | 2 |
| Denied | 6 |
| Mock adapter calls (total) | 2 |
| Mock adapter calls from denied actions | **0** |
| Audit records (evidence/demo-audit.jsonl) | 40 (8 ALLOW, 24 DENY decisions) |

## Notes

- Mock demo only: the mock adapter holds no wallet and cannot broadcast anything.
- Every denied action produced zero adapter calls.
- Only allowed actions reached the mock adapter.
- Time-window cases use an injected clock (12:00 UTC inside / 20:00 UTC outside the 09:00–17:00 UTC window).

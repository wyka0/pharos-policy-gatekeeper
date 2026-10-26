/**
 * Core types for the Policy Gatekeeper skill.
 *
 * Monetary values are always decimal strings representing wei and are
 * manipulated exclusively as BigInt. Floating point is never used for
 * monetary comparisons.
 */

/** Rule identifiers evaluated by the decision engine. */
export const RULE_IDS = ["SPEND_LIMIT", "ADDRESS_ALLOWLIST", "TIME_WINDOW"] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type Decision = "ALLOW" | "DENY";

export type ExecutionMode = "mock" | "simulation" | "live";

export type RequestKind = "native_transfer" | "contract_call";

export interface SpendLimitPolicy {
  /** Maximum permitted amount per action, in wei, as a decimal integer string. */
  maxAmountWei: string;
}

export interface AllowlistPolicy {
  /** Approved destination addresses for native transfers (0x-prefixed). */
  recipients: string[];
  /** Approved contract addresses for contract interactions (0x-prefixed). */
  contracts: string[];
}

export interface TimeWindow {
  /** Local start time "HH:mm" in the policy timezone. Start boundary handling is defined by the policy `boundary` settings. */
  start: string;
  /** Local end time "HH:mm" in the policy timezone. "24:00" is allowed for `end` only and means end of day. */
  end: string;
  /** Timezone-local days on which this window applies. 0 = Sunday ... 6 = Saturday. Omit for every day. */
  daysOfWeek?: number[];
}

export interface TimeWindowPolicy {
  /** IANA timezone name used to interpret window times, e.g. "UTC" or "America/New_York". */
  timezone: string;
  windows: TimeWindow[];
  /**
   * Boundary behavior at window edges. Defaults: start inclusive, end exclusive.
   * A request exactly at `start` is inside when startInclusive is true.
   * A request exactly at `end` is inside only when endInclusive is true.
   */
  boundary?: {
    startInclusive?: boolean;
    endInclusive?: boolean;
  };
}

/** A validated policy configuration. Create only through `validatePolicy`. */
export interface Policy {
  policyId: string;
  version: string;
  spendLimit: SpendLimitPolicy;
  allowlist: AllowlistPolicy;
  timeWindow: TimeWindowPolicy;
}

/** A request submitted for policy evaluation. */
export interface PolicyRequest {
  /** Caller-supplied identifier for the action being evaluated. */
  requestId: string;
  kind: RequestKind;
  /** Sender / originating address (0x-prefixed). */
  from: string;
  /** Recipient for native transfers, or target contract for contract calls (0x-prefixed). */
  to: string;
  /** Amount in wei as a decimal integer string. "0" is valid (e.g. contract calls without value). */
  valueWei: string;
  /** Optional calldata. Recorded for audit; the allowlist check uses `to`. */
  data?: string;
  note?: string;
}

/** Result of evaluating one rule. A specific, human-readable reason is always present. */
export interface RuleResult {
  ruleId: RuleId;
  passed: boolean;
  reason: string;
}

/** Typed decision returned for every evaluated request. */
export interface PolicyDecision {
  decisionId: string;
  requestId: string;
  decision: Decision;
  /** ISO 8601 UTC timestamp of the decision. */
  timestamp: string;
  policyId: string;
  policyVersion: string;
  /** Every applicable rule that was evaluated and its result. */
  ruleResults: RuleResult[];
  /**
   * Rules that determined the decision: the failed rules for DENY,
   * or all evaluated rules for ALLOW (they jointly permitted it).
   */
  decidingRuleIds: RuleId[];
  /** Specific human-readable failure reasons. Empty for ALLOW. */
  reasons: string[];
  executionAttempted: boolean;
  /** Audit log record ID for this decision, set once the record is written. */
  auditRecordId: string | null;
  mode: ExecutionMode;
}

export interface ExecutionOutcome {
  status: "executed" | "failed";
  detail: string;
  /** Present only when an actual transaction hash was returned by a submission. */
  transactionHash?: string;
}

export type AuditRecordKind = "policy_decision" | "execution_result";

/** One append-only audit record (JSON Lines). Contains no secrets. */
export interface AuditRecord {
  auditId: string;
  timestamp: string;
  kind: AuditRecordKind;
  requestId: string;
  policyId: string;
  policyVersion: string;
  mode: ExecutionMode;
  /** Present on policy_decision records. */
  decision?: Decision;
  decisionId?: string;
  ruleOutcomes?: RuleResult[];
  decidingRuleIds?: string[];
  reasons?: string[];
  executionAttempted?: boolean;
  /** Present on execution_result records. */
  execution?: ExecutionOutcome;
  /** Present only when a transaction hash was actually returned on-chain. */
  transactionHash?: string;
  /** Sanitized error code (e.g. POLICY_INVALID, AUDIT_WRITE_FAILED). No secrets. */
  errorCode?: string;
}

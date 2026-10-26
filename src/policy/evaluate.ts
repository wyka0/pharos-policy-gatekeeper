/**
 * Policy decision engine.
 *
 * Every applicable rule is evaluated on every request so a reviewer can
 * inspect all failures. If any mandatory rule fails, the overall decision is
 * DENY. A DENY always carries the failed rule IDs and specific reasons.
 */
import { getAddress } from "viem";
import { randomUUID } from "node:crypto";
import type {
  Decision,
  ExecutionMode,
  Policy,
  PolicyDecision,
  PolicyRequest,
  RuleId,
  RuleResult
} from "../types.js";
import { RULE_IDS } from "../types.js";
import { parseTimeToMinutes, WEI_PATTERN } from "./validate-policy.js";

export interface EvaluateOptions {
  /** Injectable clock for deterministic time-window evaluation (defaults to wall clock). */
  clock?: () => Date;
  /** Injectable decision ID factory (defaults to `dec-<uuid>`). */
  decisionIdFactory?: () => string;
  mode?: ExecutionMode;
}

const WEEKDAY_BY_LABEL: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

interface ZonedParts {
  minutesOfDay: number;
  weekday: number;
  localTimeLabel: string;
  localDateLabel: string;
}

/** Renders a Date's components in a specific IANA timezone using Intl (full-ICU in Node 13+). */
export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  const parts = new Map<string, string>();
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") parts.set(part.type, part.value);
  }
  const hour = Number(parts.get("hour"));
  const minute = Number(parts.get("minute"));
  const weekdayLabel = parts.get("weekday") ?? "";
  const weekday = WEEKDAY_BY_LABEL[weekdayLabel] ?? -1;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    minutesOfDay: hour * 60 + minute,
    weekday,
    localTimeLabel: `${pad(hour)}:${pad(minute)}`,
    localDateLabel: `${parts.get("year") ?? "????"}-${parts.get("month") ?? "??"}-${parts.get("day") ?? "??"} (${weekdayLabel})`
  };
}


function withinWindow(
  minutes: number,
  window: { start: string; end: string },
  boundary: { startInclusive: boolean; endInclusive: boolean }
): boolean {
  const start = parseTimeToMinutes(window.start, "window.start", false);
  const end = parseTimeToMinutes(window.end, "window.end", true);
  const startOk = boundary.startInclusive ? minutes >= start : minutes > start;
  const endOk = boundary.endInclusive ? minutes <= end : minutes < end;
  if (start <= end) {
    return startOk && endOk;
  }
  // Overnight window (e.g. 22:00-06:00): allowed if in the late part or early part.
  return startOk || endOk;
}

/** Validates request-level syntax. Returns per-rule failures for malformed requests. */
function evaluateSpendLimit(request: PolicyRequest, policy: Policy): RuleResult {
  const ruleId: RuleId = "SPEND_LIMIT";
  if (typeof request.valueWei !== "string" || !WEI_PATTERN.test(request.valueWei)) {
    return {
      ruleId,
      passed: false,
      reason: `Invalid amount: valueWei ${JSON.stringify(request.valueWei)} is not a decimal integer wei string (no sign, no decimals, no exponent).`
    };
  }
  const amount = BigInt(request.valueWei);
  const max = BigInt(policy.spendLimit.maxAmountWei);
  if (amount > max) {
    return {
      ruleId,
      passed: false,
      reason: `Spend limit exceeded: requested ${amount.toString()} wei exceeds the policy maximum ${max.toString()} wei.`
    };
  }
  return {
    ruleId,
    passed: true,
    reason: `Requested ${amount.toString()} wei is within the policy maximum ${max.toString()} wei (inclusive).`
  };
}

function evaluateAllowlist(request: PolicyRequest, policy: Policy): RuleResult {
  const ruleId: RuleId = "ADDRESS_ALLOWLIST";
  let from: string;
  try {
    if (typeof request.from !== "string") throw new Error("not a string");
    from = getAddress(request.from);
  } catch {
    return {
      ruleId,
      passed: false,
      reason: `Sender address ${JSON.stringify(request.from)} is not a valid EVM address.`
    };
  }
  let to: string;
  try {
    if (typeof request.to !== "string") throw new Error("not a string");
    to = getAddress(request.to);
  } catch {
    return {
      ruleId,
      passed: false,
      reason: `Destination address ${JSON.stringify(request.to)} is not a valid EVM address.`
    };
  }
  if (request.kind === "native_transfer") {
    const approved = policy.allowlist.recipients.some((addr) => getAddress(addr) === to);
    if (!approved) {
      return {
        ruleId,
        passed: false,
        reason: `Recipient ${to} is not on the approved recipient allowlist (${policy.allowlist.recipients.length} approved).`
      };
    }
    return { ruleId, passed: true, reason: `Recipient ${to} is approved for native transfers (sender ${from}).` };
  }
  const approved = policy.allowlist.contracts.some((addr) => getAddress(addr) === to);
  if (!approved) {
    return {
      ruleId,
      passed: false,
      reason: `Contract ${to} is not on the approved contract allowlist (${policy.allowlist.contracts.length} approved).`
    };
  }
  return { ruleId, passed: true, reason: `Contract ${to} is approved for contract interactions (sender ${from}).` };
}

function evaluateTimeWindow(request: PolicyRequest, policy: Policy, now: Date): RuleResult {
  const ruleId: RuleId = "TIME_WINDOW";
  const boundary = {
    startInclusive: policy.timeWindow.boundary?.startInclusive ?? true,
    endInclusive: policy.timeWindow.boundary?.endInclusive ?? false
  };
  const parts = getZonedParts(now, policy.timeWindow.timezone);
  const windowDescriptions = policy.timeWindow.windows
    .map((w) => `${w.start}-${w.end}${w.daysOfWeek ? ` (days: ${w.daysOfWeek.join(",")})` : ""}`)
    .join("; ");
  for (const [index, window] of policy.timeWindow.windows.entries()) {
    if (window.daysOfWeek && !window.daysOfWeek.includes(parts.weekday)) {
      continue;
    }
    if (withinWindow(parts.minutesOfDay, window, boundary)) {
      return {
        ruleId,
        passed: true,
        reason: `Request local time ${parts.localTimeLabel} on ${parts.localDateLabel} in ${policy.timeWindow.timezone} is inside allowed window "${window.start}-${window.end}" (start ${boundary.startInclusive ? "inclusive" : "exclusive"}, end ${boundary.endInclusive ? "inclusive" : "exclusive"}).`
      };
    }
    void index;
  }
  return {
    ruleId,
    passed: false,
    reason: `Request local time ${parts.localTimeLabel} on ${parts.localDateLabel} in ${policy.timeWindow.timezone} is outside all allowed windows: ${windowDescriptions}.`
  };
}

/** Default decision IDs are random; inject `decisionIdFactory` for deterministic output. */
export function defaultDecisionIdFactory(): string {
  return `dec-${randomUUID()}`;
}

/**
 * Evaluates every applicable policy rule against the request and returns a
 * typed ALLOW/DENY decision. Never throws for request problems - malformed
 * requests produce a typed DENY with specific reasons.
 */
export function evaluateRequest(
  policy: Policy,
  request: PolicyRequest,
  options: EvaluateOptions = {}
): PolicyDecision {
  const clock = options.clock ?? (() => new Date());
  const decisionIdFactory = options.decisionIdFactory ?? defaultDecisionIdFactory;
  const mode: ExecutionMode = options.mode ?? "mock";
  const now = clock();

  const ruleResults: RuleResult[] = [
    evaluateSpendLimit(request, policy),
    evaluateAllowlist(request, policy),
    evaluateTimeWindow(request, policy, now)
  ];

  const failed = ruleResults.filter((r) => !r.passed);
  const decision: Decision = failed.length === 0 ? "ALLOW" : "DENY";
  const decidingRuleIds = decision === "DENY" ? failed.map((r) => r.ruleId) : [...RULE_IDS];
  const reasons = failed.map((r) => r.reason);

  return {
    decisionId: decisionIdFactory(),
    requestId: typeof request.requestId === "string" && request.requestId.trim().length > 0 ? request.requestId : "unknown",
    decision,
    timestamp: now.toISOString(),
    policyId: policy.policyId,
    policyVersion: policy.version,
    ruleResults,
    decidingRuleIds,
    reasons,
    executionAttempted: false,
    auditRecordId: null,
    mode
  };
}

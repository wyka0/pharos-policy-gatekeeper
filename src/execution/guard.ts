/**
 * The single enforced execution boundary.
 *
 * Required sequence for every execution attempt:
 *  1. Validate the policy (fail closed on invalid configuration).
 *  2. Evaluate every applicable policy rule.
 *  3. Record the decision in the audit log (audit-write failure aborts execution).
 *  4. If DENY — stop. No adapter call, no signing, no submission.
 *  5. If ALLOW — return approval to the next guarded step.
 *
 * The live transaction path uses this same boundary (see src/testnet/transfer.ts):
 * after ALLOW it still requires explicit user confirmation and a full
 * revalidation immediately before signing/broadcasting.
 *
 * There is no alternate, unguarded execution path in this codebase.
 */
import { createHash } from "node:crypto";
import type { ExecutionMode, ExecutionOutcome, Policy, PolicyDecision, PolicyRequest, RuleResult } from "../types.js";
import { evaluateRequest, type EvaluateOptions } from "../policy/evaluate.js";
import { PolicyValidationError, validatePolicy } from "../policy/validate-policy.js";
import { newAuditId, type AuditLogger, type AuditWriteError } from "../audit/logger.js";

export interface ExecutionAdapter {
  readonly mode: "mock" | "live";
  execute(request: PolicyRequest, decision: PolicyDecision): Promise<ExecutionOutcome>;
}

export interface GuardedExecution {
  decision: PolicyDecision;
  executionAttempted: boolean;
  /** Present when execution was attempted (ALLOW path). */
  execution?: ExecutionOutcome;
}

export interface PolicyGuardOptions {
  /** Returns the (raw) policy. Called on every evaluation so policy changes are always observed. */
  policyProvider: () => unknown;
  audit: AuditLogger;
  /** "mock" for the demo/mock mode, "simulation" for read-only testnet simulation, "live" for the real transaction path. */
  mode: "mock" | "simulation" | "live";
  clock?: () => Date;
  decisionIdFactory?: () => string;
  /** Injectable audit ID factory (defaults to `aud-<uuid>`). */
  auditIdFactory?: () => string;
}

/** Stable SHA-256 over the canonical form of a request, used to detect parameter drift between approval and signing. */
export function canonicalRequestHash(request: PolicyRequest): string {
  const canonical = JSON.stringify({
    kind: request.kind,
    from: typeof request.from === "string" ? request.from.toLowerCase() : request.from,
    to: typeof request.to === "string" ? request.to.toLowerCase() : request.to,
    valueWei: request.valueWei,
    data: request.data ?? ""
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function safeRequestId(request: unknown): string {
  const id = (request as { requestId?: unknown } | null | undefined)?.requestId;
  return typeof id === "string" && id.trim().length > 0 ? id : "unknown";
}

export class PolicyGuard {
  private readonly policyProvider: () => unknown;
  readonly audit: AuditLogger;
  readonly mode: ExecutionMode;
  private readonly evaluateOptions: EvaluateOptions;
  private readonly auditIdFactory: () => string;

  constructor(options: PolicyGuardOptions) {
    this.policyProvider = options.policyProvider;
    this.audit = options.audit;
    this.mode = options.mode;
    this.auditIdFactory = options.auditIdFactory ?? newAuditId;
    this.evaluateOptions = {
      clock: options.clock,
      decisionIdFactory: options.decisionIdFactory,
      mode: this.mode
    };
  }

  /**
   * Steps 1–3: validate policy, evaluate all rules, audit the decision.
   * Never throws for policy/request problems — those become fail-closed DENY
   * decisions (which are themselves audited). Throws only if the audit write
   * fails, which by contract must prevent execution (fail closed).
   */
  async evaluateAndRecord(request: PolicyRequest): Promise<{ decision: PolicyDecision; auditId: string }> {
    const auditId = this.auditIdFactory();
    let decision: PolicyDecision;
    try {
      const policy: Policy = validatePolicy(this.policyProvider());
      decision = evaluateRequest(policy, request, this.evaluateOptions);
    } catch (err) {
      const issues = err instanceof PolicyValidationError ? err.issues : [`${(err as Error).name}: ${(err as Error).message}`];
      decision = {
        decisionId: this.evaluateOptions.decisionIdFactory?.() ?? `dec-${crypto.randomUUID()}`,
        requestId: safeRequestId(request),
        decision: "DENY",
        timestamp: (this.evaluateOptions.clock ?? (() => new Date))().toISOString(),
        policyId: "unknown",
        policyVersion: "unknown",
        ruleResults: [],
        decidingRuleIds: [],
        reasons: issues.map((issue) => `POLICY_INVALID: ${issue} (fail-closed; no execution attempted)`),
        executionAttempted: false,
        auditRecordId: auditId,
        mode: this.mode
      };
    }

    const record = {
      auditId,
      timestamp: decision.timestamp,
      kind: "policy_decision" as const,
      requestId: decision.requestId,
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      mode: decision.mode,
      decision: decision.decision,
      decisionId: decision.decisionId,
      ruleOutcomes: decision.ruleResults,
      decidingRuleIds: decision.decidingRuleIds,
      reasons: decision.reasons,
      executionAttempted: false
    };
    await this.audit.append(record);
    decision.auditRecordId = auditId;
    return { decision, auditId };
  }

  /**
   * Full guarded execution for the mock boundary: evaluate → audit → execute
   * only when allowed. The handler is never invoked on DENY or on audit failure.
   */
  async executeGuarded(request: PolicyRequest, adapter: ExecutionAdapter): Promise<GuardedExecution> {
    const { decision } = await this.evaluateAndRecord(request);
    if (decision.decision === "DENY") {
      return { decision, executionAttempted: false };
    }
    decision.executionAttempted = true;
    let execution: ExecutionOutcome;
    try {
      execution = await adapter.execute(request, decision);
    } catch (err) {
      execution = {
        status: "failed",
        detail: `Execution failed: ${sanitize((err as Error).message)}`
      };
    }
    await this.audit.append({
      auditId: this.auditIdFactory(),
      timestamp: (this.evaluateOptions.clock ?? (() => new Date))().toISOString(),
      kind: "execution_result",
      requestId: decision.requestId,
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      mode: decision.mode,
      decisionId: decision.decisionId,
      execution,
      executionAttempted: true,
      transactionHash: execution.transactionHash
    });
    return { decision, executionAttempted: true, execution };
  }

  /**
   * Live-mode revalidation, executed immediately before signing/broadcasting.
   * Re-reads the policy (fresh evaluation) and verifies the transaction
   * parameters are byte-for-byte the ones that were approved.
   * Returns a fresh audited decision when policy re-evaluation runs;
   * returns a blocking reason when the request hash drifted.
   */
  async revalidateForSigning(
    request: PolicyRequest,
    approvedRequestHash: string
  ): Promise<
    | { ok: true; decision: PolicyDecision; auditId: string }
    | { ok: false; reason: string; decision?: PolicyDecision }
  > {
    if (canonicalRequestHash(request) !== approvedRequestHash) {
      const { decision } = await this.evaluateAndRecord(request);
      return {
        ok: false,
        reason:
          "Revalidation blocked: transaction parameters changed after policy approval. The approval applies only to the exact parameters shown to the user.",
        decision
      };
    }
    const { decision, auditId } = await this.evaluateAndRecord(request);
    if (decision.decision === "DENY") {
      return { ok: false, reason: "Revalidation blocked: policy no longer allows this transaction.", decision };
    }
    return { ok: true, decision, auditId };
  }
}

/** Strips anything that could resemble a secret from messages destined for logs/evidence. */
export function sanitize(message: string): string {
  return message.replace(/0x[0-9a-fA-F]{64}/g, "[redacted-64-hex]");
}

export type { AuditWriteError, RuleResult };

/**
 * Mock execution adapter — fully deterministic, no blockchain interaction.
 *
 * It is isolated from the live transaction adapter: it holds no wallet, no
 * RPC connection, and cannot broadcast anything. Only actions that received
 * an ALLOW decision through the PolicyGuard may reach it.
 */
import type { ExecutionAdapter } from "./guard.js";
import type { ExecutionOutcome, PolicyDecision, PolicyRequest } from "../types.js";

export interface MockAdapterCall {
  request: PolicyRequest;
  decisionId: string;
  seq: number;
}

export class MockTransferAdapter implements ExecutionAdapter {
  readonly mode = "mock" as const;
  readonly calls: MockAdapterCall[] = [];
  private seq = 0;

  /** Number of times this adapter was invoked. */
  get callCount(): number {
    return this.calls.length;
  }

  /** Number of invocations for a specific request ID. */
  callCountFor(requestId: string): number {
    return this.calls.filter((c) => c.request.requestId === requestId).length;
  }

  async execute(request: PolicyRequest, decision: PolicyDecision): Promise<ExecutionOutcome> {
    this.seq += 1;
    this.calls.push({ request: structuredClone(request), decisionId: decision.decisionId, seq: this.seq });
    return {
      status: "executed",
      detail: `Mock transfer of ${request.valueWei} wei to ${request.to} executed deterministically (no blockchain interaction).`
    };
  }
}

/** Adapter that always throws — used to prove the guard reports execution failures honestly. */
export class FailingMockAdapter implements ExecutionAdapter {
  readonly mode = "mock" as const;
  readonly calls: MockAdapterCall[] = [];

  constructor(private readonly message = "simulated execution failure") {}

  async execute(request: PolicyRequest, decision: PolicyDecision): Promise<ExecutionOutcome> {
    this.calls.push({ request: structuredClone(request), decisionId: decision.decisionId, seq: this.calls.length + 1 });
    throw new Error(this.message);
  }
}

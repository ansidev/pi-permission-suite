/**
 * Pi Permission Suite — Auto Approver
 *
 * `subagentProvider` is the default Decision provider (runs the `approver`
 * agent in a subprocess). `autoApprove` resolves a decision through the
 * configured provider and falls back to asking the user on any uncertainty.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSubprocess, loadAgent } from "./subprocess-runner.ts";
import type { ApprovalDecision } from "./types.ts";
import {
  getDecisionProvider,
  resolveDecision,
  type DecisionConfig,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
} from "./decision-provider.ts";

const AGENT_NAME = "approver";

// ─── Format tool call ────────────────────────────────────────────────

function formatCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") return `$ ${input.command}`;
  if (["read", "write", "edit"].includes(toolName)) return `${toolName}: ${input.path}`;
  return JSON.stringify(input);
}

// ─── Parse response ──────────────────────────────────────────────────────

export function parseResponse(text: string): { approved: boolean; reason: string; confidence: number } {
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) {
      const p = JSON.parse(m[0]);
      return {
        approved: Boolean(p.approved),
        reason: String(p.reason ?? ""),
        confidence: Math.min(1, Math.max(0, Number(p.confidence ?? 0.5))),
      };
    }
  } catch {
    // JSON parsing failure is expected behavior — return default reject decision
  }
  return { approved: false, reason: "Cannot parse", confidence: 0 };
}

// ─── Default provider: subagent ──────────────────────────────────────────

export const subagentProvider: DecisionProvider = {
  name: "subagent",
  async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResponse> {
    const agent = loadAgent(AGENT_NAME);
    if (!agent) {
      throw new Error(`Agent "${AGENT_NAME}" not found, please create ~/.pi/agent/agents/approver.md`);
    }
    const r = await runSubprocess(
      `Evaluate:\nTool: ${request.toolName}\nParameters: ${formatCall(request.toolName, request.input)}`,
      { model: agent.model, systemPrompt: agent.systemPrompt, timeout: 60_000, signal },
    );
    if (!r.success) throw new Error(r.error ?? "Call failed");
    const d = parseResponse(r.output);
    return { verdict: d.approved ? "allow" : "deny", confidence: d.confidence, reason: d.reason };
  },
};

// ─── Escalate to human ────────────────────────────────────────────────────

async function escalate(ctx: ExtensionContext, toolName: string, input: Record<string, unknown>, reason: string): Promise<ApprovalDecision> {
  if (!ctx.hasUI) return { approved: false, source: "human", reason: "No UI" };
  const fmt = formatCall(toolName, input);
  const c = await ctx.ui.select(`🤖 Approval uncertain\n\n${fmt}\n${reason}`, ["✅ Approve", "❌ Reject"]);
  return { approved: c?.includes("Approve") ?? false, source: "human" };
}

/**
 * Decide an "ask" case in Auto mode. Static deny rules must be handled by the
 * caller beforehand; `resolveDecision` also short-circuits on ruleResult=deny.
 * Any provider failure / low confidence / "ask" verdict goes to the user.
 */
export async function autoApprove(
  ctx: ExtensionContext,
  request: DecisionRequest,
  config: DecisionConfig,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  const { toolName, input } = request;
  const provider = getDecisionProvider(config.provider);
  const res = await resolveDecision(provider, request, config, signal);

  if (res.verdict === "allow") return { approved: true, source: "subagent", reason: res.reason };
  if (res.verdict === "deny") return { approved: false, source: "subagent", reason: res.reason };
  return escalate(ctx, toolName, input, res.reason);
}

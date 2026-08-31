/**
 * Pi Permission Suite — Auto Approver
 *
 * Self-contained auto-approval, no external subagent extension dependency
 * Low confidence escalates to human
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSubprocess, loadAgent } from "./subprocess-runner.ts";
import type { ApprovalDecision } from "./types.ts";

const AGENT_NAME = "approver";
const CONFIDENCE_THRESHOLD = 0.7;

// ─── Format tool call ────────────────────────────────────────────────

function formatCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") return `$ ${input.command}`;
  if (["read", "write", "edit"].includes(toolName)) return `${toolName}: ${input.path}`;
  return JSON.stringify(input);
}

// ─── Parse response ──────────────────────────────────────────────────────

function parseResponse(text: string): { approved: boolean; reason: string; confidence: number } {
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

// ─── Escalate to human ────────────────────────────────────────────────────

async function escalate(ctx: ExtensionContext, toolName: string, input: Record<string, unknown>, reason: string): Promise<ApprovalDecision> {
  if (!ctx.hasUI) return { approved: false, source: "human", reason: "No UI" };
  const fmt = formatCall(toolName, input);
  const c = await ctx.ui.select(`🤖 Approval uncertain\n\n${fmt}\n${reason}`, ["✅ Approve", "❌ Reject"]);
  return { approved: c?.includes("Approve") ?? false, source: "human" };
}

export async function autoApprove(ctx: ExtensionContext, toolName: string, input: Record<string, unknown>): Promise<ApprovalDecision> {
  // Load approver agent configuration
  const agent = loadAgent(AGENT_NAME);
  if (!agent) {
    return escalate(ctx, toolName, input, `Agent "${AGENT_NAME}" not found, please create ~/.pi/agent/agents/approver.md`);
  }

  const r = await runSubprocess(
    `Evaluate:\nTool: ${toolName}\nParameters: ${formatCall(toolName, input)}`,
    {
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      timeout: 10000,
    },
  );

  if (!r.success) return escalate(ctx, toolName, input, r.error ?? "Call failed");

  const decision = parseResponse(r.output);
  return decision.confidence >= CONFIDENCE_THRESHOLD
    ? { approved: decision.approved, source: "subagent", reason: decision.reason }
    : escalate(ctx, toolName, input, decision.reason);
}

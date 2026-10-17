/**
 * Pi Permission Suite Extension
 *
 * Modes: Act / Auto / Ask / Plan
 * Shortcut: Ctrl+Q
 * Command: /approval-mode
 * Tool: set_approval_mode (callable by agent)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalMode, ApprovalState } from "./types.ts";
import { RuleEngine } from "./rules.ts";
import { autoApprove, subagentProvider } from "./approver.ts";
import { registerDecisionProvider, type DecisionRequest } from "./decision-provider.ts";
import { Type } from "typebox";
import { registerJevProvider } from "./jev-provider.ts";
import { createHttpDecisionProviderFromDecision } from "./http-decision-provider.ts";
import { buildAuditEntry, parseAuditConfig, writeAuditEntry } from "./decision-audit.ts";

// ─── Mode configuration ──────────────────────────────────────────────

const RO = ["read", "grep", "find", "ls", "question", "questionnaire", "web_search", "fetch_content", "get_search_content", "get_subagent_result", "goal_complete", "steer_subagent", "Agent"];
const ALL = [...RO, "bash", "edit", "write"];

const MODE: Record<ApprovalMode, { tools: string[]; desc: string; icon: string }> = {
  ask: { tools: RO, desc: "Read-only Q&A", icon: "❓" },
  auto: { tools: ALL, desc: "Subagent approval", icon: "🤖" },
  act: { tools: ALL, desc: "Full permission", icon: "⚡" },
  plan: { tools: RO, desc: "Read-only plan", icon: "📋" },
};

const ORDER: ApprovalMode[] = ["act", "auto", "ask", "plan"];

// ─── Shared state ──────────────────────────────────────────────────────

interface SuiteState {
  mode: ApprovalMode;
  stats: { approved: number; denied: number; escalated: number };
  rules: RuleEngine;
  /** Print Decision API call/response messages (off by default, not persisted) */
  debug: boolean;
}

function createState(): SuiteState {
  return { mode: "act", stats: { approved: 0, denied: 0, escalated: 0 }, rules: new RuleEngine(), debug: false };
}

function cfg(m: ApprovalMode) { return MODE[m]; }

function apply(state: SuiteState, m: ApprovalMode, pi: ExtensionAPI) {
  state.mode = m;
  pi.appendEntry("pi-permission-suite-state", { mode: m, ...state.stats } satisfies ApprovalState);
}

function updateStatus(state: SuiteState, ctx: ExtensionContext) {
  ctx.ui.setStatus("pi-permission-suite", ctx.ui.theme.fg("accent", `${cfg(state.mode).icon} ${state.mode.toUpperCase()}`));
}

// ─── Register commands ──────────────────────────────────────────────────────

function registerApprovalModeCommand(pi: ExtensionAPI, state: SuiteState): void {
  pi.registerCommand("approval-mode", {
    description: "Switch approval mode (ask/auto/act/plan)",
    getArgumentCompletions: (p) => {
      const out: Array<{ value: string; label: string }> = [];
      for (const m of ORDER) {
        if (m.startsWith(p)) out.push({ value: m, label: `${cfg(m).icon} ${m}` });
      }
      return out;
    },
    handler: async (args, ctx) => {
      const t = args?.trim().toLowerCase() as ApprovalMode | undefined;
      if (t && MODE[t]) apply(state, t, pi);
      else {
        const labels = ORDER.map((m) => `${cfg(m).icon} ${m.toUpperCase()} — ${cfg(m).desc}`);
        const ch = await ctx.ui.select("Mode:", labels);
        if (ch) {
          const idx = labels.indexOf(ch);
          if (idx !== -1) apply(state, ORDER[idx], pi);
        } else return;
      }
      ctx.ui.notify(`${cfg(state.mode).icon} ${state.mode.toUpperCase()}`, "info");
      updateStatus(state, ctx);
    },
  });
}

function registerSuiteCommand(pi: ExtensionAPI, state: SuiteState): void {
  pi.registerCommand("pi-permission-suite", {
    description: "Pi Permission Suite: debug on|off",
    getArgumentCompletions: (p) => {
      const parts = p.trimStart().split(/\s+/);
      if (parts.length <= 1) return "debug".startsWith(parts[0] ?? "") ? [{ value: "debug", label: "debug" }] : [];
      if (parts[0] !== "debug" || parts.length > 2) return [];
      return ["on", "off"].filter((v) => v.startsWith(parts[1])).map((v) => ({ value: `debug ${v}`, label: v }));
    },
    handler: async (args, ctx) => {
      const [sub, val] = (args ?? "").trim().toLowerCase().split(/\s+/);
      if (sub === "debug" && (val === "on" || val === "off")) {
        state.debug = val === "on";
        ctx.ui.notify(`pi-permission-suite debug ${val}`, "info");
      } else {
        ctx.ui.notify(`Usage: /pi-permission-suite debug on|off (currently ${state.debug ? "on" : "off"})`, "warning");
      }
    },
  });
}

// ─── Register tools ──────────────────────────────────────────────────────

function registerApprovalModeTool(pi: ExtensionAPI, state: SuiteState): void {
  pi.registerTool({
    name: "set_approval_mode",
    label: "Set Approval Mode",
    description: `Switch approval mode.

Available modes:
• act - Full permission (default)
• auto - subagent approval
• ask - Read-only Q&A
• plan - Read-only plan`,
    parameters: Type.Object({
      mode: Type.Union([
        Type.Literal("act"),
        Type.Literal("auto"),
        Type.Literal("ask"),
        Type.Literal("plan"),
      ], { description: "Target mode to switch to" }),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const m = params.mode as ApprovalMode;
      const prev = state.mode;
      apply(state, m, pi);
      ctx.ui.notify(`${cfg(m).icon} ${m.toUpperCase()} — ${cfg(m).desc}`, "info");
      updateStatus(state, ctx);
      return {
        content: [{ type: "text" as const, text: `Switched from ${prev} to ${m} mode. ${cfg(m).desc}` }],
      };
    },
  });
}

// ─── Register shortcut ────────────────────────────────────────────────────

function registerApprovalShortcut(pi: ExtensionAPI, state: SuiteState): void {
  pi.registerShortcut("ctrl+q", {
    description: "Cycle through approval modes",
    handler: (ctx) => {
      const next = ORDER[(ORDER.indexOf(state.mode) + 1) % ORDER.length];
      apply(state, next, pi);
      ctx.ui.notify(`${cfg(next).icon} ${next.toUpperCase()}`, "info");
      updateStatus(state, ctx);
    },
  });
}

// ─── tool_call handling ────────────────────────────────────────────────

async function handleToolCall(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  state: SuiteState,
): Promise<{ block: true; reason: string } | undefined> {
  const toolName = event.toolName;
  const inp = event.input as Record<string, unknown>;

  // 1. Deny rules (all modes) — bash parsed asynchronously with tree-sitter
  const result = toolName === "bash"
    ? await state.rules.evaluateAsync(toolName, inp)
    : state.rules.evaluate(toolName, inp);

  if (result === "deny") {
    const msg = state.rules.getDenyMessage(toolName, inp) ?? "Blocked by security rules";
    state.stats.denied++;
    ctx.ui.notify(msg, "error");
    return { block: true, reason: msg };
  }

  // 2. Act: allow all
  if (state.mode === "act") { state.stats.approved++; return undefined; }

  // 3. Ask/Plan: read-only (reuse ALLOW rules, bash read-only commands also allowed)
  if (state.mode === "ask" || state.mode === "plan") {
    if (result === "allow") {
      state.stats.approved++;
      return undefined;
    }
    state.stats.denied++;
    return { block: true, reason: `${cfg(state.mode).icon} ${state.mode.toUpperCase()}: ${toolName} disabled` };
  }

  // 4. Auto: allow passes through, rest goes to subagent
  if (state.mode === "auto") {
    if (result === "allow") { state.stats.approved++; return undefined; }

    ctx.ui.setStatus("pi-permission-suite", ctx.ui.theme.fg("warning", "🤖 Approving..."));
    const request: DecisionRequest = {
      toolName,
      input: inp,
      mode: state.mode,
      paths: state.rules.getCallPaths(toolName, inp),
      cwd: ctx.cwd,
      ruleResult: result,
    };
    const audit = parseAuditConfig((state.rules.getRawDecisionConfig() as { audit?: unknown } | undefined)?.audit);
    const decision = await autoApprove(ctx, request, state.rules.getDecisionConfig(), ctx.signal, (res, out) =>
      writeAuditEntry(buildAuditEntry(request, res, out.approved, out.source === "human"), audit),
      state.debug ? (m) => ctx.ui.notify(m, "info") : undefined);

    if (decision.approved) {
      state.stats.approved++;
      if (decision.source === "human") state.stats.escalated++;
    } else {
      state.stats.denied++;
    }
    updateStatus(state, ctx);

    return decision.approved
      ? undefined
      : { block: true, reason: `Auto rejected (${decision.source}): ${decision.reason}` };
  }

  return undefined;
}

// ─── before_agent_start handling ───────────────────────────────────────

function handleBeforeAgentStart(state: SuiteState) {
  return {
    message: {
      customType: "pi-permission-suite-context",
      content: `[Approval: ${cfg(state.mode).icon} ${state.mode.toUpperCase()}] ${cfg(state.mode).desc}`,
      display: false,
    },
  };
}

// ─── session_start handling ────────────────────────────────────────────

function handleSessionStart(
  ctx: ExtensionContext,
  state: SuiteState,
): void {
  const e = ctx.sessionManager.getEntries()
    .filter((x: unknown): x is { customType: string } =>
      typeof x === "object" && x !== null && "customType" in x &&
      (x as Record<string, unknown>).customType === "pi-permission-suite-state"
    )
    .pop() as { data?: ApprovalState } | undefined;

  if (e?.data) {
    state.mode = e.data.mode ?? "act";
    state.stats.approved = e.data.approved ?? 0;
    state.stats.denied = e.data.denied ?? 0;
    state.stats.escalated = e.data.escalated ?? 0;
  }

  state.rules.setCwd(ctx.cwd);
  updateStatus(state, ctx);
}

// ─── Extension entry ──────────────────────────────────────────────────────

export default function(pi: ExtensionAPI): void {
  const state = createState();
  registerJevProvider();
  registerDecisionProvider(subagentProvider);
  const http = createHttpDecisionProviderFromDecision(state.rules.getRawDecisionConfig());
  if (http) registerDecisionProvider(http);

  registerApprovalModeCommand(pi, state);
  registerSuiteCommand(pi, state);
  registerApprovalModeTool(pi, state);
  registerApprovalShortcut(pi, state);

  pi.on("tool_call", (event, ctx) => handleToolCall(event, ctx, state));
  pi.on("before_agent_start", () => handleBeforeAgentStart(state));
  pi.on("session_start", (_event, ctx) => handleSessionStart(ctx, state));
}

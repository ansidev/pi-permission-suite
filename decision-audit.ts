/**
 * Pi Permission Suite — Decision provider audit log
 *
 * Appends one JSON line per provider decision (JSONL). Never throws: a failed
 * write must not affect the tool-call flow. Never logs API keys or full tool
 * input — only a truncated one-line call summary.
 *
 * Config (`decision.audit` in config.json), all optional:
 *   { "enabled": true, "path": "~/.pi/agent/extensions/pi-permission-suite/decision-audit.jsonl" }
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { DecisionRequest, ResolvedDecision } from "./decision-provider.ts";

export interface AuditConfig {
  enabled: boolean;
  path: string;
}

export interface AuditEntry {
  time: string;
  tool: string;
  mode: string;
  call: string;
  provider: string;
  verdict: string;
  confidence: number;
  reason: string;
  fallback: boolean;
  /** final outcome after any human escalation */
  outcome: "approved" | "denied";
  decidedBy: "provider" | "human" | "rules";
}

export const MAX_SUMMARY_CHARS = 200;

export function defaultAuditPath(): string {
  return `${homedir()}/.pi/agent/extensions/pi-permission-suite/decision-audit.jsonl`;
}

/** Validate raw `decision.audit`; invalid fields fall back to defaults. Never throws. */
export function parseAuditConfig(raw: unknown): AuditConfig {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const path = typeof r.path === "string" && r.path.trim() ? r.path.trim() : defaultAuditPath();
  return {
    enabled: r.enabled !== false,
    path: path.startsWith("~/") ? homedir() + path.slice(1) : path,
  };
}

/** One-line, truncated description of the call (no full input). */
export function summarizeCall(toolName: string, input: Record<string, unknown>): string {
  let s: string;
  if (toolName === "bash") s = String(input?.command ?? "");
  else if (typeof input?.path === "string") s = `${toolName}: ${input.path}`;
  else s = `${toolName}: ${Object.keys(input ?? {}).join(",")}`;
  s = s.replace(/\s+/g, " ").trim();
  return s.length > MAX_SUMMARY_CHARS ? `${s.slice(0, MAX_SUMMARY_CHARS)}…` : s;
}

export function buildAuditEntry(
  request: DecisionRequest,
  res: ResolvedDecision,
  approved: boolean,
  humanDecided: boolean,
  now: Date = new Date(),
): AuditEntry {
  return {
    time: now.toISOString(),
    tool: request.toolName,
    mode: request.mode,
    call: summarizeCall(request.toolName, request.input),
    provider: res.source,
    verdict: res.verdict,
    confidence: res.confidence,
    reason: res.reason.slice(0, MAX_SUMMARY_CHARS * 2),
    fallback: res.fallback,
    outcome: approved ? "approved" : "denied",
    decidedBy: humanDecided ? "human" : res.source === "rules" ? "rules" : "provider",
  };
}

/** Append an entry. Returns false (never throws) when disabled or the write fails. */
export function writeAuditEntry(entry: AuditEntry, config: AuditConfig): boolean {
  if (!config.enabled) return false;
  try {
    mkdirSync(dirname(config.path), { recursive: true });
    appendFileSync(config.path, JSON.stringify(entry) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

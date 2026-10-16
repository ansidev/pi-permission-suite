import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAuditConfig,
  summarizeCall,
  buildAuditEntry,
  writeAuditEntry,
  MAX_SUMMARY_CHARS,
} from "../decision-audit.ts";
import type { DecisionRequest, ResolvedDecision } from "../decision-provider.ts";
import { autoApprove } from "../approver.ts";
import { registerDecisionProvider, clearDecisionProviders, DEFAULT_DECISION_CONFIG } from "../decision-provider.ts";

const req: DecisionRequest = { toolName: "bash", input: { command: "ls -la" }, mode: "auto", ruleResult: undefined };
const res: ResolvedDecision = { verdict: "allow", confidence: 0.9, reason: "safe", fallback: false, source: "http" };
const tmp = () => join(mkdtempSync(join(tmpdir(), "pps-audit-")), "sub", "audit.jsonl");

test("parseAuditConfig: defaults, disabled, custom path, invalid input", () => {
  expect(parseAuditConfig(undefined).enabled).toBe(true);
  expect(parseAuditConfig(undefined).path).toContain("decision-audit.jsonl");
  expect(parseAuditConfig({ enabled: false }).enabled).toBe(false);
  expect(parseAuditConfig({ path: "/x/y.jsonl" }).path).toBe("/x/y.jsonl");
  expect(parseAuditConfig({ path: 5, enabled: "no" }).enabled).toBe(true);
  expect(parseAuditConfig("junk").path).toContain("decision-audit.jsonl");
});

test("summarizeCall: truncates and never includes full input", () => {
  const long = "echo " + "a".repeat(1000);
  const s = summarizeCall("bash", { command: long });
  expect(s.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 1);
  expect(summarizeCall("write", { path: "/a/b", content: "SECRET" })).toBe("write: /a/b");
  expect(summarizeCall("custom", { token: "SECRET" })).not.toContain("SECRET");
});

test("buildAuditEntry + writeAuditEntry: appends JSON lines, creates dirs", () => {
  const path = tmp();
  const cfg = { enabled: true, path };
  const e = buildAuditEntry(req, res, true, false, new Date("2026-01-01T00:00:00Z"));
  expect(e).toMatchObject({ tool: "bash", provider: "http", verdict: "allow", outcome: "approved", decidedBy: "provider", time: "2026-01-01T00:00:00.000Z" });
  expect(writeAuditEntry(e, cfg)).toBe(true);
  expect(writeAuditEntry(buildAuditEntry(req, { ...res, verdict: "ask", fallback: true }, false, true), cfg)).toBe(true);
  const lines = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatchObject({ decidedBy: "human", outcome: "denied", fallback: true });
});

test("writeAuditEntry: disabled writes nothing; failure does not throw", () => {
  const path = tmp();
  const e = buildAuditEntry(req, res, true, false);
  expect(writeAuditEntry(e, { enabled: false, path })).toBe(false);
  expect(existsSync(path)).toBe(false);
  const file = join(mkdtempSync(join(tmpdir(), "pps-audit-")), "f");
  writeFileSync(file, "x");
  expect(writeAuditEntry(e, { enabled: true, path: join(file, "nested", "a.jsonl") })).toBe(false);
});

test("autoApprove: onDecision called with final outcome; throwing hook is ignored", async () => {
  clearDecisionProviders();
  registerDecisionProvider({ name: "t", decide: async () => ({ verdict: "deny", confidence: 0.95, reason: "bad" }) });
  const calls: unknown[] = [];
  const out = await autoApprove({} as never, req, { ...DEFAULT_DECISION_CONFIG, provider: "t" }, undefined, (r, o) => {
    calls.push([r.verdict, o.approved]);
    throw new Error("boom");
  });
  expect(out.approved).toBe(false);
  expect(calls).toEqual([["deny", false]]);
});

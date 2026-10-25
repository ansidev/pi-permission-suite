import { test, expect, beforeEach } from "bun:test";
import {
  DEFAULT_DECISION_CONFIG,
  parseDecisionConfig,
  usesDecisionProvider,
  registerDecisionProvider,
  getDecisionProvider,
  clearDecisionProviders,
  resolveDecision,
  type DecisionProvider,
  type DecisionRequest,
} from "../decision-provider.ts";

const req: DecisionRequest = { toolName: "bash", input: { command: "ls" }, mode: "auto", ruleResult: undefined };
const cfg = { ...DEFAULT_DECISION_CONFIG, timeoutMs: 50 };
const mk = (decide: DecisionProvider["decide"]): DecisionProvider => ({ name: "t", decide });

beforeEach(() => clearDecisionProviders());

test("parseDecisionConfig: defaults and validation", () => {
  expect(parseDecisionConfig(undefined)).toEqual(DEFAULT_DECISION_CONFIG);
  expect(parseDecisionConfig({ provider: "http", timeoutMs: 500, confidenceThreshold: 0.9 })).toEqual({
    provider: "http", timeoutMs: 500, confidenceThreshold: 0.9, modes: ["auto"], onFailure: "ask",
  });
  expect(parseDecisionConfig({ timeoutMs: -1, confidenceThreshold: 2, provider: "" })).toEqual(DEFAULT_DECISION_CONFIG);
  expect(parseDecisionConfig({ timeoutMs: "5" })).toEqual(DEFAULT_DECISION_CONFIG);
});

test("parseDecisionConfig: modes", () => {
  expect(parseDecisionConfig({ modes: ["act", "auto", "act"] }).modes).toEqual(["act", "auto"]);
  expect(parseDecisionConfig({ modes: ["act"] }).modes).toEqual(["act"]);
  expect(parseDecisionConfig({ modes: ["plan", 1] }).modes).toEqual(["auto"]);
  expect(parseDecisionConfig({ modes: "act" }).modes).toEqual(["auto"]);
  expect(parseDecisionConfig({}).modes).toEqual(["auto"]);
});

test("usesDecisionProvider: auto always, act opt-in, allow rules skip, ask/plan never", () => {
  const optIn = { ...DEFAULT_DECISION_CONFIG, modes: ["act" as const, "auto" as const] };
  expect(usesDecisionProvider("auto", DEFAULT_DECISION_CONFIG, undefined)).toBe(true);
  expect(usesDecisionProvider("act", DEFAULT_DECISION_CONFIG, undefined)).toBe(false);
  expect(usesDecisionProvider("act", optIn, undefined)).toBe(true);
  expect(usesDecisionProvider("act", optIn, "allow")).toBe(false);
  expect(usesDecisionProvider("auto", optIn, "allow")).toBe(false);
  expect(usesDecisionProvider("ask", optIn, undefined)).toBe(false);
  expect(usesDecisionProvider("plan", optIn, undefined)).toBe(false);
});

test("act mode request resolves through the provider like auto", async () => {
  const r = await resolveDecision(
    mk(async () => ({ verdict: "deny", confidence: 0.9, reason: "no" })),
    { ...req, mode: "act" }, cfg,
  );
  expect(r).toMatchObject({ verdict: "deny", fallback: false });
});

test("registry", () => {
  const p = mk(async () => ({ verdict: "allow", confidence: 1, reason: "" }));
  registerDecisionProvider(p);
  expect(getDecisionProvider("t")).toBe(p);
  expect(getDecisionProvider("x")).toBeUndefined();
});

test("confident verdict passes through", async () => {
  const r = await resolveDecision(mk(async () => ({ verdict: "allow", confidence: 0.9, reason: "ok" })), req, cfg);
  expect(r).toMatchObject({ verdict: "allow", confidence: 0.9, fallback: false, source: "t" });
});

test("low confidence -> ask", async () => {
  const r = await resolveDecision(mk(async () => ({ verdict: "allow", confidence: 0.3, reason: "meh" })), req, cfg);
  expect(r.verdict).toBe("ask");
  expect(r.fallback).toBe(true);
});

test("throw -> ask", async () => {
  const r = await resolveDecision(mk(async () => { throw new Error("boom"); }), req, cfg);
  expect(r).toMatchObject({ verdict: "ask", fallback: true });
  expect(r.reason).toContain("boom");
});

test("timeout -> ask and signal aborted", async () => {
  let aborted = false;
  const r = await resolveDecision(
    mk((_r, s) => new Promise(() => { s.addEventListener("abort", () => { aborted = true; }); })),
    req, cfg,
  );
  expect(r).toMatchObject({ verdict: "ask", fallback: true });
  expect(r.reason).toContain("timed out");
  expect(aborted).toBe(true);
});

test("malformed responses -> ask; confidence clamped", async () => {
  for (const bad of [null, "x", { verdict: "maybe", confidence: 1 }, {}]) {
    const r = await resolveDecision(mk(async () => bad as never), req, cfg);
    expect(r.verdict).toBe("ask");
  }
  const r = await resolveDecision(mk(async () => ({ verdict: "deny", confidence: 5, reason: "x" })), req, cfg);
  expect(r).toMatchObject({ verdict: "deny", confidence: 1 });
  const nan = await resolveDecision(mk(async () => ({ verdict: "allow", confidence: NaN, reason: "" })), req, cfg);
  expect(nan.verdict).toBe("ask");
});

test("caller abort -> ask", async () => {
  const ac = new AbortController();
  const p = resolveDecision(mk(() => new Promise(() => {})), req, { ...cfg, timeoutMs: 5000 }, ac.signal);
  ac.abort();
  expect(await p).toMatchObject({ verdict: "ask", reason: "Aborted" });
  expect((await resolveDecision(mk(async () => ({ verdict: "allow", confidence: 1, reason: "" })), req, cfg, ac.signal)).verdict).toBe("ask");
});

test("missing provider -> ask; rule deny short-circuits", async () => {
  expect((await resolveDecision(undefined, req, cfg)).verdict).toBe("ask");
  let called = false;
  const r = await resolveDecision(mk(async () => { called = true; return { verdict: "allow", confidence: 1, reason: "" }; }), { ...req, ruleResult: "deny" }, cfg);
  expect(r).toMatchObject({ verdict: "deny", source: "rules" });
  expect(called).toBe(false);
});

test("parseDecisionConfig: endpoint and apiKeyEnv", () => {
  expect(parseDecisionConfig({ endpoint: " https://x.test ", apiKeyEnv: "K" })).toMatchObject({ endpoint: "https://x.test", apiKeyEnv: "K" });
  expect(parseDecisionConfig({ endpoint: 5, apiKeyEnv: "" }).endpoint).toBeUndefined();
  expect(parseDecisionConfig({ endpoint: 5, apiKeyEnv: "" }).apiKeyEnv).toBeUndefined();
});

test("onDebug reports call and response; silent when omitted", async () => {
  const msgs: string[] = [];
  const p = { name: "dbg", decide: async () => ({ verdict: "allow" as const, confidence: 0.9, reason: "ok" }) };
  const req = { toolName: "bash", input: {}, mode: "auto" as const, ruleResult: undefined };
  await resolveDecision(p, req, undefined, undefined, (m) => msgs.push(m));
  expect(msgs).toHaveLength(2);
  expect(msgs[0]).toContain("call");
  expect(msgs[1]).toContain("verdict=allow");
  await resolveDecision(p, req); // no sink: must not throw
  await resolveDecision(p, { ...req, ruleResult: "deny" }, undefined, undefined, (m) => msgs.push(m));
  expect(msgs).toHaveLength(2); // rules deny never calls the API
});

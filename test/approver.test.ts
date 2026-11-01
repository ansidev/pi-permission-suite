import { test, expect, beforeEach, describe } from "bun:test";
import { autoApprove, registerHerdrEventBus, notifyHerdrBlocked, notifyHerdrBlockedEnd } from "../approver.ts";
import {
  DEFAULT_DECISION_CONFIG,
  clearDecisionProviders,
  registerDecisionProvider,
  type DecisionProvider,
  type DecisionRequest,
} from "../decision-provider.ts";

const cfg = { ...DEFAULT_DECISION_CONFIG, provider: "t", timeoutMs: 50 };
const req = (over: Partial<DecisionRequest> = {}): DecisionRequest =>
  ({ toolName: "bash", input: { command: "make" }, mode: "auto", ruleResult: undefined, ...over });

function fakeCtx(choice: string | undefined, hasUI = true) {
  const calls: string[] = [];
  const ctx = {
    hasUI,
    ui: { select: async (t: string) => { calls.push(t); return choice; } },
  } as never;
  return { ctx, calls };
}

const reg = (decide: DecisionProvider["decide"]) => registerDecisionProvider({ name: "t", decide });

beforeEach(() => clearDecisionProviders());

test("confident allow -> approved, no user prompt", async () => {
  reg(async () => ({ verdict: "allow", confidence: 0.9, reason: "safe" }));
  const { ctx, calls } = fakeCtx(undefined);
  expect(await autoApprove(ctx, req(), cfg)).toMatchObject({ approved: true, source: "subagent" });
  expect(calls).toHaveLength(0);
});

test("confident deny -> rejected, no user prompt", async () => {
  reg(async () => ({ verdict: "deny", confidence: 0.9, reason: "bad" }));
  const { ctx, calls } = fakeCtx(undefined);
  expect(await autoApprove(ctx, req(), cfg)).toMatchObject({ approved: false, reason: "bad" });
  expect(calls).toHaveLength(0);
});

test("error / low confidence / ask / missing provider -> asks the user", async () => {
  const cases: DecisionProvider["decide"][] = [
    async () => { throw new Error("boom"); },
    async () => ({ verdict: "allow", confidence: 0.1, reason: "" }),
    async () => ({ verdict: "ask", confidence: 1, reason: "" }),
    () => new Promise(() => {}),
  ];
  for (const c of cases) {
    reg(c);
    const { ctx, calls } = fakeCtx("✅ Approve");
    expect(await autoApprove(ctx, req(), cfg)).toMatchObject({ approved: true, source: "human" });
    expect(calls).toHaveLength(1);
  }
  clearDecisionProviders();
  const { ctx, calls } = fakeCtx("❌ Reject");
  expect(await autoApprove(ctx, req(), cfg)).toMatchObject({ approved: false, source: "human" });
  expect(calls).toHaveLength(1);
});

test("debug sink logs the escalation", async () => {
  reg(async () => ({ verdict: "ask", confidence: 1, reason: "unsure" }));
  const logs: string[] = [];
  const { ctx } = fakeCtx("✅ Approve");
  await autoApprove(ctx, req(), cfg, undefined, undefined, (m) => logs.push(m));
  expect(logs.some((m) => m.includes("Pausing to ask the user") && m.includes("bash") && m.includes("unsure"))).toBe(true);
});

test("fallback without UI -> rejected, never allowed", async () => {
  reg(async () => { throw new Error("boom"); });
  const { ctx } = fakeCtx(undefined, false);
  expect(await autoApprove(ctx, req(), cfg)).toMatchObject({ approved: false, source: "human", reason: "No UI" });
});

test("rule deny never consults provider", async () => {
  let called = false;
  reg(async () => { called = true; return { verdict: "allow", confidence: 1, reason: "" }; });
  const { ctx } = fakeCtx("✅ Approve");
  expect((await autoApprove(ctx, req({ ruleResult: "deny" }), cfg)).approved).toBe(false);
  expect(called).toBe(false);
});

describe("herdr blocked event", () => {
  test("notifyHerdrBlocked emits herdr:blocked active with label", () => {
    const emitted: Array<[string, unknown]> = [];
    registerHerdrEventBus({ emit: (name, data) => emitted.push([name, data]) });
    const logs: string[] = [];
    notifyHerdrBlocked("Approval uncertain: bash", (m) => logs.push(m));
    expect(emitted).toEqual([["herdr:blocked", { active: true, label: "Approval uncertain: bash" }]]);
    expect(logs).toEqual([expect.stringMatching(/^\[pi-permission-suite\] Herdr blocked: label="Approval uncertain: bash"$/)]);
  });

  test("notifyHerdrBlockedEnd emits herdr:blocked inactive", () => {
    const emitted: Array<[string, unknown]> = [];
    registerHerdrEventBus({ emit: (name, data) => emitted.push([name, data]) });
    notifyHerdrBlockedEnd();
    expect(emitted).toEqual([["herdr:blocked", { active: false }]]);
  });

  test("is a no-op without a registered bus and never throws on emit errors", () => {
    registerHerdrEventBus({ emit: () => { throw new Error("bus down"); } });
    expect(() => notifyHerdrBlocked("x")).not.toThrow();
    expect(() => notifyHerdrBlockedEnd()).not.toThrow();
    registerHerdrEventBus(undefined as never);
    expect(() => notifyHerdrBlocked("x")).not.toThrow();
  });
});

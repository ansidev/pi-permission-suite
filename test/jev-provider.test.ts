import { test, expect } from "bun:test";
import { buildJevBody, parseJevResponse, createJevProvider } from "../jev-provider.ts";
import { resolveDecision, DEFAULT_DECISION_CONFIG, type DecisionRequest } from "../decision-provider.ts";

const req: DecisionRequest = { toolName: "bash", input: { command: "ls" }, mode: "auto", ruleResult: undefined };
const ok = (choice: string, probs: Record<string, number>) =>
  ({ ok: true, status: 200, json: async () => ({ answers: { verdict: { type: "choice", choice, probabilities: probs, confidence: 1 } } }) }) as Response;
const mk = (f: (url: string, init: RequestInit) => Promise<Response>) =>
  createJevProvider({ apiKey: "k", baseUrl: "http://x/", fetch: f as never });

test("buildJevBody: choice question, clipped input", () => {
  const b = buildJevBody({ ...req, input: { content: "a".repeat(5000) } });
  expect(b.model).toBe("jev-latest");
  expect(b.questions.verdict.type).toBe("choice");
  expect(Object.keys(b.questions.verdict.criteria)).toEqual(["allow", "deny", "ask"]);
  expect(JSON.stringify(b.state)).toContain("truncated 3000 chars");
  expect(b.state.rule_result).toBe("undefined");
});

test("parseJevResponse: probability becomes confidence", () => {
  const r = parseJevResponse({ answers: { verdict: { type: "choice", choice: "deny", probabilities: { allow: 0.1, deny: 0.85, ask: 0.05 } } } });
  expect(r).toMatchObject({ verdict: "deny", confidence: 0.85 });
});

test("parseJevResponse: throws on malformed", () => {
  for (const bad of [null, {}, { answers: {} }, { answers: { verdict: { type: "choice", choice: "maybe", probabilities: {} } } },
    { answers: { verdict: { type: "choice", choice: "allow", probabilities: {} } } }]) {
    expect(() => parseJevResponse(bad)).toThrow();
  }
});

test("decide: sends auth + url, returns verdict", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const p = mk(async (url, init) => { seen = { url, init }; return ok("allow", { allow: 0.95, deny: 0, ask: 0.05 }); });
  const r = await resolveDecision(p, req, DEFAULT_DECISION_CONFIG);
  expect(seen!.url).toBe("http://x/v1/systemone");
  expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  expect(r).toMatchObject({ verdict: "allow", confidence: 0.95, fallback: false, source: "jev" });
});

test("low probability allow -> ask", async () => {
  const p = mk(async () => ok("allow", { allow: 0.5, deny: 0.2, ask: 0.3 }));
  expect((await resolveDecision(p, req)).verdict).toBe("ask");
});

test("failures never allow: no key, HTTP error, network error", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const noKey = createJevProvider({ fetch: (async () => ok("allow", { allow: 1 })) as never });
  const r1 = await resolveDecision(noKey, req);
  expect(r1).toMatchObject({ verdict: "ask", fallback: true });
  expect(r1.reason).toContain("TYPESAFE_API_KEY");
  if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;

  const http = mk(async () => ({ ok: false, status: 429 }) as Response);
  expect((await resolveDecision(http, req)).verdict).toBe("ask");
  const net = mk(async () => { throw new Error("down"); });
  expect((await resolveDecision(net, req)).verdict).toBe("ask");
});

test("abort signal propagates to fetch", async () => {
  let aborted = false;
  const p = mk((_u, init) => new Promise((_res, rej) => {
    init.signal!.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); });
  }));
  const r = await resolveDecision(p, req, { ...DEFAULT_DECISION_CONFIG, timeoutMs: 30 });
  expect(r.verdict).toBe("ask");
  expect(aborted).toBe(true);
});

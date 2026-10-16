import { test, expect } from "bun:test";
import {
  parseHttpProviderConfig,
  parseDecisionBody,
  createHttpDecisionProvider,
  createHttpDecisionProviderFromConfig,
  createHttpDecisionProviderFromDecision,
  type HttpProviderConfig,
} from "../http-decision-provider.ts";
import { resolveDecision, DEFAULT_DECISION_CONFIG, type DecisionRequest } from "../decision-provider.ts";

const req: DecisionRequest = { toolName: "bash", input: { command: "ls" }, mode: "auto", ruleResult: undefined };
const cfg: HttpProviderConfig = { url: "https://d.test/decide", authHeader: "Authorization", timeoutMs: 1000, maxResponseBytes: 1024 };
const json = (b: unknown, init?: ResponseInit) => new Response(JSON.stringify(b), init);
const sig = () => new AbortController().signal;
const fakeFetch = (fn: (url: string, init: RequestInit) => Promise<Response>) => ({ fetch: fn as unknown as typeof fetch });

test("parseHttpProviderConfig: validates url and defaults", () => {
  expect(parseHttpProviderConfig(undefined)).toBeUndefined();
  expect(parseHttpProviderConfig({})).toBeUndefined();
  expect(parseHttpProviderConfig({ url: "ftp://x" })).toBeUndefined();
  expect(parseHttpProviderConfig({ url: "not a url" })).toBeUndefined();
  expect(parseHttpProviderConfig({ url: "http://x/y" })).toEqual({
    url: "http://x/y", authHeader: "Authorization", authValue: undefined, timeoutMs: 5000, maxResponseBytes: 65536,
  });
  expect(parseHttpProviderConfig({ url: "https://x", authHeader: "X-Key", authValue: "s", timeoutMs: 10, maxResponseBytes: -1 })).toMatchObject({
    authHeader: "X-Key", authValue: "s", timeoutMs: 10, maxResponseBytes: 65536,
  });
  expect(createHttpDecisionProviderFromConfig({})).toBeUndefined();
});

test("parseDecisionBody: strict schema", () => {
  expect(parseDecisionBody({ verdict: "allow", confidence: 0.5 })).toEqual({ verdict: "allow", confidence: 0.5, reason: "" });
  expect(parseDecisionBody({ verdict: "deny", confidence: 1, reason: "no", extra: 1 })).toEqual({ verdict: "deny", confidence: 1, reason: "no" });
  for (const bad of [null, "x", [], {}, { verdict: "maybe", confidence: 1 }, { verdict: "allow" }, { verdict: "allow", confidence: "1" },
    { verdict: "allow", confidence: 2 }, { verdict: "allow", confidence: -0.1 }, { verdict: "allow", confidence: NaN }, { verdict: "allow", confidence: 1, reason: 5 }]) {
    expect(() => parseDecisionBody(bad)).toThrow();
  }
});

test("POSTs JSON with auth header (literal and env), no redirects", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const p = createHttpDecisionProvider({ ...cfg, authValue: "env:TOK" }, {
    env: { TOK: "secret" },
    ...fakeFetch(async (url, init) => { seen = { url, init }; return json({ verdict: "allow", confidence: 0.9, reason: "ok" }); }),
  });
  const r = await p.decide(req, sig());
  expect(r).toEqual({ verdict: "allow", confidence: 0.9, reason: "ok" });
  expect(seen!.url).toBe(cfg.url);
  expect(seen!.init.method).toBe("POST");
  expect(seen!.init.redirect).toBe("error");
  const h = seen!.init.headers as Record<string, string>;
  expect(h["content-type"]).toBe("application/json");
  expect(h["Authorization"]).toBe("secret");
  expect(JSON.parse(seen!.init.body as string)).toEqual(req);

  const lit = createHttpDecisionProvider({ ...cfg, authHeader: "X-Key", authValue: "abc" }, fakeFetch(async (_u, init) => {
    expect((init.headers as Record<string, string>)["X-Key"]).toBe("abc");
    return json({ verdict: "ask", confidence: 1 });
  }));
  await lit.decide(req, sig());
});

test("no auth header when not configured", async () => {
  const p = createHttpDecisionProvider(cfg, fakeFetch(async (_u, init) => {
    expect(Object.keys(init.headers as object)).not.toContain("Authorization");
    return json({ verdict: "allow", confidence: 1 });
  }));
  await p.decide(req, sig());
});

test("failures throw -> resolveDecision yields ask", async () => {
  const cases: Array<() => Promise<Response>> = [
    async () => json({ verdict: "allow", confidence: 1 }, { status: 500 }),
    async () => new Response("<html>", { status: 200 }),
    async () => json({ verdict: "allow", confidence: 7 }),
    async () => new Response("x".repeat(5000)),
    async () => { throw new Error("ECONNREFUSED"); },
  ];
  for (const c of cases) {
    const p = createHttpDecisionProvider(cfg, fakeFetch(c));
    const r = await resolveDecision(p, req, DEFAULT_DECISION_CONFIG);
    expect(r).toMatchObject({ verdict: "ask", fallback: true });
  }
});

test("missing auth env var -> ask, request never sent", async () => {
  let called = false;
  const p = createHttpDecisionProvider({ ...cfg, authValue: "env:NOPE" }, {
    env: {},
    ...fakeFetch(async () => { called = true; return json({ verdict: "allow", confidence: 1 }); }),
  });
  const r = await resolveDecision(p, req, DEFAULT_DECISION_CONFIG);
  expect(r).toMatchObject({ verdict: "ask", fallback: true });
  expect(r.reason).toContain("NOPE");
  expect(called).toBe(false);
});

test("caller abort and provider timeout abort the request", async () => {
  const hang = fakeFetch((_u, init) => new Promise<Response>((_res, rej) => {
    init.signal!.addEventListener("abort", () => rej(new Error("aborted")));
  }));
  const ac = new AbortController();
  const p1 = createHttpDecisionProvider(cfg, hang).decide(req, ac.signal);
  ac.abort();
  await expect(p1).rejects.toThrow();

  const p2 = createHttpDecisionProvider({ ...cfg, timeoutMs: 20 }, hang);
  await expect(p2.decide(req, sig())).rejects.toThrow();
});

test("real server round trip", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(r) {
      const body = (await r.json()) as DecisionRequest;
      if (r.headers.get("authorization") !== "tok") return new Response("no", { status: 401 });
      return Response.json({ verdict: body.toolName === "bash" ? "deny" : "allow", confidence: 0.95, reason: "srv" });
    },
  });
  try {
    const p = createHttpDecisionProviderFromConfig({ url: `http://localhost:${server.port}/`, authValue: "tok" })!;
    expect(await resolveDecision(p, req, DEFAULT_DECISION_CONFIG)).toMatchObject({ verdict: "deny", reason: "srv", fallback: false, source: "http" });
    const bad = createHttpDecisionProviderFromConfig({ url: `http://localhost:${server.port}/`, authValue: "wrong" })!;
    expect(await resolveDecision(bad, req, DEFAULT_DECISION_CONFIG)).toMatchObject({ verdict: "ask", fallback: true });
  } finally {
    server.stop(true);
  }
});

test("createHttpDecisionProviderFromDecision: endpoint + apiKeyEnv wiring", async () => {
  let seen: { url?: string; auth?: string } = {};
  const deps = {
    env: { MY_KEY: "k123" } as NodeJS.ProcessEnv,
    fetch: (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization };
      return json({ verdict: "allow", confidence: 0.9 });
    }) as unknown as typeof fetch,
  };
  const p = createHttpDecisionProviderFromDecision({ endpoint: "https://e.test/d", apiKeyEnv: "MY_KEY", timeoutMs: 500 }, deps)!;
  expect((await p.decide(req, sig())).verdict).toBe("allow");
  expect(seen).toEqual({ url: "https://e.test/d", auth: "Bearer k123" });
});

test("createHttpDecisionProviderFromDecision: http.url wins; missing url -> undefined; unset key throws", async () => {
  expect(createHttpDecisionProviderFromDecision({}, {})).toBeUndefined();
  expect(createHttpDecisionProviderFromDecision(undefined)).toBeUndefined();
  let url = "";
  const fetch = (async (u: string) => ((url = u), json({ verdict: "ask", confidence: 1 }))) as unknown as typeof globalThis.fetch;
  const p = createHttpDecisionProviderFromDecision({ endpoint: "https://a.test", http: { url: "https://b.test" } }, { fetch, env: {} })!;
  await p.decide(req, sig());
  expect(url).toBe("https://b.test");
  const q = createHttpDecisionProviderFromDecision({ endpoint: "https://a.test", apiKeyEnv: "NOPE" }, { fetch, env: {} })!;
  await expect(q.decide(req, sig())).rejects.toThrow("NOPE");
});

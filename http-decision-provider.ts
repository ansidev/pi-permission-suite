/**
 * Pi Permission Suite — generic HTTP Decision API provider
 *
 * POSTs the DecisionRequest as JSON to a configurable endpoint and parses a
 * decision response. Any failure (network, non-2xx, bad JSON, schema mismatch,
 * timeout) throws, so `resolveDecision` turns it into "ask". Never "allow".
 *
 * Config (under `decision.http` in config.json):
 * {
 *   "decision": {
 *     "provider": "http",
 *     "http": {
 *       "url": "https://decision.example.com/v1/decide",  // required, http(s)
 *       "authHeader": "Authorization",                    // header name (default)
 *       "authValue": "env:DECISION_API_TOKEN",            // literal or "env:NAME"
 *       "timeoutMs": 5000,                                // provider-level timeout
 *       "maxResponseBytes": 65536
 *     }
 *   }
 * }
 *
 * Response body schema: { "verdict": "allow"|"deny"|"ask",
 *                         "confidence": number 0..1, "reason"?: string }
 */

import type { DecisionProvider, DecisionRequest, DecisionResponse } from "./decision-provider.ts";

export interface HttpProviderConfig {
  url: string;
  authHeader: string;
  authValue?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export const HTTP_PROVIDER_NAME = "http";

const DEFAULTS = { authHeader: "Authorization", timeoutMs: 5_000, maxResponseBytes: 64 * 1024 };

/** Validate raw config. Returns undefined if unusable (e.g. missing/non-http url). Never throws. */
export function parseHttpProviderConfig(raw: unknown): HttpProviderConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string") return undefined;
  try {
    const u = new URL(r.url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  const pos = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : def);
  return {
    url: r.url.trim(),
    authHeader: typeof r.authHeader === "string" && r.authHeader.trim() ? r.authHeader.trim() : DEFAULTS.authHeader,
    authValue: typeof r.authValue === "string" && r.authValue ? r.authValue : undefined,
    timeoutMs: pos(r.timeoutMs, DEFAULTS.timeoutMs),
    maxResponseBytes: pos(r.maxResponseBytes, DEFAULTS.maxResponseBytes),
  };
}

/** Strict schema check; throws on any mismatch. */
export function parseDecisionBody(body: unknown): DecisionResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("response is not a JSON object");
  const b = body as Record<string, unknown>;
  if (b.verdict !== "allow" && b.verdict !== "deny" && b.verdict !== "ask") throw new Error("invalid verdict");
  if (typeof b.confidence !== "number" || !Number.isFinite(b.confidence) || b.confidence < 0 || b.confidence > 1) {
    throw new Error("invalid confidence (expected number in 0..1)");
  }
  if (b.reason !== undefined && typeof b.reason !== "string") throw new Error("invalid reason");
  return { verdict: b.verdict, confidence: b.confidence, reason: b.reason ?? "" };
}

function resolveAuthValue(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  const v = env[name];
  if (!v) throw new Error(`auth env var ${name} is not set`);
  return v;
}

async function readLimited(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) throw new Error("response too large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export interface HttpProviderDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export function createHttpDecisionProvider(config: HttpProviderConfig, deps: HttpProviderDeps = {}): DecisionProvider {
  const doFetch = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;

  return {
    name: HTTP_PROVIDER_NAME,
    async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResponse> {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (config.authValue) headers[config.authHeader] = resolveAuthValue(config.authValue, env);

      const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
      const res = await doFetch(config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        redirect: "error", // never forward the auth header to a redirect target
        signal: AbortSignal.any([signal, timeoutSignal]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = await readLimited(res, config.maxResponseBytes);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("response is not valid JSON");
      }
      return parseDecisionBody(json);
    },
  };
}

/** Build a provider from the raw `decision.http` config; undefined when config is invalid. */
export function createHttpDecisionProviderFromConfig(raw: unknown, deps?: HttpProviderDeps): DecisionProvider | undefined {
  const cfg = parseHttpProviderConfig(raw);
  return cfg ? createHttpDecisionProvider(cfg, deps) : undefined;
}

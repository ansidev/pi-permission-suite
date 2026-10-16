/**
 * Pi Permission Suite — Decision API provider interface
 *
 * A provider takes a tool call plus context and returns allow / deny / ask
 * with a confidence and a reason. `resolveDecision` wraps a provider with
 * timeout, abort, validation and confidence handling. Any failure, timeout,
 * malformed result or low confidence resolves to "ask" (the user decides).
 * A failure never produces "allow".
 *
 * Config (under the `decision` key of config.json), all fields optional:
 * {
 *   "decision": {
 *     "provider": "subagent",       // registered provider name
 *     "timeoutMs": 10000,           // per-call timeout
 *     "confidenceThreshold": 0.7,   // below this -> fallback
 *     "onFailure": "ask"            // only "ask" is supported
 *   }
 * }
 */

// ─── Types ─────────────────────────────────────────────────────────────

export type DecisionVerdict = "allow" | "deny" | "ask";

/** Result of the rule engine for this call (undefined = no rule matched) */
export type RuleResult = "allow" | "deny" | undefined;

export interface DecisionRequest {
  toolName: string;
  input: Record<string, unknown>;
  /** Current approval mode */
  mode: "act" | "auto" | "ask" | "plan";
  /** Parsed bash commands (bash tool only) */
  commands?: string[];
  /** Paths touched by the call, normalized */
  paths?: string[];
  cwd?: string;
  ruleResult: RuleResult;
}

export interface DecisionResponse {
  verdict: DecisionVerdict;
  /** 0..1 */
  confidence: number;
  reason: string;
}

export interface DecisionProvider {
  readonly name: string;
  /** Must honor `signal` where possible; the resolver also enforces timeout. */
  decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResponse>;
}

export interface DecisionConfig {
  provider: string;
  timeoutMs: number;
  confidenceThreshold: number;
  onFailure: "ask";
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  provider: "subagent",
  timeoutMs: 10_000,
  confidenceThreshold: 0.7,
  onFailure: "ask",
};

export interface ResolvedDecision extends DecisionResponse {
  /** true when the verdict is a fallback, not the provider's own answer */
  fallback: boolean;
  /** provider name, or "rules" when the rule engine already denied */
  source: string;
}

// ─── Config parsing ────────────────────────────────────────────────────

/** Validate raw config; invalid fields fall back to defaults. Never throws. */
export function parseDecisionConfig(raw: unknown): DecisionConfig {
  const d = DEFAULT_DECISION_CONFIG;
  if (typeof raw !== "object" || raw === null) return { ...d };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, ok: (n: number) => boolean, def: number) =>
    typeof v === "number" && Number.isFinite(v) && ok(v) ? v : def;
  return {
    provider: typeof r.provider === "string" && r.provider.trim() ? r.provider.trim() : d.provider,
    timeoutMs: num(r.timeoutMs, (n) => n > 0, d.timeoutMs),
    confidenceThreshold: num(r.confidenceThreshold, (n) => n >= 0 && n <= 1, d.confidenceThreshold),
    onFailure: "ask",
  };
}

// ─── Registry ──────────────────────────────────────────────────────────

const registry = new Map<string, DecisionProvider>();

export function registerDecisionProvider(provider: DecisionProvider): void {
  registry.set(provider.name, provider);
}

export function getDecisionProvider(name: string): DecisionProvider | undefined {
  return registry.get(name);
}

export function clearDecisionProviders(): void {
  registry.clear();
}

// ─── Resolution ────────────────────────────────────────────────────────

function ask(reason: string, source: string): ResolvedDecision {
  return { verdict: "ask", confidence: 0, reason, fallback: true, source };
}

function validate(res: unknown): DecisionResponse | undefined {
  if (typeof res !== "object" || res === null) return undefined;
  const r = res as Record<string, unknown>;
  if (r.verdict !== "allow" && r.verdict !== "deny" && r.verdict !== "ask") return undefined;
  const c = typeof r.confidence === "number" && Number.isFinite(r.confidence) ? r.confidence : 0;
  return {
    verdict: r.verdict,
    confidence: Math.min(1, Math.max(0, c)),
    reason: typeof r.reason === "string" ? r.reason : "",
  };
}

/**
 * Ask a provider for a decision. Never throws, never returns "allow" on failure.
 * If the rule engine already denied, the provider is not consulted.
 */
export async function resolveDecision(
  provider: DecisionProvider | undefined,
  request: DecisionRequest,
  config: DecisionConfig = DEFAULT_DECISION_CONFIG,
  signal?: AbortSignal,
): Promise<ResolvedDecision> {
  if (request.ruleResult === "deny") {
    return { verdict: "deny", confidence: 1, reason: "Denied by rules", fallback: false, source: "rules" };
  }
  if (!provider) return ask(`Decision provider "${config.provider}" not found`, config.provider);
  if (signal?.aborted) return ask("Aborted", provider.name);

  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const guard = new Promise<ResolvedDecision>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(ask(`Provider timed out (${config.timeoutMs}ms)`, provider.name));
    }, config.timeoutMs);
    onAbort = () => {
      ctrl.abort();
      resolve(ask("Aborted", provider.name));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  const call = (async (): Promise<ResolvedDecision> => {
    try {
      const res = validate(await provider.decide(request, ctrl.signal));
      if (!res) return ask("Provider returned an invalid response", provider.name);
      if (res.confidence < config.confidenceThreshold) {
        return {
          ...res,
          verdict: "ask",
          reason: `Low confidence (${res.confidence} < ${config.confidenceThreshold}): ${res.reason}`,
          fallback: true,
          source: provider.name,
        };
      }
      return { ...res, fallback: false, source: provider.name };
    } catch (e) {
      return ask(`Provider failed: ${e instanceof Error ? e.message : String(e)}`, provider.name);
    }
  })();

  try {
    return await Promise.race([call, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

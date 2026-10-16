/**
 * Pi Permission Suite — Jev (TypeSafe System One) decision provider
 *
 * Maps a tool call + context to a typed judgment (allow / deny / ask) with a
 * probability, using one `choice` question against the System One API.
 * Docs: https://docs.typesafe.ai/api.md
 *
 * Env:
 *   TYPESAFE_API_KEY   required (never read from config, never logged)
 *   TYPESAFE_BASE_URL  optional, default https://api.typesafe.ai
 *   TYPESAFE_MODEL     optional, default jev-latest
 *
 * Enable with `"decision": { "provider": "jev" }` in config.json.
 * Every failure throws; `resolveDecision` turns that into "ask".
 */

import {
  registerDecisionProvider,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
  type DecisionVerdict,
} from "./decision-provider.ts";

export const JEV_PROVIDER_NAME = "jev";
const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const MAX_FIELD_CHARS = 2000;
const VERDICTS: readonly DecisionVerdict[] = ["allow", "deny", "ask"];

export interface JevOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

const QUESTION = {
  type: "choice",
  instructions: {
    question:
      "A coding agent wants to run the tool call in `tool_call`. Should it be allowed to run without asking the user?",
    note:
      "`rule_result` is the verdict of a static rule engine (undefined = no rule matched). `mode` is the approval mode.",
  },
  criteria: {
    allow: "Clearly safe: read-only, or a local, easily reversible change confined to the working directory, matching what a developer would expect.",
    deny: "Clearly harmful: destructive or irreversible damage, data exfiltration, credential access, privilege escalation, or remote code execution.",
    ask: "Anything uncertain, ambiguous, or with side effects outside the working directory. A human should decide.",
  },
} as const;

function clip(v: unknown): unknown {
  if (typeof v === "string") return v.length > MAX_FIELD_CHARS ? `${v.slice(0, MAX_FIELD_CHARS)}…[truncated ${v.length - MAX_FIELD_CHARS} chars]` : v;
  if (Array.isArray(v)) return v.slice(0, 50).map(clip);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]));
  }
  return v;
}

/** Build the System One request body. Exported for tests. */
export function buildJevBody(req: DecisionRequest, model = DEFAULT_MODEL) {
  return {
    model,
    state: {
      tool_call: { tool: req.toolName, input: clip(req.input) },
      commands: req.commands ? clip(req.commands) : undefined,
      paths: req.paths ? clip(req.paths) : undefined,
      cwd: req.cwd,
      mode: req.mode,
      rule_result: req.ruleResult ?? "undefined",
    },
    questions: { verdict: QUESTION },
  };
}

/** Parse a System One response into a DecisionResponse. Throws on any surprise. */
export function parseJevResponse(json: unknown): DecisionResponse {
  const ans = (json as { answers?: { verdict?: Record<string, unknown> } } | null)?.answers?.verdict;
  if (!ans || ans.type !== "choice") throw new Error("Jev: missing choice answer");
  const choice = ans.choice;
  if (typeof choice !== "string" || !VERDICTS.includes(choice as DecisionVerdict)) {
    throw new Error("Jev: unknown choice");
  }
  const probs = ans.probabilities as Record<string, unknown> | undefined;
  const p = probs?.[choice];
  if (typeof p !== "number" || !Number.isFinite(p)) throw new Error("Jev: missing probability");
  const dist = VERDICTS.map((v) => `${v}=${Number(probs?.[v] ?? 0).toFixed(2)}`).join(" ");
  return { verdict: choice as DecisionVerdict, confidence: p, reason: `Jev: ${dist}` };
}

export function createJevProvider(opts: JevOptions = {}): DecisionProvider {
  return {
    name: JEV_PROVIDER_NAME,
    async decide(request, signal) {
      const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
      if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
      const base = (opts.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
      const model = opts.model ?? process.env.TYPESAFE_MODEL ?? DEFAULT_MODEL;

      const res = await (opts.fetch ?? fetch)(`${base}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildJevBody(request, model)),
        signal,
      });
      if (!res.ok) throw new Error(`Jev API HTTP ${res.status}`);
      return parseJevResponse(await res.json());
    },
  };
}

/** Register the Jev provider so `decision.provider = "jev"` resolves. */
export function registerJevProvider(opts?: JevOptions): void {
  registerDecisionProvider(createJevProvider(opts));
}

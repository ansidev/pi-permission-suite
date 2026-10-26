/**
 * Tool rules with optional argument conditions (`tools.allow` / `tools.deny`).
 *
 * A rule value may be:
 *   - allow: `true` | `false` | `{ args }` | array of `{ args }`
 *   - deny:  `"reason"` | `{ reason?, args? }` | array of those
 *
 * `args` maps an input field to a condition (all fields must match):
 *   - `true`      field is present (not null/undefined/"")
 *   - `false`     field is absent
 *   - `"pat"`     String(value) matches the wildcard pattern (`*`, `?`)
 *   - `["a","b"]` String(value) matches any pattern
 *
 * Array values are OR-ed. Patterns are checked last-to-first (last match wins);
 * a conditional entry whose args do not match falls through to earlier entries.
 */

import { compilePattern } from "./wildcard-matcher.ts";

export type ArgCondition = boolean | string | string[];
export type ArgsMatcher = Record<string, ArgCondition>;

export interface ConditionalAllow { args?: ArgsMatcher }
export interface ConditionalDeny { reason?: string; args?: ArgsMatcher }

export type ToolAllowValue = boolean | ConditionalAllow | ConditionalAllow[];
export type ToolDenyValue = string | ConditionalDeny | Array<string | ConditionalDeny>;

const DEFAULT_DENY_REASON = "Denied by tools.deny rule";

function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/** True when every field condition holds for `input`. Malformed conditions never match. */
export function matchArgs(args: ArgsMatcher | undefined, input: Record<string, unknown>): boolean {
  if (args === undefined) return true;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
  for (const [field, cond] of Object.entries(args)) {
    const value = input?.[field];
    if (cond === true) { if (!isPresent(value)) return false; continue; }
    if (cond === false) { if (isPresent(value)) return false; continue; }
    const pats = typeof cond === "string" ? [cond] : Array.isArray(cond) ? cond : null;
    if (!pats || !isPresent(value) || typeof value === "object") return false;
    const s = String(value);
    if (!pats.some((p) => typeof p === "string" && compilePattern(p).test(s))) return false;
  }
  return true;
}

/** First matching deny reason for (toolName, input), or undefined. */
export function matchToolDenyRule(
  rules: Record<string, ToolDenyValue> | undefined,
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const entries = Object.entries(rules ?? {});
  for (let i = entries.length - 1; i >= 0; i--) {
    const [pattern, value] = entries[i];
    if (!compilePattern(pattern).test(toolName)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && matchArgs(item.args, input)) {
        return item.reason ?? DEFAULT_DENY_REASON;
      }
    }
  }
  return undefined;
}

/** True when an allow rule matches (toolName, input). `false` entries stop the search. */
export function matchToolAllowRule(
  rules: Record<string, ToolAllowValue> | undefined,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const entries = Object.entries(rules ?? {});
  for (let i = entries.length - 1; i >= 0; i--) {
    const [pattern, value] = entries[i];
    if (!compilePattern(pattern).test(toolName)) continue;
    if (value === true) return true;
    if (value === false) return false;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item && typeof item === "object" && matchArgs(item.args, input)) return true;
    }
  }
  return false;
}

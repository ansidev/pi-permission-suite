/**
 * Pi Permission Suite — Rule Engine (upgraded)
 *
 * Priority: deny > allow > session always rules > mode default behavior
 *
 * Upgrades:
 * - tree-sitter bash parsing (chained commands, $(...), subshells)
 * - bash wildcard matching (last-match-wins)
 * - Cross-tool path surface (read/write/edit/bash all subject to path rules)
 * - symlink parsing to prevent bypass
 * - JSON configuration file support
 * - Retain hardcoded dangerous command safety net
 */

import type { ApprovalConfig } from "./config-loader.ts";
import { loadConfig } from "./config-loader.ts";
import { parseDecisionConfig, type DecisionConfig } from "./decision-provider.ts";
import { findMatch } from "./wildcard-matcher.ts";
import { parseBashCommand } from "./bash-parser.ts";
import { matchToolAllowRule, matchToolDenyRule } from "./tool-rules.ts";
import {
  expandHome,
  normalizePath,
  canonicalizePath,
  getPathPolicyValues,
  getToolPath,
  READONLY_TOOLS,
} from "./path-utils.ts";

// ─── Types ─────────────────────────────────────────────────────────────

interface Rule {
  name: string;
  tools: string[];
  patterns: RegExp[];
  message?: string;
}

type Policy = "deny" | "allow";

export type AlwaysRule =
  | { kind: "tool"; tool: string }
  | { kind: "bash_prefix"; prefix: string }
  | { kind: "write_path_prefix"; prefix: string };

interface EvaluateContext {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
}

// ─── Hardcoded deny rules (safety net) ─────────────────────────────────

const HARD_DENY: Rule[] = [
  { name: "rm-root", tools: ["bash"], patterns: [/\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)*(\/\s*$|~\/?\s*$|\*\s*$|\$HOME)/], message: "🚨 Deleting root directory / user directory" },
  { name: "sudo-destructive", tools: ["bash"], patterns: [/\bsudo\s+(dd|mkfs|fdisk|kill\s+-9\s+1)\b/], message: "🚨 sudo Destructive operation" },
  { name: "fork-bomb", tools: ["bash"], patterns: [/:\(\)\s*\{\s*:\|:\&\s*\}\s*;/, /\bcat\s+\/dev\/(zero|urandom)\s*>/], message: "🚨 Fork bomb / Disk filling" },
  { name: "remote-exec", tools: ["bash"], patterns: [/\b(curl|wget)\b.*\|\s*(bash|sh)\b/], message: "🚨 Remote code execution" },
  { name: "chmod-root", tools: ["bash"], patterns: [/\b(chmod|chown)\b.*\s+\/\s*$/], message: "🚨 Modifying root directory permissions" },
  { name: "env-leak", tools: ["bash"], patterns: [/\becho\b.*\$(API_KEY|SECRET|TOKEN)/], message: "🚨 Leaking sensitive variables" },
];

// ─── Hardcoded allow rules (read-only baseline) ────────────────────────

const HARD_ALLOW: Rule[] = [
  { name: "read-tools", tools: ["read", "grep", "find", "ls", "question", "questionnaire", "web_search", "fetch_content", "get_search_content", "get_subagent_result", "goal_complete", "steer_subagent", "Agent"], patterns: [/.*/] },
  { name: "bash-readonly", tools: ["bash"], patterns: [
    /^\s*(cat|head|tail|less|more|wc|file|stat|ls|tree|find|grep|rg|which|date|pwd)\b/,
    /^\s*git\s+(status|log|diff|show|branch|tag|remote|describe|blame|reflog|stash\s+list)\b/,
    /^\s*(ps|top|htop|df|du|free|uptime|uname|id|whoami|w|last|lsof)\b/,
    /^\s*(npm|yarn|pnpm)\s+(list|info|view|outdated|audit)\b/,
    /^\s*(pip|pip3)\s+(list|show|freeze)\b/,
    /^\s*(cargo)\s+(tree|list|metadata)\b/,
    /^\s*(go)\s+(list|env|version)\b/,
    /^\s*docker\s+(ps|images|logs|inspect|version|info|stats|top)\b/,
    /^\s*(zcat|zgrep|zless|zmore|zdiff)\b/,
    /^\s*(unzip|zipinfo)\s+.*-l/,
    /^\s*tar\s+.*-[tZ]/,
    /^\s*(awk|sed|jq|sort|uniq|cut|tr|tee|diff|comm|paste|join|column|fmt|fold|pr)\b/,
    /^\s*(curl|wget)\s+/,
    /^\s*(ping|dig|nslookup|host|traceroute|whois|netstat|ss|ip\s+addr)\b/,
    /^\s*[#$\s]*$/,
  ]},
];

// ─── RuleEngine ────────────────────────────────────────────────────────

export class RuleEngine {
  private config: ApprovalConfig;
  private alwaysRules: AlwaysRule[] = [];
  private cwd: string = process.cwd();

  constructor() {
    this.config = loadConfig();
  }

  /** Decision provider settings (validated; defaults on invalid/missing) */
  getDecisionConfig(): DecisionConfig {
    return parseDecisionConfig(this.config.decision);
  }

  /** Raw `decision` config block (for provider/audit setup) */
  getRawDecisionConfig(): unknown {
    return this.config.decision;
  }

  /** Normalized path touched by a tool call, if any (for decision context) */
  getCallPaths(toolName: string, input: Record<string, unknown>): string[] {
    const p = getToolPath(toolName, input);
    return p ? [normalizePath(expandHome(p), this.cwd)] : [];
  }

  /** Update the working directory (called on session start) */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /** Add a session-scoped always rule */
  addAlwaysRule(rule: AlwaysRule): void {
    this.alwaysRules.push(rule);
  }

  /** Clear all session-scoped always rules */
  clearAlwaysRules(): void {
    this.alwaysRules = [];
  }

  /**
   * Main evaluation entry point (synchronous).
   * Returns: "deny" | "allow" | undefined (undefined = no match, fall to mode layer)
   */
  evaluate(toolName: string, input: Record<string, unknown>): Policy | undefined {
    const ctx: EvaluateContext = { toolName, input, cwd: this.cwd };

    // 1. Deny rules (highest priority — any mode can't override)
    if (this.checkDeny(ctx)) return "deny";

    // 2. Allow rules
    if (this.checkAllow(ctx)) return "allow";

    // 3. Session always rules
    if (this.checkAlways(ctx)) return "allow";

    // 4. No match → fall to mode layer
    return undefined;
  }

  /**
   * Async evaluation with tree-sitter bash parsing.
   * Uses tree-sitter to properly split chain commands and extract path tokens.
   * Falls back to sync evaluate() if tree-sitter is unavailable.
   */
  async evaluateAsync(toolName: string, input: Record<string, unknown>): Promise<Policy | undefined> {
    // For non-bash tools, use sync path
    if (toolName !== "bash") return this.evaluate(toolName, input);

    const command = String(input.command ?? "");
    if (!command.trim()) return this.evaluate(toolName, input);

    // 0. Tool-name deny
    if (this.matchToolDeny(toolName, input) !== undefined) return "deny";

    // 1. Deny — try tree-sitter first
    const bashDeny = await this.checkBashDenyAsync(command);
    if (bashDeny) return "deny";

    // 2. Allow — try tree-sitter first
    const bashAllow = await this.checkBashAllowAsync(command);
    if (bashAllow) return "allow";

    // 3. Session always rules
    if (this.checkAlways({ toolName, input, cwd: this.cwd })) return "allow";

    // 4. No match → fall to mode layer
    return undefined;
  }

  /**
   * Get the deny reason message for a tool call.
   */
  getDenyMessage(toolName: string, input: Record<string, unknown>): string | undefined {
    const ctx: EvaluateContext = { toolName, input, cwd: this.cwd };

    // Check config tool-name deny
    const toolDeny = this.matchToolDeny(toolName, input);
    if (toolDeny !== undefined) return toolDeny;

    // Check config bash deny
    if (toolName === "bash") {
      const cmd = String(input.command ?? "");
      const match = findMatch(this.config.bash.deny, cmd);
      if (match) return match.value;
    }

    // Check config path deny
    const path = getToolPath(toolName, input);
    if (path) {
      const match = this.checkPathDeny(path);
      if (match) return match;
    }

    // Check hardcoded deny
    const extracted = this.extract(toolName, input);
    const hardDeny = HARD_DENY.find(
      (r) => r.tools.includes(toolName) && r.patterns.some((p) => p.test(extracted))
    );
    if (hardDeny) return hardDeny.message;

    return undefined;
  }

  /**
   * Get rule names for status display.
   */
  getRuleNames(): { deny: string[]; allow: string[] } {
    const configDenyNames = [
      ...Object.keys(this.config.bash.deny),
      ...Object.keys(this.config.path.deny),
      ...Object.keys(this.config.tools?.deny ?? {}),
    ];
    const configAllowNames = [
      ...Object.keys(this.config.bash.allow),
      ...Object.keys(this.config.path.allow),
      ...Object.keys(this.config.tools?.allow ?? {}),
    ];
    return {
      deny: [...HARD_DENY.map((r) => r.name), ...configDenyNames],
      allow: [...HARD_ALLOW.map((r) => r.name), ...configAllowNames],
    };
  }

  // ─── Deny checking ─────────────────────────────────────────────────

  /** Config tool deny match (name wildcards + optional arg conditions); returns reason */
  private matchToolDeny(toolName: string, input: Record<string, unknown>): string | undefined {
    return matchToolDenyRule(this.config.tools?.deny, toolName, input);
  }

  /** Config tool allow match; an explicit `false` entry does not allow */
  private matchToolAllow(toolName: string, input: Record<string, unknown>): boolean {
    return matchToolAllowRule(this.config.tools?.allow, toolName, input);
  }

  private checkDeny(ctx: EvaluateContext): boolean {
    // Tool-name deny (any tool, any mode)
    if (this.matchToolDeny(ctx.toolName, ctx.input) !== undefined) return true;

    // Bash deny: config patterns + hardcoded safety net
    if (ctx.toolName === "bash") {
      return this.checkBashDeny(String(ctx.input.command ?? ""));
    }

    // Path deny: cross-tool path surface
    const path = getToolPath(ctx.toolName, ctx.input);
    if (path && this.checkPathDeny(path)) return true;

    // Hardcoded deny for non-bash tools
    const extracted = this.extract(ctx.toolName, ctx.input);
    return HARD_DENY.some(
      (r) => r.tools.includes(ctx.toolName) && r.patterns.some((p) => p.test(extracted))
    );
  }

  private checkBashDeny(command: string): boolean {
    // Config patterns (synchronous check on raw command)
    const configMatch = findMatch(this.config.bash.deny, command);
    if (configMatch) return true;

    // Also try matching against sub-commands (split on chain operators)
    const subCommands = simpleChainSplit(command);
    for (const sub of subCommands) {
      const subMatch = findMatch(this.config.bash.deny, sub.trim());
      if (subMatch) return true;
    }

    // Hardcoded safety net
    return HARD_DENY.some(
      (r) => r.tools.includes("bash") && r.patterns.some((p) => p.test(command))
    );
  }

  private checkPathDeny(path: string): string | undefined {
    const expandedPath = expandHome(path);
    const normalized = normalizePath(expandedPath, this.cwd);
    const canonical = canonicalizePath(normalized);

    // Collect all values to check (lexical + canonical)
    const valuesToCheck = [expandedPath, normalized, canonical].filter(Boolean);
    const policyValues = getPathPolicyValues(path, this.cwd);
    const allValues = [...new Set([...valuesToCheck, ...policyValues])];

    // Check allow patterns first — more-specific allow overrides deny
    // (e.g. *.env.example overrides *.env.*)
    for (const val of allValues) {
      const allowMatch = findMatch(this.config.path.allow, val);
      if (allowMatch) return undefined; // explicitly allowed, skip deny
    }

    // Check deny patterns
    for (const val of allValues) {
      const match = findMatch(this.config.path.deny, val);
      if (match) return match.value;
    }

    return undefined;
  }

  // ─── Allow checking ────────────────────────────────────────────────

  private checkAllow(ctx: EvaluateContext): boolean {
    // Bash allow: config patterns + hardcoded
    if (ctx.toolName === "bash") {
      return this.checkBashAllow(String(ctx.input.command ?? ""));
    }

    // Path allow: cross-tool path surface
    const path = getToolPath(ctx.toolName, ctx.input);
    if (path) {
      const pathDenyResult = this.checkPathDeny(path);
      if (pathDenyResult) return false; // deny overrides allow
    }

    // Config tool-name allow (non-bash only; bash keeps command/path rules)
    if (this.matchToolAllow(ctx.toolName, ctx.input)) return true;

    if (READONLY_TOOLS.has(ctx.toolName)) return true;

    // Hardcoded allow
    const extracted = this.extract(ctx.toolName, ctx.input);
    return HARD_ALLOW.some(
      (r) => r.tools.includes(ctx.toolName) && r.patterns.some((p) => p.test(extracted))
    );
  }

  private checkBashAllow(command: string): boolean {
    // Config bash allow patterns
    const configMatch = findMatch(this.config.bash.allow, command);
    if (configMatch) return true;

    // Also try matching against sub-commands
    const subCommands = simpleChainSplit(command);
    for (const sub of subCommands) {
      const subMatch = findMatch(this.config.bash.allow, sub.trim());
      if (subMatch) return true;
    }

    // Hardcoded allow
    return HARD_ALLOW.some(
      (r) => r.tools.includes("bash") && r.patterns.some((p) => p.test(command))
    );
  }

  // ─── Async bash evaluation (tree-sitter) ────────────────────────────

  private async checkBashDenyAsync(command: string): Promise<boolean> {
    // Quick check on raw command first
    const configMatch = findMatch(this.config.bash.deny, command);
    if (configMatch) return true;

    // Use tree-sitter to split and check sub-commands
    try {
      const parsed = await parseBashCommand(command);
      for (const sub of parsed.commands) {
        const subMatch = findMatch(this.config.bash.deny, sub.text);
        if (subMatch) return true;
      }
      // Also check extracted path tokens against path deny
      for (const token of parsed.pathTokens) {
        if (this.checkPathDeny(token)) return true;
      }
    } catch {
      // tree-sitter failed, fall back to sync
      return this.checkBashDeny(command);
    }

    // Hardcoded safety net
    return HARD_DENY.some(
      (r) => r.tools.includes("bash") && r.patterns.some((p) => p.test(command))
    );
  }

  private async checkBashAllowAsync(command: string): Promise<boolean> {
    // Quick check on raw command first
    const configMatch = findMatch(this.config.bash.allow, command);
    if (configMatch) return true;

    // Use tree-sitter to split and check sub-commands
    try {
      const parsed = await parseBashCommand(command);
      for (const sub of parsed.commands) {
        const subMatch = findMatch(this.config.bash.allow, sub.text);
        if (subMatch) return true;
      }
    } catch {
      // tree-sitter failed, fall back to sync
      return this.checkBashAllow(command);
    }

    // Hardcoded allow
    return HARD_ALLOW.some(
      (r) => r.tools.includes("bash") && r.patterns.some((p) => p.test(command))
    );
  }

  // ─── Session always rules ──────────────────────────────────────────

  private checkAlways(ctx: EvaluateContext): boolean {
    return this.alwaysRules.some((rule) => {
      switch (rule.kind) {
        case "tool":
          return rule.tool === ctx.toolName;
        case "bash_prefix":
          if (ctx.toolName !== "bash") return false;
          return String(ctx.input.command ?? "").startsWith(rule.prefix);
        case "write_path_prefix":
          if (ctx.toolName !== "write" && ctx.toolName !== "edit") return false;
          return String(ctx.input.path ?? "").startsWith(rule.prefix);
        default:
          return false;
      }
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private extract(toolName: string, input: Record<string, unknown>): string {
    if (toolName === "bash") return String(input.command ?? "");
    if (["read", "edit", "write"].includes(toolName)) return String(input.path ?? "");
    return "";
  }
}

// ─── Simple chain splitter (synchronous, no tree-sitter) ──────────────

function simpleChainSplit(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\") { current += ch; escaped = true; continue; }
    if (ch === "'" && !inDouble) { current += ch; inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { current += ch; inDouble = !inDouble; continue; }
    if (inSingle || inDouble) { current += ch; continue; }

    const isChainOp = (ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|");
    const isSeparator = ch === ";" || ch === "|" || ch === "&";
    if (isChainOp || isSeparator) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length > 0 ? parts : [cmd];
}

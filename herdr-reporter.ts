/**
 * pi-permission-suite — Herdr integration
 *
 * Reports agent state and (best-effort) resume command to Herdr when the
 * session runs inside a Herdr pane, per https://herdr.dev/tui/docs/add-herdr-support/.
 * A no-op outside Herdr (when HERDR_ENV is not "1" or the required env vars
 * are missing). Every interaction with Herdr is fire-and-forget: failures and
 * timeouts are swallowed and never affect the permission decision flow.
 */

import { spawn } from "node:child_process";

const SOURCE = "pi-permission-suite";
const AGENT = "pi";

export function herdrAvailable(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    !!process.env.HERDR_PANE_ID &&
    !!process.env.HERDR_BIN_PATH &&
    !!process.env.HERDR_SOCKET_PATH
  );
}

let seqCounter = Date.now();
function nextSeq(): number {
  // Timestamp-based so a seq stays ahead of earlier reports even across
  // module reloads; the counter guarantees strict monotonicity within one.
  if (Date.now() >= seqCounter) seqCounter = Date.now();
  return ++seqCounter;
}

export interface HerdrStateOptions {
  message?: string;
}

/**
 * Fire-and-forget report. Returns immediately; never throws.
 */
export function reportAgentState(state: "idle" | "working" | "blocked", options?: HerdrStateOptions): void {
  if (!herdrAvailable()) return;
  const pane = process.env.HERDR_PANE_ID as string;
  const bin = process.env.HERDR_BIN_PATH as string;

  const args = [
    "pane",
    "report-agent",
    pane,
    "--source",
    SOURCE,
    "--agent",
    AGENT,
    "--state",
    state,
    "--seq",
    String(nextSeq()),
  ];
  if (options?.message) {
    args.push("--message", options.message);
  }

  try {
    const child = spawn(bin, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* ignore */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

export function releaseAgent(): void {
  if (!herdrAvailable()) return;
  const pane = process.env.HERDR_PANE_ID as string;
  const bin = process.env.HERDR_BIN_PATH as string;
  const args = ["pane", "release-agent", pane, "--source", SOURCE, "--agent", AGENT, "--seq", String(nextSeq())];
  try {
    const child = spawn(bin, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* ignore */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { herdrAvailable, reportAgentState, releaseAgent } from "../herdr-reporter.ts";

const ENV_KEYS = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_BIN_PATH", "HERDR_SOCKET_PATH"];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function enableHerdr() {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_BIN_PATH = "/usr/bin/true";
  process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
}

/**
 * Records the argv of every spawned process. The wrapper script joins its
 * arguments with spaces and appends one line per spawn (a single write, so
 * concurrently spawned processes don't interleave mid-record).
 */
async function recordSpawns(fn: () => void): Promise<string[][]> {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "herdr-test-"));
  const log = join(dir, "args.log");
  await writeFile(
    join(dir, "rec"),
    `#!/bin/sh\nargs=""\nfor a in "$@"; do args="$args$a "; done\nprintf '%s\\n' "$args" >> ${JSON.stringify(log)}\n`,
    { mode: 0o755 },
  );
  process.env.HERDR_BIN_PATH = join(dir, "rec");
  process.env.HERDR_PANE_ID = "w1:p1";
  fn();
  // Detached children write asynchronously; wait until all expected spawns land.
  let prev = -1;
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const cur = (await readFile(log, "utf8").catch(() => "")).split("\n").length - 1;
    if (cur > 0 && cur === prev) break;
    prev = cur;
  }
  const content = await readFile(log, "utf8").catch(() => "");
  await rm(dir, { recursive: true, force: true });
  return content
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.trim().split(" ").filter((a) => a.length > 0));
}

describe("herdrAvailable", () => {
  test("is false when HERDR_ENV is missing", () => {
    enableHerdr();
    delete process.env.HERDR_ENV;
    expect(herdrAvailable()).toBe(false);
  });

  test("is false when HERDR_ENV is not exactly \"1\"", () => {
    enableHerdr();
    process.env.HERDR_ENV = "true";
    expect(herdrAvailable()).toBe(false);
  });

  test("is false when any required var is missing", () => {
    for (const missing of ["HERDR_PANE_ID", "HERDR_BIN_PATH", "HERDR_SOCKET_PATH"]) {
      enableHerdr();
      delete process.env[missing];
      expect(herdrAvailable()).toBe(false);
    }
  });

  test("is true with the full Herdr env", () => {
    enableHerdr();
    expect(herdrAvailable()).toBe(true);
  });
});

describe("outside herdr", () => {
  test("reportAgentState and releaseAgent are silent no-ops", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(herdrAvailable()).toBe(false);
    expect(() => reportAgentState("working")).not.toThrow();
    expect(() => reportAgentState("blocked", { message: "x" })).not.toThrow();
    expect(() => reportAgentState("idle")).not.toThrow();
    expect(() => releaseAgent()).not.toThrow();
  });
});

describe("state reporting inside herdr", () => {
  test("reportAgentState invokes pane report-agent with state, source, agent and seq", async () => {
    const calls = await recordSpawns(() => {
      reportAgentState("working");
      reportAgentState("blocked", { message: "Approval uncertain: bash" });
      reportAgentState("idle");
    });

    expect(calls.length).toBe(3);
    // Concurrent detached writers append whole lines in any order; compare as sets.
    const byState = new Map<string, string[]>();
    for (const c of calls) {
      const si = c.indexOf("--state");
      byState.set(c[si + 1], c);
    }
    expect([...byState.keys()].sort()).toEqual(["blocked", "idle", "working"]);

    for (const c of calls) {
      expect(c[0]).toBe("pane");
      expect(c[1]).toBe("report-agent");
      expect(c[2]).toBe("w1:p1");
      expect(c).toContain("--source");
      expect(c[c.indexOf("--source") + 1]).toBe("pi-permission-suite");
      expect(c).toContain("--agent");
      expect(c[c.indexOf("--agent") + 1]).toBe("pi");
      expect(c).toContain("--seq");
      expect(Number(c[c.indexOf("--seq") + 1])).not.toBeNaN();
    }

    const working = byState.get("working")!;
    expect(working.includes("--message")).toBe(false);

    const blocked = byState.get("blocked")!;
    const mi = blocked.indexOf("--message");
    expect(blocked.slice(mi + 1).join(" ")).toBe("Approval uncertain: bash");
  });

  test("releaseAgent invokes pane release-agent", async () => {
    const calls = await recordSpawns(() => releaseAgent());
    expect(calls.length).toBe(1);
    const c = calls[0];
    expect(c[0]).toBe("pane");
    expect(c[1]).toBe("release-agent");
    expect(c[2]).toBe("w1:p1");
    expect(c[c.indexOf("--source") + 1]).toBe("pi-permission-suite");
    expect(c[c.indexOf("--agent") + 1]).toBe("pi");
  });

  test("seq increases monotonically across reports", async () => {
    const calls = await recordSpawns(() => {
      reportAgentState("working");
      reportAgentState("blocked", { message: "m" });
      reportAgentState("idle");
      releaseAgent();
    });
    const seqs = calls.map((c) => Number(c[c.indexOf("--seq") + 1]));
    expect(seqs.length).toBe(4);
    expect(new Set(seqs).size).toBe(4);
    // Timestamp-based seq must also never go backwards across separate runs.
    // Runs are separated by a real wait, so the clock must have advanced.
    await new Promise((r) => setTimeout(r, 1100));
    const later = await recordSpawns(() => {
      reportAgentState("working");
      reportAgentState("idle");
    });
    const lateSeqs = later.map((c) => Number(c[c.indexOf("--seq") + 1]));
    expect(lateSeqs[0]).toBeGreaterThan(Math.max(...seqs));
    expect(lateSeqs.length).toBe(2);
  });
});

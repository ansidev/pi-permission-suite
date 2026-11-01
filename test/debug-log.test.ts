import { test, expect, describe } from "bun:test";
import { DEBUG_TAG, makeDebugSink, tagged } from "../debug-log.ts";

describe("debug-log", () => {
  test("tagged prefixes the message with the [pi-permission-suite] tag", () => {
    expect(tagged("Herdr report: pane=w1:p1 state=blocked")).toBe(
      "[pi-permission-suite] Herdr report: pane=w1:p1 state=blocked",
    );
  });

  test("DEBUG_TAG is [pi-permission-suite]", () => {
    expect(DEBUG_TAG).toBe("[pi-permission-suite]");
  });

  test("makeDebugSink returns undefined when disabled", () => {
    expect(makeDebugSink(false)).toBeUndefined();
  });

  test("makeDebugSink prefixes output with the tag when enabled", () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (m: string) => lines.push(m);
    try {
      makeDebugSink(true)!("Pausing to ask the user: tool=bash");
    } finally {
      console.error = orig;
    }
    expect(lines).toEqual(["[pi-permission-suite] Pausing to ask the user: tool=bash"]);
  });
});

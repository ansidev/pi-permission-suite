/**
 * Pi Permission Suite — Debug logging
 *
 * Central debug sink. Every debug log line is prefixed with the
 * [pi-permission-suite] tag so lines are greppable in piped/interleaved
 * output (e.g. herdr panes, CI logs).
 */

export const DEBUG_TAG = "[pi-permission-suite]";

export type DebugSink = (message: string) => void;

/**
 * Returns a sink that prefixes messages with the debug tag, or undefined
 * when debug is off.
 */
export function makeDebugSink(enabled: boolean): DebugSink | undefined {
  if (!enabled) return undefined;
  return (message: string) => console.error(`${DEBUG_TAG} ${message}`);
}

/**
 * Formats an already-enabled debug message with the tag. Use this when the
 * caller owns the sink (e.g. ctx.ui.notify) and just needs the tag applied.
 */
export function tagged(message: string): string {
  return `${DEBUG_TAG} ${message}`;
}

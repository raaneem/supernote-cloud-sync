import type { DesktopCommandResult } from "../shared/desktop-command";
import type { RunStatus } from "./run-registry";

export const failedProcessRunStatus = (
  result: Pick<DesktopCommandResult, "cancelled" | "timedOut">,
): Exclude<RunStatus, "running" | "succeeded"> =>
  result.cancelled ? "cancelled" : result.timedOut ? "timed-out" : "failed";

export const transcriptionRunLabel = (
  notePath: string,
  pageCount: number,
): string => {
  const note = notePath.split("/").pop() || notePath;
  return `${note} · ${pageCount} page${pageCount === 1 ? "" : "s"}`;
};

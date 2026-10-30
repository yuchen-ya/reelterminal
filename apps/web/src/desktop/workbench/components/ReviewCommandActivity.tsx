import { useEffect, useMemo, useState } from "react";
import type { ReviewContext } from "@reelterminal/core/review/types";
import { installCollabEventListener, useCollabStore, type CommandActivity } from "../../../stores/collab-store";
import { ReviewRepairDraftPreview } from "./ReviewRepairDraftPreview";

const preference = "reelterminal.review.commandsOpen";
const status = (entry: CommandActivity) => entry.phase === "start" ? "运行中" : entry.ok ? entry.replayed ? "成功 · 复用回执" : "成功" : "失败";
const statusColor = (entry: CommandActivity) => entry.phase === "end" && !entry.ok ? "text-status-error" : "text-accent";

/** Uses the same endpoint activity pushes as the video's Agent status bar. */
export function ReviewCommandActivity({ target }: { target: ReviewContext["target"] }) {
  const activity = useCollabStore(state => state.commandActivity);
  const [open, setOpen] = useState(() => localStorage.getItem(preference) === "true");
  useEffect(() => installCollabEventListener(), []);
  const entries = useMemo(() => activity.filter(entry => entry.reviewTarget?.reviewWorkspaceId === target.reviewWorkspaceId
    && entry.reviewTarget.instanceId === target.instanceId && entry.reviewTarget.nodeId === target.nodeId).slice().reverse(),
  [activity, target.reviewWorkspaceId, target.instanceId, target.nodeId]);
  const latest = entries.find(entry => entry.phase === "start") ?? entries[0];

  return <><ReviewRepairDraftPreview target={target} /><details open={open} onToggle={event => {
    setOpen(event.currentTarget.open);
    localStorage.setItem(preference, String(event.currentTarget.open));
  }} className="shrink-0 border-b border-border bg-bg-1 text-[11px]" data-testid="review-command-activity">
    <summary className="flex h-8 cursor-pointer items-center gap-2 px-3 text-fg-2" data-testid="review-command-toggle">
      <span aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="shrink-0">CLI / API 命令 ({entries.length})</span>
      {latest ? <>
        <code className="min-w-0 truncate text-fg" data-testid="review-command-current">{latest.verb}</code>
        <span className={`${statusColor(latest)} shrink-0`} data-testid="review-command-current-status">{status(latest)}</span>
        <span className="min-w-0 truncate text-fg-3">{latest.argumentSummary}</span>
      </> : <span className="truncate text-fg-3">等待当前任务的命令</span>}
    </summary>
    <div className="max-h-56 overflow-auto border-t border-border" data-testid="review-command-list">
      <p className="px-3 py-1.5 text-fg-3">显示本次窗口最近 100 次调用中的当前任务命令。参数已脱敏，长列表仅显示预览。</p>
      {entries.map(entry => <details key={entry.callId} className="border-t border-border px-3 py-1.5" data-testid="review-command-entry" data-call-id={entry.callId} data-verb={entry.verb} data-state={entry.phase === "start" ? "running" : entry.ok ? "success" : "failed"}>
        <summary className="flex cursor-pointer items-center gap-2">
          <time className="shrink-0 font-mono text-fg-3" dateTime={new Date(entry.startedAt!).toISOString()}>{new Date(entry.startedAt!).toLocaleTimeString()}</time>
          <code className="min-w-0 truncate text-fg">{entry.verb}</code>
          <span className={`${statusColor(entry)} shrink-0`}>{status(entry)}</span>
          {entry.phase === "end" && entry.finishedAt !== undefined && <span className="shrink-0 text-fg-3">{Math.max(0, entry.finishedAt - entry.startedAt!)} ms</span>}
          <span className="min-w-0 truncate text-fg-3">{entry.argumentSummary}</span>
        </summary>
        {entry.phase === "end" && <p className={`mt-2 break-words ${entry.ok ? "text-fg-2" : "text-status-error"}`}>{entry.summary}</p>}
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-bg-2 p-2 font-mono text-[10px] text-fg-2" data-testid="review-command-arguments">{entry.arguments}</pre>
      </details>)}
    </div>
  </details></>;
}

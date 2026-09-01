import type { JSX } from "react";
import { useState } from "react";
import { ToolcraftButton as Button } from "@openreel/ui";
import { ChevronRight, Loader2, Check, X, Ban, Wrench } from "@/icons/lucide-compat";
import type { ToolCallView } from "../../../stores/chat-store";

const STATUS_META: Record<
  ToolCallView["status"],
  { icon: JSX.Element; tint: string; label: string }
> = {
  running: {
    icon: <Loader2 size={12} className="animate-spin" />,
    tint: "text-fg-2",
    label: "Running",
  },
  done: {
    icon: <Check size={12} />,
    tint: "text-status-success",
    label: "Done",
  },
  error: {
    icon: <X size={12} />,
    tint: "text-status-error",
    label: "Failed",
  },
  rejected: {
    icon: <Ban size={12} />,
    tint: "text-fg-muted",
    label: "Skipped",
  },
};

const MAX_VALUE_LENGTH = 60;

function formatArgValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") {
    return value.length > MAX_VALUE_LENGTH
      ? `${value.slice(0, MAX_VALUE_LENGTH)}…`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.length} items]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 0 ? "{}" : `{${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}}`;
  }
  return String(value);
}

function previewArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      const raw =
        typeof v === "string" ? v : JSON.stringify(v);
      const value = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
      return `${k}: ${value}`;
    })
    .join(", ");
}

export function ToolCallCard({ call }: { call: ToolCallView }): JSX.Element {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[call.status];
  const argEntries = Object.entries(call.args ?? {});
  const hasDetail = argEntries.length > 0 || call.result !== undefined;

  return (
    <div className="rounded-md border border-border bg-bg-1/60 text-[11px]">
      <Button
        label={`${call.name} ${meta.label}`}
        variant="ghost"
        isDisabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left disabled:cursor-default"
      >
        {hasDetail ? (
          <ChevronRight
            size={12}
            className={`shrink-0 text-fg-muted transition-transform ${open ? "rotate-90" : ""}`}
          />
        ) : (
          <Wrench size={12} className="shrink-0 text-fg-muted" />
        )}
        <span className="font-mono text-fg">{call.name}</span>
        <span className={`ml-auto flex items-center gap-1 ${meta.tint}`}>
          {meta.icon}
          <span className="text-[10px]">{meta.label}</span>
        </span>
      </Button>

      {open && hasDetail && (
        <div className="space-y-1.5 border-t border-border px-2 py-1.5">
          {argEntries.length > 0 && (
            <div>
              <div className="mb-0.5 text-[9px] uppercase tracking-wide text-fg-muted">
                Arguments
              </div>
              <div className="space-y-0.5">
                {argEntries.map(([key, value]) => (
                  <div key={key} className="flex items-baseline gap-2">
                    <span className="shrink-0 text-fg-muted">{key}</span>
                    <span className="min-w-0 break-words font-mono text-[10px] text-fg-2">
                      {formatArgValue(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {call.result && (
            <div>
              <div className="mb-0.5 text-[9px] uppercase tracking-wide text-fg-muted">
                Result
              </div>
              <div
                className={
                  call.result.ok ? "text-fg-2" : "text-status-error"
                }
              >
                {call.result.summary}
                {call.result.error && !call.result.ok
                  ? ` — ${call.result.error.message}`
                  : ""}
              </div>
            </div>
          )}
          {call.meta?.affectedIds && call.meta.affectedIds.length > 0 && (
            <div>
              <div className="mb-0.5 text-[9px] uppercase tracking-wide text-fg-muted">
                Affected
              </div>
              <div className="flex flex-wrap gap-1">
                {call.meta.affectedIds.map((id) => (
                  <span
                    key={id}
                    className="rounded bg-bg-2 px-1 py-0.5 font-mono text-[10px] text-fg-2"
                  >
                    {id}
                  </span>
                ))}
              </div>
            </div>
          )}
          {call.meta?.revision !== undefined && (
            <div className="text-[10px] text-fg-muted">
              revision {call.meta.revision}
            </div>
          )}
        </div>
      )}

      {!open && argEntries.length > 0 && (
        <div className="truncate px-2 pb-1.5 font-mono text-[10px] text-fg-muted">
          {previewArgs(call.args)}
        </div>
      )}
    </div>
  );
}

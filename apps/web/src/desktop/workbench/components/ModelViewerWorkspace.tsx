import { useEffect, useState } from "react";
import type { WorkbenchFeedbackTarget } from "@reelterminal/core/types/workbench";
import type { WorkbenchController, WorkbenchItemView } from "../types";
import { ModelPreview, type ModelCapture } from "./ModelPreview";
import { wbButton } from "../wb-button";

type ObservationTarget = Extract<WorkbenchFeedbackTarget, { kind: "model-view" }>;

export function ModelViewerWorkspace({ item, save }: { item: WorkbenchItemView; save: WorkbenchController["saveModelObservation"] }) {
  const [capture, setCapture] = useState<ModelCapture>();
  const [snapshotUrl, setSnapshotUrl] = useState<string>();
  const [restore, setRestore] = useState<{ target: ObservationTarget; version: number }>();
  const [issueId, setIssueId] = useState<string>(() => crypto.randomUUID());
  const [text, setText] = useState("");
  const [rework, setRework] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!capture) { setSnapshotUrl(undefined); return; }
    const url = URL.createObjectURL(capture.blob); setSnapshotUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [capture]);

  const snapshot = (value: ModelCapture) => { setCapture(value); setMessage(""); setError(""); };

  const submit = async () => {
    if (!capture || !save) return;
    setBusy(true); setError("");
    try {
      const result = await save({
        itemId: item.id, itemVersion: item.version, resourceId: item.modelPayload!.resourceId,
        observationId: issueId, blob: capture.blob, observation: capture.observation, text, rework
      });
      if (!result.ok) setError(result.message); else { setMessage("已保存观察反馈"); setCapture(undefined); }
    } finally { setBusy(false); }
  };

  const observations = item.feedbacks.filter(feedback => feedback.target?.kind === "model-view");
  const isCompact = observations.length === 0 && !capture && !restore;

  return (
    <div className="flex h-full min-h-0" data-testid="model-workspace">
      <div className="min-w-0 flex-1">
        <ModelPreview
          key={`${item.modelPayload!.resourceId}:${restore?.target.observationId ?? "current"}`}
          resourceId={restore?.target.resourceId ?? item.modelPayload!.resourceId}
          restore={restore?.target.observation}
          onCapture={!restore && save ? snapshot : undefined}
        />
      </div>
      <aside className={`${isCompact ? "w-[220px]" : "w-64"} shrink-0 space-y-3 overflow-y-auto border-l border-border bg-bg-1 p-3 text-xs transition-all`}>
        <div className="space-y-1">
          <p className="font-semibold text-fg">观察反馈 · v{item.version}</p>
          <p className="text-fg-3 leading-relaxed">截图绑定版本、相机与动画；新版本不继承旧面或顶点身份。</p>
        </div>

        {restore && (
          <div className="space-y-2 rounded-lg border border-border bg-bg-2/50 p-2.5">
            <p className="font-medium text-fg">正在查看保存的 v{restore.version} 观察</p>
            <img alt="保存的模型观察" src={`app://reelterminal/review-media/${restore.target.screenshotResourceId}`} className="w-full rounded border border-border" />
            <button className={wbButton.secondary} onClick={() => setRestore(undefined)}>返回当前版本</button>
          </div>
        )}

        {capture && (
          <div className="space-y-2.5 rounded-lg border border-border bg-bg-2/50 p-2.5">
            <img alt="待保存模型截图" src={snapshotUrl} className="w-full rounded border border-border" />
            <p className="text-fg-3">动画 {capture.observation.animation?.time.toFixed(3) ?? "—"} s</p>
            <textarea
              aria-label="模型观察备注"
              className="w-full rounded-[6px] border border-border bg-bg-1 p-2 text-fg focus:outline-none focus:ring-1 focus:ring-accent"
              rows={3}
              value={text}
              onChange={event => setText(event.target.value)}
              maxLength={200000}
              placeholder="请输入观察反馈..."
            />
            <label className="flex items-center gap-1.5 cursor-pointer text-fg-2">
              <input type="checkbox" className="accent-accent" checked={rework} onChange={event => setRework(event.target.checked)} />
              标记返工
            </label>
            <div className="flex items-center gap-1.5 pt-1">
              <button className={wbButton.primary} disabled={busy || !text.trim()} onClick={() => void submit()} data-testid="model-save-feedback">
                保存观察反馈
              </button>
              <button className={wbButton.ghost} disabled={busy} onClick={() => setCapture(undefined)}>
                取消
              </button>
            </div>
          </div>
        )}

        {!capture && (
          <button className={wbButton.secondary} onClick={() => { setIssueId(crypto.randomUUID()); setText(""); setRestore(undefined); setMessage("请截图创建新问题"); }}>
            新问题
          </button>
        )}

        {error && <p role="alert" className="text-status-error">{error}</p>}
        {message && <p role="status" className="text-accent">{message}</p>}

        <div className="space-y-1.5">
          {observations.map(feedback => (
            <button
              key={feedback.id}
              className="block w-full rounded-[6px] border border-border bg-bg-2/40 p-2 text-left transition hover:border-accent/40 hover:bg-bg-2"
              data-testid="model-saved-observation"
              onClick={() => {
                setCapture(undefined);
                setRestore({ target: feedback.target as ObservationTarget, version: feedback.itemVersion });
                setIssueId((feedback.target as ObservationTarget).observationId);
                setText(feedback.text);
                setRework(feedback.wantsRework);
              }}
            >
              <span className="block font-medium text-fg">v{feedback.itemVersion} · {feedback.text}</span>
              <span className="text-fg-3">{(feedback.target as ObservationTarget).observation.animation?.time.toFixed(3) ?? "—"} s</span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

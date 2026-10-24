import { useEffect, useState } from "react";
import type { WorkbenchFeedbackTarget } from "@reelterminal/core/types/workbench";
import type { WorkbenchController, WorkbenchItemView } from "../types";
import { ModelPreview, type ModelCapture } from "./ModelPreview";

const button = "rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg disabled:opacity-40";
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
      const result = await save({ itemId: item.id, itemVersion: item.version, resourceId: item.modelPayload!.resourceId,
        observationId: issueId, blob: capture.blob, observation: capture.observation, text, rework });
      if (!result.ok) setError(result.message); else { setMessage("已保存观察反馈"); setCapture(undefined); }
    } finally { setBusy(false); }
  };
  const observations = item.feedbacks.filter(feedback => feedback.target?.kind === "model-view");
  return <div className="flex h-full min-h-0" data-testid="model-workspace">
    <div className="min-w-0 flex-1"><ModelPreview key={`${item.modelPayload!.resourceId}:${restore?.target.observationId ?? "current"}`} resourceId={restore?.target.resourceId ?? item.modelPayload!.resourceId}
      restore={restore?.target.observation} onCapture={!restore && save ? snapshot : undefined} /></div>
    <aside className="w-64 shrink-0 space-y-3 overflow-auto border-l border-border p-3 text-xs">
      <p className="font-semibold">观察反馈 · v{item.version}</p><p className="text-fg-3">截图绑定版本、相机与动画；新版本不继承旧面或顶点身份。</p>
      {restore && <div><p>正在查看保存的 v{restore.version} 观察</p><img alt="保存的模型观察" src={`app://reelterminal/review-media/${restore.target.screenshotResourceId}`} className="my-2 w-full" /><button className={button} onClick={() => setRestore(undefined)}>返回当前版本</button></div>}
      {capture && <div className="space-y-2"><img alt="待保存模型截图" src={snapshotUrl} className="w-full" /><p>动画 {capture.observation.animation?.time.toFixed(3) ?? "—"} s</p><textarea aria-label="模型观察备注" className="w-full rounded border border-border bg-bg-2 p-2" value={text} onChange={event => setText(event.target.value)} maxLength={200000} /><label className="block"><input type="checkbox" checked={rework} onChange={event => setRework(event.target.checked)} />标记返工</label><button className={button} disabled={busy || !text.trim()} onClick={() => void submit()} data-testid="model-save-feedback">保存观察反馈</button><button className={`${button} ml-1`} disabled={busy} onClick={() => setCapture(undefined)}>取消</button></div>}
      {!capture && <button className={button} onClick={() => { setIssueId(crypto.randomUUID()); setText(""); setRestore(undefined); setMessage("请截图创建新问题"); }}>新问题</button>}
      {error && <p role="alert" className="text-status-error">{error}</p>}{message && <p role="status">{message}</p>}
      {observations.map(feedback => <button key={feedback.id} className="block w-full rounded border border-border p-2 text-left" data-testid="model-saved-observation" onClick={() => {
        setCapture(undefined); setRestore({ target: feedback.target as ObservationTarget, version: feedback.itemVersion }); setIssueId((feedback.target as ObservationTarget).observationId); setText(feedback.text); setRework(feedback.wantsRework);
      }}><span className="block">v{feedback.itemVersion} · {feedback.text}</span><span className="text-fg-3">{(feedback.target as ObservationTarget).observation.animation?.time.toFixed(3) ?? "—"} s</span></button>)}
    </aside>
  </div>;
}

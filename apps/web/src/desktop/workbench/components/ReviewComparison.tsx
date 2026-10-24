import { ModelPreview } from "./ModelPreview";
import { ModelComparison } from "./ModelComparison";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewContext, ReviewStep, ReviewStepReference } from "@reelterminal/core/review/types";
import { compareReviewData, compareReviewText, readReviewComparable, type ReviewComparable } from "../../../services/review-workspace/comparison";

const control = "rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg disabled:opacity-40";
export interface ComparisonSelection { reference: ReviewStepReference; step: ReviewStep; side: "input" | "output"; index: number }
export function ReviewComparison({ target, left, right }: { target: ReviewContext["target"]; left?: ComparisonSelection; right?: ComparisonSelection }) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Array<{ content?: ReviewComparable; error?: string }>>([]);
  const [zoom, setZoom] = useState(1);
  const [pixels, setPixels] = useState(false);
  const [background, setBackground] = useState("checker");
  const [imageMode, setImageMode] = useState<"side-by-side" | "slider">("side-by-side");
  const [slider, setSlider] = useState(50);
  const [held, setHeld] = useState(false);
  const [changePage, setChangePage] = useState(0);
  const scrollAreas = useRef<Array<HTMLDivElement | null>>([]);
  const synchronizing = useRef(false);
  const videos = useRef<Array<HTMLVideoElement | null>>([]);
  const mapping = left && right && left.step.id === right.step.id && left.side === "input" && right.side === "output" &&
    left.step.mapping?.inputIndex === left.index && left.step.mapping.outputIndex === right.index ? left.step.mapping : undefined;

  useEffect(() => {
    let cancelled = false;
    setValues([]); setChangePage(0); setHeld(false);
    const selections = [left, right];
    void Promise.allSettled(selections.map(selection => selection ? readReviewComparable(target, selection.reference) : Promise.resolve(undefined))).then(results => {
      if (!cancelled) setValues(results.map(result => result.status === "fulfilled" ? { content: result.value } : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) }));
    });
    return () => { cancelled = true; };
  }, [target, left, right]);
  const a = values[0]?.content;
  const b = values[1]?.content;
  const textDiff = useMemo(() => a?.kind === "text" && b?.kind === "text" ? compareReviewText(a.text, b.text) : undefined, [a, b]);
  const cells = useMemo(() => a?.kind === "data" && b?.kind === "data" ? compareReviewData(a.data, b.data) : undefined, [a, b]);
  const imagePair = a?.kind === "image" && b?.kind === "image";
  const videoPair = a?.kind === "video" && b?.kind === "video";
  const syncImages = imagePair && mapping?.kind === "image-bounds";
  const syncVideo = videoPair && mapping?.kind === "time-range";
  const backgroundStyle = background === "checker" ? { backgroundColor: "#999", backgroundImage: "conic-gradient(#ddd 25%,#aaa 0 50%,#ddd 0 75%,#aaa 0)", backgroundSize: "20px 20px" } : { backgroundColor: background };
  const synchronizeScroll = (index: number) => {
    if (!syncImages || synchronizing.current) return;
    const source = scrollAreas.current[index];
    const other = scrollAreas.current[1 - index];
    if (!source || !other) return;
    synchronizing.current = true;
    other.scrollLeft = source.scrollLeft / Math.max(1, source.scrollWidth - source.clientWidth) * (other.scrollWidth - other.clientWidth);
    other.scrollTop = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight) * (other.scrollHeight - other.clientHeight);
    requestAnimationFrame(() => { synchronizing.current = false; });
  };
  const synchronizeTime = (index: number) => {
    if (!syncVideo) return;
    const source = videos.current[index];
    const other = videos.current[1 - index];
    const ranges = [left!.reference.range!, right!.reference.range!];
    if (!source || !other) return;
    const from = ranges[index]; const to = ranges[1 - index];
    const fraction = (source.currentTime - from.startSec) / (from.endSec - from.startSec);
    const targetTime = to.startSec + Math.max(0, Math.min(1, fraction)) * (to.endSec - to.startSec);
    if (Math.abs(other.currentTime - targetTime) > 0.08) other.currentTime = targetTime;
  };
  return <div className="space-y-3" data-testid="review-comparison">
    <h3 className="text-sm font-semibold">{t("review.process.comparison")}</h3>
    {(!left || !right) && <p className="text-xs text-fg-3">{t("review.process.choosePair")}</p>}
    {(imagePair || videoPair) && <p className="text-xs text-fg-3">{t(mapping ? "review.process.mappingPresent" : "review.process.noMapping")}</p>}
    {imagePair && <div className="flex flex-wrap items-center gap-2">
      <button className={control} onClick={() => setImageMode("side-by-side")}>{t("review.process.sideBySide")}</button>
      <button className={control} disabled={!syncImages} onClick={() => setImageMode("slider")}>{t("review.process.slider")}</button>
      <label className="text-xs">{t("review.process.zoom")}<select className={control} value={zoom} onChange={event => setZoom(Number(event.target.value))}>
        {[0.25, 0.5, 1, 2, 4, 8, 16].map(value => <option key={value} value={value}>{value}×</option>)}
      </select></label>
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={pixels} onChange={event => setPixels(event.target.checked)} />{t("review.process.pixels")}</label>
      <select className={control} value={background} onChange={event => setBackground(event.target.value)} aria-label={t("review.process.background")}>
        <option value="checker">{t("review.process.checker")}</option><option value="#ffffff">{t("review.process.white")}</option><option value="#000000">{t("review.process.black")}</option>
      </select>
      <button className={control} disabled={!syncImages} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setHeld(true); }} onPointerUp={() => setHeld(false)} onPointerCancel={() => setHeld(false)}
        onKeyDown={event => { if (event.key === " ") { event.preventDefault(); setHeld(true); } }} onKeyUp={() => setHeld(false)} onBlur={() => setHeld(false)}>{t("review.process.holdInput")}</button>
      {left?.reference.region && <button className={control} onClick={() => {
        const region = left.reference.region!;
        setImageMode("side-by-side"); setZoom(4);
        requestAnimationFrame(() => {
          const area = scrollAreas.current[0];
          if (!area) return;
          area.scrollLeft = (region.x + region.width / 2) * 4 - area.clientWidth / 2;
          area.scrollTop = (region.y + region.height / 2) * 4 - area.clientHeight / 2;
          synchronizeScroll(0);
        });
      }}>{t("review.process.focusRegion")}</button>}
    </div>}
    {a?.kind === "model3d" && b?.kind === "model3d" ? <ModelComparison left={a.resourceId} right={b.resourceId} /> : imagePair && imageMode === "slider" && syncImages ? <div className="space-y-2">
      <div className="relative max-w-[720px] overflow-hidden rounded border border-border" style={{ ...backgroundStyle, aspectRatio: `${a.width}/${a.height}` }}>
        <img src={a.url} alt={t("review.process.left")} className="absolute inset-0 h-full w-full object-fill" style={{ imageRendering: pixels ? "pixelated" : "auto" }} />
        <img src={b.url} alt={t("review.process.right")} className="absolute inset-0 h-full w-full object-fill" style={{ clipPath: `inset(0 ${held ? 100 : 100 - slider}% 0 0)`, imageRendering: pixels ? "pixelated" : "auto" }} />
      </div>
      <input type="range" min={0} max={100} value={slider} onChange={event => setSlider(Number(event.target.value))} className="w-full" aria-label={t("review.process.slider")} />
    </div> : <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {[left, right].map((selection, index) => {
        const content = values[index]?.content;
        const error = values[index]?.error;
        return <section key={index} className="min-w-0 rounded-lg border border-border p-2" data-testid={`review-comparison-${index === 0 ? "left" : "right"}`}>
          <h4 className="mb-2 break-all text-xs text-fg-2">{t(index === 0 ? "review.process.left" : "review.process.right")} · {selection?.step.label} · {selection?.reference.role}</h4>
          {error ? <p role="alert" className="text-xs text-status-error">{error}</p> : !content ? <p className="text-xs text-fg-3">{t(selection ? "review.process.loading" : "review.process.unselected")}</p> :
            content.kind === "model3d" ? <div className="h-[460px]"><ModelPreview resourceId={content.resourceId} /></div> :
            content.kind === "image" ? <>
              <p className="mb-1 text-xs text-fg-3">{content.width} × {content.height}</p>
              <div className="h-96 overflow-auto" style={backgroundStyle} ref={element => { scrollAreas.current[index] = element; }} onScroll={() => synchronizeScroll(index)}>
                <div className="relative inline-block max-w-none align-top" style={{ width: content.width * zoom, height: content.height * zoom }}>
                  <img src={held && syncImages ? (a as Extract<ReviewComparable, { kind: "image" | "video" }>).url : content.url} alt={selection?.reference.role ?? ""} draggable={false} className="h-full w-full max-w-none" style={{ imageRendering: pixels ? "pixelated" : "auto" }} />
                  {pixels && zoom >= 4 && <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: "linear-gradient(to right,#8888 1px,transparent 1px),linear-gradient(to bottom,#8888 1px,transparent 1px)", backgroundSize: `${zoom}px ${zoom}px` }} />}
                  {selection?.reference.region && <div className="pointer-events-none absolute border-2 border-orange-400" style={{ left: selection.reference.region.x * zoom, top: selection.reference.region.y * zoom, width: selection.reference.region.width * zoom, height: selection.reference.region.height * zoom }} />}
                </div>
              </div>
            </> : content.kind === "video" ? <div>
              <p className="mb-1 text-xs text-fg-3">{content.width} × {content.height} · {content.durationSec.toFixed(3)} s</p>
              <video ref={element => { videos.current[index] = element; }} src={content.url} controls preload="metadata" className="max-h-96 w-full" onSeeked={() => synchronizeTime(index)} onTimeUpdate={() => { if (index === 0) synchronizeTime(0); }} />
            </div> : content.kind === "text" ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{content.text}</pre> :
              content.kind === "data" ? <div className="max-h-96 overflow-auto text-xs"><p>{content.data.rows.length} × {content.data.columns.length}</p><table><thead><tr>{content.data.columns.map(column => <th key={column.columnId} className="border border-border p-1">{column.title}</th>)}</tr></thead>
                <tbody>{content.data.rows.slice(0, 100).map(row => <tr key={row.rowId}>{content.data.columns.map(column => <td className="max-w-52 break-all border border-border p-1" key={column.columnId}>{JSON.stringify(row.cells[column.columnId])}</td>)}</tr>)}</tbody></table><p>{t("review.process.tablePreview")}</p></div> :
                <p className="break-all text-xs">{content.name} · {content.mime} · {content.size.toLocaleString()} B</p>}
        </section>;
      })}
    </div>}
    {videoPair && syncVideo && <button className={control} onClick={() => {
      const first = videos.current[0]; const second = videos.current[1];
      if (!first || !second) return;
      synchronizeTime(0);
      const input = left!.reference.range!; const output = right!.reference.range!;
      second.playbackRate = first.playbackRate * (output.endSec - output.startSec) / (input.endSec - input.startSec);
      void Promise.all([first.play(), second.play()]).catch(error => setValues(current => current.map(value => ({ ...value, error: String(error) }))));
    }}>{t("review.process.playMapped")}</button>}
    {a?.kind === "text" && b?.kind === "text" && <div className="max-h-96 overflow-auto rounded border border-border p-3 text-xs" data-testid="review-text-diff">
      {textDiff ? textDiff.map((part, index) => <pre key={index} className={`whitespace-pre-wrap break-words ${part.added ? "bg-green-500/15 text-green-400" : part.removed ? "bg-red-500/15 text-red-400" : "text-fg-2"}`}>{part.added ? "+ " : part.removed ? "− " : "  "}{part.value}</pre>) : <p>{t("review.process.diffTooLarge")}</p>}
    </div>}
    {cells && <div className="overflow-auto text-xs" data-testid="review-data-diff"><p>{t("review.process.changedCells", { count: cells.length })}</p><table className="w-full"><thead><tr><th>rowId / columnId</th><th>{t("review.process.left")}</th><th>{t("review.process.right")}</th></tr></thead>
      <tbody>{cells.slice(changePage * 100, (changePage + 1) * 100).map(cell => <tr key={`${cell.rowId}:${cell.columnId}`}><td className="break-all border border-border p-2">{cell.rowId} / {cell.columnId} · {cell.columnTitle} · {t(`review.process.${cell.kind}`)}</td><td className="break-all border border-border p-2">{cell.before === undefined ? "∅" : JSON.stringify(cell.before)}</td><td className="break-all border border-border p-2">{cell.after === undefined ? "∅" : JSON.stringify(cell.after)}</td></tr>)}</tbody></table>
      <div className="flex justify-end gap-2 py-2"><button className={control} disabled={changePage === 0} onClick={() => setChangePage(value => value - 1)}>{t("review.previous")}</button><span>{changePage + 1}</span><button className={control} disabled={(changePage + 1) * 100 >= cells.length} onClick={() => setChangePage(value => value + 1)}>{t("review.next")}</button></div>
    </div>}
  </div>;
}

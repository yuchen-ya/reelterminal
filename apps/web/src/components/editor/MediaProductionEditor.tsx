import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MediaItem } from "@reelterminal/core";
import {
  PRODUCTION_OPERATIONS,
  type MediaProduction,
  type ProductionStep,
} from "@reelterminal/core/types/media-production";
import { useProjectStore } from "../../stores/project-store";

export function MediaProductionEditor({
  item,
  onClose,
}: {
  item: MediaItem;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [record, setRecord] = useState<MediaProduction>(
    item.production ?? { status: "pending", notes: "", steps: [] },
  );
  const [error, setError] = useState("");
  const project = useProjectStore((state) => state.project);
  const [projectId] = useState(project.id);
  const [original] = useState(item.production);
  const fieldClass = "w-full rounded border border-border bg-bg-2 p-2 text-fg";
  const updateStep = (index: number, patch: Partial<ProductionStep>) =>
    setRecord({
      ...record,
      steps: record.steps.map((step, i) =>
        i === index ? { ...step, ...patch } : step,
      ),
    });
  const save = async () => {
    const store = useProjectStore.getState();
    const current = store.project.mediaLibrary.items.find(
      (media) => media.id === item.id,
    );
    if (
      store.project.id !== projectId ||
      !current ||
      JSON.stringify(current.production) !== JSON.stringify(original)
    ) {
      setError(t("production.conflict"));
      return;
    }
    const result = await store.executeAction({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: "media/setProduction",
      params: { mediaId: item.id, production: record },
    });
    if (result.success) onClose();
    else setError(result.error?.message ?? t("production.failed"));
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("production.title")}
        className="max-h-[85vh] w-[560px] overflow-y-auto rounded-lg border border-border bg-bg p-5 text-sm text-fg shadow-xl"
      >
        <h2 className="mb-3 font-semibold">
          {t("production.title")} — {item.displayName ?? item.name}
        </h2>
        <p className="mb-3 text-xs text-fg-2">{t("production.disclosure")}</p>
        {item.versionSource && (
          <p className="mb-3 text-xs">
            {t("production.previous")}:{" "}
            {project.mediaLibrary.items.find(
              (media) =>
                media.id === item.versionSource?.supersedesMediaIdInProject,
            )?.name ?? item.versionSource.supersedesMediaIdInProject}
          </p>
        )}
        <label className="mb-3 block">
          {t("production.status")}
          <select
            autoFocus
            className={fieldClass}
            value={record.status}
            onChange={(event) =>
              setRecord({
                ...record,
                status: event.target.value as MediaProduction["status"],
              })
            }
          >
            {(["pending", "adopted", "rejected"] as const).map((status) => (
              <option key={status} value={status}>
                {t(`production.${status}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="mb-3 block">
          {t("production.notes")}
          <textarea
            className={fieldClass}
            maxLength={4000}
            value={record.notes}
            onChange={(event) =>
              setRecord({ ...record, notes: event.target.value })
            }
          />
        </label>
        {record.steps.map((step, index) => (
          <fieldset
            key={index}
            className="mb-3 space-y-2 rounded border border-border p-3"
          >
            <legend>
              {t("production.step")} {index + 1}
            </legend>
            <label className="block">
              {t("production.operation")}
              <select
                className={fieldClass}
                value={step.operation}
                onChange={(event) =>
                  updateStep(index, {
                    operation: event.target
                      .value as ProductionStep["operation"],
                  })
                }
              >
                {PRODUCTION_OPERATIONS.map((operation) => (
                  <option key={operation} value={operation}>
                    {t(`production.${operation}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              {t("production.tool")}
              <input
                className={fieldClass}
                value={step.tool}
                maxLength={200}
                onChange={(event) =>
                  updateStep(index, { tool: event.target.value })
                }
              />
            </label>
            <label className="block">
              {t("production.model")}
              <input
                className={fieldClass}
                value={step.model ?? ""}
                maxLength={200}
                onChange={(event) =>
                  updateStep(index, { model: event.target.value || undefined })
                }
              />
            </label>
            <label className="block">
              {t("production.inputs")}
              <select
                multiple
                className={fieldClass}
                value={[...step.inputMediaIds]}
                onChange={(event) =>
                  updateStep(index, {
                    inputMediaIds: Array.from(
                      event.target.selectedOptions,
                      (option) => option.value,
                    ),
                  })
                }
              >
                {project.mediaLibrary.items
                  .filter((media) => media.id !== item.id)
                  .map((media) => (
                    <option key={media.id} value={media.id}>
                      {media.displayName ?? media.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={!!step.range}
                onChange={(event) =>
                  updateStep(index, {
                    range: event.target.checked
                      ? { startFrame: 0, endFrame: 1 }
                      : undefined,
                  })
                }
              />
              {t("production.range")}
            </label>
            {step.range && (
              <div className="flex gap-2">
                <label>
                  {t("production.start")}
                  <input
                    className={fieldClass}
                    type="number"
                    min={0}
                    step={1}
                    value={step.range.startFrame}
                    onChange={(event) =>
                      updateStep(index, {
                        range: {
                          ...step.range!,
                          startFrame: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  {t("production.end")}
                  <input
                    className={fieldClass}
                    type="number"
                    min={1}
                    step={1}
                    value={step.range.endFrame}
                    onChange={(event) =>
                      updateStep(index, {
                        range: {
                          ...step.range!,
                          endFrame: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
            )}
            <button
              type="button"
              onClick={() =>
                setRecord({
                  ...record,
                  steps: record.steps.filter((_, i) => i !== index),
                })
              }
            >
              {t("production.remove")}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={record.steps.length >= 100}
          onClick={() =>
            setRecord({
              ...record,
              steps: [
                ...record.steps,
                { operation: "original", tool: "", inputMediaIds: [] },
              ],
            })
          }
        >
          {t("production.addStep")}
        </button>
        {error && (
          <p role="alert" className="mt-3 text-red-400">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-3">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button
            className="rounded bg-accent px-3 py-2 text-accent-fg"
            onClick={() => void save()}
          >
            {t("projectAssets.save")}
          </button>
        </div>
      </section>
    </div>
  );
}

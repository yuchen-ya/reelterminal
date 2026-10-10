import type { JSX } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  ToolcraftButton as Button,
  ToolcraftDialog as Dialog,
  ToolcraftDialogHeader as DialogHeader,
  ToolcraftLayout as Layout,
  ToolcraftLayoutContent as LayoutContent,
  ToolcraftLayoutFooter as LayoutFooter,
  ToolcraftSelectControl as Selector,
  ToolcraftText as Text,
} from "@reelterminal/ui";
import { useSettingsStore } from "../stores/settings-store";
import type { CloseRetentionPreference } from "../stores/settings-store";

/**
 * Close-time version retention dialog (docs/VERSION-NODES-UX.md
 * 关闭应用时留存版本). The workspace save itself is mandatory and has already
 * happened before this dialog can appear; only the optional version
 * retention is decided here.
 *
 * Mounted once near the other desktop dialogs. DesktopApp opens it through
 * {@link requestCloseRetention} and awaits the user's decision.
 */

export interface CloseRetentionCandidate {
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
}

export type CloseRetentionDecision = "retain" | "close" | "cancel";

interface CloseRetentionRequest {
  candidates: readonly CloseRetentionCandidate[];
  /** Performs the retention (saveNode per candidate). Throws on failure. */
  runRetention: () => Promise<void>;
  phase: "choice" | "failed";
  resolve: (decision: CloseRetentionDecision) => void;
}

let activeRequest: CloseRetentionRequest | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = (): CloseRetentionRequest | null => activeRequest;

/**
 * Ask the user whether to retain versions before closing. Resolves with the
 * chosen action; "close" means close without retaining ("仅保存并关闭" — the
 * workspace flush has already succeeded), "cancel" aborts the close. Nothing
 * is resolved twice; a re-entrant request cancels the previous one.
 */
export function requestCloseRetention(
  candidates: readonly CloseRetentionCandidate[],
  options: {
    runRetention: () => Promise<void>;
    /** Open straight into the retention-failure state (auto-retain path). */
    startInFailure?: boolean;
  },
): Promise<CloseRetentionDecision> {
  return new Promise((resolve) => {
    if (activeRequest) activeRequest.resolve("cancel");
    activeRequest = {
      candidates,
      runRetention: options.runRetention,
      phase: options.startInFailure ? "failed" : "choice",
      resolve,
    };
    emit();
  });
}

function settle(decision: CloseRetentionDecision): void {
  const request = activeRequest;
  if (!request) return;
  activeRequest = null;
  emit();
  request.resolve(decision);
}

function enterFailedPhase(): void {
  if (!activeRequest) return;
  activeRequest = { ...activeRequest, phase: "failed" };
  emit();
}

export function CloseRetentionDialog(): JSX.Element | null {
  const { t } = useTranslation();
  const request = useSyncExternalStore(subscribe, getSnapshot);
  const [pref, setPref] = useState<CloseRetentionPreference>("ask");
  const [busy, setBusy] = useState(false);

  // Each request starts with the preference currently stored in settings;
  // the in-dialog select is only committed when an affirmative close button
  // is clicked (cancel commits nothing). Track the initialized request so a
  // phase transition (e.g. retention failure swapping in a "failed" request
  // object) does not reset what the user already picked.
  const initializedRequestRef = useRef<CloseRetentionRequest | null>(null);
  useEffect(() => {
    if (request && initializedRequestRef.current !== request) {
      initializedRequestRef.current = request;
      setPref(useSettingsStore.getState().closeRetention);
      setBusy(false);
    }
  }, [request]);

  if (!request) return null;

  const retain = async (): Promise<void> => {
    setBusy(true);
    try {
      await request.runRetention();
      useSettingsStore.getState().setCloseRetention(pref);
      settle("retain");
    } catch {
      setBusy(false);
      enterFailedPhase();
    }
  };

  const closeDirectly = (): void => {
    useSettingsStore.getState().setCloseRetention(pref);
    settle("close");
  };

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy) settle("cancel");
      }}
      width={480}
      purpose="form"
    >
      <Layout
        header={
          <DialogHeader
            closeLabel={t("Close dialog")}
            title={t("closeRetention.title")}
            onOpenChange={(open) => {
              if (!open && !busy) settle("cancel");
            }}
          />
        }
        content={
          <LayoutContent>
            <div className="space-y-4" data-testid="close-retention-dialog">
              <Text type="body" color="secondary" className="text-sm">
                {t("closeRetention.body")}
              </Text>

              {request.phase === "failed" ? (
                <Text type="body" color="danger" className="text-sm" role="alert">
                  {t("closeRetention.retainFailed")}
                </Text>
              ) : null}

              <div className="space-y-1">
                <Text type="supporting" color="secondary" className="text-xs font-medium">
                  {t("closeRetention.projectsSection")}
                </Text>
                <ul className="space-y-0.5">
                  {request.candidates.map((candidate) => (
                    <li
                      key={`${candidate.projectId}/${candidate.workspaceId}`}
                      className="text-xs text-fg-2"
                    >
                      {candidate.projectName} · {candidate.workspaceName}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-1">
                <Text type="supporting" color="secondary" className="text-xs">
                  {t("closeRetention.nextTime")}
                </Text>
                {/* ToolcraftSelectControl does not forward arbitrary data-*
                    attributes, so the test hook lives on the wrapper. */}
                <div data-testid="close-pref-select">
                  <Selector<CloseRetentionPreference>
                    ariaLabel={t("closeRetention.nextTime")}
                    label={t("closeRetention.nextTime")}
                    isLabelHidden
                    size="md"
                    width={280}
                    value={pref}
                    onChange={setPref}
                    options={[
                      { label: t("closeRetention.ask"), value: "ask" },
                      { label: t("closeRetention.auto"), value: "retain" },
                      { label: t("closeRetention.skip"), value: "skip" },
                    ]}
                  />
                </div>
              </div>
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex justify-end gap-2">
              {request.phase === "choice" ? (
                <>
                  <Button
                    label={t("common.cancel")}
                    variant="ghost"
                    onClick={() => settle("cancel")}
                    data-testid="close-cancel-button"
                  />
                  <Button
                    label={t("closeRetention.closeDirectly")}
                    variant="secondary"
                    onClick={closeDirectly}
                    isDisabled={busy}
                    data-testid="close-directly-button"
                  />
                  <Button
                    label={t("closeRetention.retainAndClose")}
                    variant="primary"
                    onClick={() => void retain()}
                    isLoading={busy}
                    data-testid="close-retain-button"
                  />
                </>
              ) : (
                <>
                  <Button
                    label={t("common.cancel")}
                    variant="ghost"
                    onClick={() => settle("cancel")}
                    data-testid="close-cancel-button"
                  />
                  <Button
                    label={t("closeRetention.saveOnlyAndClose")}
                    variant="secondary"
                    onClick={() => settle("close")}
                    data-testid="close-save-only-button"
                  />
                  <Button
                    label={t("closeRetention.retry")}
                    variant="primary"
                    onClick={() => void retain()}
                    isLoading={busy}
                    data-testid="close-retry-button"
                  />
                </>
              )}
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

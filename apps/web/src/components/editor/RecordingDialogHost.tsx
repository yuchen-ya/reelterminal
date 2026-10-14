import { useCallback } from "react";
import { ScreenRecorder } from "./ScreenRecorder";
import { useUIStore } from "../../stores/ui-store";
import { useProjectStore } from "../../stores/project-store";
import { toast } from "../../stores/notification-store";
import { getFileExtension } from "../../services/screen-recorder";

/** Shared by the web toolbar and the desktop edit page. */
export function RecordingDialogHost() {
  const activeModal = useUIStore((state) => state.activeModal);
  const closeModal = useUIStore((state) => state.closeModal);
  const projectId = useProjectStore((state) => state.project.id);
  const { importMedia } = useProjectStore();

  const handleRecordingComplete = useCallback(
    async (screenBlob: Blob, webcamBlob?: Blob) => {
      if (useProjectStore.getState().project.id !== projectId) return;
      if (!screenBlob || screenBlob.size === 0) {
        toast.error(
          "Recording failed",
          "No video data was captured. Please try again.",
        );
        return;
      }

      const timestamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:-]/g, "");
      let importCount = 0;
      const errors: string[] = [];

      const screenFile = new File([screenBlob], `Screen_${timestamp}.${getFileExtension(screenBlob.type)}`, {
        type: screenBlob.type || "video/webm",
      });
      const screenResult = await importMedia(screenFile);
      if (screenResult.success) {
        importCount++;
      } else {
        errors.push(
          screenResult.error?.message || "Failed to import screen recording",
        );
      }

      if (useProjectStore.getState().project.id !== projectId) return;
      if (webcamBlob && webcamBlob.size > 0) {
        const webcamFile = new File([webcamBlob], `Webcam_${timestamp}.${getFileExtension(webcamBlob.type)}`, {
          type: webcamBlob.type || "video/webm",
        });
        const webcamResult = await importMedia(webcamFile);
        if (webcamResult.success) {
          importCount++;
        } else {
          errors.push(
            webcamResult.error?.message || "Failed to import webcam recording",
          );
        }
      }

      if (importCount > 0) {
        toast.success(
          `${importCount} recording${importCount > 1 ? "s" : ""} imported!`,
          webcamBlob && webcamBlob.size > 0
            ? "Screen and webcam added to assets. Use the timeline to composite them."
            : "Screen recording added to assets.",
        );
      }
      if (errors.length > 0) {
        toast.error("Import failed", errors.join(". "));
      }
    },
    [importMedia, projectId],
  );

  if (activeModal !== "recorder") return null;
  return <ScreenRecorder key={projectId} isOpen onClose={closeModal} onRecordingComplete={handleRecordingComplete} />;
}

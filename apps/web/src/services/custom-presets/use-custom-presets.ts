/**
 * React binding for user-level custom presets, mirroring the custom-fonts
 * hook pattern: read a synchronous snapshot for first paint, then follow the
 * `reelterminal:custom-presets-updated` window event (fired by the service after
 * every committed change, GUI- or agent-made) and re-sync from the service.
 * Panels merge the returned records with their built-in lists; built-ins
 * stay read-only.
 */
import { useEffect, useState } from "react";
import type { PresetKind, CustomPresetRecord } from "@reelterminal/core/presets/types";
import {
  CUSTOM_PRESETS_UPDATED_EVENT,
  getCustomPresetService,
  initCustomPresets,
} from "./preset-service";

export function useCustomPresets(kind?: PresetKind): readonly CustomPresetRecord[] {
  const service = getCustomPresetService();
  const [presets, setPresets] = useState<readonly CustomPresetRecord[]>(() =>
    service.getSnapshot(kind),
  );

  useEffect(() => {
    let active = true;
    const sync = () => {
      void service.list(kind).then((result) => {
        if (active && result.ok) setPresets(result.value.presets);
      });
    };
    window.addEventListener(CUSTOM_PRESETS_UPDATED_EVENT, sync);
    void initCustomPresets().then(sync);
    return () => {
      active = false;
      window.removeEventListener(CUSTOM_PRESETS_UPDATED_EVENT, sync);
    };
  }, [service, kind]);

  return presets;
}

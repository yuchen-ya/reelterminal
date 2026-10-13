import { useEffect, useState } from "react";

import { useEngineStore } from "../../stores/engine-store";
import { useProjectStore } from "../../stores/project-store";
import { initializeMediaBridge } from "../../bridges/media-bridge";
import { initializePlaybackBridge } from "../../bridges/playback-bridge";
import { initializeRenderBridge } from "../../bridges/render-bridge";
import { initializeEffectsBridge } from "../../bridges/effects-bridge";
import { initializeTransitionBridge, syncTransitionBridgeFromProject } from "../../bridges/transition-bridge";
import {
  beginPerfOperation,
  endPerfOperation,
  failPerfOperation,
  type PerfOperation,
} from "@reelterminal/core";

export interface DesktopEditorBootstrapState {
  ready: boolean;
  error: Error | null;
}

let bootstrapPromise: Promise<void> | null = null;

const waitForEngine = (): Promise<void> => {
  const state = useEngineStore.getState();
  if (state.initialized) {
    return Promise.resolve();
  }
  if (state.initError) {
    return Promise.reject(new Error(state.initError));
  }
  return new Promise<void>((resolve, reject) => {
    const unsubscribe = useEngineStore.subscribe((next) => {
      if (next.initialized) {
        unsubscribe();
        resolve();
      } else if (next.initError) {
        unsubscribe();
        reject(new Error(next.initError));
      }
    });
  });
};

function runBootstrapStep<T>(
  phase: string,
  parent: PerfOperation | undefined,
  action: (operation: PerfOperation | undefined) => Promise<T>,
): Promise<T> {
  const operation = beginPerfOperation(phase, parent);
  if (!operation) return action(undefined);

  let result: Promise<T>;
  try {
    result = action(operation);
  } catch (error) {
    failPerfOperation(operation, error);
    throw error;
  }

  return result.then(
    (value) => {
      endPerfOperation(operation, "ok");
      return value;
    },
    (error) => {
      failPerfOperation(operation, error);
      throw error;
    },
  );
}

const runBootstrap = async (): Promise<void> => {
  const bootstrapOperation = beginPerfOperation("editor.bootstrap");
  try {
    const engineState = useEngineStore.getState();
    if (!engineState.initialized && !engineState.initializing) {
      await runBootstrapStep(
        "editor.bootstrap.engine_initialize",
        bootstrapOperation,
        (operation) => engineState.initialize(operation),
      );
    } else if (engineState.initializing) {
      await runBootstrapStep(
        "editor.bootstrap.engine_wait",
        bootstrapOperation,
        waitForEngine,
      );
    }

    const settledEngine = useEngineStore.getState();
    if (!settledEngine.initialized) {
      throw new Error(settledEngine.initError || "Engine initialization failed");
    }

    await runBootstrapStep(
      "editor.bootstrap.media_bridge",
      bootstrapOperation,
      initializeMediaBridge,
    );
    await runBootstrapStep(
      "editor.bootstrap.playback_bridge",
      bootstrapOperation,
      initializePlaybackBridge,
    );
    await runBootstrapStep(
      "editor.bootstrap.render_bridge",
      bootstrapOperation,
      initializeRenderBridge,
    );

    const { width, height } = useProjectStore.getState().project.settings;

    try {
      await runBootstrapStep(
        "editor.bootstrap.effects_bridge",
        bootstrapOperation,
        () => initializeEffectsBridge(width, height),
      );
    } catch (effectsError) {
      console.error(
        "[useDesktopEditorBootstrap] EffectsBridge initialization failed:",
        effectsError,
      );
    }

    const transitionOperation = beginPerfOperation(
      "editor.bootstrap.transition_bridge",
      bootstrapOperation,
    );
    try {
      initializeTransitionBridge(width, height);
      syncTransitionBridgeFromProject(useProjectStore.getState().project);
      endPerfOperation(transitionOperation, "ok");
    } catch (transitionError) {
      failPerfOperation(transitionOperation, transitionError);
      console.error(
        "[useDesktopEditorBootstrap] TransitionBridge initialization failed:",
        transitionError,
      );
    }

    // Enables crash recovery and feeds the desktop unsaved-changes guard.
    try {
      await runBootstrapStep(
        "editor.bootstrap.autosave",
        bootstrapOperation,
        () => useProjectStore.getState().initializeAutoSave(),
      );
    } catch (autoSaveError) {
      console.error(
        "[useDesktopEditorBootstrap] AutoSave initialization failed:",
        autoSaveError,
      );
    }
    endPerfOperation(
      bootstrapOperation,
      "ok",
      bootstrapOperation ? { width, height } : undefined,
    );
  } catch (error) {
    failPerfOperation(bootstrapOperation, error);
    throw error;
  }
};

const ensureBootstrap = (): Promise<void> => {
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().catch((error) => {
      bootstrapPromise = null;
      throw error instanceof Error ? error : new Error(String(error));
    });
  }
  return bootstrapPromise;
};

export function useDesktopEditorBootstrap(): DesktopEditorBootstrapState {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let isMounted = true;

    ensureBootstrap()
      .then(() => {
        if (isMounted) {
          setReady(true);
        }
      })
      .catch((bootstrapError: unknown) => {
        if (isMounted) {
          setError(
            bootstrapError instanceof Error
              ? bootstrapError
              : new Error(String(bootstrapError)),
          );
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  return { ready, error };
}

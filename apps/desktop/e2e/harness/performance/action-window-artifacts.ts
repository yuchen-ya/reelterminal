export const ACTION_WINDOW_PART_MAX_BYTES = 5 * 1024 * 1024;

const ACTION_WINDOW_PART_SCHEMA = "reelterminal.performance-action-windows/v1";

export interface ActionWindowArtifactReference {
  readonly artifact: string;
  readonly field: "action_windows";
  readonly part: number;
  readonly window_start: number;
  readonly window_count: number;
  readonly byte_length: number;
}

export interface ActionWindowArtifactPart {
  readonly reference: ActionWindowArtifactReference;
  readonly content: string;
}

export interface ActionWindowArtifactBundle {
  readonly descriptor: { readonly artifacts: readonly ActionWindowArtifactReference[] };
  readonly parts: readonly ActionWindowArtifactPart[];
}

/** Serialize action windows into ordered sibling JSON files below the part limit. */
export function createActionWindowArtifactParts<T>(
  windows: readonly T[],
  runId: string,
  maxPartBytes = ACTION_WINDOW_PART_MAX_BYTES,
): ActionWindowArtifactBundle {
  if (!Number.isSafeInteger(maxPartBytes) || maxPartBytes < 1) {
    throw new RangeError("action window part limit must be a positive safe integer");
  }

  const envelope = (actionWindows: readonly T[]) => ({
    schema: ACTION_WINDOW_PART_SCHEMA,
    run_id: runId,
    action_windows: actionWindows,
  });
  const emptyBytes = Buffer.byteLength(JSON.stringify(envelope([])));
  const serializedWindows = windows.map((window, index) => {
    const serialized = JSON.stringify(window);
    if (serialized === undefined) throw new TypeError(`action window ${index} is not JSON serializable`);
    const bytes = Buffer.byteLength(serialized);
    if (emptyBytes + bytes > maxPartBytes) {
      throw new RangeError(`action window ${index} requires ${emptyBytes + bytes} bytes, exceeding the ${maxPartBytes}-byte part limit`);
    }
    return { window, bytes };
  });

  const parts: ActionWindowArtifactPart[] = [];
  let current: T[] = [];
  let currentBytes = emptyBytes;
  let windowStart = 0;

  const flush = () => {
    if (current.length === 0) return;
    const part = parts.length + 1;
    const content = JSON.stringify(envelope(current));
    const byteLength = Buffer.byteLength(content);
    if (byteLength > maxPartBytes) {
      throw new Error(`action window part ${part} exceeded its ${maxPartBytes}-byte limit during serialization`);
    }
    const reference: ActionWindowArtifactReference = {
      artifact: `${runId}.action-windows-${String(part).padStart(4, "0")}.json`,
      field: "action_windows",
      part,
      window_start: windowStart,
      window_count: current.length,
      byte_length: byteLength,
    };
    parts.push({ reference, content });
    windowStart += current.length;
    current = [];
    currentBytes = emptyBytes;
  };

  for (const { window, bytes } of serializedWindows) {
    const separatorBytes = current.length === 0 ? 0 : 1;
    if (currentBytes + separatorBytes + bytes > maxPartBytes) flush();
    current.push(window);
    currentBytes += (current.length === 1 ? 0 : 1) + bytes;
  }
  flush();

  return {
    descriptor: { artifacts: parts.map(({ reference }) => reference) },
    parts,
  };
}

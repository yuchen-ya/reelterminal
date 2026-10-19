import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { readAudioEnvironment } from "./audio-environment-config";
import {
  probeAudioModelsRuntime,
  requiredAudioModelPackages,
} from "./audio-models-runner";

export type CaptionEngine = "qwen" | "sensevoice";
export interface CaptionWord {
  text: string;
  startSec: number;
  endSec: number;
  language: string;
}
export interface AlignedCaption {
  text: string;
  startSec: number;
  endSec: number;
  words: CaptionWord[];
  source: "qwen-forced-aligner";
}
export const QWEN_CAPTION_COMPONENTS = {
  asr: { repo: "Qwen/Qwen3-ASR-1.7B-hf", displayName: "Qwen ASR" },
  aligner: {
    repo: "Qwen/Qwen3-ForcedAligner-0.6B-hf",
    displayName: "Qwen ForcedAligner",
  },
  requiredPackages: [
    "torch",
    "transformers>=5.13.0",
    "soundfile",
    "numpy",
    "librosa",
  ],
  device: "cpu",
  precision: "float32",
  timestampSource: "qwen-forced-aligner",
} as const;

async function modelStatus(path: string | undefined, architecture: string) {
  if (!path)
    return {
      available: false,
      path,
      reason: "Model directory is not configured",
    };
  try {
    const config = JSON.parse(
      await readFile(join(path, "config.json"), "utf8"),
    );
    if (!config.architectures?.includes(architecture))
      throw new Error(`Expected ${architecture}`);
    for (const name of [
      "model.safetensors",
      "tokenizer.json",
      "tokenizer_config.json",
      "processor_config.json",
      "chat_template.jinja",
    ]) {
      const file = await stat(join(path, name));
      if (!file.isFile() || file.size === 0)
        throw new Error(`Missing model file: ${name}`);
    }
    const weights = await open(join(path, "model.safetensors"), "r");
    try {
      const prefix = Buffer.alloc(8);
      if ((await weights.read(prefix, 0, 8, 0)).bytesRead !== 8)
        throw new Error("Incomplete model weights");
      const length = Number(prefix.readBigUInt64LE());
      if (
        !Number.isSafeInteger(length) ||
        length < 2 ||
        length > 16 * 1024 * 1024
      )
        throw new Error("Invalid model weight header");
      const header = Buffer.alloc(length);
      if ((await weights.read(header, 0, length, 8)).bytesRead !== length)
        throw new Error("Incomplete model weight header");
      const tensors = JSON.parse(header.toString("utf8"));
      const ends = Object.entries(tensors)
        .filter(([key]) => key !== "__metadata__")
        .map(
          ([, value]) => (value as { data_offsets: number[] }).data_offsets[1]!,
        );
      if (
        !ends.length ||
        ends.some((end) => !Number.isSafeInteger(end) || end < 0) ||
        Math.max(...ends) + 8 + length !== (await weights.stat()).size
      )
        throw new Error(
          "Incomplete model weights: size does not match tensor data",
        );
    } finally {
      await weights.close();
    }
    return { available: true, path, reason: undefined };
  } catch (error) {
    return { available: false, path, reason: String(error) };
  }
}

export async function checkQwenCaptions() {
  const config = readAudioEnvironment();
  const [runtime, model, aligner] = await Promise.all([
    probeAudioModelsRuntime(
      requiredAudioModelPackages("caption-qwen"),
      "caption-qwen",
    ),
    modelStatus(config.qwenModelDir, "Qwen3ASRForConditionalGeneration"),
    modelStatus(config.qwenAlignerModelDir, "Qwen3ASRForTokenClassification"),
  ]);
  return { runtime, model, aligner };
}

/** Validate the external worker result before it can reach a project timeline. */
export function alignedWordsToCaptions(
  value: unknown,
  duration: number,
): AlignedCaption[] {
  if (!Array.isArray(value))
    throw new Error("Alignment returned no word array");
  const words: CaptionWord[] = [];
  let previousEnd = 0;
  for (const item of value) {
    if (
      !item ||
      typeof item.text !== "string" ||
      !item.text.trim() ||
      typeof item.language !== "string" ||
      !Number.isFinite(item.startSec) ||
      !Number.isFinite(item.endSec) ||
      item.startSec < 0 ||
      item.endSec < item.startSec ||
      item.startSec < previousEnd ||
      item.endSec > duration + 0.05
    ) {
      throw new Error(
        "Alignment returned invalid, overlapping or out-of-range word timestamps",
      );
    }
    const word = {
      text: item.text,
      startSec: item.startSec,
      endSec: Math.min(duration, item.endSec),
      language: item.language,
    };
    if (word.endSec < word.startSec)
      throw new Error("Alignment word is outside the audio range");
    words.push(word);
    previousEnd = word.endSec;
  }
  const captions: AlignedCaption[] = [];
  let group: CaptionWord[] = [];
  const textFor = (items: CaptionWord[]) =>
    items
      .map((word) => word.text)
      .join(
        ["Chinese", "Cantonese", "Japanese", "zh", "yue", "ja"].includes(
          items[0]!.language,
        )
          ? ""
          : " ",
      );
  const flush = () => {
    if (!group.length) return;
    if (group.at(-1)!.endSec <= group[0]!.startSec) return;
    captions.push({
      text: textFor(group),
      startSec: group[0]!.startSec,
      endSec: group.at(-1)!.endSec,
      words: group,
      source: "qwen-forced-aligner",
    });
    group = [];
  };
  for (const word of words) {
    if (
      group.length &&
      (word.startSec - group.at(-1)!.endSec > 0.6 ||
        word.endSec - group[0]!.startSec > 5 ||
        textFor([...group, word]).length > 42)
    )
      flush();
    group.push(word);
    if (/[.!?。！？]$/.test(word.text)) flush();
  }
  flush();
  if (group.length) {
    const last = captions.at(-1);
    if (!last) throw new Error("Alignment has no positive-duration speech");
    last.words.push(...group);
    last.text = textFor(last.words);
    last.endSec = group.at(-1)!.endSec;
  }
  return captions;
}

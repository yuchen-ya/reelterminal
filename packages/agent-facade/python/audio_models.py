#!/usr/bin/env python3
"""Optional local audio-model worker for ReelTerminal (AUD-07/09).

Protocol: one JSON request on stdin. The worker writes one JSON object per
stdout line:

  {"event": "progress", "percent": 0.42, "phase": "transcribe"}
  {"event": "done", "result": {...}}
  {"event": "error", "error": {"message": "...", "traceback": "..."}}

The Node side owns cancellation by killing this process; the worker never
touches project state, media roots or the network except for the explicit
model downloads funasr/modelscope perform. Model text is returned as data.

Tasks:
  probe       report import/version/CUDA availability without loading weights
  transcribe  SenseVoice-Small over caller-supplied segment boundaries
              (timestamps come from the caller's VAD, never from SenseVoice)

Only this task is part of the current product; the probe already reports which
other optional packages a later round could use, without claiming they work.
"""
import json
import os
import sys
import time
import traceback

# funasr/modelscope print progress and version banners to stdout. The protocol
# owns stdout, so redirect Python-level prints to stderr and write protocol
# lines to the real stdout descriptor captured here.
PROTOCOL_STDOUT = sys.stdout
try:
    PROTOCOL_STDOUT.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass
sys.stdout = sys.stderr


def emit(payload):
    PROTOCOL_STDOUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    PROTOCOL_STDOUT.flush()


def progress(percent, phase):
    emit({"event": "progress", "percent": max(0.0, min(1.0, float(percent))), "phase": phase})


def clean_traceback():
    return traceback.format_exc()[-4000:]


def probe(_request):
    import importlib.util

    def spec(name):
        try:
            return importlib.util.find_spec(name) is not None
        except Exception:
            return False

    packages = {
        "funasr": spec("funasr"),
        "modelscope": spec("modelscope"),
        "torch": spec("torch"),
        "torchaudio": spec("torchaudio"),
        "soundfile": spec("soundfile"),
        "numpy": spec("numpy"),
        "demucs": spec("demucs"),
        "deepfilternet": spec("deepfilternet"),
    }
    versions = {}
    if packages["funasr"]:
        import funasr
        versions["funasr"] = getattr(funasr, "__version__", "unknown")
    if packages["modelscope"]:
        import modelscope
        versions["modelscope"] = getattr(modelscope, "__version__", "unknown")
    if packages["torch"]:
        import torch
        versions["torch"] = torch.__version__
        versions["cuda"] = bool(torch.cuda.is_available())
        versions["cuda_device"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    if packages["soundfile"]:
        import soundfile
        versions["soundfile"] = soundfile.__version__
    if packages["numpy"]:
        import numpy
        versions["numpy"] = numpy.__version__
    if packages["demucs"]:
        try:
            import demucs
            versions["demucs"] = getattr(demucs, "__version__", "unknown")
        except Exception:
            versions["demucs"] = "import-failed"
    emit({"event": "done", "result": {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "packages": packages,
        "versions": versions,
        "cwd": os.getcwd(),
    }})


def _load_audio(path):
    import soundfile as sf
    pcm, sr = sf.read(path, dtype="float32", always_2d=False)
    if pcm.ndim > 1:
        pcm = pcm.mean(axis=1)
    if sr != 16000:
        raise RuntimeError(f"worker expects 16 kHz mono WAV, got {sr} Hz")
    return pcm


def _sensevoice(request):
    from funasr import AutoModel
    import numpy as np

    pcm = _load_audio(request["wavPath"])
    device = request.get("device") or ("cuda:0" if __import__("torch").cuda.is_available() else "cpu")
    model_ref = request.get("modelDir") or "iic/SenseVoiceSmall"
    progress(0.02, "load")
    started = time.time()
    asr = AutoModel(model=model_ref, device=device, disable_update=True)
    load_seconds = time.time() - started
    progress(0.15, "transcribe")
    segments = request.get("segments") or []
    language = request.get("language") or "auto"
    use_itn = bool(request.get("useItn", True))
    batch_size = 8
    texts = []
    inference_started = time.time()
    for offset in range(0, len(segments), batch_size):
        batch = segments[offset:offset + batch_size]
        chunks = []
        for segment in batch:
            start = max(0, int(round(float(segment["startSec"]) * 16000)))
            end = min(len(pcm), int(round(float(segment["endSec"]) * 16000)))
            chunks.append(np.ascontiguousarray(pcm[start:end]))
        results = asr.generate(input=chunks, cache={}, language=language, use_itn=use_itn, batch_size_s=60)
        if not isinstance(results, list):
            results = [results]
        for item in results:
            texts.append(item.get("text", "") if isinstance(item, dict) else str(item))
        progress(0.15 + 0.8 * min(1.0, (offset + len(batch)) / max(1, len(segments))), "transcribe")
    progress(0.98, "done")
    emit({"event": "done", "result": {
        "texts": texts,
        "model": model_ref,
        "device": device,
        "language": language,
        "useItn": use_itn,
        "loadSeconds": round(load_seconds, 3),
        "inferenceSeconds": round(time.time() - inference_started, 3),
    }})


TASKS = {
    "probe": probe,
    "transcribe": _sensevoice,
}


def main():
    request = json.load(sys.stdin)
    task = request.get("task")
    handler = TASKS.get(task)
    if handler is None:
        emit({"event": "error", "error": {"message": f"unknown task: {task}"}})
        return
    try:
        handler(request)
    except Exception as error:  # keep the protocol single-document per line
        emit({"event": "error", "error": {"message": str(error), "traceback": clean_traceback()}})


if __name__ == "__main__":
    main()

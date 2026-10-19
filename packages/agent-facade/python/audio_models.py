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
  diarize     CAM++ embeddings + cosine-threshold clustering over caller-supplied
              VAD segments; labels are anonymous clusters, never real identities

The remaining AUD-09 separation task is added in the next step and uses the same
one-process-per-task contract.
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
        "transformers": spec("transformers"),
        "librosa": spec("librosa"),
        "demucs": spec("demucs"),
        "deepfilternet": spec("deepfilternet"),
    }
    versions = {}
    if packages["transformers"] and _request.get("qwen"):
        import transformers
        from transformers import AutoProcessor, AutoModelForMultimodalLM, AutoModelForTokenClassification
        from transformers.models.qwen3_asr.processing_qwen3_asr import Qwen3ASRProcessor
        versions["transformers"] = transformers.__version__
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


def _load_audio(path, expected_rate=16000, mono=True):
    import soundfile as sf
    pcm, sr = sf.read(path, dtype="float32", always_2d=False)
    if mono and pcm.ndim > 1:
        pcm = pcm.mean(axis=1)
    if expected_rate is not None and sr != expected_rate:
        raise RuntimeError(f"worker expects {expected_rate} Hz audio, got {sr} Hz")
    return pcm


def verify_model_weights(path, expected):
    import hashlib
    if os.path.getsize(path) != expected["bytes"]:
        raise RuntimeError("Model weights size does not match the pinned file")
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected["sha256"]:
        raise RuntimeError("Model weights SHA256 does not match the pinned file")
    return path


def modelscope_model_directory(request):
    expected = request["expectedModel"]
    directory = request.get("modelDir")
    if not directory:
        from modelscope import snapshot_download
        directory = snapshot_download(expected["repo"])
    verify_model_weights(os.path.join(directory, expected["file"]), expected)
    return directory


def demucs_model_weights(request):
    expected = request["expectedModel"]
    path = request.get("modelWeightPath")
    if not path:
        from huggingface_hub import hf_hub_download
        path = hf_hub_download(expected["repo"], expected["file"],
                               cache_dir=os.path.join(request["cacheDir"], "hub"),
                               local_files_only=bool(request.get("offline")))
    return verify_model_weights(path, expected)


def _sensevoice(request):
    from funasr import AutoModel
    import numpy as np

    pcm = _load_audio(request["wavPath"])
    device = request.get("device") or "cpu"
    model_ref = modelscope_model_directory(request)
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


def _diarize(request):
    import numpy as np
    import torch
    from modelscope.pipelines import pipeline

    pcm = _load_audio(request["wavPath"])
    segments = request.get("segments") or []
    device = request.get("device") or ("cuda:0" if torch.cuda.is_available() else "cpu")
    model_ref = modelscope_model_directory(request)
    threshold = float(request.get("threshold", 0.7))
    max_speakers = int(request.get("maxSpeakers", 8))
    max_chunk = 10.0
    progress(0.02, "load")
    started = time.time()
    sv = pipeline(task="speaker-verification", model=model_ref, device=device)
    load_seconds = time.time() - started
    progress(0.12, "segments")
    chunks = []
    spans = []
    for index, segment in enumerate(segments):
        start = max(0.0, float(segment["startSec"]))
        end = min(len(pcm) / 16000.0, float(segment["endSec"]))
        cursor = start
        while cursor < end - 1e-6:
            chunk_end = min(end, cursor + max_chunk)
            chunks.append(np.ascontiguousarray(pcm[int(round(cursor * 16000)):int(round(chunk_end * 16000))]))
            spans.append((cursor, chunk_end, index))
            cursor = chunk_end
        if (index + 1) % 20 == 0:
            progress(0.12 + 0.08 * (index + 1) / max(1, len(segments)), "segments")
    if len(chunks) == 0:
        emit({"event": "done", "result": {"labels": [], "spans": [], "speakerCount": 0, "model": model_ref, "device": device, "threshold": threshold}})
        return
    if len(chunks) > 400:
        raise RuntimeError(f"too many diarization chunks ({len(chunks)}); analyze a shorter range or raise VAD minSpeechSec")
    embeddings = []
    batch_size = 32
    inference_started = time.time()
    with torch.no_grad():
        for offset in range(0, len(chunks), batch_size):
            batch = sv.preprocess(chunks[offset:offset + batch_size])
            embeddings.append(sv.forward(batch).detach().cpu())
            progress(0.2 + 0.7 * min(1.0, (offset + len(batch)) / max(1, len(chunks))), "embed")
    matrix = torch.nn.functional.normalize(torch.cat(embeddings, dim=0), dim=1)
    similarity = (matrix @ matrix.T).cpu().numpy()
    # Union-find at the requested cosine threshold; labels are anonymous and
    # numbered by first appearance.
    parent = list(range(len(chunks)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i in range(len(chunks)):
        for j in range(i + 1, len(chunks)):
            if float(similarity[i][j]) >= threshold:
                parent[find(j)] = find(i)
    roots = {}
    labels = []
    for index in range(len(chunks)):
        root = find(index)
        labels.append(roots.setdefault(root, len(roots)))
    if len(roots) > max_speakers:
        raise RuntimeError(f"clustering produced {len(roots)} speakers, above maxSpeakers {max_speakers}; raise maxSpeakers or the similarity threshold")
    progress(0.98, "done")
    emit({"event": "done", "result": {
        "labels": labels,
        "spans": [{"startSec": round(a, 6), "endSec": round(b, 6), "segmentIndex": s} for a, b, s in spans],
        "speakerCount": len(roots),
        "threshold": threshold,
        "maxSpeakers": max_speakers,
        "model": model_ref,
        "device": device,
        "loadSeconds": round(load_seconds, 3),
        "inferenceSeconds": round(time.time() - inference_started, 3),
    }})


def _separate(request):
    # Demucs 4.1 loads htdemucs from the Hugging Face cache; point it at the
    # dedicated optional-component cache before importing demucs.
    cache_dir = request.get("cacheDir")
    if cache_dir:
        os.environ["HF_HOME"] = cache_dir
    if request.get("offline"):
        # The pinned file is already verified locally; never wait on Hugging
        # Face HEAD requests just to discover that.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import soundfile as sf
    import torch
    from demucs.apply import apply_model, BagOfModels
    from demucs.hf import load_safetensors_model

    pcm = _load_audio(request["wavPath"], expected_rate=None, mono=False)
    # Demucs models are stereo; duplicate mono input.
    stereo = np_stereo(pcm)
    output_dir = request["outputDir"]
    os.makedirs(output_dir, exist_ok=True)
    device = request.get("device") or ("cuda" if torch.cuda.is_available() else "cpu")
    progress(0.02, "load")
    started = time.time()
    # The pinned htdemucs bag contains this single model with default weights.
    # Load the exact verified file; never resolve a mutable name or fall back
    # to the legacy remote repository after verification.
    model = BagOfModels([load_safetensors_model(demucs_model_weights(request))])
    model.to(device)
    model.eval()
    load_seconds = time.time() - started
    tensor = torch.from_numpy(stereo).unsqueeze(0)
    if device == "cuda":
        tensor = tensor.cuda()
    progress(0.2, "separate")
    inference_started = time.time()
    with torch.no_grad():
        stems = apply_model(model, tensor, device=device, shifts=1, split=True, overlap=0.25)[0]
    inference_seconds = time.time() - inference_started
    names = list(model.sources)
    outputs = []
    for index, name in enumerate(names):
        path = os.path.join(output_dir, f"{name}.wav")
        sf.write(path, stems[index].detach().cpu().numpy().T, model.samplerate, subtype="FLOAT")
        outputs.append({"stem": name, "path": path})
        progress(0.2 + 0.75 * (index + 1) / max(1, len(names)), "write")
    peak_gpu = None
    if torch.cuda.is_available():
        peak_gpu = int(torch.cuda.max_memory_allocated() / (1024 * 1024))
    peak_rss = None
    try:
        import resource
        peak_rss = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024) if os.name != "nt" else None
    except ImportError:
        peak_rss = None
    emit({"event": "done", "result": {
        "stems": outputs,
        "sampleRate": model.samplerate,
        "device": device,
        "loadSeconds": round(load_seconds, 3),
        "inferenceSeconds": round(inference_seconds, 3),
        "realtimeFactor": round(inference_seconds / max(1e-9, len(pcm) / 44100.0), 4),
        "peakGpuMemoryMb": peak_gpu,
        "peakRssMb": peak_rss,
    }})


def np_stereo(pcm):
    import numpy as np
    if pcm.ndim == 1:
        return np.stack([pcm, pcm], axis=0).astype("float32")
    if pcm.shape[1] == 1:
        return np.repeat(pcm, 2, axis=1).T.astype("float32")
    return np.ascontiguousarray(pcm[:, :2].T.astype("float32"))


def _caption(request):
    import runpy
    module = runpy.run_path(os.path.join(os.path.dirname(__file__), "caption_models.py"))
    emit({"event": "done", "result": module["run_caption"](request, progress)})


TASKS = {
    "probe": probe,
    "transcribe": _sensevoice,
    "diarize": _diarize,
    "separate": _separate,
    "caption-qwen": _caption,
    "caption-align": _caption,
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

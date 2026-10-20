"""Real pinned Demucs worker on synthetic speech + deterministic tone bed."""
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
from scipy.signal import resample_poly
import soundfile as sf

root = Path(sys.argv[1]).resolve()
config = json.loads((root / "audio-config.json").read_text(encoding="utf-8-sig"))
speech, rate = sf.read(root / "speech-19s.wav", dtype="float32")
speech = resample_poly(speech, 441, 160)
t = np.arange(len(speech)) / 44100
bed = 0.035 * (np.sin(2 * np.pi * 220 * t) + np.sin(2 * np.pi * 330 * t))
mixture = np.column_stack([speech + bed, speech + bed]).astype("float32")
wav = root / "demucs-mixture.wav"
sf.write(wav, mixture, 44100, subtype="FLOAT")
weights = next((Path(config["demucsCache"]) / "hub/models--adefossez--HTDemucs/snapshots").glob("*/955717e8.safetensors"))
request = {
    "task": "separate", "wavPath": str(wav), "outputDir": str(root / "demucs-stems"),
    "cacheDir": config["demucsCache"], "offline": True, "modelWeightPath": str(weights),
    "expectedModel": {"file": "955717e8.safetensors", "bytes": 84025440, "sha256": "d9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd"},
}
worker = Path("packages/agent-facade/python/audio_models.py").resolve()
process = subprocess.run([config["separationPython"], "-I", str(worker)], input=json.dumps(request),
                         capture_output=True, text=True, encoding="utf-8", timeout=180)
(root / "demucs-quality-worker.log").write_text(process.stdout + process.stderr, encoding="utf-8")
assert process.returncode == 0, "Worker failed; inspect retained log"
events = [json.loads(line) for line in process.stdout.splitlines()]
result = next(event["result"] for event in events if event["event"] == "done")
stems = {}
for item in result["stems"]:
    pcm, stem_rate = sf.read(item["path"], dtype="float32", always_2d=True)
    assert stem_rate == 44100 and pcm.shape == mixture.shape and np.isfinite(pcm).all()
    stems[item["stem"]] = pcm
reconstruction = sum(stems.values())
relative_error = float(np.linalg.norm(reconstruction - mixture) / np.linalg.norm(mixture))
assert relative_error < 0.15, relative_error
assert float(np.sqrt(np.mean(stems["vocals"] ** 2))) > 0.001
result["validation"] = {
    "duration_seconds": len(mixture) / 44100,
    "finite_aligned_stems": list(stems),
    "relative_reconstruction_error": relative_error,
    "rms": {name: float(np.sqrt(np.mean(pcm ** 2))) for name, pcm in stems.items()},
    "limitation": "Synthetic speech plus tones; reconstruction/non-silence do not establish music separation quality.",
}
(root / "demucs-quality-result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result["validation"], indent=2))

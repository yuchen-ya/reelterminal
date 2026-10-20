"""Offline CPU caption recognition and forced alignment; no project writes."""
import gc
import os
import time

LANGUAGES = {"zh": "Chinese", "en": "English", "yue": "Cantonese", "ja": "Japanese", "ko": "Korean"}
ALIGN_LANGUAGES = {"Chinese", "English", "Cantonese", "French", "German", "Italian", "Japanese", "Korean", "Portuguese", "Russian", "Spanish"}


def restore_word_text(transcript, aligned):
    """Alignment strips punctuation (including decimal points); preserve ASR text."""
    positions = [i for i, char in enumerate(transcript) if char.isalnum()]
    normalized = "".join(transcript[i] for i in positions).lower()
    cursor = 0
    boundary = 0
    for word in aligned:
        token = "".join(char for char in word["text"] if char.isalnum()).lower()
        if not token or normalized[cursor:cursor + len(token)] != token:
            raise ValueError("Aligned words do not match the recognized transcript")
        cursor += len(token)
        end = positions[cursor] if cursor < len(positions) else len(transcript)
        word["text"] = transcript[boundary:end].strip()
        boundary = end
    if cursor != len(positions):
        raise ValueError("Alignment omitted recognized text")
    return aligned


def audio_chunks(audio, sample_rate):
    """Keep ASR inputs short; choose a quiet boundary without duplicate samples."""
    import numpy as np
    start = 0
    while start < len(audio):
        end = min(len(audio), start + 30 * sample_rate)
        if end < len(audio):
            candidates = range(end - 2 * sample_rate, end + 1, sample_rate // 10)
            end = min(candidates, key=lambda n: float(np.mean(audio[n - sample_rate // 10:n] ** 2)))
        yield start, end
        start = end


def run_caption(request, progress):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import numpy as np
    import soundfile as sf
    import torch
    from transformers import AutoProcessor, AutoModelForMultimodalLM, AutoModelForTokenClassification

    torch.set_num_threads(min(8, os.cpu_count() or 1))
    audio, rate = sf.read(request["wavPath"], dtype="float32")
    duration = request["duration"]
    if rate != 16000 or audio.ndim != 1 or not np.isfinite(audio).all():
        raise ValueError("Captions require finite 16 kHz mono WAV audio")
    if abs(len(audio) / rate - duration) > 0.05:
        raise ValueError("Audio duration differs from the requested caption range")
    started = time.monotonic()
    if request["task"] == "caption-qwen":
        processor = AutoProcessor.from_pretrained(request["modelDir"], local_files_only=True)
        model = AutoModelForMultimodalLM.from_pretrained(request["modelDir"], local_files_only=True, dtype=torch.float32).to("cpu").eval()
        segments = []
        for start, end in audio_chunks(audio, rate):
            inputs = processor.apply_transcription_request(
                audio=audio[start:end], language=LANGUAGES.get(request["language"]),
                processor_kwargs={"sampling_rate": rate},
            ).to("cpu", torch.float32)
            with torch.inference_mode():
                output = model.generate(**inputs, max_new_tokens=512, do_sample=False)
            generated = output[:, inputs["input_ids"].shape[1]:]
            if generated.shape[1] >= 512:
                raise ValueError("ASR output reached its token limit; refusing truncated captions")
            parsed = processor.decode(generated, return_format="parsed")[0]
            if parsed["transcription"].strip():
                # An explicit language is in the input prefill, not the decoded
                # continuation. Auto mode must still use the detected language.
                language = parsed["language"] or LANGUAGES.get(request["language"])
                segments.append({"startSec": start / rate, "endSec": end / rate,
                                 "text": parsed["transcription"], "language": language})
            progress(0.65 * end / len(audio), "transcribe")
        del model, processor, inputs, output, generated
        gc.collect()
    else:
        segments = request["segments"]
    if not segments:
        return {"words": [], "device": "cpu", "elapsedSeconds": time.monotonic() - started}
    processor = AutoProcessor.from_pretrained(request["alignerDir"], local_files_only=True)
    model = AutoModelForTokenClassification.from_pretrained(request["alignerDir"], local_files_only=True, dtype=torch.float32).to("cpu").eval()
    words = []
    for index, segment in enumerate(segments):
        language = LANGUAGES.get(segment["language"], segment["language"])
        if language not in ALIGN_LANGUAGES:
            raise ValueError(f"Word alignment does not support detected language: {language}")
        start = round(segment["startSec"] * rate)
        end = round(segment["endSec"] * rate)
        inputs, word_lists = processor.prepare_forced_aligner_inputs(
            audio=audio[start:end], transcript=segment["text"], language=language,
        )
        inputs = inputs.to("cpu", torch.float32)
        with torch.inference_mode():
            output = model(**inputs)
        aligned = processor.decode_forced_alignment(
            logits=output.logits, input_ids=inputs["input_ids"], word_lists=word_lists,
            timestamp_token_id=model.config.timestamp_token_id,
        )[0]
        if not aligned:
            raise ValueError("The aligner returned no words for recognized speech")
        for word in restore_word_text(segment["text"], aligned):
            words.append({"text": word["text"], "startSec": segment["startSec"] + float(word["start_time"]),
                          "endSec": segment["startSec"] + float(word["end_time"]), "language": language})
        progress(0.65 + 0.35 * (index + 1) / len(segments), "align")
    return {"words": words, "device": "cpu", "elapsedSeconds": time.monotonic() - started}

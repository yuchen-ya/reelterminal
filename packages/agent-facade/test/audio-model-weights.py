"""Offline regression tests for first-download verification, without model runtimes."""
import hashlib
import importlib.util
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("audio_models", Path(__file__).resolve().parent.parent / "python" / "audio_models.py")
worker = importlib.util.module_from_spec(spec)
stdout = sys.stdout
spec.loader.exec_module(worker)
sys.stdout = stdout


class DownloadVerificationTests(unittest.TestCase):
    def test_downloaded_weights_are_checked_before_returning_a_loadable_path(self):
        for task, filename in [("transcribe", "model.pt"), ("diarize", "campplus_cn_common.bin"), ("separate", "955717e8.safetensors")]:
            for content in [b"valid", b"wrong", b"truncated"]:
                with self.subTest(task=task, content=content), tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / filename
                    path.write_bytes(content)
                    expected = {"repo": "fixture/model", "file": filename, "bytes": 5,
                                "sha256": hashlib.sha256(b"valid").hexdigest()}
                    request = {"expectedModel": expected, "cacheDir": directory, "offline": False}
                    modelscope = types.ModuleType("modelscope")
                    modelscope.snapshot_download = lambda repo: directory
                    hub = types.ModuleType("huggingface_hub")
                    hub.hf_hub_download = lambda *args, **kwargs: str(path)
                    with patch.dict(sys.modules, {"modelscope": modelscope, "huggingface_hub": hub}):
                        load = worker.demucs_model_weights if task == "separate" else worker.modelscope_model_directory
                        if content == b"valid":
                            self.assertEqual(load(request), str(path) if task == "separate" else directory)
                        else:
                            with self.assertRaisesRegex(RuntimeError, "pinned file"):
                                load(request)


if __name__ == "__main__":
    unittest.main()

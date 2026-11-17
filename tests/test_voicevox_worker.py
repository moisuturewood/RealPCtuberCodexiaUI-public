from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from voicevox_worker import Worker


class StyleMetadataTests(unittest.TestCase):
    def setUp(self):
        self.runtime_patch = patch("voicevox_worker.VoicevoxRuntime")
        self.runtime = self.runtime_patch.start().return_value
        self.addCleanup(self.runtime_patch.stop)
        self.lookup_patch = patch("voicevox_worker.find_model_for_style")
        self.lookup = self.lookup_patch.start()
        self.addCleanup(self.lookup_patch.stop)
        self.metadata = (Path("metan.vvm"), "四国めたん", "ノーマル")
        self.lookup.return_value = self.metadata
        self.worker = Worker(Path("core"), Path("dictionary"), "cpu", 2, "audio-query")
        self.addCleanup(self.worker.close)

    def test_repeated_style_reuses_metadata(self):
        for _ in range(100):
            self.assertEqual(self.worker.ensure_style_loaded(2), self.metadata)
        self.lookup.assert_called_once_with(Path("core"), 2)
        self.runtime.load_model.assert_called_once_with(Path("metan.vvm"))

    def test_another_style_in_loaded_model_keeps_its_own_metadata(self):
        whisper = (Path("metan.vvm"), "四国めたん", "ささやき")
        self.lookup.return_value = whisper
        self.assertEqual(self.worker.ensure_style_loaded(22), whisper)
        self.assertEqual(self.worker.ensure_style_loaded(2), self.metadata)
        self.assertEqual(self.worker.ensure_style_loaded(22), whisper)
        self.assertEqual(self.lookup.call_count, 2)
        self.runtime.load_model.assert_called_once()

    def test_lookup_failure_can_be_retried(self):
        hau = (Path("hau.vvm"), "雨晴はう", "ノーマル")
        self.lookup.side_effect = [FileNotFoundError("not found"), hau]
        with self.assertRaises(FileNotFoundError):
            self.worker.ensure_style_loaded(10)
        self.assertEqual(self.worker.ensure_style_loaded(10), hau)
        self.assertEqual(self.worker.ensure_style_loaded(10), hau)
        self.assertEqual(self.lookup.call_count, 3)

    def test_load_failure_does_not_cache_a_style(self):
        hau = (Path("hau.vvm"), "雨晴はう", "ノーマル")
        self.lookup.return_value = hau
        self.runtime.load_model.side_effect = [RuntimeError("load failed"), None]
        with self.assertRaises(RuntimeError):
            self.worker.ensure_style_loaded(10)
        self.assertEqual(self.worker.ensure_style_loaded(10), hau)
        self.assertEqual(self.worker.ensure_style_loaded(10), hau)
        self.assertEqual(self.lookup.call_count, 3)


if __name__ == "__main__":
    unittest.main()

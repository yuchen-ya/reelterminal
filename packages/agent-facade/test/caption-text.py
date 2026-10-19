import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from caption_models import restore_word_text


class CaptionTextTest(unittest.TestCase):
    def test_preserves_decimal_points_and_sentence_punctuation(self):
        words = [{"text": t} for t in ["It's", "628", "not", "314"]]
        result = restore_word_text("It's 6.28, not 3.14.", words)
        self.assertEqual([w["text"] for w in result], ["It's", "6.28,", "not", "3.14."])

    def test_preserves_chinese_punctuation(self):
        result = restore_word_text("圆周率，派。", [{"text": t} for t in "圆周率派"])
        self.assertEqual("".join(w["text"] for w in result), "圆周率，派。")

    def test_refuses_omitted_text(self):
        with self.assertRaisesRegex(ValueError, "omitted"):
            restore_word_text("hello world", [{"text": "hello"}])

    def test_refuses_changed_words(self):
        with self.assertRaisesRegex(ValueError, "do not match"):
            restore_word_text("6.28", [{"text": "314"}])


if __name__ == "__main__":
    unittest.main()

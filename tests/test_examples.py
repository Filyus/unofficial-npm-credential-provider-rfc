from __future__ import annotations

from pathlib import Path
import unittest

from tests.protocol_model import validate_transcript

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"


class ExampleTranscriptTests(unittest.TestCase):
    """Every exchange an example shows is a transcript the model accepts, so
    the examples cannot drift from the protocol."""

    def test_every_example_transcript_is_valid(self) -> None:
        transcripts = sorted(EXAMPLES.glob("*/*.jsonl"))
        self.assertTrue(transcripts, "the examples carry transcripts")
        for path in transcripts:
            with self.subTest(transcript=str(path.relative_to(EXAMPLES))):
                validate_transcript(str(path))


if __name__ == "__main__":
    unittest.main()

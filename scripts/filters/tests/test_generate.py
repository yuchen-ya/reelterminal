from pathlib import Path

import numpy as np

from scripts.filters.generate import generate_one

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN_CUBE = FIXTURES / "sample.cube"


def test_sample_generates_expected_cube(tmp_path: Path):
    cube_dir = tmp_path / "cube"
    cube_dir.mkdir()
    cube_path, _ = generate_one(FIXTURES / "sample.yaml", cube_dir)
    actual = cube_path.read_text().splitlines()
    expected = GOLDEN_CUBE.read_text().splitlines()
    assert actual[:4] == expected[:4]
    assert len(actual) == len(expected)
    # Different NumPy/platform arithmetic can round the final serialized digit
    # either way. Keep the golden numeric comparison at the six-decimal precision.
    actual_values = np.array([list(map(float, line.split())) for line in actual[4:]])
    expected_values = np.array([list(map(float, line.split())) for line in expected[4:]])
    np.testing.assert_allclose(actual_values, expected_values, rtol=0, atol=1e-6 + np.finfo(float).eps)

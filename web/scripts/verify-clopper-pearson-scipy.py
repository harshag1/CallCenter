#!/usr/bin/env python3
"""Independent SciPy oracle for the registered semantic-horizon intervals.

This script deliberately does not import the TypeScript scorer. It rebuilds all
registered n=107 Clopper-Pearson intervals and exact coverage jumps with SciPy,
then checks the public validation artifact. The TypeScript test separately
hashes its own quantized endpoint table against the digest produced here.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import scipy
from scipy.stats import beta, binom


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ARTIFACT_PATH = (
    REPOSITORY_ROOT
    / "benchmarks"
    / "voice-long-horizon"
    / "OFFLINE_NUMERICAL_VALIDATION.json"
)


def compact_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def interval(successes: int, total: int, confidence: float) -> tuple[float, float]:
    tail = (1.0 - confidence) / 2.0
    lower = 0.0 if successes == 0 else float(beta.ppf(tail, successes, total - successes + 1))
    upper = 1.0 if successes == total else float(beta.ppf(1.0 - tail, successes + 1, total - successes))
    return lower, upper


def minimum_coverage_at_jumps(
    intervals: list[tuple[float, float]],
    total: int,
) -> float:
    candidates = {0.0, 1.0}
    for lower, upper in intervals:
        for endpoint in (lower, upper):
            candidates.add(endpoint)
            candidates.add(float(np.nextafter(endpoint, -math.inf)))
            candidates.add(float(np.nextafter(endpoint, math.inf)))
    minimum = 1.0
    counts = np.arange(total + 1)
    for probability in candidates:
        if probability < 0.0 or probability > 1.0:
            continue
        mass = binom.pmf(counts, total, probability)
        coverage = sum(
            float(mass[successes])
            for successes, (lower, upper) in enumerate(intervals)
            if lower <= probability <= upper
        )
        minimum = min(minimum, coverage)
    return minimum


def main() -> None:
    artifact = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
    expected = artifact["clopper_pearson_replacement_verification"]
    total = int(expected["sample_size"])
    family_confidence = float(expected["family_confidence"])
    oracle = expected["executable_scipy_oracle"]
    decimal_places = int(oracle["endpoint_decimal_places"])

    rows: list[list[object]] = []
    coverages: list[dict[str, object]] = []
    for candidate in expected["cases"]:
        opportunities = int(candidate["opportunities"])
        confidence = float(candidate["pointwise_confidence"])
        derived_confidence = 1.0 - (1.0 - family_confidence) / opportunities
        if confidence != derived_confidence:
            raise AssertionError(
                f"pointwise confidence drift for {opportunities}: "
                f"{confidence!r} != {derived_confidence!r}"
            )
        intervals = [interval(successes, total, confidence) for successes in range(total + 1)]
        for successes, (lower, upper) in enumerate(intervals):
            rows.append(
                [
                    opportunities,
                    successes,
                    f"{lower:.{decimal_places}f}",
                    f"{upper:.{decimal_places}f}",
                ]
            )
        minimum_coverage = minimum_coverage_at_jumps(intervals, total)
        recorded_coverage = float(candidate["minimum_exact_coverage"])
        if not math.isclose(minimum_coverage, recorded_coverage, rel_tol=0.0, abs_tol=5e-12):
            raise AssertionError(
                f"coverage drift for {opportunities}: "
                f"{minimum_coverage!r} != {recorded_coverage!r}"
            )
        coverages.append(
            {
                "opportunities": opportunities,
                "minimum_exact_coverage": minimum_coverage,
            }
        )

    endpoint_table_sha256 = sha256_text(compact_json(rows))
    if endpoint_table_sha256 != oracle["endpoint_table_sha256"]:
        raise AssertionError(
            f"endpoint-table digest drift: {endpoint_table_sha256} "
            f"!= {oracle['endpoint_table_sha256']}"
        )
    if len(rows) != int(oracle["interval_rows"]):
        raise AssertionError(f"interval row count drift: {len(rows)}")

    print(
        json.dumps(
            {
                "ok": True,
                "implementation": "SciPy beta.ppf and binom.pmf",
                "scipy_version": scipy.__version__,
                "sample_size": total,
                "interval_rows": len(rows),
                "endpoint_values": len(rows) * 2,
                "endpoint_decimal_places": decimal_places,
                "endpoint_table_sha256": endpoint_table_sha256,
                "coverages": coverages,
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()

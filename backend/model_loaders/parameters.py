from typing import Any, Callable

import numpy as np


def parameter(
    label: str,
    label_mm: str,
    unit: str,
    native: str | None = None,
    cmap: str = "viridis",
    convert: Callable[[np.ndarray], np.ndarray] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    result = {
        "label": label,
        "label_mm": label_mm,
        "unit": unit,
        "native": native or unit,
        "cmap": cmap,
        "convert": convert or (lambda values: values),
    }
    if note:
        result["note"] = note
    return result

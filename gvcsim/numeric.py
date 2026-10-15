"""Numeric guards for JSON values consumed by floating-point calculations."""

from __future__ import annotations

import math
from typing import Any, TypeGuard


def finite_number(value: Any) -> TypeGuard[int | float]:
    """Reject booleans, non-finite floats and integers too large to convert to a float."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False

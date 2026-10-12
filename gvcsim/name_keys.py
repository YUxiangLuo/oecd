"""Name comparison only; never rewrite display typography or emoji.

Use per-code-point Unicode lowercase (not casefold or contextual lowercase),
matching frontend/src/name-keys.ts. This is not a visual-homoglyph detector.
"""

import re
import unicodedata
from typing import Any

# Unicode Default_Ignorable_Code_Point plus the review's blank-like characters.
_IGNORABLE = re.compile(
    "[\u00ad\u034f\u061c\u115f-\u1160\u17b4-\u17b5\u180b-\u180f"
    "\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164"
    "\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8"
    "\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]"
)


def name_key(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    return _IGNORABLE.sub("", "".join(char.lower() for char in value)).strip(
        "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005"
        "\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
    )


def required_name_key(value: str) -> str:
    key = name_key(value)
    if not key:
        raise ValueError("名称不能为空")
    return key


def normalize_academic_name(value: Any) -> Any:
    """A request's display name: trim edges, leaving typography and emoji intact."""
    return value.strip() if isinstance(value, str) else value


def username_key(value: str) -> str:
    """Login names are ASCII, case-insensitive, without Unicode compatibility aliases."""
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{2,40}", value):
        raise ValueError("用户名须为 2–40 位字母、数字、下划线、点或连字符")
    return value.lower()

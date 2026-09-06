"""Validate request text before password encoding or PostgreSQL text writes."""

from typing import Any

from pydantic import BaseModel, field_validator


class TextRequest(BaseModel):
    @field_validator("*")
    @classmethod
    def valid_text(cls, value: Any) -> Any:
        if isinstance(value, str):
            if "\x00" in value:
                raise ValueError("文本不能包含空字符 U+0000")
            try:
                value.encode("utf-8")
            except UnicodeEncodeError as error:
                raise ValueError("文本包含无效的 Unicode 字符") from error
        return value

"""Validate request text before password encoding or PostgreSQL text writes."""

from typing import Any

from pydantic import BaseModel, ValidationInfo, field_validator

from gvcsim.name_keys import required_name_key


class TextRequest(BaseModel):
    @field_validator("*")
    @classmethod
    def valid_text(cls, value: Any, info: ValidationInfo) -> Any:
        if isinstance(value, str):
            if info.field_name == "name":
                required_name_key(value)
            if "\x00" in value:
                raise ValueError("文本不能包含空字符 U+0000")
            try:
                value.encode("utf-8")
            except UnicodeEncodeError as error:
                raise ValueError("文本包含无效的 Unicode 字符") from error
        return value

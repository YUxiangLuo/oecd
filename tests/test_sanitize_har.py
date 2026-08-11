import json
import subprocess
import sys

from gvcsim.config import ROOT


SANITIZER = ROOT / "scripts" / "sanitize_har.py"


def test_browser_har_sanitizer_removes_headers_passwords_tokens_and_receipts(tmp_path):
    path = tmp_path / "browser.har"
    path.write_text(
        json.dumps(
            {
                "log": {
                    "version": "1.2",
                    "entries": [
                        {
                            "request": {
                                "url": "https://example.test/api/auth/password",
                                "headers": [
                                    {"name": "Authorization", "value": "Bearer live-token"},
                                    {"name": "Content-Type", "value": "application/json"},
                                ],
                                "cookies": [{"name": "session", "value": "cookie-value"}],
                                "postData": {
                                    "mimeType": "application/json",
                                    "text": json.dumps(
                                        {
                                            "current_password": "old-private-password",
                                            "new_password": "new-private-password",
                                            "safe": "kept",
                                        }
                                    ),
                                },
                            },
                            "response": {
                                "headers": [{"name": "Set-Cookie", "value": "session=response-cookie"}],
                                "content": {
                                    "mimeType": "application/json",
                                    "text": json.dumps(
                                        {
                                            "token": "signed-access-token",
                                            "run_id": "signed-run",
                                            "placebo_id": "signed-placebo",
                                            "safe": "kept",
                                        }
                                    ),
                                },
                            },
                        }
                    ],
                }
            }
        ),
        encoding="utf-8",
    )

    subprocess.run([sys.executable, str(SANITIZER), str(path)], check=True)

    sanitized_text = path.read_text(encoding="utf-8")
    sanitized = json.loads(sanitized_text)
    assert sanitized["log"]["_gvcsim_credentials_redacted"] is True
    for secret in (
        "live-token",
        "cookie-value",
        "response-cookie",
        "old-private-password",
        "new-private-password",
        "signed-access-token",
        "signed-run",
        "signed-placebo",
    ):
        assert secret not in sanitized_text
    assert sanitized_text.count("[REDACTED]") >= 7
    assert sanitized_text.count("kept") == 2


def test_browser_har_sanitizer_fails_closed_on_non_har_json(tmp_path):
    path = tmp_path / "not-a-har.json"
    path.write_text("{}", encoding="utf-8")

    result = subprocess.run([sys.executable, str(SANITIZER), str(path)], capture_output=True, text=True)

    assert result.returncode != 0
    assert path.read_text(encoding="utf-8") == "{}"

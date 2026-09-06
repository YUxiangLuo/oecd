"""Audit a populated student's course at three scroll positions per step.

Use an isolated account that has completed the browser course journey; this does
not seed learning records. Credentials and output directory come from GVCSIM_E2E
environment variables, as in agent_browser_course_journey.py.
"""

import json
import os
from pathlib import Path

from dogfood_sync import Browser


def main():
    base = os.environ["GVCSIM_BASE_URL"].rstrip("/")
    output = Path(os.environ["GVCSIM_E2E_ARTIFACT_DIR"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    browser = Browser("course-a11y")
    results = []
    try:
        browser.login(base, os.environ["GVCSIM_E2E_USERNAME"], os.environ["GVCSIM_E2E_PASSWORD"])
        browser.run("set", "viewport", "1200", "800")
        for step in range(1, 16):
            browser.run("open", f"{base}/?step={step}")
            browser.run("wait", "main.content")
            browser.run("wait", "--load", "networkidle")
            for position in (0, 0.5, 1):
                browser.run(
                    "eval",
                    '(() => { const pane = document.querySelector("main.content"); '
                    f'pane.scrollTo({{top:(pane.scrollHeight-pane.clientHeight)*{position},behavior:"instant"}}); }})()',
                )
                browser.run("eval", "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                audit = json.loads(browser.run("a11y", "--tags", "wcag2a,wcag2aa", "--json"))
                assert audit["success"], audit
                (output / f"{step}-{position}.json").write_text(json.dumps(audit, ensure_ascii=False))
                overflow = json.loads(browser.run(
                    "eval",
                    "document.documentElement.scrollWidth>innerWidth+1 || document.documentElement.scrollHeight>innerHeight+1",
                ))
                result = {"step": step, "position": position, "violations": len(audit["data"]["violations"]), "overflow": overflow}
                results.append(result)
                if result["violations"] or overflow:
                    browser.run("screenshot", str(output / f"{step}-{position}.png"))
            print(json.dumps(results[-3:]), flush=True)
        assert len(results) == 45 and all(not row["violations"] and not row["overflow"] for row in results), results
    finally:
        (output / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
        browser.run("close")


if __name__ == "__main__":
    main()

/** Capture the student-manual screenshots from a running local classroom (1280×960).
 *
 * Accounts come from the environment (never committed):
 *   MANUAL_BASE_URL            default http://127.0.0.1:5173 (Vite dev server proxying /api)
 *   MANUAL_STUDENT / _PASSWORD  a student whose Steps 1–14 are complete and who has no report yet
 *   MANUAL_GATE_STUDENT / _PASSWORD  a student with an incomplete course (material-gate image),
 *                                    whose Step 12 regression has not been run (pre-run image)
 *   MANUAL_TEACHER / _PASSWORD  grades the report for the "graded" image
 * The script generates and submits MANUAL_STUDENT's report and grades it, so use a test account.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchChrome, type Page } from "./manual-chrome";

const root = resolve(import.meta.dir, "../..");
const outDir = resolve(root, "docs/student-manual/screenshots");
const base = (process.env.MANUAL_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "");
const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const student = { username: need("MANUAL_STUDENT"), password: need("MANUAL_STUDENT_PASSWORD") };
const gate = { username: need("MANUAL_GATE_STUDENT"), password: need("MANUAL_GATE_STUDENT_PASSWORD") };
const teacher = { username: need("MANUAL_TEACHER"), password: need("MANUAL_TEACHER_PASSWORD") };

async function api(method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const login = async (account: { username: string; password: string }) =>
  (await api("POST", "/api/auth/login", undefined, account)).token as string;

/** Page helpers installed before the app boots; the token makes the tab signed in without the intro. */
const helpers = (token: string | null) => `
  ${token ? `sessionStorage.setItem("gvcsim_token", ${JSON.stringify(token)});` : ""}
  window.__find = (text, scope) => [...(scope || document).querySelectorAll("body *")]
    .filter((el) => el.innerText && el.innerText.includes(text))
    .sort((a, b) => a.innerText.length - b.innerText.length)[0] || null;
  window.__scroll = (el, offset) => {
    const scroller = el.closest(".content") || document.scrollingElement;
    const top = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
    scroller.scrollTo(0, Math.max(0, top));
  };
  window.__select = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
`;

const shots: { file: string; account: string; note: string }[] = [];
async function save(file: string, png: Buffer, account: string, note: string) {
  await writeFile(resolve(outDir, file), png);
  shots.push({ file, account, note });
  console.log(`captured ${file}`);
}

async function signedIn(token: string | null) {
  const page = await chrome.cdp.newPage();
  await page.addInitScript(helpers(token));
  return page;
}
/** Automatic material recording saves shortly after a page mounts (later still when its data is
 *  slow to load); wait for the outline to settle so no figure shows a transient "材料保存中" or
 *  "材料未保存" badge. */
async function settled(page: Page) {
  await Bun.sleep(1200);
  await page.waitFor(`![...document.querySelectorAll(".step-row-status")].some((el) => /保存中|未保存/.test(el.innerText))`, 20_000);
  await Bun.sleep(400);
}
async function open(page: Page, step: number | null, ready: string) {
  await page.goto(step == null ? `${base}/` : `${base}/?step=${step}`);
  await page.waitFor(ready, 45_000);
  await settled(page);
}
async function scrollTo(page: Page, finder: string, offset = 12) {
  await page.eval(`(() => { const el = ${finder}; if (!el) throw new Error("not found: " + ${JSON.stringify(finder)}); window.__scroll(el, ${offset}); return true; })()`);
  await Bun.sleep(600);
  await settled(page);
}
async function clipOf(page: Page, finder: string, pad = 12) {
  return page.eval<{ x: number; y: number; width: number; height: number }>(`(() => {
    const el = ${finder}; if (!el) throw new Error("clip target not found");
    window.__scroll(el, 40);
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}), width: r.width + ${pad * 2}, height: r.height + ${pad * 2} };
  })()`);
}

await mkdir(outDir, { recursive: true });
const chrome = await launchChrome();
try {
  const studentToken = await login(student);
  const gateToken = await login(gate);

  // Login page: public, nothing typed.
  let page = await signedIn(null);
  await open(page, null, `window.__find("进入实验平台")`);
  await save("00-login.png", await page.screenshot(), "none", "Public login page; demo prefill only in demo builds.");
  await page.close();

  // Incomplete student: material gate and the pre-run regression view.
  page = await signedIn(gateToken);
  await open(page, 15, `window.__find("还不能生成报告")`);
  await scrollTo(page, `window.__find("1 · 检查实验材料")`, 60);
  await save("15-material-gate.png", await page.screenshot(), gate.username, "Incomplete course: checklist and missing-item entry points.");
  await open(page, 12, `document.querySelector(".group-change-chart svg") && document.querySelector(".reg-run-card .run-btn")`);
  await scrollTo(page, `document.querySelector(".reg-run-card")`, 12);
  await save("11-regression-setup.png", await page.screenshot(), gate.username, "Step 12 before running: taxed vs untaxed group chart and run button.");
  await page.close();

  // Complete student: one image per step.
  page = await signedIn(studentToken);
  await open(page, 1, `window.__find("已记录的观察值") && document.querySelector("button.db-observation-cell")`);
  await scrollTo(page, `window.__find("已记录的观察值")`, 150);
  await save("01-icio.png", await page.screenshot(), student.username, "Step 1 recorded cell.");
  await scrollTo(page, `document.querySelector(".quiz-question")?.closest("section") || document.querySelector(".quiz-question")`, 20);
  await save("01-quiz.png", await page.screenshot(), student.username, "Understanding check (completed).");

  await open(page, 2, `window.__find("01 / 计算方法") && window.__find("报告材料 · 自动记录")`);
  await save("02-indicators.png", await page.screenshot(), student.username, "Step 2 method intro with task card.");
  await open(page, 3, `window.__find("02 / 动手拆解") && window.__find("分解明细")`);
  await scrollTo(page, `window.__find("02 / 动手拆解")`, 8);
  await save("03-indicators.png", await page.screenshot(), student.username, "Step 3 hands-on decomposition.");
  await open(page, 4, `window.__find("02 / 动手拆解") && window.__find("分解明细")`);
  await scrollTo(page, `window.__find("02 / 动手拆解")`, 8);
  await save("04-indicators.png", await page.screenshot(), student.username, "Step 4 length decomposition.");
  await open(page, 5, `window.__find("02 / 动手查看") && document.querySelector(".fullscreen-panel table tbody tr")`);
  await scrollTo(page, `window.__find("02 / 动手查看")`, 8);
  await save("05-indicators.png", await page.screenshot(), student.username, "Step 5 centrality table.");

  await open(page, 6, `document.querySelector('[aria-label="报告材料"]') && document.querySelector("main svg[role=img]")`);
  await save("06-visualization.png", await page.screenshot(), student.username, "Step 6 trend with automatic material.");
  await open(page, 7, `document.querySelector('[aria-label="报告材料"]') && document.querySelector("main svg[role=img]")`);
  await scrollTo(page, `window.__find("当前比较口径") || document.querySelector('[aria-label="当前比较口径"]')`, 140);
  await save("07-visualization.png", await page.screenshot(), student.username, "Step 7 production chart.");
  await open(page, 8, `document.querySelector('[aria-label="报告材料"]') && document.querySelector("main svg[role=img]")`);
  await scrollTo(page, `document.querySelector('[aria-label="当前比较口径"]')`, 140);
  await save("08-visualization.png", await page.screenshot(), student.username, "Step 8 forward/backward lengths.");
  await open(page, 9, `document.querySelector('section[aria-label="行业网络指标趋势"]')?.querySelector('svg, table')`);
  await scrollTo(page, `document.querySelector('section[aria-label="行业网络指标趋势"]')`, 8);
  await save("09-network.png", await page.screenshot(), student.username, "Step 9 two-country industry comparison.");

  await open(page, 10, `document.querySelectorAll(".shock-workbench select").length >= 3`);
  await page.eval(`(() => { const s = document.querySelectorAll(".shock-workbench select");
    window.__select(s[0], "CAN"); window.__select(s[1], "MEX"); window.__select(s[2], "C29"); return true; })()`);
  await page.waitFor(`window.__find("MEX 墨西哥 · C29") && document.querySelector(".teaching-example-summary")`);
  await Bun.sleep(2500);
  await scrollTo(page, `window.__find("选一个例子跟着走")`, 8);
  await save("10-shocks.png", await page.screenshot(), student.username, "Step 10 followed example (Canada vs Mexico, motor vehicles).");

  await open(page, 11, `document.querySelector(".verdict-card .coef-plot svg") && document.querySelector(".reg-example-effect")`);
  await scrollTo(page, `document.querySelector(".verdict-card")`, 12);
  await save("11-regression-result.png", await page.screenshot(), student.username, "Step 11 coefficient plot and reading.");

  await open(page, 15, `window.__find("你的分析 · 自动保存")`);
  await scrollTo(page, `window.__find("你的分析 · 自动保存")`, 8);
  await save("15-writing.png", await page.screenshot(), student.username, "Step 15 writing area with sentence starters.");

  // Generate → report; submit → submitted; teacher grades → graded.
  await api("POST", "/api/classroom/report/generate", studentToken, {});
  await open(page, 15, `window.__find("GVC 指标与模拟关税实验报告")`);
  await scrollTo(page, `window.__find("GVC 指标与模拟关税实验报告")`, 12);
  await save("15-report.png", await page.screenshot(), student.username, "Generated report (draft).");
  await api("POST", "/api/classroom/report/submit", studentToken);
  await open(page, 15, `window.__find("等待教师评阅")`);
  const submitted = await clipOf(page, `[...document.querySelectorAll("main *")].filter((el) => /提交于 .*等待教师评阅/.test(el.innerText || "")).sort((a, b) => a.innerText.length - b.innerText.length)[0]`);
  await save("15-submitted.png", await page.screenshot(submitted), student.username, "Submitted status line.");
  const teacherToken = await login(teacher);
  const list = await api("GET", "/api/classroom/reports", teacherToken);
  const row = (list.reports ?? list).find((item: { username: string }) => item.username === student.username);
  const detail = await api("GET", `/api/classroom/reports/${row.account_id}`, teacherToken);
  await api("POST", `/api/classroom/reports/${row.account_id}/grade`, teacherToken, {
    score: 90, feedback: "能引用具体数字说明方向与区间；局限部分可以再结合样本范围展开。", expected_updated_at: detail.updated_at,
  });
  await open(page, 15, `window.__find("教师评语")`);
  const graded = await clipOf(page, `[...document.querySelectorAll("main *")].filter((el) => /已评阅 · \\d+ 分/.test(el.innerText || "") && (el.innerText || "").includes("教师评语")).sort((a, b) => a.innerText.length - b.innerText.length)[0]`);
  await save("15-graded.png", await page.screenshot(graded), student.username, "Graded status with feedback.");
  await page.close();
} finally {
  await chrome.close();
}

const manifest = await Promise.all(shots.map(async (shot) => {
  const bytes = Buffer.from(await Bun.file(resolve(outDir, shot.file)).arrayBuffer());
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return { ...shot, width, height, sha256: createHash("sha256").update(bytes).digest("hex") };
}));
await writeFile(resolve(root, "dogfood-output/student-manual/capture.json"), JSON.stringify(manifest, null, 2)).catch(async () => {
  await mkdir(resolve(root, "dogfood-output/student-manual"), { recursive: true });
  await writeFile(resolve(root, "dogfood-output/student-manual/capture.json"), JSON.stringify(manifest, null, 2));
});
console.log(JSON.stringify(manifest.map(({ file, width, height }) => `${file} ${width}x${height}`)));

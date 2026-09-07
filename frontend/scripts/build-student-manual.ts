/** Render the editable student manual to self-contained, paginated HTML.
 * Run with Bun; export the resulting HTML using agent-browser pdf.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, process.argv[2] ?? "dogfood-output/student-manual-20260907/render/实验手册.html");
const source = await readFile(resolve(root, "实验手册.md"), "utf8");
const pages = source.split("<!-- page -->").map((page) => page.trim());
const imagePaths = [...source.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
const images = new Map<string, string>();
await Promise.all(imagePaths.map(async (path) => {
  const bytes = await readFile(resolve(root, path));
  images.set(path, `data:image/png;base64,${bytes.toString("base64")}`);
}));

const route = `<svg class="cover-route" viewBox="0 0 720 150" role="img" aria-label="数据、指标、可视化、冲击、回归、报告的实验路线">
  <path d="M60 70H660" fill="none" stroke="#a2b8c4" stroke-width="2"/>
  ${["数据", "指标", "可视化", "冲击", "回归", "报告"].map((name, index) => `<g transform="translate(${60 + 120 * index},70)"><circle r="26" fill="${index < 3 ? "#253c50" : "#15786e"}"/><text text-anchor="middle" y="5" fill="white" font-size="14">${String(index + 1).padStart(2, "0")}</text><text text-anchor="middle" y="57" fill="#263d51" font-size="17">${name}</text></g>`).join("")}
</svg>`;

const body = pages.map((markdown, index) => {
  const content = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    components: {
      img: ({ src, alt }) => createElement("img", { src: images.get(src ?? ""), alt, loading: "eager" }),
    },
    children: markdown,
  }));
  return `<section class="sheet${index === 0 ? " cover" : ""}" id="page-${index + 1}">
    <header><span>GVC SIMULATION LAB</span><span>学生实验手册 · 操作与记录</span></header>
    <article>${content}${index === 0 ? route : ""}</article>
    <footer><span>全球生产网络与国际供应链冲击</span><span>${String(index + 1).padStart(2, "0")} / ${pages.length}</span></footer>
  </section>`;
}).join("\n");

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>实验手册 · 全球生产网络与国际供应链冲击</title>
<style>
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html { background: #dce3e8; color: #243748; }
body { margin: 0; font-family: "Source Han Sans CN", "Noto Sans CJK SC", sans-serif; font-size: 9.3pt; line-height: 1.62; }
.sheet { position: relative; width: 210mm; height: 297mm; margin: 7mm auto; padding: 13mm 17mm 17mm; background: white; break-after: page; page-break-after: always; box-shadow: 0 2mm 8mm #19304320; }
.sheet:last-child { break-after: auto; page-break-after: auto; }
header { height: 9mm; display: flex; justify-content: space-between; border-bottom: .35mm solid #29475b; color: #526777; font-size: 7.5pt; letter-spacing: .04em; }
header span:first-child { font-weight: 700; letter-spacing: .12em; }
article { padding-top: 5mm; height: 251mm; }
footer { position: absolute; bottom: 8mm; left: 17mm; right: 17mm; display: flex; justify-content: space-between; border-top: .2mm solid #dbe3e9; padding-top: 2mm; color: #6a7c89; font-size: 7.2pt; }
h1, h2, h3 { line-height: 1.35; color: #183348; }
h1 { font-size: 42pt; letter-spacing: .08em; margin: 18mm 0 7mm; }
h2 { margin: 0 0 4mm; font-size: 18pt; font-weight: 700; }
h3 { font-size: 10pt; margin: 3mm 0 1.4mm; padding-left: 2.3mm; border-left: 1mm solid #158274; }
p { margin: 1.8mm 0; }
strong { font-weight: 700; }
ul, ol { margin: 1.8mm 0; padding-left: 5.6mm; }
li { margin: .7mm 0; }
li > p { margin: 0; }
blockquote { margin: 3mm 0 0; padding: 2.3mm 3.4mm; background: #eff7f5; border-left: .8mm solid #158274; color: #244f4a; }
blockquote p { margin: 0; font-size: 8.6pt; line-height: 1.58; }
p:has(> img) { margin: 2mm 0 0; text-align: center; line-height: 0; }
img { width: 100%; max-height: 131mm; object-fit: contain; object-position: center; border: .25mm solid #dce3eb; border-radius: 1.2mm; }
p:has(> em:only-child) { font-size: 7.7pt; line-height: 1.4; color: #5d7182; margin: 1.7mm 0 3.5mm; }
em { font-style: normal; }
table { border-collapse: collapse; width: 100%; margin: 3mm 0; font-size: 8.5pt; line-height: 1.5; }
th { background: #eef2f6; color: #243f52; text-align: left; }
td, th { border-bottom: .2mm solid #dce3e9; padding: 2.1mm 2.2mm; vertical-align: top; }
tr:nth-child(even) td { background: #fafbfc; }
code { font-family: "DejaVu Sans Mono", monospace; font-size: .88em; background: #eef2f5; padding: 0 .7mm; border-radius: .5mm; overflow-wrap: anywhere; }
a { color: #166e75; text-decoration: none; }
.task-list-item { list-style: none; margin-left: -4mm; padding: .8mm 0; }
input[type=checkbox] { width: 3mm; height: 3mm; accent-color: #15786e; vertical-align: middle; margin-right: 2mm; }
.cover { background: linear-gradient(160deg, #fff 58%, #f0f6f7 58%); }
.cover article { padding-top: 10mm; }
.cover h1 + p { font-size: 17pt; line-height: 1.65; max-width: 145mm; margin-bottom: 6mm; }
.cover h1 + p + p { font-size: 12pt; color: #158274; letter-spacing: .1em; margin-bottom: 12mm; }
.cover article > p:nth-of-type(3) { max-width: 151mm; font-size: 11pt; line-height: 1.9; margin-bottom: 10mm; }
.cover article > p:nth-of-type(4) { margin-top: 10mm; }
.cover article > p:nth-of-type(5) { max-width: 146mm; }
.cover-route { display: block; width: 100%; height: 44mm; margin-top: 9mm; font-family: "Source Han Sans CN", sans-serif; }
#page-2 table td:first-child { white-space: nowrap; }
#page-26 table { font-size: 9pt; }
#page-26 td, #page-26 th { padding: 2.7mm 2mm; }
#page-28 .task-list-item { margin-top: .4mm; }
@media print { html, body { background: white; } .sheet { margin: 0; box-shadow: none; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>${body}</body></html>`;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(JSON.stringify({ output, pages: pages.length, screenshots: images.size }, null, 2));

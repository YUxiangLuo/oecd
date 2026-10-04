/** Print the rendered student manual to an A4 PDF with the locally installed Chrome.
 * Fails before printing if any page's content overflows its A4 sheet.
 *
 * Usage (from the repository root):
 *   bun run frontend/scripts/export-student-manual.ts [manual.html] [output.pdf]
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchChrome } from "./manual-chrome";

const root = resolve(import.meta.dir, "../..");
const input = resolve(root, process.argv[2] ?? "dogfood-output/student-manual/render/实验手册.html");
const output = resolve(root, process.argv[3] ?? "实验手册.pdf");

const chrome = await launchChrome();
try {
  const page = await chrome.cdp.newPage(1280, 960);
  await page.goto(pathToFileURL(input).href);
  await page.eval("Promise.all([document.fonts.ready, ...Array.from(document.images).map((image) => image.decode())]).then(() => true)");
  const overflow = await page.eval<{ page: number; over: number }[]>(`[...document.querySelectorAll(".sheet")].map((sheet, index) => {
    const article = sheet.querySelector("article");
    return { page: index + 1, over: Math.round(article.scrollHeight - article.clientHeight) };
  }).filter((item) => item.over > 1)`);
  if (overflow.length) {
    throw new Error("Pages overflow their A4 sheet (page: px over): " + overflow.map((item) => `${item.page}: ${item.over}`).join(", "));
  }
  await Bun.write(output, await page.printA4());
  console.log(`A4 PDF exported: ${output}`);
} finally {
  await chrome.close();
}

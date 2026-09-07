/** Print the document already opened by agent-browser at its CSS A4 size.
 * The CLI's generic `pdf` currently defaults to Letter; this export-only CDP
 * command uses the same agent-browser session with explicit A4 options.
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const url = process.argv[2];
const output = resolve(root, process.argv[3] ?? "实验手册.pdf");
if (!url) throw new Error("Usage: bun scripts/export-student-manual.ts <document-url> [output.pdf]");
const browser = ["agent-browser", "--namespace", "student-manual-layout", "--session", "print"];
async function command(...args: string[]) {
  const process = Bun.spawn([...browser, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (status !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}
await command("open", url);
await command("wait", "--load", "networkidle");
await command("eval", "Promise.all([document.fonts.ready,...Array.from(document.images).map(i=>i.decode())]).then(()=>true)");
const socket = new WebSocket(await command("get", "cdp-url"));
let sequence = 0;
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const pending = new Map<number, Pending>();
socket.addEventListener("message", (message) => {
  const data = JSON.parse(String(message.data));
  const request = pending.get(data.id);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(data.id);
  if (data.error) request.reject(new Error(data.error.message));
  else request.resolve(data.result);
});
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("Cannot connect to the agent-browser print session")), { once: true });
});
function cdp(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
try {
  const targets = await cdp("Target.getTargets");
  const target = targets.targetInfos.find((item: { type: string; url: string }) => item.type === "page" && decodeURI(item.url) === decodeURI(new URL(url).href));
  if (!target) throw new Error("Manual page not found in the agent-browser session");
  const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const printed = await cdp("Page.printToPDF", {
    printBackground: true, preferCSSPageSize: true,
    paperWidth: 210 / 25.4, paperHeight: 297 / 25.4,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    generateTaggedPDF: true, generateDocumentOutline: true,
  }, sessionId);
  await Bun.write(output, Buffer.from(printed.data, "base64"));
  await cdp("Target.detachFromTarget", { sessionId });
  console.log(`A4 PDF exported: ${output}`);
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  socket.close();
}

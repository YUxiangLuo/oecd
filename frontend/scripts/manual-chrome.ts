/** Headless-Chrome driver for the student manual and A4 PDF export.
 * Screenshots use agent-browser; cropped status images also require ImageMagick.
 * Set CHROME_PATH to override the browser location. No extra npm packages are needed.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((path): path is string => Boolean(path));

export async function launchChrome() {
  const executable = CANDIDATES.find((path) => existsSync(path));
  if (!executable) throw new Error("Chrome not found; set CHROME_PATH");
  const profile = await mkdtemp(join(tmpdir(), "gvcsim-manual-chrome-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = Bun.spawn([
    executable, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
    "--force-color-profile=srgb", "--lang=zh-CN", "about:blank",
  ], { stdout: "ignore", stderr: "ignore" });
  let wsUrl = "";
  for (let attempt = 0; attempt < 100 && !wsUrl; attempt += 1) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await Bun.sleep(100);
    }
  }
  if (!wsUrl) throw new Error("Chrome did not expose a DevTools endpoint");
  const cdp = await Cdp.connect(wsUrl);
  return {
    cdp,
    async close() {
      cdp.close();
      chrome.kill();
      await chrome.exited;
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class Cdp {
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(message: any) => void>();

  private constructor(private socket: WebSocket, readonly endpoint: string) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id != null) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else {
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  static async connect(url: string) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(socket, url);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  once(predicate: (message: any) => boolean, timeoutMs = 60_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error("event timed out")); }, timeoutMs);
      const listener = (message: any) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message);
      };
      this.listeners.add(listener);
    });
  }

  async newPage(width = 1280, height = 960) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    return page;
  }

  close() {
    for (const request of this.pending.values()) clearTimeout(request.timer);
    this.socket.close();
  }
}

export class Page {
  constructor(private cdp: Cdp, readonly sessionId: string, readonly targetId: string) {}

  send(method: string, params: Record<string, unknown> = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  addInitScript(source: string) {
    return this.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  async goto(url: string) {
    const loaded = this.cdp.once((message) => message.sessionId === this.sessionId && message.method === "Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value as T;
  }

  /** Poll a boolean expression in the page until it is true. */
  async waitFor(expression: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.eval<boolean>(`Boolean(${expression})`).catch(() => false)) return;
      await Bun.sleep(250);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }

  async screenshot(clip?: { x: number; y: number; width: number; height: number }) {
    const dir = await mkdtemp(join(tmpdir(), "gvcsim-manual-shot-"));
    const image = join(dir, "capture.png");
    const command = async (args: string[]) => {
      const process = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
      const error = await new Response(process.stderr).text();
      if (await process.exited) throw new Error(`Screenshot command failed: ${error}`);
    };
    try {
      // Keep each page's selected tab independent when screenshots run concurrently.
      const browser = ["agent-browser", "--session", `manual-capture-${this.targetId}`, "--cdp", this.cdp.endpoint];
      await command([...browser, "tab", this.targetId]);
      await command([...browser, "screenshot", image]);
      if (clip) {
        const { x, y, width, height } = clip;
        await command(["magick", image, "-crop", `${Math.ceil(width)}x${Math.ceil(height)}+${Math.floor(x)}+${Math.floor(y)}`, "+repage", image]);
      }
      return await readFile(image);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async printA4() {
    const printed = await this.send("Page.printToPDF", {
      printBackground: true, preferCSSPageSize: true,
      paperWidth: 210 / 25.4, paperHeight: 297 / 25.4,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      generateTaggedPDF: true, generateDocumentOutline: true,
    });
    return Buffer.from(printed.data, "base64");
  }

  close() {
    return this.cdp.send("Target.closeTarget", { targetId: this.targetId });
  }
}

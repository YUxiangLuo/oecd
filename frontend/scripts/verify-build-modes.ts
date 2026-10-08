const customDemoPassword = "gvcsim-demo-build-boundary-check-2026";
const productionForbidden = [
  "gvclab2026",
  customDemoPassword,
  "演示账号快捷登录",
  "学生身份",
  "教师身份",
  "已为你预填一个空闲的演示学生账号",
];
const demoRequired = [
  customDemoPassword,
  "演示账号快捷登录",
  "学生身份",
  "教师身份",
  "已为你预填一个空闲的演示学生账号",
];

async function runBuild(script: "build" | "build:demo", extraEnv: Record<string, string> = {}): Promise<void> {
  const child = Bun.spawn(["bun", "run", script], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, ...extraEnv },
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${script} failed with exit code ${status}`);
}

async function bundleText(): Promise<string> {
  const root = import.meta.dir + "/../dist";
  const files = [
    ...await Array.fromAsync(new Bun.Glob("**/*.js").scan({ cwd: root, onlyFiles: true })),
    ...await Array.fromAsync(new Bun.Glob("**/*.html").scan({ cwd: root, onlyFiles: true })),
  ];
  return (await Promise.all(files.map((file) => Bun.file(`${root}/${file}`).text()))).join("\n");
}

function requireAbsent(text: string, markers: string[], label: string): void {
  const found = markers.filter((marker) => text.includes(marker));
  if (found.length) throw new Error(`${label} unexpectedly contains demo markers: ${found.join(", ")}`);
}

function requirePresent(text: string, markers: string[], label: string): void {
  const missing = markers.filter((marker) => !text.includes(marker));
  if (missing.length) throw new Error(`${label} is missing demo markers: ${missing.join(", ")}`);
}

await runBuild("build");
requireAbsent(await bundleText(), productionForbidden, "production bundle");

try {
  await runBuild("build:demo", { VITE_DEMO_PASSWORD: customDemoPassword });
  const demo = await bundleText();
  requirePresent(demo, demoRequired, "demo bundle");
  requireAbsent(demo, ["gvclab2026"], "custom-password demo bundle");
} finally {
  // Leave dist in the normal production state for the following CI/browser jobs.
  await runBuild("build");
}

requireAbsent(await bundleText(), productionForbidden, "restored production bundle");
console.log("production/demo build boundary verified");

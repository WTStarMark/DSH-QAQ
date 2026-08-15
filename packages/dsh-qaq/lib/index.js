import { join } from "node:path";
import { copyFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
const name = "dsh-qaq";
const QAQ_DIR = ".qaq";
const KEEP = 5;
const FILES = ["package.json", "cordis.patch.yml"];
function newTimestamp() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
}
function prune(historyDir, keep) {
  let names;
  try {
    names = readdirSync(historyDir);
  } catch {
    return;
  }
  names.sort((a, b) => a < b ? 1 : a > b ? -1 : 0);
  for (const n of names.slice(keep)) {
    try {
      rmSync(join(historyDir, n), { recursive: true, force: true });
    } catch {
    }
  }
}
function writeSnapshotHome(home, profileName, profileDir) {
  const root = join(home, QAQ_DIR);
  mkdirSync(join(root, "latest-good"), { recursive: true });
  mkdirSync(join(root, "history"), { recursive: true });
  const ts = newTimestamp();
  mkdirSync(join(root, "history", ts), { recursive: true });
  for (const f of FILES) {
    const src = join(profileDir, f);
    if (existsSync(src)) {
      copyFileSync(src, join(root, "latest-good", f));
      copyFileSync(src, join(root, "history", ts, f));
    }
  }
  writeFileSync(join(root, "latest-good", "manifest.json"), JSON.stringify({ profile: profileName, ts: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), "utf8");
  prune(join(root, "history"), KEEP);
}
function apply(ctx) {
  const home = resolveDshHome();
  const profileName = process.env.QAQ_PROFILE ?? inferProfileName(ctx) ?? "web";
  const profileDir = join(home, "profiles", profileName);
  const settle = ctx.get("loader")?.await?.();
  if (settle === void 0) {
    if (existsSync(join(profileDir, "package.json"))) writeSnapshotHome(home, profileName, profileDir);
    return;
  }
  void settle.then(() => {
    if (existsSync(join(profileDir, "package.json"))) writeSnapshotHome(home, profileName, profileDir);
  }).catch(() => {
  });
}
function inferProfileName(ctx) {
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const m = cwd.match(/profiles[\\/]([^\\/]+)/);
  return m ? m[1] : null;
}
export {
  apply,
  name
};

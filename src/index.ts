import type { Plugin } from "@opencode-ai/plugin";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

type Mode = "win" | "wsl";

export interface WslWinToolsOptions {
  default?: Mode;
  tools?: Record<string, Mode>;
  translatePaths?: boolean;
  onlyUnderMnt?: boolean;
  debug?: boolean;
}

const FALLBACK_JSON = join(homedir(), ".config", "opencode", "wsl-win-tools.json");

// base tool -> windows exe
const EXE_MAP: Record<string, string> = {
  git: "git.exe",
  "git-lfs": "git-lfs.exe",
  gh: "gh.exe",
  cargo: "cargo.exe",
  rustc: "rustc.exe",
  rustup: "rustup.exe",
  node: "node.exe",
  npm: "npm.exe",
  npx: "npx.exe",
  yarn: "yarn.exe",
  pnpm: "pnpm.exe",
  bun: "bun.exe",
  deno: "deno.exe",
  python: "python.exe",
  python3: "python.exe",
  pip: "pip.exe",
  pip3: "pip.exe",
  uv: "uv.exe",
  ruff: "ruff.exe",
};

const DEFAULT_TOOLS: Record<string, Mode> = {
  git: "win",
  "git-lfs": "win",
  gh: "win",
  cargo: "win",
  rustc: "win",
  rustup: "win",
  node: "wsl",
  npm: "wsl",
  npx: "wsl",
  yarn: "wsl",
  pnpm: "wsl",
  bun: "wsl",
  deno: "wsl",
  python: "win",
  python3: "win",
  pip: "win",
  pip3: "win",
  uv: "win",
  ruff: "win",
};

// prefixes to skip when looking for the binary (sudo, env, VAR=x, command, time, nice...)
const SKIP_TOKENS = new Set(["sudo", "command", "time", "nice", "env", "nohup", "xargs"]);

function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const v = readFileSync("/proc/version", "utf8").toLowerCase();
    return v.includes("microsoft") || v.includes("wsl");
  } catch {
    return false;
  }
}

async function loadFallbackJson(): Promise<WslWinToolsOptions> {
  try {
    if (!existsSync(FALLBACK_JSON)) return {};
    const raw = await readFile(FALLBACK_JSON, "utf8").catch(() => "");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed as WslWinToolsOptions;
  } catch {
    return {};
  }
}

function resolveConfig(options?: Record<string, unknown>, fallback: WslWinToolsOptions = {}): Required<WslWinToolsOptions> {
  const o = (options ?? {}) as WslWinToolsOptions;
  return {
    default: o.default ?? fallback.default ?? "wsl",
    tools: { ...DEFAULT_TOOLS, ...(fallback.tools ?? {}), ...(o.tools ?? {}) },
    translatePaths: o.translatePaths ?? fallback.translatePaths ?? true,
    onlyUnderMnt: o.onlyUnderMnt ?? fallback.onlyUnderMnt ?? false,
    debug: o.debug ?? fallback.debug ?? false,
  };
}

function modeFor(tool: string, cfg: Required<WslWinToolsOptions>): Mode {
  return cfg.tools[tool] ?? cfg.default;
}

// Split command into segments on shell operators, respecting quotes.
// Returns array of { text, isOperator } parts so we can rewrite each segment's head.
function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let esc = false;
  const push = () => {
    out.push(cur);
    cur = "";
  };
  const ops = ["&&", "||", ";;", "<<", ">>", "|", ";", "&", "(", ")", "\n"];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (esc) {
      cur += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      cur += c;
      esc = true;
      continue;
    }
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      q = c;
      cur += c;
      continue;
    }
    let matched: string | null = null;
    for (const op of ops) {
      if (cmd.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      push();
      out.push(matched);
      i += matched.length - 1;
    } else {
      cur += c;
    }
  }
  push();
  return out;
}

const OP_SET = new Set(["&&", "||", ";;", "<<", ">>", "|", ";", "&", "(", ")", "\n", ""]);

// Tokenize a segment respecting quotes (keeps quote chars so we can re-emit safely).
function tokenize(seg: string): string[] {
  const toks: string[] = [];
  let cur = "";
  let q: string | null = null;
  let esc = false;
  let started = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (esc) {
      cur += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      cur += c;
      esc = true;
      started = true;
      continue;
    }
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      started = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (started) {
        toks.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started || cur) toks.push(cur);
  return toks;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function quoteWin(p: string): string {
  if (/^".*"$/.test(p)) return p;
  if (/[\s&()^!]/.test(p)) return `"${p.replace(/"/g, '""')}"`;
  return p;
}

function manualMntToWin(p: string): string | null {
  const m = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
  return null;
}

function looksLikeAbsPath(arg: string): boolean {
  const s = stripQuotes(arg);
  if (!s) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return false; // already windows
  if (s.startsWith("/mnt/") || s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s === "." || s === "..") return true;
  if (s.startsWith("~/") || s === "~") return true;
  return false;
}

export const WslWinTools = (async ({ client, $, directory }, options) => {
  if (!isWSL()) return {};
  const fallback = await loadFallbackJson();
  const cfg = resolveConfig(options, fallback);

  const exeCache = new Map<string, boolean>();
  const pathCache = new Map<string, string>();
  const warned = new Set<string>();

  async function exeExists(exe: string): Promise<boolean> {
    if (exeCache.has(exe)) return exeCache.get(exe)!;
    try {
      await $`sh -c ${`command -v ${exe}`}`.quiet().text();
      exeCache.set(exe, true);
      return true;
    } catch {
      exeCache.set(exe, false);
      return false;
    }
  }

  async function toWinPath(p: string): Promise<string> {
    if (pathCache.has(p)) return pathCache.get(p)!;
    const raw = stripQuotes(p);
    let win: string;
    try {
      const out = (await $`wslpath -w ${raw}`.quiet().text()).trim();
      win = out || manualMntToWin(raw) || p;
    } catch {
      win = manualMntToWin(raw) || p;
    }
    const quoted = quoteWin(win);
    pathCache.set(p, quoted);
    return quoted;
  }

  async function warnOnce(msg: string) {
    if (warned.has(msg)) return;
    warned.add(msg);
    try {
      await client.app.log({ body: { service: "wsl-win-tools", level: "warn", message: msg } });
    } catch {
      // ignore
    }
  }

  async function debug(msg: string) {
    if (!cfg.debug) return;
    try {
      await client.app.log({ body: { service: "wsl-win-tools", level: "info", message: msg } });
    } catch {
      // ignore
    }
  }

  async function rewriteSegment(seg: string): Promise<string> {
    if (!seg.trim()) return seg;
    const toks = tokenize(seg);
    if (toks.length === 0) return seg;

    // find binary index skipping prefixes and VAR=x assignments
    let binIdx = -1;
    for (let i = 0; i < toks.length; i++) {
      const bare = stripQuotes(toks[i]);
      if (!bare) continue;
      if (SKIP_TOKENS.has(bare)) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(bare)) continue;
      if (bare.startsWith("-")) continue;
      binIdx = i;
      break;
    }
    if (binIdx === -1) return seg;

    let base = stripQuotes(toks[binIdx]);
    // already an exe -> only translate paths
    const alreadyExe = base.toLowerCase().endsWith(".exe");
    if (alreadyExe) base = base.replace(/\.exe$/i, "");

    const exe = EXE_MAP[base];
    if (!exe) return seg; // not a managed tool

    const wantWin = alreadyExe || modeFor(base, cfg) === "win";
    if (!wantWin) return seg;

    if (!(await exeExists(exe))) {
      await warnOnce(`wsl-win-tools: ${exe} not found in PATH, using WSL ${base}`);
      return seg;
    }

    const leading = seg.match(/^\s*/)?.[0] ?? "";
    const trailing = seg.match(/\s*$/)?.[0] ?? "";
    const rest = toks.slice(binIdx + 1);

    const outToks = [...toks.slice(0, binIdx), exe];
    if (cfg.translatePaths) {
      for (const t of rest) {
        const bare = stripQuotes(t);
        // --flag=value form: translate value if path-like
        const eq = t.indexOf("=");
        if (eq > 0 && t.startsWith("-")) {
          const val = t.slice(eq + 1);
          if (looksLikeAbsPath(val)) outToks.push(`${t.slice(0, eq + 1)}${await toWinPath(val)}`);
          else outToks.push(t);
        } else if (bare.startsWith("-") || !looksLikeAbsPath(t)) {
          outToks.push(t);
        } else {
          outToks.push(await toWinPath(t));
        }
      }
    } else {
      outToks.push(...rest);
    }

    const rewritten = leading + outToks.join(" ") + trailing;
    await debug(`wsl-win-tools: '${seg.trim()}' -> '${rewritten.trim()}'`);
    return rewritten;
  }

  async function rewriteCommand(cmd: string, cwd: string): Promise<string> {
    if (cfg.onlyUnderMnt && !cwd.startsWith("/mnt/")) return cmd;
    // quick exit if no managed tool name appears
    const names = Object.keys(EXE_MAP).join("|");
    if (!new RegExp(`(^|[\\s;&|(\`'"])(${names})(\\s|$|\\.|\\.exe)`, "i").test(cmd)) return cmd;
    const parts = splitSegments(cmd);
    const out: string[] = [];
    for (const p of parts) {
      if (OP_SET.has(p)) out.push(p);
      else out.push(await rewriteSegment(p));
    }
    return out.join("");
  }

  return {
    "tool.execute.before": async (input, output) => {
      try {
        if (input.tool !== "bash") return;
        const cmd = output.args?.command;
        if (typeof cmd !== "string" || !cmd) return;
        const cwd = output.args?.cwd ?? output.args?.worktree ?? directory ?? "";
        output.args.command = await rewriteCommand(cmd, cwd);
      } catch (e) {
        await warnOnce(`wsl-win-tools error: ${String(e)}`);
      }
    },
  };
}) satisfies Plugin;

export default WslWinTools;

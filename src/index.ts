import type { Plugin } from "@opencode-ai/plugin";
import { readFileSync, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

type Mode = "win" | "wsl";

export interface FallbackOptions {
  /** Preferred win but .exe missing -> keep WSL binary (default true). */
  winToWsl?: boolean;
  /** Preferred wsl but binary missing -> use .exe if present (default true). */
  wslToWin?: boolean;
}

export interface WslWinToolsOptions {
  default?: Mode;
  tools?: Record<string, Mode>;
  /** Workspace-aware strategy (default true): cwd under /mnt/* -> win, else wsl.
   *  Explicit `tools` entries always win over this. */
  workspaceAware?: boolean;
  /** Fallback direction when the preferred variant is missing.
   *  `true` (default) = both directions, `false` = none (leave command untouched). */
  fallback?: boolean | FallbackOptions;
  translatePaths?: boolean;
  onlyUnderMnt?: boolean;
  debug?: boolean;
  /** Master switch (default true). A project file can set false to disable
   *  all shims in that workspace (e.g. to force ELF builds with WSL cargo). */
  enabled?: boolean;
  /** Warn when a .exe runs against the WSL-native filesystem, which goes
   *  through \\wsl$\\ (9P) with severe I/O penalty (default true). */
  warnOn9P?: boolean;
  /** Extra WSLENV entries (e.g. ["SSH_AUTH_SOCK/p"]) relayed to Windows
   *  processes so git/cargo can auth against private repos (default []). */
  wslenv?: string[];
}

type ResolvedConfig = Required<Omit<WslWinToolsOptions, "fallback">> & {
  /** Explicit per-tool pins from options/fallback JSON (before defaults). */
  explicit: Record<string, Mode>;
  fallback: Required<FallbackOptions>;
};

const FALLBACK_JSON = join(homedir(), ".config", "opencode", "wsl-win-tools.json");

// base tool -> windows exe
const EXE_MAP: Record<string, string> = {
  git: "git.exe",
  "git-lfs": "git-lfs.exe",
  gh: "gh.exe",
  cargo: "cargo.exe",
  rustc: "rustc.exe",
  rustup: "rustup.exe",
  go: "go.exe",
  gofmt: "gofmt.exe",
  dotnet: "dotnet.exe",
  java: "java.exe",
  javac: "javac.exe",
  mvn: "mvn.exe",
  gradle: "gradle.exe",
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
  poetry: "poetry.exe",
  pytest: "pytest.exe",
  ruby: "ruby.exe",
  gem: "gem.exe",
  bundle: "bundle.exe",
  php: "php.exe",
  composer: "composer.exe",
  docker: "docker.exe",
  kubectl: "kubectl.exe",
  helm: "helm.exe",
  terraform: "terraform.exe",
  tofu: "tofu.exe",
  aws: "aws.exe",
  az: "az.exe",
  gcloud: "gcloud.exe",
  psql: "psql.exe",
  mysql: "mysql.exe",
  sqlite3: "sqlite3.exe",
  ffmpeg: "ffmpeg.exe",
  pandoc: "pandoc.exe",
  code: "code.exe",
};

// built-in preference table (used when workspaceAware is off and no explicit pin).
// compiled/data/infra toolchains lean win (avoids double installs and variant
// issues like line endings); js runtimes lean wsl (node often lives in WSL
// via fnm/nvm with its own modules)
// Legacy static table, intentionally empty: with workspaceAware (default)
// the workspace location decides (win under /mnt/*, wsl elsewhere).
// Only used as merge base when workspaceAware is off, where `default` applies.
const DEFAULT_TOOLS: Record<string, Mode> = {};

// prefixes to skip when looking for the binary (sudo, env, VAR=x, command, time, nice...)
const SKIP_TOKENS = new Set(["sudo", "command", "time", "nice", "env", "nohup", "xargs"]);

export function isWSL(): boolean {
  // Escape hatch for tests/CI (non-WSL runners): WSL_SHIM_FORCE=1 pretends
  // to be WSL, =0 pretends not to be. Real WSL hosts are unaffected.
  const force = process.env.WSL_SHIM_FORCE?.toLowerCase();
  if (force === "1" || force === "true") return true;
  if (force === "0" || force === "false") return false;
  // Standard WSL env markers (present on every WSL distro).
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
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

function resolveFallback(fb?: boolean | FallbackOptions): Required<FallbackOptions> {
  if (fb === false) return { winToWsl: false, wslToWin: false };
  if (fb === true || fb === undefined) return { winToWsl: true, wslToWin: true };
  return { winToWsl: fb.winToWsl ?? true, wslToWin: fb.wslToWin ?? true };
}

function resolveConfig(options?: Record<string, unknown>, fallback: WslWinToolsOptions = {}): ResolvedConfig {
  const o = (options ?? {}) as WslWinToolsOptions;
  return {
    default: o.default ?? fallback.default ?? "wsl",
    tools: { ...DEFAULT_TOOLS, ...(fallback.tools ?? {}), ...(o.tools ?? {}) },
    explicit: { ...(fallback.tools ?? {}), ...(o.tools ?? {}) },
    workspaceAware: o.workspaceAware ?? fallback.workspaceAware ?? true,
    fallback: resolveFallback(o.fallback ?? fallback.fallback),
    translatePaths: o.translatePaths ?? fallback.translatePaths ?? true,
    onlyUnderMnt: o.onlyUnderMnt ?? fallback.onlyUnderMnt ?? false,
    debug: o.debug ?? fallback.debug ?? false,
    enabled: o.enabled ?? fallback.enabled ?? true,
    warnOn9P: o.warnOn9P ?? fallback.warnOn9P ?? true,
    wslenv: o.wslenv ?? fallback.wslenv ?? [],
  };
}

function mergeConfigs(base: ResolvedConfig, proj: WslWinToolsOptions): ResolvedConfig {
  if (!proj || Object.keys(proj).length === 0) return base;
  return {
    ...base,
    default: proj.default ?? base.default,
    tools: { ...base.tools, ...(proj.tools ?? {}) },
    explicit: { ...base.explicit, ...(proj.tools ?? {}) },
    workspaceAware: proj.workspaceAware ?? base.workspaceAware,
    fallback: proj.fallback !== undefined ? resolveFallback(proj.fallback) : base.fallback,
    translatePaths: proj.translatePaths ?? base.translatePaths,
    onlyUnderMnt: proj.onlyUnderMnt ?? base.onlyUnderMnt,
    debug: proj.debug ?? base.debug,
    enabled: proj.enabled ?? base.enabled,
    warnOn9P: proj.warnOn9P ?? base.warnOn9P,
    wslenv: proj.wslenv ?? base.wslenv,
  };
}

// Per-workspace config: .opencode/wsl-shim.json, searched upward from dir.
const projectCache = new Map<string, { mtime: number; config: WslWinToolsOptions }>();

function findProjectFile(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 32 && dir && dir !== "/"; i++) {
    const f = join(dir, ".opencode", "wsl-shim.json");
    try {
      if (existsSync(f)) return f;
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadProjectFile(file: string): WslWinToolsOptions {
  try {
    const mtime = statSync(file).mtimeMs;
    const hit = projectCache.get(file);
    if (hit && hit.mtime === mtime) return hit.config;
    const config = JSON.parse(readFileSync(file, "utf8")) as WslWinToolsOptions;
    projectCache.set(file, { mtime, config });
    return config;
  } catch {
    return {};
  }
}

function modeFor(tool: string, cfg: ResolvedConfig, inWindows: boolean): Mode {
  return cfg.explicit[tool] ?? (cfg.workspaceAware ? (inWindows ? "win" : "wsl") : (cfg.tools[tool] ?? cfg.default));
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
  const base = resolveConfig(options, fallback);

  // Per-call config: tuple/global options, overridden by the workspace file.
  function configForCall(cwd: string): ResolvedConfig {
    const starts = [cwd, directory].filter((d): d is string => !!d);
    for (const start of starts) {
      const file = findProjectFile(start);
      if (!file) continue;
      const proj = loadProjectFile(file);
      if (Object.keys(proj).length > 0) return mergeConfigs(base, proj);
    }
    return base;
  }

  const exeCache = new Map<string, boolean>();
  const pathCache = new Map<string, string>();
  const warned = new Set<string>();

  async function binExists(bin: string): Promise<boolean> {
    if (exeCache.has(bin)) return exeCache.get(bin)!;
    try {
      await $`sh -c ${`command -v ${bin}`}`.quiet().text();
      exeCache.set(bin, true);
      return true;
    } catch {
      exeCache.set(bin, false);
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

  async function debug(cfg: ResolvedConfig, msg: string) {
    if (!cfg.debug) return;
    try {
      await client.app.log({ body: { service: "wsl-win-tools", level: "info", message: msg } });
    } catch {
      // ignore
    }
  }

  async function rewriteSegment(seg: string, inWindows: boolean, cfg: ResolvedConfig): Promise<string> {
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

    const origBin = stripQuotes(toks[binIdx]);
    // already an exe -> keep it, only translate paths
    const alreadyExe = origBin.toLowerCase().endsWith(".exe");
    const base = alreadyExe ? origBin.replace(/\.exe$/i, "") : origBin;

    const exe = EXE_MAP[base];
    if (!exe) return seg; // not a managed tool

    const wantWin = alreadyExe || modeFor(base, cfg, inWindows) === "win";

    // Bidirectional fallback to whichever binary actually exists (if enabled).
    let useExe: boolean;
    if (alreadyExe) {
      useExe = true;
      if (!(await binExists(exe))) await warnOnce(`wsl-win-tools: ${exe} not found in PATH`);
    } else if (wantWin) {
      if (await binExists(exe)) {
        useExe = true;
      } else if (cfg.fallback.winToWsl) {
        await warnOnce(`wsl-win-tools: ${exe} not found in PATH, using WSL ${base}`);
        return seg;
      } else {
        await warnOnce(`wsl-win-tools: ${exe} not found in PATH, leaving ${base} untouched (fallback disabled)`);
        return seg;
      }
    } else {
      if (await binExists(base)) return seg;
      if (cfg.fallback.wslToWin && (await binExists(exe))) {
        useExe = true;
        await warnOnce(`wsl-win-tools: WSL ${base} not found, falling back to ${exe}`);
      } else {
        await warnOnce(`wsl-win-tools: WSL ${base} not found, leaving command untouched (fallback disabled)`);
        return seg;
      }
    }

    if (!useExe) return seg;

    if (!inWindows && cfg.warnOn9P) {
      await warnOnce(
        `wsl-win-tools: running ${exe} on the WSL-native filesystem goes through \\\\wsl$\\\\ (9P) with severe I/O penalty; prefer WSL ${base} or move the project under /mnt/`,
      );
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
    await debug(cfg, `wsl-win-tools: '${seg.trim()}' -> '${rewritten.trim()}'`);
    return rewritten;
  }

  async function rewriteCommand(cmd: string, cwd: string): Promise<string> {
    const cfg = configForCall(cwd);
    if (!cfg.enabled) return cmd;
    if (cfg.onlyUnderMnt && !cwd.startsWith("/mnt/")) return cmd;
    const inWindows = cwd.startsWith("/mnt/");
    // quick exit if no managed tool name appears
    const names = Object.keys(EXE_MAP).join("|");
    if (!new RegExp(`(^|[\\s;&|(\`'"])(${names})(\\s|$|\\.|\\.exe)`, "i").test(cmd)) return cmd;
    const parts = splitSegments(cmd);
    const out: string[] = [];
    for (const p of parts) {
      if (OP_SET.has(p)) out.push(p);
      else out.push(await rewriteSegment(p, inWindows, cfg));
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
    "shell.env": async (input, output) => {
      try {
        const cfg = configForCall(input.cwd ?? "");
        if (!cfg.enabled || cfg.wslenv.length === 0) return;
        if (!output.env) output.env = {};
        const cur = output.env.WSLENV ?? process.env.WSLENV ?? "";
        const parts = cur.split(":").filter(Boolean);
        for (const e of cfg.wslenv) if (!parts.includes(e)) parts.push(e);
        output.env.WSLENV = parts.join(":");
      } catch {
        // never break shell startup over env relay
      }
    },
  };
}) satisfies Plugin;

export default WslWinTools;

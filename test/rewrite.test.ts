import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WslWinTools } from "../src/index.ts";

// Simulated machine: WSL has git/cargo/node/npm, Windows has git/cargo/rustc/python exes.
const WSL_BINS = new Set(["git", "cargo", "node", "npm"]);
const WIN_EXES = new Set(["git.exe", "cargo.exe", "rustc.exe", "python.exe", "go.exe", "docker.exe"]);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeProjectDir(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "wsl-shim-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(join(dir, ".opencode", "wsl-shim.json"), JSON.stringify(config));
  return dir;
}

function makePlugin(options: Record<string, unknown>, extra: { logs?: string[]; directory?: string } = {}) {
  const logs = extra.logs ?? [];
  const fake$ = ((s: TemplateStringsArray, ...v: unknown[]) => {
    const cmd = s.reduce((a, p, i) => a + p + String(v[i] ?? ""), "");
    const q = {
      quiet() {
        return q;
      },
      async text() {
        if (cmd.includes("command -v")) {
          const bin = cmd.trim().split(/\s+/).pop()!;
          if (WSL_BINS.has(bin) || WIN_EXES.has(bin)) return `/fake/${bin}\n`;
          throw new Error("not found");
        }
        if (cmd.includes("wslpath")) {
          const m = cmd.match(/\/mnt\/([a-zA-Z])\/(\S+)/);
          if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}\n`;
          throw new Error("wslpath fail");
        }
        return "";
      },
    };
    return q;
  }) as any;

  return WslWinTools(
    {
      client: { app: { log: async (e: any) => void logs.push(e?.body?.message ?? String(e)) } },
      directory: extra.directory ?? "/mnt/c/Users/u/proj",
      $: fake$,
    } as any,
    options,
  );
}

async function run(plug: any, cmd: string, cwd = "/mnt/c/Users/u/proj") {
  const output = { args: { command: cmd, cwd } };
  await plug["tool.execute.before"]({ tool: "bash" }, output);
  return output.args.command as string;
}

describe("wsl-win-tools rewrite", () => {
  test("explicit pins win over everything", async () => {
    const plug = await makePlugin({ default: "wsl", tools: { git: "win", cargo: "win", node: "wsl" } });
    expect(await run(plug, "git status")).toBe("git.exe status");
    expect(await run(plug, "cargo build && npm test")).toBe("cargo.exe build && npm test");
    expect(await run(plug, "node --version")).toBe("node --version");
  });

  test("workspaceAware: windows workspace defaults to exe", async () => {
    const plug = await makePlugin({ workspaceAware: true });
    expect(await run(plug, "git status")).toBe("git.exe status");
    // node.exe missing -> falls back to WSL node
    expect(await run(plug, "node --version")).toBe("node --version");
  });

  test("workspaceAware: native wsl workspace defaults to wsl", async () => {
    const plug = await makePlugin({ workspaceAware: true });
    expect(await run(plug, "cargo build", "/home/u/proj")).toBe("cargo build");
    expect(await run(plug, "git status", "/home/u/proj")).toBe("git status");
  });

  test("reverse fallback: missing wsl binary uses exe", async () => {
    const plug = await makePlugin({ workspaceAware: true });
    // python exists only as Windows exe on this machine
    expect(await run(plug, "python script.py", "/home/u/proj")).toBe("python.exe script.py");
  });

  test("absolute paths translated via wslpath", async () => {
    const plug = await makePlugin({ default: "wsl", tools: { git: "win" } });
    expect(await run(plug, "git -C /mnt/c/Users/u/proj status")).toBe("git.exe -C C:\\Users\\u\\proj status");
  });

  test("non-managed commands, pipes and prefixes", async () => {
    const plug = await makePlugin({ default: "wsl", tools: { git: "win" } });
    expect(await run(plug, "echo hi | grep h")).toBe("echo hi | grep h");
    expect(await run(plug, "sudo git status")).toBe("sudo git.exe status");
    expect(await run(plug, "git.exe status")).toBe("git.exe status");
    expect(await run(plug, "ls -la")).toBe("ls -la");
  });

  test("extended toolchain coverage", async () => {
    const plug = await makePlugin({ workspaceAware: true });
    expect(await run(plug, "go version")).toBe("go.exe version");
    expect(await run(plug, "docker ps")).toBe("docker.exe ps");
    // java.exe absent on this machine -> falls back to WSL
    expect(await run(plug, "java -version")).toBe("java -version");
  });

  test("workspaceAware off: plain default applies, no legacy table", async () => {
    const wsl = await makePlugin({ workspaceAware: false, default: "wsl" });
    expect(await run(wsl, "git status")).toBe("git status");
    const win = await makePlugin({ workspaceAware: false, default: "win" });
    expect(await run(win, "git status")).toBe("git.exe status");
  });

  test("fallback disabled leaves command untouched", async () => {
    const plug = await makePlugin({ workspaceAware: true, fallback: false });
    // node.exe missing and fallback off -> WSL node kept (would fail loudly if absent)
    expect(await run(plug, "node --version")).toBe("node --version");
    // python missing in WSL and fallback off -> untouched
    expect(await run(plug, "python script.py", "/home/u/proj")).toBe("python script.py");
  });

  test("fallback direction configurable", async () => {
    const noWin = await makePlugin({ workspaceAware: true, fallback: { wslToWin: false } });
    expect(await run(noWin, "python script.py", "/home/u/proj")).toBe("python script.py");
    const noWsl = await makePlugin({ default: "wsl", tools: { npm: "win" }, fallback: { winToWsl: false } });
    expect(await run(noWsl, "npm test")).toBe("npm test");
  });

  test("9P warning when exe runs on WSL-native filesystem", async () => {
    const logs: string[] = [];
    const plug = await makePlugin({ workspaceAware: true }, { logs });
    expect(await run(plug, "python script.py", "/home/u/proj")).toBe("python.exe script.py");
    expect(logs.some((m) => m.includes("9P"))).toBe(true);
    const logs2: string[] = [];
    const plug2 = await makePlugin({ workspaceAware: true }, { logs: logs2 });
    expect(await run(plug2, "git status")).toBe("git.exe status");
    expect(logs2.some((m) => m.includes("9P"))).toBe(false);
  });

  test("project file pins tools per workspace", async () => {
    const dir = makeProjectDir({ tools: { git: "win" } });
    const plug = await makePlugin({ workspaceAware: true });
    // native cwd would default to wsl, project file pins git to win
    expect(await run(plug, "git status", dir)).toBe("git.exe status");
    const plain = mkdtempSync(join(tmpdir(), "wsl-shim-plain-"));
    tmpDirs.push(plain);
    expect(await run(plug, "git status", plain)).toBe("git status");
  });

  test("project file enabled:false disables shims", async () => {
    const dir = makeProjectDir({ enabled: false, tools: { git: "win" } });
    const plug = await makePlugin({ workspaceAware: true }, { directory: dir });
    // cwd on windows fs would rewrite, but project disables the shim via directory
    expect(await run(plug, "git status")).toBe("git status");
  });

  test("global enabled:false disables shims", async () => {
    const plug = await makePlugin({ enabled: false, tools: { git: "win" } });
    expect(await run(plug, "git status")).toBe("git status");
  });

  test("shell.env relays configured WSLENV entries", async () => {
    const plug = await makePlugin({ wslenv: ["SSH_AUTH_SOCK/p", "HTTP_PROXY/u"] });
    const out1 = { env: {} as Record<string, string> };
    await plug["shell.env"]({ cwd: "/mnt/c/Users/u/proj" }, out1);
    expect(out1.env.WSLENV.split(":")).toEqual(expect.arrayContaining(["SSH_AUTH_SOCK/p", "HTTP_PROXY/u"]));
    const out2 = { env: { WSLENV: "FOO/u" } };
    await plug["shell.env"]({ cwd: "/mnt/c/Users/u/proj" }, out2);
    expect(out2.env.WSLENV.split(":")).toEqual(expect.arrayContaining(["FOO/u", "SSH_AUTH_SOCK/p", "HTTP_PROXY/u"]));
    const plain = await makePlugin({});
    const out3 = { env: {} as Record<string, string> };
    await plain["shell.env"]({ cwd: "/mnt/c/Users/u/proj" }, out3);
    expect("WSLENV" in out3.env).toBe(false);
  });
});

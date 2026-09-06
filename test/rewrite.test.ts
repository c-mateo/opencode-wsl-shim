import { describe, expect, test } from "bun:test";
import { WslWinTools } from "../src/index.ts";

// Simulated machine: WSL has git/cargo/node/npm, Windows has git/cargo/rustc/python exes.
const WSL_BINS = new Set(["git", "cargo", "node", "npm"]);
const WIN_EXES = new Set(["git.exe", "cargo.exe", "rustc.exe", "python.exe", "go.exe", "docker.exe"]);

function makePlugin(options: Record<string, unknown>) {
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
    { client: { app: { log: async () => {} } }, directory: "/mnt/c/Users/u/proj", $: fake$ } as any,
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
});

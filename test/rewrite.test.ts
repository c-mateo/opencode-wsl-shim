import { describe, expect, test } from "bun:test";
import { WslWinTools } from "../src/index.ts";

function makePlugin(options: Record<string, unknown>) {
  const fake$ = ((s: TemplateStringsArray, ...v: unknown[]) => {
    const cmd = s.reduce((a, p, i) => a + p + String(v[i] ?? ""), "");
    const q = {
      quiet() {
        return q;
      },
      async text() {
        if (cmd.includes("command -v")) {
          const exe = cmd.trim().split(/\s+/).pop()!;
          if (/^(git|cargo|rustc|python)\.exe$/.test(exe)) return `/mnt/c/fake/${exe}\n`;
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
  test("win tools get .exe, wsl tools untouched", async () => {
    const plug = await makePlugin({ default: "wsl", tools: { git: "win", cargo: "win", node: "wsl" } });
    expect(await run(plug, "git status")).toBe("git.exe status");
    expect(await run(plug, "cargo build && npm test")).toBe("cargo.exe build && npm test");
    expect(await run(plug, "node --version")).toBe("node --version");
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

  test("missing exe falls back to wsl", async () => {
    const plug = await makePlugin({ default: "wsl", tools: { npm: "win" } });
    expect(await run(plug, "npm test")).toBe("npm test");
  });
});

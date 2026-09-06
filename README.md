# opencode-wsl-win-tools

opencode plugin for running inside **WSL2** that routes toolchain calls
(`git`, `cargo`, `node`, `python`, ...) to the native **Windows `.exe`**
binaries instead of the WSL ones — per tool, with automatic path translation.

## How it works

Hooks into `tool.execute.before` for the `bash` tool. When the model runs e.g.
`git -C /mnt/c/Users/you/proj status`, the plugin rewrites it to
`git.exe -C C:\Users\you\proj status` (paths via `wslpath -w`).
Outside WSL it does nothing. If a `.exe` is missing from `PATH`
(e.g. `node.exe` when node lives in WSL via fnm), it silently falls back
to the WSL binary.

## Installation

Via opencode config (recommended — opencode installs it with Bun at startup):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["opencode-wsl-win-tools", { "tools": { "git": "win" } }]]
}
```

## Configuration

All fields optional. Per-tool values override `default`.

| Option | Type | Default | Description |
|---|---|---|---|
| `default` | `"wsl" \| "win"` | `"wsl"` | Fallback for tools not listed in `tools` |
| `tools` | `Record<string, "wsl" \| "win">` | see below | Per-tool preference |
| `translatePaths` | `boolean` | `true` | Convert absolute WSL paths to `C:\...` via `wslpath -w` |
| `onlyUnderMnt` | `boolean` | `false` | Only rewrite when cwd is under `/mnt/*` |
| `debug` | `boolean` | `false` | Log every rewrite via `client.app.log` |

Built-in tool defaults (`"win"`: git, git-lfs, gh, cargo, rustc, rustup,
python, python3, pip, pip3, uv, ruff · `"wsl"`: node, npm, npx, yarn,
pnpm, bun, deno):

```json
["opencode-wsl-win-tools", {
  "default": "wsl",
  "tools": { "git": "win", "cargo": "win", "python": "win", "node": "wsl" },
  "translatePaths": true,
  "onlyUnderMnt": false,
  "debug": false
}]
```

Without npm (single file): copy `src/index.ts` to
`~/.config/opencode/plugins/wsl-win-tools.ts` (global, autoloaded) and
reference it as `["./plugins/wsl-win-tools.ts", { ... }]` to pass options.
A `~/.config/opencode/wsl-win-tools.json` file with the same shape is also
read as a fallback when no tuple options are given.

## License

MIT

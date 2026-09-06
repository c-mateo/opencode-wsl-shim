# opencode-wsl-win-tools

opencode plugin for running inside **WSL2** that routes toolchain calls
(`git`, `cargo`, `node`, `python`, ...) to the native **Windows `.exe`**
binaries instead of the WSL ones — per tool, with automatic path translation.

## How it works

Hooks into `tool.execute.before` for the `bash` tool. Strategy, in priority
order:

1. **Explicit `tools` pins** — always win (e.g. `"git": "win"`).
2. **Workspace-aware default** (`workspaceAware: true`, the default):
   command runs under `/mnt/*` (Windows filesystem) → `.exe`,
   otherwise (native WSL filesystem) → WSL binary. This avoids variant
   issues like git line-ending noise or WSL node missing packages.
3. **Fallback to whatever exists** — if the preferred variant is not in
   `PATH`, the other one is used (with a one-time warning). So you never
   need cargo/node/python installed twice: set the preference, and a
   missing binary falls back automatically. Each direction is
   independently configurable via `fallback`.

When the model runs e.g. `git -C /mnt/c/Users/you/proj status`, the
plugin rewrites it to `git.exe -C C:\Users\you\proj status`
(paths via `wslpath -w`). Outside WSL it does nothing.

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
| `default` | `"wsl" \| "win"` | `"wsl"` | Fallback when `workspaceAware` is off and tool not listed |
| `workspaceAware` | `boolean` | `true` | `/mnt/*` cwd → `win`, native WSL cwd → `wsl` (explicit `tools` pins override) |
| `fallback` | `boolean \| { winToWsl?, wslToWin? }` | `true` | Per-direction fallback when preferred binary missing; `false` disables both (command left untouched) |
| `tools` | `Record<string, "wsl" \| "win">` | see below | Per-tool preference |
| `translatePaths` | `boolean` | `true` | Convert absolute WSL paths to `C:\...` via `wslpath -w` |
| `onlyUnderMnt` | `boolean` | `false` | Only rewrite when cwd is under `/mnt/*` |
| `debug` | `boolean` | `false` | Log every rewrite via `client.app.log` |

Built-in tool defaults (`"win"`: git, gh, cargo/rust, go, dotnet,
java/mvn/gradle, python/pip/uv/ruff/poetry, ruby, php/composer,
docker, kubectl/helm, terraform, aws/az/gcloud, psql/mysql/sqlite3,
ffmpeg, pandoc, vscode `code` · `"wsl"`: node, npm, npx, yarn,
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

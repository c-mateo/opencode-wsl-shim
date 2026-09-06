# opencode-wsl-shim

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
  "plugin": [["opencode-wsl-shim", { "tools": { "git": "win" } }]]
}
```

## Configuration

All fields optional. Per-tool values override `default`.

| Option | Type | Default | Description |
|---|---|---|---|
| `default` | `"wsl" \| "win"` | `"wsl"` | Fallback when `workspaceAware` is off and tool not listed |
| `tools` | `Record<string, "wsl" \| "win">` | `{}` | Per-tool preference (explicit pins always win) |
| `workspaceAware` | `boolean` | `true` | `/mnt/*` cwd → `win`, native WSL cwd → `wsl` (explicit `tools` pins override) |
| `fallback` | `boolean \| { winToWsl?, wslToWin? }` | `true` | Per-direction fallback when preferred binary missing; `false` disables both (command left untouched) |
| `translatePaths` | `boolean` | `true` | Convert absolute WSL paths to `C:\...` via `wslpath -w` |
| `onlyUnderMnt` | `boolean` | `false` | Only rewrite when cwd is under `/mnt/*` |
| `enabled` | `boolean` | `true` | Master switch; a project file can set `false` to disable all shims in that workspace |
| `warnOn9P` | `boolean` | `true` | Warn when a `.exe` runs on the WSL-native filesystem (`\\wsl$\` 9P I/O penalty) |
| `wslenv` | `string[]` | `[]` | Extra `WSLENV` entries (e.g. `"SSH_AUTH_SOCK/p"`) relayed to Windows processes |
| `debug` | `boolean` | `false` | Log every rewrite via `client.app.log` |

## Per-workspace config

Drop a `.opencode/wsl-shim.json` file in any project (searched upward from
the command's cwd). Same shape as the options, lower priority than the
plugin tuple options:

```json
{
  "tools": { "cargo": "wsl" },
  "enabled": true,
  "wslenv": ["SSH_AUTH_SOCK/p"]
}
```

Useful cases: force the Linux toolchain in a project that builds native
ELF binaries (`"tools": { "cargo": "wsl" }`), or kill the shim entirely
with `"enabled": false`. The global fallback file
`~/.config/opencode/wsl-win-tools.json` has the lowest priority.

No hardcoded per-tool preferences: every known tool
(git, cargo/rust, go, dotnet, java/mvn/gradle, node/npm/npx/yarn/pnpm/bun/deno,
python/pip/uv/ruff/poetry, ruby, php/composer, docker, kubectl/helm,
terraform, aws/az/gcloud, psql/mysql/sqlite3, ffmpeg, pandoc, vscode `code`)
follows the workspace strategy above unless pinned in `tools`.
(With `workspaceAware: false`, the `default` value applies to all.)

```json
["opencode-wsl-shim", {
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

MIT — © 2026 [Mateo Cerri](https://github.com/c-mateo)

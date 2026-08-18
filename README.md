[![CI](https://github.com/isanchez31/opencode-sandbox-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/isanchez31/opencode-sandbox-plugin/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-sandbox)](https://www.npmjs.com/package/opencode-sandbox)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# opencode-sandbox

An [OpenCode](https://opencode.ai) plugin that sandboxes agent-executed commands using [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).

Every `bash` tool invocation is wrapped with OS-level filesystem and network restrictions — no containers, no VMs, just native OS sandboxing primitives.

| Platform | Mechanism |
|----------|-----------|
| **macOS** | `sandbox-exec` (Seatbelt profiles) |
| **Linux** | `bubblewrap` (namespace isolation) |
| **Windows** | Not currently supported by OpenCode's command-string hook (commands pass through) |

## Install

<!-- ```json
// opencode.json
{
  "plugin": ["opencode-sandbox"]
}
```

The plugin is automatically installed from npm when OpenCode starts. -->

### Manual installation

This fork is NOT published to npm, and therefore cannot be simply installed by the "plugin" entry in the OpenCode config file. To cleanly install this plugin, build this package, link it to `~/.config/opencode/node_modules`, and load it with a single-file shim placed in `~/.config/opencode/plugins`. Detailed steps:

1. Clone this repository to a place which is unlikely to be moved in the future.
2. Enter the directory, install dependencies: `bun install`.
3. Build plugin to generate dist/index.js: `bun run build`.
4. Register as local linked package: `bun link`.
5. Enter `~/.config/opencode` directory, run `bun link opencode-sandbox`.
6. Place [the shim file](./.opencode/plugins/opencode-sandbox-shim.ts) in `~/.config/opencode/plugins`.

After installation, launch OpenCode CLI. You should be able to see these briefly on the temporary black screen (or in `~/.local/share/opencode/log/opencode.log`) during startup:

```
[opencode-sandbox] Using sandbox with directory=/home/user/shared_agent_workspace, worktree=/.
[opencode-sandbox] Fail-safe mode is used. Commands will fail if sandbox fails.
[opencode-sandbox] Rejecting unsafe write path: /
```

### Troubleshooting note

The OpenCode log file (`~/.local/share/opencode/log/opencode.log`) may be helpful if the plugin does not seem to load or produces errors when using the shell tool. You may also want to check the trasient abnormal texts that appears in the TUI if there are some.

### Defect and its relation with the private OpenCode fork

This plugin works by transforming the command into a sandbox-wrapped form using the `tool.execute.before` hook. Unfortunately, the transformed command will also end in the UI and the chat history (which will be sent back to the model), possibly causing some confusion. Two measures are taken to mitigate this:

- Add a note into the tool description, informing the model that commands will appear wrapped in the chat history:
  "Note: Sandbox rewriting is on. Commands will be rewritten to enforce sandbox rules, and will appear in their rewritten forms in chat history."
  Whether the model can understand this correctly is unknown though.
- Instead of rewriting the command to its sandbox-wrapped form directly (which generates a massive wrapper command with all sandbox configurations embedded), the plugin writes the sandbox-wrapped form into a shim file (filename starting with `oc_sandboxed-`) under the temporary directory, and then rewrite the command to execute the shim instead.
  For example, `ls -la` will finally become `/bin/sh /tmp/oc_sandboxed-f87cc52597ddf4183445d0d4287103cf 'ls -la'`.
  The shim file deletes itself first when executed, and is cleaned up by the plugin again if it still exists.

The shim file behavior can be disabled using config value `noShimFile`.

I have not found a way to fully fix this defect using the OpenCode plugin API, so I have made a [private OpenCode fork](https://github.com/yezhiyi9670/opencode-fork) that exposes the executor function as `output.executeFn` in the `tool.definition` hook, which in turn allows the plugin to fully control execution behavior by wrapping the function. This is the cleanest approach and can achieve sandboxing while still leaving the original commands in the chat history. The plugin automatically uses this implementation when `output.executeFn` is exposed, and the defective `tool.execute.before` implementation when not.

In short, take command `ls -la` for example:

| Setup | Runs in sandbox? | What appears in chat history? |
| - | - | - |
| [Private OC fork](https://github.com/yezhiyi9670/opencode-fork) (recommended) | ✅ | `ls -la` |
| Vanilla, `noShimFile: false` (default) | ✅ | `/bin/sh /tmp/oc_sandboxed-<hash> 'ls -la'` |
| Vanilla, `noShimFile: true` | ✅ | `bwrap --die-with-parent <lots_of_gibberish> '"'"'"'"'"'"'"ls -la"'"'"'"'"'"'"'` |

### Linux prerequisites

**1. Install dependencies:**

```bash
# Debian/Ubuntu
sudo apt install bubblewrap socat ripgrep

# Fedora
sudo dnf install bubblewrap socat ripgrep

# Arch
sudo pacman -S bubblewrap socat ripgrep
```

**2. Ubuntu 24.04+ (AppArmor fix):**

Ubuntu 24.04 and later restrict unprivileged user namespaces via AppArmor, which prevents bubblewrap from working. You need to enable the `bwrap-userns-restrict` AppArmor profile:

```bash
# Install the AppArmor profiles package
sudo apt install apparmor-profiles

# Create the symlink to enable the profile
sudo ln -s /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/force-complain/bwrap-userns-restrict

# Load the profile
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

You can verify bwrap works:

```bash
bwrap --ro-bind / / --dev /dev --proc /proc -- echo "sandbox works"
```

Without this fix, bwrap will fail with `loopback: Failed RTM_NEWADDR: Operation not permitted` or `setting up uid map: Permission denied`.

## What it does

When the agent runs a bash command, the sandbox enforces three layers of protection:

### Filesystem write protection

Commands can only write to the project directory and `/tmp`. Writing anywhere else returns "Read-only file system":

```
$ touch ~/some-file
touch: cannot touch '/home/user/some-file': Read-only file system

$ echo "data" > /etc/config
/usr/bin/bash: line 1: /etc/config: Read-only file system
```

### Sensitive file read protection

Access to credential directories is blocked:

```
$ cat ~/.ssh/id_rsa
cat: /home/user/.ssh/id_rsa: Permission denied
```

### Network allowlist

Only approved domains are reachable. All other traffic is blocked via a local proxy:

```
$ curl https://evil.com
Connection blocked by network allowlist

$ curl https://registry.npmjs.org
(works — npmjs.org is in the default allowlist)
```

### Default restrictions

**Filesystem (deny-read)**:
- `~/.ssh`, `~/.gnupg`
- `~/.aws/credentials`, `~/.config/gcloud`
- `~/.npmrc`, `~/.env`

**Filesystem (allow-read)**:
- Empty by default

**Filesystem (allow-write)**:
- Project directory
- Git worktree (validated — unsafe paths like `/` are rejected)
- `/tmp`

**Network (allow-only)**:
- `registry.npmjs.org`, `*.npmjs.org`
- `registry.yarnpkg.com`
- `pypi.org`, `crates.io`
- `github.com`, `*.github.com`
- `gitlab.com`, `*.gitlab.com`
- `api.openai.com`, `api.anthropic.com`
- `*.googleapis.com`

Everything else is **blocked by default**.

## Configuration

Config files are stored outside the project directory (in `~/.config/opencode-sandbox/`) so that sandboxed commands cannot modify them. This prevents indirect prompt injection from weakening the sandbox by overwriting the config.

### Config file locations

The plugin searches for configuration in this order (first match wins):

1. **Environment variable** `OPENCODE_SANDBOX_CONFIG` (JSON string)
2. **Per-project config** `~/.config/opencode-sandbox/projects/<project-name>.json`
3. **Global config** `~/.config/opencode-sandbox/config.json`
4. **Built-in defaults**

The `<project-name>` is the basename of the project directory (e.g., `my-app` for `/home/user/projects/my-app`).

If `XDG_CONFIG_HOME` is set, it is used instead of `~/.config`.

### Example: Global config

```json
// ~/.config/opencode-sandbox/config.json
{
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws/credentials"],
    "allowRead": ["~/.ssh/id_ed25519.pub"],
    "allowWrite": [".", "/tmp", "/var/data"],
    "denyWrite": [".env.production"]
  },
  "network": {
    "allowedDomains": [
      "registry.npmjs.org",
      "github.com",
      "*.github.com",
      "api.openai.com",
      "api.anthropic.com",
      "my-internal-api.company.com"
    ],
    "deniedDomains": ["malicious.example.com"]
  }
}
```

### Path precedence

Path precedence is inherited from `@anthropic-ai/sandbox-runtime`:

- Read: `allowRead` takes precedence over `denyRead`
- Write: `denyWrite` takes precedence over `allowWrite`

### Example: allow git commit signing with SSH public key

If your Git workflow needs to read a public key (for example `~/.ssh/id_ed25519.pub`) while keeping `~/.ssh` blocked by default, re-allow only that file:

```json
// ~/.config/opencode-sandbox/config.json
{
  "filesystem": {
    "denyRead": [
      "~/.ssh",
      "~/.gnupg",
      "~/.aws/credentials",
      "~/.azure",
      "~/.config/gcloud",
      "~/.config/gh",
      "~/.kube",
      "~/.docker/config.json",
      "~/.npmrc",
      "~/.netrc",
      "~/.env",
      ".git"
    ],
    "allowRead": ["~/.ssh/id_ed25519.pub"]
  }
}
```

### Example: Per-project config

```json
// ~/.config/opencode-sandbox/projects/my-app.json
{
  "network": {
    "allowedDomains": ["my-internal-api.company.com"]
  }
}
```

### Environment variable

```bash
OPENCODE_SANDBOX_CONFIG='{"filesystem":{"denyRead":["~/.ssh"]},"network":{"allowedDomains":["github.com"]}}' opencode
```

Example allowing only the SSH public key to be read:

```bash
OPENCODE_SANDBOX_CONFIG='{"filesystem":{"denyRead":["~/.ssh","~/.gnupg","~/.aws/credentials","~/.azure","~/.config/gcloud","~/.config/gh","~/.kube","~/.docker/config.json","~/.npmrc","~/.netrc","~/.env"],"allowRead":["~/.ssh/id_ed25519.pub"]}}' opencode
```

### Disable

```bash
OPENCODE_DISABLE_SANDBOX=1 opencode
```

Or in any config file:

```json
{
  "disabled": true
}
```

### Junk file prevention and removal

Currently, `@anthropic-ai/sandbox-runtime` has a defect that might create several read-only empty files (like `.bashrc`, `.zprofile`, `.claude/agents`) in every writable directory and fail to clean them up. See "Mandatory Deny Paths" on the [npm page](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime/v/0.0.73) and [this Claude Code issue](https://github.com/anthropics/claude-code/issues/17087), an such behavior cannot be disabled by modifying sandbox configuration. The plugin mitigates with two approaches:

- Eliminate these problematic arguments by replacing them away directly in the sandbox-wrapped command. Only arguments regarding non-already-existing files will be considered for removal. This is directly implemented with string replacement, which is not considered a "safe" way, though this does not seem to cause obvious security holes. One can set `"doNotRemoveJunkArgs": true` to disable this behavior.

- Hunt for these files after execution and delete them. Only files that are both empty and read-only are considered for removal. One can set `"doNotDeleteJunkFiles": true` to disable this behavior. This approach may cause interference and execution failure when multiple concurrent commands are executed, but will not cause any interference if alll problematic arguments are eliminated in the first pass.

Neither shall make any difference for "Mandatory Deny Files" that already exists in the directory.

If `"doNotRemoveJunkArgs": true` is set but `"doNotDeleteJunkFiles": true` is not, a prompt will be added to tell the model to avoid concurrent commands.

### Other options

- `{"noShimFile": true}` disables the shim file mitigation of the above-mentioned chat history defect. Not recommended since this will clutter context window and waste a lot of tokens. No effect when using with the private OpenCode fork.
- `{"failOpen": true}` enables fail-open mode, which lets commands bypass sandbox if sandbox fails. Generally considered insecure and not recommended.

## How it works

The plugin uses two OpenCode hooks:

1. **`tool.execute.before`** — Intercepts bash commands and wraps them with `SandboxManager.wrapWithSandbox()` before execution
2. **`tool.execute.after`** — Restores the original command in the UI (hides the bwrap wrapper)

```
Agent → bash tool → [plugin wraps command] → sandboxed execution → [plugin restores UI] → Agent
```

The AI model interprets sandbox errors (like "Read-only file system" or "Connection blocked") directly from command output — no additional annotation layer needed.

Sandbox initialization is deferred until the first `bash` command, so the plugin does not interfere with OpenCode startup. Plugin diagnostics are sent through OpenCode's structured logger instead of being printed into the TUI. Sandbox violations are correlated with each individual tool call, including concurrent or repeated commands.

### Windows status

`@anthropic-ai/sandbox-runtime` supports Windows through an argv-and-environment API, while OpenCode currently exposes this plugin's `bash` hook as a command string. Until those interfaces can be connected safely, this plugin leaves Windows commands unsandboxed rather than claiming protection it cannot enforce.

### Fail-safe by default, fail-open if needed

If anything goes wrong (sandbox init fails, wrapping fails, platform unsupported), commands fails with an error message that tells the model to avoid retrying immediately, ensuring that nothing bypasses sandbox.

Setting `{"failOpen": true}` in config file will enable fail-open mode instead, where commands execute without sandbox if anything goes wrong. Suitable only if you do not care much about security but do not want to break your workflow (so why use this plugin in the first place)?

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture, and guidelines.

## Related

- [@anthropic-ai/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) — The underlying sandbox engine
- [OpenCode Plugins Docs](https://opencode.ai/docs/plugins) — How to create and use plugins
- [Claude Code Sandboxing](https://docs.claude.com/en/docs/claude-code/sandboxing) — Anthropic's sandboxing documentation

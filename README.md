# switchbot-openapi-cli

Command-line interface for the [SwitchBot API v1.1](https://github.com/OpenWonderLabs/SwitchBotAPI).
List devices, query status, send control commands, run scenes, and manage webhooks from your terminal or shell scripts.

## Requirements

- Node.js ≥ 18
- A SwitchBot account with Developer Options enabled (see [Credentials](#credentials))

## Installation

```bash
git clone <repo-url>
cd switchbot-openapi-cli
npm install
npm run build
# Optional: make it globally available as `switchbot`
npm link
```

During development you can run directly from sources without building:

```bash
npm run dev -- devices list
```

## Credentials

The CLI reads credentials in this order (first match wins):

1. **Environment variables** — `SWITCHBOT_TOKEN` and `SWITCHBOT_SECRET`
2. **Config file** — `~/.switchbot/config.json` (written by `config set-token`, mode `0600`)

Obtain the token and secret from the SwitchBot mobile app:
**Profile → Preferences → Developer Options → Get Token**.

```bash
# One-time setup (writes ~/.switchbot/config.json)
switchbot config set-token <token> <secret>

# Or export environment variables (e.g. in CI)
export SWITCHBOT_TOKEN=...
export SWITCHBOT_SECRET=...

# Confirm which source is active and see the masked secret
switchbot config show
```

## Global options

| Option              | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `--json`            | Print the raw JSON response instead of a formatted table           |
| `-v`, `--verbose`   | Log HTTP request/response details to stderr                        |
| `--dry-run`         | Print mutating requests (POST/PUT/DELETE) without sending them     |
| `--timeout <ms>`    | HTTP request timeout in milliseconds (default: `30000`)            |
| `--config <path>`   | Override credential file location (default: `~/.switchbot/config.json`) |
| `-V`, `--version`   | Print the CLI version                                              |
| `-h`, `--help`      | Show help for any command or subcommand                            |

Every subcommand supports `--help`, and most include a parameter-format reference and examples.

```bash
switchbot --help
switchbot devices command --help
```

### `--dry-run`

Intercepts every non-GET request: the CLI prints the URL/body it would have
sent, then exits `0` without contacting the API. `GET` requests (list, status,
query) are still executed so you can preview the state involved.

```bash
switchbot devices command ABC123 turnOn --dry-run
# [dry-run] Would POST https://api.switch-bot.com/v1.1/devices/ABC123/commands
# [dry-run] body: {"command":"turnOn","parameter":"default","commandType":"command"}
```

## Commands

### `config` — credential management

```bash
switchbot config set-token <token> <secret>   # Save to ~/.switchbot/config.json
switchbot config show                          # Print current source + masked secret
```

### `devices` — list, status, control

```bash
# List all physical devices and IR remote devices
# Columns: deviceId, deviceName, type, controlType, family, roomID, room, hub, cloud
switchbot devices list
switchbot devices list --json | jq '.deviceList[].deviceId'

# Filter by family / room (family & room info requires the 'src: OpenClaw'
# header, which this CLI sends on every request)
switchbot devices list --json | jq '.deviceList[] | select(.familyName == "Home")'
switchbot devices list --json | jq '[.deviceList[], .infraredRemoteList[]] | group_by(.familyName)'

# Query real-time status of a physical device
switchbot devices status <deviceId>
switchbot devices status <deviceId> --json

# Send a control command
switchbot devices command <deviceId> <cmd> [parameter] [--type command|customize]

# Describe a specific device (1 API call): metadata + supported commands + status fields
switchbot devices describe <deviceId>
switchbot devices describe <deviceId> --json

# Discover what's supported (offline reference, no API call)
switchbot devices types                 # List all device types + IR remote types
switchbot devices commands <type>       # Show commands, parameter formats, and status fields
switchbot devices commands Bot
switchbot devices commands "Smart Lock"
switchbot devices commands curtain      # Case-insensitive, substring match
```

#### Parameter formats

`parameter` is optional — omit it for commands like `turnOn`/`turnOff` (auto-defaults to `"default"`).
Numeric-only and JSON-object parameters are auto-parsed; strings with colons / commas / semicolons pass through as-is.

For the exact commands and parameter formats a specific device supports, query the built-in catalog:

```bash
switchbot devices commands <type>       # e.g. Bot, Curtain, "Smart Lock", "Robot Vacuum Cleaner S10"
```

Generic parameter shapes (which one applies is decided by the device — see the catalog):

| Shape               | Example                                                  |
| ------------------- | -------------------------------------------------------- |
| _(none)_            | `devices command <id> turnOn`                            |
| `<integer>`         | `devices command <id> setBrightness 75`                  |
| `<R:G:B>`           | `devices command <id> setColor "255:0:0"`                |
| `<direction;angle>` | `devices command <id> setPosition "up;60"`               |
| `<a,b,c,…>`         | `devices command <id> setAll "26,1,3,on"`                |
| `<json object>`     | `'{"action":"sweep","param":{"fanLevel":2,"times":1}}'`  |
| Custom IR button    | `devices command <id> MyButton --type customize`         |

For the complete per-device command reference, see the [SwitchBot API docs](https://github.com/OpenWonderLabs/SwitchBotAPI#send-device-control-commands).

### `scenes` — run manual scenes

```bash
switchbot scenes list                 # Columns: sceneId, sceneName
switchbot scenes execute <sceneId>
```

### `webhook` — receive device events over HTTP

```bash
# Register a receiver URL for events from ALL devices
switchbot webhook setup https://your.host/hook

# Query what is currently configured
switchbot webhook query
switchbot webhook query --details https://your.host/hook

# Enable / disable / re-submit the registered URL
switchbot webhook update https://your.host/hook --enable
switchbot webhook update https://your.host/hook --disable

# Remove the configuration
switchbot webhook delete https://your.host/hook
```

The CLI validates that `<url>` is an absolute `http://` or `https://` URL before calling the API. `--enable` and `--disable` are mutually exclusive.

### `completion` — shell tab-completion

```bash
# Bash: load on every new shell
echo 'source <(switchbot completion bash)' >> ~/.bashrc

# Zsh
echo 'source <(switchbot completion zsh)' >> ~/.zshrc

# Fish
switchbot completion fish > ~/.config/fish/completions/switchbot.fish

# PowerShell (profile)
switchbot completion powershell >> $PROFILE
```

Supported shells: `bash`, `zsh`, `fish`, `powershell` (`pwsh` is accepted as an alias).

## Output modes

- **Default** — ANSI-colored tables for `list`/`status`, key-value tables for details.
- **`--json`** — raw JSON passthrough, ideal for `jq` and scripting.

```bash
switchbot devices list --json | jq '.deviceList[] | {id: .deviceId, name: .deviceName}'
```

## Exit codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| `0`  | Success (including `--dry-run` intercept)                                           |
| `1`  | Runtime error — API error, network failure, missing credentials                     |
| `2`  | Usage error — bad flag, missing/invalid argument, unknown subcommand, unknown device type, invalid URL, conflicting flags |

Typical errors bubble up in the form `Error: <message>` on stderr. The SwitchBot-specific error codes that get mapped to readable English messages:

| Code | Meaning                                     |
| ---- | ------------------------------------------- |
| 151  | Device type error                           |
| 152  | Device not found                            |
| 160  | Command not supported by this device        |
| 161  | Device offline (BLE devices need a Hub)     |
| 171  | Hub offline                                 |
| 190  | Device internal error / server busy         |
| 401  | Authentication failed (check token/secret)  |
| 429  | Request rate too high (10,000 req/day cap)  |

## Environment variables

| Variable            | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `SWITCHBOT_TOKEN`   | API token — takes priority over the config file                    |
| `SWITCHBOT_SECRET`  | API secret — takes priority over the config file                   |
| `NO_COLOR`          | Disable ANSI colors in all output (automatically respected)        |

## Scripting examples

```bash
# Turn off every Bot device
switchbot devices list --json \
  | jq -r '.deviceList[] | select(.deviceType == "Bot") | .deviceId' \
  | while read id; do switchbot devices command "$id" turnOff; done

# Dump each scene as `<id> <name>`
switchbot scenes list --json | jq -r '.[] | "\(.sceneId) \(.sceneName)"'
```

## Development

```bash
npm run dev -- <args>      # Run from TypeScript sources via tsx
npm run build              # Compile to dist/
npm test                   # Run the Vitest suite (282 tests)
npm run test:watch         # Watch mode
npm run test:coverage      # Coverage report (v8, HTML + text)
```

### Project layout

```
src/
├── index.ts              # Commander entry; mounts all subcommands; global flags
├── auth.ts               # HMAC-SHA256 signature (token + t + nonce → sign)
├── config.ts             # Credential load/save; env > file priority; --config override
├── api/client.ts         # axios instance + request/response interceptors;
│                         # --verbose / --dry-run / --timeout wiring
├── devices/catalog.ts    # Static catalog powering `devices types`/`devices commands`
├── commands/
│   ├── config.ts
│   ├── devices.ts
│   ├── scenes.ts
│   ├── webhook.ts
│   └── completion.ts     # `switchbot completion bash|zsh|fish|powershell`
└── utils/
    ├── flags.ts          # Global flag readers (isVerbose / isDryRun / getTimeout / getConfigPath)
    └── output.ts         # printTable / printKeyValue / printJson / handleError
tests/                    # Vitest suite (282 tests, mocked axios, no network)
```

## References

- [SwitchBot API v1.1 documentation](https://github.com/OpenWonderLabs/SwitchBotAPI)
- Base URL: `https://api.switch-bot.com`
- Rate limit: 10,000 requests/day per account

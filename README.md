# pi-rc

Remote-control [Pi](https://pi.dev) from your phone over Tailscale.

The **desktop** still gets a real terminal (Zellij + Pi). The **phone** gets a small chat UI: list sessions, stream output, send prompts, stop a turn. Zellij’s web TUI is not the phone UI — it does not type or show panes well on mobile.

Repo: [github.com/raymondtri/pi-rc](https://github.com/raymondtri/pi-rc)

## Requirements

| Piece | Why |
|---|---|
| [Node.js](https://nodejs.org/) 22+ | Runs the broker |
| [Pi](https://pi.dev) (`pi`) | The coding agent |
| [Zellij](https://zellij.dev) 0.45+ | Multiplexer + visible desktop session (`zellij web` exists) |
| [Tailscale](https://tailscale.com) | Phone reaches the desktop on the tailnet only |
| A GUI terminal | Windows Terminal (`wt`), Terminal.app, Ghostty, WezTerm, etc. |

Phone must **already** be logged into the **same Tailscale tailnet**. The QR does not onboard Tailscale.

### Platform notes

- **macOS / Linux:** Zellij + a GUI terminal on `PATH`.
- **Windows:** Zellij 0.45+ (native build is fine), Windows Terminal, Git Bash or similar for `pi`. If Zellij has no config file it will exit immediately; `pi-rc` writes an empty `%APPDATA%\Zellij\config\config.kdl` when missing.
- **Windows Zellij `--daemonize` is unreliable.** The broker starts the web server itself.

## Install

```bash
git clone https://github.com/raymondtri/pi-rc.git
cd pi-rc
npm install
pi install .
```

`pi install .` registers `extension/index.ts` so every Pi session checks in with the broker.

Restart any already-running `pi` after install so the extension loads.

## Run

On the desktop:

```bash
node src/cli.mjs serve
```

That will:

1. Start Zellij web on `127.0.0.1:8082` (desktop mux only)
2. Start the chat broker on `127.0.0.1:18741`
3. Publish it with `tailscale serve` (HTTPS, **tailnet only**, not Funnel)
4. Print a QR + URL
5. Open a local terminal attached to session `pi-rc` (unless `--no-open`)

On the phone: scan the QR (or open the URL). You should get the chat UI.

If Pi is not running yet, tap **new** — that opens a visible terminal on the desk. Wait until the session shows **live**, then type.

Reprint the QR:

```bash
node src/cli.mjs qr
```

Rotate the login token (old scans stop working):

```bash
node src/cli.mjs qr --rotate
```

Other commands:

```text
node src/cli.mjs serve [--no-open] [--https-port N]
node src/cli.mjs status
node src/cli.mjs stop          # Zellij web only; Tailscale Serve is left in place
```

Optional: `npm link` then use `pi-rc` instead of `node src/cli.mjs`.

## How it fits together

```text
Phone (Tailscale)  --HTTPS-->  Tailscale Serve  -->  pi-rc broker (chat SPA + API)
                                                         ^
                                                         | localhost heartbeat
Desktop terminal:  zellij attach  -->  pi  +  pi-rc extension
```

Sending a message on the phone calls `pi.sendUserMessage` in the live TUI. **stop** is Escape-equivalent (`ctx.abort()`).

The footer mirrors Pi’s status line: session name, cwd, model, thinking, context %, cost.

Slash commands from the phone:

| Command | What happens |
|---|---|
| `/model` | Remote picker (or `/model provider/id`) |
| `/thinking` | Remote picker (or `/thinking high`) |
| `/name` | Sets the session name |
| `/compact` | Compacts context |
| `/help` | Lists the above |
| `/skill:…`, templates | Expanded via Pi (`expandPromptTemplates`) |

Type `/` in the phone composer for autocomplete (Pi commands + the ones above). Tap `/model` to open the picker immediately.

Builtin TUI pickers (`/settings`, `/tree`) still live on the desktop. Extension commands that use `ctx.ui.select` / `confirm` / `input` are forwarded to the phone when a watcher is connected.

## Auth and network

- Bind is localhost. The only remote path is Tailscale Serve (your tailnet).
- Do **not** enable Tailscale Funnel.
- The QR carries a Zellij-style login token (also used as the SPA bearer). Rotate with `--rotate`.
- If something else already uses Serve on `:443`, pi-rc picks `:8443` (then `:8444`, `:8445`). It does not reset your existing Serve config.

## Troubleshooting

| Symptom | Fix |
|---|---|
| QR opens but no sessions | Restart `pi` on the desktop after `pi install .` |
| Session stuck on **starting** | Refresh the phone page; confirm the desktop Pi is running and shows a `pi-rc` / remote status |
| `zellij web` dies on Windows | Let pi-rc create the config file, or add `%APPDATA%\Zellij\config\config.kdl` yourself |
| Port 18741 in use | Another `pi-rc serve` is running; stop it and retry |
| Phone cannot load HTTPS | Tailscale app connected to the same tailnet; MagicDNS on |

## License

MIT

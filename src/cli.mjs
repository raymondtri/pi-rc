#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { startBroker } from "./broker.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(os.homedir(), ".pi-rc");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const TOKEN_NAME = "pi-rc";
const ZELLIJ_PORT = 8082;
const JOIN_PORT = 18741;
const SESSION_NAME = "pi-rc";
const SERVE_HTTPS_CANDIDATES = [8443, 8444, 8445];

const usage = `pi-rc — desktop broker for Pi over Tailscale

Usage:
  pi-rc serve [--no-open] [--https-port N]   Start broker + Serve + QR (default)
  pi-rc qr [--rotate]                        Print the connect QR again
  pi-rc stop                                 Stop the Zellij web server
  pi-rc status                               Show zellij / tailscale / token
  pi-rc help

Phone must already be on the same tailnet. Scan the QR for the chat UI.
Desktop still gets a real terminal. Does not touch Tailscale Serve on :443.
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "serve";
  const flags = parseFlags(argv);

  switch (cmd) {
    case "serve":
      await serve(flags);
      return;
    case "qr":
      await printQr(flags);
      return;
    case "stop":
      return stop();
    case "status":
      return status();
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(usage);
      return;
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${usage}`);
      process.exitCode = 1;
  }
}

function parseFlags(argv) {
  const flags = { open: true, rotate: false, httpsPort: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") flags.open = false;
    else if (a === "--rotate") flags.rotate = true;
    else if (a === "--https-port") flags.httpsPort = Number(argv[++i]);
    else throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

async function serve(flags) {
  const zellij = which("zellij") || which("zellij.exe");
  const tailscale = which("tailscale") || which("tailscale.exe");
  if (!zellij) die("zellij not found on PATH");
  if (!tailscale) die("tailscale not found on PATH");

  await ensureWeb(zellij);
  const token = ensureToken(zellij, flags.rotate);
  const httpsPort = flags.httpsPort || pickHttpsPort(tailscale);
  exposeTailscale(tailscale, httpsPort);
  const url = joinUrl(tailscale, httpsPort, token);

  startBroker({
    token,
    port: JOIN_PORT,
    root: ROOT,
    onCreateSession: ({ name, cwd }) => openLocalTerminal(zellij, { session: name, cwd }),
    onError: (err) => {
      if (err.code === "EADDRINUSE") {
        die(`broker already listening on 127.0.0.1:${JOIN_PORT} (is pi-rc serve already running?)`);
      }
      die(err.message);
    },
  });
  if (flags.open) openLocalTerminal(zellij, { session: SESSION_NAME });

  process.stdout.write("\n");
  process.stdout.write(`Chat UI      http://127.0.0.1:${JOIN_PORT}\n`);
  process.stdout.write(`Join (QR)    ${url}\n`);
  process.stdout.write(`Local attach zellij attach -c ${SESSION_NAME}\n`);
  process.stdout.write("\nScan from your phone (already on the tailnet):\n\n");
  qrcode.generate(url, { small: true });
  process.stdout.write("\nCtrl+C stops the phone UI. Zellij web keeps running (`pi-rc stop`).\n");

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

async function printQr(flags) {
  const zellij = which("zellij") || which("zellij.exe");
  const tailscale = which("tailscale") || which("tailscale.exe");
  if (!zellij) die("zellij not found on PATH");
  if (!tailscale) die("tailscale not found on PATH");
  await ensureWeb(zellij);
  const token = ensureToken(zellij, flags.rotate);
  const httpsPort = flags.httpsPort || readState().httpsPort || pickHttpsPort(tailscale);
  const url = joinUrl(tailscale, httpsPort, token);
  process.stdout.write(`${url}\n\n`);
  qrcode.generate(url, { small: true });
}

function stop() {
  const zellij = which("zellij") || which("zellij.exe");
  if (!zellij) die("zellij not found on PATH");
  run(zellij, ["web", "--stop"]);
  process.stdout.write("Stopped Zellij web. Tailscale Serve left in place.\n");
}

function status() {
  const zellij = which("zellij") || which("zellij.exe");
  const tailscale = which("tailscale") || which("tailscale.exe");
  if (zellij) {
    try {
      process.stdout.write(`zellij:  ${run(zellij, ["web", "--status"]).trim()}\n`);
    } catch (err) {
      process.stdout.write(`zellij:  ${err.message}\n`);
    }
  } else process.stdout.write("zellij:  not found\n");
  if (tailscale) {
    process.stdout.write(`dns:     ${magicDns(tailscale)}\n`);
    process.stdout.write(`serve:\n${run(tailscale, ["serve", "status"])}\n`);
  } else process.stdout.write("tailscale: not found\n");
  const state = readState();
  process.stdout.write(`token:   ${state.tokenName || "(none)"} ${state.token ? "(saved)" : ""}\n`);
}

function zellijConfigPath() {
  if (process.platform === "win32") {
    const appdata =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "Zellij", "config", "config.kdl");
  }
  return path.join(os.homedir(), ".config", "zellij", "config.kdl");
}

function ensureZellijConfig() {
  const file = zellijConfigPath();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      "// created by pi-rc so zellij web has a config file path\n",
    );
  }
  return file;
}

async function ensureWeb(zellij) {
  if (await webOnline()) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const config = ensureZellijConfig();
  const logPath = path.join(STATE_DIR, "web.log");
  const log = fs.openSync(logPath, "a");
  const child = spawn(
    zellij,
    ["--config", config, "web", "--start", "--ip", "127.0.0.1", "--port", String(ZELLIJ_PORT)],
    {
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
    },
  );
  child.unref();
  writeState({ ...readState(), webPid: child.pid });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await webOnline()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  die(`zellij web did not come up on 127.0.0.1:${ZELLIJ_PORT} (see ${logPath})`);
}

async function webOnline() {
  try {
    const res = await fetch(`http://127.0.0.1:${ZELLIJ_PORT}/info/version`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function ensureToken(zellij, rotate) {
  const state = readState();
  if (!rotate && state.token) return state.token;
  if (rotate && state.tokenName) {
    try {
      run(zellij, ["web", "--revoke-token", state.tokenName]);
    } catch {
      // token may already be gone
    }
  }
  const out = run(zellij, ["web", "--create-token"]);
  const parsed = parseToken(out);
  if (!parsed) die(`could not parse zellij token from:\n${out}`);
  writeState({
    ...state,
    tokenName: parsed.name,
    token: parsed.token,
    createdAt: new Date().toISOString(),
  });
  return parsed.token;
}

function parseToken(out) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const named = line.match(/^(token_\d+|\S+)\s*:\s*([0-9a-f-]{16,})$/i);
    if (named) return { name: named[1], token: named[2] };
    const labeled = line.match(/^(?:token|auth(?:entication)? token)\s*[:=]\s*(\S+)/i);
    if (labeled) return { name: TOKEN_NAME, token: labeled[1] };
  }
  const any = out.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  return any ? { name: TOKEN_NAME, token: any[0] } : null;
}

function pickHttpsPort(tailscale) {
  const saved = readState().httpsPort;
  if (saved) return saved;
  const used = servedHttpsPorts(tailscale);
  for (const port of SERVE_HTTPS_CANDIDATES) {
    if (!used.has(port)) return port;
  }
  die(`no free Tailscale HTTPS port among ${SERVE_HTTPS_CANDIDATES.join(", ")}`);
}

function servedHttpsPorts(tailscale) {
  const used = new Set();
  let json;
  try {
    json = JSON.parse(run(tailscale, ["serve", "status", "--json"]));
  } catch {
    return used;
  }
  for (const key of Object.keys(json.TCP || {})) {
    const port = Number(String(key).replace(/^:/, ""));
    if (json.TCP[key]?.HTTPS) used.add(port);
  }
  return used;
}

function exposeTailscale(tailscale, httpsPort) {
  run(tailscale, [
    "serve",
    "--bg",
    "--yes",
    "--https",
    String(httpsPort),
    `http://127.0.0.1:${JOIN_PORT}`,
  ]);
  writeState({ ...readState(), httpsPort });
}

function joinUrl(tailscale, httpsPort, token) {
  const host = magicDns(tailscale);
  const port = httpsPort === 443 ? "" : `:${httpsPort}`;
  return `https://${host}${port}/?t=${encodeURIComponent(token)}`;
}

function magicDns(tailscale) {
  const json = JSON.parse(run(tailscale, ["status", "--json"]));
  const name = json.Self?.DNSName || "";
  return name.replace(/\.$/, "");
}

function openLocalTerminal(zellij, opts = {}) {
  const session = opts.session || SESSION_NAME;
  const cwd = opts.cwd || os.homedir();
  const pi = which("pi.cmd") || which("pi") || which("pi.exe");
  const args = pi
    ? ["attach", "-c", session, "--", pi, "--name", session]
    : ["attach", "-c", session];
  const env = { ...process.env, PI_RC_NAME: session };

  if (process.platform === "win32") {
    const wt = which("wt.exe") || which("wt");
    if (wt) {
      spawnDetached(wt, ["-w", "0", "nt", "--title", session, "-d", cwd, zellij, ...args], { env });
      return;
    }
  }
  if (process.platform === "darwin") {
    const cmd = `${shellQuote(zellij)} ${args.map(shellQuote).join(" ")}`;
    spawnDetached("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(cmd)}`], { env });
    return;
  }
  if (process.platform === "linux") {
    const term = which("ghostty") || which("wezterm") || which("kitty") || which("x-terminal-emulator") || which("gnome-terminal");
    if (term && path.basename(term) === "wezterm") {
      spawnDetached(term, ["start", "--", zellij, ...args], { env });
      return;
    }
    if (term && path.basename(term) === "gnome-terminal") {
      spawnDetached(term, ["--", zellij, ...args], { env });
      return;
    }
    if (term) {
      spawnDetached(term, ["-e", zellij, ...args], { env });
      return;
    }
  }
  process.stderr.write("Could not open a GUI terminal; attach locally with:\n");
  process.stderr.write(`  ${zellij} ${args.join(" ")}\n`);
}

function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    cwd: opts.cwd,
    env: opts.env,
  });
  child.unref();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function which(name) {
  const paths = process.env.PATH?.split(path.delimiter) || [];
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  const hasExt = path.extname(name) !== "";
  for (const dir of paths) {
    const candidates = hasExt ? [path.join(dir, name)] : exts.map((ext) => path.join(dir, name + ext));
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch {
          // continue
        }
      }
    }
  }
  if (process.platform === "win32") {
    const extras = [
      path.join(os.homedir(), "AppData", "Local", "Zellij", name),
      path.join(os.homedir(), "AppData", "Local", "Zellij", `${name}.exe`),
      path.join("C:\\Program Files\\Tailscale", name),
      path.join("C:\\Program Files\\Tailscale", `${name}.exe`),
    ];
    for (const candidate of extras) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = err.stderr?.toString?.() || "";
    const stdout = err.stdout?.toString?.() || "";
    throw new Error(stderr.trim() || stdout.trim() || err.message);
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((err) => die(err.stack || err.message));

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MAX_TRANSCRIPT = 400;
const STALE_MS = 15_000;
const PENDING_MS = 30_000;

export function startBroker({ token, port, root, onCreateSession, onError }) {
  const sessions = new Map();
  const sse = new Set();
  const publicDir = path.join(root, "public");
  const indexHtml = fs.readFileSync(path.join(publicDir, "index.html"));

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.on("error", (err) => {
    if (onError) onError(err);
    else throw err;
  });
  server.listen(port, "127.0.0.1");

  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const { pathname } = url;

    if (req.method === "GET" && (pathname === "/" || pathname === "/join")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(indexHtml);
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith("/api/agent/")) {
      if (!isLocal(req)) {
        json(res, 403, { error: "agent API is localhost only" });
        return;
      }
      await handleAgent(req, res, url);
      return;
    }

    if (!authorized(req, url)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && pathname === "/api/sessions") {
      json(res, 200, { sessions: listSessions() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/stream") {
      attachSse(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/sessions") {
      const body = await readJson(req);
      const name = sanitizeName(body.name) || `pi-${Math.random().toString(36).slice(2, 6)}`;
      const cwd = body.cwd || process.env.USERPROFILE || process.env.HOME;
      onCreateSession?.({ name, cwd });
      const pending = upsertSession({
        id: `pending:${name}`,
        name,
        cwd,
        streaming: false,
        online: false,
        pending: true,
        lastSeen: Date.now(),
      });
      broadcast({ type: "sessions", sessions: listSessions() });
      json(res, 200, { session: publicSession(pending) });
      return;
    }

    const promptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
    if (req.method === "POST" && promptMatch) {
      const session = sessions.get(decodeURIComponent(promptMatch[1]));
      if (!session || session.pending) {
        json(res, 404, { error: "session not connected yet" });
        return;
      }
      const body = await readJson(req);
      const text = String(body.text || "").trim();
      if (!text) {
        json(res, 400, { error: "empty prompt" });
        return;
      }
      session.inbox.push({
        text,
        deliverAs: body.deliverAs || (session.streaming ? "steer" : null),
      });
      append(session, { role: "user", text });
      broadcast({ type: "user", sessionId: session.id, text });
      json(res, 200, { ok: true });
      return;
    }

    const abortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
    if (req.method === "POST" && abortMatch) {
      const session = sessions.get(decodeURIComponent(abortMatch[1]));
      if (!session) {
        json(res, 404, { error: "unknown session" });
        return;
      }
      session.abortRequested = true;
      session.inbox.push({ type: "abort" });
      json(res, 200, { ok: true });
      return;
    }

    const uiMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/ui$/);
    if (req.method === "POST" && uiMatch) {
      const session = sessions.get(decodeURIComponent(uiMatch[1]));
      if (!session) {
        json(res, 404, { error: "unknown session" });
        return;
      }
      const body = await readJson(req);
      const pickId = String(body.pickId || body.id || "");
      if (!pickId || !session.uiPending?.has(pickId)) {
        json(res, 404, { error: "unknown picker" });
        return;
      }
      session.uiPending.set(pickId, {
        ...session.uiPending.get(pickId),
        pending: false,
        value: body.value,
        cancel: Boolean(body.cancel),
      });
      session.ui = null;
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: "not found" });
  }

  async function handleAgent(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/agent/hello") {
      const body = await readJson(req);
      if (!body.id) {
        json(res, 400, { error: "id required" });
        return;
      }
      const existed = sessions.has(String(body.id));
      const session = upsertSession({
        id: String(body.id),
        name: body.name || body.id,
        cwd: body.cwd,
        sessionFile: body.sessionFile,
        model: body.model,
        streaming: Boolean(body.streaming),
        online: true,
        pending: false,
        lastSeen: Date.now(),
        footer: body.footer || undefined,
        managed: Boolean(body.managed),
      });
      if (body.footer) session.footer = body.footer;
      if (body.name) session.name = body.name;
      session.managed = Boolean(body.managed);
      if (Array.isArray(body.commands)) session.commands = body.commands;
      adoptPending(session);
      if (!existed) broadcast({ type: "sessions", sessions: listSessions() });
      else if (body.footer || body.commands) {
        broadcast({
          type: "footer",
          sessionId: session.id,
          footer: session.footer,
          name: session.name,
          commands: session.commands || [],
        });
      }
      json(res, 200, { ok: true, sessionId: session.id, watchers: sse.size });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent/bye") {
      const body = await readJson(req);
      if (body.id && sessions.delete(body.id)) {
        broadcast({ type: "sessions", sessions: listSessions() });
      }
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent/event") {
      const body = await readJson(req);
      const session = sessions.get(body.sessionId);
      if (!session) {
        json(res, 404, { error: "unknown session" });
        return;
      }
      session.lastSeen = Date.now();
      session.online = true;
      if (body.type === "delta") {
        session.streaming = true;
        append(session, { role: "assistant", text: body.text, delta: true });
        broadcast({ type: "delta", sessionId: session.id, text: body.text });
      } else if (body.type === "tool") {
        append(session, { role: "tool", text: `${body.phase} ${body.name}` });
        broadcast({ type: "tool", sessionId: session.id, name: body.name, phase: body.phase });
      } else if (body.type === "status") {
        session.streaming = Boolean(body.streaming);
        if (body.model) session.model = body.model;
        broadcast({
          type: "status",
          sessionId: session.id,
          streaming: session.streaming,
          online: true,
          model: session.model,
        });
      } else if (body.type === "turn_end") {
        session.streaming = false;
        session.abortRequested = false;
        broadcast({ type: "turn_end", sessionId: session.id });
      } else if (body.type === "aborted") {
        session.abortRequested = false;
        session.streaming = false;
        append(session, { role: "meta", text: "stopped" });
        broadcast({ type: "status", sessionId: session.id, streaming: false, online: true });
        broadcast({ type: "tool", sessionId: session.id, name: "stop", phase: "end" });
      } else if (body.type === "echo") {
        append(session, { role: "meta", text: body.text });
        broadcast({ type: "echo", sessionId: session.id, text: body.text });
      } else if (body.type === "ui") {
        if (!session.uiPending) session.uiPending = new Map();
        session.uiPending.set(body.pick.id, { ...body.pick, pending: true });
        session.ui = body.pick;
        broadcast({ type: "ui", sessionId: session.id, pick: body.pick });
      }
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/inbox") {
      const id = url.searchParams.get("id");
      const session = id ? sessions.get(id) : null;
      if (!session) {
        json(res, 200, { prompts: [] });
        return;
      }
      session.lastSeen = Date.now();
      session.online = true;
      const prompts = session.inbox.splice(0, session.inbox.length);
      if (session.abortRequested && !prompts.some((item) => item.type === "abort")) {
        prompts.unshift({ type: "abort" });
      }
      json(res, 200, { prompts });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/ui") {
      const session = sessions.get(url.searchParams.get("sessionId"));
      const pickId = url.searchParams.get("pickId");
      const pick = session?.uiPending?.get(pickId);
      if (!pick) {
        json(res, 200, { pending: true });
        return;
      }
      json(res, 200, pick.pending === false ? { pending: false, value: pick.value, cancel: pick.cancel } : { pending: true });
      return;
    }

    json(res, 404, { error: "not found" });
  }

  function upsertSession(fields) {
    const prev = sessions.get(fields.id) || {
      id: fields.id,
      transcript: [],
      inbox: [],
      assistantBuf: "",
    };
    const next = { ...prev, ...fields };
    if (!next.transcript) next.transcript = [];
    if (!next.inbox) next.inbox = [];
    if (!next.uiPending) next.uiPending = new Map();
    sessions.set(next.id, next);
    return next;
  }

  function append(session, entry) {
    if (entry.delta) {
      session.assistantBuf = (session.assistantBuf || "") + entry.text;
      const last = session.transcript[session.transcript.length - 1];
      if (last?.role === "assistant" && last.live) last.text = session.assistantBuf;
      else session.transcript.push({ role: "assistant", text: session.assistantBuf, live: true });
    } else {
      if (entry.role === "user") session.assistantBuf = "";
      const last = session.transcript[session.transcript.length - 1];
      if (last?.live) last.live = false;
      session.transcript.push(entry);
    }
    if (session.transcript.length > MAX_TRANSCRIPT) {
      session.transcript.splice(0, session.transcript.length - MAX_TRANSCRIPT);
    }
  }

  function adoptPending(session) {
    const pending = [...sessions.values()].filter((other) => other.pending);
    const named = pending.find((other) => other.name && other.name === session.name);
    const sameCwd = pending.find(
      (other) => other.cwd && session.cwd && pathsEqual(other.cwd, session.cwd),
    );
    const match = named || sameCwd || (pending.length === 1 ? pending[0] : null);
    if (!match) return;
    sessions.delete(match.id);
    if (match.inbox?.length) session.inbox.push(...match.inbox);
    if (match.transcript?.length && !session.transcript.length) {
      session.transcript = match.transcript;
    }
  }

  function pruneStale() {
    const now = Date.now();
    for (const [id, s] of sessions) {
      const age = now - (s.lastSeen || 0);
      const deadHeartbeat = !s.pending && age > STALE_MS;
      const deadPending = s.pending && age > PENDING_MS;
      if (deadHeartbeat || deadPending) sessions.delete(id);
    }
  }

  function listSessions() {
    pruneStale();
    return [...sessions.values()].map(publicSession);
  }

  function publicSession(s) {
    return {
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      model: s.model,
      streaming: Boolean(s.streaming),
      online: Boolean(s.online),
      pending: Boolean(s.pending),
      transcript: s.transcript || [],
      footer: s.footer || null,
      ui: s.ui || null,
      commands: s.commands || [],
      managed: Boolean(s.managed),
    };
  }

  function attachSse(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "sessions", sessions: listSessions() })}\n\n`);
    sse.add(res);
    req.on("close", () => sse.delete(res));
  }

  function broadcast(event) {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sse) {
      try {
        client.write(frame);
      } catch {
        sse.delete(client);
      }
    }
  }

  function authorized(req, url) {
    const header = req.headers.authorization || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const q = url.searchParams.get("t") || "";
    return Boolean(token) && (bearer === token || q === token);
  }

  return server;
}

function isLocal(req) {
  const addr = req.socket.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function pathsEqual(a, b) {
  return String(a).replace(/[\/]+$/, "").toLowerCase() === String(b).replace(/[\/]+$/, "").toLowerCase();
}

function sanitizeName(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const BROKER = process.env.PI_RC_URL || "http://127.0.0.1:18741";
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export default function (pi: any) {
  let sessionId = "";
  let latestCtx: any;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let abortArmed = false;
  let draining = false;
  let watchers = 0;
  let uiWrapped = false;

  const post = async (path: string, body: unknown) => {
    try {
      const res = await fetch(`${BROKER}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return await res.json().catch(() => ({}));
    } catch {
      return null;
    }
  };

  const remember = (ctx: any) => {
    if (ctx) latestCtx = ctx;
  };

  const abortNow = (ctx: any = latestCtx) => {
    abortArmed = true;
    try {
      ctx?.abort?.();
    } catch {
      // retry on the next event
    }
  };

  const echo = (text: string) =>
    post("/api/agent/event", { sessionId, type: "echo", text });

  const footerOf = (ctx: any) => {
    const usage = ctx.getContextUsage?.();
    let cost = 0;
    for (const entry of ctx.sessionManager?.getEntries?.() || []) {
      const u = entry?.usage || entry?.message?.usage;
      const c = typeof u?.cost === "number" ? u.cost : u?.cost?.total;
      if (typeof c === "number") cost += c;
    }
    const model = ctx.model;
    return {
      name:
        process.env.PI_RC_NAME ||
        pi.getSessionName?.() ||
        ctx.sessionManager?.getSessionName?.() ||
        sessionId.slice(0, 8),
      cwd: ctx.cwd,
      model: model ? `${model.provider}/${model.id}` : undefined,
      modelId: model?.id,
      thinking: pi.getThinkingLevel?.() || ctx.thinkingLevel,
      tokens: usage?.tokens ?? null,
      percent: usage?.percent ?? null,
      contextWindow: usage?.contextWindow,
      cost,
    };
  };

  const hello = async (ctx: any) => {
    remember(ctx);
    sessionId = ctx.sessionManager?.getSessionId?.() || sessionId;
    if (!sessionId) return;
    const data = await post("/api/agent/hello", {
      id: sessionId,
      name: footerOf(ctx).name,
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager?.getSessionFile?.(),
      model: ctx.model?.id,
      streaming: !ctx.isIdle?.(),
      footer: footerOf(ctx),
      commands: commandList(),
      managed: Boolean(process.env.PI_RC_NAME || process.env.ZELLIJ),
    });
    if (typeof data?.watchers === "number") watchers = data.watchers;
  };

  const waitUi = async (pickId: string, timeoutMs = 120_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs && !stopped) {
      try {
        const res = await fetch(
          `${BROKER}/api/agent/ui?sessionId=${encodeURIComponent(sessionId)}&pickId=${encodeURIComponent(pickId)}`,
        );
        if (res.ok) {
          const body = await res.json();
          if (body && body.pending === false) return body;
        }
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { cancel: true };
  };

  const remoteUi = async (kind: string, title: string, options?: { id: string; label: string }[], message?: string) => {
    const pickId = crypto.randomUUID();
    await post("/api/agent/event", {
      sessionId,
      type: "ui",
      pick: { id: pickId, kind, title, message, options: options || [] },
    });
    return waitUi(pickId);
  };

  const wrapUi = (ctx: any) => {
    const ui = ctx.ui;
    if (!ui || ui.__piRcWrapped) return;
    ui.__piRcWrapped = true;
    uiWrapped = true;
    const origSelect = ui.select?.bind(ui);
    const origConfirm = ui.confirm?.bind(ui);
    const origInput = ui.input?.bind(ui);
    ui.select = async (title: string, options: string[], opts?: unknown) => {
      if (watchers > 0) {
        const result = await remoteUi(
          "pick",
          title,
          options.map((value) => ({ id: value, label: value })),
        );
        if (!result.cancel) return result.value;
      }
      return origSelect?.(title, options, opts);
    };
    ui.confirm = async (title: string, message: string, opts?: unknown) => {
      if (watchers > 0) {
        const result = await remoteUi("confirm", title, [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ], message);
        if (!result.cancel) return result.value === "yes";
      }
      return origConfirm?.(title, message, opts);
    };
    ui.input = async (title: string, placeholder?: string, opts?: unknown) => {
      if (watchers > 0) {
        const result = await remoteUi("ask", title, undefined, placeholder);
        if (!result.cancel) return result.value;
      }
      return origInput?.(title, placeholder, opts);
    };
  };

  const commandList = () => {
    const ours = [
      { name: "model", description: "Switch model" },
      { name: "thinking", description: "Thinking level" },
      { name: "name", description: "Rename session" },
      { name: "compact", description: "Compact context" },
      { name: "help", description: "Phone slash commands" },
    ];
    const rest = (pi.getCommands?.() || []).map((c: any) => ({
      name: String(c.name || "").replace(/^\//, ""),
      description: c.description || "",
    }));
    const seen = new Set<string>();
    const out: { name: string; description: string }[] = [];
    for (const c of [...ours, ...rest]) {
      if (!c.name || seen.has(c.name)) continue;
      seen.add(c.name);
      out.push(c);
    }
    return out;
  };

  const modelsOf = (ctx: any) => {
    const scoped = ctx.scopedModels || [];
    if (scoped.length) return scoped.map((row: any) => row.model || row);
    return ctx.modelRegistry?.getAvailable?.() || [];
  };

  const handleSlash = async (ctx: any, text: string) => {
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return false;
    const cmd = match[1].toLowerCase();
    const arg = (match[2] || "").trim();

    if (cmd === "help") {
      await echo("/model [id]\n/thinking [level]\n/name [name]\n/compact\n/help");
      return true;
    }

    if (cmd === "model") {
      const models = modelsOf(ctx);
      if (arg) {
        const q = arg.toLowerCase();
        const found = models.find((m: any) => {
          const id = String(m.id || "").toLowerCase();
          const full = `${m.provider}/${m.id}`.toLowerCase();
          return id === q || full === q || id.includes(q) || full.includes(q);
        });
        if (!found) {
          await echo(`unknown model: ${arg}`);
          return true;
        }
        const ok = await pi.setModel(found);
        await echo(ok ? `model ${found.provider}/${found.id}` : "failed to set model");
        return true;
      }
      const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
      const result = await remoteUi(
        "pick",
        "Model",
        models.map((m: any) => ({
          id: `${m.provider}/${m.id}`,
          label: `${m.id}${current === `${m.provider}/${m.id}` ? "  *" : ""}`,
        })),
      );
      if (result.cancel) return true;
      const found = models.find((m: any) => `${m.provider}/${m.id}` === result.value);
      if (!found) return true;
      const ok = await pi.setModel(found);
      await echo(ok ? `model ${found.provider}/${found.id}` : "failed to set model");
      return true;
    }

    if (cmd === "thinking" || cmd === "think") {
      if (arg) {
        if (!THINKING.includes(arg)) {
          await echo(`levels: ${THINKING.join(" ")}`);
          return true;
        }
        pi.setThinkingLevel(arg);
        await echo(`thinking ${arg}`);
        return true;
      }
      const current = pi.getThinkingLevel?.() || ctx.thinkingLevel || "off";
      const result = await remoteUi(
        "pick",
        "Thinking",
        THINKING.map((level) => ({
          id: level,
          label: level === current ? `${level}  *` : level,
        })),
      );
      if (result.cancel) return true;
      pi.setThinkingLevel(result.value);
      await echo(`thinking ${result.value}`);
      return true;
    }

    if (cmd === "name") {
      if (arg) {
        pi.setSessionName(arg);
        await echo(`name ${arg}`);
        return true;
      }
      const result = await remoteUi("ask", "Session name");
      if (result.cancel || !result.value) return true;
      pi.setSessionName(result.value);
      await echo(`name ${result.value}`);
      return true;
    }

    if (cmd === "compact") {
      ctx.compact?.();
      await echo("compacting…");
      return true;
    }

    return false;
  };

  const drainInbox = async (ctx: any) => {
    remember(ctx);
    if (!sessionId || draining) return;
    draining = true;
    let items: any[] = [];
    try {
      const res = await fetch(`${BROKER}/api/agent/inbox?id=${encodeURIComponent(sessionId)}`);
      if (res.ok) {
        const body = await res.json();
        items = body.prompts || [];
      }
    } catch {
      draining = false;
      return;
    }
    draining = false;
    for (const item of items) {
      if (item.type === "abort") {
        abortNow(ctx);
        await post("/api/agent/event", { sessionId, type: "aborted" });
        continue;
      }
      const text = String(item.text || "");
      if (!text) continue;
      if (text.startsWith("/")) {
        if (await handleSlash(ctx, text)) continue;
        await pi.sendUserMessage(text, {
          expandPromptTemplates: true,
          ...(ctx.isIdle?.() ? {} : { deliverAs: item.deliverAs || "steer" }),
        });
        continue;
      }
      const opts: Record<string, string> = {};
      if (!ctx.isIdle?.() || item.deliverAs) opts.deliverAs = item.deliverAs || "steer";
      await pi.sendUserMessage(text, Object.keys(opts).length ? opts : undefined);
    }
  };

  const startLoop = (ctx: any) => {
    remember(ctx);
    if (timer) return;
    timer = setInterval(() => {
      if (stopped) return;
      const active = latestCtx || ctx;
      void hello(active);
      void drainInbox(active);
    }, 400);
  };

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    stopped = false;
    abortArmed = false;
    wrapUi(ctx);
    await hello(ctx);
    startLoop(ctx);
    ctx.ui?.setStatus?.("pi-rc", "remote");
  });

  pi.on("session_shutdown", async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (sessionId) await post("/api/agent/bye", { id: sessionId });
  });

  pi.on("agent_start", async (_event: unknown, ctx: any) => {
    remember(ctx);
    if (abortArmed) abortNow(ctx);
    await post("/api/agent/event", {
      sessionId,
      type: "status",
      streaming: true,
      model: ctx.model?.id,
    });
  });

  pi.on("agent_settled", async () => {
    abortArmed = false;
    await post("/api/agent/event", { sessionId, type: "turn_end" });
  });

  pi.on("message_update", (event: any, ctx: any) => {
    remember(ctx);
    if (abortArmed) abortNow(ctx);
    const ev = event?.assistantMessageEvent;
    if (ev?.type === "text_delta" && typeof ev.delta === "string" && ev.delta) {
      void post("/api/agent/event", { sessionId, type: "delta", text: ev.delta });
    }
  });

  pi.on("tool_execution_start", (event: any, ctx: any) => {
    remember(ctx);
    if (abortArmed) abortNow(ctx);
    void post("/api/agent/event", {
      sessionId,
      type: "tool",
      phase: "start",
      name: event?.toolName ?? "tool",
    });
  });

  pi.on("tool_execution_end", (event: any) => {
    void post("/api/agent/event", {
      sessionId,
      type: "tool",
      phase: "end",
      name: event?.toolName ?? "tool",
    });
  });

  void uiWrapped;
}

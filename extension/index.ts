const BROKER = process.env.PI_RC_URL || "http://127.0.0.1:18741";

export default function (pi: any) {
  let sessionId = "";
  let latestCtx: any;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let abortArmed = false;
  let draining = false;

  const post = async (path: string, body: unknown) => {
    try {
      await fetch(`${BROKER}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // broker not running
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
      // ctx may be stale; retry on the next event
    }
  };

  const hello = async (ctx: any) => {
    remember(ctx);
    sessionId = ctx.sessionManager?.getSessionId?.() || sessionId;
    if (!sessionId) return;
    await post("/api/agent/hello", {
      id: sessionId,
      name:
        process.env.PI_RC_NAME ||
        ctx.sessionManager?.getSessionName?.() ||
        sessionId.slice(0, 8),
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager?.getSessionFile?.(),
      model: ctx.model?.id,
      streaming: !ctx.isIdle?.(),
    });
  };

  const drainInbox = async (ctx: any) => {
    remember(ctx);
    if (!sessionId || draining) return;
    draining = true;
    try {
      const res = await fetch(`${BROKER}/api/agent/inbox?id=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const { prompts } = await res.json();
      for (const item of prompts || []) {
        if (item.type === "abort") {
          abortNow(ctx);
          await post("/api/agent/event", { sessionId, type: "aborted" });
          continue;
        }
        const text = String(item.text || "");
        if (!text) continue;
        const opts: Record<string, string> = {};
        if (!ctx.isIdle?.() || item.deliverAs) {
          opts.deliverAs = item.deliverAs || "steer";
        }
        await pi.sendUserMessage(text, Object.keys(opts).length ? opts : undefined);
      }
    } catch {
      // ignore
    } finally {
      draining = false;
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
}

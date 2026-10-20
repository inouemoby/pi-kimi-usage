import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

// ─── Types ───────────────────────────────────────────────────────
interface UsageData {
  level: string; // membership level, e.g. LEVEL_INTERMEDIATE
  subType: string; // subscription type, e.g. TYPE_PURCHASE
  fiveHourUsed: number;
  fiveHourLimit: number;
  fiveHourResetMs: number;
  weekUsed: number;
  weekLimit: number;
  weekResetMs: number;
  monthUsed: number;
  monthLimit: number;
  parallelLimit: number;
  _ts: number;
}

const CACHE_MS = 60_000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const API_URL = "https://api.kimi.com/coding/v1/usages";

// ─── API Key Storage ─────────────────────────────────────────────
function getAuthPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return resolve(home, ".pi", "agent", "auth.json");
}

function readApiKey(): string {
  // 1. pi auth config (same key pi uses to call Kimi models)
  try {
    const path = getAuthPath();
    if (existsSync(path)) {
      const auth = JSON.parse(readFileSync(path, "utf-8"));
      const key = auth?.["kimi-coding"]?.key ?? auth?.kimi?.key ?? "";
      if (key) return key;
    }
  } catch { /* fall through */ }
  // 2. environment variable
  if (process.env.KIMI_API_KEY) return process.env.KIMI_API_KEY;
  // 3. kimi-desktop auto-provisioned key (daimon-share/config.toml)
  try {
    const appdata = process.env.APPDATA;
    if (appdata) {
      const p = resolve(appdata, "kimi-desktop", "daimon-share", "config.toml");
      if (existsSync(p)) {
        const m = readFileSync(p, "utf-8").match(/api_key\s*=\s*"([^"]+)"/);
        if (m) return m[1];
      }
    }
  } catch { /* fall through */ }
  return "";
}

// ─── Helpers ─────────────────────────────────────────────────────
/** Returns severity: 0=normal, 1=above expected, 2=critical (1.5x expected) */
function usageSeverity(pct: number, windowMs: number, resetMs: number): number {
  if (resetMs <= 0) return 0;
  const remainingMs = resetMs - Date.now();
  const elapsedMs = Math.max(0, windowMs - remainingMs);
  const elapsedRatio = elapsedMs / windowMs;
  const expectedPct = elapsedRatio * 100;
  if (pct > expectedPct * 1.5) return 2;
  if (pct > expectedPct) return 1;
  return 0;
}

function humanDuration(untilMs: number): string {
  if (untilMs <= 0) return "now";
  const m = Math.floor(untilMs / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins}m`;
  return `${mins}m`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1000)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

// ─── Fetch ───────────────────────────────────────────────────────
async function fetchUsage(apiKey: string): Promise<UsageData> {
  const resp = await fetch(API_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();

  const num = (v: unknown): number => parseInt(String(v ?? "0"), 10) || 0;

  // Weekly quota (resets every 7 days)
  const usage = json.usage ?? {};
  const weekUsed = num(usage.used);
  const weekLimit = num(usage.limit);
  const weekResetMs = usage.resetTime ? Date.parse(usage.resetTime) : 0;

  // 5-hour rolling rate-limit window (duration=300 minutes)
  let fiveHourUsed = 0, fiveHourLimit = 0, fiveHourResetMs = 0;
  const limits: any[] = json.limits ?? [];
  const win =
    limits.find((l) => l?.window?.duration === 300 && l?.window?.timeUnit === "TIME_UNIT_MINUTE") ??
    limits[0];
  if (win?.detail) {
    fiveHourUsed = num(win.detail.used);
    fiveHourLimit = num(win.detail.limit);
    fiveHourResetMs = win.detail.resetTime ? Date.parse(win.detail.resetTime) : 0;
  }

  // Monthly total quota (no reset timestamp exposed by this endpoint)
  const tq = json.totalQuota ?? {};
  const monthLimit = num(tq.limit);
  const monthUsed = monthLimit - num(tq.remaining);

  return {
    level: json.user?.membership?.level ?? "unknown",
    subType: json.subType ?? "",
    fiveHourUsed, fiveHourLimit, fiveHourResetMs,
    weekUsed, weekLimit, weekResetMs,
    monthUsed, monthLimit,
    parallelLimit: num(json.parallel?.limit),
    _ts: Date.now(),
  };
}

// ─── Main ────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  let apiKey = "";
  let usage: UsageData | null = null;
  let footerOn = false;
  let footerGeneration = 0;
  let _tui: any = null;
  let thinkingLevel = "off";
  const IDLE_REFRESH_MS = 30 * 60 * 1000;  // 闲时定时刷新: 30 分钟
  let latestCtx: any = null;              // 最近一次事件拿到的 ctx,供定时器使用
  let agentBusy = false;                  // agent 生成中 = true,定时刷新只在闲时执行
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  async function getUsage(): Promise<UsageData> {
    if (!apiKey) throw new Error("Kimi API key not found (auth.json kimi-coding.key / KIMI_API_KEY)");
    if (usage && Date.now() - usage._ts < CACHE_MS) return usage;
    usage = await fetchUsage(apiKey);
    return usage;
  }

  function isKimi(ctx: any) {
    const p = ctx.model?.provider?.toLowerCase() ?? "";
    return p.includes("kimi") || p.includes("moonshot");
  }
  function requestRenderSafe(tui: any): void {
    try { tui?.requestRender?.(); } catch { /* footer may already be disposed */ }
  }

  function trigger() {
    setTimeout(() => requestRenderSafe(_tui), 0);
  }

  // ── Refresh ─────────────────────────────────────────────────
  async function refresh(ctx: any) {
    if (!apiKey) return;
    if (!isKimi(ctx)) {
      if (usage) { usage = null; toggleFooter(ctx); }
      return;
    }
    try { await getUsage(); trigger(); } catch { /* silent */ }
  }

  // ── Footer ──────────────────────────────────────────────────
  function toggleFooter(ctx: any, force = false) {
    if (isKimi(ctx) && apiKey) {
      if (!footerOn || force) {
        ctx.ui.setFooter(buildFooter(ctx));
        footerOn = true;
      }
    } else {
      if (footerOn) {
        _tui = null;
        ctx.ui.setFooter(undefined as any);
        footerOn = false;
      }
    }
  }

  function buildFooter(ctx: any) {
    const generation = ++footerGeneration;
    return (tui: any, theme: any, fd: any) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => {
        if (generation === footerGeneration) requestRenderSafe(tui);
      });
      return {
        dispose: () => {
          try { unsub(); } catch { /* already disposed */ }
          if (generation === footerGeneration) {
            _tui = null;
            footerOn = false;
          }
        },
        invalidate() {},
        render(width: number): string[] {
          const sm = ctx.sessionManager;

          // ── Line 1: pwd ──────────────────────────────────
          const home = process.env.HOME || process.env.USERPROFILE || "";
          let pwd = ctx.cwd || sm.getCwd?.() || "";
          if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
          const branch = fd.getGitBranch();
          if (branch) pwd += ` (${branch})`;
          const sname = sm.getSessionName?.();
          if (sname) pwd += ` • ${sname}`;
          const ln1 = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

          // ── Line 2: stats ────────────────────────────────
          let ti = 0, to = 0, tr = 0, tw = 0, tc = 0;
          for (const e of sm.getEntries()) {
            if (e.type === "message" && e.message?.role === "assistant") {
              const u = (e.message as AssistantMessage).usage;
              ti += u.input; to += u.output;
              tr += u.cacheRead; tw += u.cacheWrite;
              tc += u.cost.total;
            }
          }
          const parts: string[] = [];
          const cachePartIndexes: number[] = [];
          const tokenPartIndexes: number[] = [];
          let costPartIndex = -1;
          if (ti) { tokenPartIndexes.push(parts.length); parts.push(`↑${formatTokens(ti)}`); }
          if (to) { tokenPartIndexes.push(parts.length); parts.push(`↓${formatTokens(to)}`); }
          if (tr) { cachePartIndexes.push(parts.length); parts.push(`R${formatTokens(tr)}`); }
          if (tw) { cachePartIndexes.push(parts.length); parts.push(`W${formatTokens(tw)}`); }
          if (tc) { costPartIndex = parts.length; parts.push(`$${tc.toFixed(3)}`); }

          // Context %
          const cu = ctx.getContextUsage();
          const cw = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const raw = cu?.percent;
          const cp = raw !== null && raw !== undefined ? raw.toFixed(1) : "?";
          let cpStr: string;
          if (cp === "?") cpStr = `?/${formatTokens(cw)} (auto)`;
          else if (parseFloat(cp) > 90) cpStr = theme.fg("error", `${cp}%/${formatTokens(cw)} (auto)`);
          else if (parseFloat(cp) > 70) cpStr = theme.fg("warning", `${cp}%/${formatTokens(cw)} (auto)`);
          else cpStr = `${cp}%/${formatTokens(cw)} (auto)`;
          parts.push(cpStr);

          // Kimi usage
          if (usage) {
            if (usage.fiveHourLimit > 0) {
              const p5 = (usage.fiveHourUsed / usage.fiveHourLimit) * 100;
              const sev = usageSeverity(p5, FIVE_HOUR_MS, usage.fiveHourResetMs);
              const flag = sev === 2 ? "!!" : sev === 1 ? "!" : "";
              parts.push(`${flag}5h:${p5.toFixed(0)}%`);
            }
            if (usage.weekLimit > 0) {
              const pw = (usage.weekUsed / usage.weekLimit) * 100;
              const sev = usageSeverity(pw, WEEK_MS, usage.weekResetMs);
              const flag = sev === 2 ? "!!" : sev === 1 ? "!" : "";
              parts.push(`${flag}wk:${pw.toFixed(0)}%`);
            }
          }
          let left = parts.join(" ");

          // Right side: model info
          const m = ctx.model;
          let right = m?.id || "no-model";
          if (m?.reasoning) {
            const tl = thinkingLevel;
            right = tl === "off" ? `${right} • thinking off` : `${right} • ${tl}`;
          }
          if (m) {
            const withProv = `(${m.provider}) ${right}`;
            if (visibleWidth(left) + 2 + visibleWidth(withProv) <= width) {
              right = withProv;
            }
          }

          // 宽度不足时的省略顺序 (与 pi-codex-usage 一致): 供应商名 → 缓存计数 → 费用 → 累计 token
          const fits = () => visibleWidth(left) + 2 + visibleWidth(right) <= width;
          if (!fits()) {
            for (const index of cachePartIndexes) parts[index] = "";
            left = parts.filter(Boolean).join(" ");
          }
          if (!fits() && costPartIndex >= 0) {
            parts[costPartIndex] = "";
            left = parts.filter(Boolean).join(" ");
          }
          if (!fits() && tokenPartIndexes.length > 0) {
            for (const index of tokenPartIndexes) parts[index] = "";
            left = parts.filter(Boolean).join(" ");
          }

          const lw = visibleWidth(left);
          const rw = visibleWidth(right);

          let ln2: string;
          if (lw + 2 + rw <= width) {
            ln2 = left + " ".repeat(width - lw - rw) + right;
          } else if (lw + 2 < width) {
            ln2 = truncateToWidth(left + "  " + right, width, "");
          } else {
            ln2 = truncateToWidth(left, width, "...");
          }

          return [ln1, theme.fg("dim", ln2)];
        },
      };
    };
  }

  // ── Idle timer (每 30 分钟闲时刷新) ───────────────────────
  function startIdleTimer() {
    stopIdleTimer();
    idleTimer = setInterval(() => {
      if (agentBusy) return;                    // 生成中,跳过本轮
      const ctx = latestCtx;
      if (!ctx || !isKimi(ctx) || !apiKey) return;  // 只在对应 provider 下刷新
      refresh(ctx);
    }, IDLE_REFRESH_MS);
    (idleTimer as any).unref?.();               // 不阻止进程退出
  }

  function stopIdleTimer() {
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  }

  // ── Events ─────────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    latestCtx = ctx;
    apiKey = readApiKey();
    thinkingLevel = pi.getThinkingLevel?.() || "off";
    footerOn = false;                            // 强制重建 footer,确保闭包捕获新 ctx
    toggleFooter(ctx, true);
    if (apiKey) refresh(ctx);
    startIdleTimer();
  });

  pi.on("session_shutdown", async () => {
    stopIdleTimer();
    latestCtx = null;
  });

  pi.on("agent_start", async (_e, ctx) => { latestCtx = ctx; agentBusy = true; });
  pi.on("agent_end", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = false;
    if (apiKey) refresh(ctx);
  });

  // 每条 assistant 消息结束 (含工具调用轮次) 都尝试刷新一次, 让单轮很长的任务
  // 中途也能及时看到用量变化; 同一个 CACHE_MS 窗口内最多发起一次 (含失败重试), 避免过快
  let lastMidRefreshAt = 0;
  pi.on("message_end", async (event: any, ctx: any) => {
    latestCtx = ctx;
    if (event?.message?.role !== "assistant") return;
    if (!isKimi(ctx) || !apiKey) return;
    const now = Date.now();
    if (now - lastMidRefreshAt < CACHE_MS) return;
    lastMidRefreshAt = now;
    refresh(ctx);
  });

  pi.on("model_select", async (_e, ctx) => {
    latestCtx = ctx;
    if (isKimi(ctx)) {
      // 延迟到 macrotask: 让排在我们后面的扩展先完成卸载,我们再挂载,避免被覆盖
      setTimeout(() => {
        const currentCtx = latestCtx;
        if (!currentCtx || !isKimi(currentCtx)) return;
        try {
          toggleFooter(currentCtx, true);
          if (apiKey) refresh(currentCtx);
        } catch { /* session or footer was disposed */ }
      }, 0);
    } else {
      // 切走时立即卸载自己,给目标 provider 的扩展让位
      toggleFooter(ctx);
      if (apiKey) refresh(ctx);
    }
  });
  pi.on("thinking_level_select", async (event: any) => { thinkingLevel = event?.level || "off"; trigger(); });

  // ── /kimi ────────────────────────────────────────────────
  pi.registerCommand("kimi", {
    description: "Show Kimi membership / Kimi Code usage",
    handler: async (_args, ctx) => {
      try {
        const d = await getUsage();
        const bar = (used: number, total: number) => {
          const pct = total > 0 ? (used / total) * 100 : 0;
          return "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
        };

        const lines = [`══ Kimi 会员 (${d.level}${d.subType ? ` · ${d.subType}` : ""}) ══`];

        if (d.fiveHourLimit > 0) {
          lines.push(
            `5h  ${bar(d.fiveHourUsed, d.fiveHourLimit)}  ${d.fiveHourUsed}/${d.fiveHourLimit} used  resets ${humanDuration(d.fiveHourResetMs - Date.now())}`,
          );
        }
        if (d.weekLimit > 0) {
          lines.push(
            `wk  ${bar(d.weekUsed, d.weekLimit)}  ${d.weekUsed}/${d.weekLimit} used  resets ${humanDuration(d.weekResetMs - Date.now())}`,
          );
        }
        if (d.monthLimit > 0) {
          lines.push(
            `mo  ${bar(d.monthUsed, d.monthLimit)}  ${d.monthUsed}/${d.monthLimit} used`,
          );
        }
        if (d.parallelLimit > 0) lines.push(`parallel: ${d.parallelLimit}`);
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err: any) {
        ctx.ui.notify(`Kimi: ${err.message}`, "error");
      }
    },
  });

}

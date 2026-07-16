import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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
  let _tui: any = null;
  let thinkingLevel = "off";

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
  function trigger() { if (_tui) setTimeout(() => _tui.requestRender?.(), 0); }

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
  function toggleFooter(ctx: any) {
    if (isKimi(ctx) && apiKey) {
      if (!footerOn) {
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
    return (tui: any, theme: any, fd: any) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => tui.requestRender());
      return {
        dispose: () => { unsub(); _tui = null; },
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
          if (ti) parts.push(`↑${formatTokens(ti)}`);
          if (to) parts.push(`↓${formatTokens(to)}`);
          if (tr) parts.push(`R${formatTokens(tr)}`);
          if (tw) parts.push(`W${formatTokens(tw)}`);
          if (tc) parts.push(`$${tc.toFixed(3)}`);

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
          const left = parts.join(" ");

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

  // ── Events ─────────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    apiKey = readApiKey();
    thinkingLevel = pi.getThinkingLevel?.() || "off";
    toggleFooter(ctx);
    if (apiKey) refresh(ctx);
  });

  pi.on("model_select", async (_e, ctx) => { toggleFooter(ctx); if (apiKey) refresh(ctx); });
  pi.on("thinking_level_select", async (event: any) => { thinkingLevel = event.level || "off"; trigger(); });
  pi.on("agent_end", async (_e, ctx) => { if (apiKey) refresh(ctx); });

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

  // ── kimi_usage tool ─────────────────────────────────────
  pi.registerTool({
    name: "kimi_usage",
    label: "Kimi Usage",
    description: "Check Kimi (Moonshot AI) membership / Kimi Code subscription usage: 5-hour window, weekly quota with reset times, and monthly total usage.",
    promptSnippet: "Check Kimi membership usage (5h window, weekly & monthly quota)",
    promptGuidelines: [
      "Use kimi_usage to check Kimi membership quota before expensive operations.",
      "Use kimi_usage when the user asks about Kimi usage, limits, membership quota, or remaining credits.",
    ],
    parameters: Type.Object({}),
    async execute() {
      try {
        const d = await getUsage();
        const result: any = {
          membership: d.level,
          subType: d.subType,
          fiveHour: {
            used: d.fiveHourUsed,
            limit: d.fiveHourLimit,
            remaining: Math.max(0, d.fiveHourLimit - d.fiveHourUsed),
            resetsIn: humanDuration(d.fiveHourResetMs - Date.now()),
          },
          weekly: {
            used: d.weekUsed,
            limit: d.weekLimit,
            remaining: Math.max(0, d.weekLimit - d.weekUsed),
            resetsIn: humanDuration(d.weekResetMs - Date.now()),
          },
          monthly: {
            used: d.monthUsed,
            limit: d.monthLimit,
            remaining: Math.max(0, d.monthLimit - d.monthUsed),
          },
          parallelLimit: d.parallelLimit,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    },
  });
}

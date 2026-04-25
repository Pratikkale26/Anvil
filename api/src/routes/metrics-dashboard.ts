import type { RequestHandler } from "express";
import { metrics } from "../metrics.js";

/**
 * GET /metrics/dashboard — Public HTML view of the in-memory metrics.
 *
 * Pure SSR: snapshot is rendered into the initial HTML so visitors see live
 * numbers immediately. A small inline script polls /metrics every 30 s and
 * mutates the DOM in place. No build step, no external libraries — colors and
 * layout come straight from /home/pk/Anvil/web/app/globals.css so the page
 * matches the workbench dark theme.
 */
export const metricsDashboardHandler: RequestHandler = (_req, res) => {
  const snap = metrics.snapshot();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderDashboard(snap));
};

function fmt(n: number): string {
  return n > 0 ? n.toLocaleString("en-US") : "—";
}
function pct(n: number, divisor: number): string {
  if (!divisor || divisor <= 0) return "—";
  return `${Math.round(n * 100)}%`;
}
function ratio(a: number, b: number): string {
  if (a + b <= 0) return "—";
  return `${a} / ${b}`;
}
function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;");
}

function renderDashboard(s: ReturnType<typeof metrics.snapshot>): string {
  const targets = ["pinocchio", "native", "quasar"] as const;
  const errs = targets.map((t) => s.emit.validationErrorsByTarget[t] ?? 0);
  const maxErr = Math.max(1, ...errs);
  const buildRate = s.build.total > 0 ? s.build.success / s.build.total : 0;
  const upH = Math.floor(s.uptimeSec / 3600);
  const upM = Math.floor((s.uptimeSec % 3600) / 60);
  const uptime = upH > 0 ? `${upH}h ${upM}m` : `${upM}m`;
  const initial = JSON.stringify(s);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Anvil — Metrics</title>
<style>
:root{--bg:#0d0f1a;--card:#131520;--bd:rgba(255,255,255,.09);--tx:#e8ecf4;--sub:#9095b0;--mu:#5c6080;--am:#f5a623;--teal:#0ea880}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font-family:Inter,system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:48px 24px}
header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:32px;flex-wrap:wrap;gap:12px}
h1{font-size:28px;font-weight:800;margin:0;letter-spacing:-.02em}
h1 span{color:var(--am)}
.meta{font-size:12px;color:var(--mu);text-transform:uppercase;letter-spacing:.14em}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:20px}
.card h2{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--mu);margin:0 0 12px}
.big{font-size:42px;font-weight:800;letter-spacing:-.025em;line-height:1;color:var(--tx)}
.sub{font-size:12px;color:var(--sub);margin-top:8px}
.kvs{display:flex;flex-direction:column;gap:10px;margin-top:4px}
.kv{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.kv .k{font-size:13px;color:var(--sub)}
.kv .v{font-variant-numeric:tabular-nums;font-weight:600}
.kv .v.am{color:var(--am)}
.bar{display:flex;align-items:flex-end;gap:14px;height:140px;padding-top:8px}
.bar .col{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%}
.bar .fill{width:100%;background:linear-gradient(to top,rgba(245,166,35,.7),rgba(245,166,35,.25));border-top:1px solid var(--am);border-radius:3px 3px 0 0;transition:height .3s ease;min-height:2px}
.bar .lbl{font-size:11px;color:var(--mu);text-transform:uppercase;letter-spacing:.06em}
.bar .num{font-size:13px;font-variant-numeric:tabular-nums;color:var(--tx);font-weight:600}
.gauge{position:relative;height:8px;background:rgba(255,255,255,.05);border-radius:4px;margin-top:10px;overflow:hidden}
.gauge .gf{height:100%;background:linear-gradient(to right,var(--teal),var(--am));border-radius:4px;transition:width .3s ease}
footer{margin-top:32px;font-size:11px;color:var(--mu);text-align:center;letter-spacing:.06em}
footer a{color:var(--sub);text-decoration:none;border-bottom:1px solid var(--bd)}
footer a:hover{color:var(--am)}
</style></head><body>
<div class="wrap">
<header><h1>Anvil <span>—</span> Metrics</h1><div class="meta">uptime <span id="uptime">${uptime}</span> &middot; refreshes every 30s</div></header>

<div class="row">
<div class="card"><h2>Parses</h2><div class="big" id="parses">${fmt(s.parse.total)}</div><div class="sub" id="parses-sub">${s.parse.failures > 0 ? `${s.parse.failures} failed` : "all clean"}</div></div>
<div class="card"><h2>Emits</h2><div class="big" id="emits">${fmt(s.emit.total)}</div><div class="sub">target × IR</div></div>
<div class="card"><h2>Builds</h2><div class="big" id="builds">${fmt(s.build.total)}</div><div class="sub" id="builds-sub">p50 ${s.build.p50DurationMs > 0 ? s.build.p50DurationMs + "ms" : "—"}</div></div>
</div>

<div class="row">
<div class="card"><h2>AI Refine</h2>
<div class="kvs">
<div class="kv"><span class="k">cache hit rate</span><span class="v am" id="hitrate">${pct(s.refine.cacheHitRate, s.refine.calls)}</span></div>
<div class="kv"><span class="k">total calls</span><span class="v" id="rcalls">${fmt(s.refine.calls)}</span></div>
<div class="kv"><span class="k">accept / reject</span><span class="v" id="ratio">${ratio(s.refine.patchesAccepted, s.refine.patchesRejected)}</span></div>
<div class="kv"><span class="k">accept rate</span><span class="v" id="acceptrate">${pct(s.refine.acceptRate, s.refine.patchesAccepted + s.refine.patchesRejected)}</span></div>
</div>
</div>

<div class="card"><h2>Validation errors per target</h2>
<div class="bar" id="bars">
${targets.map((t, i) => `<div class="col"><div class="num" data-num="${t}">${fmt(errs[i] ?? 0)}</div><div class="fill" data-fill="${t}" style="height:${(((errs[i] ?? 0) / maxErr) * 100).toFixed(0)}%"></div><div class="lbl">${t}</div></div>`).join("")}
</div></div>

<div class="card"><h2>Build success rate</h2>
<div class="big" id="brate">${pct(buildRate, s.build.total)}</div>
<div class="gauge"><div class="gf" id="gf" style="width:${(buildRate * 100).toFixed(0)}%"></div></div>
<div class="sub"><span id="bok">${fmt(s.build.success)}</span> ok &middot; <span id="bfail">${fmt(s.build.failure)}</span> failed</div>
</div>
</div>

<footer><a href="/metrics">/metrics JSON</a> &middot; <a href="/health">/health</a> &middot; in-memory counters reset on restart</footer>
</div>
<script>
const I=${initial};
const fmtN=n=>n>0?n.toLocaleString('en-US'):'—';
const pctN=(n,d)=>(!d||d<=0)?'—':Math.round(n*100)+'%';
const rat=(a,b)=>(a+b<=0)?'—':a+' / '+b;
async function tick(){
  try{
    const r=await fetch('/metrics',{cache:'no-store'});if(!r.ok)return;
    const s=await r.json();
    const set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v};
    const upH=Math.floor(s.uptimeSec/3600),upM=Math.floor((s.uptimeSec%3600)/60);
    set('uptime',upH>0?upH+'h '+upM+'m':upM+'m');
    set('parses',fmtN(s.parse.total));set('parses-sub',s.parse.failures>0?s.parse.failures+' failed':'all clean');
    set('emits',fmtN(s.emit.total));
    set('builds',fmtN(s.build.total));set('builds-sub','p50 '+(s.build.p50DurationMs>0?s.build.p50DurationMs+'ms':'—'));
    set('hitrate',pctN(s.refine.cacheHitRate,s.refine.calls));
    set('rcalls',fmtN(s.refine.calls));
    set('ratio',rat(s.refine.patchesAccepted,s.refine.patchesRejected));
    set('acceptrate',pctN(s.refine.acceptRate,s.refine.patchesAccepted+s.refine.patchesRejected));
    const ts=['pinocchio','native','quasar'];
    const es=ts.map(t=>s.emit.validationErrorsByTarget[t]||0);
    const mx=Math.max(1,...es);
    ts.forEach((t,i)=>{const n=document.querySelector('[data-num="'+t+'"]');const f=document.querySelector('[data-fill="'+t+'"]');if(n)n.textContent=fmtN(es[i]);if(f)f.style.height=((es[i]/mx)*100).toFixed(0)+'%'});
    const br=s.build.total>0?s.build.success/s.build.total:0;
    set('brate',pctN(br,s.build.total));set('bok',fmtN(s.build.success));set('bfail',fmtN(s.build.failure));
    const gf=document.getElementById('gf');if(gf)gf.style.width=(br*100).toFixed(0)+'%';
  }catch{}
}
setInterval(tick,30000);
void I;
</script>
</body></html>`;
}

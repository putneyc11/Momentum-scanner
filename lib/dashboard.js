/* Live equity dashboard — zero-dep HTTP server the trade loop starts.

   GET /            the chart page (dark terminal style, matches the scanner)
   GET /api/state   { equity:[{t,eq}], trades:[...], status:{...} }
   GET /health      ok

   Reads state/equity.jsonl (samples the trade loop appends) and
   state/journal.jsonl (trade events) directly, so it stays correct even if
   the loop restarts. If env DASH_TOKEN is set, every route except /health
   requires ?token=... once (then a cookie keeps the session).

   Chart notes (deliberate, per the dataviz pass):
   - single series -> no legend; the title names it; one axis only
   - win/loss markers are NEVER color-alone: wins are filled dots, losses
     are X crosses, and tooltips/table always show the signed P/L
   - crosshair + tooltip on hover; trades table = the accessible view */

const http = require("http");
const fs = require("fs");
const path = require("path");

function tailJsonl(file, maxLines) {
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    return lines.slice(-maxLines).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function startDashboard({ port, stateDir, status }) {
  const equityFile = path.join(stateDir, "equity.jsonl");
  const journalFile = path.join(stateDir, "journal.jsonl");
  const token = process.env.DASH_TOKEN || "";

  const authed = (req) => {
    if (!token) return true;
    const u = new URL(req.url, "http://x");
    if (u.searchParams.get("token") === token) return true;
    return (req.headers.cookie || "").includes("dash=" + token);
  };

  const server = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (u === "/health") { res.writeHead(200); res.end("ok"); return; }
    if (!authed(req)) { res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" }); res.end(GATE); return; }
    const cookie = token ? { "Set-Cookie": `dash=${token}; HttpOnly; Path=/; Max-Age=2592000` } : {};
    if (u === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json", ...cookie });
      res.end(JSON.stringify({
        equity: tailJsonl(equityFile, 5000),
        trades: tailJsonl(journalFile, 200).filter((j) => j.kind === "entry" || j.kind === "exit" || j.kind === "scale"),
        status: status || {},
        now: Date.now(),
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...cookie });
    res.end(PAGE);
  });
  server.listen(port);
  return server;
}

/* Friendly access gate shown instead of a bare 401. Entering the token
   redirects to /?token=..., which sets the cookie so it's a one-time step. */
const GATE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Algo Trader — unlock</title>
<style>
html,body{margin:0;background:#0A0E13;color:#E7EEF5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-height:100vh;display:grid;place-items:center}
.card{background:#10161E;border:1px solid #1E2A38;border-radius:12px;padding:22px;max-width:380px;margin:20px}
h1{font-size:14px;letter-spacing:1.5px;color:#E8B54D;text-transform:uppercase;margin:0 0 10px}
p{font-size:12px;color:#7E8C9A;line-height:1.6;margin:0 0 14px}
b{color:#E7EEF5}
input{width:100%;box-sizing:border-box;background:#0A0E13;border:1px solid #1E2A38;border-radius:7px;color:#E7EEF5;padding:11px;font:inherit;font-size:13px}
button{width:100%;margin-top:10px;background:#E8B54D;color:#06090D;border:none;border-radius:7px;padding:12px;font:inherit;font-weight:700;font-size:13px;cursor:pointer}
</style></head><body>
<div class="card">
<h1>🔒 Algo Trader dashboard</h1>
<p>This page shows your live paper-account equity, so it's locked behind an
access token. Find it in <b>Render → your momentum-algo-trader service →
Environment → DASH_TOKEN</b>, paste it once below — this browser is
remembered after that.</p>
<input id="tk" type="password" placeholder="paste DASH_TOKEN value" autofocus>
<button onclick="go()">Unlock</button>
</div>
<script>
function go(){var v=document.getElementById("tk").value.trim();if(v)location.href="/?token="+encodeURIComponent(v);}
document.getElementById("tk").addEventListener("keydown",function(e){if(e.key==="Enter")go();});
</script>
</body></html>`;

const PAGE = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Algo Trader — Account value</title>
<style>
:root{--bg:#0A0E13;--panel:#10161E;--border:#1E2A38;--text:#E7EEF5;--muted:#7E8C9A;--dim:#55636F;--up:#2EBD85;--down:#F6465D;--amber:#E8B54D}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.wrap{max-width:980px;margin:0 auto;padding:14px}
h1{font-size:15px;letter-spacing:1px;margin:2px 0 12px;color:var(--amber);text-transform:uppercase}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.tile .k{font-size:9px;letter-spacing:1.2px;color:var(--dim);text-transform:uppercase}
.tile .v{font-size:20px;font-weight:700;margin-top:3px}
.tile .s{font-size:11px;color:var(--muted);margin-top:2px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:12px}
.bar{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border)}
.bar .t{font-size:10px;letter-spacing:1.2px;color:var(--dim);text-transform:uppercase;flex:1}
button{background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:4px 10px;font:inherit;font-size:11px;cursor:pointer}
button.on{background:rgba(232,181,77,.13);border-color:var(--amber);color:var(--amber)}
#chartbox{position:relative;height:320px}
canvas{display:block;width:100%;height:100%;cursor:crosshair}
#tip{position:absolute;display:none;background:rgba(10,14,19,.95);border:1px solid var(--border);border-radius:6px;padding:6px 9px;font-size:11px;pointer-events:none;white-space:pre;z-index:5}
table{width:100%;border-collapse:collapse;font-size:11px}
th{font-size:9px;letter-spacing:1px;color:var(--dim);text-transform:uppercase;text-align:left;padding:7px 12px;border-bottom:1px solid var(--border)}
td{padding:6px 12px;border-bottom:1px solid rgba(30,42,56,.5);color:var(--muted)}
td.sym{color:var(--text);font-weight:700}
.pos{color:var(--up)}.neg{color:var(--down)}
.empty{padding:24px 12px;color:var(--dim);font-size:12px}
.note{color:var(--dim);font-size:10px;padding:0 2px 14px;line-height:1.5}
</style></head><body>
<div class="wrap">
<h1>Algo Trader · Account value (paper)</h1>
<div id="errbox" style="display:none;background:rgba(246,70,93,.09);border:1px solid var(--down);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;line-height:1.6;color:var(--down)"></div>
<div class="tiles">
  <div class="tile"><div class="k">Account value</div><div class="v" id="eqNow">—</div><div class="s" id="eqTime"></div></div>
  <div class="tile"><div class="k">Day P/L</div><div class="v" id="dayPL">—</div><div class="s" id="dayPLpct"></div></div>
  <div class="tile"><div class="k">Open positions</div><div class="v" id="posN">—</div><div class="s" id="posSyms"></div></div>
  <div class="tile"><div class="k">Session</div><div class="v" id="sess" style="font-size:14px">—</div><div class="s" id="uni"></div></div>
</div>
<div class="card">
  <div class="bar"><span class="t">Equity curve · ▲ entry · ◆ scale-out · ● win exit · ✕ loss exit</span>
    <button id="w1d" class="on">Today</button><button id="wall">All</button></div>
  <div id="chartbox"><canvas id="cv"></canvas><div id="tip"></div></div>
</div>
<div class="card">
  <div class="bar"><span class="t">Active trades · scale-out at the planned exit, runner rides with a break-even stop</span></div>
  <div style="overflow-x:auto"><table id="ptbl"><thead><tr>
    <th>Sym</th><th>Qty</th><th>Entry</th><th>Now</th><th>Planned exit</th><th>Stop loss</th><th>Chg %</th><th>Value</th><th>P/L $ / %</th></tr></thead><tbody></tbody></table></div>
  <div class="empty" id="noPos" style="display:none"></div>
</div>
<div class="card">
  <div class="bar"><span class="t">Recent trades</span></div>
  <div style="overflow-x:auto"><table id="tbl"><thead><tr>
    <th>Time (ET)</th><th>Event</th><th>Sym</th><th>Detail</th><th>P/L</th></tr></thead><tbody></tbody></table></div>
  <div class="empty" id="noTrades" style="display:none">No trades journaled yet — the loop is watching the tape.</div>
</div>
<div class="note">Samples every ~30s while the engine runs (4:00–20:00 ET — premarket and after hours included). Paper account only. Not investment advice.</div>
</div>
<script>
const $=id=>document.getElementById(id);
const fmt$=v=>v==null?"—":"$"+Number(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const fET=t=>new Date(t).toLocaleTimeString("en-US",{hour12:false,hour:"2-digit",minute:"2-digit",timeZone:"America/New_York"});
const fETd=t=>new Date(t).toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"America/New_York"});
const etDay=t=>new Date(t).toLocaleDateString("en-US",{timeZone:"America/New_York"});
let D={equity:[],trades:[],status:{}},win="1d",hoverX=null;
async function pull(){
  try{const r=await fetch("/api/state");D=await r.json();render();}catch(e){}
}
function viewData(){
  if(win==="all"||D.equity.length===0)return D.equity;
  const today=etDay(Date.now());
  const t=D.equity.filter(s=>etDay(s.t)===today);
  return t.length>1?t:D.equity.slice(-500);
}
function render(){
  const eq=D.equity;
  const last=eq[eq.length-1];
  $("eqNow").textContent=fmt$(last&&last.eq);
  $("eqTime").textContent=last?("as of "+fET(last.t)+" ET"):"waiting for first sample…";
  const today=etDay(Date.now());
  const todays=eq.filter(s=>etDay(s.t)===today);
  if(todays.length>1){
    const d=todays[todays.length-1].eq-todays[0].eq;
    const p=(d/todays[0].eq)*100;
    $("dayPL").textContent=(d>=0?"+$":"−$")+Math.abs(d).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
    $("dayPL").className="v "+(d>=0?"pos":"neg");
    $("dayPLpct").textContent=(p>=0?"+":"")+p.toFixed(2)+"% today";
  }else{$("dayPL").textContent="—";$("dayPLpct").textContent="no samples today";}
  const st=D.status||{};
  const poss=(st.positions||[]).map(p=>typeof p==="string"?{sym:p}:p);
  $("posN").textContent=st.positions!=null?poss.length:"—";
  $("posSyms").textContent=poss.length?poss.map(p=>p.sym).join(" "):"flat";
  const ptb=document.querySelector("#ptbl tbody");ptb.innerHTML="";
  $("noPos").style.display=poss.length?"none":"block";
  $("noPos").textContent=(st.session==="closed")
    ? "Market closed — the engine wakes with the 4:00 AM premarket tape."
    : "No open trades right now — watching "+(st.universe||0)+" scanner movers for a breakout (entries 4:00–19:30 ET).";
  for(const p of poss){
    if(p.entry==null)continue;
    const chg=p.entry?((p.price-p.entry)/p.entry)*100:0;
    const tr=document.createElement("tr");
    tr.innerHTML="<td class=sym>"+p.sym+"</td><td>"+(p.qty!=null?p.qty:"")+"</td>"+
      "<td>$"+Number(p.entry).toFixed(2)+"</td><td>$"+Number(p.price).toFixed(2)+"</td>"+
      "<td>"+(p.scaled?"runner · trailing":(p.target!=null?"$"+Number(p.target).toFixed(2)+" · sell "+(p.scaleOutPct||85)+"%":"—"))+"</td>"+
      "<td>"+(p.stop!=null?"$"+Number(p.stop).toFixed(2)+(p.scaled?" (≥ break-even)":""):"—")+"</td>"+
      "<td class='"+(chg>=0?"pos":"neg")+"'>"+(chg>=0?"+":"")+chg.toFixed(2)+"%</td>"+
      "<td>"+(p.value!=null?"$"+Number(p.value).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}):"—")+"</td>"+
      "<td class='"+((p.plUsd||0)>=0?"pos":"neg")+"'>"+((p.plUsd||0)>=0?"+$":"−$")+Math.abs(p.plUsd||0).toFixed(2)+" / "+((p.plPct||0)>=0?"+":"")+(p.plPct||0).toFixed(2)+"%</td>";
    ptb.appendChild(tr);
  }
  $("sess").textContent=st.session||"—";
  const beat=st.beat?Math.max(0,Math.round(((D.now||Date.now())-st.beat)/1000)):null;
  $("uni").textContent=(st.universe!=null?st.universe+" in universe":"")+
    (beat!=null?" · engine "+(beat<120?"alive ("+beat+"s)":"⚠ stalled "+Math.round(beat/60)+"m"):"");
  const eb=$("errbox");
  if(st.error){eb.style.display="block";eb.textContent="⚠ "+st.error;}
  else eb.style.display="none";
  drawChart();
  const tb=document.querySelector("#tbl tbody");tb.innerHTML="";
  const rows=(D.trades||[]).slice(-20).reverse();
  $("noTrades").style.display=rows.length?"none":"block";
  for(const j of rows){
    const tr=document.createElement("tr");
    const pnl=j.pnl!=null?Number(j.pnl):null;
    tr.innerHTML="<td>"+fETd(j.t)+" "+fET(j.t)+"</td><td>"+(j.kind==="entry"?"▲ entry":j.kind==="scale"?"◆ scale-out":"exit · "+(j.reason||""))+
      "</td><td class=sym>"+(j.sym||"")+"</td><td>"+(j.kind==="entry"?("x"+j.qty+" @ $"+Number(j.px).toFixed(2)+" stop $"+Number(j.stop).toFixed(2)):"")+
      "</td><td class='"+(pnl==null?"":pnl>=0?"pos":"neg")+"'>"+(pnl==null?"—":(pnl>=0?"+$":"−$")+Math.abs(pnl).toFixed(2))+"</td>";
    tb.appendChild(tr);
  }
}
function drawChart(){
  const cv=$("cv"),box=$("chartbox");
  const dpr=window.devicePixelRatio||1,W=box.clientWidth,H=box.clientHeight;
  cv.width=W*dpr;cv.height=H*dpr;
  const ctx=cv.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
  const data=viewData();
  if(data.length<2){ctx.fillStyle="#55636F";ctx.font="12px ui-monospace,monospace";ctx.fillText("waiting for equity samples…",16,40);return;}
  const padL=8,padR=70,padT=14,padB=26,pw=W-padL-padR,ph=H-padT-padB;
  let lo=Infinity,hi=-Infinity;
  for(const s of data){if(s.eq<lo)lo=s.eq;if(s.eq>hi)hi=s.eq;}
  const span=Math.max(hi-lo,hi*0.001)||1;lo-=span*0.12;hi+=span*0.12;
  const t0=data[0].t,t1=data[data.length-1].t||t0+1;
  const X=t=>padL+((t-t0)/Math.max(1,t1-t0))*pw;
  const Y=v=>padT+((hi-v)/(hi-lo))*ph;
  ctx.font="10px ui-monospace,monospace";
  for(let i=0;i<=4;i++){
    const v=hi-((hi-lo)*i)/4,y=Y(v);
    ctx.strokeStyle="rgba(255,255,255,0.05)";ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();
    ctx.fillStyle="#7E8C9A";ctx.fillText("$"+Math.round(v).toLocaleString(),W-padR+6,y+3);
  }
  const nT=Math.max(2,Math.floor(W/160));
  ctx.textAlign="center";
  for(let i=0;i<=nT;i++){
    const t=t0+((t1-t0)*i)/nT,x=X(t);
    ctx.fillStyle="#55636F";
    ctx.fillText(win==="all"?fETd(t)+" "+fET(t):fET(t),Math.min(Math.max(x,34),W-padR-30),H-8);
  }
  ctx.textAlign="left";
  /* day-start reference */
  const today=etDay(Date.now());
  const first=data.find(s=>etDay(s.t)===today)||data[0];
  ctx.strokeStyle="rgba(126,140,154,0.5)";ctx.setLineDash([4,4]);
  ctx.beginPath();ctx.moveTo(padL,Y(first.eq));ctx.lineTo(W-padR,Y(first.eq));ctx.stroke();ctx.setLineDash([]);
  /* area + line (single series, amber) */
  ctx.beginPath();
  data.forEach((s,i)=>{const x=X(s.t),y=Y(s.eq);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.strokeStyle="#E8B54D";ctx.lineWidth=2;ctx.stroke();
  ctx.lineTo(X(t1),padT+ph);ctx.lineTo(X(t0),padT+ph);ctx.closePath();
  ctx.fillStyle="rgba(232,181,77,0.07)";ctx.fill();ctx.lineWidth=1;
  /* trade markers: entry=hollow triangle, win=filled dot, loss=X (shape+sign, never color alone) */
  const eqAt=t=>{let b=data[0];for(const s of data){if(s.t<=t)b=s;else break;}return b.eq;};
  for(const j of D.trades||[]){
    const tt=Date.parse(j.t);
    if(tt<t0||tt>t1)continue;
    const x=X(tt),y=Y(eqAt(tt));
    if(j.kind==="entry"){
      ctx.strokeStyle="#E7EEF5";ctx.beginPath();ctx.moveTo(x,y-5);ctx.lineTo(x-4.5,y+3);ctx.lineTo(x+4.5,y+3);ctx.closePath();ctx.stroke();
    }else if(j.kind==="scale"){
      ctx.fillStyle="#2EBD85";ctx.beginPath();ctx.moveTo(x,y-5);ctx.lineTo(x+4.5,y);ctx.lineTo(x,y+5);ctx.lineTo(x-4.5,y);ctx.closePath();ctx.fill();
    }else{
      const w=j.pnl!=null&&Number(j.pnl)>=0;
      if(j.pnl==null){ctx.strokeStyle="#7E8C9A";ctx.beginPath();ctx.arc(x,y,3.5,0,7);ctx.stroke();}
      else if(w){ctx.fillStyle="#2EBD85";ctx.beginPath();ctx.arc(x,y,4,0,7);ctx.fill();}
      else{ctx.strokeStyle="#F6465D";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x-4,y-4);ctx.lineTo(x+4,y+4);ctx.moveTo(x+4,y-4);ctx.lineTo(x-4,y+4);ctx.stroke();ctx.lineWidth=1;}
    }
  }
  /* crosshair + tooltip */
  const tip=$("tip");
  if(hoverX!=null&&hoverX>=padL&&hoverX<=W-padR){
    let best=data[0],bd=Infinity;
    for(const s of data){const d=Math.abs(X(s.t)-hoverX);if(d<bd){bd=d;best=s;}}
    const x=X(best.t),y=Y(best.eq);
    ctx.strokeStyle="rgba(255,255,255,0.25)";ctx.setLineDash([3,3]);
    ctx.beginPath();ctx.moveTo(x,padT);ctx.lineTo(x,padT+ph);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle="#E8B54D";ctx.beginPath();ctx.arc(x,y,3.5,0,7);ctx.fill();
    let txt=fET(best.t)+" ET\\n"+fmt$(best.eq);
    let nearest=null,nd=12;
    for(const j of D.trades||[]){const d=Math.abs(X(Date.parse(j.t))-hoverX);if(d<nd){nd=d;nearest=j;}}
    if(nearest){
      txt+="\\n— "+(nearest.kind==="entry"?"▲ entry "+nearest.sym+" x"+nearest.qty+" @$"+Number(nearest.px).toFixed(2)
        :nearest.kind==="scale"?"◆ scale-out "+nearest.sym+(nearest.qty?" x"+nearest.qty:"")+(nearest.pnl!=null?" +$"+Math.abs(nearest.pnl).toFixed(2):"")
        :(nearest.pnl!=null&&nearest.pnl>=0?"● ":"✕ ")+nearest.sym+" exit ("+(nearest.reason||"")+")"+(nearest.pnl!=null?" "+(nearest.pnl>=0?"+$":"−$")+Math.abs(nearest.pnl).toFixed(2):""));
    }
    tip.textContent=txt;tip.style.display="block";
    tip.style.left=Math.min(x+12,W-170)+"px";tip.style.top=Math.max(8,y-46)+"px";
  }else tip.style.display="none";
}
$("cv").addEventListener("mousemove",e=>{hoverX=e.offsetX;drawChart();});
$("cv").addEventListener("mouseleave",()=>{hoverX=null;drawChart();});
$("cv").addEventListener("touchstart",e=>{hoverX=e.touches[0].clientX-$("chartbox").getBoundingClientRect().left;drawChart();},{passive:true});
$("cv").addEventListener("touchmove",e=>{hoverX=e.touches[0].clientX-$("chartbox").getBoundingClientRect().left;drawChart();},{passive:true});
$("cv").addEventListener("touchend",()=>{hoverX=null;drawChart();});
$("w1d").onclick=()=>{win="1d";$("w1d").className="on";$("wall").className="";drawChart();};
$("wall").onclick=()=>{win="all";$("wall").className="on";$("w1d").className="";drawChart();};
window.addEventListener("resize",drawChart);
pull();setInterval(pull,5000);
</script>
</body></html>`;

module.exports = { startDashboard, tailJsonl };

(()=>{
  const fmtBRL = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' });
  const params = new URLSearchParams(location.search);
  const pair = params.get('pair') || 'btc-brl';
  const title = document.getElementById('title'); title.textContent = pair.toUpperCase();
  const canvas = document.getElementById('big');
  const tipEl = (()=>{ const el = document.createElement('div'); el.className='chart-tip'; el.hidden=true; document.body.appendChild(el); return el; })();

  const RANGE_MS = { '1h': 3_600_000, '4h': 14_400_000, '24h': 86_400_000 };
  let RG = '4h';
  const buttons = Array.from(document.querySelectorAll('.rg[data-rg]'));
  buttons.forEach(b=> b.addEventListener('click', ()=>{ RG = b.dataset.rg; draw(); }));

  const ENDPOINTS = {
    CG: (id, vs='brl', d=1) => `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=${vs}&days=${d}&interval=hourly`,
  };
  const CG_IDS = {
    'btc-brl':'bitcoin','eth-brl':'ethereum','bnb-brl':'binancecoin','dash-brl':'dash',
    'usdt-brl':'tether','usdc-brl':'usd-coin','sol-brl':'solana','ada-brl':'cardano','xrp-brl':'ripple','doge-brl':'dogecoin'
  };
  const id = CG_IDS[pair] || 'bitcoin';
  let series = []; // [ [ts, price], ... ]

  async function getJSON(url){ const r = await fetch(url, { cache:'no-store' }); if(!r.ok) throw new Error('http ' + r.status); return r.json(); }
  function binSizeForRange(key){ switch(key){ case '1h': return 60_000; case '4h': return 5*60_000; default: return 15*60_000; } }
  function makeCandles(ts, prices, binMs){
    const out = []; if(!ts || !prices || ts.length !== prices.length) return out; let cur=null;
    for(let i=0;i<ts.length;i++){ const t=ts[i], p=prices[i]; const bucket = Math.floor(t/binMs)*binMs; if(!cur || cur.t!==bucket){ if(cur) out.push(cur); cur={ t:bucket,o:p,h:p,l:p,c:p}; } else { if(p>cur.h) cur.h=p; if(p<cur.l) cur.l=p; cur.c=p; } }
    if(cur) out.push(cur); return out; }
  function draw(){ if(!series.length) return; const ts=series.map(x=>x[0]); const ps=series.map(x=>x[1]); const bin=binSizeForRange(RG); const cands=makeCandles(ts,ps,bin); drawCandles(canvas,cands); }

  function drawCandles(el, candles){ const ctx=el.getContext('2d'); const dpr=window.devicePixelRatio||1; if(el._dpr!==dpr){ el._dpr=dpr; el.width=Math.floor(el.clientWidth*dpr); el.height=Math.floor(el.clientHeight*dpr);} const W=el.width,H=el.height; ctx.clearRect(0,0,W,H); if(!candles.length) return; const padX=10*dpr,padY=10*dpr; const n=candles.length; const min=Math.min(...candles.map(c=>c.l)), max=Math.max(...candles.map(c=>c.h)); const sx=i=> padX+(W-2*padX)*(i/(n-1)); const sy=v=> max===min?H/2:(H-padY)-((v-min)/(max-min))*(H-2*padY); ctx.save(); ctx.strokeStyle='rgba(255,255,255,.06)'; ctx.lineWidth=1; for(let i=1;i<=4;i++){ const y=(H/(4+1))*i; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); } ctx.restore(); const bodyW=Math.max(1*dpr,(W-2*padX)/Math.max(1,n-1)*0.6); for(let i=0;i<n;i++){ const c=candles[i]; const x=Math.round(sx(i)); const up=c.c>=c.o; const col=up?'rgba(0,200,83,.9)':'rgba(255,59,48,.9)'; const yH=sy(c.h),yL=sy(c.l),yO=sy(c.o),yC=sy(c.c); ctx.strokeStyle=col; ctx.lineWidth=Math.max(1,1*dpr); ctx.beginPath(); ctx.moveTo(x,yH); ctx.lineTo(x,yL); ctx.stroke(); const bx=Math.round(x-bodyW/2), by=Math.round(Math.min(yO,yC)), bh=Math.max(1,Math.abs(yC-yO)); ctx.fillStyle=col; ctx.fillRect(bx,by,Math.max(1,Math.floor(bodyW)),bh); }
    const last=candles[n-1].c; const yLast=sy(last); ctx.save(); ctx.setLineDash([4*dpr,3*dpr]); ctx.strokeStyle='rgba(255,255,255,.25)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(0,yLast); ctx.lineTo(W,yLast); ctx.stroke(); ctx.restore();
    el._candles={candles,padX,padY,W,H}; if(!el._tip){ el._tip=true; const move=(ev)=>{ const rect=el.getBoundingClientRect(); const clientX=(ev.touches?ev.touches[0].clientX:ev.clientX); const x=clientX-rect.left; const s=el._candles; if(!s) return; const n=s.candles.length; const rx=Math.max(s.padX,Math.min(s.W-s.padX,x)); const t=(rx-s.padX)/Math.max(1,(s.W-2*s.padX)); const idx=Math.max(0,Math.min(n-1,Math.round(t*(n-1)))); const c=s.candles[idx]; const base=s.candles[0]?.o??c.o; const pct=base?((c.c-base)/base*100):0; tipEl.textContent=`${fmtBRL.format(c.c)} • O ${fmtBRL.format(c.o)} • H ${fmtBRL.format(c.h)} • L ${fmtBRL.format(c.l)} • ${pct>=0?'+':''}${pct.toFixed(2)}%`; tipEl.hidden=false; const tipRect=tipEl.getBoundingClientRect(); const off=10; let tx=clientX+off, ty=(ev.touches?ev.touches[0].clientY:ev.clientY)+off; if((tx+tipRect.width)>window.innerWidth-6) tx=clientX-tipRect.width-off; if((ty+tipRect.height)>window.innerHeight-6) ty-=tipRect.height+off; tipEl.style.left=`${Math.max(6,tx)}px`; tipEl.style.top=`${Math.max(6,ty)}px`; }; const leave=()=>{ tipEl.hidden=true; }; el.addEventListener('mousemove',move); el.addEventListener('touchstart',move,{passive:true}); el.addEventListener('touchmove',move,{passive:true}); el.addEventListener('mouseleave',leave); el.addEventListener('touchend',leave); el.addEventListener('touchcancel',leave); }
  }

  async function seed(){ try{ const days = 1; const j = await getJSON(ENDPOINTS.CG(id,'brl',days)); const arr = Array.isArray(j?.prices)? j.prices: []; series = arr.map(x=>[Number(x[0]), Number(x[1])]).filter(x=> Number.isFinite(x[0]) && Number.isFinite(x[1])); draw(); }catch{ /* ignore seed errors */ } }
  seed();

  // live: poll BitPreço/CG fallback light for last price and append
  async function live(){ try{ const cg = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=brl`,{cache:'no-store'}); if(cg.ok){ const j=await cg.json(); const v=Number(j?.[id]?.brl); if(Number.isFinite(v)){ series.push([Date.now(), v]); const cutoff = Date.now() - RANGE_MS['24h']; series = series.filter(x=> x[0] >= cutoff); draw(); } } }catch{} finally { setTimeout(live, 30_000); } }
  live();

  if('serviceWorker' in navigator){ window.addEventListener('load', ()=>{ try{ navigator.serviceWorker.register('./sw.js'); }catch{} }); }
})();

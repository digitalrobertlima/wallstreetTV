(()=>{
  // Config de mercados: nome, cidade, timezone IANA, sessões (local time)
  const MARKETS = [
    { key:'nyse', name:'NYSE (EUA)', tz:'America/New_York', city:'Nova York', sessions:[{open:'09:30', close:'16:00'}] },
    { key:'nasdaq', name:'Nasdaq (EUA)', tz:'America/New_York', city:'Nova York', sessions:[{open:'09:30', close:'16:00'}] },
    { key:'b3', name:'B3 (Brasil)', tz:'America/Sao_Paulo', city:'São Paulo', sessions:[{open:'10:00', close:'17:55'}] },
    { key:'lse', name:'LSE (Reino Unido)', tz:'Europe/London', city:'Londres', sessions:[{open:'08:00', close:'16:30'}] },
    { key:'euronext', name:'Euronext (Europa)', tz:'Europe/Paris', city:'Paris', sessions:[{open:'09:00', close:'17:30'}] },
    { key:'xetra', name:'Xetra (Alemanha)', tz:'Europe/Berlin', city:'Frankfurt', sessions:[{open:'09:00', close:'17:30'}] },
    { key:'tse', name:'TSE (Japão)', tz:'Asia/Tokyo', city:'Tóquio', sessions:[{open:'09:00', close:'15:00'}] },
    { key:'hkex', name:'HKEX (Hong Kong)', tz:'Asia/Hong_Kong', city:'Hong Kong', sessions:[{open:'09:30', close:'16:00'}] },
    { key:'asx', name:'ASX (Austrália)', tz:'Australia/Sydney', city:'Sydney', sessions:[{open:'10:00', close:'16:00'}] },
    { key:'nse', name:'NSE (Índia)', tz:'Asia/Kolkata', city:'Mumbai', sessions:[{open:'09:15', close:'15:30'}] },
  ];

  const wrap = document.getElementById('clocks');
  const fmtOpt = (tz)=> ({ hour12:false, timeZone:tz, hour:'2-digit', minute:'2-digit', second:'2-digit'});

  function parseHM(hm){ const [h,m] = hm.split(':').map(Number); return {h: h||0, m: m||0}; }
  function inSession(now, tz, sessions){
    // now: Date in UTC; compute local times for sessions
    const day = new Intl.DateTimeFormat('en-US',{timeZone:tz, weekday:'short'}).format(now);
    // Basic weekday filter (markets mostly Mon-Fri)
    const isWeekend = day === 'Sat' || day === 'Sun';
    if(isWeekend) return { open:false, nextOpen: nextSessionStart(now, tz, sessions) };
    const nLocal = zonedDate(now, tz);
    for(const s of sessions){
      const o = parseHM(s.open), c = parseHM(s.close);
      const oD = new Date(nLocal); oD.setHours(o.h, o.m, 0, 0);
      const cD = new Date(nLocal); cD.setHours(c.h, c.m, 0, 0);
      if(nLocal >= oD && nLocal <= cD){
        return { open:true, closesAt: cD };
      }
      if(nLocal < oD){
        return { open:false, nextOpen: oD };
      }
    }
    // After last close today, next open tomorrow's first session
    return { open:false, nextOpen: nextSessionStart(now, tz, sessions, 1) };
  }
  function nextSessionStart(now, tz, sessions, addDays=0){
    const n = zonedDate(now, tz); n.setDate(n.getDate() + (addDays||0));
    const first = sessions[0]; const o = parseHM(first.open);
    n.setHours(o.h, o.m, 0, 0);
    // If weekend, roll to next Monday
    while(true){
      const wd = new Intl.DateTimeFormat('en-US',{timeZone:tz, weekday:'short'}).format(n);
      if(wd==='Sat'){ n.setDate(n.getDate()+2); continue; }
      if(wd==='Sun'){ n.setDate(n.getDate()+1); continue; }
      break;
    }
    return n;
  }
  function zonedDate(utcDate, tz){
    // Construct a Date that represents the same instant but we can compare in that tz
    // We’ll format parts and rebuild a Date in that tz’s wall-clock for comparisons
    const parts = new Intl.DateTimeFormat('en-US',{
      timeZone: tz,
      year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
    }).formatToParts(utcDate).reduce((acc,p)=>{acc[p.type]=p.value; return acc;},{});
    const mm = parts.month, dd = parts.day, yy = parts.year, hh = parts.hour, mi = parts.minute, ss = parts.second;
    return new Date(`${yy}-${mm}-${dd}T${hh}:${mi}:${ss}`);
  }

  function timeLeftStr(from, to){
    const ms = Math.max(0, to - from);
    const s = Math.floor(ms/1000);
    const h = Math.floor(s/3600);
    const m = Math.floor((s%3600)/60);
    const ss = s%60;
    const pad=(n)=> String(n).padStart(2,'0');
    if(h>0) return `${h}h ${pad(m)}m ${pad(ss)}s`;
    if(m>0) return `${m}m ${pad(ss)}s`;
    return `${ss}s`;
  }

  function render(){
    wrap.innerHTML = '';
    const now = new Date();
    for(const mkt of MARKETS){
      const card = document.createElement('section');
      card.className = 'clock';
      const fmt = new Intl.DateTimeFormat('pt-BR', fmtOpt(mkt.tz));
      const state = inSession(now, mkt.tz, mkt.sessions);
      const open = state.open;
      const status = open ? `<span class="open">ABERTO</span>` : `<span class="closed">FECHADO</span>`;
      const sessInfo = open ? `Fecha em ${timeLeftStr(zonedDate(now, mkt.tz), state.closesAt)}` : `Abre em ${timeLeftStr(zonedDate(now, mkt.tz), state.nextOpen)}`;
      card.innerHTML = `
        <h2>${mkt.name} • <span class="sub">${mkt.city}</span></h2>
        <div class="now" aria-live="polite">${fmt.format(now)}</div>
        <div class="sess">${status} • ${sessInfo}</div>
        <div class="legend">Sessão: ${mkt.sessions.map(s=>`${s.open}–${s.close}`).join(', ')} (${mkt.tz})</div>
      `;
      wrap.appendChild(card);
    }
  }

  render();
  setInterval(render, 1000);
})();

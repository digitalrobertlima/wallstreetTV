(() => {
  const APP_VERSION = 'v0.0.6';
  // ===== CONFIG ==============================================================
  const REFRESH_MS = 35_000; // 35 segundos
  const REFRESH_HIDDEN_MS = 90_000; // reduzir consumo quando aba estiver oculta
  const MAX_POINTS = 360;    // ~3.5h de histórico
  const TARGET_MAX_REQ_PER_MIN = 28; // margem de segurança sob 30/min
  const COINS = [
    { symbol: 'BTC', pair: 'btc-brl', label: 'BTC/BRL' },
    { symbol: 'ETH', pair: 'eth-brl', label: 'ETH/BRL' },
    { symbol: 'BNB', pair: 'bnb-brl', label: 'BNB/BRL' },
    { symbol: 'DASH', pair: 'dash-brl', label: 'DASH/BRL' },
    { symbol: 'USDT', pair: 'usdt-brl', label: 'USDT/BRL' },
    { symbol: 'USDC', pair: 'usdc-brl', label: 'USDC/BRL' },
    { symbol: 'SOL',  pair: 'sol-brl',  label: 'SOL/BRL'  },
    { symbol: 'ADA',  pair: 'ada-brl',  label: 'ADA/BRL'  },
    { symbol: 'XRP',  pair: 'xrp-brl',  label: 'XRP/BRL'  },
    { symbol: 'DOGE', pair: 'doge-brl', label: 'DOGE/BRL' },
  ];
  const ENDPOINTS = {
    TICKERS_ALL: 'https://api.bitpreco.com/all-brl/ticker',
    TICKER:      (pair) => `https://api.bitpreco.com/${pair}/ticker`,
    ORDERBOOK:   (pair) => `https://api.bitpreco.com/${pair}/orderbook`,
    TRADES:      (pair) => `https://api.bitpreco.com/${pair}/trades`,
  };
  const ENDPOINTS_WEATHER = {
    CURRENT: (lat, lon) => `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=America%2FSao_Paulo`,
  };
  const ENDPOINTS_BINANCE = {
    PRICE:      (symbol) => `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
    BOOK_TICKER:(symbol) => `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${symbol}`,
  };
  const fmtBRL = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' });
  const fmtNum = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 });
  const sleep = (ms)=> new Promise(r=> setTimeout(r, ms));
  const TIMEOUT_MS = 9000; // timeout padrão de fetch

  // ===== Diagnóstico e persistência =========================================
  const LAT = { samples:[], max:50, avg:0 };
  let ERR_COUNT = 0; let LAST_ERR = null;
  let PERSIST = false; // opt-in
  try{
    const saved = localStorage.getItem('wstv_diag');
    if(saved){ const j = JSON.parse(saved); if(j && j.persist) PERSIST = true; if(Array.isArray(j.samples)) { LAT.samples = j.samples.slice(-LAT.max); } }
  }catch{ /* ignore */ }
  function saveDiag(){ if(!PERSIST) return; try{ localStorage.setItem('wstv_diag', JSON.stringify({ persist:true, samples: LAT.samples.slice(-LAT.max) })); }catch{} }
  function recordLatency(ms){ LAT.samples.push(ms); if(LAT.samples.length > LAT.max) LAT.samples.shift(); LAT.avg = LAT.samples.reduce((a,b)=>a+b,0)/LAT.samples.length; saveDiag(); }
  function recordError(e){ ERR_COUNT++; LAST_ERR = (e && e.message) ? e.message : String(e); }

  // ===== Estado ==============================================================
  const S = Object.fromEntries(COINS.map(c => [c.pair, {
    last:null, prev:null, high:null, low:null, vol:null, var:null,
    bid:null, ask:null, spread:null,
    trade:null, history:[], lastAt:null,
    alt:{ last:null, bid:null, ask:null, at:null },
    _histAt:null,
    dir:'flat', // direção de cor do blink no card (up/down/flat)
    _dispLast:null, // último preço exibido (após choosePrice)
  }])) ;
  let NET_ERR = false;

  // ===== DOM ================================================================
  const grid = document.getElementById('grid');
  const versionBadge = document.getElementById('versionBadge');
  const tapeTrack = document.getElementById('tapeTrack');
  const tapeA = document.getElementById('tapeA');
  const tapeB = document.getElementById('tapeB');
  const lastUpdate = document.getElementById('lastUpdate');
  const intervalText = document.getElementById('intervalText');
  const brClock = document.getElementById('brClock');
  const brWeather = document.getElementById('brWeather');
  const pwaBadge = document.getElementById('pwaBadge');
  const diagBtn = document.getElementById('diagToggle');
  const diagBox = document.getElementById('diag');
  const diagClose = document.getElementById('diagClose');
  const diagLatency = document.getElementById('diagLatency');
  const diagErrors = document.getElementById('diagErrors');
  const diagLastErr = document.getElementById('diagLastErr');
  const diagPersist = document.getElementById('diagPersist');

  intervalText.textContent = Math.round(REFRESH_MS/1000)+"s";
  if(versionBadge) versionBadge.textContent = APP_VERSION;
  if(diagPersist){ diagPersist.checked = !!PERSIST; diagPersist.addEventListener('change', ()=>{ PERSIST = !!diagPersist.checked; if(!PERSIST) try{ localStorage.removeItem('wstv_diag'); }catch{} else saveDiag(); }); }

  // Mostrar badge PWA se standalone
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
    if(pwaBadge) pwaBadge.hidden = false;
  }

  // ===== UI Build ===========================================================
  const tiles = {};
  const TAPE_LAST = Object.create(null);
  let TAPE_START_TS = performance.now();
  let TAPE_BUILT = false;
  let TAPE_SECONDS = 40;
  const TAPE_ELEMS = [];
  let TAPE_RUN_WIDTH = 0;
  let _tapeUpdateTimer = null;

  function buildTape(){
    if(!tapeA || !tapeB || TAPE_BUILT) return;
    tapeA.innerHTML = '';
    tapeB.innerHTML = '';
    TAPE_ELEMS.length = 0;
    COINS.forEach((c, idx) => {
      const makeTick = () => {
        const tick = document.createElement('span'); tick.className = 'tick';
        const sym = document.createElement('span'); sym.className = 'sym'; sym.textContent = c.symbol;
        const pri = document.createElement('span'); pri.className = 'pri blink flat'; pri.textContent = '—';
        const sig = document.createElement('span'); sig.className = 'sig'; sig.textContent = '•';
        tick.appendChild(sym); tick.appendChild(pri); tick.appendChild(sig);
        return { tick, pri, sig };
      };
      const a = makeTick(); const b = makeTick();
      tapeA.appendChild(a.tick);
      tapeB.appendChild(b.tick);
      if(idx < COINS.length - 1){
        const sepA = document.createElement('span'); sepA.className = 'sep'; sepA.textContent = '·'; tapeA.appendChild(sepA);
        const sepB = document.createElement('span'); sepB.className = 'sep'; sepB.textContent = '·'; tapeB.appendChild(sepB);
      }
      TAPE_ELEMS.push({ pair:c.pair, aPri:a.pri, aSig:a.sig, bPri:b.pri, bSig:b.sig });
    });
    TAPE_BUILT = true;
    TAPE_RUN_WIDTH = tapeA.scrollWidth;
    tapeA.style.width = TAPE_RUN_WIDTH + 'px';
    tapeB.style.width = TAPE_RUN_WIDTH + 'px';
    tuneTickerSpeed(true);
  }

  const WEATHER_CITIES = [
    { key:'BSB', name:'Brasília',       lat:-15.7939, lon:-47.8828 },
    { key:'SP',  name:'São Paulo',      lat:-23.5505, lon:-46.6333 },
    { key:'RIO', name:'Rio de Janeiro', lat:-22.9068, lon:-43.1729 },
    { key:'BH',  name:'Belo Horizonte', lat:-19.9167, lon:-43.9345 },
    { key:'SSA', name:'Salvador',       lat:-12.9777, lon:-38.5016 },
    { key:'FOR', name:'Fortaleza',      lat:-3.7319,  lon:-38.5267 },
    { key:'REC', name:'Recife',         lat:-8.0476,  lon:-34.8770 },
    { key:'CTA', name:'Curitiba',       lat:-25.4284, lon:-49.2733 },
    { key:'POA', name:'Porto Alegre',   lat:-30.0346, lon:-51.2177 },
    { key:'MAO', name:'Manaus',         lat:-3.1190,  lon:-60.0217 },
  ];
  const WEATHER_REFRESH_MS = 10*60*1000;
  const WEA = Object.fromEntries(WEATHER_CITIES.map(c=>[c.key,{temp:null, at:0}]));

  COINS.forEach(c => {
    const tile = document.createElement('section');
    tile.className = 'tile';
    tile.innerHTML = `
      <div class="row">
        <div class="id">
          <div class="ticker">${c.symbol}</div>
          <div class="pair">${c.label}</div>
        </div>
        <div class="row row-tight align-end">
          <div class="price" id="p-${c.pair}" aria-live="polite" aria-atomic="true" aria-label="Preço atual">—</div>
          <div class="delta" id="d-${c.pair}">—</div>
        </div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="label">Alta 24h</div><div class="value" id="hi-${c.pair}">—</div></div>
        <div class="kpi"><div class="label">Baixa 24h</div><div class="value" id="lo-${c.pair}">—</div></div>
        <div class="kpi"><div class="label">Volume 24h</div><div class="value" id="vo-${c.pair}">—</div></div>
      </div>
      <canvas class="spark" id="sp-${c.pair}" width="600" height="140" aria-label="mini gráfico da ${c.label}"></canvas>
      <div class="book">
        <div class="kpi"><div class="label">L1 BID</div><div class="value" id="bid-${c.pair}">—</div></div>
        <div class="kpi"><div class="label">L1 ASK</div><div class="value" id="ask-${c.pair}">—</div></div>
        <div class="kpi"><div class="label">Spread</div><div class="value" id="spu-${c.pair}">—</div></div>
      </div>
      <div class="trade" id="tr-${c.pair}">
        <span class="badge">Última negociação</span>
        <span class="pill" id="tt-${c.pair}">—</span>
        <span id="ta-${c.pair}">—</span>
        <span>•</span>
        <span id="tp-${c.pair}">—</span>
        <span>•</span>
        <span id="ts-${c.pair}">—</span>
      </div>
    `;
    grid.appendChild(tile);
    tiles[c.pair] = tile;
  });

  // ===== Fetchers com timeout ==============================================
  async function getJSON(url){
    let attempt = 0; let delay = 500;
    while(true){
      try{
        const controller = new AbortController();
        const timer = setTimeout(()=> controller.abort(), TIMEOUT_MS);
        const t0 = performance.now();
        const res = await fetch(url, { cache:'no-store', signal: controller.signal });
        const t1 = performance.now(); recordLatency(t1 - t0); clearTimeout(timer);
        if(res.status === 429){
          const ra = res.headers.get('Retry-After');
          const raMs = ra ? (Number(ra) * 1000) : delay;
          await sleep(raMs + Math.random()*250);
          attempt++; delay *= 2;
          if(attempt >= 3) throw new Error(`HTTP 429 (limite) @ ${url}`);
          continue;
        }
        if(!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
        return await res.json();
      }catch(err){
        attempt++; recordError(err);
        if(attempt >= 3) throw err;
        await sleep(delay + Math.random()*200);
        delay *= 2;
      }
    }
  }

  // ===== Stale-While-Revalidate de APIs (leve no SW-like) ====================
  // Para BitPreço tickers, guardamos o último bom em memória; se falhar, usamos o alt
  // Para uma experiência melhor, opcionalmente poderíamos usar IndexedDB; mantemos simples.

  async function fetchTickers(){
    try {
      const data = await getJSON(ENDPOINTS.TICKERS_ALL);
      for(const c of COINS){
        const k = c.pair; const keyUpperPair = k.toUpperCase();
        const t = data[keyUpperPair] || data[k] || data[c.symbol] || data[c.symbol?.toUpperCase?.()] || data[c.symbol?.toLowerCase?.()];
        if(t) applyTicker(k, t); else applyTicker(k, await getJSON(ENDPOINTS.TICKER(k)));
      }
    } catch(err){
      console.error('tickers/all falhou:', err); NET_ERR = true;
      await Promise.all(COINS.map(async c => {
        try{ applyTicker(c.pair, await getJSON(ENDPOINTS.TICKER(c.pair))); }catch(e){ console.error('ticker falhou', c.pair, e); NET_ERR = true; }
      }));
    }
  }

  function applyTicker(pair, t){
    const st = S[pair];
    st.prev = st.last;
    const computedLast = Number(t.last ?? t.price ?? t.Last ?? t.LAST ?? NaN);
    st.last = (Number.isFinite(computedLast) && computedLast > 0) ? computedLast : NaN;
    st.high = Number(t.high ?? t.High ?? NaN);
    st.low  = Number(t.low  ?? t.Low  ?? NaN);
    st.vol  = Number(t.vol  ?? t.volume ?? NaN);
    st.var  = (t.var !== undefined) ? Number(t.var) : null;
    st.lastAt = Date.now();
    if(Number.isFinite(st.last) && st.last > 0){ maybePushHistory(st, st.last); }
  }

  function maybePushHistory(st, price){
    const now = Date.now(); const MIN_GAP = 10_000;
    if(st._histAt && (now - st._histAt) < MIN_GAP) return;
    st._histAt = now; st.history.push(price);
    if(st.history.length > MAX_POINTS) st.history.shift();
  }

  let cycleCount = 0; let FETCH_TRADES_EVERY = computeTradesEvery(REFRESH_MS);
  async function fetchOrderbookAndTrades(){
    const shouldFetchTrades = !document.hidden && ((cycleCount % FETCH_TRADES_EVERY) === 0);
    const BATCH = 3;
    for(let i=0;i<COINS.length;i+=BATCH){
      const batch = COINS.slice(i, i+BATCH);
      await Promise.all(batch.map(async c => {
        const pair = c.pair;
        try{
          const ob = await getJSON(ENDPOINTS.ORDERBOOK(pair));
          const bestBid = ob.bids && ob.bids.length ? ob.bids[0] : null;
          const bestAsk = ob.asks && ob.asks.length ? ob.asks[0] : null;
          const bid = bestBid ? Number(bestBid.price ?? bestBid[1] ?? bestBid) : null;
          const ask = bestAsk ? Number(bestAsk.price ?? bestAsk[1] ?? bestAsk) : null;
          S[pair].bid = bid; S[pair].ask = ask; S[pair].spread = (bid && ask) ? (ask - bid) : null;
        }catch(e){ console.error('orderbook falhou', pair, e); NET_ERR = true; }
        if(shouldFetchTrades){
          try{
            const tr = await getJSON(ENDPOINTS.TRADES(pair));
            const last = Array.isArray(tr) && tr.length ? tr.reduce((a,b)=> new Date(b.timestamp) > new Date(a.timestamp) ? b : a) : null;
            S[pair].trade = last || null;
          }catch(e){ console.error('trades falhou', pair, e); NET_ERR = true; }
        }
      }));
      await sleep(200);
    }
  }

  function computeTradesEvery(baseMs){
    const N = COINS.length; const cpm = 60_000 / baseMs; const baseline = cpm * (1 + N); const budget = TARGET_MAX_REQ_PER_MIN - baseline;
    if (budget <= 0) return 9999; const freq = Math.ceil((cpm * N) / budget); return Math.max(1, Math.min(10, freq));
  }

  // ===== Binance leve ========================================================
  const BINANCE_SYMBOLS = Object.fromEntries(COINS.map(c=>{ const s = c.pair.toUpperCase().replace(/-/g,''); return [c.pair, s]; }));
  const BINANCE_AUX = { DASH_USDT: 'DASHUSDT', USDT_BRL: 'USDTBRL' };

  async function fetchBinanceLight(){
    const BATCH = 4;
    for(let i=0;i<COINS.length;i+=BATCH){
      const batch = COINS.slice(i, i+BATCH);
      await Promise.all(batch.map(async c => {
        const pair = c.pair; const sym = BINANCE_SYMBOLS[pair]; if(!sym) return;
        try{
          const tp = await getJSON(ENDPOINTS_BINANCE.PRICE(sym));
          const last = Number(tp?.price ?? NaN);
          if(Number.isFinite(last)){ const st = S[pair]; st.alt.last = last; st.alt.at = Date.now(); maybePushHistory(st, last); }
        }catch{ /* ignore */ }
        try{
          const bt = await getJSON(ENDPOINTS_BINANCE.BOOK_TICKER(sym));
          const bid = Number(bt?.bidPrice ?? NaN); const ask = Number(bt?.askPrice ?? NaN);
          const st = S[pair]; st.alt.bid = Number.isFinite(bid) ? bid : st.alt.bid; st.alt.ask = Number.isFinite(ask) ? ask : st.alt.ask; if(Number.isFinite(st.alt.bid) && Number.isFinite(st.alt.ask)) st.alt.at = Date.now();
        }catch{ /* ignore */ }
        if(pair === 'dash-brl' && (!Number.isFinite(S[pair].alt.last) || !sym || sym === 'DASHBRL')){
          try{
            const [pDashUsdt, pUsdtBrl] = await Promise.all([
              getJSON(ENDPOINTS_BINANCE.PRICE(BINANCE_AUX.DASH_USDT)),
              getJSON(ENDPOINTS_BINANCE.PRICE(BINANCE_AUX.USDT_BRL))
            ]);
            const a = Number(pDashUsdt?.price ?? NaN); const b = Number(pUsdtBrl?.price ?? NaN);
            const st = S[pair]; if(Number.isFinite(a) && Number.isFinite(b)){ const last = a * b; st.alt.last = last; st.alt.at = Date.now(); maybePushHistory(st, last); }
          }catch{ /* ignore */ }
        }
        if(pair === 'dash-brl'){
          try{
            const [dashUsdtPrice, usdtBrlPrice, dashUsdtBook, usdtBrlBook] = await Promise.all([
              getJSON(ENDPOINTS_BINANCE.PRICE(BINANCE_AUX.DASH_USDT)),
              getJSON(ENDPOINTS_BINANCE.PRICE(BINANCE_AUX.USDT_BRL)),
              getJSON(ENDPOINTS_BINANCE.BOOK_TICKER(BINANCE_AUX.DASH_USDT)),
              getJSON(ENDPOINTS_BINANCE.BOOK_TICKER(BINANCE_AUX.USDT_BRL)),
            ]);
            const aLast = Number(dashUsdtPrice?.price ?? NaN); const bLast = Number(usdtBrlPrice?.price ?? NaN);
            const dashBid = Number(dashUsdtBook?.bidPrice ?? NaN); const dashAsk = Number(dashUsdtBook?.askPrice ?? NaN);
            const usdtBid = Number(usdtBrlBook?.bidPrice ?? NaN); const usdtAsk = Number(usdtBrlBook?.askPrice ?? NaN);
            const st = S[pair];
            if(Number.isFinite(aLast) && Number.isFinite(bLast)){ const last = aLast * bLast; st.alt.last = last; st.alt.at = Date.now(); maybePushHistory(st, last); }
            if(Number.isFinite(dashBid) && Number.isFinite(usdtBid)) st.alt.bid = dashBid * usdtBid;
            if(Number.isFinite(dashAsk) && Number.isFinite(usdtAsk)) st.alt.ask = dashAsk * usdtAsk;
          }catch{ /* ignore */ }
        }
      }));
      await sleep(150);
    }
  }

  // ===== Render ==============================================================
  function render(){
    buildTape();
    const GUARD_MS = 280; const now = performance.now(); const elapsed = (now - TAPE_START_TS) / 1000; const remMs = (TAPE_SECONDS - (elapsed % TAPE_SECONDS)) * 1000; const safeUpdate = () => { _tapeUpdateTimer = null; updateTape(); };
    if(remMs < GUARD_MS){ if(!_tapeUpdateTimer){ _tapeUpdateTimer = setTimeout(safeUpdate, Math.max(30, remMs + 30)); } } else { updateTape(); }
    for(const c of COINS){
      const k = c.pair, st = S[k];
      const dispPrice = choosePrice(st);
      // Atualiza direção de cor com base no preço exibido (sticky até mudar)
      const prevShown = st._dispLast;
      if(Number.isFinite(dispPrice)){
        if(Number.isFinite(prevShown)){
          if(dispPrice > prevShown) st.dir = 'up';
          else if(dispPrice < prevShown) st.dir = 'down';
          // se igual, mantém cor anterior
        }
        st._dispLast = dispPrice;
      }
      setPrice(`p-${k}`, dispPrice);
      // continuous blink on main price using sticky direction
      const priceEl = document.getElementById(`p-${k}`);
      if(priceEl){
        priceEl.className = `price blink ${st.dir || 'flat'}`;
      }
      let deltaStr = '—', cls = '';
      if(Number.isFinite(st.last) && Number.isFinite(st.prev)){
        const delta = st.last - st.prev; const perc = st.prev ? (delta/st.prev*100) : 0; deltaStr = `${delta>=0?'+':''}${perc.toFixed(2)}%`; cls = delta>0 ? 'up' : delta<0 ? 'down' : '';
      }
      setDelta(`d-${k}`, deltaStr, cls);
      setText(`hi-${k}`, Number.isFinite(st.high) ? fmtBRL.format(st.high) : '—');
      setText(`lo-${k}`, Number.isFinite(st.low)  ? fmtBRL.format(st.low)  : '—');
      setText(`vo-${k}`, Number.isFinite(st.vol)  ? fmtNum.format(st.vol)  : '—');
      const bidDisp = Number.isFinite(st.bid) ? st.bid : (Number.isFinite(st.alt.bid) ? st.alt.bid : null);
      const askDisp = Number.isFinite(st.ask) ? st.ask : (Number.isFinite(st.alt.ask) ? st.alt.ask : null);
      const sprDisp = (Number.isFinite(bidDisp) && Number.isFinite(askDisp)) ? (askDisp - bidDisp) : (Number.isFinite(st.spread) ? st.spread : null);
      setText(`bid-${k}`, Number.isFinite(bidDisp) ? fmtBRL.format(bidDisp) : '—');
      setText(`ask-${k}`, Number.isFinite(askDisp) ? fmtBRL.format(askDisp) : '—');
      setText(`spu-${k}`, Number.isFinite(sprDisp) ? fmtBRL.format(sprDisp) : '—');
      const tr = st.trade; const side = (tr?.type || tr?.TYPE || '').toString().toUpperCase();
      const sideClass = side === 'BUY' ? 'buy' : side === 'SELL' ? 'sell' : '';
      setPill(`tt-${k}`, side || '—', sideClass);
      setText(`ta-${k}`, tr?.amount != null ? `${fmtNum.format(Number(tr.amount))}` : '—');
      setText(`tp-${k}`, tr?.price  != null ? fmtBRL.format(Number(tr.price)) : '—');
      setText(`ts-${k}`, tr?.timestamp ? humanTime(tr.timestamp) : '—');
      drawSpark(`sp-${k}`, st.history);
    }
    renderDiag();
  }

  function updateTape(){
    if(!TAPE_BUILT) return;
    for(const ref of TAPE_ELEMS){
      const st = S[ref.pair]; const priceNum = choosePrice(st);
      const price = Number.isFinite(priceNum) ? fmtBRL.format(priceNum) : '—';
      const d = (st.prev && st.last) ? (st.last - st.prev) : 0;
      const sigCls = d>0 ? 'up' : d<0 ? 'down' : '';
      let blinkCls = 'flat'; const prevTape = TAPE_LAST[ref.pair];
      if(Number.isFinite(priceNum) && Number.isFinite(prevTape)){
        if(priceNum > prevTape) blinkCls = 'up'; else if(priceNum < prevTape) blinkCls = 'down'; else blinkCls = 'flat';
      }
      if(Number.isFinite(priceNum)) TAPE_LAST[ref.pair] = priceNum;
      ref.aPri.textContent = price; ref.bPri.textContent = price;
      ref.aPri.className = `pri blink ${blinkCls}`; ref.bPri.className = `pri blink ${blinkCls}`;
      ref.aSig.className = `sig ${sigCls}`; ref.bSig.className = `sig ${sigCls}`;
      const arrow = d>0 ? '▲' : d<0 ? '▼' : '•'; ref.aSig.textContent = arrow; ref.bSig.textContent = arrow;
    }
    if(tapeA){
      const w = tapeA.scrollWidth;
      if(Math.abs(w - TAPE_RUN_WIDTH) > 16){
        TAPE_RUN_WIDTH = w; tapeA.style.width = TAPE_RUN_WIDTH + 'px'; tapeB.style.width = TAPE_RUN_WIDTH + 'px'; tapeA._lastWidth = w; tuneTickerSpeed(true);
      }
    }
  }

  function setPrice(id, value){ const el = document.getElementById(id); if(!el) return; const parent = el.parentElement; if(!parent){ el.textContent = '—'; return; } if(!Number.isFinite(value)){ el.textContent = '—'; return; } el.style.fontSize = ''; el.textContent = fmtBRL.format(value); fitToRow(el, parent); }
  function fitToRow(el, parent){ const row = parent; const siblings = Array.from(row.children).filter(n=> n !== el); const deltaEl = siblings.find(n=> n.classList.contains('delta')); const gap = 10; const deltaW = deltaEl ? deltaEl.getBoundingClientRect().width : 0; const maxW = Math.max(0, row.clientWidth - deltaW - gap - 2); if(el.scrollWidth <= maxW) return; let fs = parseFloat(getComputedStyle(el).fontSize) || 32; let guard = 0; while(el.scrollWidth > maxW && fs > 8 && guard < 20){ fs = Math.max(8, Math.floor(fs * 0.9)); el.style.fontSize = fs + 'px'; guard++; } }
  function choosePrice(st){ const now = Date.now(); const freshMs = 2 * REFRESH_MS; if(Number.isFinite(st.last) && st.last > 0 && st.lastAt && (now - st.lastAt) < freshMs) return st.last; if(Number.isFinite(st.alt.last) && st.alt.at && (now - st.alt.at) < freshMs) return st.alt.last; return Number.isFinite(st.last) && st.last > 0 ? st.last : (Number.isFinite(st.alt.last) ? st.alt.last : NaN); }
  function setText(id, txt){ const el = document.getElementById(id); if(el) el.textContent = txt; }
  function setDelta(id, txt, cls){ const el = document.getElementById(id); if(!el) return; el.textContent=txt; el.className = `delta ${cls}`; }
  function setPill(id, txt, cls){ const el = document.getElementById(id); if(!el) return; el.textContent = txt; el.className = `pill ${cls}`; }
  function setNet(ok){ const d = document.getElementById('netDot'); if(!d) return; d.className = `dot ${ok? 'ok':'err'}`; d.title = ok? 'Conexão OK' : 'Falha de rede parcial'; }
  function humanTime(ts){ const t = new Date(ts); if(isNaN(+t)) return String(ts); const diff = (Date.now()-t.getTime())/1000; if(diff < 60) return `${Math.floor(diff)}s atrás`; if(diff < 3600) return `${Math.floor(diff/60)}min atrás`; const d = t.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); return d; }
  function drawSpark(id, series){ const el = document.getElementById(id); if(!el) return; const ctx = el.getContext('2d'); const dpr = window.devicePixelRatio || 1; if(el._dpr !== dpr){ el._dpr = dpr; el.width = Math.floor(el.clientWidth*dpr); el.height = Math.floor(el.clientHeight*dpr); } const W = el.width, H = el.height; ctx.clearRect(0,0,W,H); ctx.globalAlpha = .5; ctx.strokeStyle = 'rgba(255,255,255,.04)'; const lines = 3; for(let i=1;i<=lines;i++){ const y = (H/(lines+1))*i; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); } ctx.globalAlpha = 1; if(!series || series.length<2){ return; } const min = Math.min(...series), max = Math.max(...series); const pad = 6*dpr; const scaleX = (i)=> pad + (W-2*pad) * (i/(series.length-1)); const scaleY = (v)=>{ if(max===min) return H/2; return H - pad - ( (v - min) / (max - min) ) * (H - 2*pad); }; const last = series[series.length-1], prev = series[series.length-2]; const up = last >= prev; ctx.lineWidth = 2*dpr; ctx.strokeStyle = up ? 'rgba(0,200,83,.95)' : 'rgba(255,59,48,.95)'; ctx.beginPath(); ctx.moveTo(scaleX(0), scaleY(series[0])); for(let i=1;i<series.length;i++) ctx.lineTo(scaleX(i), scaleY(series[i])); ctx.stroke(); const g = ctx.createLinearGradient(0,0,0,H); g.addColorStop(0, up ? 'rgba(0,200,83,.20)' : 'rgba(255,59,48,.20)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.lineTo(W-pad, H-pad); ctx.lineTo(pad, H-pad); ctx.closePath(); ctx.fill(); }

  // ===== Loop ================================================================
  async function cycle(){ NET_ERR = false; await fetchTickers(); await fetchOrderbookAndTrades(); render(); lastUpdate.textContent = new Date().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit', second:'2-digit'}); setNet(!NET_ERR); cycleCount++; }
  let _cycleTimer = null; let _isRunning = false; function nextDelay(){ return document.hidden ? REFRESH_HIDDEN_MS : REFRESH_MS; } function scheduleNext(ms){ if(_cycleTimer) clearTimeout(_cycleTimer); _cycleTimer = setTimeout(runCycle, ms); }
  async function runCycle(){ if(_isRunning){ scheduleNext(250); return; } _isRunning = true; try{ await cycle(); } catch(e){ console.error('cycle erro:', e); } finally{ try{ if((cycleCount % 2) === 1){ await fetchBinanceLight(); render(); } }catch(e){ console.error('binance erro:', e); } _isRunning = false; scheduleNext(nextDelay()); } }
  runCycle(); requestAnimationFrame(()=>{ TAPE_START_TS = performance.now(); tuneTickerSpeed(true); });

  const brFmt = new Intl.DateTimeFormat('pt-BR', { timeZone:'America/Sao_Paulo', hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  function tickClock(){ if(brClock) brClock.textContent = `Brasília: ${brFmt.format(new Date())}`; }
  tickClock(); setInterval(tickClock, 1000);

  async function fetchWeatherAll(){ const BATCH = 3; for(let i=0;i<WEATHER_CITIES.length;i+=BATCH){ const batch = WEATHER_CITIES.slice(i, i+BATCH); await Promise.all(batch.map(async c => { try{ const data = await getJSON(ENDPOINTS_WEATHER.CURRENT(c.lat, c.lon)); const temp = Number(data?.current_weather?.temperature); if(Number.isFinite(temp)){ WEA[c.key].temp = temp; WEA[c.key].at = Date.now(); } }catch{} })); await sleep(200); } renderWeatherBox(); }
  fetchWeatherAll(); setInterval(fetchWeatherAll, WEATHER_REFRESH_MS);
  let WEATHER_IDX = 0; const WEATHER_ROTATE_MS = 60_000; function renderWeatherBox(){ if(!brWeather) return; const city = WEATHER_CITIES[WEATHER_IDX % WEATHER_CITIES.length]; const rec = WEA[city.key]; const t = Number(rec?.temp); const tStr = Number.isFinite(t) ? `${Math.round(t)}°C` : '—°C'; brWeather.innerHTML = `<span class="wx-city">${city.name}</span><span class="wx-temp">${tStr}</span>`; }
  function rotateCity(){ WEATHER_IDX = (WEATHER_IDX + 1) % WEATHER_CITIES.length; renderWeatherBox(); }
  renderWeatherBox(); setInterval(rotateCity, WEATHER_ROTATE_MS);
  document.addEventListener('visibilitychange', () => { if(!document.hidden){ FETCH_TRADES_EVERY = computeTradesEvery(REFRESH_MS); } pauseTape(); scheduleNext(250); setTimeout(()=>{ tuneTickerSpeed(true); }, 150); });

  // ===== Ticker speed ========================================================
  let _tapePauseTimer = null; function pauseTape(){ if(tapeTrack) tapeTrack.style.animationPlayState = 'paused'; } function resumeTape(){ if(tapeTrack) tapeTrack.style.animationPlayState = 'running'; }
  function tuneTickerSpeed(forcePhase=false){ if(!tapeTrack || !tapeA) return; const style = getComputedStyle(tapeTrack); const gapPx = parseFloat(style.columnGap || style.gap || '64') || 64; const runW = tapeA.scrollWidth; const total = runW + gapPx; const pxPerSec = 110; const seconds = Math.max(20, Math.min(90, total / pxPerSec)); TAPE_SECONDS = seconds; const prev = getComputedStyle(tapeTrack).getPropertyValue('--tape-speed').trim(); tapeTrack.style.setProperty('--tape-speed', seconds + 's'); tapeTrack.style.setProperty('--tape-distance', total + 'px'); const prevDist = parseFloat(style.getPropertyValue('--tape-distance') || '0'); const distChanged = Math.abs(prevDist - total) > 1; if(forcePhase || (prev !== (seconds + 's')) || distChanged){ const elapsed = (performance.now() - TAPE_START_TS) / 1000; const phase = (elapsed % seconds).toFixed(3); tapeTrack.style.animationDelay = `-${phase}s`; } if(_tapePauseTimer) clearTimeout(_tapePauseTimer); resumeTape(); }
  const roTicker = new ResizeObserver(()=>{ pauseTape(); if(_tapePauseTimer) clearTimeout(_tapePauseTimer); _tapePauseTimer = setTimeout(()=> tuneTickerSpeed(true), 120); }); if(tapeTrack) roTicker.observe(tapeTrack);

  // ===== Fullscreen ==========================================================
  const fsBtn = document.getElementById('fullscreenBtn'); fsBtn.addEventListener('click', toggleFS); document.addEventListener('keydown', (e)=>{ if(e.key.toLowerCase()==='f') toggleFS(); });
  function toggleFS(){ const el = document.documentElement; if(!document.fullscreenElement){ (el.requestFullscreen && el.requestFullscreen()) || (el.webkitRequestFullscreen && el.webkitRequestFullscreen()); } else { (document.exitFullscreen && document.exitFullscreen()) || (document.webkitExitFullscreen && document.webkitExitFullscreen()); } }
  function updateFsBtn(){ const p = !!document.fullscreenElement; fsBtn.setAttribute('aria-pressed', String(p)); fsBtn.textContent = p ? 'Sair da tela cheia ⤢' : 'Tela cheia ⤢'; }
  document.addEventListener('fullscreenchange', updateFsBtn); updateFsBtn();

  // ===== Diagnóstico UI ======================================================
  function renderDiag(){ if(diagLatency) diagLatency.textContent = LAT.avg ? `${Math.round(LAT.avg)} ms` : '—'; if(diagErrors) diagErrors.textContent = String(ERR_COUNT); if(diagLastErr) diagLastErr.textContent = LAST_ERR || '—'; }
  function toggleDiag(){ const vis = diagBox.hasAttribute('hidden'); if(vis) diagBox.removeAttribute('hidden'); else diagBox.setAttribute('hidden',''); }
  if(diagBtn) diagBtn.addEventListener('click', toggleDiag); if(diagClose) diagClose.addEventListener('click', toggleDiag); renderDiag();

  // ===== SW registro =========================================================
  if('serviceWorker' in navigator){ window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(()=>{}); }); }

  // ===== Erros globais =======================================================
  window.addEventListener('unhandledrejection', (e)=>{ NET_ERR = true; setNet(false); recordError(e.reason || e); renderDiag(); });
  window.addEventListener('error', (e)=>{ /* opcional: recordError(e.error || e.message) */ });
})();

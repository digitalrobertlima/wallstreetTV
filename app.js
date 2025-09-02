(() => {
  const APP_VERSION = 'v0.0.7';
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
  // Preferências de áudio por ativo
  let AUD_PREFS = {};
  // Modo solo (apenas um ativo toca)
  let AUD_SOLO = null;
  try{ const raw = localStorage.getItem('wstv_aud_pairs'); if(raw){ const j = JSON.parse(raw); if(j && typeof j==='object') AUD_PREFS = j; } }catch{}
  try{ const s = localStorage.getItem('wstv_aud_solo'); if(s){ AUD_SOLO = s || null; } }catch{}
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
    aud: !!AUD_PREFS[c.pair] // som habilitado por ativo
  }])) ;
  let NET_ERR = false;

  // ===== DOM ================================================================
  const grid = document.getElementById('grid');
  const versionBadge = document.getElementById('versionBadge');
  const tapeTrack = document.getElementById('tapeTrack');
  const tapeA = document.getElementById('tapeA');
  const tapeB = document.getElementById('tapeB');
  const lastUpdate = document.getElementById('lastUpdate');
  const nextInEl = document.getElementById('nextIn');
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
  const moodBar = document.getElementById('moodBar');
  const soundBtn = document.getElementById('soundBtn');
  const intensityInput = document.getElementById('intensity');
  // Install banner elements
  const installBanner = document.getElementById('installBanner');
  const ibInstall = document.getElementById('ibInstall');
  const ibDismiss = document.getElementById('ibDismiss');
  // Update banner elements
  const updateBanner = document.getElementById('updateBanner');
  const ubReload = document.getElementById('ubReload');
  const ubLater = document.getElementById('ubLater');

  intervalText.textContent = Math.round(REFRESH_MS/1000)+"s";
  if(versionBadge) versionBadge.textContent = APP_VERSION;
  if(diagPersist){ diagPersist.checked = !!PERSIST; diagPersist.addEventListener('change', ()=>{ PERSIST = !!diagPersist.checked; if(!PERSIST) try{ localStorage.removeItem('wstv_diag'); }catch{} else saveDiag(); }); }

  // Intensidade visual (0-100) influencia brilhos/tempos sutis
  let INTENSITY = 70;
  try{ const v = Number(localStorage.getItem('wstv_intensity')); if(Number.isFinite(v)) INTENSITY = Math.max(0, Math.min(100, v)); }catch{}
  function applyIntensity(){ const root = document.documentElement; root.style.setProperty('--intensity', String(INTENSITY)); }
  applyIntensity();
  if(intensityInput){ intensityInput.value = String(INTENSITY); intensityInput.addEventListener('input', ()=>{ const v = Number(intensityInput.value); INTENSITY = Math.max(0, Math.min(100, v)); applyIntensity(); try{ localStorage.setItem('wstv_intensity', String(INTENSITY)); }catch{} }); }

  // ===== Som (WebAudio) =====================================================
  const SOUND = { enabled:false, ctx:null, master:null, _lastAt:0, vol:0.15 };
  function setSoundUI(){ if(!soundBtn) return; soundBtn.setAttribute('aria-pressed', String(!!SOUND.enabled)); soundBtn.textContent = SOUND.enabled ? '🔊 Som' : '🔇 Som'; }
  (function loadSoundPref(){ try{ const v = localStorage.getItem('wstv_sound'); SOUND.enabled = (v === 'on'); }catch{} setSoundUI(); })();
  async function ensureAudio(){ if(!SOUND.ctx){ try{ const AC = window.AudioContext || window.webkitAudioContext; if(!AC) return false; const ctx = new AC(); const gain = ctx.createGain(); gain.gain.value = SOUND.enabled ? SOUND.vol : 0; gain.connect(ctx.destination); SOUND.ctx = ctx; SOUND.master = gain; }catch{ return false; } } if(SOUND.ctx && SOUND.ctx.state === 'suspended'){ try{ await SOUND.ctx.resume(); }catch{} } return !!SOUND.ctx; }
  function toggleSound(){
    SOUND.enabled = !SOUND.enabled;
    try{ localStorage.setItem('wstv_sound', SOUND.enabled ? 'on' : 'off'); }catch{}
    setSoundUI();
    if(SOUND.master){ SOUND.master.gain.value = SOUND.enabled ? SOUND.vol : 0; }
    // Confirmação sonora ao habilitar
    if(SOUND.enabled){ setTimeout(()=>{ blip('up', 0.2); }, 30); }
  }
  function blip(dir, intensity){ if(!SOUND.enabled || document.hidden) return; if(!SOUND.ctx || !SOUND.master) return; const now = SOUND.ctx.currentTime; if((now - SOUND._lastAt) < 0.12) return; SOUND._lastAt = now; try{ const osc = SOUND.ctx.createOscillator(); const g = SOUND.ctx.createGain(); osc.type = 'sine'; const clampI = Math.max(0.05, Math.min(3, Number(intensity)||0.2)); const baseUp = 880; const baseDown = 320; const freq = dir==='up' ? baseUp * (1 + 0.25*Math.log2(1+clampI)) : dir==='down' ? baseDown * (1 + 0.25*Math.log2(1+clampI)) : 600; osc.frequency.setValueAtTime(freq, now); g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(1.0, now + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.13 + 0.03*Math.random()); osc.connect(g); g.connect(SOUND.master); osc.start(now); osc.stop(now + 0.18); }catch{} }
  function chimeError(){ if(!SOUND.enabled || !SOUND.ctx || !SOUND.master) return; const now = SOUND.ctx.currentTime; try{ const o = SOUND.ctx.createOscillator(); const g = SOUND.ctx.createGain(); o.type = 'triangle'; o.frequency.setValueAtTime(660, now); o.frequency.exponentialRampToValueAtTime(330, now + 0.25); g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(1.0, now + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.35); o.connect(g); g.connect(SOUND.master); o.start(now); o.stop(now + 0.4); }catch{} }
  if(soundBtn){ soundBtn.addEventListener('click', async ()=>{ await ensureAudio(); toggleSound(); }); }

  // Mostrar badge PWA somente quando de fato em modo instalado/standalone (robusto)
  function isInstalledContext(){
    try{
      // iOS Safari (Add to Home Screen)
      if(('standalone' in navigator) && navigator.standalone === true) return true;
      // Trusted Web Activity (Android Chrome via referrer)
      if(document.referrer && document.referrer.startsWith('android-app://')) return true;
      if(!window.matchMedia) return false;
      const mStandalone = window.matchMedia('(display-mode: standalone)');
      const mBrowser = window.matchMedia('(display-mode: browser)');
      // Consider installed only if standalone matches and browser does not
      if(mStandalone && mStandalone.matches){ if(mBrowser && mBrowser.matches) return false; return true; }
      return false;
    }catch{ return false; }
  }
  function updatePwaBadge(){ if(!pwaBadge) return; pwaBadge.hidden = !isInstalledContext(); }
  updatePwaBadge();
  // reagir a mudanças de display-mode
  try{
    const mStandalone = window.matchMedia('(display-mode: standalone)');
    const mBrowser = window.matchMedia('(display-mode: browser)');
    const onChange = ()=> updatePwaBadge();
    if(mStandalone && mStandalone.addEventListener) mStandalone.addEventListener('change', onChange);
    if(mBrowser && mBrowser.addEventListener) mBrowser.addEventListener('change', onChange);
  }catch{}
  window.addEventListener('visibilitychange', updatePwaBadge);
  window.addEventListener('resize', updatePwaBadge);
  window.addEventListener('appinstalled', updatePwaBadge);

  // ===== PWA Install Banner (retorno após 1h) ===============================
  const LS_KEYS = {
    snoozeAt: 'wstv_install_snooze_at',
    installed: 'wstv_install_installed',
    declinedCount: 'wstv_install_declined'
  };
  let deferredPrompt = null;
  function shouldShowInstallBanner(){
    // Não mostrar se já instalado
    if(isInstalledContext()) return false;
    // Guardar último acesso e considerar retorno após 1h
    let snoozeAt = 0; try{ snoozeAt = Number(localStorage.getItem(LS_KEYS.snoozeAt)) || 0; }catch{}
    const now = Date.now();
    const oneHour = 60*60*1000;
    if(!snoozeAt) return true; // primeira visita após carregar (sem snooze registrado)
    return (now - snoozeAt) >= oneHour;
  }
  function markSnooze(){ try{ localStorage.setItem(LS_KEYS.snoozeAt, String(Date.now())); }catch{} }
  function showInstallBanner(){ if(!installBanner) return; installBanner.hidden = false; markSnooze(); }
  function hideInstallBanner(){ if(!installBanner) return; installBanner.hidden = true; }

  window.addEventListener('beforeinstallprompt', (e)=>{
    // Previna prompt automático; guardamos para disparar via banner
    e.preventDefault(); deferredPrompt = e; if(shouldShowInstallBanner()) showInstallBanner();
  });
  window.addEventListener('appinstalled', ()=>{ try{ localStorage.setItem(LS_KEYS.installed,'1'); }catch{} hideInstallBanner(); });
  // Se o navegador não disparar beforeinstallprompt (ex: iOS), ainda assim ofereça se não instalado
  document.addEventListener('DOMContentLoaded', ()=>{ setTimeout(()=>{ if(shouldShowInstallBanner()) showInstallBanner(); }, 1500); });

  if(ibInstall){ ibInstall.addEventListener('click', async ()=>{
    if(deferredPrompt && deferredPrompt.prompt){ try{ deferredPrompt.prompt(); const choice = await deferredPrompt.userChoice; if(choice && choice.outcome === 'accepted'){ hideInstallBanner(); try{ localStorage.setItem(LS_KEYS.installed,'1'); }catch{} } else { markSnooze(); hideInstallBanner(); } }catch{ markSnooze(); hideInstallBanner(); } finally { deferredPrompt = null; } }
    else {
      // Sem beforeinstallprompt (iOS Safari / desktop não suportado): mostrar instruções em tooltip simples
      markSnooze(); hideInstallBanner();
      try{
        const msg = 'Para instalar: use “Adicionar à Tela de Início” no menu do navegador.';
        ibInstall.title = msg; ibInstall.blur();
      }catch{}
    }
  }); }
  if(ibDismiss){ ibDismiss.addEventListener('click', ()=>{ markSnooze(); hideInstallBanner(); try{ const n = Number(localStorage.getItem(LS_KEYS.declinedCount))||0; localStorage.setItem(LS_KEYS.declinedCount, String(n+1)); }catch{} }); }

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
          <span class="mini-dot" id="md-${c.pair}" aria-hidden="true"></span>
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
      <div class="tile-foot">
        <div class="aud-controls">
          <button class="aud-btn" id="au-${c.pair}" aria-pressed="${S[c.pair].aud? 'true':'false'}" title="Ativar som para ${c.symbol}">${S[c.pair].aud ? '🔊' : '🔇'}</button>
          <button class="solo-btn" id="so-${c.pair}" aria-pressed="${AUD_SOLO===c.pair? 'true':'false'}" title="Solo: ouvir apenas ${c.symbol}">🎧</button>
        </div>
      </div>
    `;
    grid.appendChild(tile);
    tiles[c.pair] = tile;
    // Listener do botão de áudio por ativo
    const btn = tile.querySelector(`#au-${c.pair}`);
    if(btn){
      btn.addEventListener('click', ()=>{
        const st = S[c.pair]; st.aud = !st.aud; btn.setAttribute('aria-pressed', String(st.aud)); btn.textContent = st.aud ? '🔊' : '🔇';
        AUD_PREFS[c.pair] = st.aud ? true : false;
        try{ localStorage.setItem('wstv_aud_pairs', JSON.stringify(AUD_PREFS)); }catch{}
        // feedback sutil se som global estiver ligado
        if(st.aud) blip('up', 0.1);
      });
    }
    // Listener do botão solo
    const soloBtn = tile.querySelector(`#so-${c.pair}`);
    if(soloBtn){
      if(AUD_SOLO===c.pair) tile.classList.add('solo');
      soloBtn.addEventListener('click', ()=>{
        if(AUD_SOLO === c.pair){
          AUD_SOLO = null;
          tile.classList.remove('solo');
          soloBtn.setAttribute('aria-pressed','false');
        } else {
          // limpar marcação anterior
          const prev = AUD_SOLO; AUD_SOLO = c.pair;
          document.querySelectorAll('.tile.solo').forEach(t=> t.classList.remove('solo'));
          soloBtn.setAttribute('aria-pressed','true');
          tile.classList.add('solo');
          if(prev){ const prevBtn = document.getElementById(`so-${prev}`); if(prevBtn){ prevBtn.setAttribute('aria-pressed','false'); } }
        }
        try{ localStorage.setItem('wstv_aud_solo', AUD_SOLO || ''); }catch{}
      });
    }
  });
  function canPlay(pair){ if(!SOUND.enabled) return false; if(AUD_SOLO){ return AUD_SOLO === pair; } return !!S[pair].aud; }

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
      // flash na tile quando muda o preço exibido
      const tile = tiles[k];
      if(tile && Number.isFinite(dispPrice) && Number.isFinite(prevShown) && dispPrice !== prevShown){
        const cls = dispPrice > prevShown ? 'flash-up' : 'flash-down';
        tile.classList.remove('flash-up','flash-down');
        // force reflow para reiniciar animação
        void tile.offsetWidth;
        tile.classList.add(cls);
  // som de blip por mudança de preço exibido
  const dir = dispPrice > prevShown ? 'up' : 'down';
  const intensity = Math.min(3, Math.abs((dispPrice - prevShown) / Math.max(1, prevShown)) * 10);
  if(canPlay(k)) blip(dir, intensity);
  const md = document.getElementById(`md-${k}`);
  if(md){ md.classList.remove('ping'); void md.offsetWidth; md.classList.add('ping'); }
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
    // Atualiza barra de humor do mercado (proporção verde x vermelho)
    if(moodBar){
      let up=0, down=0;
      for(const c of COINS){
        const st = S[c.pair];
        if(Number.isFinite(st.last) && Number.isFinite(st.prev)){
          if(st.last > st.prev) up++; else if(st.last < st.prev) down++;
        } else {
          // fallback: usa dir sticky
          if(st.dir === 'up') up++; else if(st.dir === 'down') down++;
        }
      }
      const total = up + down; const greenRatio = total ? (up/total) : 0.5;
      moodBar.style.setProperty('--mood', `${Math.round(greenRatio*100)}%`);
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
  function drawSpark(id, series){
    const el = document.getElementById(id); if(!el) return;
    const ctx = el.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    if(el._dpr !== dpr){ el._dpr = dpr; el.width = Math.floor(el.clientWidth*dpr); el.height = Math.floor(el.clientHeight*dpr); }
    const W = el.width, H = el.height; ctx.clearRect(0,0,W,H);

    // grid linhas sutis
    ctx.globalAlpha = .5; ctx.strokeStyle = 'rgba(255,255,255,.04)';
    const lines = 3; for(let i=1;i<=lines;i++){ const y = (H/(lines+1))*i; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
    ctx.globalAlpha = 1;
    if(!series || series.length<2){ return; }
    const min = Math.min(...series), max = Math.max(...series);
    const pad = 6*dpr;
    const scaleX = (i)=> pad + (W-2*pad) * (i/(series.length-1));
    const scaleY = (v)=>{ if(max===min) return H/2; return H - pad - ( (v - min) / (max - min) ) * (H - 2*pad); };

    const last = series[series.length-1], prev = series[series.length-2];
    const up = last >= prev;

    // curva suavizada (Catmull-Rom -> Bézier simplificada)
    const pts = series.map((v,i)=>({x:scaleX(i), y:scaleY(v)}));
    const tension = 0.5; // leve suavização
    function controlPoints(p0,p1,p2,p3,t){ const d01 = Math.hypot(p1.x-p0.x, p1.y-p0.y) || 1; const d12 = Math.hypot(p2.x-p1.x, p2.y-p1.y) || 1; const d23 = Math.hypot(p3.x-p2.x, p3.y-p2.y) || 1; const fa = t * d01 / (d01 + d12); const fb = t * d23 / (d12 + d23); const p1x = p1.x + fa * (p2.x - p0.x); const p1y = p1.y + fa * (p2.y - p0.y); const p2x = p2.x - fb * (p3.x - p1.x); const p2y = p2.y - fb * (p3.y - p1.y); return {cp1:{x:p1x,y:p1y}, cp2:{x:p2x,y:p2y}}; }

    // cor e brilho escalados pela intensidade
    const glow = Math.max(0.08, Math.min(0.45, (INTENSITY/100) * 0.35));
    const strokeCol = up ? `rgba(0,200,83,${0.95})` : `rgba(255,59,48,${0.95})`;
    const glowCol = up ? `rgba(0,200,83,${glow})` : `rgba(255,59,48,${glow})`;

    ctx.lineWidth = 2*dpr; ctx.strokeStyle = strokeCol; ctx.fillStyle = glowCol;

    // trilha de brilho suave
    ctx.save();
    ctx.shadowColor = glowCol; ctx.shadowBlur = 12 * (INTENSITY/100);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for(let i=0;i<pts.length-1;i++){
      const p0 = pts[Math.max(0, i-1)];
      const p1 = pts[i];
      const p2 = pts[i+1];
      const p3 = pts[Math.min(pts.length-1, i+2)];
      const {cp1, cp2} = controlPoints(p0,p1,p2,p3,tension);
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y);
    }
    ctx.stroke();
    ctx.restore();

    // preenchimento degradê sutil
    const g = ctx.createLinearGradient(0,0,0,H);
    g.addColorStop(0, up ? `rgba(0,200,83,${0.18 + glow*0.15})` : `rgba(255,59,48,${0.18 + glow*0.15})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.lineTo(W-pad, H-pad);
    ctx.lineTo(pad, H-pad);
    ctx.closePath();
    ctx.fill();

    // marcador do último ponto
    const lp = pts[pts.length-1];
    ctx.beginPath(); ctx.fillStyle = up ? 'rgba(0,200,83,0.9)' : 'rgba(255,59,48,0.9)';
    ctx.arc(lp.x, lp.y, 2.5*dpr, 0, Math.PI*2);
    ctx.fill();
  }

  // ===== Loop ================================================================
  async function cycle(){ NET_ERR = false; await fetchTickers(); await fetchOrderbookAndTrades(); render(); lastUpdate.textContent = new Date().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit', second:'2-digit'}); setNet(!NET_ERR); cycleCount++; }
  let _cycleTimer = null; let _isRunning = false; function nextDelay(){ return document.hidden ? REFRESH_HIDDEN_MS : REFRESH_MS; } function scheduleNext(ms){ if(_cycleTimer) clearTimeout(_cycleTimer); _cycleTimer = setTimeout(runCycle, ms); _nextTickAt = Date.now() + ms; }
  async function runCycle(){ if(_isRunning){ scheduleNext(250); return; } _isRunning = true; try{ await cycle(); } catch(e){ console.error('cycle erro:', e); } finally{ try{ if((cycleCount % 2) === 1){ await fetchBinanceLight(); render(); } }catch(e){ console.error('binance erro:', e); } _isRunning = false; scheduleNext(nextDelay()); } }
  runCycle(); requestAnimationFrame(()=>{ TAPE_START_TS = performance.now(); tuneTickerSpeed(true); });
  // live countdown to next refresh
  let _nextTickAt = Date.now() + nextDelay();
  (function updateCountdown(){
    const now = Date.now(); const ms = Math.max(0, _nextTickAt - now); const s = Math.ceil(ms/1000);
    if(nextInEl){ nextInEl.textContent = `${s}s`; nextInEl.style.color = s <= 3 ? 'var(--down)' : s <= 10 ? 'var(--accent)' : 'var(--muted)'; }
    requestAnimationFrame(updateCountdown);
  })();

  const brFmt = new Intl.DateTimeFormat('pt-BR', { timeZone:'America/Sao_Paulo', hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  function tickClock(){ if(brClock) brClock.textContent = `Brasília: ${brFmt.format(new Date())}`; }
  tickClock(); setInterval(tickClock, 1000);

  async function fetchWeatherAll(){ const BATCH = 3; for(let i=0;i<WEATHER_CITIES.length;i+=BATCH){ const batch = WEATHER_CITIES.slice(i, i+BATCH); await Promise.all(batch.map(async c => { try{ const data = await getJSON(ENDPOINTS_WEATHER.CURRENT(c.lat, c.lon)); const temp = Number(data?.current_weather?.temperature); if(Number.isFinite(temp)){ WEA[c.key].temp = temp; WEA[c.key].at = Date.now(); } }catch{} })); await sleep(200); } renderWeatherBox(); }
  fetchWeatherAll(); setInterval(fetchWeatherAll, WEATHER_REFRESH_MS);
  let WEATHER_IDX = 0; const WEATHER_ROTATE_MS = 60_000; function renderWeatherBox(){ if(!brWeather) return; const city = WEATHER_CITIES[WEATHER_IDX % WEATHER_CITIES.length]; const rec = WEA[city.key]; const t = Number(rec?.temp); const tStr = Number.isFinite(t) ? `${Math.round(t)}°C` : '—°C'; brWeather.innerHTML = `<span class="wx-city">${city.name}</span><span class="wx-temp">${tStr}</span>`; }
  function rotateCity(){ WEATHER_IDX = (WEATHER_IDX + 1) % WEATHER_CITIES.length; renderWeatherBox(); }
  renderWeatherBox(); setInterval(rotateCity, WEATHER_ROTATE_MS);
  document.addEventListener('visibilitychange', () => { if(!document.hidden){ FETCH_TRADES_EVERY = computeTradesEvery(REFRESH_MS); } pauseTape(); scheduleNext(250); setTimeout(()=>{ tuneTickerSpeed(true); }, 150); });
  // Atalho de teclado para som (S)
  document.addEventListener('keydown', async (e)=>{ const key = (e.key||'').toLowerCase(); if(key==='s'){ await ensureAudio(); toggleSound(); } });

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
  if('serviceWorker' in navigator){
    window.addEventListener('load', async () => {
      try{
        const reg = await navigator.serviceWorker.register('./sw.js');
        // Ask current controller to warmup cache with fresh assets
        if(navigator.serviceWorker.controller){ navigator.serviceWorker.controller.postMessage({ type:'warmup' }); }
        // Also request an update check proactively
        if(reg && reg.update){ try{ reg.update(); }catch{} }
        // Show update banner when a new SW is waiting
        function showUpdate(){ if(updateBanner) updateBanner.hidden = false; }
        function hideUpdate(){ if(updateBanner) updateBanner.hidden = true; }
        if(reg){
          if(reg.waiting){ showUpdate(); }
          reg.addEventListener('updatefound', () => {
            const nw = reg.installing;
            if(!nw) return;
            nw.addEventListener('statechange', () => {
              if(nw.state === 'installed' && reg.waiting){ showUpdate(); }
            });
          });
        }
        // On click, tell waiting worker to activate immediately
        if(ubReload){ ubReload.addEventListener('click', () => {
          try{ if(reg && reg.waiting){ reg.waiting.postMessage({ type:'SKIP_WAITING' }); } }catch{}
        }); }
        if(ubLater){ ubLater.addEventListener('click', () => hideUpdate()); }
        // When controller changes, reload to pick the fresh version
        navigator.serviceWorker.addEventListener('controllerchange', () => { window.location.reload(); });
      }catch{}
    });
  }

  // ===== Erros globais =======================================================
  window.addEventListener('unhandledrejection', (e)=>{ NET_ERR = true; setNet(false); recordError(e.reason || e); renderDiag(); chimeError(); });
  window.addEventListener('error', (e)=>{ /* opcional: recordError(e.error || e.message) */ });
})();

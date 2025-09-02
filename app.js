(() => {
  const APP_VERSION = 'v0.0.11';
  // ===== CONFIG ==============================================================
  const REFRESH_MS = 35_000; // 35 segundos
  const REFRESH_HIDDEN_MS = 90_000; // reduzir consumo quando aba estiver oculta
  const MAX_POINTS = 360;    // ~3.5h de histórico
  const TARGET_MAX_REQ_PER_MIN = 28; // margem de segurança sob 30/min
  // Janelas do gráfico (aprox.; 24h exibirá o máximo disponível)
  const RANGE_MS = { '1h': 1*60*60*1000, '4h': 4*60*60*1000, '24h': 24*60*60*1000 };
  let RANGE_CUR = (()=>{ try{ return localStorage.getItem('wstv_range') || '1h'; }catch{ return '1h'; } })();
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
  // Tri-source: CoinGecko (preço), Bitstamp (USD: ticker/orderbook/trades), FX (USD->BRL)
  const ENDPOINTS_CG = {
    SIMPLE_PRICE: (ids, vs) => `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}&include_24hr_change=true`,
  };
  const ENDPOINTS_BS = {
    TICKER:     (pairUSD) => `https://www.bitstamp.net/api/v2/ticker/${pairUSD}/`,
    ORDERBOOK:  (pairUSD) => `https://www.bitstamp.net/api/v2/order_book/${pairUSD}/`,
    TRADES:     (pairUSD, range='hour') => `https://www.bitstamp.net/api/v2/transactions/${pairUSD}/?time=${range}`,
  };
  const ENDPOINTS_FX = {
    USDBRL: () => `https://api.exchangerate.host/latest?base=USD&symbols=BRL`,
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
  const STALE_TRADE_MS = 3 * REFRESH_MS; // após isso, considerar última negociação desatualizada
  // ===== Simple AI helpers (local-only) =====================================
  const SENTI = {
    pos: ['alta','subida','ganho','otimista','otimismo','recorde','acelera','cresce','bull','rali','rally','expande','positivo','forte','avança','saltou','salta','dispara'],
    neg: ['queda','cai','perda','pessimista','pessimismo','crise','desacelera','despenca','bear','colapso','recua','negativo','fraco','recuo','derrete','desaba','despencou']
  };
  function scoreSentiment(text){
    try{
      if(!text) return 0;
      const t = String(text).toLowerCase(); let s=0;
      for(const w of SENTI.pos) if(t.includes(w)) s++;
      for(const w of SENTI.neg) if(t.includes(w)) s--;
      return Math.max(-3, Math.min(3, s));
    }catch{ return 0; }
  }
  function zscore(arr){
    try{
      const xs = arr.filter(Number.isFinite);
      const n = xs.length; if(n<3) return 0;
      const mean = xs.reduce((a,b)=>a+b,0)/n;
      const varr = xs.reduce((a,b)=> a + (b-mean)*(b-mean), 0)/n;
      const sd = Math.sqrt(varr) || 1;
      const last = xs[xs.length-1];
      return (last - mean)/sd;
    }catch{ return 0; }
  }
  function pct(a,b){ if(!Number.isFinite(a) || !Number.isFinite(b) || b===0) return NaN; return (a-b)/b*100; }

  // ===== Preconnect condicional (economia móvel) ============================
  const PRECONNECT = { last:new Map(), cooldownMs: 5*60*1000 };
  const ALLOWED_PRECONNECT = new Set([
    'https://api.bitpreco.com',
    'https://api.binance.com',
    'https://api.coingecko.com',
    'https://www.bitstamp.net',
    'https://api.exchangerate.host',
  'https://api.open-meteo.com',
  'https://api.allorigins.win'
  ]);
  function maybePreconnect(url){
    let origin;
    try{ origin = new URL(url, location.href).origin; }catch{ return; }
    if(!ALLOWED_PRECONNECT.has(origin)) return;
    const now = Date.now();
    const last = PRECONNECT.last.get(origin) || 0;
    if((now - last) < PRECONNECT.cooldownMs) return;
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const save = !!(conn && conn.saveData);
    const down = (conn && typeof conn.downlink === 'number') ? conn.downlink : null;
    // Heurística: respeitar economia de dados e redes muito lentas
    if(save) return;
    if(down != null && down < 1.2) return; // ~3G/slow
    // Inserir hints se ainda não existirem
    try{
      if(!document.querySelector(`link[rel="preconnect"][href="${origin}"]`)){
        const l = document.createElement('link'); l.rel='preconnect'; l.href=origin; l.crossOrigin='anonymous'; document.head.appendChild(l);
      }
      if(!document.querySelector(`link[rel="dns-prefetch"][href="${origin}"]`)){
        const d = document.createElement('link'); d.rel='dns-prefetch'; d.href=origin; document.head.appendChild(d);
      }
      PRECONNECT.last.set(origin, now);
    }catch{ /* ignore */ }
  }

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
  trade:null, history:[], histTS:[], lastAt:null,
    alt:{ last:null, bid:null, ask:null, at:null }, // Binance
    cg:{ last:null, at:null },                      // CoinGecko
    bs:{ last:null, bid:null, ask:null, at:null },  // Bitstamp (USD->BRL)
    _histAt:null,
    dir:'flat', // direção de cor do blink no card (up/down/flat)
    _dispLast:null, // último preço exibido (após choosePrice)
    aud: !!AUD_PREFS[c.pair],
    pd:null,
    _zArr:[]
  }])) ;
  // FX cache (para conversões USD->BRL via BS/Kraken, etc.)
  const FX = { usdtbrl:null, usdtbrlAt:0, usdbrl:null, usdbrlAt:0 };
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
  const rg1 = document.getElementById('rg-1h');
  const rg4 = document.getElementById('rg-4h');
  const rg24 = document.getElementById('rg-24h');
  const chartTip = document.getElementById('chartTip');
  const marketsBtn = document.getElementById('marketsBtn');
  // Install banner elements
  const installBanner = document.getElementById('installBanner');
  const ibInstall = document.getElementById('ibInstall');
  const ibDismiss = document.getElementById('ibDismiss');
  // Update banner elements
  const updateBanner = document.getElementById('updateBanner');
  const ubReload = document.getElementById('ubReload');
  const ubLater = document.getElementById('ubLater');
  // iOS install modal
  const iosModal = document.getElementById('iosInstall');
  const iosClose = document.getElementById('iosClose');

  intervalText.textContent = Math.round(REFRESH_MS/1000)+"s";
  if(versionBadge) versionBadge.textContent = APP_VERSION;
  if(diagPersist){ diagPersist.checked = !!PERSIST; diagPersist.addEventListener('change', ()=>{ PERSIST = !!diagPersist.checked; if(!PERSIST) try{ localStorage.removeItem('wstv_diag'); }catch{} else saveDiag(); }); }

  // Intensidade visual (0-100) influencia brilhos/tempos sutis
  let INTENSITY = 70;
  try{ const v = Number(localStorage.getItem('wstv_intensity')); if(Number.isFinite(v)) INTENSITY = Math.max(0, Math.min(100, v)); }catch{}
  function applyIntensity(){ const root = document.documentElement; root.style.setProperty('--intensity', String(INTENSITY)); }
  applyIntensity();
  if(intensityInput){ intensityInput.value = String(INTENSITY); intensityInput.addEventListener('input', ()=>{ const v = Number(intensityInput.value); INTENSITY = Math.max(0, Math.min(100, v)); applyIntensity(); try{ localStorage.setItem('wstv_intensity', String(INTENSITY)); }catch{} }); }

  // Navegação para página de mercados
  if(marketsBtn){ marketsBtn.addEventListener('click', ()=>{ try{ window.location.href = './markets.html'; }catch{ location.assign('./markets.html'); } }); }

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
  const FORCE_INSTALL = (()=>{
    try{
      const params = new URLSearchParams(location.search);
      if(params.has('install')) return true;
      const ls = localStorage.getItem('wstv_install_force');
      return ls === '1';
    }catch{ return false; }
  })();
  let deferredPrompt = null;
  function shouldShowInstallBanner(){
    // Mostrar sempre que não estiver instalado (sem janela de 1h)
    if(isInstalledContext()) return false;
    return true;
  }
  function markSnooze(){ /* snooze desativado */ }
  function showInstallBanner(){ if(!installBanner) return; installBanner.hidden = false; }
  function hideInstallBanner(){ if(!installBanner) return; installBanner.hidden = true; }

  window.addEventListener('beforeinstallprompt', (e)=>{
    // Previna prompt automático; guardamos para disparar via banner
    e.preventDefault(); deferredPrompt = e; if(shouldShowInstallBanner()) showInstallBanner();
  });
  window.addEventListener('appinstalled', ()=>{ try{ localStorage.setItem(LS_KEYS.installed,'1'); }catch{} hideInstallBanner(); });
  // Se o navegador não disparar beforeinstallprompt (ex: iOS), ainda assim ofereça se não instalado
  document.addEventListener('DOMContentLoaded', ()=>{
    setTimeout(()=>{
      // Se não houver deferredPrompt, ainda assim ofereça o banner com instruções (iOS/desktop)
      if(shouldShowInstallBanner()) showInstallBanner();
    }, 1200);
  });

  function isIOS(){ return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function showIOS(){ if(iosModal) iosModal.hidden = false; }
  function hideIOS(){ if(iosModal) iosModal.hidden = true; }
  if(iosClose){ iosClose.addEventListener('click', hideIOS); }
  if(ibInstall){ ibInstall.addEventListener('click', async ()=>{
    if(deferredPrompt && deferredPrompt.prompt){ try{ deferredPrompt.prompt(); const choice = await deferredPrompt.userChoice; if(choice && choice.outcome === 'accepted'){ hideInstallBanner(); try{ localStorage.setItem(LS_KEYS.installed,'1'); }catch{} } else { markSnooze(); hideInstallBanner(); } }catch{ markSnooze(); hideInstallBanner(); } finally { deferredPrompt = null; } }
    else {
      // Sem beforeinstallprompt (iOS Safari / desktop não suportado): mostrar instruções em tooltip simples
  hideInstallBanner();
      if(isIOS()){ showIOS(); return; }
      try{
        const msg = 'Para instalar: use “Adicionar à Tela de Início” no menu do navegador.';
        ibInstall.title = msg; ibInstall.blur();
      }catch{}
    }
  }); }
  if(ibDismiss){ ibDismiss.addEventListener('click', ()=>{ hideInstallBanner(); }); }

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
    tile.className = 'tile clickable';
    tile.innerHTML = `
      <div class="row">
        <div class="id">
          <div class="ticker">${c.symbol}</div>
          <span class="trend" id="ar-${c.pair}" aria-hidden="true">●</span>
          <div class="pair pair-inline">${c.label}</div>
          <span class="mini-dot" id="md-${c.pair}" aria-hidden="true"></span>
        </div>
        <div class="row row-tight align-end">
          <div class="price" id="p-${c.pair}" aria-live="polite" aria-atomic="true" aria-label="Preço atual">—</div>
          <div class="delta" id="d-${c.pair}">—</div>
        </div>
      </div>
      ${c.pair==='usdt-brl' ? `
      <div class="usdt-news" id="news-${c.pair}">
        <div class="headline multi">
          <div class="hcol">
            <div class="source" id="news-src-pt-${c.pair}">—</div>
            <div class="title" id="news-ttl-pt-${c.pair}">—</div>
          </div>
          <div class="hcol">
            <div class="source" id="news-src-int1-${c.pair}">—</div>
            <div class="title" id="news-ttl-int1-${c.pair}">—</div>
          </div>
          <div class="hcol">
            <div class="source" id="news-src-int2-${c.pair}">—</div>
            <div class="title" id="news-ttl-int2-${c.pair}">—</div>
          </div>
        </div>
      </div>` : ''}
      <div class="kpis">
        <div class="kpi"><div class="label">Alta 24h</div><div class="value" id="hi-${c.pair}">—</div></div>
        <div class="kpi"><div class="label">Baixa 24h</div><div class="value" id="lo-${c.pair}">—</div></div>
        <div class="kpi"><div class="label">Volume 24h</div><div class="value" id="vo-${c.pair}">—</div></div>
      </div>
      <div class="book">
        <div class="kpi"><div class="label">L1 BID</div><div class="value" id="bid-${c.pair}">—</div></div>
        <div class="kpi"><div class="label">L1 ASK</div><div class="value" id="ask-${c.pair}">—</div></div>
        <div class="kpi"><div class="label">Spread</div><div class="value" id="spu-${c.pair}">—</div></div>
      </div>
      <div class="pd-line">
        <div class="label">Prêmio/Desconto (BP vs alt)</div>
        <div class="value" id="pd-${c.pair}">—</div>
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
        <div class="pair pair-foot">${c.label}</div>
        <div class="aud-controls">
          ${c.pair==='usdt-brl' ? `<button class="news-toggle" id="newsOnly-${c.pair}" aria-pressed="false" title="Exibir apenas manchetes">📰 Só manchetes</button>` : ''}
          <button class="aud-btn" id="au-${c.pair}" aria-pressed="${S[c.pair].aud? 'true':'false'}" title="Ativar som para ${c.symbol}">${S[c.pair].aud ? '🔊' : '🔇'}</button>
          <button class="solo-btn" id="so-${c.pair}" aria-pressed="${AUD_SOLO===c.pair? 'true':'false'}" title="Solo: ouvir apenas ${c.symbol}">🎧</button>
        </div>
      </div>
    `;
    grid.appendChild(tile);
  tiles[c.pair] = tile;
    // Navegação para gráfico detalhado ao clicar no card
    tile.addEventListener('click', ()=>{ try{ window.location.href = `./chart.html?pair=${encodeURIComponent(c.pair)}`; }catch{ location.assign(`./chart.html?pair=${encodeURIComponent(c.pair)}`); } });
    // Listener do botão de áudio por ativo
    const btn = tile.querySelector(`#au-${c.pair}`);
    if(btn){
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
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
      soloBtn.addEventListener('click', (e)=>{
        e.stopPropagation();
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
    // News-only toggle (USDT)
    if(c.pair==='usdt-brl'){
      const btnNews = tile.querySelector(`#newsOnly-${c.pair}`);
      if(btnNews){
        btnNews.addEventListener('click', (e)=>{
          e.stopPropagation();
          NEWS.only = !NEWS.only;
          btnNews.setAttribute('aria-pressed', String(!!NEWS.only));
          btnNews.textContent = NEWS.only ? '📺 Voltar ao mercado' : '📰 Só manchetes';
          if(NEWS.only){ USDT_NEWS_MODE = true; scheduleNewsOnlyTick(); }
          else { if(_newsOnlyTimer) clearTimeout(_newsOnlyTimer); }
          render();
        });
      }
    }
  });

  // ===== News aggregator (10 free public RSS endpoints via AllOrigins) =====
  // 3 brasileiras + 7 internacionais
  const NEWS_SOURCES = [
    // Brasil
    { name:'G1 Economia', url:'https://g1.globo.com/economia/rss2.xml', lang:'pt' },
    { name:'Estadão Economia', url:'https://economia.estadao.com.br/rss', lang:'pt' },
    { name:'Valor Investe', url:'https://valorinveste.globo.com/rss/ultimas/feed.xml', lang:'pt' },
    // Global
    { name:'Reuters Business', url:'https://feeds.reuters.com/reuters/businessNews', lang:'en' },
    { name:'Bloomberg Markets', url:'https://www.bloomberg.com/feeds/podcasts/etf-report.xml', lang:'en' },
    { name:'Financial Times', url:'https://www.ft.com/world/us/rss', lang:'en' },
    { name:'BBC Business', url:'https://feeds.bbci.co.uk/news/business/rss.xml', lang:'en' },
    { name:'CNBC Top', url:'https://www.cnbc.com/id/100003114/device/rss/rss.html', lang:'en' },
    { name:'Yahoo Finance', url:'https://finance.yahoo.com/news/rss', lang:'en' },
    { name:'Investing.com', url:'https://www.investing.com/rss/news_25.rss', lang:'en' }
  ];
  const NEWS = { items: [], idx: 0, lastAt: 0, ttl: 10*60*1000, only:false };
  function buildAllOriginsUrl(feed){ return `https://api.allorigins.win/get?url=${encodeURIComponent(feed)}`; }
  async function fetchRSS(feed){
    const url = buildAllOriginsUrl(feed);
    const j = await getJSON(url);
    const xml = j?.contents || '';
    if(!xml) return [];
    try{
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const items = Array.from(doc.querySelectorAll('item'));
      if(items.length){
        return items.slice(0, 5).map(n => ({
          title: (n.querySelector('title')?.textContent || '').trim(),
          link: (n.querySelector('link')?.textContent || '').trim()
        })).filter(it => it.title);
      }
      // Atom fallback
      const entries = Array.from(doc.querySelectorAll('entry'));
      return entries.slice(0, 5).map(n => ({
        title: (n.querySelector('title')?.textContent || '').trim(),
        link: (n.querySelector('link')?.getAttribute('href') || '').trim()
      })).filter(it => it.title);
    }catch{ return []; }
  }
  async function refreshNews(){
    const now = Date.now(); if((now - NEWS.lastAt) < NEWS.ttl && NEWS.items.length) return;
    const all = [];
    for(const src of NEWS_SOURCES){
      try{
        const arr = await fetchRSS(src.url);
        for(const it of arr){ all.push({ source: src.name, title: it.title, link: it.link, lang: src.lang || 'en' }); }
      }catch{}
      await sleep(120);
    }
    if(all.length){ NEWS.items = all; NEWS.lastAt = Date.now(); NEWS.idx = 0; }
  }

  // Alternância USDT: 35s normal, 35s manchete; se "só manchetes" estiver ativo, fixa news-mode e gira headlines a cada 1 minuto
  let USDT_NEWS_MODE = false; let _altTimer = null; let _newsOnlyTimer = null;
  const NEWS_ONLY_REFRESH_MS = 60_000;
  function scheduleUSDTAlternate(){
    if(_altTimer) clearTimeout(_altTimer);
    _altTimer = setTimeout(()=>{
      if(!NEWS.only){ USDT_NEWS_MODE = !USDT_NEWS_MODE; }
      render();
      scheduleUSDTAlternate();
    }, REFRESH_MS);
  }
  function scheduleNewsOnlyTick(){
    if(_newsOnlyTimer) clearTimeout(_newsOnlyTimer);
    if(!NEWS.only) return;
    _newsOnlyTimer = setTimeout(async ()=>{
      try{ await refreshNews(); }catch{}
      render();
      scheduleNewsOnlyTick();
    }, NEWS_ONLY_REFRESH_MS);
  }
  scheduleUSDTAlternate();
  function canPlay(pair){ if(!SOUND.enabled) return false; if(AUD_SOLO){ return AUD_SOLO === pair; } return !!S[pair].aud; }

  // ===== Fetchers com timeout ==============================================
  async function getJSON(url){
    let attempt = 0; let delay = 500;
    while(true){
      try{
  if(attempt === 0){ maybePreconnect(url); }
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

  // ===== FX helpers (com cache) ============================================
  const FX_TTL = 10*60*1000; // 10 min
  async function getUSDTBRL(){
    const now = Date.now(); if(FX.usdtbrl && (now - FX.usdtbrlAt) < FX_TTL) return FX.usdtbrl;
    // Fonte 1: Binance USDTBRL
    try{
      const j = await getJSON(ENDPOINTS_BINANCE.PRICE('USDTBRL')); const v = Number(j?.price);
      if(Number.isFinite(v)){ FX.usdtbrl=v; FX.usdtbrlAt=now; return v; }
    }catch{}
    // Fonte 2: BitPreço USDT-BRL ticker
    try{
      const j = await getJSON(ENDPOINTS.TICKER('usdt-brl')); const v = Number(j?.last ?? j?.price);
      if(Number.isFinite(v)){ FX.usdtbrl=v; FX.usdtbrlAt=now; return v; }
    }catch{}
    // Fonte 3: USD->BRL (assumindo USDT≈USD)
    const usdbrl = await getUSDBRL(); if(Number.isFinite(usdbrl)){ FX.usdtbrl=usdbrl; FX.usdtbrlAt=Date.now(); return usdbrl; }
    return NaN;
  }
  async function getUSDBRL(){
    const now = Date.now(); if(FX.usdbrl && (now - FX.usdbrlAt) < FX_TTL) return FX.usdbrl;
    // Fonte 1: Exchangerate.host
    try{
      const j = await getJSON(ENDPOINTS_FX.USDBRL()); const v = Number(j?.rates?.BRL);
      if(Number.isFinite(v)){ FX.usdbrl=v; FX.usdbrlAt=now; return v; }
    }catch{}
    // Fonte 2: derivado de USDTBRL
    try{
      const usdt = await getJSON(ENDPOINTS_BINANCE.PRICE('USDTBRL')); const v = Number(usdt?.price);
      if(Number.isFinite(v)){ FX.usdbrl=v; FX.usdbrlAt=Date.now(); return v; }
    }catch{}
    // Fonte 3: BitPreço USDT-BRL
    try{
      const j = await getJSON(ENDPOINTS.TICKER('usdt-brl')); const v = Number(j?.last ?? j?.price);
      if(Number.isFinite(v)){ FX.usdbrl=v; FX.usdbrlAt=Date.now(); return v; }
    }catch{}
    return NaN;
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
  st.statAt = st.lastAt;
    if(Number.isFinite(st.last) && st.last > 0){ maybePushHistory(st, st.last); }
  }

  function maybePushHistory(st, price){
    const now = Date.now(); const MIN_GAP = 10_000;
    if(st._histAt && (now - st._histAt) < MIN_GAP) return;
  st._histAt = now; st.history.push(price); st.histTS.push(now);
  if(st.history.length > MAX_POINTS){ st.history.shift(); st.histTS.shift(); }
  }

  let cycleCount = 0; let FETCH_TRADES_EVERY = computeTradesEvery(REFRESH_MS);
  async function fetchOrderbookAndTrades(){
    const baseAllowTrades = !document.hidden && ((cycleCount % FETCH_TRADES_EVERY) === 0);
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
          S[pair].bid = bid; S[pair].ask = ask; S[pair].spread = (bid && ask) ? (ask - bid) : null; S[pair]._l1At = Date.now();
        }catch(e){ console.error('orderbook falhou', pair, e); NET_ERR = true; }
        // Revalidar trades quando agendado ou se o último registro estiver velho
        try{
          const tr = S[pair].trade;
          const trTs = tr && tr.timestamp ? (typeof tr.timestamp === 'number' ? tr.timestamp : (new Date(tr.timestamp).getTime() || 0)) : 0;
          const isStale = !Number.isFinite(trTs) || (Date.now() - trTs) > STALE_TRADE_MS;
          if(baseAllowTrades || isStale){
            try{ S[pair].trade = await fetchTradeTri(pair); }
            catch(e){ console.error('trades tri falhou', pair, e); NET_ERR = true; }
          }
        }catch(e){ /* ignore */ }
      }));
      await sleep(200);
    }
  }

  // Tri-source trades: BitPreço -> Binance -> Bitstamp(USD->BRL)
  async function fetchTradeTri(pair){
    // 1) BitPreço
    try{
      const tr = await getJSON(ENDPOINTS.TRADES(pair));
      const last = Array.isArray(tr) && tr.length ? tr.reduce((a,b)=> new Date(b.timestamp) > new Date(a.timestamp) ? b : a) : null;
      if(last) return last;
    }catch{}
    // 2) Binance (sem lado explícito)
    try{
      const sym = BINANCE_SYMBOLS[pair]; if(sym){
        const arr = await getJSON(`https://api.binance.com/api/v3/trades?symbol=${sym}&limit=1`);
        const t = Array.isArray(arr) && arr[0] ? arr[0] : null;
        if(t){ return { type:'', amount: Number(t.qty), price: Number(t.price), timestamp: t.time } }
      }
    }catch{}
    // 3) Bitstamp (USD -> BRL)
    try{
      const sym = BS_MAP[pair]; if(sym){
        const usdbrl = await getUSDBRL(); if(!Number.isFinite(usdbrl)) throw new Error('no FX');
        const arr = await getJSON(ENDPOINTS_BS.TRADES(sym, 'hour'));
        const t = Array.isArray(arr) && arr[0] ? arr[0] : null;
        if(t){
          const priceBRL = Number(t.price) * usdbrl; const amt = Number(t.amount);
          const ts = (t.date ? Number(t.date)*1000 : Date.now());
          return { type: t.type==="0"? 'BUY' : t.type==="1"? 'SELL' : '', amount: amt, price: priceBRL, timestamp: ts };
        }
      }
    }catch{}
    return null;
  }

  function computeTradesEvery(baseMs){
    const N = COINS.length; const cpm = 60_000 / baseMs; const baseline = cpm * (1 + N); const budget = TARGET_MAX_REQ_PER_MIN - baseline;
    if (budget <= 0) return 9999; const freq = Math.ceil((cpm * N) / budget); return Math.max(1, Math.min(10, freq));
  }

  // ===== Binance leve ========================================================
  const BINANCE_SYMBOLS = Object.fromEntries(COINS.map(c=>{ const s = c.pair.toUpperCase().replace(/-/g,''); return [c.pair, s]; }));
  const BINANCE_AUX = { DASH_USDT: 'DASHUSDT', USDT_BRL: 'USDTBRL' };
  ENDPOINTS_BINANCE.TICKER_24HR = (symbol) => `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;

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

  // ===== 24h stats (tri-source) ============================================
  const B24_EVERY = 6; // ~3.5min
  async function fetchBinance24h(){
    const BATCH = 4;
    for(let i=0;i<COINS.length;i+=BATCH){
      const batch = COINS.slice(i, i+BATCH);
      await Promise.all(batch.map(async c => {
        const sym = BINANCE_SYMBOLS[c.pair]; if(!sym) return;
        try{
          const r = await getJSON(ENDPOINTS_BINANCE.TICKER_24HR(sym));
          const st = S[c.pair];
          st.bin24 = st.bin24 || {};
          st.bin24.high = Number(r?.highPrice ?? NaN);
          st.bin24.low  = Number(r?.lowPrice ?? NaN);
          st.bin24.vol  = Number(r?.volume ?? NaN);
          st.bin24.at   = Date.now();
        }catch{}
      }));
      await sleep(160);
    }
  }

  async function fetchCoinGeckoMarkets(){
    const ids = Object.values(CG_IDS).join(',');
    try{
      // coins/markets exige vs_currency e ids; page única cobre nossos 10 ativos
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=brl&ids=${ids}&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h`;
      const data = await getJSON(url);
      const now = Date.now();
      for(const rec of (Array.isArray(data)? data : [])){
        const id = rec?.id; if(!id) continue;
        const pair = Object.keys(CG_IDS).find(k => CG_IDS[k]===id); if(!pair) continue;
        const st = S[pair]; st.cg24 = st.cg24 || {};
        st.cg24.high = Number(rec?.high_24h ?? NaN);
        st.cg24.low  = Number(rec?.low_24h ?? NaN);
        st.cg24.vol  = Number(rec?.total_volume ?? NaN);
        st.cg24.at   = now;
      }
    }catch(e){ recordError(e); }
  }

  function chooseStats(st){
    const now = Date.now(); const freshMs = 4 * REFRESH_MS;
    // fontes: bitpreco (st.high/low/vol + st.statAt), binance (st.bin24), cg (st.cg24)
    const cand = [];
    if(Number.isFinite(st.high) || Number.isFinite(st.low) || Number.isFinite(st.vol)) cand.push({src:'bp', at: st.statAt||0, hi:st.high, lo:st.low, vo:st.vol});
    if(st.bin24 && st.bin24.at && (now - st.bin24.at) < (6*REFRESH_MS)) cand.push({src:'bn', at: st.bin24.at, hi:st.bin24.high, lo:st.bin24.low, vo:st.bin24.vol});
    if(st.cg24 && st.cg24.at && (now - st.cg24.at) < (10*REFRESH_MS)) cand.push({src:'cg', at: st.cg24.at, hi:st.cg24.high, lo:st.cg24.low, vo:st.cg24.vol});
    if(!cand.length) return { hi: st.high, lo: st.low, vo: st.vol };
    cand.sort((a,b)=> b.at - a.at);
    const best = cand[0];
    return { hi: best.hi, lo: best.lo, vo: best.vo };
  }

  // ===== CoinGecko (preço BRL) =============================================
  const CG_IDS = {
    'btc-brl':'bitcoin', 'eth-brl':'ethereum', 'bnb-brl':'binancecoin', 'dash-brl':'dash',
    'usdt-brl':'tether', 'usdc-brl':'usd-coin', 'sol-brl':'solana', 'ada-brl':'cardano',
    'xrp-brl':'ripple', 'doge-brl':'dogecoin'
  };
  const CG_EVERY = 3; // a cada 3 ciclos (~105s)
  async function fetchCoinGeckoBatch(){
    const ids = Object.values(CG_IDS).join(',');
    try{
      const data = await getJSON(ENDPOINTS_CG.SIMPLE_PRICE(ids, 'brl,usd'));
      const now = Date.now();
      for(const c of COINS){
        const id = CG_IDS[c.pair]; if(!id) continue; const rec = data?.[id];
        const lastBRL = Number(rec?.brl ?? NaN);
        if(Number.isFinite(lastBRL)){
          const st = S[c.pair]; st.cg.last = lastBRL; st.cg.at = now; maybePushHistory(st, lastBRL);
        }
      }
    }catch(e){ recordError(e); }
  }

  // ===== Bitstamp leve (USD -> BRL) ========================================
  const BS_MAP = {
    'btc-brl':'btcusd', 'eth-brl':'ethusd', 'xrp-brl':'xrpusd', 'ada-brl':'adausd',
    'sol-brl':'solusd', 'doge-brl':'dogeusd', 'dash-brl':'dashusd'
    // Observação: Bitstamp pode não ter todos os pares; erros serão ignorados
  };
  const BS_EVERY = 6; // ~3.5min
  async function fetchBitstampLight(){
    const usdbrl = await getUSDBRL(); if(!Number.isFinite(usdbrl)) return; // sem FX confiável, skip
    const BATCH = 3;
    for(let i=0;i<COINS.length;i+=BATCH){
      const batch = COINS.slice(i, i+BATCH);
      await Promise.all(batch.map(async c => {
        const sym = BS_MAP[c.pair]; if(!sym) return;
        try{
          const tk = await getJSON(ENDPOINTS_BS.TICKER(sym));
          const lastUSD = Number(tk?.last ?? tk?.last_price ?? NaN);
          if(Number.isFinite(lastUSD)){
            const lastBRL = lastUSD * usdbrl; const st = S[c.pair]; st.bs.last = lastBRL; st.bs.at = Date.now(); maybePushHistory(st, lastBRL);
          }
        }catch{}
        try{
          const ob = await getJSON(ENDPOINTS_BS.ORDERBOOK(sym));
          const bestBid = ob?.bids && ob.bids[0] ? Number(ob.bids[0][0]) : NaN;
          const bestAsk = ob?.asks && ob.asks[0] ? Number(ob.asks[0][0]) : NaN;
          const st = S[c.pair];
          if(Number.isFinite(bestBid)) st.bs.bid = bestBid * usdbrl;
          if(Number.isFinite(bestAsk)) st.bs.ask = bestAsk * usdbrl;
          if(Number.isFinite(st.bs.bid) && Number.isFinite(st.bs.ask)) st.bs.at = Date.now();
        }catch{}
      }));
      await sleep(180);
    }
  }

  // ===== Render ==============================================================
  function render(){
    buildTape();
    const GUARD_MS = 280; const now = performance.now(); const elapsed = (now - TAPE_START_TS) / 1000; const remMs = (TAPE_SECONDS - (elapsed % TAPE_SECONDS)) * 1000; const safeUpdate = () => { _tapeUpdateTimer = null; updateTape(); };
    if(remMs < GUARD_MS){ if(!_tapeUpdateTimer){ _tapeUpdateTimer = setTimeout(safeUpdate, Math.max(30, remMs + 30)); } } else { updateTape(); }
    for(const c of COINS){
      const k = c.pair, st = S[k];
      const isUSDT = (k === 'usdt-brl');
      if(isUSDT){
        const tile = tiles[k];
        if(tile){ if(USDT_NEWS_MODE || NEWS.only){ tile.classList.add('usdt-news-mode'); } else { tile.classList.remove('usdt-news-mode'); } }
      }
  if(isUSDT && (USDT_NEWS_MODE || NEWS.only)){
        // Render 3 headlines: 1 PT + 2 international rotating
        const pick = () => {
          const items = NEWS.items || [];
          if(!items.length) return { pt:null, int1:null, int2:null };
          const ptItems = items.filter(i => (i.lang||'en') === 'pt');
          const intItems = items.filter(i => (i.lang||'en') !== 'pt');
          const pt = ptItems.length ? ptItems[(NEWS.idx) % ptItems.length] : null;
          const int1 = intItems.length ? intItems[(NEWS.idx) % intItems.length] : null;
          const int2 = intItems.length ? intItems[(NEWS.idx + 1) % intItems.length] : null;
          NEWS.idx = (NEWS.idx + 1) % Math.max(1, items.length);
          return { pt, int1, int2 };
        };
  const { pt, int1, int2 } = pick();
        const nWrap = document.getElementById(`news-${k}`);
        const ptS = document.getElementById(`news-src-pt-${k}`);
        const ptT = document.getElementById(`news-ttl-pt-${k}`);
        const i1S = document.getElementById(`news-src-int1-${k}`);
        const i1T = document.getElementById(`news-ttl-int1-${k}`);
        const i2S = document.getElementById(`news-src-int2-${k}`);
        const i2T = document.getElementById(`news-ttl-int2-${k}`);
        if(nWrap && ptS && ptT && i1S && i1T && i2S && i2T){
          if(!pt && !int1 && !int2){
            ptS.textContent = 'Carregando manchetes…'; ptT.textContent = '—';
            i1S.textContent = '—'; i1T.textContent = '—';
            i2S.textContent = '—'; i2T.textContent = '—';
          } else {
            const set = (S,T,it) => {
              if(!it){ S.textContent='—'; T.textContent='—'; T.className = 'title'; }
              else {
                S.textContent=it.source; T.textContent=it.title;
                const sc = scoreSentiment(it.title);
                T.className = 'title ' + (sc>0? 'sent-up' : sc<0? 'sent-down' : '');
              }
            };
            set(ptS, ptT, pt);
            set(i1S, i1T, int1);
            set(i2S, i2T, int2);
          }
        }
        continue; // skip normal market render while in news mode
      }
      // premium/discount
      const dispPrice = choosePrice(st);
      const bp = Number.isFinite(st.last) ? st.last : NaN;
      const altCand = Number.isFinite(st.alt?.last) ? st.alt.last : Number.isFinite(st.cg?.last) ? st.cg.last : Number.isFinite(st.bs?.last) ? st.bs.last : NaN;
      const pd = (Number.isFinite(bp) && Number.isFinite(altCand)) ? pct(bp, altCand) : null;
      st.pd = Number.isFinite(pd) ? pd : null;
      setPrice(`p-${k}`, dispPrice);
      const pdEl = document.getElementById(`pd-${k}`);
      if(pdEl){ pdEl.textContent = (st.pd==null) ? '—' : `${st.pd>=0?'+':''}${st.pd.toFixed(2)}%`; pdEl.style.color = st.pd==null? '' : (st.pd>=0? 'var(--up)':'var(--down)'); }
      // z-score swing alert
      if(Number.isFinite(dispPrice)){
        const buf = st._zArr; buf.push(dispPrice); if(buf.length>40) buf.shift();
        const z = zscore(buf);
        const tile = tiles[k];
        if(tile){
          tile.classList.remove('swing-up','swing-down');
          if(Math.abs(z) > 2){ tile.classList.add(z>0? 'swing-up':'swing-down'); if(canPlay(k)) blip(z>0?'up':'down', Math.min(3, Math.abs(z))); }
        }
      }
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
      // Indicadores rápidos baseados na janela selecionada
  const { seriesF, tsF } = filterWindow(st);
      let dStr = '—', dCls = '';
      if(seriesF.length >= 2){
        const a = seriesF[0], b = seriesF[seriesF.length-1];
        const d = b - a; const pct = a ? (d/a*100) : 0;
        let sigma = 0;
        if(seriesF.length >= 3){
          const rets = []; for(let i=1;i<seriesF.length;i++){ const r = seriesF[i-1] ? ((seriesF[i]-seriesF[i-1])/seriesF[i-1]) : 0; if(Number.isFinite(r)) rets.push(r); }
          if(rets.length){ const m = rets.reduce((x,y)=>x+y,0)/rets.length; const v = rets.reduce((acc,v)=> acc + (v-m)*(v-m), 0) / rets.length; sigma = Math.sqrt(v) * 100; }
        }
        dStr = `${pct>=0?'+':''}${pct.toFixed(2)}% • σ ${sigma.toFixed(2)}%`;
        dCls = pct>0 ? 'up' : pct<0 ? 'down' : '';
      }
      setDelta(`d-${k}`, dStr, dCls);
      // Trend arrow next to symbol
      const ar = document.getElementById(`ar-${k}`);
      if(ar){
        if(dCls==='up'){ ar.textContent='▲'; ar.style.color='var(--up)'; }
        else if(dCls==='down'){ ar.textContent='▼'; ar.style.color='var(--down)'; }
        else { ar.textContent='•'; ar.style.color='var(--muted)'; }
      }
  const stats = chooseStats(st);
  setText(`hi-${k}`, Number.isFinite(stats.hi) ? fmtBRL.format(stats.hi) : '—');
  setText(`lo-${k}`, Number.isFinite(stats.lo) ? fmtBRL.format(stats.lo) : '—');
  setText(`vo-${k}`, Number.isFinite(stats.vo) ? fmtNum.format(stats.vo) : '—');
  const { bidDisp, askDisp } = chooseL1(st);
      const sprDisp = (Number.isFinite(bidDisp) && Number.isFinite(askDisp)) ? (askDisp - bidDisp) : (Number.isFinite(st.spread) ? st.spread : null);
      setText(`bid-${k}`, Number.isFinite(bidDisp) ? fmtBRL.format(bidDisp) : '—');
      setText(`ask-${k}`, Number.isFinite(askDisp) ? fmtBRL.format(askDisp) : '—');
      setText(`spu-${k}`, Number.isFinite(sprDisp) ? fmtBRL.format(sprDisp) : '—');
      // Última negociação: esconder se estiver velha
      const tr = st.trade;
      const trTs = tr?.timestamp ? (typeof tr.timestamp === 'number' ? tr.timestamp : (new Date(tr.timestamp).getTime() || 0)) : 0;
      const isStaleTr = !Number.isFinite(trTs) || (Date.now() - trTs) > STALE_TRADE_MS;
      const side = (tr?.type || tr?.TYPE || '').toString().toUpperCase();
      const sideClass = side === 'BUY' ? 'buy' : side === 'SELL' ? 'sell' : '';
      setPill(`tt-${k}`, (!isStaleTr && side) ? side : '—', sideClass);
      setText(`ta-${k}`, (!isStaleTr && tr?.amount != null) ? `${fmtNum.format(Number(tr.amount))}` : '—');
      setText(`tp-${k}`, (!isStaleTr && tr?.price  != null) ? fmtBRL.format(Number(tr.price)) : '—');
      setText(`ts-${k}`, (!isStaleTr && tr?.timestamp) ? humanTime(tr.timestamp) : '—');
      // chart removed from card for cleaner view
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
  function fitToRow(el, parent){
    const row = parent;
    const siblings = Array.from(row.children).filter(n=> n !== el);
    const deltaEl = siblings.find(n=> n.classList.contains('delta'));
    const gap = 10;
    let deltaW = 0;
    if(deltaEl){
      // Only subtract delta width if it's on the same line as price
      try{
        const eRect = el.getBoundingClientRect();
        const dRect = deltaEl.getBoundingClientRect();
        const sameLine = Math.abs(eRect.top - dRect.top) < Math.max(8, eRect.height*0.5);
        deltaW = sameLine ? dRect.width : 0;
      }catch{ deltaW = 0; }
    }
    const maxW = Math.max(0, row.clientWidth - deltaW - gap - 2);
    if(el.scrollWidth <= maxW) return;
    let fs = parseFloat(getComputedStyle(el).fontSize) || 32;
    let guard = 0;
    while(el.scrollWidth > maxW && fs > 12 && guard < 20){
      fs = Math.max(12, Math.floor(fs * 0.9));
      el.style.fontSize = fs + 'px';

      guard++;
    }
  }
  function choosePrice(st){
    const now = Date.now(); const freshMs = 2 * REFRESH_MS;
    const cands = [];
    if(Number.isFinite(st.last) && st.last>0 && st.lastAt && (now - st.lastAt) < freshMs) cands.push({ v: st.last, at: st.lastAt });
    if(Number.isFinite(st.alt.last) && st.alt.at && (now - st.alt.at) < freshMs) cands.push({ v: st.alt.last, at: st.alt.at });
    if(Number.isFinite(st.cg?.last) && st.cg.at && (now - st.cg.at) < freshMs) cands.push({ v: st.cg.last, at: st.cg.at });
    if(Number.isFinite(st.bs?.last) && st.bs.at && (now - st.bs.at) < freshMs) cands.push({ v: st.bs.last, at: st.bs.at });
    if(!cands.length){
      if(Number.isFinite(st.last) && st.last>0) return st.last;
      if(Number.isFinite(st.alt.last)) return st.alt.last;
      if(Number.isFinite(st.cg?.last)) return st.cg.last;
      if(Number.isFinite(st.bs?.last)) return st.bs.last;
      return NaN;
    }
    cands.sort((a,b)=> b.at - a.at);
    return cands[0].v;
  }
  function chooseL1(st){
    const now = Date.now(); const freshMs = 2 * REFRESH_MS;
    const cands = [];
    if((Number.isFinite(st.bid) || Number.isFinite(st.ask)) && st.lastAt && (now - st.lastAt) < freshMs) cands.push({ bid: st.bid, ask: st.ask, at: st.lastAt });
    if((Number.isFinite(st.alt.bid) || Number.isFinite(st.alt.ask)) && st.alt.at && (now - st.alt.at) < freshMs) cands.push({ bid: st.alt.bid, ask: st.alt.ask, at: st.alt.at });
    if((Number.isFinite(st.bs.bid) || Number.isFinite(st.bs.ask)) && st.bs.at && (now - st.bs.at) < freshMs) cands.push({ bid: st.bs.bid, ask: st.bs.ask, at: st.bs.at });
    if(!cands.length) return { bidDisp: Number.isFinite(st.bid)?st.bid:null, askDisp: Number.isFinite(st.ask)?st.ask:null };
    cands.sort((a,b)=> b.at - a.at);
    const top = cands[0];
    return { bidDisp: Number.isFinite(top.bid)?top.bid:null, askDisp: Number.isFinite(top.ask)?top.ask:null };
  }

  // ===== Small DOM helpers (restore missing fns) ============================
  function setText(id, text){ const el = document.getElementById(id); if(!el) return; el.textContent = (text === null || text === undefined) ? '—' : String(text); }
  function setDelta(id, text, cls){ const el = document.getElementById(id); if(!el) return; el.textContent = text || '—'; el.className = `delta ${cls||''}`.trim(); }
  function setPill(id, text, side){ const el = document.getElementById(id); if(!el) return; el.textContent = text || '—'; el.className = `pill ${side||''}`.trim(); }
  function humanTime(ts){ try{ const d = (typeof ts === 'number') ? new Date(ts) : new Date(ts); if(!d || isNaN(d.getTime())) return '—'; return d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' }); }catch{ return '—'; } }
  function setNet(ok){ const dot = document.getElementById('netDot'); if(!dot) return; dot.classList.remove('ok','err'); dot.classList.add(ok ? 'ok' : 'err'); }

  // ===== Loop ================================================================
  async function cycle(){
    NET_ERR = false;
    await fetchTickers();
    // No primeiro ciclo, dispara fontes alternativas em paralelo (fire-and-forget)
    if(cycleCount === 0){
      try{ Promise.allSettled([ fetchBinanceLight(), fetchCoinGeckoBatch() ]); }catch{}
    }
    await fetchOrderbookAndTrades();
    render();
    lastUpdate.textContent = new Date().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    setNet(!NET_ERR);
    cycleCount++;
  }
  let _cycleTimer = null; let _isRunning = false; function nextDelay(){ return document.hidden ? REFRESH_HIDDEN_MS : REFRESH_MS; } function scheduleNext(ms){ if(_cycleTimer) clearTimeout(_cycleTimer); _cycleTimer = setTimeout(runCycle, ms); _nextTickAt = Date.now() + ms; }
  async function runCycle(){
    if(_isRunning){ scheduleNext(250); return; }
    _isRunning = true;
    try{ await cycle(); }
    catch(e){ console.error('cycle erro:', e); }
    finally{
      try{
        // Cadências auxiliares (respeitando orçamento)
        if((cycleCount % 2) === 1){ await fetchBinanceLight(); }
        if((cycleCount % CG_EVERY) === 0){ await fetchCoinGeckoBatch(); }
        if((cycleCount % BS_EVERY) === 0){ await fetchBitstampLight(); }
        if((cycleCount % 1) === 0){ await refreshNews(); }
        render();
      }catch(e){ console.error('aux fetch erro:', e); }
      _isRunning = false; scheduleNext(nextDelay());
    }
  }
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

  // ===== Range selector & window filter ====================================
  function filterWindow(st){
    const all = st.history || []; const ts = st.histTS || [];
    if(!all.length) return { seriesF: [], tsF: [] };
    const now = Date.now(); const win = RANGE_MS[RANGE_CUR] || RANGE_MS['1h'];
    let startIdx = 0;
    if(ts.length === all.length && ts.length){
      for(let i=ts.length-1;i>=0;i--){ if((now - ts[i]) <= win){ startIdx = i; while(startIdx>0 && (now - ts[startIdx-1]) <= win) startIdx--; break; } }
    } else {
      const approx = Math.max(2, Math.floor(win / 35_000)); startIdx = Math.max(0, all.length - approx);
    }
    const seriesF = all.slice(startIdx);
    const tsF = ts.length ? ts.slice(startIdx) : [];
    return { seriesF, tsF };
  }
  function updateRangeUI(){ try{
    const r1 = document.getElementById('rg-1h'); const r4 = document.getElementById('rg-4h'); const r24 = document.getElementById('rg-24h');
    if(r1) r1.setAttribute('aria-pressed', String(RANGE_CUR==='1h'));
    if(r4) r4.setAttribute('aria-pressed', String(RANGE_CUR==='4h'));
    if(r24) r24.setAttribute('aria-pressed', String(RANGE_CUR==='24h'));
  }catch{} }
  function setRange(key){ if(!(key in RANGE_MS)) return; RANGE_CUR = key; try{ localStorage.setItem('wstv_range', key); }catch{} updateRangeUI(); render(); }
  function wireRange(){
    const r1 = document.getElementById('rg-1h'); const r4 = document.getElementById('rg-4h'); const r24 = document.getElementById('rg-24h');
    if(r1) r1.addEventListener('click', ()=> setRange('1h'));
    if(r4) r4.addEventListener('click', ()=> setRange('4h'));
    if(r24) r24.addEventListener('click', ()=> setRange('24h'));
    updateRangeUI();
  }
  wireRange();

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

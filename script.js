/* ============================================
   THE SWAN STATION — script.js  v3
   DHARMA Initiative Computing System
   ============================================ */
(function() {
  'use strict';

  // ── CONFIG ──
  const DEFAULT_MINUTES = 108;
  const CORRECT_NUMS    = [4,8,15,16,23,42];
  const WARN_AT         = 4 * 60;   // seconds
  const STORAGE_KEY     = 'swan_v3';

  // ── STATE ──
  let totalSeconds   = DEFAULT_MINUTES * 60;
  let remaining      = totalSeconds;
  let isRunning      = false;
  let isAlarm        = false;
  let isFailure      = false;
  let activeNav      = 'home';
  let soundEnabled   = false;
  let timerInterval  = null;
  let alarmInterval  = null;       // legacy (kept so existing refs don't crash)
  let beepInterval   = null;       // plays beep.mp3 every 2s when remaining <= 4:00
  let alarmLoopInterval = null;    // plays alarm.mp3 every 1.5s when remaining <= 1:00
  let alarmLoopRate     = 0;       // current alarm interval in ms (0 = not running)

  // ── DIGIT STATE (alt-style: track current char per tile) ──
  const flapState = { m1:'1', m2:'0', m3:'8', s1:'0', s2:'0' };

  // ── AUDIO (MP3 samples) ──────────────────────────────────────────────
  // All sample files live in assets/. Each gets a pool of Audio objects so
  // rapid repeated playback (e.g. fast typing) doesn't get cut off.
  const SAMPLE_DEFS = {
    tick:     { src: 'soundfx/tick.mp3',     vol: 0.55, pool: 2 },
    beep:     { src: 'soundfx/beep.mp3',     vol: 0.70, pool: 2 },
    alarm:    { src: 'soundfx/alarm.mp3',    vol: 0.85, pool: 2 },
    keyboard: { src: 'soundfx/keyboard.mp3', vol: 0.45, pool: 6 }, // fast typing
    reset:    { src: 'soundfx/reset.mp3',    vol: 0.80, pool: 1 },
    shuffle:  { src: 'soundfx/shuffle.mp3',  vol: 0.75, pool: 1 },
    menu:     { src: 'soundfx/menu.mp3',     vol: 0.65, pool: 1 },
    sysfail:  { src: 'soundfx/sysfail.mp3',  vol: 0.90, pool: 1 },
    gear:     { src: 'soundfx/gear.mp3',     vol: 0.70, pool: 1 },
  };
  const samples = {};       // name -> { pool: [Audio,...], idx, vol }

  function preloadSamples() {
    Object.entries(SAMPLE_DEFS).forEach(([name, def]) => {
      const pool = [];
      for (let i = 0; i < def.pool; i++) {
        const a = new Audio(def.src);
        a.preload = 'auto';
        a.volume = def.vol;
        pool.push(a);
      }
      samples[name] = { pool, idx: 0, vol: def.vol };
    });
  }

  function playSample(name) {
    if (!soundEnabled) return;
    const s = samples[name];
    if (!s) return;
    const audio = s.pool[s.idx];
    s.idx = (s.idx + 1) % s.pool.length;
    try {
      audio.currentTime = 0;
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay blocked, ignore */ });
    } catch (e) { /* swallow */ }
  }

  // Compatibility wrappers (called from existing code paths) ──
  // tick.mp3 is driven by the timer interval (once per second), NOT by
  // each flip-digit animation, so playTick() is intentionally a no-op now.
  function playTick()   { /* handled by 1s timer loop */ }
  function playAccept() { playSample('reset'); }
  function playReject() { /* no dedicated sound — silent on bad input */ }

  // ── Beep / Alarm loops ─────────────────────────────────────────────
  // Mutually exclusive: when alarm kicks in (≤1:00), beep stops.
  function startBeepLoop() {
    if (beepInterval) return;
    playSample('beep');
    beepInterval = setInterval(() => playSample('beep'), 2000);
  }
  function stopBeepLoop() {
    if (beepInterval) { clearInterval(beepInterval); beepInterval = null; }
  }
  function startAlarmLoop(intervalMs) {
    intervalMs = intervalMs || 1500;
    // If already running at the requested rate, do nothing.
    if (alarmLoopInterval && alarmLoopRate === intervalMs) return;
    // Rate change: clear and restart at new rate (without an immediate
    // double-play if we already started recently).
    if (alarmLoopInterval) {
      clearInterval(alarmLoopInterval);
      alarmLoopInterval = null;
    } else {
      playSample('alarm');
    }
    alarmLoopRate = intervalMs;
    alarmLoopInterval = setInterval(() => playSample('alarm'), intervalMs);
  }
  function stopAlarmLoop() {
    if (alarmLoopInterval) { clearInterval(alarmLoopInterval); alarmLoopInterval = null; }
    alarmLoopRate = 0;
  }
  // Legacy names — kept so callers (resetTimer, triggerFailure) keep working.
  function startAlarm() { /* loops are now driven by remaining-time checks in updateAudioLoops */ }
  function stopAlarm()  { stopBeepLoop(); stopAlarmLoop(); }

  // Called every second from the timer; picks the right loop for current time.
  function updateAudioLoops() {
    if (isFailure || remaining <= 0) {
      stopBeepLoop(); stopAlarmLoop(); return;
    }
    if (remaining <= 10) {
      stopBeepLoop();
      startAlarmLoop(1000);     // urgent 1s cadence for final countdown
    } else if (remaining <= 60) {
      stopBeepLoop();
      startAlarmLoop(1500);     // normal alarm cadence
    } else if (remaining <= WARN_AT) {
      stopAlarmLoop();
      startBeepLoop();
    } else {
      stopBeepLoop(); stopAlarmLoop();
    }
  }

  function playFailure() {
    if (!soundEnabled) return;
    // Play sysfail.mp3 three times, spaced so each clip can finish.
    // sysfail.mp3 is ~0.5s; 1.2s spacing gives a clear, dramatic cadence.
    playSample('sysfail');
    setTimeout(() => playSample('sysfail'), 1200);
    setTimeout(() => playSample('sysfail'), 2400);
  }
  // ─────────────────────────────────────────────────────────────────────

  // ── PERSISTENCE ──
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ totalSeconds, remaining, isRunning, savedAt: Date.now() })); } catch(e){}
  }
  function loadState() {
    try {
      const d = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!d) return;
      totalSeconds = d.totalSeconds || DEFAULT_MINUTES*60;
      if (d.isRunning && d.savedAt) {
        remaining = Math.max(0, (d.remaining||totalSeconds) - Math.floor((Date.now()-d.savedAt)/1000));
      } else {
        remaining = d.remaining || totalSeconds;
      }
      isRunning = d.isRunning || false;
    } catch(e){}
  }

  // ── FLIP DIGIT (alt's approach: append new, remove old) ──
  function flipDigit(id, newChar) {
    const tile = document.getElementById(id);
    if (!tile) return;
    const oldSpan = tile.querySelector('.digit');
    const fresh = document.createElement('span');
    fresh.className = 'digit enter';
    fresh.textContent = newChar;
    tile.appendChild(fresh);
    if (oldSpan) {
      oldSpan.classList.add('exit');
      setTimeout(() => oldSpan.remove(), 340);
    }
    playTick();
    flapState[id.replace('fd-','')] = newChar;
  }

  function renderTime(mins, secs) {
    const mm = String(Math.max(0,Math.min(999,mins))).padStart(3,'0');
    const ss = String(Math.max(0,Math.min(59,secs))).padStart(2,'0');
    const target = { m1:mm[0], m2:mm[1], m3:mm[2], s1:ss[0], s2:ss[1] };
    Object.entries(target).forEach(([k,v]) => {
      if (flapState[k] !== v) flipDigit('fd-'+k, v);
    });

    // Alarm at 4:00
    const clock = document.getElementById('flip-clock');
    if (remaining <= WARN_AT && remaining > 0 && !isFailure) {
      clock.classList.add('timer-alarm');
      if (!isAlarm) { isAlarm = true; startAlarm(); }
    }
  }

  function renderTimeDirect(mins, secs) {
    // Set without animation (initial load)
    const mm = String(Math.max(0,Math.min(999,mins))).padStart(3,'0');
    const ss = String(Math.max(0,Math.min(59,secs))).padStart(2,'0');
    ['m1','m2','m3'].forEach((k,i) => {
      const tile = document.getElementById('fd-'+k);
      if (tile) { const s = tile.querySelector('.digit'); if(s) s.textContent = mm[i]; flapState[k] = mm[i]; }
    });
    ['s1','s2'].forEach((k,i) => {
      const tile = document.getElementById('fd-'+k);
      if (tile) { const s = tile.querySelector('.digit'); if(s) s.textContent = ss[i]; flapState[k] = ss[i]; }
    });
  }

  // ── TIMER ──
  function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    isRunning = true;
    let lastTick = Date.now();
    timerInterval = setInterval(() => {
      if (!isRunning) return;
      const now = Date.now();
      const elapsed = Math.floor((now - lastTick) / 1000);
      if (elapsed >= 1) {
        remaining = Math.max(0, remaining - elapsed);
        lastTick += elapsed * 1000;
        renderTime(Math.floor(remaining/60), remaining%60);
        // Tick once per real second (collapse if multiple seconds elapsed).
        if (remaining > 0 && !isFailure) playSample('tick');
        // Manage beep / alarm loops based on remaining time.
        updateAudioLoops();
        saveState();
        if (remaining === 0) { clearInterval(timerInterval); triggerFailure(); }
      }
    }, 250);
  }

  function resetTimer(secs) {
    clearInterval(timerInterval); timerInterval = null;
    stopAlarm(); isAlarm = false; isFailure = false;
    totalSeconds = secs !== undefined ? secs : totalSeconds;
    remaining = totalSeconds;
    document.getElementById('flip-clock').classList.remove('timer-alarm','timer-glyph');
    renderTimeDirect(Math.floor(remaining/60), remaining%60);
    document.getElementById('timer-info').textContent =
      Math.floor(totalSeconds/60) + ':00 ' + (totalSeconds === DEFAULT_MINUTES*60 ? 'DEFAULT' : 'CUSTOM');
    saveState();
    startTimer();
  }

  // ── FAILURE SEQUENCE ──
  function triggerFailure() {
    isFailure = true; stopAlarm();
    const clock = document.getElementById('flip-clock');
    clock.classList.remove('timer-alarm'); clock.classList.add('timer-glyph');
    const glyphs = ['𓂀','𓆣','𓇯','𓏤','𓃒'];
    ['m1','m2','m3','s1','s2'].forEach((k,i) => setTimeout(()=>flipDigit('fd-'+k, glyphs[i]), i*300));

    const overlay = document.getElementById('failure-overlay');
    overlay.classList.add('active');
    setTimeout(()=>{ document.getElementById('monitor-screen').classList.add('glitch'); }, 600);
    playFailure();
    setTimeout(()=>{ setScreen('failure'); }, 1000);
    setTimeout(()=>{
      overlay.classList.remove('active');
      document.getElementById('monitor-screen').classList.remove('glitch');
      setScreen('failure-end');
    }, 8500);
  }

  // ── SCREEN CONTENT ──
  const SCREENS = {
    home: () => `
<span class="screen-line text-dim">DHARMA INITIATIVE — SWAN STATION</span>
<span class="screen-line text-dim">COMPUTING SYSTEM v2.01 — READY</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line"><span class="screen-prompt">&gt;:</span> SYSTEM ONLINE. ALL FUNCTIONS NOMINAL.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-amber">PROTOCOL REMINDER:</span>
<span class="screen-line">Every 108 minutes the button must be pushed. Alarm sounds at 4 minutes. You will have 4 minutes to enter code.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">Type a command below, or use ≡ menu.</span>
<span class="screen-line text-dim">Commands: home · comm · instructions · orientation · faq</span>
<span class="screen-line"> </span>`,

    communication: () => `
<span class="screen-line text-amber">// COMMUNICATION LOG — INTERNAL //</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">─────────────────────────────────────</span>
<span class="screen-line"> </span>
<span class="screen-line"><span class="text-dim">[DAY 001]</span> Kelvin: Button pushed. Namaste.</span>
<span class="screen-line"><span class="text-dim">[DAY 003]</span> Desmond: Who else is down here?</span>
<span class="screen-line"><span class="text-dim">[DAY 047]</span> Kelvin: Don't ask questions.</span>
<span class="screen-line"><span class="text-dim">[DAY 102]</span> Desmond: 4 8 15 16 23 42. Done.</span>
<span class="screen-line"><span class="text-dim">[DAY 440]</span> [USER DISCONNECT]</span>
<span class="screen-line"><span class="text-dim">[DAY 441]</span> Locke: What does it DO?</span>
<span class="screen-line"><span class="text-dim">[DAY 441]</span> Jack: Nothing. Push it anyway.</span>
<span class="screen-line"><span class="text-dim">[DAY 511]</span> Desmond: I was wrong about that.</span>
<span class="screen-line"> </span>
<span class="screen-line text-dim">─────────────────────────────────────</span>`,

    instructions: () => `
<span class="screen-line text-amber">// STATION PROTOCOL — READ CAREFULLY //</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line">Every 108 minutes, the button must be pushed. From the moment the alarm sounds, you will have four minutes to enter the code into the micro-computer processor.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line">Either you or your partners must input the code. It is recommended that you take alternating shifts.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line">On behalf of the DeGroots, Alvar Hanso, and all of us at the DHARMA Initiative — thank you.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-amber">NAMASTE. AND GOOD LUCK.</span>
<span class="screen-line"> </span>`,

    orientation: () => `
<span class="screen-line text-amber">// ORIENTATION FILM — REEL B //</span>
<span class="screen-line text-dim">DR. MARVIN CANDLE — DHARMA INITIATIVE</span>
<span class="screen-line"> </span>
<video class="screen-video" controls id="orient-video">
  <source src="assets/orientation.mp4" type="video/mp4">
</video>
<span class="screen-line" id="video-fallback" style="display:none" class="text-red">&gt; REEL NOT FOUND. Upload to /assets/orientation.mp4</span>
<span class="screen-line"> </span>`,

    faq: () => `
<span class="screen-line text-amber">// ABOUT & FAQ //</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">Q: What is this?</span>
<span class="screen-line">A: A tribute to ABC's LOST and a functional countdown timer.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">Q: How do I push the button?</span>
<span class="screen-line">A: Type <span class="text-amber">4 8 15 16 23 42</span> then EXECUTE. Spaces optional.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">Q: Custom timer?</span>
<span class="screen-line">A: Click ⚙ near the timer. Any duration in minutes works.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">Q: Terminal commands?</span>
<span class="screen-line">A: home · comm · instructions · orientation · faq</span>
<span class="screen-line">   Type and press EXECUTE or Enter.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">Q: What if I don't push it?</span>
<span class="screen-line text-red">A: "You know what happens." — Locke</span>
<span class="screen-line"> </span>`,

    failure: () => `
<span class="screen-line text-red blink">████ SYSTEM FAILURE ████</span>
<span class="screen-line"> </span>
<span class="screen-line text-red">ELECTROMAGNETIC EVENT DETECTED</span>
<span class="screen-line text-red">CONTAINMENT PROTOCOL BREACHED</span>
<span class="screen-line"> </span>
<span class="screen-line text-amber">𓂀  𓆣  𓇯  𓏤  𓃒</span>
<span class="screen-line"> </span>
<span class="screen-line text-red blink">SYSTEM FAILURE — SYSTEM FAILURE</span>`,

    about: () => `
<span class="screen-line text-amber">// ABOUT THIS PROJECT //</span>
<span class="screen-line"> </span>
<span class="screen-line">This page will contain a full About</span>
<span class="screen-line">section. For now, see FAQ below.</span>
<span class="screen-line"> </span>
<span class="screen-line text-dim">Type <span class="text-amber">faq</span> for full FAQ.</span>
<span class="screen-line"> </span>`,

    'failure-end': () => `
<span class="screen-line text-dim">... ... ...</span>
<span class="screen-line"> </span>
<span class="screen-line text-red">TIMER EXPIRED.</span>
<span class="screen-line">The button was not pushed.</span>
<span class="screen-line"> </span>
<span class="screen-line text-dim">Use ⚙ to set a new timer, or reload.</span>
<span class="screen-line"> </span>`,
  };

  function termInputHTML() {
    // The prompt + cursor + input are one unified row.
    // The cursor blinks until the user starts typing (hidden via CSS focus trick).
    return `<div class="term-input-row" id="term-input-row">
      <span class="input-prompt">&gt;:</span> <input type="text" id="code-input"
        placeholder=""
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
        maxlength="40"><button class="btn-kbd-toggle" id="btn-kbd-toggle">[KBD]</button><button class="btn-execute" id="btn-execute">EXECUTE</button>
    </div>
    <div id="term-response"></div>`;
  }

  function setScreen(key) {
    activeNav = key;
    const fn = SCREENS[key];
    document.getElementById('screen-content').innerHTML = fn ? fn() : SCREENS.home();
    // Inject input area (except pure failure screen)
    const inputArea = document.getElementById('screen-input-area');
    if (key !== 'failure') {
      inputArea.innerHTML = termInputHTML();
    } else {
      inputArea.innerHTML = '';
    }
    // Auto-focus input on screen change
    setTimeout(() => { const i = document.getElementById('code-input'); if (i) i.focus(); }, 40);

    // Wire orientation fallback
    if (key === 'orientation') {
      const v = document.getElementById('orient-video');
      const fb = document.getElementById('video-fallback');
      if (v && fb) {
        v.addEventListener('error', () => { v.style.display='none'; fb.style.display='block'; });
        setTimeout(() => { if (!v.duration || isNaN(v.duration)) { v.style.display='none'; fb.style.display='block'; } }, 2000);
      }
    }
    // Update nav active
    document.querySelectorAll('[data-nav]').forEach(el => {
      const li = el.closest('li');
      if (li) li.classList.toggle('active', el.dataset.nav === key);
    });
    // Scroll to bottom after render
    const scr = document.getElementById('screen-scroll');
    if (scr) setTimeout(() => { scr.scrollTop = scr.scrollHeight; }, 30);
  }


  function printResponse(html) {
    const resp = document.getElementById('term-response');
    if (resp) {
      resp.innerHTML = html;
      const scr = document.getElementById('screen-scroll');
      if (scr) setTimeout(() => scr.scrollTop = scr.scrollHeight, 30);
    }
  }

  // ── CODE / COMMAND INPUT ──
  const COMMANDS = {
    'home': 'home', 'h': 'home',
    'comm': 'communication', 'communication': 'communication', 'comms': 'communication',
    'instructions': 'instructions', 'instr': 'instructions', 'i': 'instructions',
    'orientation': 'orientation', 'orient': 'orientation', 'video': 'orientation', 'o': 'orientation',
    'faq': 'faq', 'help': 'faq',
    'about': 'about',
    'comm': 'communication', 'communication': 'communication', 'comms': 'communication',
  };

  function normalizeCode(str) {
    return str.trim().replace(/\s+/g,' ').replace(/[^0-9 ]/g,'');
  }
  function checkCode(raw) {
    const nums = normalizeCode(raw).split(' ').map(Number).filter(n => !isNaN(n) && n > 0);
    return JSON.stringify(nums) === JSON.stringify(CORRECT_NUMS);
  }

  function submitInput() {
    const input = document.getElementById('code-input');
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;
    const lower = val.toLowerCase();

    // Check if it's a nav command
    if (COMMANDS[lower]) {
      input.value = '';
      setScreen(COMMANDS[lower]);
      return;
    }
    // Check if it's the numbers code
    if (checkCode(val)) {
      input.value = '';
      playAccept();
      resetTimer();
      printResponse('<span class="text-amber">&gt;: CODE ACCEPTED. TIMER RESET. NAMASTE.</span>');
      // Flash screen
      const scr = document.getElementById('monitor-screen');
      scr.style.transition = 'box-shadow 0.08s';
      scr.style.boxShadow = '0 0 50px rgba(0,255,0,0.45), inset 0 0 60px rgba(0,80,0,0.25)';
      setTimeout(()=>{ scr.style.boxShadow=''; setTimeout(()=>scr.style.transition='',400); }, 650);
    } else {
      input.value = '';
      playReject();
      printResponse('<span class="text-red">&gt;: UNKNOWN COMMAND OR INVALID CODE.</span>');
    }
  }

  // ── VIRTUAL KEYBOARD ──
  const KB_ROWS = [
    [{l:'!',s:'1',k:'1'},{l:'@',s:'2',k:'2'},{l:'#',s:'3',k:'3'},{l:'$',s:'4',k:'4'},
     {l:'%',s:'5',k:'5'},{l:'&',s:'6',k:'6'},{l:"'",s:'7',k:'7'},{l:'(',s:'8',k:'8'},
     {l:')',s:'9',k:'9'},{l:' ',s:'0',k:'0'},{l:'_',s:'-',k:'-'},{l:'=',s:'=',k:'='},
     {l:'←',k:'Backspace',c:'key-special key-w-1h'}],
    [{l:'TAB',k:'Tab',c:'key-special key-w-1h'},
     {l:'Q',k:'q'},{l:'W',k:'w'},{l:'E',k:'e'},{l:'R',k:'r'},{l:'T',k:'t'},
     {l:'Y',k:'y'},{l:'U',k:'u'},{l:'I',k:'i'},{l:'O',k:'o'},{l:'P',k:'p'},
     {l:'[',k:'['},{l:']',k:']'},{l:'RETURN',k:'Enter',c:'key-special key-w-ret'}],
    [{l:'CTRL',k:'Control',c:'key-special key-w-1h'},
     {l:'A',k:'a'},{l:'S',k:'s'},{l:'D',k:'d'},{l:'F',k:'f'},{l:'G',k:'g'},
     {l:'H',k:'h'},{l:'J',k:'j'},{l:'K',k:'k'},{l:'L',k:'l'},
     {l:';',k:';'},{l:"'",k:"'"},{l:'RETURN',k:'Enter',c:'key-special key-w-2'}],
    [{l:'SHIFT',k:'Shift',c:'key-special key-w-2h'},
     {l:'Z',k:'z'},{l:'X',k:'x'},{l:'C',k:'c'},{l:'V',k:'v'},{l:'B',k:'b'},
     {l:'N',k:'n'},{l:'M',k:'m'},{l:',',k:','},{l:'.',k:'.'},{l:'/',k:'/'},
     {l:'SHIFT',k:'Shift',c:'key-special key-w-2'}],
    [{l:'RESET',k:'Escape',c:'key-reset key-w-1h'},{l:'⌥',k:'Alt',c:'key-special'},
     {l:'',k:' ',c:'key-w-sp'},{l:'⌘',k:'Meta',c:'key-special'},
     {l:'←',k:'ArrowLeft',c:'key-special'},{l:'→',k:'ArrowRight',c:'key-special'}],
  ];

  function buildKeyboard() {
    const kb = document.getElementById('virtual-keyboard');
    if (!kb) return;
    kb.innerHTML = '';
    KB_ROWS.forEach(row => {
      const rowEl = document.createElement('div');
      rowEl.className = 'key-row';
      row.forEach(k => {
        const btn = document.createElement('button');
        btn.className = 'key ' + (k.c || 'key-w-1');
        btn.dataset.key = k.k;
        btn.innerHTML = k.s
          ? `<span class="key-shift">${k.l}</span><span class="key-main">${k.s}</span>`
          : `<span class="key-main">${k.l}</span>`;
        btn.addEventListener('mousedown', e => {
          e.preventDefault();
          handleKey(k.k);
          btn.classList.add('pressed');
          setTimeout(() => btn.classList.remove('pressed'), 150);
        });
        rowEl.appendChild(btn);
      });
      kb.appendChild(rowEl);
    });
  }

  function handleKey(key) {
    const input = document.getElementById('code-input');
    if (!input) return;
    if (key === 'Enter') { submitInput(); return; }
    // Click sound for every virtual-keyboard press (mirrors physical typing).
    playSample('keyboard');
    if (key === 'Backspace') { input.value = input.value.slice(0,-1); }
    else if (key === 'Escape') { input.value = ''; }
    else if (['Tab','Shift','Control','Alt','Meta','ArrowLeft','ArrowRight'].includes(key)) { /* ignore */ }
    else if (key === ' ') { input.value += ' '; }
    else { input.value += key; }
    input.focus();
  }

  function highlightKey(key) {
    const btn = document.querySelector(`[data-key="${key}"], [data-key="${key.toLowerCase()}"]`);
    if (btn) { btn.classList.add('pressed'); setTimeout(()=>btn.classList.remove('pressed'),150); }
  }

  // ── SETTINGS ──
  function openSettings() {
    playSample('gear');
    const m = document.getElementById('settings-modal');
    document.getElementById('settings-minutes').value = Math.round(totalSeconds/60);
    m.classList.add('open');
    setTimeout(()=>document.getElementById('settings-minutes').focus(),30);
  }
  function closeSettings() { document.getElementById('settings-modal').classList.remove('open'); }
  function applySettings() {
    const v = parseInt(document.getElementById('settings-minutes').value);
    if (isNaN(v)||v<1||v>9999) return;
    playSample('shuffle');
    closeSettings(); resetTimer(v*60);
    printResponse(`<span class="text-amber">&gt;: TIMER SET TO ${v} MINUTES.</span>`);
  }

  // ── MENU OVERLAY ──
  function openMenu() { playSample('menu'); document.getElementById('menu-overlay').classList.add('open'); }
  function closeMenu() { document.getElementById('menu-overlay').classList.remove('open'); }

  // ── FOOTER CLOCK ──
  function tickClock() {
    const el = document.getElementById('footer-time');
    if (el) el.textContent = new Date().toLocaleString('en-US',{month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true});
  }

  // ── INIT ──
  function init() {
    loadState();
    preloadSamples();
    renderTimeDirect(Math.floor(remaining/60), remaining%60);
    if (remaining <= WARN_AT && remaining > 0 && !isFailure) {
      document.getElementById('flip-clock').classList.add('timer-alarm');
      isAlarm = true;
    }
    buildKeyboard();
    setScreen('home');
    tickClock(); setInterval(tickClock, 15000);
    if (remaining > 0) startTimer();
    else { isFailure = true; setScreen('failure-end'); }

    // First-click sound enable. Browsers block <audio>.play() until the user
    // interacts at least once; on first click we mark sound enabled and run
    // a silent priming-play on each sample to satisfy autoplay policies.
    function enableSound() {
      if (soundEnabled) return;
      soundEnabled = true;
      // Prime each Audio element so subsequent .play() calls are gesture-free.
      Object.values(samples).forEach(s => {
        s.pool.forEach(a => {
          const origVol = a.volume;
          a.volume = 0;
          const p = a.play();
          if (p && typeof p.then === 'function') {
            p.then(() => { a.pause(); a.currentTime = 0; a.volume = origVol; })
             .catch(() => { a.volume = origVol; });
          } else {
            a.pause(); a.currentTime = 0; a.volume = origVol;
          }
        });
      });
      const sp = document.getElementById('sound-prompt');
      if (sp) sp.classList.add('hidden');
      // Kick off any loop appropriate for current remaining time.
      updateAudioLoops();
    }
    document.addEventListener('click', function onFirst() {
      enableSound();
      document.removeEventListener('click', onFirst);
    }, {once:true});
    document.getElementById('sound-prompt').addEventListener('click', enableSound);

    // ── Delegated click handler ──
    document.addEventListener('click', e => {
      const t = e.target;

      // Execute button
      if (t.id === 'btn-execute' || t.closest('#btn-execute')) { submitInput(); return; }

      // KBD toggle
      if (t.id === 'btn-kbd-toggle' || t.closest('#btn-kbd-toggle')) {
        const kw = document.querySelector('.keyboard-wrap');
        kw.classList.toggle('visible');
        const btn = document.getElementById('btn-kbd-toggle');
        if (btn) btn.textContent = kw.classList.contains('visible') ? '[KBD ×]' : '[KBD]';
        const inp = document.getElementById('code-input'); if (inp) inp.focus();
        return;
      }

      // Settings
      if (t.id === 'btn-settings') { openSettings(); return; }
      if (t.id === 'btn-settings-cancel') { closeSettings(); return; }
      if (t.id === 'btn-settings-apply') { applySettings(); return; }
      if (t.id === 'settings-modal' && t === e.currentTarget) { closeSettings(); return; }

      // Menu
      if (t.id === 'btn-menu') { openMenu(); return; }
      if (t.id === 'menu-close') { closeMenu(); return; }
      if (t.id === 'menu-overlay' && t === e.currentTarget) { closeMenu(); return; }

      // Nav buttons (menu)
      const navEl = t.closest('[data-nav]');
      if (navEl) {
        setScreen(navEl.dataset.nav);
        closeMenu();
        return;
      }

      // Station buttons in menu overlay
      const stBtn = t.closest('.menu-station-btn');
      if (stBtn) { showStationModal(stBtn.dataset.station); closeMenu(); return; }

      // Station modal close
      if (t.id === 'station-modal-close') { document.getElementById('station-modal').classList.remove('open'); return; }
      if (t.id === 'station-modal') { document.getElementById('station-modal').classList.remove('open'); return; }


    });

    // Physical keyboard
    document.addEventListener('keydown', e => {
      highlightKey(e.key);
      const inp = document.getElementById('code-input');
      const typingInInput = inp && document.activeElement === inp;
      // Per-character keyboard click while user types in the terminal input.
      // Includes regular chars + Backspace/Delete (anything that mutates value).
      if (typingInInput && e.key !== 'Enter' && e.key !== 'Escape') {
        const isPrintable = e.key.length === 1;
        const isEdit = e.key === 'Backspace' || e.key === 'Delete';
        if (isPrintable || isEdit) playSample('keyboard');
      }
      // Enter submits if input focused
      if (e.key === 'Enter') {
        if (typingInInput) { e.preventDefault(); submitInput(); }
      }
      if (e.key === 'Escape') { closeMenu(); closeSettings(); }
    });

    // Settings enter key
    document.getElementById('settings-minutes').addEventListener('keydown', e => {
      if (e.key === 'Enter') applySettings();
    });
  }

  function showStationModal(name) {
    const m = document.getElementById('station-modal');
    document.getElementById('station-modal-title').textContent = 'THE ' + name.toUpperCase();
    document.getElementById('station-modal-desc').innerHTML =
      'ACCESS: <span style="color:var(--red-alarm)">CLASSIFIED</span><br><br>This station is not yet operational.<br><br>Namaste.';
    m.classList.add('open');
  }

  function closeMobileDrawer() {}

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

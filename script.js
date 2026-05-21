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

  // ── CHAT STATE (Michael/Walt "hello" sequence) ──
  let chatActive = false;
  let chatStep   = 0;   // 0 = waiting for "this is X" reply, 1 = "dad?", 2 = "are you alone?", 3 = final any-reply
  let chatTimeoutId = null;

  // ── INVALID INPUT TRACKING ──
  // Increments on every unknown command / bad code. Reset on any valid input.
  // When it reaches 2, we show the lockout warning screen.
  let invalidAttempts = 0;

  // ── AUDIO (MP3 samples) ──────────────────────────────────────────────
  // All sample files live in assets/. Each gets a pool of Audio objects so
  // rapid repeated playback (e.g. fast typing) doesn't get cut off.
  const SAMPLE_DEFS = {
    tick:     { src: 'soundfx/tick.mp3',     vol: 0.55, pool: 2 },
    beep:     { src: 'soundfx/beep.mp3',     vol: 0.70, pool: 2 },
    alarm:    { src: 'soundfx/alarm.mp3',    vol: 0.85, pool: 2 },
    keyboard: { src: 'soundfx/keyboard.mp3', vol: 0.45, pool: 6 },
    reset:    { src: 'soundfx/reset.mp3',    vol: 0.80, pool: 1 },
    shuffle:  { src: 'soundfx/shuffle.mp3',  vol: 0.75, pool: 1 },
    menu:     { src: 'soundfx/menu.mp3',     vol: 0.65, pool: 1 },
    sysfail:  { src: 'soundfx/sysfail.mp3',  vol: 0.90, pool: 1 },
    gear:     { src: 'soundfx/gear.mp3',     vol: 0.95, pool: 1 },
    wrong:    { src: 'soundfx/wrong.mp3',    vol: 0.75, pool: 2 },
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
  function playReject() { playSample('wrong'); }

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

  // ═══════════════════════════════════════════════════════════════════
  //  TYPEWRITER — animated rendering of HTML into a DOM element.
  //
  //  Use `typewriter(el, html, options)` to render `html` into `el` one
  //  character at a time. HTML tags (e.g. <br>, <span class="...">) are
  //  inserted instantly; only text content is paced. A blinking ▮ cursor
  //  follows the typing head while active. Animation is cancellable and
  //  skippable.
  //
  //  Presets are exposed via `typewriter.modes` — pick by name:
  //    'type'   — chat-style, slow + punctuation pauses + jitter
  //    'stream' — page-loading style, fast + cursor
  //    'fast'   — quick sweep, almost-instant
  //    'still'  — no animation, render instantly
  // ═══════════════════════════════════════════════════════════════════

  // Track the current in-flight animation so it can be cancelled or skipped.
  let _twActive = null;   // { skip: fn(), cancel: fn() } or null

  function typewriterCancel() {
    if (_twActive) { _twActive.cancel(); _twActive = null; }
  }
  function typewriterSkip() {
    if (_twActive) { _twActive.skip(); _twActive = null; }
  }
  function typewriterIsActive() { return !!_twActive; }

  // Walk an HTML string and produce a flat ordered sequence of "tokens":
  //   { type: 'char', char: 'A', parents: [openTag, openTag, ...] }   ← paced
  //   { type: 'tag',  html: '<br>', parents: [...] }                  ← instant
  // Each token carries the list of currently-open tags so that on skip
  // we can rebuild the final markup faithfully.
  function tokenizeHtml(html) {
    const tokens = [];
    let i = 0;
    const openTags = [];   // stack of tag-open strings, e.g. ['<span class="text-amber">']

    while (i < html.length) {
      const ch = html[i];

      if (ch === '<') {
        // Find matching '>'
        const end = html.indexOf('>', i);
        if (end === -1) { i = html.length; break; }
        const tag = html.substring(i, end + 1);
        const isClosing = tag.startsWith('</');
        const isSelfClosing = /<(br|hr|img|input|meta|link)\b[^>]*\/?>/i.test(tag) || tag.endsWith('/>');
        // For closing tags, pop the open stack BEFORE recording parents,
        // so the parents snapshot reflects state AFTER this close.
        if (isClosing) openTags.pop();
        tokens.push({ type: 'tag', html: tag, parents: openTags.slice() });
        if (!isClosing && !isSelfClosing) openTags.push(tag);
        i = end + 1;
      } else if (ch === '&') {
        // HTML entity — treat as a single char unit.
        const end = html.indexOf(';', i);
        if (end !== -1 && end - i < 10) {
          tokens.push({ type: 'char', char: html.substring(i, end + 1), parents: openTags.slice() });
          i = end + 1;
        } else {
          tokens.push({ type: 'char', char: ch, parents: openTags.slice() });
          i++;
        }
      } else if (ch === '\n' || ch === '\r') {
        // Preserve as instant content (don't pace whitespace between tags).
        tokens.push({ type: 'tag', html: ch, parents: openTags.slice() });
        i++;
      } else {
        tokens.push({ type: 'char', char: ch, parents: openTags.slice() });
        i++;
      }
    }
    return tokens;
  }

  // Pause (extra delay) after certain punctuation, in ms.
  function punctuationDelay(ch) {
    if (ch === '.' || ch === '?' || ch === '!') return 250;
    if (ch === ',' || ch === ';' || ch === ':') return 120;
    return 0;
  }

  function typewriter(element, html, options) {
    typewriterCancel();
    if (!element) return Promise.resolve();

    const opts = Object.assign({
      speed: 30,
      jitter: 0,
      punctuationPause: false,
      showCursor: true,
      cursorChar: '▮',
      scrollEl: null,
      tickSound: false,
      tickEvery: 3,            // play tick sample every Nth char
      onComplete: null,
    }, options || {});

    // 'still' mode shortcut — render instantly with no cursor.
    if (opts.speed <= 0) {
      element.innerHTML = html;
      if (opts.scrollEl) opts.scrollEl.scrollTop = opts.scrollEl.scrollHeight;
      if (opts.onComplete) opts.onComplete();
      return Promise.resolve();
    }

    const tokens = tokenizeHtml(html);
    let idx = 0;
    let cancelled = false;
    let timeoutId = null;
    let charsSinceTick = 0;

    // We build the visible markup as a plain string and assign innerHTML
    // each step. The cursor is rendered as a string fragment placed at
    // the current insertion point — BEFORE any auto-closing tags — so
    // it visually follows the typing head inside the correct span(s).
    let visibleHtml = '';
    const cursorHtml = opts.showCursor
      ? `<span class="tw-cursor">${opts.cursorChar}</span>`
      : '';
    element.innerHTML = cursorHtml;     // cursor shown immediately

    const scrollFn = () => {
      if (opts.scrollEl) opts.scrollEl.scrollTop = opts.scrollEl.scrollHeight;
    };

    return new Promise(resolve => {
      function finish() {
        element.innerHTML = html;       // ensure exact final state, no cursor
        scrollFn();
        if (_twActive && _twActive._token === token) _twActive = null;
        if (opts.onComplete) opts.onComplete();
        resolve();
      }

      function skip() {
        cancelled = true;
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        finish();
      }

      function cancel() {
        cancelled = true;
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        // Leave element in whatever state it is — caller will overwrite.
        resolve();
      }

      const token = {};   // identity object for ownership check
      _twActive = { skip, cancel, _token: token };

      function render() {
        // Compute the closing-tag string for any currently-open parents.
        const lastTok = tokens[idx - 1];
        const parents = lastTok ? lastTok.parents : [];
        const openClosers = parents.map(openTag => {
          const m = openTag.match(/^<\s*([a-zA-Z][a-zA-Z0-9]*)/);
          return m ? `</${m[1]}>` : '';
        }).reverse().join('');
        // Cursor sits INSIDE the open span(s), right after the last char.
        element.innerHTML = visibleHtml + cursorHtml + openClosers;
        scrollFn();
      }

      function step() {
        if (cancelled) return;
        // Burn through any tag tokens (instant) until the next char.
        while (idx < tokens.length && tokens[idx].type === 'tag') {
          visibleHtml += tokens[idx].html;
          idx++;
        }
        if (idx >= tokens.length) { finish(); return; }

        const tok = tokens[idx++];
        visibleHtml += tok.char;
        render();

        // Sound — every Nth visible char, and only if the char is printable.
        if (opts.tickSound && tok.char && tok.char.trim()) {
          charsSinceTick++;
          if (charsSinceTick >= opts.tickEvery) {
            charsSinceTick = 0;
            playSample('keyboard');
          }
        }

        let delay = opts.speed;
        if (opts.jitter) delay += (Math.random() * 2 - 1) * opts.jitter;
        if (opts.punctuationPause) delay += punctuationDelay(tok.char);
        if (delay < 1) delay = 1;

        timeoutId = setTimeout(step, delay);
      }

      step();
    });
  }

  // Presets — pass any of these names to setScreen via SCREEN_MODES.
  typewriter.modes = {
    type:   { speed: 40, jitter: 15, punctuationPause: true,  showCursor: true,  tickSound: true,  tickEvery: 6 },
    stream: { speed: 10, jitter: 0,  punctuationPause: false, showCursor: true,  tickSound: false                 },
    fast:   { speed: 4,  jitter: 0,  punctuationPause: false, showCursor: true,  tickSound: false                 },
    still:  { speed: 0,  jitter: 0,  punctuationPause: false, showCursor: false, tickSound: false                 },
  };

  // Per-screen mode mapping. 
  // null means "do not touch" (screen handles its own rendering)
  const SCREEN_MODES = {
    home:           'still',
    communication:  'still',
    instructions:   'stream',
    faq:            'fast',
    about:          'fast',
    lockout:        'stream',
    hello:          'still',     // intro line types in; chat replies use 'type' separately
    orientation:    null,
    failure:        null,
    'failure-end':  null,
  };



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
    // Cancel any in-flight failure-end stream
    if (typeof failureStreamTimeouts !== 'undefined') {
      failureStreamTimeouts.forEach(id => clearTimeout(id));
      failureStreamTimeouts = [];
    }
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
<span class="screen-line text-dim">home · communication · instructions · orientation · faq</span>
<span class="screen-line"> </span>`,

    communication: () => `
<span class="screen-line text-amber">// COMMUNICATION LOG — STATION 3 //</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">─────────────────────────────────────</span>
<span class="screen-line"> </span>
<span class="screen-line"><span class="text-dim">[DAY 0001]</span> Kelvin: A new partner. Brother, you'll do.</span>
<span class="screen-line"><span class="text-dim">[DAY 0001]</span> Desmond: Where am I? What is this place?</span>
<span class="screen-line"><span class="text-dim">[DAY 0001]</span> Kelvin: Don't ask questions. Just push the button.</span>
<span class="screen-line"><span class="text-dim">[DAY 0014]</span> Desmond: 4 8 15 16 23 42. Execute.</span>
<span class="screen-line"><span class="text-dim">[DAY 0092]</span> Desmond: What does the button DO, brother?</span>
<span class="screen-line"><span class="text-dim">[DAY 0092]</span> Kelvin: It saves the world.</span>
<span class="screen-line"><span class="text-dim">[DAY 0092]</span> Kelvin: That's all you need to know.</span>
<span class="screen-line"><span class="text-dim">[DAY 0301]</span> Desmond: There's blood on the ceiling.</span>
<span class="screen-line"><span class="text-dim">[DAY 0301]</span> Desmond: Who was here before?</span>
<span class="screen-line"><span class="text-dim">[DAY 0301]</span> Kelvin: Radzinsky. He didn't make it. Don't ask.</span>
<span class="screen-line"><span class="text-dim">[DAY 0824]</span> Desmond: I dreamed of Penny again.</span>
<span class="screen-line"><span class="text-dim">[DAY 1093]</span> Kelvin: I'll be in the jungle. Push the button.</span>
<span class="screen-line"><span class="text-dim">[DAY 1094]</span> <span class="text-red">[KELVIN INMAN — DISCONNECTED]</span></span>
<span class="screen-line"><span class="text-dim">[DAY 1094]</span> <span class="text-red">SYSTEM FAILURE.</span></span>
<span class="screen-line"><span class="text-dim">[DAY 1094]</span> <span class="text-amber">[ANOMALY DETECTED — 09:16:00]</span></span>
<span class="screen-line"><span class="text-dim">[DAY 1094]</span> Desmond: I killed them. I killed them all.</span>
<span class="screen-line"><span class="text-dim">[DAY 1136]</span> Locke: We came through the ceiling. What does it DO?</span>
<span class="screen-line"><span class="text-dim">[DAY 1136]</span> Jack: Nothing. Push it anyway.</span>
<span class="screen-line"><span class="text-dim">[DAY 1138]</span> <span class="text-red">[ TRANSMISSION ENDS ]</span></span>
<span class="screen-line"> </span><span class="screen-line text-dim">─────────────────────────────────────</span>`,

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
<div class="orient-fullscreen">
  <div class="orient-header">
    <span class="orient-header-line text-amber">// ORIENTATION FILM — REEL B //</span>
    <span class="orient-header-line text-dim">DR. MARVIN CANDLE — DHARMA INITIATIVE</span>
  </div>
  <button class="orient-exit-btn" id="orient-exit-btn" title="Exit (Esc)">[× EXIT]</button>
  <div class="orient-video-wrap">
    <video class="orient-video" id="orient-video" autoplay controls playsinline>
      <source src="assets/orientation.mp4" type="video/mp4">
    </video>
    <div class="orient-fallback" id="video-fallback">
      <span class="text-red">&gt; REEL NOT FOUND.</span><br>
      <span class="text-dim">Upload to /assets/orientation.mp4</span>
    </div>
  </div>
</div>`,

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
<span class="screen-line">A: home · communication · instructions · orientation · faq</span>
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
<span class="screen-line text-dim">─────────────────────────────────────</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line">The Swan Station is a fan tribute to ABC's <span class="text-amber">LOST</span> (2004–2010) and a working 108-minute countdown timer. Push the button. Or don't.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-amber">// WHY THIS EXISTS //</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line">LOST is where my love of TV series began. I was watching shows before, but LOST is the one that revolutionized the medium and me. The DHARMA Initiative, the stations, the counter, the mysterious hieroglyphics... they were the fuel to my curiosity.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line">I always wanted to make the counter for myself. Now that I'm vibe coding and building little pages for things I love, I finally got around to it. An old wish, come true.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-amber">// CREDITS & INSPIRATIONS //</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line"><span class="text-dim">·</span> LOST (2004–2010). J.J. Abrams & Damon Lindelof</span>
<span class="screen-line"><span class="text-dim">·</span> The DHARMA Initiative (for the clip & octagons)</span>
<span class="screen-line"><span class="text-dim">·</span> <a href="https://lostpedia.fandom.com/" target="_blank" rel="noopener">Lostpedia</a> (for reference material)</span>
<span class="screen-line"><span class="text-dim">·</span> Mark Snow's score (had on loop while building this)</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-amber">// DISCLAIMER //</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">This is an unofficial fan tribute. Not affiliated with, endorsed by, or sponsored by ABC, Disney, Bad Robot, or the DHARMA Initiative. All trademarks and copyrights belong to their respective owners.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">No island was harmed in the making of this site.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">─────────────────────────────────────</span>
<span class="screen-line text-amber">Namaste. And good luck.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-dim">Type <span class="text-amber">faq</span> for usage details, or <span class="text-amber">home</span> to return to the station.</span>
<span class="screen-line"> </span>`,

    'failure-end': () => `<div id="failure-end-content"></div>`,

    hello: () => `
<span class="screen-line text-amber">// INCOMING TRANSMISSION //</span>
<span class="screen-line text-dim">─────────────────────────────────────</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line"><span class="text-dim">&gt;</span> Hello. Who is this?</span>
<span class="screen-line"> </span>`,

    lockout: () => `
<span class="screen-line text-red blink">⚠ WARNING — STATION 3 PROTOCOL ⚠</span>
<span class="screen-line text-dim">─────────────────────────────────────</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line">Do <span class="text-red">NOT</span> attempt to use the computer for anything else other than entering the code. This is its <span class="text-amber">ONLY</span> function.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line">The isolation that attends the duties associated with <span class="text-amber">Station 3</span> may tempt you to try and utilise the computer for communication with the outside world.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line">This is <span class="text-red">strictly forbidden</span>. Attempting to use the computer in this manner will compromise the integrity of the project and, worse, could lead to <span class="text-red">another incident</span>.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line">I repeat — <span class="text-red blink">DO NOT</span> use the computer for anything other than entering the code.</span>
<span class="screen-line">&nbsp;</span>
<span class="screen-line text-amber">— DHARMA INITIATIVE</span>
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
    // Cancel any in-flight typewriter animation immediately.
    typewriterCancel();

    // If we are leaving the hello screen, terminate any active chat session.
    if (chatActive && key !== 'hello') endChat();

    // If we are leaving the orientation screen, pause any playing video so
    // its audio doesn't continue in the background (innerHTML rewrite usually
    // handles this but we're being explicit).
    if (activeNav === 'orientation' && key !== 'orientation') {
      const prevVideo = document.getElementById('orient-video');
      if (prevVideo) { try { prevVideo.pause(); } catch(e) {} }
    }

    activeNav = key;
    const fn = SCREENS[key];
    const html = fn ? fn() : SCREENS.home();
    const screenContent = document.getElementById('screen-content');

    // Pick rendering mode for this screen.
    const modeName = SCREEN_MODES.hasOwnProperty(key) ? SCREEN_MODES[key] : 'stream';
    if (modeName === null) {
      // Screen handles its own rendering (orientation, failure-end).
      screenContent.innerHTML = html;
    } else {
      const mode = typewriter.modes[modeName] || typewriter.modes.stream;
      const scrollEl = document.getElementById('screen-scroll');
      typewriter(screenContent, html, Object.assign({}, mode, { scrollEl }));
    }

    // Toggle fullscreen-monitor mode for the orientation film.
    const monitor = document.getElementById('monitor-screen');
    if (monitor) {
      monitor.classList.toggle('monitor-fullscreen', key === 'orientation');
    }

    // Inject input area (except pure failure screen and fullscreen orientation)
    const inputArea = document.getElementById('screen-input-area');
    if (key === 'failure' || key === 'orientation') {
      inputArea.innerHTML = '';
    } else {
      inputArea.innerHTML = termInputHTML();
    }
    // Auto-focus input on screen change.
    // On touch devices, suppress the OS keyboard so only our virtual keyboard shows.
    setTimeout(() => {
      const i = document.getElementById('code-input');
      if (!i) return;
      if (window.matchMedia('(pointer: coarse)').matches) {
        i.setAttribute('readonly', '');
        i.setAttribute('inputmode', 'none');
      }
      i.focus();
    }, 40);

    // Wire orientation fallback + auto-exit on end
    if (key === 'orientation') {
      const v = document.getElementById('orient-video');
      const fb = document.getElementById('video-fallback');
      if (v && fb) {
        // Hide fallback by default; only show on error / missing file.
        fb.style.display = 'none';
        v.addEventListener('error', () => {
          v.style.display = 'none';
          fb.style.display = 'flex';
        });
        v.addEventListener('ended', () => {
          // Brief "transmission complete" beat, then back to home.
          if (activeNav !== 'orientation') return;
          const wrap = v.closest('.orient-video-wrap');
          if (wrap) {
            const done = document.createElement('div');
            done.className = 'orient-complete';
            done.innerHTML = '<span class="text-amber">// TRANSMISSION COMPLETE //</span>';
            wrap.appendChild(done);
          }
          setTimeout(() => {
            if (activeNav === 'orientation') setScreen('home');
          }, 1800);
        });
        setTimeout(() => {
          if (!v.duration || isNaN(v.duration)) {
            v.style.display = 'none';
            fb.style.display = 'flex';
          }
        }, 2000);
      }
    }

    // Stream failure-end lines one by one for dramatic effect
    if (key === 'failure-end') {
        streamFailureEnd();
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
    'communication': 'communication', 'communications': 'communication', 'comms': 'communication',
    'instructions': 'instructions', 'instr': 'instructions', 'i': 'instructions', 'instruction': 'instructions',
    'orientation': 'orientation', 'orient': 'orientation', 'video': 'orientation', 'o': 'orientation',
    'faq': 'faq', 'help': 'faq', 'help me': 'faq',
    'about': 'about',
    'hello': 'hello', 'hi': 'hello',
    'comm': 'communication', 'communication': 'communication', 'comms': 'communication',
  };

  function normalizeCode(str) {
    return str.trim().replace(/\s+/g,' ').replace(/[^0-9 ]/g,'');
  }
  function checkCode(raw) {
    const nums = normalizeCode(raw).split(' ').map(Number).filter(n => !isNaN(n) && n > 0);
    return JSON.stringify(nums) === JSON.stringify(CORRECT_NUMS);
  }

  // ── CHAT HELPERS (Michael/Walt "hello" sequence) ──
  // Normalize a user reply for matching: lowercase, strip punctuation,
  // collapse whitespace. Keeps letters, digits, and spaces.
  function normalizeReply(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Append a chat exchange to the screen content. `userText` is what the
  // user typed (appears instantly); `replyHtml` is the system's response
  // (typed character-by-character).
  function appendChat(userText, replyHtml) {
    const content = document.getElementById('screen-content');
    if (!content) return;
    // If a typewriter is still running (e.g. the intro line hasn't
    // finished typing), skip it to completion so the visible state is
    // coherent before we append the next exchange.
    if (typewriterIsActive()) typewriterSkip();

    const userLine = document.createElement('span');
    userLine.className = 'screen-line';
    userLine.innerHTML = `<span class="screen-prompt">&gt;:</span> ${escapeHtml(userText)}`;
    content.appendChild(userLine);

    if (replyHtml) {
      const spacer = document.createElement('span');
      spacer.className = 'screen-line';
      spacer.innerHTML = '&nbsp;';
      content.appendChild(spacer);

      const reply = document.createElement('span');
      reply.className = 'screen-line';
      // Type only the dynamic reply portion. The "> " prefix appears
      // instantly so the user can see a new transmission is incoming.
      reply.innerHTML = '<span class="text-dim">&gt;</span> <span class="tw-target"></span>';
      content.appendChild(reply);

      const spacer2 = document.createElement('span');
      spacer2.className = 'screen-line';
      spacer2.innerHTML = '&nbsp;';
      content.appendChild(spacer2);

      const scr = document.getElementById('screen-scroll');
      const target = reply.querySelector('.tw-target');
      typewriter(target, replyHtml, Object.assign({}, typewriter.modes.type, { scrollEl: scr }));
    }

    // Scroll to bottom (also done per-char by typewriter)
    const scr = document.getElementById('screen-scroll');
    if (scr) setTimeout(() => scr.scrollTop = scr.scrollHeight, 30);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ));
  }

  // Returns true if the normalized reply matches step 0 (introducing a name).
  // Accepts: "this is X", "this is X who is this", "i am X", "my name is X".
  // X must be at least one non-empty word.
  function matchIntroReply(n) {
    if (!n) return false;
    // "this is <name>" (optionally followed by anything)
    if (/^this is [a-z0-9]+/.test(n)) return true;
    // "i am <name>"
    if (/^i am [a-z0-9]+/.test(n)) return true;
    if (/^i m [a-z0-9]+/.test(n)) return true;
    if (/^im [a-z0-9]+/.test(n)) return true;
    // "it is <name>"
    if (/^it is [a-z0-9]+/.test(n)) return true;
    if (/^it s [a-z0-9]+/.test(n)) return true;
    if (/^its [a-z0-9]+/.test(n)) return true;
    // "my name is <name>"
    if (/^my name is [a-z0-9]+/.test(n)) return true;
    return false;
  }

  // Step 1: "Dad?" — accepts yes / yeah / son / walt / "are you ok".
  function matchDadReply(n) {
    if (!n) return false;
    if (n === 'yes' || n === 'yeah') return true;
    if (n === 'son' || n === 'walt') return true;
    if (n === 'are you ok' || n === 'are you okay') return true;
    return false;
  }

  // Step 2: "Are you alone?" — accepts yes / yeah / sure / yup / "i am",
  // each optionally followed by more text ("yes son" is fine).
  function matchAloneReply(n) {
    if (!n) return false;
    if (/^(yes|yeah|sure|yup|i am)(\b|$)/.test(n)) return true;
    return false;
  }

  // Begin the chat mode. Screen is already set to 'hello'.
  function startChat() {
    chatActive = true;
    chatStep = 0;
    if (chatTimeoutId) { clearTimeout(chatTimeoutId); chatTimeoutId = null; }
  }

  function endChat() {
    chatActive = false;
    chatStep = 0;
    if (chatTimeoutId) { clearTimeout(chatTimeoutId); chatTimeoutId = null; }
  }

  // Handle a user reply while chat is active. Returns true if handled.
  function handleChatInput(raw) {
    const n = normalizeReply(raw);

    if (chatStep === 0) {
      if (matchIntroReply(n)) {
        appendChat(raw, 'Dad?');
        chatStep = 1;
      } else {
        appendChat(raw, '<span class="text-dim">[NO RESPONSE]</span>');
      }
      return true;
    }

    if (chatStep === 1) {
      if (matchDadReply(n)) {
        appendChat(raw, 'Yes.<br>Are you alone?');
        chatStep = 2;
      } else {
        appendChat(raw, '<span class="text-dim">[NO RESPONSE]</span>');
      }
      return true;
    }

    if (chatStep === 2) {
      if (matchAloneReply(n)) {
        appendChat(raw, "Can't talk long. They are coming back soon...");
        chatStep = 3;
      } else {
        appendChat(raw, '<span class="text-dim">[NO RESPONSE]</span>');
      }
      return true;
    }

    if (chatStep === 3) {
      // Any reply triggers the final cut-off line, then auto-returns home.
      appendChat(raw, '<span class="text-red">You need to com</span>');
      chatStep = 4;
      // Disable further chat input until auto-return.
      chatActive = false;
      chatTimeoutId = setTimeout(() => {
        endChat();
        setScreen('home');
      }, 5000);
      return true;
    }

    return false;
  }


  // Lines for the failure-end sequence. [delayBefore_ms, html]
  const FAILURE_END_LINES = [
    [0,    `<span class="screen-line text-dim">... ... ...</span>`],
    [0,    `<span class="screen-line text-dim">... ... ...</span>`],
    [0,    `<span class="screen-line text-dim">... ... ...</span>`],
    [800,  `<span class="screen-line"> </span>`],
    [400,  `<span class="screen-line text-red">TIMER EXPIRED.</span>`],
    [500,  `<span class="screen-line">The button was not pushed.</span>`],
    [1200, `<span class="screen-line"> </span>`],
    [200,  `<span class="screen-line text-dim">The hieroglyphs lock into place.</span>`],
    [1100, `<span class="screen-line"> </span>`],
    [200,  `<span class="screen-line">Beneath the floor... the anomaly stirs.</span>`],
    [900,  `<span class="screen-line">A hum. Low. Then louder. Then everywhere.</span>`],
    [1300, `<span class="screen-line"> </span>`],
    [200,  `<span class="screen-line text-dim">Desmond reaches into a locker with the key.</span>`],
    [1500, `<span class="screen-line"> </span>`],
    [400,  `<span class="screen-line text-amber">"I'll see you in another life, brother."</span>`],
    [1800, `<span class="screen-line"> </span>`],
    [200,  `<span class="screen-line text-red">[ FAILSAFE ENGAGED ]</span>`],
    [400,  `<span class="screen-line text-red blink">█ █ █ DISCHARGE █ █ █</span>`],
    [1400, `<span class="screen-line"> </span>`],
    [300,  `<span class="screen-line text-dim">The sky turns violet. The island holds its breath.</span>`],
    [2200, `<span class="screen-line"> </span>`],
    [0,    `<span class="screen-line">&nbsp;</span>`],
    [0,    `<span class="screen-line">&nbsp;</span>`],
    [200,  `<span class="screen-line">You failed!</span>`],
    [1400, `<span class="screen-line"> </span>`],
    [300,  `<span class="screen-line text-amber">But the island isn't done with you yet.</span>`],
    [700,  `<span class="screen-line text-amber">We have to go back.</span>`],
    [800,  `<span class="screen-line">&nbsp;</span>`],
    [400,  `<span class="screen-line">Type <span class="text-amber" style="font-weight:bold">reset</span> to try again,</span>`],
    [200,  `<span class="screen-line text-dim">or type home and use ⚙ to set a new duration</span>`],
    [200,  `<span class="screen-line"> </span>`],
  ];

  let failureStreamTimeouts = [];

  function streamFailureEnd() {
  // Clear any prior pending lines (in case of re-entry)
    failureStreamTimeouts.forEach(id => clearTimeout(id));
    failureStreamTimeouts = [];

    const container = document.getElementById('failure-end-content');
    if (!container) return;
    container.innerHTML = '';

    let cumulative = 0;
    FAILURE_END_LINES.forEach(([delay, html]) => {
      cumulative += delay;
      const id = setTimeout(() => {
        // Bail if user has navigated away
        if (!document.getElementById('failure-end-content')) return;
        container.insertAdjacentHTML('beforeend', html);
        const scr = document.getElementById('screen-scroll');
        if (scr) scr.scrollTop = scr.scrollHeight;
      }, cumulative);
      failureStreamTimeouts.push(id);
    });
  }

  function submitInput() {
    const input = document.getElementById('code-input');
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;
    const lower = val.toLowerCase();

    // If a chat session is active, route through chat handler.
    // Exception: allow the user to bail out by typing 'home'.
    if (chatActive) {
      if (lower === 'home' || lower === 'h') {
        input.value = '';
        endChat();
        setScreen('home');
        return;
      }
      input.value = '';
      handleChatInput(val);
      return;
    }

    // "reset" command — restart the system using the last-set duration.
    // Only meaningful after failure, but harmless any other time.
    if (lower === 'reset' || lower === 'restart') {
       input.value = '';
       invalidAttempts = 0;
       playAccept();
       resetTimer(totalSeconds);
      setScreen('home');
      printResponse('<span class="text-amber">&gt;: SYSTEM RESTARTED. NAMASTE.</span>');
      return;
    }

    // Check if it's a nav command
    if (COMMANDS[lower]) {
      input.value = '';
      invalidAttempts = 0;
      const target = COMMANDS[lower];
      setScreen(target);
      // If switching to hello, kick off the chat sequence.
      if (target === 'hello') startChat();
      return;
    }

    // Check if it's the numbers code
    if (checkCode(val)) {
      input.value = '';
      // Code is correct, but the processor is only armed in the final 4 min.
      // Entering early is rejected with a protocol warning (and does NOT
      // count as an "invalid command" attempt — it's the right code, wrong
      // time).
      if (remaining > WARN_AT && !isFailure) {
        playReject();
        printResponse('<span class="text-red">&gt;: PROCESSOR DISABLED UNTIL THE LAST 4 MIN.</span>');
        return;
      }
      invalidAttempts = 0;
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
      invalidAttempts++;
      playReject();
      if (invalidAttempts >= 2) {
        // Second bad input in a row → show the Station 3 protocol warning.
        invalidAttempts = 0;
        setScreen('lockout');
      } else {
        printResponse('<span class="text-red">&gt;: UNKNOWN COMMAND OR INVALID CODE.</span>');
      }
    }
  }

  // ── VIRTUAL KEYBOARD ──
  // Layout modelled on the Apple II+ keyboard from the Swan Station.
  // `l` = upper (shifted) glyph shown small at top of key.
  // `s` = main glyph (the unshifted character) shown large.
  // When only `l` is given, that's the sole label.
  const KB_ROWS = [
    // Row 1: number/symbol row + RESET on far right (no ESC here — ESC is row 2)
    [{l:'!',s:'1',k:'1'},{l:'"',s:'2',k:'2'},{l:'#',s:'3',k:'3'},{l:'$',s:'4',k:'4'},
     {l:'%',s:'5',k:'5'},{l:'&',s:'6',k:'6'},{l:"'",s:'7',k:'7'},{l:'(',s:'8',k:'8'},
     {l:')',s:'9',k:'9'},{l:'',s:'0',k:'0'},{l:'*',s:':',k:':'},{l:'',s:'=',k:'='},
     {l:'RESET',k:'Escape',c:'key-special key-w-1h'}],

    // Row 2: ESC, QWERTYUIOP, @, REPT, RETURN
    [{l:'ESC',k:'Escape',c:'key-special key-w-1'},
     {l:'Q',k:'q'},{l:'W',k:'w'},{l:'E',k:'e'},{l:'R',k:'r'},{l:'T',k:'t'},
     {l:'Y',k:'y'},{l:'U',k:'u'},{l:'I',k:'i'},{l:'O',k:'o'},{l:'P',k:'p'},
     {l:'@',k:'@'},{l:'REPT',k:'Repeat',c:'key-special'},
     {l:'RETURN',k:'Enter',c:'key-special key-w-1h'}],

    // Row 3: CTRL, ASDFGHJKL, ;+, '", ←, →
    [{l:'CTRL',k:'Control',c:'key-special key-w-1h'},
     {l:'A',k:'a'},{l:'S',k:'s'},{l:'D',k:'d'},{l:'F',k:'f'},{l:'G',k:'g'},
     {l:'H',k:'h'},{l:'J',k:'j'},{l:'K',k:'k'},{l:'L',k:'l'},
     {l:'+',s:';',k:';'},{l:'"',s:"'",k:"'"},
     {l:'←',k:'ArrowLeft',c:'key-special'},{l:'→',k:'ArrowRight',c:'key-special'}],

    // Row 4: SHIFT, ZXCVBNM, ,< .> /?  + big red EXECUTE replacing right SHIFT
    [{l:'SHIFT',k:'Shift',c:'key-special key-w-1h'},
     {l:'Z',k:'z'},{l:'X',k:'x'},{l:'C',k:'c'},{l:'V',k:'v'},{l:'B',k:'b'},
     {l:'N',k:'n'},{l:'M',k:'m'},
     {l:'<',s:',',k:','},{l:'>',s:'.',k:'.'},{l:'?',s:'/',k:'/'},
     {l:'EXECUTE',k:'Enter',c:'key-execute key-w-execute'}],

    // Row 5: spacebar only (thick, centred)
    [{l:'',k:' ',c:'key-w-space'}],
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
    // If a typewriter animation is running, ESC and Enter (when input is
    // empty) skip it instead of doing their normal action.
    if (typewriterIsActive()) {
      if (key === 'Escape' || (key === 'Enter' && !input.value)) {
        typewriterSkip();
        return;
      }
    }
    if (key === 'Enter') { submitInput(); return; }
    // Click sound for every virtual-keyboard press (mirrors physical typing).
    playSample('keyboard');
    if (key === 'Backspace') { input.value = input.value.slice(0,-1); }
    else if (key === 'Escape') { input.value = ''; }
    else if (['Tab','Shift','Control','Alt','Meta','Repeat','ArrowLeft','ArrowRight'].includes(key)) { /* ignore */ }
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
    if (isNaN(v)||v<1||v>999) return;
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

      // Skip in-flight typewriter when user clicks anywhere on the monitor
      // screen — but only if the click isn't on an interactive element
      // (input, button, link). We check this BEFORE the early-return
      // handlers below so the skip fires even when the click target is
      // the monitor background.
      if (typewriterIsActive()) {
        const inMonitor = t.closest('#monitor-screen');
        const interactive = t.closest('input, button, a, video, .orient-exit-btn');
        if (inMonitor && !interactive) {
          typewriterSkip();
          // Don't return — let the rest of the click handler run normally.
        }
      }

      // Execute button
      if (t.id === 'btn-execute' || t.closest('#btn-execute')) { submitInput(); return; }

      // Orientation EXIT button
      if (t.id === 'orient-exit-btn' || t.closest('#orient-exit-btn')) {
        setScreen('home');
        return;
      }

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
      if (stBtn) { showStationModal(stBtn.dataset.station); return; }

      // Station modal close
      if (t.id === 'station-modal-close') { document.getElementById('station-modal').classList.remove('open'); return; }
      if (t.id === 'station-modal') { document.getElementById('station-modal').classList.remove('open'); return; }


    });

    // Physical keyboard
    document.addEventListener('keydown', e => {
      highlightKey(e.key);
      const inp = document.getElementById('code-input');
      const typingInInput = inp && document.activeElement === inp;

      // Skip in-flight typewriter on Esc or Enter (when input is empty).
      // Doing this BEFORE the regular Enter/Esc handlers below means a
      // single key press first skips the animation; a second press
      // proceeds with the normal Enter/Esc behaviour.
      if (typewriterIsActive()) {
        if (e.key === 'Escape' || (e.key === 'Enter' && (!inp || !inp.value))) {
          typewriterSkip();
          if (e.key === 'Enter') e.preventDefault();
          return;
        }
      }

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
      if (e.key === 'Escape') {
        const menuOpen = document.getElementById('menu-overlay').classList.contains('open');
        const settingsOpen = document.getElementById('settings-modal').classList.contains('open');
        const stationOpen = document.getElementById('station-modal').classList.contains('open');
        // Close only the topmost open layer so the user stays in their context
        // (e.g. closing a station modal returns to the menu underneath).
        if (stationOpen) {
          document.getElementById('station-modal').classList.remove('open');
        } else if (settingsOpen) {
          closeSettings();
        } else if (menuOpen) {
          closeMenu();
        } else if (activeNav === 'orientation') {
          setScreen('home');
        }
      }
    });

    // Settings enter key
    document.getElementById('settings-minutes').addEventListener('keydown', e => {
      if (e.key === 'Enter') applySettings();
    });
  }

  // Map station display name (from data-station) → logo filename.
  const STATION_LOGOS = {
    'Flame':         'assets/Logo_TheFlame.png',
    'Hydra':         'assets/Logo_TheHydra.png',
    'Arrow':         'assets/Logo_TheArrow.png',
    'Pearl':         'assets/Logo_ThePearl.png',
    'Looking Glass': 'assets/Logo_LookingGlass.png',
    'Orchid':        'assets/Logo_TheOrchid.png',
  };

  function showStationModal(name) {
    const m = document.getElementById('station-modal');
    const logo = document.getElementById('station-modal-logo');
    if (logo) {
      const src = STATION_LOGOS[name];
      if (src) {
        logo.src = src;
        logo.alt = 'The ' + name;
        logo.style.display = '';
      } else {
        logo.style.display = 'none';
      }
    }
    document.getElementById('station-modal-title').textContent = 'THE ' + name.toUpperCase();
    document.getElementById('station-modal-desc').innerHTML =
      'ACCESS: <span style="color:var(--red-alarm)">CLASSIFIED</span><br><br>This station is not yet operational.<br><br>Namaste.';
    m.classList.add('open');
  }

  function closeMobileDrawer() {}

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

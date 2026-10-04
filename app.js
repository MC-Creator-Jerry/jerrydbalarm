(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const thresholdEl = $('threshold');
  const soundOnEl = $('soundOn');
  const notifyOnEl = $('notifyOn');
  const startBtn = $('startBtn');
  const testBtn = $('testBtn');
  const ackBtn = $('ackBtn');
  const dbValEl = $('dbVal');
  const statusEl = $('status');
  const barFill = $('barFill');
  const thrMark = $('thrMark');
  const peakValEl = $('peakVal');
  const offValEl = $('offVal');
  const calibInput = $('calibInput');
  const calibBtn = $('calibBtn');
  const calibReset = $('calibReset');
  const alarmEl = $('alarm');
  const alarmDbEl = $('alarmDb');

  const MAX_DB = 130;
  const HYST_DB = 5;        // 迟滞：低于 阈值-HYST 才解除报警，避免阈值附近反复闪烁
  const HOLD_MS = 800;      // 必须持续超标这么久才报警（防瞬间抖动误报）
  const BEEP_GAP_MS = 700;  // 报警时蜂鸣间隔
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  let audioCtx = null;
  let analyser = null;
  let stream = null;
  let rafId = null;
  let running = false;
  let offset = 94;          // assumed dB SPL at 0 dBFS
  let peak = -Infinity;
  let smoothDb = null;
  let lastRawDb = 0;

  // 报警状态机：ARMED(布防监听) -> ALARMING(报警中) -> MUTED(已静音,仍监听) -> 安静后回到 ARMED
  let alarmState = 'ARMED';
  let overSince = 0;        // 开始超标的时刻(performance.now)
  let lastBeep = 0;
  let testActive = false;   // 测试警报进行中，期间不触发/不隐藏真实报警

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function updateThresholdMark() {
    const t = clamp(parseFloat(thresholdEl.value) || 0, 0, MAX_DB);
    thrMark.style.left = (t / MAX_DB * 100) + '%';
  }

  function resetAlarmState() {
    alarmState = 'ARMED';
    overSince = 0;
    setAlarm(false, 0);
  }

  async function start() {
    if (running) { stop(); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
    } catch (e) {
      alert('无法访问麦克风 / Mic access denied:\n' + e.message);
      return;
    }
    if (notifyOnEl.checked && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.1;
    src.connect(analyser);
    running = true;
    peak = -Infinity;
    smoothDb = null;
    resetAlarmState();
    startBtn.textContent = '■ 停止 / Stop';
    startBtn.classList.remove('primary');
    loop();
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (audioCtx) audioCtx.close();
    audioCtx = analyser = stream = null;
    smoothDb = null;
    testActive = false;
    dbValEl.textContent = '--';
    barFill.style.width = '0%';
    barFill.className = 'bar-fill';
    peakValEl.textContent = '--';
    resetAlarmState();
    setStatus('待机 / Idle', '');
    startBtn.textContent = '▶ 开始监测 / Start';
    startBtn.classList.add('primary');
  }

  function loop() {
    if (!running) return;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    let dbfs = rms > 0 ? 20 * Math.log10(rms) : -100;
    if (!isFinite(dbfs)) dbfs = -100;
    const db = dbfs + offset;
    lastRawDb = db;
    smoothDb = smoothDb == null ? db : smoothDb * 0.8 + db * 0.2;
    const shown = clamp(smoothDb, 0, MAX_DB);

    dbValEl.textContent = shown.toFixed(1);
    barFill.style.width = (shown / MAX_DB * 100) + '%';

    const t = clamp(parseFloat(thresholdEl.value) || 0, 0, MAX_DB);
    barFill.className = 'bar-fill ' + (shown >= t ? 'over' : shown >= t * 0.85 ? 'warn' : 'ok');

    if (db > peak) peak = db;
    peakValEl.textContent = clamp(peak, 0, MAX_DB).toFixed(1);

    // 测试警报期间：只更新仪表，不动真实报警状态
    if (!testActive) updateAlarm(shown, t);

    rafId = requestAnimationFrame(loop);
  }

  function updateAlarm(shown, t) {
    const now = performance.now();
    if (shown >= t) {
      if (alarmState === 'ARMED') {
        if (!overSince) overSince = now;
        else if (now - overSince >= HOLD_MS) {
          alarmState = 'ALARMING';
          setAlarm(true, shown);
          if (notifyOnEl.checked) fireNotify(shown);
        }
      }
      // ALARMING / MUTED 时保持，等安静后重新布防
    } else if (shown < t - HYST_DB) {
      // 已回到安全区 -> 解除并重新布防
      overSince = 0;
      if (alarmState !== 'ARMED') {
        alarmState = 'ARMED';
        setAlarm(false, shown);
      }
    }

    // 状态文案（避开测试态）
    if (alarmState === 'ARMED') {
      setStatus('✅ 安全 / Safe', 'safe');
    } else if (alarmState === 'ALARMING') {
      setStatus('⚠ 超标 / Over limit', 'danger');
    } else if (alarmState === 'MUTED') {
      setStatus('🔕 已静音 · 安静后重新布防 / Muted, re-arm when quiet', 'muted');
    }

    // 报警中且开启声音 -> 周期性蜂鸣（不再自递归死循环）
    if (alarmState === 'ALARMING' && soundOnEl.checked && audioCtx) {
      if (now - lastBeep >= BEEP_GAP_MS) { lastBeep = now; beepOnce(); }
    }
  }

  function setAlarm(on, db) {
    if (on) {
      alarmEl.classList.remove('hidden');
      alarmDbEl.textContent = db > 0 ? db.toFixed(1) : '--';
    } else {
      alarmEl.classList.add('hidden');
    }
  }

  function fireNotify(db) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification('噪音警报 / Noise Alarm', { body: '当前 ' + db.toFixed(0) + ' dB 超过阈值' });
  }

  function beepOnce() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.25, now + 0.02);
    g.gain.linearRampToValueAtTime(0, now + 0.18);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }

  // 用户在报警时点击「知道了」-> 静音本次，保留监听；安静后自动重新布防
  ackBtn.addEventListener('click', () => {
    if (alarmState === 'ALARMING') {
      alarmState = 'MUTED';
      setAlarm(false, 0);
    }
  });

  testBtn.addEventListener('click', async () => {
    let ctx = audioCtx;
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    testActive = true;
    alarmDbEl.textContent = 'TEST';
    alarmEl.classList.remove('hidden');
    let n = 0;
    const iv = setInterval(() => {
      beepOnce();
      if (++n >= 3) {
        clearInterval(iv);
        setTimeout(() => {
          if (!running || alarmState === 'ARMED') alarmEl.classList.add('hidden');
          testActive = false;
        }, 500);
        if (!audioCtx) ctx.close();
      }
    }, 500);
  });

  calibBtn.addEventListener('click', () => {
    const known = parseFloat(calibInput.value);
    if (!isFinite(known) || known <= 0) { alert('请输入已知分贝 / Enter a known dB value'); return; }
    if (!running) { alert('请先开始监测并制造该音量 / Start monitoring first'); return; }
    offset = known - lastRawDb;
    offValEl.textContent = offset.toFixed(1);
  });

  calibReset.addEventListener('click', () => {
    offset = 94;
    offValEl.textContent = '94';
    calibInput.value = '';
  });

  thresholdEl.addEventListener('input', updateThresholdMark);
  startBtn.addEventListener('click', start);

  updateThresholdMark();
  setStatus('待机 / Idle', '');
})();

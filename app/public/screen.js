/* 大屏展示端逻辑 */
let S = null;            // 最新状态快照
let rollTimer = null;
let pageTimers = [];
let soundCtx = null;
let volume = 0.3;
const $ = id => document.getElementById(id);

/* ---------- 声音 ---------- */
function ensureAudio() {
  try {
    soundCtx = soundCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (soundCtx.state === 'suspended') soundCtx.resume(); // 解除浏览器自动播放限制
  } catch (e) {}
}
// 首次任意触摸/按键即解锁声音（自动播放策略要求用户手势）
['pointerdown', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, ensureAudio));
function beep(freq, dur, when = 0, vol = 1) {
  try {
    if (S && S.voiceMode === 'ai' && ttsOK) return; // 仅AI播报且AI可用时才静音提示音（AI不可用则降级保留提示音）
    ensureAudio();
    const o = soundCtx.createOscillator(), g = soundCtx.createGain();
    o.frequency.value = freq; o.type = 'sine';
    g.gain.setValueAtTime(volume * vol, soundCtx.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.0001, soundCtx.currentTime + when + dur);
    o.connect(g); g.connect(soundCtx.destination);
    o.start(soundCtx.currentTime + when); o.stop(soundCtx.currentTime + when + dur);
  } catch (e) {}
}
const sfx = {
  rollTick: () => beep(660, 0.05, 0, 0.5),
  reveal: () => { beep(523, 0.12); beep(784, 0.18, 0.12); },
  page: () => { beep(880, 0.15); beep(880, 0.15, 0.25); beep(1174, 0.3, 0.5); },
  countEnd: () => { for (let i = 0; i < 3; i++) beep(988, 0.1, i * 0.18); }
};

/* ---------- AI 语音播报（Web Speech API，Windows 自带离线中文语音） ---------- */
let ttsVoice = null, ttsOK = false;
function initVoice() {
  if (!('speechSynthesis' in window)) return;
  const load = () => {
    const vs = speechSynthesis.getVoices();
    ttsVoice = vs.find(v => /^zh/i.test(v.lang)) || null;
    ttsOK = !!ttsVoice;
    if (ttsOK && document.getElementById('voiceStatus')) document.getElementById('voiceStatus').textContent = 'AI 播报可用（' + ttsVoice.name + '）';
  };
  load();
  speechSynthesis.onvoiceschanged = load; // 部分浏览器语音异步加载
}
initVoice();
function speak(text) {
  if (!('speechSynthesis' in window) || !ttsVoice) return;
  if (!S || S.voiceMode === 'sound') return;      // 关闭时静默
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = ttsVoice; u.lang = ttsVoice.lang || 'zh-CN';
    u.rate = 1.0; u.volume = Math.max(0.15, S.volume || 0.3);
    speechSynthesis.speak(u);
  } catch (e) {}
}
function voiceModeAllowsAI() { return S && (S.voiceMode === 'ai' || S.voiceMode === 'both'); }

/* ---------- SSE ---------- */
const es = new EventSource('/events');
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.event === 'state') { S = msg.state; render(); }
  else if (msg.event === 'rollStart') startRoll(msg);
  else if (msg.event === 'rollResult') showResult(msg.names);
  else if (msg.event === 'answerStart') showAnswerStart();
  else if (msg.event === 'marked') showMark(msg.result);
  else if (msg.event === 'skipped') { }
  else if (msg.event === 'page') { /* 传呼状态由随后的 state 推送统一渲染，避免重复弹卡/播报 */ }
};
es.onerror = () => { /* EventSource 自动重连 */ };

/* ---------- 视图切换 ---------- */
function view(name) {
  for (const v of ['standby', 'rolling', 'result', 'answering']) $(v).style.display = v === name ? '' : 'none';
}
function startRoll(msg) {
  const duration = msg.duration || 3000;
  const style = msg.style || 'slot';
  const pool = (msg.pool && msg.pool.length ? msg.pool : (S ? S.students.map(s => s.name) : ['张三', '李四', '王五']));
  slotPending = msg.resultNames || null;
  view('rolling');
  clearInterval(rollTimer);
  stopSlot();
  if (style === 'classic') {
    $('rollName').style.display = '';
    $('slotMachine').style.display = 'none';
    $('slotTip').style.display = 'none';
    rollTimer = setInterval(() => {
      $('rollName').textContent = pool[Math.floor(Math.random() * pool.length)];
      sfx.rollTick();
    }, 90);
  } else {
    $('rollName').style.display = 'none';
    $('slotMachine').style.display = '';
    $('slotTip').style.display = '';
    startSlot(Math.max(1, Math.min(4, msg.slots || 1)), pool, duration);
  }
}

/* ---------- 老虎机：多列滚轮，逐列减速停止 ---------- */
let slotTimers = [];
let slotPending = null;   // 本轮真实结果（rollStart 携带），定格时滚轮对齐到它，杜绝"抽到的人不一样"
function stopSlot() {
  slotTimers.forEach(t => { clearTimeout(t); clearInterval(t); });
  slotTimers = [];
  if (stopSlot._raf) { cancelAnimationFrame(stopSlot._raf); stopSlot._raf = null; }
}
function startSlot(cols, pool, duration) {
  const box = $('slotMachine');
  box.innerHTML = '';
  const rowH = Math.max(42, Math.round(window.innerHeight * 0.10));   // 行高 ≈ 10vmin
  const rows = 30;                                                     // 名单条长度（滚动连续性）
  const repeated = [];
  while (repeated.length < rows) repeated.push(...pool);
  const maxH = rows * rowH;
  const els = [];
  for (let i = 0; i < cols; i++) {
    const col = document.createElement('div');
    col.className = 'slot-col';
    const strip = document.createElement('div');
    strip.className = 'slot-strip';
    strip.innerHTML = repeated.map(n => `<div class="slot-row">${n}</div>`).join('');
    col.appendChild(strip);
    const win = document.createElement('div');
    win.className = 'slot-window';
    col.appendChild(win);
    box.appendChild(col);
    els.push({ col, strip, offset: (Math.random() * maxH) | 0, stopped: false, delay: Math.random() * 180 });
  }
  $('slotTip').textContent = cols > 1 ? `正在抽取 ${cols} 位同学…` : '谁是今天的幸运儿？';
  const t0 = Date.now();
  const spinEnd = Math.max(600, duration - 700);   // 转轮停止时间点（末段留给结果页）
  // requestAnimationFrame 驱动：速度按二次曲线从快衰减到 0，实现真"滚轮"减速
  const frame = () => {
    const el = Date.now() - t0;
    let running = false;
    els.forEach((c, i) => {
      if (c.stopped) return;
      const stopAt = spinEnd - (cols - 1 - i) * 260;   // 逐列依次停止
      if (el >= stopAt + c.delay) {
        // 定格：滚轮对齐到真实结果行（与 rollResult 完全一致，杜绝"抽到的人不一样"）
        c.stopped = true;
        const target = (slotPending && slotPending[i]) ? slotPending[i] : null;
        const idx = target ? repeated.indexOf(target) : -1;
        if (idx >= 0) {
          // 窗口显示第 idx 行 → offset 置为 (idx-1)*rowH，并按最近方向回绕滑动
          const to = (((idx - 1) * rowH) % maxH + maxH) % maxH;
          let d = to - c.offset;
          if (d > maxH / 2) d -= maxH;
          if (d < -maxH / 2) d += maxH;
          c.offset += d;
          const slide = Math.min(0.55, 0.05 + (Math.abs(d) / rowH) * 0.045);
          c.strip.style.transition = `transform ${slide}s cubic-bezier(.18,1.35,.3,1)`;
        } else {
          c.offset -= c.offset % rowH;
          c.strip.style.transition = 'transform 0.3s cubic-bezier(.2,1.7,.35,1)';
        }
        c.strip.style.transform = `translateY(${-c.offset}px)`;
        c.col.classList.add('stopped');
        beep(880, 0.12, 0, 0.8);
        return;
      }
      const prog = Math.min(1, el / stopAt);
      c.speed = 15 * (1 - prog * prog);              // 减速曲线：先快后慢
      c.offset += Math.max(0.2, c.speed);
      if (c.offset > maxH - rowH) c.offset -= maxH;  // 名单条回绕，保证无限滚动
      c.strip.style.transform = `translateY(${-c.offset}px)`;
      running = true;
    });
    if (running) {
      if (Math.random() < 0.4) sfx.rollTick();       // 滚动音效节流，避免刺耳
      stopSlot._raf = requestAnimationFrame(frame);
    }
  };
  frame();
}
function showResult(msg) {
  clearInterval(rollTimer);
  slotPending = null;   // 动画结束，清理对齐目标
  view('result');
  const names = msg.display || msg.names || [];
  $('resultNames').textContent = names.join('  ');
  // 组名小字（有组才显示）
  const groups = (msg.students || []).map(s => s.group).filter(Boolean);
  $('resultGroups').textContent = groups.length ? groups.join('  ·  ') : '';
  $('resultHint').textContent = names.length > 1 ? '请几位同学一起讨论' : '请回答问题';
  sfx.reveal();
  // AI 播报：请 XXX 同学回答问题
  if (voiceModeAllowsAI() && msg.names && msg.names.length) {
    speak(`${msg.names.join('、')} 同学，请回答问题`);
  }
}
function showAnswerStart() {
  render();
  if (voiceModeAllowsAI() && S && S.lastPick && S.lastPick.names) speak(`${S.lastPick.names.join('、')} 同学，请开始回答问题，计时开始`);
}
function showMark(result) {
  const tag = $('resultHint');
  view('result');
  const map = { right: ['答对了 ✅', 'right'], wrong: ['答错了 💪', 'wrong'], none: ['未作答 ⏰', 'none'] };
  const [txt, cls] = map[result] || map.none;
  tag.innerHTML = `<span class="mark-tag ${cls}">${txt}</span>`;
  setTimeout(() => { if (!S || !S.answering) render(); }, 3000);
}

/* ---------- 传呼 ---------- */
function clearPageTimers() { pageTimers.forEach(t => { clearTimeout(t); clearInterval(t); }); pageTimers = []; }
// 横幅（缩小常驻）：教师手机端"已到/撤回"后消失
function renderBanner(page) {
  $('pageOverlay').style.display = 'none';
  $('bnName').textContent = page.names.join('、');
  $('bnPlace').textContent = '→ ' + page.place;
  $('bnNote').textContent = page.note || '';
  $('pageBanner').style.display = '';
  // 未确认时每 2 分钟重新弹 8 秒提醒（防止学生没看见）
  const repop = setInterval(() => {
    if (!S || !S.page || S.page.confirmed || S.page.retracted || S.examMode) { clearInterval(repop); return; }
    if (S.page.sentAt !== page.sentAt) { clearInterval(repop); return; }
    $('pageOverlay').style.display = '';
    pageTimers.push(setTimeout(() => { $('pageOverlay').style.display = 'none'; }, 8000));
  }, 120000);
  pageTimers.push(repop);
}
function showPage(page) {
  if (!page || page.retracted || page.confirmed) { hidePage(); return; }
  clearPageTimers();
  const names = page.names.join('、');
  $('pName').textContent = names;
  $('pPlace').textContent = `请到「${page.place}」` + (page.from ? ` 找 ${page.from}` : '');
  $('pNote').textContent = page.note || '';
  $('pFrom').textContent = '请看到通知后及时前往';
  if (!S || !S.examMode) {
    sfx.page();
    // AI 播报：XX 同学，请到「教务处」找李老师，带上作业本（含留言）
    if (voiceModeAllowsAI()) {
      speak(`${names} 同学，请到「${page.place}」` + (page.from ? `，找 ${page.from}` : '') + (page.note ? `，${page.note}` : ''));
    }
  }
  if (S && S.examMode) { /* 考试模式只显示角落条，不弹卡不发声 */ return; }
  const dur = page.duration; // 秒，0=常驻
  if (dur > 0) { $('pageOverlay').style.display = ''; pageTimers.push(setTimeout(() => renderBanner(page), dur * 1000)); }
  else { $('pageOverlay').style.display = ''; }
}
function hidePage() {
  clearPageTimers();
  $('pageOverlay').style.display = 'none';
  $('pageBanner').style.display = 'none';
  sessionStorage.removeItem('csSeenPage');
}

/* ---------- 渲染 ---------- */
let lastPageKey = '';
function render() {
  if (!S) return;
  volume = S.volume; $('className').textContent = S.className;
  // 时钟
  const d = new Date();
  $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // 大屏URL提示
  // 教师端候选地址：服务端按网卡实时给出（网线/热点/USB共享自动适应）
  const urls = (S.ctrlUrls && S.ctrlUrls.length ? S.ctrlUrls : [location.href.replace('screen.html', 'ctrl.html')]);
  $('ctrlUrls').innerHTML = urls.map(u => `<div>${u}</div>`).join('');
  // 二维码（每个候选地址一张，手机扫码直达控制端；最多 3 张防挤爆，其余地址只显示文字）
  if (typeof qrcode === 'function' && S.ctrlUrls && S.ctrlUrls.length) {
    $('qrRow').innerHTML = S.ctrlUrls.slice(0, 3).map((u, i) => {
      try {
        const qr = qrcode(0, 'M');
        qr.addData(u); qr.make();
        return `<div class="qr-cell">${qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true })}<div>${i === 0 ? '← 手机扫码进控制端' : ''}</div></div>`;
      } catch (e) { return ''; }
    }).join('');
  }
  // 主视图
  if (S.answering) {
    view('answering');
    $('ansName').textContent = S.answering.name;
    const cd = $('countdown');
    if (!S.answering.deadline) { cd.className = 'countdown unlimited'; cd.textContent = '不限时'; }
    else {
      cd.className = 'countdown';
      if (render._cdTimer) clearInterval(render._cdTimer);
      const tick = () => {
        const left = Math.max(0, Math.ceil((S.answering.deadline - Date.now()) / 1000));
        cd.textContent = left;
        cd.classList.toggle('low', left <= 10);
        if (left <= 0) { clearInterval(render._cdTimer); sfx.countEnd(); cd.textContent = '时间到'; }
      };
      tick(); render._cdTimer = setInterval(tick, 500);
    }
  } else if ($('result').style.display !== 'none' && $('resultNames').textContent) {
    /* 保留结果与标记展示 */
  } else if (S.lastPick && !$('rolling').style.display) {
    /* 动画中不干扰 */
  } else {
    view('standby');
  }
  // 传呼（刷新去重：同标签页刷新过且已弹过的传呼，只挂横条不重复弹卡/播报）
  const p = S.page;
  const key = p ? p.sentAt : '';
  if (key !== lastPageKey) {
    lastPageKey = key;
    if (p && !p.retracted && !p.confirmed) {
      if (sessionStorage.getItem('csSeenPage') === String(key)) renderBanner(p); // 已看过：只挂横条
      else { showPage(p); sessionStorage.setItem('csSeenPage', String(key)); }   // 新传呼：弹卡+播报
    } else hidePage();
  }
  // 撤回 / 确认已到 → 横幅立即消失
  if (p && (p.retracted || p.confirmed)) hidePage();
  // 考试模式
  if (S.examMode) {
    $('pageOverlay').style.display = 'none';
    if (p && !p.retracted && !p.confirmed) {
      $('examText').textContent = p.names.join('、') + ' → ' + p.place;
      $('examStrip').style.display = '';
    } else $('examStrip').style.display = 'none';
    $('pageBanner').style.display = 'none';
  } else {
    $('examStrip').style.display = 'none';
  }
  // 本节课点名录
  $('lessonLog').innerHTML = (S.lessonLog || []).map(l => `<div>${(l.display || l.names).join('、')}</div>`).join('');
}
setInterval(() => { const d = new Date(); $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }, 10000);

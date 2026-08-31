/* 大屏展示端逻辑 */
let S = null;            // 最新状态快照
let rollTimer = null;
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
function beep(freq, dur, when = 0, vol = 1, type = 'sine') {
  try {
    ensureAudio();
    const o = soundCtx.createOscillator(), g = soundCtx.createGain();
    o.frequency.value = freq; o.type = type;
    g.gain.setValueAtTime(volume * vol, soundCtx.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.0001, soundCtx.currentTime + when + dur);
    o.connect(g); g.connect(soundCtx.destination);
    o.start(soundCtx.currentTime + when); o.stop(soundCtx.currentTime + when + dur);
  } catch (e) {}
}
// 白噪声脉冲：模拟机械咔哒声（滚动音效材质）
function playNoise(dur = 0.03, vol = 1, freq = 2400) {
  try {
    ensureAudio();
    const n = Math.max(1, Math.floor(soundCtx.sampleRate * dur));
    const buf = soundCtx.createBuffer(1, n, soundCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n); // 快速衰减
    const src = soundCtx.createBufferSource(); src.buffer = buf;
    const f = soundCtx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.1;
    const g = soundCtx.createGain();
    g.gain.setValueAtTime(volume * vol, soundCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, soundCtx.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(soundCtx.destination);
    src.start();
  } catch (e) {}
}
const sfx = {
  rollTick: () => playNoise(0.022, 0.5, 3000),                 // 滚动咔哒：短噪声脉冲
  reveal: () => { beep(523, 0.12); beep(784, 0.18, 0.12); },
  page: () => { beep(880, 0.15); beep(880, 0.15, 0.25); beep(1174, 0.3, 0.5); },
  countEnd: () => { for (let i = 0; i < 3; i++) beep(988, 0.1, i * 0.18); }
};

/* ---------- AI 语音播报（Web Speech API，Windows 自带离线中文语音） ---------- */
let ttsVoice = null, ttsOK = false;
function loadVoices() {
  if (!('speechSynthesis' in window)) return false;
  const vs = speechSynthesis.getVoices();
  if (vs && vs.length) {
    // 优先中文，其次任意可用语音兜底
    ttsVoice = vs.find(v => /^zh/i.test(v.lang)) || vs.find(v => v.lang) || vs[0];
    ttsOK = !!ttsVoice;
    const st = document.getElementById('voiceStatus');
    if (st) st.textContent = ttsOK ? 'AI 播报可用（' + ttsVoice.name + '）' : '当前设备无可用语音';
    return ttsOK;
  }
  return false;
}
function initVoice() {
  if (!('speechSynthesis' in window)) return;
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
  // 某些浏览器 voices 异步很晚，1 秒后再试一次
  setTimeout(() => { if (!ttsOK) loadVoices(); }, 1000);
}
initVoice();
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  if (!S || S.voiceMode === 'sound') return;      // 关闭时静默
  if (!ttsOK) loadVoices();
  if (!ttsVoice) return;                          // 设备无语音包则静默
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = ttsVoice; u.lang = ttsVoice.lang || 'zh-CN';
    u.rate = 1.0; u.volume = Math.max(0.35, S.volume || 0.3); // 避免音量太小听不见
    speechSynthesis.speak(u);
  } catch (e) {}
}
function voiceModeAllowsAI() { return S && (S.voiceMode === 'ai' || S.voiceMode === 'both'); }

/* ---------- SSE（携带访问密码，密码错误时弹出输入框） ---------- */
let es = null;
async function initSSE() {
  let pin = new URLSearchParams(location.search).get('pin') || localStorage.getItem('djPin') || '';
  for (let i = 0; i < 3; i++) {
    const r = await fetch('/api/state?pin=' + encodeURIComponent(pin)).catch(() => null);
    if (!r || r.status !== 401) break;
    pin = prompt('请输入访问密码') || '';
    localStorage.setItem('djPin', pin);
  }
  es = new EventSource('/events?pin=' + encodeURIComponent(pin));
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.event === 'state') { S = msg.state; render(); }
    else if (msg.event === 'rollStart') startRoll(msg);
    else if (msg.event === 'rollResult') showResult(msg.names);
    else if (msg.event === 'answerStart') showAnswerStart();
    else if (msg.event === 'marked') showMark(msg.result);
    else if (msg.event === 'skipped') { }
    else if (msg.event === 'page') {
      // 服务器先发 page 事件，再推 state；这里直接弹出大弹窗+音效，state 到达后不会再重复播放
      if (msg.page) { S = S || {}; showPage(msg.page); }
    }
  };
  es.onerror = () => { /* EventSource 自动重连 */ };
}
initSSE();

/* ---------- 大屏班级切换（有密码的班级需输入密码） ---------- */
function showMsg(t) {
  const el = $('screenToast');
  el.textContent = t; el.style.display = 'block';
  clearTimeout(showMsg._t); showMsg._t = setTimeout(() => el.style.display = 'none', 2400);
}
async function apiCmd(body) {
  let pin = localStorage.getItem('djPin') || new URLSearchParams(location.search).get('pin') || '';
  const r = await fetch('/api/cmd?pin=' + encodeURIComponent(pin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 401) { pin = prompt('请输入访问密码') || ''; localStorage.setItem('djPin', pin); return apiCmd(body); }
  return r.json().catch(() => ({}));
}
function toggleClassPicker(show) {
  $('classOverlay').style.display = show ? '' : 'none';
  if (show && S) {
    $('classList').innerHTML = (S.allClasses || []).map(c => {
      const cur = c.i === S.currentClass;
      return `<button class="cc-item${cur ? ' cur' : ''}" data-i="${c.i}">${c.locked ? '🔒 ' : ''}${c.name}${cur ? '（当前）' : ''}</button>`;
    }).join('');
  }
}
$('className').onclick = () => toggleClassPicker(true);
$('classClose').onclick = () => toggleClassPicker(false);
$('classOverlay').addEventListener('click', async e => {
  if (e.target === $('classOverlay')) { toggleClassPicker(false); return; }
  const btn = e.target.closest('.cc-item');
  if (!btn) return;
  const i = +btn.dataset.i;
  if (i === S.currentClass) { toggleClassPicker(false); return; }
  // 先无密码尝试（服务端会话已解锁过则直接通过，避免重复询问）
  let j = await apiCmd({ action: 'classSwitch', index: i });
  if (j && !j.ok && j.msg === '需要班级密码') {
    const target = (S.allClasses || []).find(c => c.i === i);
    const pass = prompt(`班级「${target ? target.name : ''}」已加密，请输入密码：`, '') || '';
    if (!pass) { toggleClassPicker(false); return; }
    j = await apiCmd({ action: 'classSwitch', index: i, pass });
  }
  toggleClassPicker(false);
  if (j && j.msg) showMsg(j.msg);
});

/* ---------- 视图切换 ---------- */
function view(name) {
  for (const v of ['standby', 'rolling', 'result', 'answering']) $(v).style.display = v === name ? '' : 'none';
}
function startRoll(msg) {
  const pool = (msg.pool && msg.pool.length ? msg.pool : (S ? S.students.map(s => s.name) : ['张三', '李四', '王五']));
  view('rolling');
  clearInterval(rollTimer); clearTimeout(rollTimer);
  $('rollName').classList.add('rolling');
  // 经典滚动：快速轮换姓名，逐次放慢 + 咔哒声，结束前 400ms 停止
  const spinEnd = Math.max(600, (msg.duration || 3000) - 400);
  const t0 = Date.now();
  const frame = () => {
    const el = Date.now() - t0;
    if (el >= spinEnd) { clearTimeout(rollTimer); return; }
    $('rollName').textContent = pool[Math.floor(Math.random() * pool.length)];
    // 滚动越久间隔越长（缓出感），最后阶段自然减速
    const prog = el / spinEnd;
    rollTimer = setTimeout(frame, 60 + prog * prog * 260);
    sfx.rollTick();
  };
  frame();
}

/* ---------- 老虎机已移除：仅保留经典滚动 ---------- */

function showResult(msg) {
  clearTimeout(rollTimer); clearInterval(rollTimer);
  $('rollName').classList.remove('rolling');
  view('result');
  const names = msg.display || msg.names || [];
  $('resultNames').textContent = names.join('  ');
  // 重触发弹入动画（结束后移除，让金色光晕动画恢复）
  $('resultNames').classList.add('pop-in');
  setTimeout(() => $('resultNames').classList.remove('pop-in'), 600);
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
function showPage(page) {
  if (!page || page.retracted || page.confirmed) { hidePage(); return; }
  const names = page.names.join('、');
  $('pName').textContent = names;
  $('pPlace').textContent = `请到「${page.place}」` + (page.from ? ` 找 ${page.from}` : '');
  $('pNote').textContent = page.note || '';
  $('pFrom').textContent = '请看到通知后及时前往';
  // 大弹窗居中常驻，直到教师端「已到 / 撤回」才消失
  if (S && S.examMode) { /* 考试模式只显示角落条，不弹卡不发声 */ return; }
  $('pageOverlay').style.display = '';
  if (lastPageSoundAt === page.sentAt) return;   // 同一传呼只播一次提示音/AI 语音
  lastPageSoundAt = page.sentAt;
  sfx.page();
  // AI 播报：XX 同学，请到「教务处」找李老师，带上作业本（含留言）
  if (voiceModeAllowsAI()) {
    speak(`${names} 同学，请到「${page.place}」` + (page.from ? `，找 ${page.from}` : '') + (page.note ? `，${page.note}` : ''));
  }
}
function hidePage() {
  $('pageOverlay').style.display = 'none';
  $('pageBanner').style.display = 'none';
}

/* ---------- 渲染 ---------- */
let lastPageKey = '';
let lastPageSoundAt = 0;
function render() {
  if (!S) return;
  // 答题结束后清理倒计时定时器（防止 tick 访问 null.answering 抛错）
  if (!S.answering && render._cdTimer) { clearInterval(render._cdTimer); render._cdTimer = null; }
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
  // 主视图：滚动动画进行中绝不切走（否则 skip 连抽等中间状态会把动画打回待机）
  if ($('rolling').style.display !== 'none') {
    /* 动画中保持滚动视图 */
  } else if (S.answering) {
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
  // 传呼：只要未确认/未撤回，大屏就显示居中大弹窗；showPage 内部保证同一传呼只播一次音
  const p = S.page;
  const key = p ? p.sentAt : '';
  if (p && !p.retracted && !p.confirmed) {
    lastPageKey = key;
    showPage(p);
  } else {
    // 已确认 / 已撤回 / 无传呼：一律收起弹窗
    lastPageKey = key;
    hidePage();
  }
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

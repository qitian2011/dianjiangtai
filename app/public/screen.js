/* 大屏展示端逻辑 */
let S = null;            // 最新状态快照
let rollTimer = null;
let soundCtx = null;
let volume = 0.3;
/* ==== v2.0.2 桌面端兼容：Electron 默认禁用 window.prompt/confirm/alert，优先用 djt.* 桥（main.js 注册的 sync IPC），浏览器 fallback 到原生 ==== */
const _djt=window.djt||{};
const _prompt=(_djt.prompt||window.prompt).bind(_djt.prompt||window);
const _confirm=(_djt.confirm||window.confirm).bind(_djt.confirm||window);
const _alert=(_djt.alert||window.alert).bind(_djt.alert||window);
const $ = id => document.getElementById(id);
// HTML 全量转义（P0-2 XSS 修复）：& < > " ' 五项全转，可同时用于文本节点与双引号属性
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

/* ---------- 声音 ---------- */
function ensureAudio() {
  try {
    soundCtx = soundCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (soundCtx.state === 'suspended') {
      const p = soundCtx.resume();            // 无用户手势时会被浏览器拒绝，静默处理
      if (p && p.catch) p.catch(() => {});
    }
    if (soundCtx.state === 'running') {       // 已解锁：收起提示浮层
      const ov = document.getElementById('unlockOverlay');
      if (ov) ov.style.display = 'none';
    }
  } catch (e) {}
}
// 首次任意触摸/按键即解锁声音（自动播放策略要求用户手势）
['pointerdown', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, ensureAudio));
// 开机声音解锁浮层：点一下就解锁（浏览器必须收到真实手势）
(function initUnlock() {
  const ov = document.getElementById('unlockOverlay');
  if (!ov) return;
  const unlock = () => { ensureAudio(); if (ov) ov.style.display = 'none'; };
  ov.addEventListener('pointerdown', unlock);
  ov.addEventListener('touchstart', unlock, { passive: true });
  setTimeout(() => { if (soundCtx && soundCtx.state === 'running') ov.style.display = 'none'; }, 800);
})();
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

/* ---------- SSE（?room=X 指定班级；无 room 默认打开示例班） ---------- */
let es = null;
let sseLastEvt = Date.now();   // 2026-09-07：最近一次收到服务器数据的时间（心跳 hb/state/事件），看门狗判活依据
function reopenSSE() {         // 2026-09-07：统一重连入口（onerror 与看门狗共用），防并发重复建连
  if (reopenSSE._t) return;
  reopenSSE._t = setTimeout(() => { reopenSSE._t = null; initSSE(); }, 30);
}
const ROOM = new URLSearchParams(location.search).get('room') || '1';
// 标签页会话 id：解锁态按标签页隔离（sessionStorage 关标签即清）——新开页面/新设备打开加密班级 URL 必弹密码框
const SID = (() => { let s = sessionStorage.getItem('djSid'); if (!s) { s = 's' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('djSid', s); } return s; })();
async function initSSE() {
  initSSE._gotState = false;   // v2.0.3: 每次重连重置，避免上一次的成功残留导致超时提示失效
  const r0 = await fetch(`/api/state?room=${ROOM}&sid=${SID}`).catch(() => null);
  if (r0 && r0.status === 404) { location.replace(location.pathname); return; }   // 房间失效：回首页自愈
  es = new EventSource(`/events?room=${ROOM}&sid=${SID}`);
  // 6 秒内没收到任何状态 → 显示连接失败提示（网址错/被墙/断网）
  setTimeout(() => { if (!initSSE._gotState) { const el = $('connError'); if (el) el.style.display = ''; } }, 6000);
  es.onmessage = (e) => {
    initSSE._gotState = true;
    sseLastEvt = Date.now();   // 2026-09-07：任何数据（含 25s 心跳 hb 事件）都证明连接存活
    const el = $('connError'); if (el && el.style.display !== 'none') el.style.display = 'none';
    const msg = JSON.parse(e.data);
    if (msg.event === 'state') {
      S = msg.state;
      // 2026-09-06：无 room 参数 = 主实例上的「首班副本」。跳到该班自己的 rid DO，
      // 与切班(换 ?room=rid)后的控制端/小程序同实例——点名/传呼/解锁/SSE 广播才互通；
      // 否则大屏停留在主实例副本上，控制端发在班级 DO 的事件永远收不到。
      if (!new URLSearchParams(location.search).has('room')) {
        const cur = (S.allClasses || []).find(x => x.i === (S.currentClass || 0));
        if (cur && cur.rid) { location.replace(location.pathname + '?room=' + encodeURIComponent(cur.rid)); return; }
      }
      render();
      if (window._pickerOpen) renderClassList();   // v2.0.2: S 更新时若班级选择器已展开则自动同步列表
    }
    else if (msg.event === 'rollStart') startRoll(msg);
    else if (msg.event === 'rollResult') showResult(msg);   // 2026-09-07：传整个事件对象——showResult 内部取 msg.display/msg.students（组名）；旧载荷只有 names 时同样兼容
    else if (msg.event === 'answerStart') showAnswerStart();
    else if (msg.event === 'marked') showMark(msg.result);
    else if (msg.event === 'skipped') { }
    else if (msg.event === 'page') {
      // 服务器先发 page 事件，再推 state；这里直接弹出大弹窗+音效，state 到达后不会再重复播放
      if (msg.page) { S = S || {}; showPage(msg.page); }
    }
  };
  // v2.0.3: SSE 连续失败(长时间断网)累计 5 次 → 主动关闭重连，不再死等自动重连
  let esErr = 0;
  es.onopen = () => {
    esErr = 0;
    sseLastEvt = Date.now();
    classLockAutoTried = false;   // 2026-09-07：每次(重)连都允许自动试一次历史密码——DO 空闲回收丢失解锁态后可自愈
    const el = $('connError'); if (el && el.style.display !== 'none') el.style.display = 'none';
  };
  es.onerror = () => {
    esErr += 1;
    if (esErr >= 5) {
      esErr = 0;
      try { es.close(); } catch (err) {}
      es = null;
      reopenSSE();
    }
  };
}
initSSE();
// 2026-09-07 看门狗：50s 无任何数据（服务端 25s 心跳漏 1 次以上）→ 判定连接静默失效并强制重连。
// 覆盖"DO 被空闲回收后不再推数据、但 TCP 未触发 error"等长时间运行失效场景（大屏/控制端收不到消息）
setInterval(() => {
  if (!es || es.readyState === EventSource.CLOSED) return;   // 已关：交给 onerror 流程
  if (Date.now() - sseLastEvt > 50000) {
    console.warn('[djt] SSE 静默超时(50s 无数据)，强制重连');
    sseLastEvt = Date.now();
    try { es.close(); } catch (e) {}
    es = null;
    reopenSSE();
  }
}, 10000);

/* ---------- 大屏班级切换（有密码的班级需输入密码） ---------- */
/* ---------- 班级密码锁定画面 ---------- */
let classLockAutoTried = false;
function lockRid() {
  const c = (S.allClasses || []).find(x => x.i === S.currentClass);
  return (c && c.rid) || ROOM;
}
function showClassLock() {
  $('classLock').style.display = '';
  $('classLockName').textContent = S.className || '本班级';
  $('className').textContent = S.className || '—';
  const saved = sessionStorage.getItem('djUnlock:' + lockRid());
  if (saved && !classLockAutoTried) { classLockAutoTried = true; doClassUnlock(saved); return; }
}
async function doClassUnlock(pass) {
  if (!pass) { $('classLockMsg').textContent = '请输入班级访问密码'; return; }
  const j = await apiCmd({ action: 'unlockClass', pass });
  if (j.ok) { sessionStorage.setItem('djUnlock:' + lockRid(), pass); $('classLockPass').value = ''; }
  else { $('classLockMsg').textContent = j.msg || '班级访问密码不正确'; }
}
$('classLockBtn').onclick = () => doClassUnlock($('classLockPass').value.trim());
$('classLockPass').addEventListener('keydown', e => { if (e.key === 'Enter') doClassUnlock($('classLockPass').value.trim()); });

function showMsg(t) {
  const el = $('screenToast');
  el.textContent = t; el.style.display = 'block';
  clearTimeout(showMsg._t); showMsg._t = setTimeout(() => el.style.display = 'none', 2400);
}
async function apiCmd(body) {
  const r = await fetch(`/api/cmd?room=${ROOM}&sid=${SID}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
function renderClassList() {
  const wrap = $('classList'); if (!wrap) return;
  const list = (S && S.allClasses) || [];
  if (!list.length) {
    wrap.innerHTML = '<div class="cc-empty">暂无可选班级（或正在加载）</div>';
    return;
  }
  // 用 DOM 而非 innerHTML，避免未来字段插值引发 XSS；事件仍走 classOverlay 委托
  wrap.innerHTML = list.map(c => {
    const cur = c.rid === ROOM;
    return `<button class="cc-item${cur ? ' cur' : ''}" data-i="${c.i}" data-rid="${esc(c.rid||'')}">${c.locked ? '🔒 ' : ''}${esc(c.name||'未命名')}${cur ? ' （当前）' : ''}</button>`;
  }).join('');
}
function toggleClassPicker(show) {
  const ov = $('classOverlay'); if (!ov) return;
  ov.style.display = show ? '' : 'none';
  window._pickerOpen = !!show;
  if (show) renderClassList();
}
$('className').onclick = () => toggleClassPicker(true);
$('classClose').onclick = () => toggleClassPicker(false);
$('classOverlay').addEventListener('click', async e => {
  if (e.target === $('classOverlay')) { toggleClassPicker(false); return; }
  const btn = e.target.closest('.cc-item');
  if (!btn) return;
  const i = +btn.dataset.i;
  const target = (S.allClasses || []).find(c => c.i === i);
  if (!target || target.rid === ROOM) { toggleClassPicker(false); return; }   // 已是这个班
  // 切班 = 换 URL（班级即房间）：加密班先验证密码
  if (target.locked) {
    const pass = _prompt(`班级「${target.name}」已加密，请输入班级访问密码：`, '') || '';
    if (!pass) { toggleClassPicker(false); return; }
    const j = await apiCmd({ action: 'classSwitch', index: i, pass });
    if (!j.ok) { toggleClassPicker(false); if (j && j.msg) showMsg(j.msg); return; }
    sessionStorage.setItem('djUnlock:' + target.rid, pass);   // 新页面自动解锁，免二次输入
  }
  toggleClassPicker(false);
  location.href = location.pathname + '?room=' + encodeURIComponent(target.rid);
});

/* ---------- 大屏一周课表（待机页常驻，老式表格排版） ---------- */
// 根据课表时间判断当前是哪一节（返回 {key,label,time}，非课时段返回 null）
function nowSlotInfo(tt) {
  if (!tt || !tt.times) return null;
  const now = new Date();
  const dow = now.getDay();            // 1-5 周一~周五
  if (dow < 1 || dow > 5) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const sls = [];
  if (tt.pre) sls.push({ key: 'pre', label: '早读' });
  for (let s = 0; s < tt.am; s++) sls.push({ key: String(s), label: '上午' + (s + 1) + '节' });
  for (let s = 0; s < tt.pm; s++) sls.push({ key: String(tt.am + s), label: '下午' + (s + 1) + '节' });
  if (tt.post) sls.push({ key: 'post', label: '晚托' });
  for (const sl of sls) {
    const t = tt.times[sl.key];
    if (!t || !t.s) continue;
    const sp = String(t.s).split(':');
    const sh = parseInt(sp[0], 10), sm = parseInt(sp[1], 10);
    if (isNaN(sh)) continue;
    const sMin = sh * 60 + (isNaN(sm) ? 0 : sm);
    let eMin = Infinity;
    if (t.e) {
      const ep = String(t.e).split(':');
      const eh = parseInt(ep[0], 10), em = parseInt(ep[1], 10);
      if (!isNaN(eh)) eMin = eh * 60 + (isNaN(em) ? 0 : em);
    }
    if (nowMin >= sMin && nowMin < eMin) return { key: sl.key, label: sl.label, time: t.s + (t.e ? '—' + t.e : '') };
  }
  return null;
}
function renderTtTable() {
  const tt = (S && S.tt) || { am: 4, pm: 3, cells: {} };
  const days = ['周一', '周二', '周三', '周四', '周五'];
  const today = new Date().getDay();   // 0=周日
  const now = nowSlotInfo(tt);
  // 今日答题统计：stats 键为「slotKey_yyyy-MM-dd」
  const td = new Date();
  const todayStr2 = td.getFullYear() + '-' + String(td.getMonth() + 1).padStart(2, '0') + '-' + String(td.getDate()).padStart(2, '0');
  const statsMap = {};
  const stAll = tt.stats || {};
  for (const k in stAll) {
    if (k.endsWith('_' + todayStr2)) statsMap[k.slice(0, k.length - todayStr2.length - 1)] = stAll[k];
  }
  // 节次列表：早读 → 上午 → 下午 → 晚托
  const slots = [];
  if (tt.pre) slots.push({ key: 'pre', label: '早读', extra: true });
  for (let s = 0; s < tt.am; s++) slots.push({ key: String(s), label: '上午' + (s + 1) + '节' });
  for (let s = 0; s < tt.pm; s++) slots.push({ key: String(tt.am + s), label: '下午' + (s + 1) + '节' });
  if (tt.post) slots.push({ key: 'post', label: '晚托', extra: true });
  let html = '';
  // 现在是横幅：上课时段显示当前节次/课程/时间/今日答题
  if (now) {
    const st = statsMap[now.key];
    const course = (tt.cells || {})[today + '_' + now.key];
    html += `<div class="now-bar"><span class="nb-ico">📖</span>现在是：<b>${esc(now.label)}${course ? ' · ' + esc(course) : ''}</b>${now.time ? `<span class="nb-time">${esc(now.time)}</span>` : ''}${st ? `<span class="nb-stats">答出 <b>${st.answered}</b> · 未答出 <b>${st.missed}</b></span>` : ''}</div>`;
  }
  html += '<table class="screen-tt"><tr><th class="stt-slot"></th>' + days.map((d, i) => `<th class="${today === i + 1 ? 'today' : ''}">${d}</th>`).join('') + '</tr>';
  for (const sl of slots) {
    const isNow = !!(now && now.key === sl.key);
    const t = (tt.times || {})[sl.key];
    const timeHtml = (t && (t.s || t.e)) ? `<span class="stt-time">${esc(t.s || '')}${t.s && t.e ? '—' : ''}${esc(t.e || '')}</span>` : '';
    const nowTag = isNow ? '<span class="stt-now-tag">当前</span>' : '';
    html += `<tr class="${sl.extra ? 'stt-extra-row' : ''}${isNow ? ' now' : ''}"><td class="stt-slot${sl.extra ? ' stt-extra-slot' : ''}">${nowTag}${esc(sl.label)}${timeHtml}</td>`;
    for (let d = 1; d <= 5; d++) {
      const course = (tt.cells || {})[d + '_' + sl.key];
      html += `<td class="${today === d ? 'today' : ''}">${course ? esc(course) : '<span class="stt-empty">—</span>'}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  const el = $('standbyTt');
  el.innerHTML = html;
  // 设置里的「大屏课表显示」开关：关闭时隐藏课表面板，公告居中
  const show = S ? S.showTt !== false : true;
  el.style.display = show ? '' : 'none';
  $('standby').classList.toggle('tt-hidden', !show);
  // 每分钟自动刷新当前课/时间状态
  clearTimeout(renderTtTable._t);
  if (show) renderTtTable._t = setTimeout(renderTtTable, 30000);
}

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
  // 按需求：点名结果「请回答问题」不做 AI 语音播报（提示音保留）
}
function showAnswerStart() {
  render();
  // 「请开始回答问题」同样不做 AI 语音播报
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
let lastPageSoundAt = 0;
let pageOverlayShownAt = 0;    // 当前弹窗对应的 page.sentAt（0=未弹窗）；同一次传呼不重复弹
let pageOverlayT = null;       // 5 秒自动收起定时器
function showPage(page) {
  if (!page || page.retracted || page.confirmed) { hidePage(); return; }
  // 显示：姓名·学号（有学号时），便于确认身份；AI 播报仍喊姓名
  const showNames = page.names.map((n, i) => page.sids && page.sids[i] ? `${n}·${page.sids[i]}` : n).join('、');
  const sayNames = page.names.join('、');
  $('pName').textContent = showNames;
  $('pPlace').textContent = `请到「${page.place}」` + (page.from ? ` 找 ${page.from}` : '');
  $('pNote').textContent = page.note || '';
  $('pFrom').textContent = '请看到通知后及时前往';
  // 考试模式只显示角落条，不弹卡不发声；同时把该传呼标记为“已处理”，
  // 退出考试模式后不会补弹大窗/补响铃/补桌面通知（P1-5）
  if (S && S.examMode) {
    clearTimeout(pageOverlayT); pageOverlayT = null;
    pageOverlayShownAt = page.sentAt;
    lastPageSoundAt = page.sentAt;
    $('pageOverlay').style.display = 'none';
    return;
  }
  const isNewPage = page.sentAt !== pageOverlayShownAt;
  if (isNewPage) {
    pageOverlayShownAt = page.sentAt;
    $('pageOverlay').style.display = '';
    // 展示时长固定 5 秒：超时自动收起居中大弹窗（右下角堆叠仍保留，等教师「已到/撤回」）
    clearTimeout(pageOverlayT);
    pageOverlayT = setTimeout(() => {
      const cur = S && S.page;
      if (!(cur && cur.sentAt === pageOverlayShownAt && !cur.retracted && !cur.confirmed)) return;
      $('pageOverlay').style.display = 'none';
      pageOverlayShownAt = 0;   // 重置：后续同 page 的 state 推送不会再把它弹开
    }, 5000);
  }
  if (lastPageSoundAt === page.sentAt) return;   // 同一传呼只播一次提示音/AI 语音
  lastPageSoundAt = page.sentAt;
  sfx.page();
  // 桌面版（window.djt 由 preload 注入）：把「叫人」同步推送到 Windows 系统通知，窗口被遮挡/最小化也不漏看；普通浏览器里自动跳过
  if (window.djt && window.djt.notify) {
    window.djt.notify(`📢 传呼：${sayNames}`, `请到「${page.place}」` + (page.from ? ` 找 ${page.from}` : '') + (page.note ? `（${page.note}）` : ''));
  }
  // AI 播报：XX 同学，请到「教务处」找李老师，带上作业本（含留言）
  if (voiceModeAllowsAI()) {
    speak(`${sayNames} 同学，请到「${page.place}」` + (page.from ? `，找 ${page.from}` : '') + (page.note ? `，${page.note}` : ''));
  }
}
function hidePage() {
  clearTimeout(pageOverlayT); pageOverlayT = null;
  pageOverlayShownAt = 0;
  $('pageOverlay').style.display = 'none';
  $('pageBanner').style.display = 'none';
}

/* ---------- 渲染 ---------- */
function render() {
  if (!S) return;
  // 班级密码锁定：显示锁定画面（可在此输密码，或等待控制端解锁）
  if (S.locked) { showClassLock(); return; }
  if ($('classLock').style.display !== 'none') { $('classLock').style.display = 'none'; $('classLockMsg').textContent = ''; }
  // 答题结束后清理倒计时定时器（防止 tick 访问 null.answering 抛错）
  if (!S.answering && render._cdTimer) { clearInterval(render._cdTimer); render._cdTimer = null; }
  volume = S.volume; $('className').textContent = S.className;
  renderTtTable();   // 待机页课表常驻
  // 公告栏（左侧面板：有公告则显示，长文可滚动）
  const notice = S.notice && S.notice.text ? S.notice.text : '';
  if (notice) { $('noticePanel').style.display = ''; $('noticeTextEl').textContent = notice; }
  else $('noticePanel').style.display = 'none';
  // 作业栏（备忘录）：控制端开关 showMemos 开启时，待机页常驻显示未完成条目，勾掉即下屏
  const memos = (S.memos || []).filter(m => !m.done);
  const memoPanel = $('memoPanel'), memoBody = $('memoBodyEl');
  if (S.showMemos && memos.length) {
    memoBody.textContent = '';
    memos.forEach(m => {
      const div = document.createElement('div');
      div.className = 'memo-line';
      div.textContent = m.text;
      memoBody.appendChild(div);
    });
    memoPanel.style.display = '';
  } else { memoPanel.style.display = 'none'; memoBody.textContent = ''; }
  // 传呼待处理堆叠：右下角累积未点"已到"的传呼
  const pend = (S.pageLog || []).filter(p => !p.confirmed && !p.retracted);
  const stackEl = $('pageStack');
  if (pend.length) {
    stackEl.innerHTML = pend.slice().reverse().map(p => {
      const t = new Date(p.sentAt), ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      return `<div class="ps-item">👤 <b>${esc(p.names.join('、'))}</b> → ${esc(p.place)}${p.from ? ' · 找' + esc(p.from) : ''}<span class="ps-time">${ts}</span></div>`;
    }).join('');
    stackEl.style.display = '';
  } else { stackEl.style.display = 'none'; stackEl.innerHTML = ''; }
  // 时钟
  const d = new Date();
  $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // 二维码（缩小放右下角，扫第一个候选地址进控制端，自动带房间参数）
  // P2-8：仅当目标 URL 变化时才重建 SVG，避免高频 state 下反复清空/重插造成抖动
  if (typeof qrcode === 'function') {
    const urls = (S.ctrlUrls && S.ctrlUrls.length ? S.ctrlUrls : [location.origin + '/ctrl.html' + (location.search || '')]);
    if (!render._qrUrl || render._qrUrl !== urls[0]) {
      render._qrUrl = urls[0];
      try {
        const qr = qrcode(0, 'M');
        qr.addData(urls[0]); qr.make();
        $('qrCorner').innerHTML = qr.createSvgTag({ cellSize: 2, margin: 1, scalable: true }) + '<div class="qr-corner-label">📱 扫码控制</div>';
      } catch (e) {}
    }
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
  // 传呼：未确认/未撤回时大屏显示居中弹窗，新传呼展示 5 秒自动收起；
  // showPage/hidePage 内部控制弹窗开关与提示音，同一传呼只播一次
  const p = S.page;
  if (p && !p.retracted && !p.confirmed) {
    showPage(p);
  } else {
    // 已确认 / 已撤回 / 无传呼：一律收起弹窗
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
  // 本节课点名录（判定结果：✓答对 ✗答错 — 未答 ⏭跳过，随行小标）
  const RES = { right: ['✓', '#7bd88f'], wrong: ['✗', '#ff8080'], none: ['—', '#9a9a9a'], skip: ['⏭', '#9a9a9a'] };
  $('lessonLog').innerHTML = (S.lessonLog || []).map(l =>
    `<div>${esc((l.display || l.names).join('、'))}${l.result && RES[l.result] ? ` <b style="color:${RES[l.result][1]}">${RES[l.result][0]}</b>` : ''}</div>`
  ).join('');
}
setInterval(() => { const d = new Date(); $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }, 10000);

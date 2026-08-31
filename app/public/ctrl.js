/* 教师控制端逻辑 */
let S = null;
let selGroup = null, selCount = 1, selTimer = 60, selDur = 30;
let pageSel = [], selPlace = null;
let lockRoll = false;
const $ = id => document.getElementById(id);

/* ---------- 工具 ---------- */
async function cmd(body) {
  const pin = localStorage.getItem('djPin') || '';
  const r = await fetch('/api/cmd?pin=' + encodeURIComponent(pin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 401) {
    const p = prompt('请输入访问密码');
    if (p !== null) { localStorage.setItem('djPin', p); return cmd(body); }
    return { ok: false };
  }
  const j = await r.json();
  if (j.msg) toast(j.msg);
  return j;
}
function toast(t) { const el = $('toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => el.style.display = 'none', 2200); }
function timeStr(ts) { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

/* ---------- SSE（携带访问密码） ---------- */
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
  es.onopen = () => { $('connBadge').textContent = '● 已连接'; $('connBadge').style.background = '#1d4d33'; };
  es.onerror = () => { $('connBadge').textContent = '● 重连中…'; $('connBadge').style.background = '#6b4a1d'; };
  es.onmessage = e => { const m = JSON.parse(e.data); if (m.event === 'state') { S = m.state; render(); maybeShowPickModal(); } };
}
initSSE();

/* ---------- Tab 切换 ---------- */
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  for (const t of ['roll', 'page', 'roster', 'set']) $('tab-' + t).style.display = b.dataset.tab === t ? '' : 'none';
});

/* ---------- 渲染 ---------- */
function render() {
  if (!S) return;
  // 班级选择
  $('classSel').innerHTML = S.allClasses.map(c => `<option value="${c.i}" ${c.i === S.currentClass ? 'selected' : ''}>${c.name}</option>`).join('');
  // 分组chips（组由名单页自定义，无组时只显示"全班"）
  $('groupChips').innerHTML = `<span class="chip ${selGroup ? '' : 'sel'}" data-g="">全班</span>` +
    (S.groups || []).map(g => `<span class="chip ${selGroup === g ? 'sel' : ''}" data-g="${g}">${g}</span>`).join('');
  // 点名结果卡（显示带组名的名字）
  const showResult = S.lastPick && !S.answering;
  $('pickResult').style.display = showResult ? '' : 'none';
  if (showResult) {
    $('pickNames').textContent = (S.lastPick.display || S.lastPick.names).join('  ');
    const answered = !!(S.lessonLog.length && !lockRoll);
    $('answerBtns').style.display = '';
    $('timerBtns').style.display = 'none';
    $('markBtns').style.display = 'none';
  }
  if (S.answering) { $('answerBtns').style.display = 'none'; $('markBtns').style.display = ''; $('timerBtns').style.display = 'none'; }
  $('rollBtn').disabled = lockRoll || !!S.answering;
  // 今日请假（点名自动跳过）
  const absent = S.absentToday || [];
  $('absentBadge').textContent = `${absent.length} 人`;
  $('absentBadge').style.display = absent.length ? '' : 'none';
  $('absentSummary').textContent = absent.length
    ? `请假中：${absent.join('、')}（抽取时自动跳过）`
    : '无请假，全员参与抽取';
  $('absentEdit').innerHTML = S.students.map(s =>
    `<span class="chip ${absent.includes(s.name) ? 'sel' : ''}" data-a="${s.name}">${s.name}</span>`).join('')
    || '<span style="color:var(--dim)">名单为空</span>';
  // 本节课记录
  $('lessonList').innerHTML = S.lessonLog.length
    ? S.lessonLog.map(l => `<li><b>${(l.display || l.names).join('、')}</b><span>${timeStr(l.at)}</span></li>`).join('') : '<li>暂无</li>';
  // 传呼候选学生（带组名）
  const kw = $('stuSearch').value.trim();
  $('pageStudents').innerHTML = S.students
    .filter(s => !kw || s.name.includes(kw))
    .map(s => `<span class="chip ${pageSel.includes(s.name) ? 'sel' : ''}" data-n="${s.name}">${s.group ? s.name + '·' + s.group : s.name}</span>`).join('') || '<span style="color:var(--dim)">无匹配学生</span>';
  // 去处
  $('placeChips').innerHTML = S.places.map(p => `<span class="chip ${selPlace === p ? 'sel' : ''}" data-p="${p}">${p}</span>`).join('');
  $('fromInput').value = localStorage.getItem('teacherName') || $('fromInput').value;
  // 当前传呼
  const p = S.page;
  $('activePage').style.display = p && !p.retracted && !p.confirmed ? '' : 'none';
  if (p && !p.retracted && !p.confirmed) {
    $('activePageInfo').textContent = `${p.names.join('、')} → ${p.place}${p.from ? ' · 找' + p.from : ''} · ${timeStr(p.sentAt)}发出`;
  }
  // 传呼记录
  $('pageLogList').innerHTML = S.pageLog.length
    ? S.pageLog.slice().reverse().map(l => `<li><b>${l.names.join('、')}→${l.place}</b><span>${timeStr(l.sentAt)} ${l.confirmed ? '✅' : (l.retracted ? '撤回' : '…')}</span></li>`).join('') : '<li>暂无</li>';
  // 名单（权重名字旁直接改：0=今天不点他，1=正常，2=双倍概率…；📌=加入今日请假）
  const absNow = S.absentToday || [];
  $('stuList').innerHTML = S.students.map(s => {
    const isAbs = absNow.includes(s.name);
    return `<div class="stu-item"><span class="nm">${s.name}${isAbs ? ' <span style="color:#ff5d5d;font-size:12px">📌请假</span>' : ''}</span><span class="meta">${s.group || '未分组'} · 被点${s.pickedCount}次</span><span class="meta">权重</span><input type="text" inputmode="decimal" pattern="[0-9.]*" value="${s.weight}" data-w="${s.name}" title="0=不点他，1=正常，2=双倍概率"><span class="del" data-a="${s.name}" style="${isAbs ? 'color:#ff5d5d' : ''}">📌</span><span class="del" data-n="${s.name}">×</span></div>`;
  }).join('') || '<div style="color:var(--dim)">名单为空，请导入</div>';
  // 组管理（自定义组，点 × 删组）
  $('groupManage').innerHTML = (S.groups || []).length
    ? S.groups.map(g => `<span class="chip">${g}<span class="del" data-g="${g}" style="color:var(--red);margin-left:6px;cursor:pointer">×</span></span>`).join('')
    : '<span style="color:var(--dim)">暂无分组，可在下方添加（不分组也完全可以正常点名）</span>';
  $('groupDatalist').innerHTML = (S.groups || []).map(g => `<option value="${g}">`).join('');
  // 考试模式
  $('examChk').checked = S.examMode;
  // 设置
  $('connInfo').textContent = `控制端: ${location.href}\n大屏: ${location.href.replace('ctrl.html', 'screen.html')}`.replace(/\n/g, '　|　');
  $('volSlider').value = Math.round((S.volume || 0.3) * 100);
  $('volText').textContent = Math.round((S.volume || 0.3) * 100) + '%';
  syncChips('animChips', 'ms', String(S.animationMs));
  syncChips('voiceChips', 'm', S.voiceMode || 'sound');
  syncChips('themeChips', 't', (window.__getTheme ? __getTheme() : 'auto'));
}

function syncChips(containerId, attr, val) {
  document.querySelectorAll(`#${containerId} .chip`).forEach(c => c.classList.toggle('sel', c.dataset[attr] === val));
}

/* ---------- 点名答题事件 ---------- */
$('groupChips').addEventListener('click', e => { if (e.target.dataset.g !== undefined) { selGroup = e.target.dataset.g || null; render(); } });
$('countChips').addEventListener('click', e => { if (e.target.dataset.n) { selCount = +e.target.dataset.n; syncChips('countChips', 'n', e.target.dataset.n); } });
$('rollBtn').onclick = async () => {
  if (lockRoll) return;
  lockRoll = true; render();
  await cmd({ action: 'roll', group: selGroup, count: selCount, noRepeat: $('noRepeatChk').checked });
  setTimeout(() => { lockRoll = false; render(); }, (S ? S.animationMs : 3000) + 300);
};
$('resetRoundBtn').onclick = () => cmd({ action: 'resetRound' });
// 请假名单：编辑模式切换 + 勾选保存 + 清空
$('absentToggleBtn').onclick = () => { $('absentEdit').style.display = $('absentEdit').style.display === 'none' ? '' : 'none'; };
$('absentClearBtn').onclick = () => { if (confirm('确定清空今日请假名单？')) cmd({ action: 'clearAbsent' }); };
$('absentEdit').addEventListener('click', async e => {
  if (!e.target.dataset.a) return;
  const name = e.target.dataset.a;
  const cur = (S.absentToday || []).slice();
  if (cur.includes(name)) cur.splice(cur.indexOf(name), 1); else cur.push(name);
  await cmd({ action: 'setAbsent', names: cur });
});
$('askBtn').onclick = () => { $('answerBtns').style.display = 'none'; $('timerBtns').style.display = ''; };
$('timerBtns').addEventListener('click', e => {
  if (e.target.dataset.d !== undefined) { selTimer = +e.target.dataset.d; syncChips('timerBtns', 'd', e.target.dataset.d); cmd({ action: 'answerStart', duration: selTimer }); }
});
$('skipBtn').onclick = () => cmd({ action: 'skip' });
$('markBtns').addEventListener('click', e => { if (e.target.dataset.m) cmd({ action: 'mark', result: e.target.dataset.m }); });

/* ---------- 传呼事件 ---------- */
$('stuSearch').oninput = render;
$('pageStudents').addEventListener('click', e => {
  const n = e.target.dataset.n; if (!n) return;
  pageSel.includes(n) ? pageSel = pageSel.filter(x => x !== n) : pageSel.push(n);
  render();
});
$('placeChips').addEventListener('click', e => { if (e.target.dataset.p) { selPlace = e.target.dataset.p; render(); } });
$('addPlaceBtn').onclick = () => { const v = $('newPlace').value.trim(); if (v) { cmd({ action: 'addPlace', name: v }); $('newPlace').value = ''; selPlace = v; } };
$('durChips').addEventListener('click', e => {
  if (e.target.dataset.d !== undefined) {
    selDur = +e.target.dataset.d;
    $('durCustom').value = '';
    syncChips('durChips', 'd', e.target.dataset.d);
  }
});
// 自定义显示时长（秒）：0~3600，0=常驻
$('durCustom').addEventListener('change', e => {
  const v = parseInt(e.target.value, 10);
  if (isNaN(v) || v < 0 || v > 3600) { toast('请输入 0~3600 的秒数'); $('durCustom').value = ''; return; }
  selDur = v;
  document.querySelectorAll('#durChips .chip').forEach(c => c.classList.remove('sel'));
  $('durCustom').placeholder = v === 0 ? '0=常驻' : `当前：${v} 秒`;
});
$('pageBtn').onclick = async () => {
  if (pageSel.length === 0) return toast('请先选择学生');
  if (!selPlace) return toast('请选择去处');
  localStorage.setItem('teacherName', $('fromInput').value.trim());
  await cmd({ action: 'page', names: pageSel, place: selPlace, from: $('fromInput').value.trim(), note: $('noteInput').value.trim(), duration: selDur });
  pageSel = []; $('noteInput').value = ''; render();
};
$('confirmBtn').onclick = () => cmd({ action: 'pageConfirm' });
$('retractBtn').onclick = () => cmd({ action: 'pageRetract' });

/* ---------- 名单事件 ---------- */
$('importBtn').onclick = async () => {
  const text = $('importText').value.trim();
  if (!text) return toast('请粘贴名单');
  const j = await cmd({ action: 'importRoster', className: $('importName').value.trim(), text });
  if (j.ok) { $('importText').value = ''; $('importName').value = ''; }
};
$('addStuBtn').onclick = () => { if ($('addName').value.trim()) { cmd({ action: 'addStudent', name: $('addName').value.trim(), group: $('addGroup').value.trim(), weight: parseFloat($('addWeight').value) || 1 }); $('addName').value = ''; } };
$('stuList').addEventListener('click', e => {
  if (e.target.classList.contains('del') && e.target.dataset.n) cmd({ action: 'delStudent', name: e.target.dataset.n });
  // 📌 一键加入/取消今日请假（病假等当天不点他，次日自动恢复）
  if (e.target.classList.contains('del') && e.target.dataset.a) {
    const cur = (S.absentToday || []).slice();
    if (cur.includes(e.target.dataset.a)) cur.splice(cur.indexOf(e.target.dataset.a), 1); else cur.push(e.target.dataset.a);
    cmd({ action: 'setAbsent', names: cur });
  }
});
$('stuList').addEventListener('change', e => {
  if (!e.target.dataset.w) return;
  const w = parseFloat(e.target.value);
  if (isNaN(w)) { toast('请输入数字（0=不点他，1=正常）'); render(); return; }
  cmd({ action: 'setWeight', name: e.target.dataset.w, weight: w });
});
$('addGroupBtn').onclick = () => { const v = $('newGroup').value.trim(); if (v) { cmd({ action: 'addGroup', name: v }); $('newGroup').value = ''; } };
$('groupManage').addEventListener('click', e => { if (e.target.dataset.g && e.target.classList.contains('del')) cmd({ action: 'delGroup', name: e.target.dataset.g }); });
$('resetStatsBtn').onclick = () => cmd({ action: 'resetStats' });

/* ---------- 设置与其他 ---------- */
$('classSel').onchange = e => cmd({ action: 'classSwitch', index: +e.target.value });
$('addClassBtn').onclick = () => {
  const name = prompt('新建班级名称（留空自动命名）：', '');
  if (name === null) return;
  cmd({ action: 'addClass', name: name.trim() });
};
$('delClassBtn').onclick = async () => {
  const cur = S ? S.className : '';
  if (!confirm(`确定删除班级「${cur}」？\n该班级的名单、分组、统计将一并删除，且不可恢复！`)) return;
  await cmd({ action: 'delClass', index: S.currentClass, confirm: true });
};
$('renameClassBtn').onclick = () => {
  const cur = S ? S.className : '';
  const name = prompt('修改班级名称：', cur);
  if (name && name.trim() && name.trim() !== cur) cmd({ action: 'renameClass', name: name.trim() });
};
$('examChk').onchange = e => cmd({ action: 'examMode', on: e.target.checked });
$('animChips').addEventListener('click', e => { if (e.target.dataset.ms) cmd({ action: 'setAnim', ms: +e.target.dataset.ms }); });
$('voiceChips').addEventListener('click', e => { if (e.target.dataset.m) cmd({ action: 'setVoiceMode', mode: e.target.dataset.m }); });
$('themeChips').addEventListener('click', e => { if (e.target.dataset.t) { window.__setTheme(e.target.dataset.t); render(); } });
let volT = null;
$('volSlider').oninput = e => { $('volText').textContent = e.target.value + '%'; clearTimeout(volT); volT = setTimeout(() => cmd({ action: 'setVolume', value: e.target.value / 100 }), 400); };

/* ---------- 点名结果大弹窗（屏幕居中） ---------- */
let modalSeenPickAt = null; // 已处理过的 lastPick.at（页面刚打开时不弹旧结果）
function maybeShowPickModal() {
  if (!S.lastPick) { closePickModal(); return; }
  if (S.answering) { closePickModal(); return; }   // 开始答题即收起
  if (modalSeenPickAt === null) { modalSeenPickAt = S.lastPick.at; return; }
  if (S.lastPick.at !== modalSeenPickAt) { modalSeenPickAt = S.lastPick.at; openPickModal(); }
}
function openPickModal() {
  const p = S.lastPick;
  $('pickModalNames').textContent = (p.display || p.names).join('  ');
  $('pickModalAsk').style.display = '';
  $('pickModalTimers').style.display = 'none';
  $('pickModal').style.display = '';
}
function closePickModal() { $('pickModal').style.display = 'none'; }
$('pickModalClose').onclick = closePickModal;
$('pickModal').addEventListener('click', e => { if (e.target === $('pickModal')) closePickModal(); });
$('pickModalAskBtn').onclick = () => { $('pickModalAsk').style.display = 'none'; $('pickModalTimers').style.display = ''; };
$('pickModalTimerChips').addEventListener('click', e => {
  if (!e.target.dataset.d) return;
  selTimer = +e.target.dataset.d;
  syncChips('pickModalTimerChips', 'd', e.target.dataset.d);
  cmd({ action: 'answerStart', duration: selTimer });
  closePickModal();
});
$('pickModalSkipBtn').onclick = () => { cmd({ action: 'skip' }); closePickModal(); };

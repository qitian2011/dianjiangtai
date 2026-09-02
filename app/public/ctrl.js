/* 教师控制端逻辑 */
let S = null;
let selGroup = null, selCount = 1, selTimer = 60, selDur = 30;
let pageSel = [], selPlace = null;   // pageSel: [{n:姓名, s:学号}]，以学号定位防同名
let lockRoll = false;
const $ = id => document.getElementById(id);

/* ---------- 工具 ---------- */
const ROOM = new URLSearchParams(location.search).get('room') || '1';
async function cmd(body) {
  const pin = localStorage.getItem('djPin') || '';
  const r = await fetch(`/api/cmd?room=${ROOM}&pin=${encodeURIComponent(pin)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

/* ---------- SSE（携带访问密码，?room=X 指定房间） ---------- */
let es = null;
let roomNormalized = false;   // 打开时无 room 参数 → 自动跳到当前班级专属链接（只跳一次）
async function initSSE() {
  let pin = new URLSearchParams(location.search).get('pin') || localStorage.getItem('djPin') || '';
  // 服务器未设密码（PIN 为空）时直接放行；设了密码且未通过则弹一次，取消就不再反复弹
  const r0 = await fetch(`/api/state?room=${ROOM}&pin=${encodeURIComponent(pin)}`).catch(() => null);
  if (r0 && r0.status === 401) {
    const p = prompt('请输入访问密码');
    if (p !== null) { pin = p; localStorage.setItem('djPin', p); }
  }
  // 房间不存在/已失效（如班级被删除）：回首页自愈
  if (r0 && r0.status === 404) { location.replace(location.pathname); return; }
  es = new EventSource(`/events?room=${ROOM}&pin=${encodeURIComponent(pin)}`);
  // 8 秒内没收到状态 → 提示（网址错/被墙/密码错/断网）
  setTimeout(() => {
    if (!initSSE._gotState) {
      $('connBadge').textContent = '● 连接失败'; $('connBadge').style.background = '#7a1d1d';
      toast('无法连接服务器：请检查网址(qitian.dpdns.org)/密码/网络');
    }
  }, 8000);
  es.onopen = () => { $('connBadge').textContent = '● 已连接'; $('connBadge').style.background = '#1d4d33'; };
  es.onerror = () => { $('connBadge').textContent = '● 重连中…'; $('connBadge').style.background = '#6b4a1d'; };
  es.onmessage = e => {
    initSSE._gotState = true;
    const m = JSON.parse(e.data);
    if (m.event === 'state') {
      S = m.state; render(); maybeShowPickModal();
      if (!roomNormalized && !/room=/.test(location.search)) {
        roomNormalized = true;
        const cur = (S.allClasses || []).find(c => c.i === S.currentClass);
        if (cur && cur.rid) location.replace(location.pathname + '?room=' + encodeURIComponent(cur.rid));
      }
    }
  };
}
initSSE();

/* ---------- Tab 切换 ---------- */
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  for (const t of ['roll', 'page', 'roster', 'tt', 'set']) $('tab-' + t).style.display = b.dataset.tab === t ? '' : 'none';
});

/* ---------- 渲染 ---------- */
function render() {
  if (!S) return;
  // 班级密码锁定：只显示解锁弹窗，其余 UI 一概不渲染
  if (S.locked) { showLock(); return; }
  hideLock();
  // 班级选择
  $('classSel').innerHTML = S.allClasses.map(c => `<option value="${c.i}" ${c.i === S.currentClass ? 'selected' : ''}>${c.locked ? '🔒 ' : ''}${c.name}</option>`).join('');
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
  // 传呼候选学生（姓名+学号；有学号显示学号、无学号显示组别，搜索姓名/学号均可）
  const kw = $('stuSearch').value.trim();
  $('pageStudents').innerHTML = S.students
    .filter(s => !kw || s.name.includes(kw) || (s.sid || '').includes(kw))
    .map(s => `<span class="chip ${pageSel.some(x => x.n === s.name) ? 'sel' : ''}" data-n="${s.name}" data-s="${s.sid || ''}">${s.name}${s.sid ? '·' + s.sid : (s.group ? '·' + s.group : '')}</span>`).join('') || '<span style="color:var(--dim)">无匹配学生</span>';
  // 去处
  $('placeChips').innerHTML = S.places.map(p => `<span class="chip ${selPlace === p ? 'sel' : ''}" data-p="${p}">${p}</span>`).join('');
  $('fromInput').value = localStorage.getItem('teacherName') || $('fromInput').value;
  // 当前传呼（姓名·学号）
  const p = S.page;
  $('activePage').style.display = p && !p.retracted && !p.confirmed ? '' : 'none';
  if (p && !p.retracted && !p.confirmed) {
    const pn = (p.names || []).map((n, i) => p.sids && p.sids[i] ? `${n}·${p.sids[i]}` : n).join('、');
    $('activePageInfo').textContent = `${pn} → ${p.place}${p.from ? ' · 找' + p.from : ''} · ${timeStr(p.sentAt)}发出`;
  }
  // 传呼记录
  $('pageLogList').innerHTML = S.pageLog.length
    ? S.pageLog.slice().reverse().map(l => `<li><b>${(l.names || []).map((n, i) => l.sids && l.sids[i] ? `${n}·${l.sids[i]}` : n).join('、')}→${l.place}</b><span>${timeStr(l.sentAt)} ${l.confirmed ? '✅' : (l.retracted ? '撤回' : '…')}</span></li>`).join('') : '<li>暂无</li>';
  // 名单（学号/组别旁直接改：权重 0=今天不点他，1=正常，2=双倍概率…；📌=加入今日请假）
  const absNow = S.absentToday || [];
  $('stuList').innerHTML = S.students.map(s => {
    const isAbs = absNow.includes(s.name);
    return `<div class="stu-item"><span class="nm">${s.name}${isAbs ? ' <span style="color:#ff5d5d;font-size:12px">📌请假</span>' : ''}</span><span class="meta">学号</span><input type="text" inputmode="numeric" value="${s.sid || ''}" data-sid="${s.name}" title="学号" style="width:86px"><span class="meta">${s.group || '未分组'} · 被点${s.pickedCount}次</span><span class="meta">权重</span><input type="text" inputmode="decimal" pattern="[0-9.]*" value="${s.weight}" data-w="${s.name}" title="0=不点他，1=正常，2=双倍概率"><span class="del" data-a="${s.name}" style="${isAbs ? 'color:#ff5d5d' : ''}">📌</span><span class="del" data-n="${s.name}">×</span></div>`;
  }).join('') || '<div style="color:var(--dim)">名单为空，请导入</div>';
  // 组管理（自定义组，点 × 删组）
  $('groupManage').innerHTML = (S.groups || []).length
    ? S.groups.map(g => `<span class="chip">${g}<span class="del" data-g="${g}" style="color:var(--red);margin-left:6px;cursor:pointer">×</span></span>`).join('')
    : '<span style="color:var(--dim)">暂无分组，可在下方添加（不分组也完全可以正常点名）</span>';
  $('groupDatalist').innerHTML = (S.groups || []).map(g => `<option value="${g}">`).join('');
  // 课表
  renderTt();
  // 公告栏（输入中不被状态刷新覆盖）
  if (document.activeElement !== $('noticeText')) $('noticeText').value = (S.notice && S.notice.text) || '';
  // 备忘录（输入中不被状态刷新覆盖）
  $('memoList').innerHTML = (S.memos || []).length
    ? S.memos.map(m => `<li style="${m.done ? 'opacity:.55' : ''}"><b style="${m.done ? 'text-decoration:line-through' : ''}">${esc(m.text)}</b><span>${timeStr(m.at)} <input type="checkbox" ${m.done ? 'checked' : ''} data-mt="${m.id}" title="已完成"><span class="del" data-md="${m.id}" style="cursor:pointer; color:var(--red)">×</span></span></li>`).join('')
    : '<li>暂无备忘</li>';
  // 考试模式
  $('examChk').checked = S.examMode;
  // 班级密码状态
  const curCls = (S.allClasses || []).find(c => c.i === S.currentClass);
  $('classPassStatus').textContent = curCls && curCls.locked ? '当前：已加密（切换班级 / 删除该班需密码）' : '当前：未加密';
  // 设置
  $('connInfo').textContent = `控制端: ${location.href}\n大屏: ${location.href.replace('ctrl.html', 'screen.html')}`.replace(/\n/g, '　|　');
  $('volSlider').value = Math.round((S.volume || 0.3) * 100);
  $('volText').textContent = Math.round((S.volume || 0.3) * 100) + '%';
  syncChips('animChips', 'ms', String(S.animationMs));
  syncChips('voiceChips', 'm', S.voiceMode || 'sound');
  syncChips('themeChips', 't', (window.__getTheme ? __getTheme() : 'auto'));
  // 大屏课表显示开关
  $('showTtChk').checked = S.showTt !== false;
}

function syncChips(containerId, attr, val) {
  document.querySelectorAll(`#${containerId} .chip`).forEach(c => c.classList.toggle('sel', c.dataset[attr] === val));
}

/* ---------- 班级密码锁定（直接打开加密班级 URL 时弹出） ---------- */
let lockAutoTried = false;   // sessionStorage 里的历史密码只自动试一次，避免死循环
function lockRid() {
  const c = (S.allClasses || []).find(x => x.i === S.currentClass);
  return (c && c.rid) || ROOM;
}
function showLock() {
  $('lockOverlay').style.display = '';
  $('lockClassName').textContent = S.className || '本班级';
  const saved = sessionStorage.getItem('djUnlock:' + lockRid());
  if (saved && !lockAutoTried) { lockAutoTried = true; doUnlock(saved); return; }
  setTimeout(() => $('lockPass').focus(), 100);
}
function hideLock() { $('lockOverlay').style.display = 'none'; $('lockMsg').textContent = ''; }
async function doUnlock(pass) {
  if (!pass) { $('lockMsg').textContent = '请输入密码'; return; }
  const j = await cmd({ action: 'unlockClass', pass });
  if (j.ok) {
    sessionStorage.setItem('djUnlock:' + lockRid(), pass);
    $('lockMsg').textContent = '';
    $('lockPass').value = '';
  } else {
    $('lockMsg').textContent = j.msg || '密码不正确';
  }
}
$('lockBtn').onclick = () => doUnlock($('lockPass').value.trim());
$('lockPass').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock($('lockPass').value.trim()); });
$('lockSwitchBtn').onclick = () => { location.href = location.pathname; };   // 回首页自动进当前班级（未加密的话）

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
  const i = pageSel.findIndex(x => x.n === n);
  i >= 0 ? pageSel.splice(i, 1) : pageSel.push({ n, s: e.target.dataset.s || '' });
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
  await cmd({ action: 'page', names: pageSel.map(x => x.n), sids: pageSel.map(x => x.s), place: selPlace, from: $('fromInput').value.trim(), note: $('noteInput').value.trim(), duration: selDur });
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
$('addStuBtn').onclick = () => {
  if ($('addName').value.trim()) {
    cmd({ action: 'addStudent', name: $('addName').value.trim(), sid: $('addSid').value.trim(), group: $('addGroup').value.trim(), weight: parseFloat($('addWeight').value) || 1 });
    $('addName').value = ''; $('addSid').value = '';
  }
};
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
  if (e.target.dataset.sid) { cmd({ action: 'setSid', name: e.target.dataset.sid, sid: e.target.value.trim() }); return; }
  if (!e.target.dataset.w) return;
  const w = parseFloat(e.target.value);
  if (isNaN(w)) { toast('请输入数字（0=不点他，1=正常）'); render(); return; }
  cmd({ action: 'setWeight', name: e.target.dataset.w, weight: w });
});
$('addGroupBtn').onclick = () => { const v = $('newGroup').value.trim(); if (v) { cmd({ action: 'addGroup', name: v }); $('newGroup').value = ''; } };
$('groupManage').addEventListener('click', e => { if (e.target.dataset.g && e.target.classList.contains('del')) cmd({ action: 'delGroup', name: e.target.dataset.g }); });
$('resetStatsBtn').onclick = () => cmd({ action: 'resetStats' });

/* ---------- 课表（按班级保存） ---------- */
const TT_DAYS = ['周一', '周二', '周三', '周四', '周五'];
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function renderTt() {
  const tt = S.tt || { am: 4, pm: 3, cells: {} };
  $('ttAmVal').textContent = tt.am; $('ttPmVal').textContent = tt.pm;
  $('ttPreChk').checked = !!tt.pre;
  $('ttPostChk').checked = !!tt.post;
  // 构建节次列表：早读 → 上午 → 下午 → 晚托
  const slots = [];
  if (tt.pre) slots.push({ key: 'pre', label: '早读', extra: true });
  for (let s = 0; s < tt.am; s++) slots.push({ key: s, label: '上午' + (s + 1) + '节' });
  for (let s = 0; s < tt.pm; s++) slots.push({ key: tt.am + s, label: '下午' + (s + 1) + '节' });
  if (tt.post) slots.push({ key: 'post', label: '晚托', extra: true });
  // 每节课时间（独立于课程格子渲染，正在输入时不重建避免丢焦点）
  let th = '';
  for (const sl of slots) {
    const t = (tt.times || {})[sl.key] || {};
    th += `<div class="tt-time-row"><span class="tt-time-label${sl.extra ? ' tt-time-extra' : ''}">${sl.label}</span><input type="text" maxlength="5" placeholder="8:00" data-slot="${sl.key}" data-kind="s" value="${esc(t.s || '')}"><span class="tt-time-sep">—</span><input type="text" maxlength="5" placeholder="8:45" data-slot="${sl.key}" data-kind="e" value="${esc(t.e || '')}"></div>`;
  }
  $('ttTimes').innerHTML = th;
  // 今日答题统计（stats 键为「slotKey_yyyy-MM-dd」）
  const td = new Date();
  const todayStr2 = td.getFullYear() + '-' + String(td.getMonth() + 1).padStart(2, '0') + '-' + String(td.getDate()).padStart(2, '0');
  const slotLabel = {};
  for (const sl of slots) slotLabel[sl.key] = sl.label;
  const stats = tt.stats || {};
  let sh = '';
  for (const k in stats) {
    if (!k.endsWith('_' + todayStr2)) continue;
    const sk2 = k.slice(0, k.length - todayStr2.length - 1);
    const st = stats[k];
    sh += `<div class="tt-stat-row"><span class="tt-stat-slot">${slotLabel[sk2] || sk2}</span><span class="tt-stat-a">答出 ${st.answered}</span><span class="tt-stat-m">未答出 ${st.missed}</span><span class="tt-stat-total">共 ${st.total} 人</span></div>`;
  }
  $('ttStats').innerHTML = sh || '<div class="tt-stat-empty">今天还没有答题记录</div>';
  // 正在格子中输入时不重建，避免丢焦点
  const grid = $('ttGrid');
  if (document.activeElement && grid.contains(document.activeElement)) return;
  let html = '<table class="tt-table"><tr><th class="tt-slot-h"></th>' + TT_DAYS.map(d => `<th>${d}</th>`).join('') + '</tr>';
  for (const sl of slots) {
    html += `<tr class="${sl.extra ? 'tt-extra-row' : ''}"><td class="tt-slot${sl.extra ? ' tt-extra-slot' : ''}">${sl.label}</td>`;
    for (let d = 1; d <= 5; d++) {
      html += `<td><input type="text" maxlength="12" placeholder="—" data-d="${d}" data-s="${sl.key}" value="${esc(tt.cells[d + '_' + sl.key] || '')}"></td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  grid.innerHTML = html;
}
$('ttAmMinus').onclick = () => cmd({ action: 'ttConfig', am: Math.max(1, (S.tt ? S.tt.am : 4) - 1), pm: S.tt ? S.tt.pm : 3 });
$('ttAmPlus').onclick = () => cmd({ action: 'ttConfig', am: Math.min(8, (S.tt ? S.tt.am : 4) + 1), pm: S.tt ? S.tt.pm : 3 });
$('ttPmMinus').onclick = () => cmd({ action: 'ttConfig', am: S.tt ? S.tt.am : 4, pm: Math.max(1, (S.tt ? S.tt.pm : 3) - 1) });
$('ttPmPlus').onclick = () => cmd({ action: 'ttConfig', am: S.tt ? S.tt.am : 4, pm: Math.min(8, (S.tt ? S.tt.pm : 3) + 1) });
$('ttClearBtn').onclick = () => { if (confirm('确定清空本班整周课表？')) cmd({ action: 'ttClear' }); };
$('ttPreChk').addEventListener('change', e => cmd({ action: 'ttExtra', pre: e.target.checked ? 1 : 0 }));
$('ttPostChk').addEventListener('change', e => cmd({ action: 'ttExtra', post: e.target.checked ? 1 : 0 }));
$('ttStatsClearBtn').onclick = () => { if (confirm('确定清空本班今日答题统计？')) cmd({ action: 'ttStatsClear' }); };
$('ttGrid').addEventListener('change', e => {
  if (e.target.dataset.d === undefined) return;
  cmd({ action: 'ttCell', day: +e.target.dataset.d, slot: e.target.dataset.s, course: e.target.value.trim() });
});
/* 每节课时间：行内开始/结束输入，改完自动保存（两格都空=删除该节时间） */
$('ttTimes').addEventListener('change', e => {
  if (e.target.dataset.slot === undefined) return;
  const row = e.target.closest('.tt-time-row');
  cmd({
    action: 'ttTime',
    slot: e.target.dataset.slot,
    start: row.querySelector('input[data-kind="s"]').value.trim(),
    end: row.querySelector('input[data-kind="e"]').value.trim()
  });
});
/* 大屏课表显示/隐藏（按班级保存） */
$('showTtChk').onchange = () => cmd({ action: 'setShowTt', on: $('showTtChk').checked });
/* 公告栏：发布/清除（按班级保存，大屏待机页常驻） */
$('noticeSaveBtn').onclick = () => cmd({ action: 'setNotice', text: $('noticeText').value.trim() });
$('noticeClearBtn').onclick = () => { if (confirm('确定清除当前公告？')) cmd({ action: 'setNotice', text: '' }); };
/* 备忘录：添加 / 勾选完成 / 删除 / 清除已完成（按班级保存） */
$('memoAddBtn').onclick = () => {
  const v = $('memoInput').value.trim();
  if (!v) return toast('先写点内容再添加');
  cmd({ action: 'memoAdd', text: v });
  $('memoInput').value = '';
};
$('memoInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('memoAddBtn').click(); });
$('memoList').addEventListener('change', e => { if (e.target.dataset.mt) cmd({ action: 'memoToggle', id: e.target.dataset.mt }); });
$('memoList').addEventListener('click', e => { if (e.target.dataset.md) cmd({ action: 'memoDel', id: e.target.dataset.md }); });
$('memoClearDoneBtn').onclick = () => cmd({ action: 'memoClearDone' });
/* 班级密码：设置/修改/移除（改密需原密码，移除需原密码） */
$('setClassPassBtn').onclick = async () => {
  const cur = (S.allClasses || []).find(c => c.i === S.currentClass);
  let old = '';
  if (cur && cur.locked) {
    old = prompt(`「${S.className}」已加密，请输入原密码：`, '') || '';
  }
  const pass = prompt('设置新密码（留空 = 移除密码，最长 20 位）：', '');
  if (pass === null) return;
  await cmd({ action: 'setClassPass', old, pass: pass.trim() });
};
$('clearClassPassBtn').onclick = async () => {
  const cur = (S.allClasses || []).find(c => c.i === S.currentClass);
  if (!cur || !cur.locked) { toast('当前班级未加密'); return; }
  const old = prompt('输入当前密码以移除加密：', '') || '';
  await cmd({ action: 'setClassPass', old, pass: '' });
};

/* ---------- 设置与其他 ---------- */
// 切班 = 换 URL（班级即房间）：跳到目标班级的 rid 链接；加密班先验证密码
$('classSel').onchange = async e => {
  const i = +e.target.value;
  const target = (S.allClasses || []).find(c => c.i === i);
  if (!target) { render(); return; }
  if (target.rid === ROOM) { render(); return; }   // 已经是这个班
  if (target.locked) {
    const pass = prompt(`班级「${target.name}」已加密，请输入密码：`, '') || '';
    if (!pass) { render(); return; }
    const j = await cmd({ action: 'classSwitch', index: i, pass });
    if (!j.ok) { render(); return; }
    sessionStorage.setItem('djUnlock:' + target.rid, pass);   // 新页面自动解锁，免二次输入
  }
  location.href = location.pathname + '?room=' + encodeURIComponent(target.rid);
};
$('addClassBtn').onclick = () => {
  const name = prompt('新建班级名称（留空自动命名）：', '');
  if (name === null) return;
  const pass = prompt('可选：为该班级设置访问密码（留空 = 不加密；删除该班时也需要此密码）：', '');
  if (pass === null) return;
  cmd({ action: 'addClass', name: name.trim(), pass: pass.trim() });
};
$('delClassBtn').onclick = async () => {
  const cur = S ? S.className : '';
  if (!confirm(`确定删除班级「${cur}」？\n该班级的名单、分组、统计将一并删除，且不可恢复！`)) return;
  let pass = '';
  const curInfo = (S.allClasses || []).find(c => c.i === S.currentClass);
  if (curInfo && curInfo.locked) {
    pass = prompt(`班级「${cur}」已加密，删除需要输入密码：`, '') || '';
  }
  await cmd({ action: 'delClass', index: S.currentClass, confirm: true, pass });
  // 删除后离开当前（已失效的）班级房间，回首页自动进剩余班级
  location.href = location.pathname;
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

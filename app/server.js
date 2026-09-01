/**
 * 课堂互动大屏服务 · 零依赖版（Node 18+，无需 npm install）
 * 架构：HTTP 静态服务 + SSE(Server-Sent Events) 实时下行 + POST 指令上行
 * 取代文档中的 Socket.IO：功能等价，且完全离线、U盘拷贝即用
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const ROSTER_FILE = path.join(ROOT, 'roster.json');

/* ---------------- 名单与持久化 ---------------- */
function defaultRoster() {
  return {
    classes: [{
      name: '示例班',
      groups: ['A组', 'B组'],
      students: [
        { name: '张三', sid: '2024001', group: 'A组', weight: 1, pickedCount: 0, right: 0, wrong: 0, none: 0, skipped: 0 },
        { name: '李四', sid: '2024002', group: 'B组', weight: 1, pickedCount: 0, right: 0, wrong: 0, none: 0, skipped: 0 },
        { name: '王五', sid: '2024003', group: 'A组', weight: 2, pickedCount: 0, right: 0, wrong: 0, none: 0, skipped: 0 },
        { name: '赵六', sid: '2024004', group: 'B组', weight: 1, pickedCount: 0, right: 0, wrong: 0, none: 0, skipped: 0 }
      ],
      absent: { date: '', names: [] }   // 当日请假名单（跨天自动失效）
    }],
    places: ['办公室', '教务处', '医务室', '自习室'],
    currentClass: 0
  };
}
function loadJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
let roster = loadJSON(ROSTER_FILE) || defaultRoster();
roster.classes.forEach(c => { if (!c.absent || typeof c.absent !== 'object') c.absent = { date: '', names: [] }; });
// 老名单迁移：补学号字段 + 补班级房间ID(rid) + 补班级设置(prefs)
roster.classes.forEach(c => (c.students || []).forEach(s => { if (s.sid === undefined) s.sid = ''; }));
roster.classes.forEach((c, i) => {
  if (!c.rid) c.rid = genRid(c.name || '', i);
  if (!c.prefs) c.prefs = {};
  if (c.prefs.volume === undefined) c.prefs.volume = 0.3;
  if (c.prefs.animationMs === undefined) c.prefs.animationMs = 3000;
  if (c.prefs.voiceMode === undefined) c.prefs.voiceMode = 'sound';
  if (c.prefs.showTt === undefined) c.prefs.showTt = true;
  if (!c.tt || typeof c.tt !== 'object') c.tt = { am: 4, pm: 3, cells: {} };   // 班级课表
  if (!c.tt.cells) c.tt.cells = {};
  if (!c.tt.times) c.tt.times = {};
  if (!c.tt.am) c.tt.am = 4;
  if (!c.tt.pm) c.tt.pm = 3;
  if (c.tt.pre === undefined) c.tt.pre = 0;    // 早读课开关
  if (c.tt.post === undefined) c.tt.post = 0;  // 晚托课开关
  if (!c.notice || typeof c.notice !== 'object') c.notice = { text: '', at: 0 };   // 班级公告
});
function saveRoster() { fs.writeFileSync(ROSTER_FILE, JSON.stringify(roster, null, 2), 'utf8'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 根据课表时间判断当前属于哪一节（返回 slotKey 如 'pre'/'0'/1...，无课/未配时间返回 null）
function currentSlotKey(tt) {
  if (!tt || !tt.times) return null;
  const now = new Date();
  const dow = now.getDay();           // 1-5 周一~周五
  if (dow < 1 || dow > 5) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const slots = [];
  if (tt.pre) slots.push({ key: 'pre' });
  for (let s = 0; s < (tt.am || 0); s++) slots.push({ key: String(s) });
  for (let s = 0; s < (tt.pm || 0); s++) slots.push({ key: String((tt.am || 0) + s) });
  if (tt.post) slots.push({ key: 'post' });
  for (const sl of slots) {
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
    if (nowMin >= sMin && nowMin < eMin) return sl.key;
  }
  return null;
}
// 返回当前班级当日有效的请假名单（过滤掉已不在名单中的名字）
function absentNames(cls) {
  if (!cls || !cls.absent || cls.absent.date !== todayStr()) return [];
  return cls.absent.names.filter(n => cls.students.some(s => s.name === n));
}

/* ---------------- 多房间会话状态（不落盘，重启即清） ----------------
 * 每个「房间」= 一个班级空间（一块大屏 + 一台控制手机）。
 * URL ?room=X：X 是班级的房间ID(rid)，一个班级一个稳定ID；
 * 切班 = 把 URL 换成目标班级的 rid（前端直接跳转，不再调用 classSwitch）。
 * 同 room 两端联动；不同 room（不同班级）完全独立。默认 '1' 兼容老用法。
 */
function genRid(name, i) {
  let h = 2166136261;
  for (const ch of (name + '#' + i)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return 'c' + (h >>> 0).toString(36);
}
const rooms = new Map();
// 房间绑定班级：room 是某班级 rid 时，班级永远由 rid 决定（不受房间内切班状态影响，杜绝"串班"）
function roomClassIndex(roomId, room) {
  const idx = roster.classes.findIndex(c => c.rid === roomId);
  return idx >= 0 ? idx : room.currentClass;
}
function getRoom(id) {
  id = String(id || '1').slice(0, 24);
  if (!rooms.has(id)) {
    // room 是某班级的 rid 时，该房间直接绑定这个班级，并载入该班已保存的设置；否则用默认值
    const idx = roster.classes.findIndex(c => c.rid === id);
    const p = (idx >= 0 && roster.classes[idx].prefs) || {};
    rooms.set(id, {
      currentClass: idx >= 0 ? idx : 0,
      pickedThisRound: [],   // 本轮已点名单（不复读机用）
      lastPick: null,        // {names:[...], at}
      answering: null,       // {name, deadline, duration}
      page: null,            // {names, place, from, note, duration, sentAt, confirmed, retracted}
      examMode: false,
      volume: p.volume !== undefined ? p.volume : 0.3,
      animationMs: p.animationMs !== undefined ? p.animationMs : 3000,
      rollStyle: 'classic',
      voiceMode: p.voiceMode !== undefined ? p.voiceMode : 'sound',
      lessonLog: [],         // 本节课点名记录
      pageLog: [],           // 今日传呼记录
      unlocked: {}           // 已解锁班级 { index: true }
    });
  }
  return rooms.get(id);
}

/* ---------------- SSE 客户端（按房间分组） ---------------- */
const sseClients = new Set(); // { res, room }
// 把某房间的音量/动画/提示方式写回其绑定班级的 prefs（rid 绑定才有归属；老式自定义房间不落盘）
function saveClassPrefs(roomId, room) {
  const idx = roster.classes.findIndex(c => c.rid === roomId);
  if (idx >= 0) {
    const cls = roster.classes[idx];
    cls.prefs = cls.prefs || {};
    cls.prefs.volume = room.volume;
    cls.prefs.animationMs = room.animationMs;
    cls.prefs.voiceMode = room.voiceMode;
    saveRoster();
  }
}
function broadcast(roomId, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of sseClients) { if (c.room === roomId) { try { c.res.write(payload); } catch (e) { sseClients.delete(c); } } }
}
function lanIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const k of Object.keys(nets)) for (const n of nets[k]) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  return out;
}
function pushState(roomId) { broadcast(roomId, { event: 'state', state: snapshot(roomId) }); }
function snapshot(roomId) {
  const room = getRoom(roomId);
  const cls = roster.classes[roomClassIndex(roomId, room)] || { name: '', students: [] };
  const qs = roomId !== '1' ? '?room=' + encodeURIComponent(roomId) : '';
  return {
    ctrlUrls: lanIPs().map(ip => `http://${ip}:${PORT}/ctrl.html${qs}`),
    className: cls.name,
    groups: cls.groups || [],
    students: cls.students.map(s => ({ name: s.name, sid: s.sid || '', group: s.group, weight: s.weight, pickedCount: s.pickedCount })),
    allClasses: roster.classes.map((c, i) => ({ i, name: c.name, rid: c.rid, locked: !!c.pass })),
    currentClass: roomClassIndex(roomId, room),
    tt: cls.tt || { am: 4, pm: 3, cells: {} },
    showTt: cls.prefs ? cls.prefs.showTt !== false : true,
    notice: cls.notice || { text: '', at: 0 },
    places: roster.places,
    pickedThisRound: room.pickedThisRound,
    lastPick: room.lastPick,
    answering: room.answering,
    page: room.page,
    examMode: room.examMode,
    volume: room.volume,
    animationMs: room.animationMs,
    rollStyle: room.rollStyle,
    voiceMode: room.voiceMode,
    absentToday: absentNames(cls),
    lessonLog: room.lessonLog.slice(-20),
    pageLog: room.pageLog.slice(-50)
  };
}

/* ---------------- 加权抽取（按房间） ---------------- */
function pickStudents(roomId, { group = null, count = 1, noRepeat = true } = {}) {
  const room = getRoom(roomId);
  const cls = roster.classes[roomClassIndex(roomId, room)];
  if (!cls) return [];
  const absent = absentNames(cls);
  let pool = cls.students.filter(s => !group || s.group === group);
  pool = pool.filter(s => !absent.includes(s.name)); // 今日请假自动跳过
  pool = pool.filter(s => (s.weight || 0) > 0);      // 权重 0 = 长期不点，直接排除（这是"调0"真正的生效点）
  if (noRepeat) {
    const avail = pool.filter(s => !room.pickedThisRound.includes(s.name));
    if (avail.length === 0) { room.pickedThisRound = []; pool = pool; } else pool = avail;
  }
  if (pool.length === 0) return [];
  // 有效权重 = weight / (1 + pickedCount)：点过的人自动降权
  const weighted = [];
  for (const s of pool) {
    const w = Math.max(0.01, (s.weight || 1) / (1 + (s.pickedCount || 0)));
    weighted.push([s, w]);
  }
  const picked = [];
  let n = Math.min(count, pool.length);
  for (let k = 0; k < n; k++) {
    let total = weighted.reduce((a, [s, w]) => a + w, 0);
    let r = Math.random() * total, chosen = weighted[0][0], idx = 0;
    for (let i = 0; i < weighted.length; i++) {
      r -= weighted[i][1];
      if (r <= 0) { chosen = weighted[i][0]; idx = i; break; }
    }
    weighted.splice(idx, 1);
    picked.push(chosen);
  }
  return picked;
}

/* ---------------- 指令处理 ---------------- */
function handleCmd(body, res, roomId) {
  const session = getRoom(roomId);
  const cls = roster.classes[roomClassIndex(roomId, session)];
  const find = (name) => cls && cls.students.find(s => s.name === name);
  const disp = (s) => s.group ? `${s.name}(${s.group})` : s.name; // 显示名：带组名
  const now = Date.now();
  let ok = true, msg = '';
  switch (body.action) {
    case 'roll': {
      if (session.answering) { ok = false; msg = '答题进行中'; break; }
      const picked = pickStudents(roomId, body);
      if (picked.length === 0) {
        ok = false;
        const allZero = cls.students.length > 0 && cls.students.every(s => (s.weight || 0) <= 0);
        msg = allZero ? '该范围学生权重均为 0（点名单页改权重或清空请假）' : '该范围无可点名学生（可能全部请假或名单为空）';
        break;
      }
      const names = picked.map(s => s.name);
      const display = picked.map(disp);
      const students = picked.map(s => ({ name: s.name, group: s.group || '' }));
      // 滚动内容用全班姓名（排除当日请假），结果不提前泄漏
      const pool = cls.students.map(s => s.name).filter(n => !absentNames(cls).includes(n));
      picked.forEach(s => { s.pickedCount = (s.pickedCount || 0) + 1; session.pickedThisRound.push(s.name); });
      session.lessonLog.push({ names, display, at: now });
      broadcast(roomId, { event: 'rollStart', duration: session.animationMs, pool });
      const dur = Math.max(500, session.animationMs);
      setTimeout(() => {
        session.lastPick = { names, display, at: Date.now() };
        session.answering = null;
        saveRoster(); pushState(roomId);
        broadcast(roomId, { event: 'rollResult', names, display, students });
      }, dur);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rolling: true }));
      return;
    }
    case 'answerStart': {
      if (!session.lastPick) { ok = false; msg = '请先点名'; break; }
      const d = body.duration | 0; // 秒，0=不限时
      session.answering = { name: (session.lastPick.display || session.lastPick.names).join('、'), deadline: d > 0 ? now + d * 1000 : 0, duration: d };
      broadcast(roomId, { event: 'answerStart', duration: d });
      break;
    }
    case 'mark': {
      if (!session.answering) { ok = false; msg = '无答题中'; break; }
      for (const n of session.lastPick.names) {
        const s = find(n); if (!s) continue;
        if (body.result === 'right') s.right = (s.right || 0) + 1;
        else if (body.result === 'wrong') s.wrong = (s.wrong || 0) + 1;
        else s.none = (s.none || 0) + 1;
      }
      // 每节课答题统计：答出(right/wrong) / 未答出(none)，按「节次_日期」累计
      const sk = currentSlotKey(cls.tt);
      if (sk !== null) {
        cls.tt.stats = cls.tt.stats || {};
        const tkey = sk + '_' + todayStr();
        const st = cls.tt.stats[tkey] || { date: todayStr(), slot: sk, answered: 0, missed: 0, total: 0 };
        st.total += session.lastPick.names.length;
        if (body.result === 'right' || body.result === 'wrong') st.answered += session.lastPick.names.length;
        else st.missed += session.lastPick.names.length;
        cls.tt.stats[tkey] = st;
      }
      session.answering = null;
      saveRoster();
      broadcast(roomId, { event: 'marked', result: body.result });
      break;
    }
    case 'skip': {
      if (!session.lastPick) { ok = false; msg = '请先点名'; break; }
      for (const n of session.lastPick.names) { const s = find(n); if (s) s.skipped = (s.skipped || 0) + 1; }
      const sk2 = currentSlotKey(cls.tt);
      if (sk2 !== null) {
        cls.tt.stats = cls.tt.stats || {};
        const tkey2 = sk2 + '_' + todayStr();
        const st2 = cls.tt.stats[tkey2] || { date: todayStr(), slot: sk2, answered: 0, missed: 0, total: 0 };
        st2.total += session.lastPick.names.length;
        st2.missed += session.lastPick.names.length;
        cls.tt.stats[tkey2] = st2;
      }
      session.answering = null; session.lastPick = null;
      saveRoster(); broadcast(roomId, { event: 'skipped' });
      // 自动连抽下一名
      const picked = pickStudents(roomId, { noRepeat: true });
      if (picked.length) {
        const names = picked.map(s => s.name);
        const display = picked.map(disp);
        const students = picked.map(s => ({ name: s.name, group: s.group || '' }));
        const pool2 = cls.students.map(s => s.name).filter(n => !absentNames(cls).includes(n));
        picked.forEach(s => { s.pickedCount = (s.pickedCount || 0) + 1; session.pickedThisRound.push(s.name); });
        session.lessonLog.push({ names, display, at: Date.now() });
        broadcast(roomId, { event: 'rollStart', duration: session.animationMs, pool: pool2 });
        setTimeout(() => {
          session.lastPick = { names, display, at: Date.now() };
          saveRoster(); pushState(roomId); broadcast(roomId, { event: 'rollResult', names, display, students });
        }, Math.max(500, session.animationMs));
      }
      break;
    }
    case 'resetRound': session.pickedThisRound = []; session.lastPick = null; session.answering = null; break;
    case 'page': {
      // 姓名+学号成对校验：学号用于区分同名，无学号的学生 sids 为空串（兼容旧控制端）
      const pairs = (body.names || []).map((n, i) => ({ n, s: (body.sids || [])[i] || '' })).filter(p => find(p.n));
      const names = pairs.map(p => p.n), sids = pairs.map(p => p.s);
      if (names.length === 0) { ok = false; msg = '学生不在名单内'; break; }
      session.page = {
        names, sids, place: String(body.place || '办公室').slice(0, 20),
        from: String(body.from || '').slice(0, 20),
        note: String(body.note || '').slice(0, 30),
        // 显示时长：0=常驻；允许任意秒数（0~3600），非法回退 30
        duration: (Number.isFinite(+body.duration) && +body.duration >= 0 && +body.duration <= 3600) ? (+body.duration | 0) : 30,
        sentAt: now, confirmed: false, retracted: false
      };
      session.pageLog.push({ names, sids, place: session.page.place, from: session.page.from, sentAt: now, confirmed: false, retracted: false });
      broadcast(roomId, { event: 'page', page: session.page });
      break;
    }
    case 'pageConfirm': if (session.page) { session.page.confirmed = true; session.pageLog.forEach(p => { if (!p.retracted && !p.confirmed) p.confirmed = true; }); } break;
    case 'pageRetract': if (session.page) { session.page.retracted = true; session.pageLog.forEach(p => { if (!p.confirmed) p.retracted = true; }); session.page = null; } break;
    case 'examMode': session.examMode = !!body.on; break;
    // 班级设置：改动即写回班级 prefs 持久化（rid 绑定的房间），重启不丢
    case 'setVolume': session.volume = Math.min(1, Math.max(0, +body.value || 0)); saveClassPrefs(roomId, session); break;
    case 'setAnim': session.animationMs = [2000, 3000, 5000].includes(body.ms) ? body.ms : 3000; saveClassPrefs(roomId, session); break;
    case 'setRollStyle': session.rollStyle = 'classic'; break; // 兼容旧指令，样式已固定
    case 'setVoiceMode': session.voiceMode = ['sound', 'ai', 'both'].includes(body.mode) ? body.mode : 'sound'; saveClassPrefs(roomId, session); break;
    // 班级课表：节数配置 / 单格课程 / 清空（存班级对象，持久化）
    case 'ttConfig': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      const am = Math.min(8, Math.max(1, body.am | 0));
      const pm = Math.min(8, Math.max(1, body.pm | 0));
      cls.tt = { am, pm, pre: cls.tt && cls.tt.pre ? 1 : 0, post: cls.tt && cls.tt.post ? 1 : 0, cells: cls.tt && cls.tt.cells ? cls.tt.cells : {}, times: cls.tt && cls.tt.times ? cls.tt.times : {} };
      saveRoster(); msg = `课表已设为上午${am}节、下午${pm}节`;
      break;
    }
    case 'ttExtra': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      if (body.pre !== undefined) cls.tt.pre = body.pre ? 1 : 0;
      if (body.post !== undefined) cls.tt.post = body.post ? 1 : 0;
      saveRoster(); msg = '已更新早读/晚托设置';
      break;
    }
    case 'ttStatsClear': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      cls.tt.stats = {};
      saveRoster(); msg = '答题统计已清空';
      break;
    }
    case 'ttCell': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      const day = body.day | 0;
      const slotKey = String(body.slot);
      const isExtra = slotKey === 'pre' || slotKey === 'post';
      if (day < 1 || day > 5 || (!isExtra && (isNaN(+slotKey) || +slotKey < 0 || +slotKey >= (cls.tt.am + cls.tt.pm)))) { ok = false; msg = '无效位置'; break; }
      const course = String(body.course || '').trim().slice(0, 12);
      if (course) cls.tt.cells[day + '_' + slotKey] = course; else delete cls.tt.cells[day + '_' + slotKey];
      saveRoster();
      break;
    }
    case 'ttClear': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      cls.tt.cells = {}; saveRoster(); msg = '课表已清空';
      break;
    }
    case 'ttTime': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      const slotKey = String(body.slot);
      const isExtra = slotKey === 'pre' || slotKey === 'post';
      if (!isExtra && (isNaN(+slotKey) || +slotKey < 0 || +slotKey >= (cls.tt.am + cls.tt.pm))) { ok = false; msg = '无效节次'; break; }
      const start = String(body.start || '').trim().slice(0, 5);
      const end = String(body.end || '').trim().slice(0, 5);
      cls.tt.times = cls.tt.times || {};
      if (start || end) cls.tt.times[slotKey] = { s: start, e: end };
      else delete cls.tt.times[slotKey];
      saveRoster();
      break;
    }
    case 'setShowTt': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      cls.prefs = cls.prefs || {};
      cls.prefs.showTt = !!body.on;
      saveRoster(); msg = body.on ? '大屏已显示课表' : '大屏已隐藏课表';
      break;
    }
    case 'setClassPass': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      const old = String(body.old || '');
      if (cls.pass && old !== cls.pass) { ok = false; msg = '原密码不正确'; break; }
      const pass = String(body.pass || '').trim().slice(0, 20);
      cls.pass = pass || '';
      const ci = roster.classes.indexOf(cls);
      rooms.forEach(r => { delete r.unlocked[ci]; });   // 改密后旧解锁全部失效
      saveRoster();
      msg = pass ? '班级密码已设置' : '班级密码已移除';
      break;
    }
    case 'setNotice': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      const text = String(body.text || '').trim().slice(0, 120);
      cls.notice = { text, at: text ? Date.now() : 0 };
      saveRoster(); msg = text ? '公告已发布' : '公告已清除';
      break;
    }
    case 'classSwitch': {
      const i = body.index | 0;
      if (!roster.classes[i]) { ok = false; msg = '班级不存在'; break; }
      const target = roster.classes[i];
      // 有密码的班级：需输入密码（本会话解锁过则免）
      if (target.pass && !session.unlocked[i] && String(body.pass || '') !== target.pass) {
        ok = false; msg = '需要班级密码'; break;
      }
      session.currentClass = i; roster.currentClass = i;
      if (target.pass) session.unlocked[i] = true;
      saveRoster(); session.pickedThisRound = []; session.lastPick = null; session.answering = null;
      break;
    }
    case 'renameClass': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      const name = String(body.name || '').trim().slice(0, 20);
      if (!name) { ok = false; msg = '班级名称为空'; break; }
      cls.name = name; saveRoster(); msg = `班级已改名为「${name}」`;
      break;
    }
    case 'addClass': {
      const name = String(body.name || '').trim().slice(0, 20) || `新班级${roster.classes.length + 1}`;
      const pass = String(body.pass || '').trim().slice(0, 20);
      roster.classes.push({ name, rid: genRid(name, roster.classes.length), groups: [], students: [], absent: { date: '', names: [] }, pass });
      roster.currentClass = roster.classes.length - 1; session.currentClass = roster.currentClass;
      if (pass) session.unlocked[roster.currentClass] = true;
      session.pickedThisRound = []; session.lastPick = null; session.answering = null; session.page = null;
      saveRoster();
      msg = pass ? `已创建班级「${name}」（已设置密码）` : `已创建班级「${name}」`;
      break;
    }
    case 'delClass': {
      if (roster.classes.length <= 1) { ok = false; msg = '至少保留一个班级'; break; }
      if (body.confirm !== true) { ok = false; msg = '未确认删除'; break; }
      const i = (body.index !== undefined) ? (body.index | 0) : roster.currentClass;
      if (!roster.classes[i]) { ok = false; msg = '班级不存在'; break; }
      // 有密码的班级：删除需密码
      if (roster.classes[i].pass && String(body.pass || '') !== roster.classes[i].pass) {
        ok = false; msg = '需要班级密码'; break;
      }
      const nm = roster.classes[i].name;
      roster.classes.splice(i, 1);
      if (roster.currentClass >= roster.classes.length) roster.currentClass = roster.classes.length - 1;
      rooms.forEach(r => { if (r.currentClass >= roster.classes.length) r.currentClass = roster.classes.length - 1; delete r.unlocked[i]; });
      session.pickedThisRound = []; session.lastPick = null; session.answering = null; session.page = null;
      saveRoster();
      msg = `已删除班级「${nm}」`;
      break;
    }
    case 'importRoster': {
      // 支持格式：姓名 / 姓名,学号 / 姓名,组别,权重(旧) / 姓名,学号,组别 / 姓名,学号,组别,权重
      const lines = String(body.text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const students = lines.map(l => {
        const p = l.split(/[,，\t]/).map(x => x.trim());
        let name = p[0], sid = '', group = '', weight = 1;
        if (p.length >= 4) { sid = p[1]; group = p[2]; weight = parseFloat(p[3]) || 1; }
        else if (p.length === 3) {
          if (isNaN(parseFloat(p[2]))) { sid = p[1]; group = p[2]; }   // 姓名,学号,组别
          else { group = p[1]; weight = parseFloat(p[2]) || 1; }        // 姓名,组别,权重（旧）
        }
        else if (p.length === 2) {
          if (/^\d+$/.test(p[1])) sid = p[1]; else group = p[1];        // 姓名,学号 或 姓名,组别
        }
        return { name, sid: sid.slice(0, 20), group: group.slice(0, 12), weight, pickedCount: 0, right: 0, wrong: 0, none: 0, skipped: 0 };
      }).filter(s => s.name);
      if (students.length === 0) { ok = false; msg = '没有解析到有效名单'; break; }
      const name = String(body.className || '').trim() || `导入班${roster.classes.length + 1}`;
      const groups = [...new Set(students.map(s => s.group).filter(Boolean))];
      roster.classes.push({ name, rid: genRid(name, roster.classes.length), groups, students });
      roster.currentClass = roster.classes.length - 1; session.currentClass = roster.currentClass;
      session.pickedThisRound = []; session.lastPick = null; session.answering = null;
      saveRoster();
      msg = `已导入「${name}」${students.length} 人`;
      break;
    }
    case 'replaceRoster': {
      // 替换已有班级的完整名单（保留 prefs/课表/公告等班级设置，统计清零）
      const lines = String(body.text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const students = lines.map(l => {
        const p = l.split(/[,，\t]/).map(x => x.trim());
        let name = p[0], sid = '', group = '', weight = 1;
        if (p.length >= 4) { sid = p[1]; group = p[2]; weight = parseFloat(p[3]) || 1; }
        else if (p.length === 3) {
          if (isNaN(parseFloat(p[2]))) { sid = p[1]; group = p[2]; }
          else { group = p[1]; weight = parseFloat(p[2]) || 1; }
        }
        else if (p.length === 2) {
          if (/^\d+$/.test(p[1])) sid = p[1]; else group = p[1];
        }
        return { name, sid: sid.slice(0, 20), group: group.slice(0, 12), weight, pickedCount: 0, right: 0, wrong: 0, none: 0, skipped: 0 };
      }).filter(s => s.name);
      if (students.length === 0) { ok = false; msg = '没有解析到有效名单'; break; }
      const norm = s => String(s || '').replace(/[（）()]/g, '').trim();
      let ci = -1;
      if (body.rid) ci = roster.classes.findIndex(c => c.rid === String(body.rid));
      if (ci < 0 && body.name) ci = roster.classes.findIndex(c => norm(c.name) === norm(body.name));
      if (ci < 0) { ok = false; msg = '未找到目标班级'; break; }
      const target = roster.classes[ci];
      target.students = students;
      target.groups = [...new Set(students.map(s => s.group).filter(Boolean))];
      target.absent = { date: '', names: [] };
      saveRoster();
      msg = `已导入「${target.name}」${students.length} 人`;
      break;
    }
    case 'addStudent': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      const name = String(body.name || '').trim().slice(0, 20);
      if (!name || find(name)) { ok = false; msg = '姓名为空或重复'; break; }
      cls.students.push({ name, sid: String(body.sid || '').trim().slice(0, 20), group: String(body.group || '').trim(), weight: parseFloat(body.weight) || 1, pickedCount: 0, right: 0, wrong: 0, none: 0, skipped: 0 });
      if (body.group && !cls.groups.includes(body.group)) cls.groups.push(body.group);
      saveRoster();
      break;
    }
    case 'setSid': {
      const s = find(String(body.name || ''));
      if (!s) { ok = false; msg = '学生不存在'; break; }
      s.sid = String(body.sid || '').trim().slice(0, 20);
      saveRoster();
      break;
    }
    case 'delStudent': {
      if (!cls) break;
      cls.students = cls.students.filter(s => s.name !== body.name);
      saveRoster();
      break;
    }
    case 'setWeight': {
      const s = find(String(body.name || ''));
      if (!s) { ok = false; msg = '学生不存在'; break; }
      const w = parseFloat(body.weight);
      if (isNaN(w) || w < 0 || w > 99) { ok = false; msg = '权重需在 0~99 之间'; break; }
      s.weight = Math.round(w * 10) / 10;
      saveRoster();
      msg = w === 0 ? `${s.name} 已设为 0（不会被抽中）` : `${s.name} 权重已改为 ${s.weight}`;
      break;
    }
    case 'setAbsent': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      const names = (Array.isArray(body.names) ? body.names : []).filter(n => cls.students.some(s => s.name === n));
      cls.absent = { date: todayStr(), names };
      saveRoster();
      msg = names.length ? `今日请假已保存：${names.join('、')}（点名时自动跳过）` : '今日无请假';
      break;
    }
    case 'clearAbsent': {
      if (!cls) break;
      cls.absent = { date: '', names: [] };
      saveRoster();
      msg = '已清除今日请假名单';
      break;
    }
    case 'addGroup': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      const g = String(body.name || '').trim().slice(0, 12);
      if (!g) { ok = false; msg = '组名为空'; break; }
      if (!cls.groups.includes(g)) { cls.groups.push(g); saveRoster(); msg = `已添加组「${g}」`; }
      break;
    }
    case 'delGroup': {
      if (!cls) break;
      const g = String(body.name || '');
      cls.groups = (cls.groups || []).filter(x => x !== g);
      cls.students.forEach(s => { if (s.group === g) s.group = ''; }); // 组删了，学生保留
      saveRoster();
      msg = `已删除组「${g}」（学生保留，组别已清空）`;
      break;
    }
    case 'addPlace': {
      const p = String(body.name || '').trim().slice(0, 20);
      if (p && !roster.places.includes(p)) { roster.places.push(p); saveRoster(); }
      break;
    }
    case 'resetStats': {
      if (!cls) break;
      cls.students.forEach(s => { s.pickedCount = 0; s.right = 0; s.wrong = 0; s.none = 0; s.skipped = 0; });
      session.pickedThisRound = []; session.lessonLog = [];
      saveRoster();
      msg = '统计已清零';
      break;
    }
    default: ok = false; msg = '未知指令';
  }
  pushState(roomId);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok, msg }));
}

/* ---------------- HTTP 服务 ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const roomId = url.searchParams.get('room') || '1';
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write(`data: ${JSON.stringify({ event: 'state', state: snapshot(roomId) })}\n\n`);
    const client = { res, room: roomId };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }
  if (url.pathname === '/api/cmd' && req.method === 'POST') {
    const body = await readBody(req);
    return handleCmd(body, res, roomId);
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(snapshot(roomId)));
  }
  // 静态文件
  let p = url.pathname === '/' ? '/screen.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(p).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[ERROR] 端口 ${PORT} 已被占用！请先关闭旧的服务窗口（黑底窗口），再重新运行本程序。`);
    console.error('        （或换端口：先 set PORT=8081 再运行 node server.js）');
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  课堂互动大屏服务已启动（零依赖 · 离线可用）');
  console.log(`  大屏页(本机): http://localhost:${PORT}/screen.html`);
  console.log('  教师端候选地址（手机连哪个网就用哪个，含USB网络共享/热点）:');
  for (const ip of lanIPs()) console.log(`    http://${ip}:${PORT}/ctrl.html`);
  console.log('==============================================');
});

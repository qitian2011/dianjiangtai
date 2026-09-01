/**
 * 点将台 · Cloudflare Workers 版
 * 架构：Worker（路由 + 静态资产）+ Durable Object「Room」（教室状态 + SSE 广播 + 名单持久化）
 * - 名单持久化在 DO storage（免费版 SQLite 存储），重启不丢
 * - 会话状态（本轮已点、答题、传呼）在内存，DO 重启即清（与本地版一致）
 * - PIN 访问控制：wrangler.jsonc vars.PIN，非空时 /events 与 /api/* 都需要密码
 * 部署：在 app 目录执行 `wrangler deploy`
 */

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
      absent: { date: '', names: [] }
    }],
    places: ['办公室', '教务处', '医务室', '自习室'],
    currentClass: 0
  };
}
// 东八区日期（Cloudflare 服务器是 UTC，直接用本地日期会在早上 8 点才换天）
function todayStr() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}
// 根据课表时间判断当前属于哪一节（返回 slotKey 如 'pre'/'0'/1...，无课/未配时间返回 null）
function currentSlotKey(tt) {
  if (!tt || !tt.times) return null;
  // Cloudflare 服务器是 UTC，先偏移到东八区再判断（否则节次时间全部错位 8 小时）
  const sh = new Date(Date.now() + 8 * 3600 * 1000);
  const dow = sh.getUTCDay();          // 1-5 周一~周五（东八区视角）
  if (dow < 1 || dow > 5) return null;
  const nowMin = sh.getUTCHours() * 60 + sh.getUTCMinutes();
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
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

/* ---------------- Durable Object：一间教室 ---------------- */
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sse = new Set();       // SSE 连接集合 {push, close, room}
    this.hb = null;             // 心跳定时器
    this.origin = null;
    this.roster = null;
    this.rooms = new Map();     // 多房间：{roomId: {currentClass, pickedThisRound, ...}}
    this.ready = this.init();
  }
  async init() {
    let roster = await this.state.storage.get('roster');
    if (!roster) roster = defaultRoster();
    roster.classes.forEach(c => { if (!c.absent || typeof c.absent !== 'object') c.absent = { date: '', names: [] }; });
    // 老名单迁移：补学号字段 + 补班级房间ID(rid)
    roster.classes.forEach(c => (c.students || []).forEach(s => { if (s.sid === undefined) s.sid = ''; }));
    roster.classes.forEach((c, i) => {
      if (!c.rid) c.rid = this.genRid(c.name || '', i);
      if (!c.prefs) c.prefs = {};
      if (c.prefs.volume === undefined) c.prefs.volume = 0.3;
      if (c.prefs.animationMs === undefined) c.prefs.animationMs = 3000;
      if (c.prefs.voiceMode === undefined) c.prefs.voiceMode = 'sound';
      if (c.prefs.showTt === undefined) c.prefs.showTt = true;
      if (!c.tt || typeof c.tt !== 'object') c.tt = { am: 4, pm: 3, cells: {} };
      if (!c.tt.cells) c.tt.cells = {};
      if (!c.tt.times) c.tt.times = {};
      if (!c.tt.am) c.tt.am = 4;
      if (!c.tt.pm) c.tt.pm = 3;
      if (c.tt.pre === undefined) c.tt.pre = 0;    // 早读课开关
      if (c.tt.post === undefined) c.tt.post = 0;  // 晚托课开关
      if (!c.notice || typeof c.notice !== 'object') c.notice = { text: '', at: 0 };
    });
    this.roster = roster;
  }
  genRid(name, i) {
    let h = 2166136261;
    for (const ch of (name + '#' + i)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return 'c' + (h >>> 0).toString(36);
  }
  // 房间绑定班级：room 是某班级 rid 时，班级永远由 rid 决定（不受房间内切班状态影响）
  roomClassIndex(roomId, room) {
    const idx = this.roster.classes.findIndex(c => c.rid === roomId);
    return idx >= 0 ? idx : room.currentClass;
  }
  getRoom(id) {
    id = String(id || '1').slice(0, 24);
    if (!this.rooms.has(id)) {
      const idx = this.roster.classes.findIndex(c => c.rid === id);
      const p = (idx >= 0 && this.roster.classes[idx].prefs) || {};
      this.rooms.set(id, {
        currentClass: idx >= 0 ? idx : 0,   // room 是班级 rid 时绑定该班级，否则从第一个班级开始
        pickedThisRound: [], lastPick: null, answering: null, page: null,
        examMode: false,
        volume: p.volume !== undefined ? p.volume : 0.3,
        animationMs: p.animationMs !== undefined ? p.animationMs : 3000,
        rollStyle: 'classic',
        voiceMode: p.voiceMode !== undefined ? p.voiceMode : 'sound',
        lessonLog: [], pageLog: [], unlocked: {}
      });
    }
    return this.rooms.get(id);
  }
  saveRoster() { return this.state.storage.put('roster', this.roster); }
  // 把房间设置写回其绑定班级的 prefs（rid 绑定才有归属；老式自定义房间不落盘）
  saveClassPrefs(roomId, room) {
    const idx = this.roster.classes.findIndex(c => c.rid === roomId);
    if (idx >= 0) {
      const cls = this.roster.classes[idx];
      cls.prefs = cls.prefs || {};
      cls.prefs.volume = room.volume;
      cls.prefs.animationMs = room.animationMs;
      cls.prefs.voiceMode = room.voiceMode;
      this.saveRoster();
    }
  }
  absentNames(cls) {
    if (!cls || !cls.absent || cls.absent.date !== todayStr()) return [];
    return cls.absent.names.filter(n => cls.students.some(s => s.name === n));
  }
  snapshot(roomId) {
    const room = this.getRoom(roomId);
    const cls = this.roster.classes[this.roomClassIndex(roomId, room)] || { name: '', students: [] };
    const qs = roomId !== '1' ? '?room=' + encodeURIComponent(roomId) : '';
    return {
      ctrlUrls: [`${this.origin}/ctrl.html${qs}`],
      className: cls.name,
      groups: cls.groups || [],
      students: cls.students.map(x => ({ name: x.name, sid: x.sid || '', group: x.group, weight: x.weight, pickedCount: x.pickedCount })),
      allClasses: this.roster.classes.map((c, i) => ({ i, name: c.name, rid: c.rid, locked: !!c.pass })),
      currentClass: this.roomClassIndex(roomId, room),
      tt: cls.tt || { am: 4, pm: 3, cells: {} },
      showTt: cls.prefs ? cls.prefs.showTt !== false : true,
      notice: cls.notice || { text: '', at: 0 },
      places: this.roster.places,
      pickedThisRound: room.pickedThisRound,
      lastPick: room.lastPick,
      answering: room.answering,
      page: room.page,
      examMode: room.examMode,
      volume: room.volume,
      animationMs: room.animationMs,
      rollStyle: room.rollStyle,
      voiceMode: room.voiceMode,
      absentToday: this.absentNames(cls),
      lessonLog: room.lessonLog.slice(-20),
      pageLog: room.pageLog.slice(-50)
    };
  }
  raw(payload) {
    for (const w of this.sse) { try { w.push(payload); } catch (e) { this.sse.delete(w); } }
  }
  broadcast(roomId, event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const w of this.sse) { if (w.room === roomId) { try { w.push(payload); } catch (e) { this.sse.delete(w); } } }
  }
  pushState(roomId) { this.broadcast(roomId, { event: 'state', state: this.snapshot(roomId) }); }
  ensureHeartbeat() {
    if (this.hb) return;
    this.hb = setInterval(() => { if (this.sse.size) this.raw(': ping\n\n'); }, 25000);
  }
  sseResponse(roomId) {
    this.ensureHeartbeat();
    const enc = new TextEncoder();
    let entry = null;
    const stream = new ReadableStream({
      start: (ctrl) => {
        entry = {
          push: (s) => ctrl.enqueue(enc.encode(s)),
          close: () => { try { ctrl.close(); } catch (e) {} },
          room: roomId
        };
        this.sse.add(entry);
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ event: 'state', state: this.snapshot(roomId) })}\n\n`));
      },
      cancel: () => { if (entry) this.sse.delete(entry); }
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*'
      }
    });
  }

  /* ---------------- 加权抽取 ---------------- */
  pickStudents(roomId, { group = null, count = 1, noRepeat = true } = {}) {
    const room = this.getRoom(roomId);
    const cls = this.roster.classes[this.roomClassIndex(roomId, room)];
    if (!cls) return [];
    const absent = this.absentNames(cls);
    let pool = cls.students.filter(x => !group || x.group === group);
    pool = pool.filter(x => !absent.includes(x.name));
    pool = pool.filter(x => (x.weight || 0) > 0);
    if (noRepeat) {
      const avail = pool.filter(x => !room.pickedThisRound.includes(x.name));
      if (avail.length > 0) pool = avail;
      else room.pickedThisRound = [];
    }
    if (pool.length === 0) return [];
    const weighted = [];
    for (const x of pool) {
      const w = Math.max(0.01, (x.weight || 1) / (1 + (x.pickedCount || 0)));
      weighted.push([x, w]);
    }
    const picked = [];
    const n = Math.min(count, pool.length);
    for (let k = 0; k < n; k++) {
      let total = weighted.reduce((a, [x, w]) => a + w, 0);
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
  async handleCmd(body, roomId) {
    await this.ready;
    const roster = this.roster, session = this.getRoom(roomId);
    const cls = roster.classes[this.roomClassIndex(roomId, session)];
    const find = (name) => cls && cls.students.find(x => x.name === name);
    const disp = (x) => x.group ? `${x.name}(${x.group})` : x.name;
    const now = Date.now();
    let ok = true, msg = '';
    switch (body.action) {
      case 'roll': {
        if (session.answering) { ok = false; msg = '答题进行中'; break; }
        const picked = this.pickStudents(roomId, body);
        if (picked.length === 0) {
          ok = false;
          const allZero = cls.students.length > 0 && cls.students.every(x => (x.weight || 0) <= 0);
          msg = allZero ? '该范围学生权重均为 0（点名单页改权重或清空请假）' : '该范围无可点名学生（可能全部请假或名单为空）';
          break;
        }
        const names = picked.map(x => x.name);
        const display = picked.map(disp);
        const students = picked.map(x => ({ name: x.name, group: x.group || '' }));
        const pool = cls.students.map(x => x.name).filter(n => !this.absentNames(cls).includes(n));
        picked.forEach(x => { x.pickedCount = (x.pickedCount || 0) + 1; session.pickedThisRound.push(x.name); });
        session.lessonLog.push({ names, display, at: now });
        this.broadcast(roomId, { event: 'rollStart', duration: session.animationMs, pool });
        const dur = Math.max(500, session.animationMs);
        setTimeout(() => {
          session.lastPick = { names, display, at: Date.now() };
          session.answering = null;
          this.saveRoster(); this.pushState(roomId);
          this.broadcast(roomId, { event: 'rollResult', names, display, students });
        }, dur);
        // 与本地版一致：动画期间不推中间 state（否则大屏滚动视图会被打断），结果出来后再推
        return json({ ok: true, msg: '', rolling: true });
      }
      case 'answerStart': {
        if (!session.lastPick) { ok = false; msg = '请先点名'; break; }
        const d = body.duration | 0;
        session.answering = { name: (session.lastPick.display || session.lastPick.names).join('、'), deadline: d > 0 ? now + d * 1000 : 0, duration: d };
        this.broadcast(roomId, { event: 'answerStart', duration: d });
        break;
      }
      case 'mark': {
        if (!session.answering) { ok = false; msg = '无答题中'; break; }
        for (const n of session.lastPick.names) {
          const x = find(n); if (!x) continue;
          if (body.result === 'right') x.right = (x.right || 0) + 1;
          else if (body.result === 'wrong') x.wrong = (x.wrong || 0) + 1;
          else x.none = (x.none || 0) + 1;
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
        this.saveRoster();
        this.broadcast(roomId, { event: 'marked', result: body.result });
        break;
      }
      case 'skip': {
        if (!session.lastPick) { ok = false; msg = '请先点名'; break; }
        for (const n of session.lastPick.names) { const x = find(n); if (x) x.skipped = (x.skipped || 0) + 1; }
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
        this.saveRoster(); this.broadcast(roomId, { event: 'skipped' });
        const picked = this.pickStudents(roomId, { noRepeat: true });
        if (picked.length) {
          const names = picked.map(x => x.name);
          const display = picked.map(disp);
          const students = picked.map(x => ({ name: x.name, group: x.group || '' }));
          const pool2 = cls.students.map(x => x.name).filter(n => !this.absentNames(cls).includes(n));
          picked.forEach(x => { x.pickedCount = (x.pickedCount || 0) + 1; session.pickedThisRound.push(x.name); });
          session.lessonLog.push({ names, display, at: Date.now() });
          this.broadcast(roomId, { event: 'rollStart', duration: session.animationMs, pool: pool2 });
          setTimeout(() => {
            session.lastPick = { names, display, at: Date.now() };
            this.saveRoster(); this.pushState(roomId); this.broadcast(roomId, { event: 'rollResult', names, display, students });
          }, Math.max(500, session.animationMs));
        }
        break;
      }
      case 'resetRound': session.pickedThisRound = []; session.lastPick = null; session.answering = null; break;
      case 'page': {
        const names = (body.names || []).filter(n => find(n));
        if (names.length === 0) { ok = false; msg = '学生不在名单内'; break; }
        session.page = {
          names, place: String(body.place || '办公室').slice(0, 20),
          from: String(body.from || '').slice(0, 20),
          note: String(body.note || '').slice(0, 30),
          duration: (Number.isFinite(+body.duration) && +body.duration >= 0 && +body.duration <= 3600) ? (+body.duration | 0) : 30,
          sentAt: now, confirmed: false, retracted: false
        };
        session.pageLog.push({ names, place: session.page.place, from: session.page.from, sentAt: now, confirmed: false, retracted: false });
        this.broadcast(roomId, { event: 'page', page: session.page });
        break;
      }
      case 'pageConfirm': if (session.page) { session.page.confirmed = true; session.pageLog.forEach(p => { if (!p.retracted && !p.confirmed) p.confirmed = true; }); } break;
      case 'pageRetract': if (session.page) { session.page.retracted = true; session.pageLog.forEach(p => { if (!p.confirmed) p.retracted = true; }); session.page = null; } break;
      case 'examMode': session.examMode = !!body.on; break;
      case 'setVolume': session.volume = Math.min(1, Math.max(0, +body.value || 0)); this.saveClassPrefs(roomId, session); break;
      case 'setAnim': session.animationMs = [2000, 3000, 5000].includes(body.ms) ? body.ms : 3000; this.saveClassPrefs(roomId, session); break;
      case 'setRollStyle': session.rollStyle = 'classic'; break;
      case 'setVoiceMode': session.voiceMode = ['sound', 'ai', 'both'].includes(body.mode) ? body.mode : 'sound'; this.saveClassPrefs(roomId, session); break;
      // 班级课表：节数配置 / 单格课程 / 清空（存班级对象，持久化）
      case 'ttConfig': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        const am = Math.min(8, Math.max(1, body.am | 0));
        const pm = Math.min(8, Math.max(1, body.pm | 0));
        cls.tt = { am, pm, pre: cls.tt && cls.tt.pre ? 1 : 0, post: cls.tt && cls.tt.post ? 1 : 0, cells: cls.tt && cls.tt.cells ? cls.tt.cells : {}, times: cls.tt && cls.tt.times ? cls.tt.times : {} };
        this.saveRoster(); msg = `课表已设为上午${am}节、下午${pm}节`;
        break;
      }
      case 'ttExtra': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        if (body.pre !== undefined) cls.tt.pre = body.pre ? 1 : 0;
        if (body.post !== undefined) cls.tt.post = body.post ? 1 : 0;
        this.saveRoster(); msg = '已更新早读/晚托设置';
        break;
      }
      case 'ttStatsClear': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        cls.tt.stats = {};
        this.saveRoster(); msg = '答题统计已清空';
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
        this.saveRoster();
        break;
      }
      case 'ttClear': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        cls.tt.cells = {}; this.saveRoster(); msg = '课表已清空';
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
        this.saveRoster();
        break;
      }
      case 'setShowTt': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        cls.prefs = cls.prefs || {};
        cls.prefs.showTt = !!body.on;
        this.saveRoster(); msg = body.on ? '大屏已显示课表' : '大屏已隐藏课表';
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
      this.saveRoster();
      msg = pass ? '班级密码已设置' : '班级密码已移除';
      break;
    }
    case 'setNotice': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        const text = String(body.text || '').trim().slice(0, 120);
        cls.notice = { text, at: text ? Date.now() : 0 };
        this.saveRoster(); msg = text ? '公告已发布' : '公告已清除';
        break;
      }
      case 'classSwitch': {
        const i = body.index | 0;
        if (!roster.classes[i]) { ok = false; msg = '班级不存在'; break; }
        const target = roster.classes[i];
        if (target.pass && !session.unlocked[i] && String(body.pass || '') !== target.pass) {
          ok = false; msg = '需要班级密码'; break;
        }
        session.currentClass = i; roster.currentClass = i;
        if (target.pass) session.unlocked[i] = true;
        this.saveRoster(); session.pickedThisRound = []; session.lastPick = null; session.answering = null;
        break;
      }
      case 'renameClass': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        const name = String(body.name || '').trim().slice(0, 20);
        if (!name) { ok = false; msg = '班级名称为空'; break; }
        cls.name = name; this.saveRoster(); msg = `班级已改名为「${name}」`;
        break;
      }
      case 'addClass': {
        const name = String(body.name || '').trim().slice(0, 20) || `新班级${roster.classes.length + 1}`;
        const pass = String(body.pass || '').trim().slice(0, 20);
        roster.classes.push({ name, rid: this.genRid(name, roster.classes.length), groups: [], students: [], absent: { date: '', names: [] }, pass });
        roster.currentClass = roster.classes.length - 1; session.currentClass = roster.currentClass;
        if (pass) session.unlocked[roster.currentClass] = true;
        session.pickedThisRound = []; session.lastPick = null; session.answering = null; session.page = null;
        this.saveRoster();
        msg = pass ? `已创建班级「${name}」（已设置密码）` : `已创建班级「${name}」`;
        break;
      }
      case 'delClass': {
        if (roster.classes.length <= 1) { ok = false; msg = '至少保留一个班级'; break; }
        if (body.confirm !== true) { ok = false; msg = '未确认删除'; break; }
        const i = (body.index !== undefined) ? (body.index | 0) : roster.currentClass;
        if (!roster.classes[i]) { ok = false; msg = '班级不存在'; break; }
        if (roster.classes[i].pass && String(body.pass || '') !== roster.classes[i].pass) {
          ok = false; msg = '需要班级密码'; break;
        }
        const nm = roster.classes[i].name;
        roster.classes.splice(i, 1);
        if (roster.currentClass >= roster.classes.length) roster.currentClass = roster.classes.length - 1;
        this.rooms.forEach(r => { if (r.currentClass >= roster.classes.length) r.currentClass = roster.classes.length - 1; delete r.unlocked[i]; });
        session.pickedThisRound = []; session.lastPick = null; session.answering = null; session.page = null;
        this.saveRoster();
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
            if (isNaN(parseFloat(p[2]))) { sid = p[1]; group = p[2]; }
            else { group = p[1]; weight = parseFloat(p[2]) || 1; }
          }
          else if (p.length === 2) {
            if (/^\d+$/.test(p[1])) sid = p[1]; else group = p[1];
          }
          return { name, sid: sid.slice(0, 20), group: group.slice(0, 12), weight, pickedCount: 0, right: 0, wrong: 0, none: 0, skipped: 0 };
        }).filter(x => x.name);
        if (students.length === 0) { ok = false; msg = '没有解析到有效名单'; break; }
        const name = String(body.className || '').trim() || `导入班${roster.classes.length + 1}`;
        const groups = [...new Set(students.map(x => x.group).filter(Boolean))];
        roster.classes.push({ name, rid: this.genRid(name, roster.classes.length), groups, students });
        roster.currentClass = roster.classes.length - 1; session.currentClass = roster.currentClass;
        session.pickedThisRound = []; session.lastPick = null; session.answering = null;
        this.saveRoster();
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
        }).filter(x => x.name);
        if (students.length === 0) { ok = false; msg = '没有解析到有效名单'; break; }
        const norm = s => String(s || '').replace(/[（）()]/g, '').trim();
        let ci = -1;
        if (body.rid) ci = roster.classes.findIndex(c => c.rid === String(body.rid));
        if (ci < 0 && body.name) ci = roster.classes.findIndex(c => norm(c.name) === norm(body.name));
        if (ci < 0) { ok = false; msg = '未找到目标班级'; break; }
        const target = roster.classes[ci];
        target.students = students;
        target.groups = [...new Set(students.map(x => x.group).filter(Boolean))];
        target.absent = { date: '', names: [] };
        this.saveRoster();
        msg = `已导入「${target.name}」${students.length} 人`;
        break;
      }
      case 'addStudent': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        const name = String(body.name || '').trim().slice(0, 20);
        if (!name || find(name)) { ok = false; msg = '姓名为空或重复'; break; }
        cls.students.push({ name, sid: String(body.sid || '').trim().slice(0, 20), group: String(body.group || '').trim(), weight: parseFloat(body.weight) || 1, pickedCount: 0, right: 0, wrong: 0, none: 0, skipped: 0 });
        if (body.group && !cls.groups.includes(body.group)) cls.groups.push(body.group);
        this.saveRoster();
        break;
      }
      case 'setSid': {
        const x = find(String(body.name || ''));
        if (!x) { ok = false; msg = '学生不存在'; break; }
        x.sid = String(body.sid || '').trim().slice(0, 20);
        this.saveRoster();
        break;
      }
      case 'delStudent': {
        if (!cls) break;
        cls.students = cls.students.filter(x => x.name !== body.name);
        this.saveRoster();
        break;
      }
      case 'setWeight': {
        const x = find(String(body.name || ''));
        if (!x) { ok = false; msg = '学生不存在'; break; }
        const w = parseFloat(body.weight);
        if (isNaN(w) || w < 0 || w > 99) { ok = false; msg = '权重需在 0~99 之间'; break; }
        x.weight = Math.round(w * 10) / 10;
        this.saveRoster();
        msg = w === 0 ? `${x.name} 已设为 0（不会被抽中）` : `${x.name} 权重已改为 ${x.weight}`;
        break;
      }
      case 'setAbsent': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        const names = (Array.isArray(body.names) ? body.names : []).filter(n => cls.students.some(x => x.name === n));
        cls.absent = { date: todayStr(), names };
        this.saveRoster();
        msg = names.length ? `今日请假已保存：${names.join('、')}（点名时自动跳过）` : '今日无请假';
        break;
      }
      case 'clearAbsent': {
        if (!cls) break;
        cls.absent = { date: '', names: [] };
        this.saveRoster();
        msg = '已清除今日请假名单';
        break;
      }
      case 'addGroup': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        const g = String(body.name || '').trim().slice(0, 12);
        if (!g) { ok = false; msg = '组名为空'; break; }
        if (!cls.groups.includes(g)) { cls.groups.push(g); this.saveRoster(); msg = `已添加组「${g}」`; }
        break;
      }
      case 'delGroup': {
        if (!cls) break;
        const g = String(body.name || '');
        cls.groups = (cls.groups || []).filter(x => x !== g);
        cls.students.forEach(x => { if (x.group === g) x.group = ''; });
        this.saveRoster();
        msg = `已删除组「${g}」（学生保留，组别已清空）`;
        break;
      }
      case 'addPlace': {
        const p = String(body.name || '').trim().slice(0, 20);
        if (p && !roster.places.includes(p)) { roster.places.push(p); this.saveRoster(); }
        break;
      }
      case 'resetStats': {
        if (!cls) break;
        cls.students.forEach(x => { x.pickedCount = 0; x.right = 0; x.wrong = 0; x.none = 0; x.skipped = 0; });
        session.pickedThisRound = []; session.lessonLog = [];
        this.saveRoster();
        msg = '统计已清零';
        break;
      }
      default: ok = false; msg = '未知指令';
    }
    this.pushState(roomId);
    return json({ ok, msg });
  }

  async fetch(req) {
    await this.ready;
    const url = new URL(req.url);
    this.origin = url.origin;
    const roomId = url.searchParams.get('room') || '1';
    if (url.pathname === '/events') return this.sseResponse(roomId);
    if (url.pathname === '/api/state') return json(this.snapshot(roomId));
    if (url.pathname === '/api/cmd' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return this.handleCmd(body, roomId);
    }
    return json({ ok: false, msg: 'Not Found' }, 404);
  }
}

/* ---------------- Worker 入口：PIN 校验 + 路由 ---------------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/') return Response.redirect(url.origin + '/screen.html', 302);
    if (url.pathname === '/events' || url.pathname.startsWith('/api/')) {
      if (env.PIN) {
        const pin = url.searchParams.get('pin') || req.headers.get('x-pin') || '';
        if (pin !== env.PIN) {
          return json({ ok: false, msg: '需要访问密码' }, 401);
        }
      }
      const id = env.ROOM.idFromName('main');
      return env.ROOM.get(id).fetch(req);
    }
    return env.ASSETS.fetch(req);
  }
};

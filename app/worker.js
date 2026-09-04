/**
 * 点将台 · Cloudflare Workers 版
 * 架构：Worker（路由 + 静态资产）+ Durable Object「Room」（教室状态 + SSE 广播 + 名单持久化）
 * - 双模式 DO：主实例 'main'（管理中枢 + 老式自定义房间 + 全量名单镜像）；每班一个实例 idFromName(rid)
 *   （班级实例独立存储/独立配额，全校规模互不影响；数据自动从主实例引导迁移，改动回写主实例镜像）
 * - 名单持久化在 DO storage（免费版 SQLite 存储），重启不丢
 * - 会话状态（本轮已点、答题、传呼）在内存，DO 重启即清（与本地版一致）
 * - PIN 访问控制：wrangler.jsonc vars.PIN，非空时 /events 与 /api/* 都需要密码
 * - 班级密码：班级设置 pass 后，该班 URL 直接打开会锁定（只放行 unlockClass），前端弹密码框
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
// 班级对象字段规范化（老数据迁移：补学号/请假/偏好/课表/公告/备忘录）
function normalizeClass(c) {
  if (!c.absent || typeof c.absent !== 'object') c.absent = { date: '', names: [] };
  (c.students || []).forEach(s => { if (s.sid === undefined) s.sid = ''; });
  if (!c.prefs) c.prefs = {};
  if (c.prefs.volume === undefined) c.prefs.volume = 0.3;
  if (c.prefs.animationMs === undefined) c.prefs.animationMs = 3000;
  if (c.prefs.voiceMode === undefined) c.prefs.voiceMode = 'sound';
  if (c.prefs.showTt === undefined) c.prefs.showTt = true;
  if (c.prefs.showMemos === undefined) c.prefs.showMemos = false;   // 大屏作业栏开关（默认关）
  if (c.prefs.autoExam === undefined) c.prefs.autoExam = true;   // 按课表：上课时间自动进考试模式（默认开，未配节次时间的班不受影响）
  if (!c.tt || typeof c.tt !== 'object') c.tt = { am: 4, pm: 3, cells: {} };
  if (!c.tt.cells) c.tt.cells = {};
  if (!c.tt.times) c.tt.times = {};
  if (!c.tt.am) c.tt.am = 4;
  if (!c.tt.pm) c.tt.pm = 3;
  if (c.tt.pre === undefined) c.tt.pre = 0;    // 早读课开关
  if (c.tt.post === undefined) c.tt.post = 0;  // 晚托课开关
  if (!c.notice || typeof c.notice !== 'object') c.notice = { text: '', at: 0 };
  if (!Array.isArray(c.memos)) c.memos = [];   // 备忘录
  return c;
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
// 按课表判断当前是否在上课时间内（自动考试模式用，东八区视角；起止时间必须配全才参与自动切换）
function autoInClass(tt) {
  if (!tt || !tt.times) return false;
  const sh = new Date(Date.now() + 8 * 3600 * 1000);
  const dow = sh.getUTCDay();          // 1-5 周一~周五（东八区视角）
  if (dow < 1 || dow > 5) return false;
  const nowMin = sh.getUTCHours() * 60 + sh.getUTCMinutes();
  const slots = [];
  if (tt.pre) slots.push('pre');
  for (let s = 0; s < (tt.am || 0); s++) slots.push(String(s));
  for (let s = 0; s < (tt.pm || 0); s++) slots.push(String((tt.am || 0) + s));
  if (tt.post) slots.push('post');
  for (const key of slots) {
    const t = tt.times[key];
    if (!t || !t.s || !t.e) continue;   // 起止必须完整
    const sp = String(t.s).split(':'), ep = String(t.e).split(':');
    const shh = parseInt(sp[0], 10), sm = parseInt(sp[1], 10), eh = parseInt(ep[0], 10), em = parseInt(ep[1], 10);
    if (isNaN(shh) || isNaN(eh)) continue;
    const sMin = shh * 60 + (isNaN(sm) ? 0 : sm), eMin = eh * 60 + (isNaN(em) ? 0 : em);
    if (nowMin >= sMin && nowMin < eMin) return true;
  }
  return false;
}
// 把点名判定结果写回「本节课记录」中对应轮次（尾向找第一条未标记且包含这些名字的记录）
function tagLessonLog(session, names, result) {
  const log = session.lessonLog;
  for (let i = log.length - 1; i >= 0; i--) {
    const l = log[i];
    if (!l.result && Array.isArray(l.names) && l.names.length && names.every(n => l.names.includes(n))) { l.result = result; return; }
  }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
// 静态资源带 charset 处理：CF assets 默认对 .txt 给 text/plain 无 charset，
// 这里强制给文本资源 UTF-8 + Content-Disposition 内联展示（保中文件名），避免中文乱码与浏览器当下载
// 注意：必须完全不复制原 headers，否则 CF 边缘节点会用原 Content-Type 覆盖
async function serveAssetWithCharset(req, env) {
  const url = new URL(req.url);
  const m = (url.pathname.match(/\.([a-z0-9]+)$/i) || [, '']);
  const ext = m[1].toLowerCase();
  const TEXT_EXT = { txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', json: 'application/json; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8' };
  const r = await env.ASSETS.fetch(req);
  if (!r.ok) return r;
  if (!TEXT_EXT[ext]) return r;   // 非文本类型直接返回原响应（保留 CF 默认 Content-Type）
  const baseName = url.pathname.split('/').pop() || 'file';
  const enc = encodeURIComponent(baseName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  // 完全重写 headers（不复制 r.headers，避免 CF 边缘节点覆盖）
  return new Response(r.body, {
    status: r.status,
    headers: {
      'Content-Type': TEXT_EXT[ext],
      'Content-Disposition': `inline; filename="${baseName.replace(/[\r\n"]/g, '_')}"; filename*=UTF-8''${enc}`,
      'Cache-Control': 'no-cache'
    }
  });
}

/* ---------------- Durable Object：主实例（管理中枢/全量镜像） 或 一间教室（每班独立） ---------------- */
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sse = new Set();       // SSE 连接集合 {push, close, room}
    this.hb = null;             // 心跳定时器
    this.origin = null;
    this.roster = null;
    this.rooms = new Map();     // 多房间：{roomId: {currentClass, pickedThisRound, ...}}
    // 双模式：DO 实例名 = 'main' → 主实例；= 班级 rid → 该班独立实例
    this.selfId = (state.id && state.id.name) ? String(state.id.name) : 'main';
    this.mode = this.selfId === 'main' ? 'main' : 'class';
    this.dir = null;            // class 模式：班级目录缓存（来自主实例，用于班级下拉）
    this.ready = this.init();
  }
  async init() {
    if (this.mode === 'class') return this.initClass();
    let roster = await this.state.storage.get('roster');
    if (!roster) roster = defaultRoster();
    roster.classes.forEach(normalizeClass);
    roster.classes.forEach((c, i) => { if (!c.rid) c.rid = this.genRid(c.name || '', i); });
    this.roster = roster;
  }
  // 班级实例初始化：优先读自身存储；没有则从主实例引导迁移（老部署名单都在 main 里）
  async initClass() {
    let cls = await this.state.storage.get('cls');
    let places = await this.state.storage.get('places');
    if (!cls) {
      try {
        const stub = this.env.ROOM.get(this.env.ROOM.idFromName('main'));
        const r = await stub.fetch('https://do/internal/get-class?rid=' + encodeURIComponent(this.selfId));
        const d = await r.json();
        if (d && d.cls) { cls = d.cls; if (!places && d.places) places = d.places; }
      } catch (e) { /* 主实例不可达时按无数据处理 */ }
    }
    if (!cls) { this.invalid = true; return; }
    this.cls = normalizeClass(cls);
    if (!Array.isArray(places)) places = ['办公室', '教务处', '医务室', '自习室'];
    // 迷你 roster：复用全部班级本地指令逻辑（classes 恒为本班）
    this.roster = { classes: [this.cls], places, currentClass: 0 };
    this.dir = [{ i: 0, name: this.cls.name, rid: this.cls.rid, locked: !!this.cls.pass }];
    await this.refreshDir();
  }
  // 从主实例刷新班级目录（班级下拉/切换用）+ 共享去处列表
  async refreshDir() {
    try {
      const stub = this.env.ROOM.get(this.env.ROOM.idFromName('main'));
      const r = await stub.fetch('https://do/internal/dir');
      const d = await r.json();
      if (d && Array.isArray(d.classes) && d.classes.length) {
        this.dir = d.classes;
        const mine = this.dir.find(c => c.rid === this.selfId);
        if (mine) { mine.locked = !!this.cls.pass; }
        if (Array.isArray(d.places) && d.places.length) this.roster.places = d.places;
      }
    } catch (e) { /* 失败时沿用缓存 */ }
  }
  // 班级实例数据落盘：自身存储 + 异步回写主实例镜像（主实例保持全量最新，供目录/引导/备份）
  saveRoster() {
    if (this.mode === 'class') {
      const p = (async () => {
        await this.state.storage.put('cls', this.cls);
        await this.state.storage.put('places', this.roster.places);
        try {
          const stub = this.env.ROOM.get(this.env.ROOM.idFromName('main'));
          await stub.fetch('https://do/internal/save-class', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cls: JSON.parse(JSON.stringify(this.cls)), places: this.roster.places })
          });
        } catch (e) { /* 镜像失败不影响本班 */ }
      })();
      if (this.state.waitUntil) { try { this.state.waitUntil(p.catch(() => {})); } catch (e) {} }
      return p;
    }
    return this.state.storage.put('roster', this.roster);
  }
  // 班级列表管理类指令：班级实例转发主实例处理（唯一权威），回来刷新目录
  async proxyCmd(body) {
    try {
      const stub = this.env.ROOM.get(this.env.ROOM.idFromName('main'));
      // 走主实例内部通道（公网不可达）：主实例跳过外层房间门禁，
      // 管理指令自身的目标班密码校验（classSwitch/delClass 等）仍然生效
      const r = await stub.fetch('https://do/internal/proxy-cmd', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      await this.refreshDir();
      this.pushState(this.selfId);
      return json(j);
    } catch (e) {
      return json({ ok: false, msg: '管理指令处理失败，请稍后重试' }, 502);
    }
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
        // room 是班级 rid 时绑定该班级；否则沿用全局当前班（DO 休眠重启后会话重建，避免回落到第 0 班）
        currentClass: idx >= 0 ? idx : Math.min(this.roster.currentClass || 0, this.roster.classes.length - 1),
        pickedThisRound: [], lastPick: null, answering: null, page: null,
        examMode: false,
        examModeAuto: false,   // true=由课表自动开启（下课可自动回收）；false=手动开关（自动逻辑不覆盖）
        volume: p.volume !== undefined ? p.volume : 0.3,
        animationMs: p.animationMs !== undefined ? p.animationMs : 3000,
        rollStyle: 'classic',
        voiceMode: p.voiceMode !== undefined ? p.voiceMode : 'sound',
        lessonLog: [], pageLog: [], unlocked: {}
      });
    }
    return this.rooms.get(id);
  }
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
  // 该房间当前班是否处于锁定态（按 sid 隔离：sid 未解锁就算锁定，sid 为空的旧客户端一律视为锁定）
  isLocked(roomId, sid) {
    const room = this.getRoom(roomId);
    const cls = this.roster.classes[this.roomClassIndex(roomId, room)];
    return !!(cls && cls.pass && !(sid && room.unlocked[sid + ':' + cls.rid]));
  }
  snapshot(roomId, sid = '') {
    const room = this.getRoom(roomId);
    const cls = this.roster.classes[this.roomClassIndex(roomId, room)] || { name: '', students: [] };
    // 班级目录：主实例实时生成；班级实例用缓存目录（i = 主实例中的下标，前端切班用）
    const allClasses = this.mode === 'class'
      ? (this.dir || [{ i: 0, name: cls.name, rid: roomId, locked: !!cls.pass }]).map(c => ({ ...c }))
      : this.roster.classes.map((c, i) => ({ i, name: c.name, rid: c.rid, locked: !!c.pass }));
    const curIdx = this.roomClassIndex(roomId, room);
    const dirIdx = allClasses.findIndex(c => this.mode === 'class' ? c.rid === roomId : c.i === curIdx);
    const currentClass = dirIdx >= 0 ? allClasses[dirIdx].i : curIdx;
    // 班级密码门禁：本标签页未解锁时只回最小信息（名单/记录一概不给），前端弹密码框
    if (this.isLocked(roomId, sid)) {
      return {
        locked: true, room: roomId, className: cls.name,
        allClasses, currentClass, places: this.roster.places
      };
    }
    const qs = roomId !== '1' ? '?room=' + encodeURIComponent(roomId) : '';
    return {
      ctrlUrls: [`${this.origin}/ctrl.html${qs}`],
      className: cls.name,
      groups: cls.groups || [],
      students: cls.students.map(x => ({ name: x.name, sid: x.sid || '', group: x.group, weight: x.weight, pickedCount: x.pickedCount })),
      allClasses,
      currentClass,
      tt: cls.tt || { am: 4, pm: 3, cells: {} },
      showTt: cls.prefs ? cls.prefs.showTt !== false : true,
      showMemos: cls.prefs ? !!cls.prefs.showMemos : false,
      autoExam: cls.prefs ? cls.prefs.autoExam !== false : true,
      notice: cls.notice || { text: '', at: 0 },
      memos: cls.memos || [],
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
    for (const w of this.sse) {
      if (w.room !== roomId) continue;
      if (this.isLocked(w.room, w.sid)) continue;   // 锁定中的连接不推事件数据（防名单/记录泄露）
      try { w.push(payload); } catch (e) { this.sse.delete(w); }
    }
  }
  pushState(roomId) {
    for (const w of this.sse) {
      if (w.room !== roomId) continue;
      try { w.push(`data: ${JSON.stringify({ event: 'state', state: this.snapshot(w.room, w.sid) })}\n\n`); }
      catch (e) { this.sse.delete(w); }
    }
  }
  // 按课表自动考试模式轮询：并入 SSE 心跳（只在有活跃连接时执行，DO 空闲不空转）。
  // 上课时间自动开（标记 examModeAuto），离开上课时间只回收"自动开启"的状态；
  // 老师手动切换（examMode 指令清除 examModeAuto）的状态不回收，避免覆盖老师的主动操作
  autoExamTickAll() {
    if (!this.roster || !Array.isArray(this.roster.classes)) return;   // DO 尚未就绪
    for (const [roomId, room] of this.rooms) {
      const cls = this.roster.classes[this.roomClassIndex(roomId, room)];
      if (!cls || !cls.prefs || cls.prefs.autoExam === false) continue;   // 该班总开关关闭：不干预
      const inClass = autoInClass(cls.tt);
      if (inClass && !room.examMode) { room.examMode = true; room.examModeAuto = true; this.pushState(roomId); }
      else if (!inClass && room.examMode && room.examModeAuto) { room.examMode = false; room.examModeAuto = false; this.pushState(roomId); }
    }
  }
  ensureHeartbeat() {
    if (this.hb) return;
    this.hb = setInterval(() => {
      if (!this.sse.size) return;
      this.raw(': ping\n\n');
      this.autoExamTickAll();
    }, 25000);
  }
  sseResponse(roomId, sid = '') {
    this.ensureHeartbeat();
    const enc = new TextEncoder();
    let entry = null;
    const stream = new ReadableStream({
      start: (ctrl) => {
        entry = {
          push: (s) => ctrl.enqueue(enc.encode(s)),
          close: () => { try { ctrl.close(); } catch (e) {} },
          room: roomId,
          sid
        };
        this.sse.add(entry);
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ event: 'state', state: this.snapshot(roomId, sid) })}\n\n`));
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
  // 班级列表管理类指令：班级实例转发主实例（班级名单唯一权威在主实例）
  static PROXY_TO_MAIN = ['classSwitch', 'addClass', 'delClass', 'importRoster', 'addPlace'];
  async handleCmd(body, roomId, sid = '', opts = {}) {
    await this.ready;
    if (this.mode === 'class' && Room.PROXY_TO_MAIN.includes(body.action)) return this.proxyCmd(body);
    const roster = this.roster, session = this.getRoom(roomId);
    const cls = roster.classes[this.roomClassIndex(roomId, session)];
    // 班级密码门禁：本标签页未解锁时只放行 unlockClass，其余指令一律拒绝。
    // 主实例内部转发通道(internal/proxy-cmd)跳过外层房间门禁——班级实例自身已做同等级校验，
    // 否则 room '1' 当前班的锁定态会误拦其他班级页转发来的管理指令。
    if (!opts.skipGate && cls && cls.pass && !session.unlocked[sid + ':' + cls.rid] && body.action !== 'unlockClass') {
      return json({ ok: false, msg: '需要班级密码' });
    }
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
        // 把判定结果写进「本节课记录」（控制端/大屏同步显示 ✅答对 / ❌答错 / 未答）
        tagLessonLog(session, session.lastPick.names, body.result === 'right' ? 'right' : body.result === 'wrong' ? 'wrong' : 'none');
        session.answering = null;
        this.saveRoster();
        this.broadcast(roomId, { event: 'marked', result: body.result });
        break;
      }
      case 'skip': {
        if (!session.lastPick) { ok = false; msg = '请先点名'; break; }
        for (const n of session.lastPick.names) { const x = find(n); if (x) x.skipped = (x.skipped || 0) + 1; }
        tagLessonLog(session, session.lastPick.names, 'skip');   // 跳过也记入本节课记录
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
        // 姓名+学号成对校验：学号用于区分同名，无学号的学生 sids 为空串（兼容旧控制端）
        const pairs = (body.names || []).map((n, i) => ({ n, s: (body.sids || [])[i] || '' })).filter(p => find(p.n));
        const names = pairs.map(p => p.n), sids = pairs.map(p => p.s);
        if (names.length === 0) { ok = false; msg = '学生不在名单内'; break; }
        session.page = {
          names, sids, place: String(body.place || '办公室').slice(0, 20),
          from: String(body.from || '').slice(0, 20),
          note: String(body.note || '').slice(0, 30),
          // 展示时长已固定：大屏端居中弹窗统一展示 5 秒后自动收起（不再由控制端配置）
          sentAt: now, confirmed: false, retracted: false
        };
        session.pageLog.push({ names, sids, place: session.page.place, from: session.page.from, sentAt: now, confirmed: false, retracted: false });
        this.broadcast(roomId, { event: 'page', page: session.page });
        break;
      }
      case 'pageConfirm': if (session.page) { session.page.confirmed = true; session.pageLog.forEach(p => { if (!p.retracted && !p.confirmed) p.confirmed = true; }); } break;
      case 'pageRetract': if (session.page) { session.page.retracted = true; session.pageLog.forEach(p => { if (!p.confirmed) p.retracted = true; }); session.page = null; } break;
      case 'examMode': session.examMode = !!body.on; session.examModeAuto = false; break;   // 手动切换：清除"自动开启"标记，自动逻辑不回收
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
      case 'setShowMemos': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        cls.prefs = cls.prefs || {};
        cls.prefs.showMemos = !!body.on;
        this.saveRoster(); msg = body.on ? '大屏已显示作业栏' : '大屏已隐藏作业栏';
        break;
      }
      case 'setAutoExam': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        cls.prefs = cls.prefs || {};
        cls.prefs.autoExam = !!body.on;
        this.saveRoster(); msg = body.on ? '已开启：上课时间自动进入考试模式' : '已关闭：不再按课表自动切换考试模式';
        break;
      }
      case 'setClassPass': {
      if (!cls) { ok = false; msg = '无班级'; break; }
      const old = String(body.old || '');
      if (cls.pass && old !== cls.pass) { ok = false; msg = '原密码不正确'; break; }
      const pass = String(body.pass || '').trim().slice(0, 20);
      cls.pass = pass || '';
      this.rooms.forEach(r => { r.unlocked = {}; });   // 改密后所有标签页的解锁全部失效
      if (this.mode === 'class') { const d = (this.dir || []).find(x => x.rid === cls.rid); if (d) d.locked = !!cls.pass; }
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
        if (target.pass && !session.unlocked[sid + ':' + target.rid] && String(body.pass || '') !== target.pass) {
          ok = false; msg = '需要班级密码'; break;
        }
        session.currentClass = i; roster.currentClass = i;
        if (target.pass) session.unlocked[sid + ':' + target.rid] = true;
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
        if (pass) session.unlocked[sid + ':' + roster.classes[roster.currentClass].rid] = true;
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
        const nm = roster.classes[i].name, delRid = roster.classes[i].rid;
        roster.classes.splice(i, 1);
        if (roster.currentClass >= roster.classes.length) roster.currentClass = roster.classes.length - 1;
        this.rooms.forEach(r => {
          if (r.currentClass >= roster.classes.length) r.currentClass = roster.classes.length - 1;
          for (const k of Object.keys(r.unlocked)) if (k.endsWith(':' + delRid)) delete r.unlocked[k];
        });
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
      case 'unlockClass': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        if (!cls.pass) break;   // 未加密班级无需解锁
        if (String(body.pass || '') === cls.pass) { session.unlocked[sid + ':' + cls.rid] = true; msg = '已解锁'; }
        else { ok = false; msg = '密码不正确'; }
        break;
      }
      // 备忘录（按班级保存）：添加 / 勾选完成 / 删除 / 清除已完成
      case 'memoAdd': {
        if (!cls) { ok = false; msg = '无班级'; break; }
        const text = String(body.text || '').trim().slice(0, 200);
        if (!text) { ok = false; msg = '内容为空'; break; }
        cls.memos = cls.memos || [];
        cls.memos.push({ id: now.toString(36) + Math.random().toString(36).slice(2, 6), text, at: now, done: false });
        if (cls.memos.length > 100) cls.memos = cls.memos.slice(-100);
        this.saveRoster(); msg = '已添加备忘';
        break;
      }
      case 'memoToggle': {
        if (!cls) break;
        const m = (cls.memos || []).find(x => x.id === String(body.id || ''));
        if (!m) { ok = false; msg = '备忘不存在'; break; }
        m.done = !m.done; this.saveRoster();
        break;
      }
      case 'memoDel': {
        if (!cls) break;
        cls.memos = (cls.memos || []).filter(x => x.id !== String(body.id || ''));
        this.saveRoster();
        break;
      }
      case 'memoClearDone': {
        if (!cls) break;
        cls.memos = (cls.memos || []).filter(x => !x.done);
        this.saveRoster(); msg = '已清除已完成备忘';
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
    const sid = String(url.searchParams.get('sid') || '');   // 浏览器标签页会话 id：解锁态按标签页隔离，新开页面必重新输密码
    // 失效班级实例（rid 在主实例中不存在）：返回 404，前端自动回退首页
    if (this.invalid) return json({ ok: false, msg: '房间不存在或已失效' }, 404);
    // 主实例内部端点（仅 DO 间通过 service binding 调用；Worker 入口不转发 /internal/*，公网不可达）
    if (this.mode === 'main' && url.pathname === '/internal/dir') {
      return json({
        classes: this.roster.classes.map((c, i) => ({ i, name: c.name, rid: c.rid, locked: !!c.pass })),
        places: this.roster.places
      });
    }
    if (this.mode === 'main' && url.pathname === '/internal/get-class') {
      const rid = String(url.searchParams.get('rid') || '');
      const cls = this.roster.classes.find(c => c.rid === rid) || null;
      return json({ cls, places: this.roster.places });
    }
    if (this.mode === 'main' && url.pathname === '/internal/save-class' && req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (body && body.cls && body.cls.rid) {
        const i = this.roster.classes.findIndex(c => c.rid === body.cls.rid);
        if (i >= 0) this.roster.classes[i] = body.cls;
        else this.roster.classes.push(body.cls);
        if (Array.isArray(body.places)) for (const p of body.places) if (!this.roster.places.includes(p)) this.roster.places.push(p);
        if (this.roster.currentClass >= this.roster.classes.length) this.roster.currentClass = this.roster.classes.length - 1;
        await this.state.storage.put('roster', this.roster);
      }
      return json({ ok: true });
    }
    // 班级实例转发来的管理指令：以 room '1' 会话执行，跳过外层房间门禁
    //（班级实例侧已做过同等级门禁；classSwitch/delClass 等指令内部仍校验目标班密码）
    if (this.mode === 'main' && url.pathname === '/internal/proxy-cmd' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return this.handleCmd(body, '1', '', { skipGate: true });
    }
    if (url.pathname === '/events') return this.sseResponse(roomId, sid);
    if (url.pathname === '/api/state') return json(this.snapshot(roomId, sid));
    if (url.pathname === '/api/cmd' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return this.handleCmd(body, roomId, sid);
    }
    return json({ ok: false, msg: 'Not Found' }, 404);
  }
}

/* ---------------- Worker 入口：PIN 校验 + 每班独立 DO 路由 ---------------- */
// 班级 rid 目录缓存（20 秒）：命中 → 路由到该班独立 DO；未命中/失效 → 主实例（老式行为兜底）
let dirCache = { at: 0, rids: null };
async function isClassRid(env, roomId) {
  const now = Date.now();
  if (!dirCache.rids || now - dirCache.at > 20000) {
    try {
      const r = await env.ROOM.get(env.ROOM.idFromName('main')).fetch('https://do/internal/dir');
      const d = await r.json();
      dirCache = { at: now, rids: new Set((d.classes || []).map(c => c.rid)) };
    } catch (e) { return false; }
  }
  return dirCache.rids.has(roomId);
}
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
      const roomId = url.searchParams.get('room') || '1';
      let name = 'main';
      if (roomId !== '1' && /^c[0-9a-z]{4,8}$/.test(roomId) && await isClassRid(env, roomId)) name = roomId;
      return env.ROOM.get(env.ROOM.idFromName(name)).fetch(req);
    }
    return await serveAssetWithCharset(req, env);
  }
};

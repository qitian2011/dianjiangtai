// 云函数 proxy：把小程序请求转发到点将台 Cloudflare Worker
// 传输：Node 原生 https（零依赖，无需 wx-server-sdk）
// 环境变量（云开发控制台 → 云函数 → proxy → 配置）：
//   BASE_URL = https://qitian.dpdns.org   （worker 自定义域，国内可达）
// 注意：不要用 *.workers.dev——该域在腾讯云境内被屏蔽，云函数会一直超时。

const https = require('https');

const BASE = (process.env.BASE_URL || 'https://qitian.dpdns.org').replace(/\/+$/, '');
// 云端访问密码（PIN）由 proxy 环境变量持有并注入：小程序端不感知、不传输密码。
// 部署：云开发控制台 → 云函数 → proxy → 配置 → 新增环境变量 PIN = 云端口令（与 worker 的 PIN 一致）。
const PIN = String(process.env.PIN || '');

exports.main = async (event) => {
  const method = String(event.method || 'GET').toUpperCase();
  const path = String(event.path || '/api/state');
  const q = (event.q && typeof event.q === 'object') ? event.q : {};

  if (!PIN) {
    // fail-closed：未配置 PIN 一律不放行，并给出可操作的部署提示
    return { status: 503, text: '', json: { ok: false, msg: 'proxy 云函数未配置 PIN 环境变量：请在云开发控制台为 proxy 新增环境变量 PIN 后重新部署' } };
  }

  const params = new URLSearchParams();
  Object.keys(q).forEach(k => {
    const v = q[k];
    if (v !== undefined && v !== null && v !== '') params.append(k, String(v));
  });
  params.set('pin', PIN);   // 注入云端访问密码（服务端覆盖，客户端无法伪造）

  const qs = params.toString();
  const url = BASE + path + (qs ? '?' + qs : '');
  const body = event.body ? (typeof event.body === 'string' ? event.body : JSON.stringify(event.body)) : null;

  return new Promise((resolve) => {
    const u = new URL(url);
    const headers = { 'x-pin': PIN, 'user-agent': 'djt-mp-proxy' };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers
    }, (res) => {
      let txt = '';
      res.on('data', d => { txt += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(txt); } catch (e) { /* 非 JSON 原样透传 */ }
        resolve({ status: res.statusCode, text: txt, json });
      });
    });
    req.on('error', err => resolve({ status: 0, text: String((err && err.message) || err), json: null }));
    if (body) req.write(body);
    req.end();
  });
};

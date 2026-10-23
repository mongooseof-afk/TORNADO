/*
 * ocr_captchaai.js — CaptchaAI BLS solver client (https only, raw multipart).
 * API: POST https://ocr.captchaai.com/in.php  (multipart form)
 *        key, method=bls, instructions=<target>, json=1, image_base64_1..9
 *      GET  https://ocr.captchaai.com/res.php?key=&action=get&id=&json=1
 *        -> {"status":1,"request":"[1,4,7,8]"}  (1-based cell indexes)
 */
const https = require('https');

function postMultipart(host, path, fields) {
  return new Promise((resolve, reject) => {
    const boundary = '----ThunderBoltBoundary' + Date.now().toString(16);
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' +
        String(value) + '\r\n'
      ));
    }
    parts.push(Buffer.from('--' + boundary + '--\r\n'));
    const body = Buffer.concat(parts);
    const req = https.request({
      host, path, method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      },
      timeout: 30000
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('timeout', () => { req.destroy(new Error('in.php timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

function getJson(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, path, timeout: 20000 }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data.trim())); }
        catch (e) { resolve({ status: 0, request: 'BAD_JSON:' + data.slice(0, 80) }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('res.php timeout')); });
    req.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function decodeDataUri(uri) {
  const m = /^data:[^;]+;base64,(.*)$/s.exec(String(uri || ''));
  return m ? m[1] : null;
}

/**
 * solveCaptchaAI(job, apiKey) -> array of {number:target}|{number:"-"} (9) or {error}
 * job: { images: [{image|String}...], target: "667" }
 */
async function solveCaptchaAI(job, apiKey) {
  const target = String(job.target || '').replace(/\D+/g, '');
  const images = Array.isArray(job.images) ? job.images : [];
  if (!target) return { error: 'captchaai: no target' };
  if (images.length !== 9) return { error: 'captchaai: need 9 images, got ' + images.length };

  const fields = {
    key: apiKey,
    method: 'bls',
    instructions: target,
    json: '1'
  };
  images.forEach((img, i) => {
    const b64 = decodeDataUri(img && img.image ? img.image : img);
    if (!b64) throw new Error('captchaai: image ' + i + ' not a base64 data URI');
    fields['image_base64_' + (i + 1)] = 'data:image/jpeg;base64,' + b64;
  });

  const sub = await postMultipart('ocr.captchaai.com', '/in.php', fields);
  let subJ = null;
  try { subJ = JSON.parse(sub.text.trim()); } catch (e) {}
  if (!subJ || subJ.status !== 1) {
    return { error: 'captchaai submit failed: ' + (subJ ? subJ.request : sub.text.slice(0, 80)) };
  }
  const taskId = subJ.request;

  await sleep(5000);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const r = await getJson('ocr.captchaai.com',
      '/res.php?key=' + encodeURIComponent(apiKey) + '&action=get&id=' + encodeURIComponent(taskId) + '&json=1');
    if (r.status === 1) {
      let idx = [];
      try { idx = JSON.parse(r.request); } catch (e) {
        return { error: 'captchaai bad index payload: ' + String(r.request).slice(0, 80) };
      }
      const out = [];
      for (let i = 1; i <= 9; i++) {
        out.push(idx.includes(i) ? { number: target } : { number: '-' });
      }
      return out;
    }
    if (r.request !== 'CAPCHA_NOT_READY') {
      return { error: 'captchaai: ' + (r.request || 'unknown error') };
    }
    await sleep(3000);
  }
  return { error: 'captchaai: polling timed out' };
}


function getBalance(apiKey) {
  return getJson('ocr.captchaai.com', '/res.php?key=' + encodeURIComponent(apiKey) + '&action=getbalance&json=1');
}
module.exports = { solveCaptchaAI, getBalance };

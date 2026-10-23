'use strict';
// Local Gmail IMAP only. No mailbox password or message body leaves this process.
module.exports = function createAutoOtp(deps = {}) {
  const ImapFlow = deps.ImapFlow || require('imapflow').ImapFlow;
  const parse = deps.parse || require('mailparser').simpleParser;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const jobs = new Map();
  const send = (ws, value) => { if (ws.readyState === 1) ws.send(JSON.stringify({type:'TORNADO_AUTO_OTP_RESULT', ...value})); };
  function cancel(job) { job.cancelled = true; try { job.client?.close(); } catch {} }
  async function run(ws, msg, key) {
    const job = {cancelled:false, client:null}; jobs.set(key, job);
    const onClose = () => cancel(job); ws.once('close', onClose);
    const finish = result => { if (!job.cancelled) send(ws, {id:msg.id, ...result}); };
    const since = Math.max(now() - 5 * 60000, Math.min(now(), msg.since));
    const end = now() + 65000;
    const client = job.client = new ImapFlow({host:'imap.gmail.com',port:993,secure:true,
      auth:{user:msg.email,pass:msg.appPassword.replace(/\s/g,'')},logger:false,
      connectionTimeout:12000,greetingTimeout:12000,socketTimeout:20000});
    const timeout = setTimeout(() => { finish({status:'timeout'}); cancel(job); }, 70000);
    client.on('error', () => {});
    let lock;
    try {
      await client.connect(); lock = await client.getMailboxLock('INBOX');
      const checked = new Set();
      while (!job.cancelled && now() < end) {
        const uids = (await client.search({since:new Date(since)}, {uid:true})).sort((a,b)=>b-a).slice(0,40);
        for (const uid of uids) {
          if (job.cancelled || now() >= end) break;
          if (checked.has(uid)) continue; checked.add(uid);
          const message = await client.fetchOne(uid, {source:true,internalDate:true}, {uid:true});
          if (!message?.source || message.source.length > 2 * 1024 * 1024) continue;
          const mail = await parse(message.source);
          const date = new Date(message.internalDate || mail.date).getTime();
          if (!Number.isFinite(date) || date < since || date > now() + 120000) continue;
          if (!mail.from?.value?.some(v=>/@(?:[a-z0-9-]+\.)?blsinternational\.com$/i.test(v.address || ''))) continue;
          if (!/BLS Visa Appointment\s*-\s*(?:Email|User) Verification/i.test(mail.subject || '')) continue;
          const body = mail.text || String(mail.html || '').replace(/<[^>]*>/g,' ');
          const addressed = body.match(/Dear\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i)?.[1];
          if (addressed ? addressed.toLowerCase() !== msg.email.toLowerCase() :
            !mail.to?.value?.some(v=>v.address?.toLowerCase() === msg.email.toLowerCase())) continue;
          const labeled = body.match(/(?:verification\s+code|one[ -]time\s+(?:password|code)|otp|security\s+code)\b[^\d]{0,80}(\d{6})\b/i)?.[1];
          const candidates = [...new Set(body.match(/\b\d{6}\b/g) || [])];
          const code = labeled || (candidates.length === 1 ? candidates[0] : null);
          if (code) { finish({status:'completed',code}); return; }
        }
        if (!job.cancelled) await sleep(3000);
      }
      finish({status:'timeout'});
    } catch { finish({status:'mail-error'}); }
    finally {
      clearTimeout(timeout); try { lock?.release(); } catch {}
      try { await client.logout(); } catch {}
      ws.off('close',onClose); if (jobs.get(key) === job) jobs.delete(key);
    }
  }
  return {handle(ws,msg) {
    if (!['TORNADO_AUTO_OTP_READ','TORNADO_AUTO_OTP_CANCEL'].includes(msg?.type)) return false;
    if (!ws.browserId || !['Spain','Portugal'].includes(ws.country) || msg.country !== ws.country ||
        typeof msg.id !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(msg.id)) return true;
    const key = ws.browserId + ':' + msg.id;
    if (msg.type === 'TORNADO_AUTO_OTP_CANCEL') { if (jobs.has(key)) cancel(jobs.get(key)); return true; }
    if (jobs.has(key)) return true;
    if ([...jobs.keys()].filter(k=>k.startsWith(ws.browserId+':')).length >= 2) { send(ws,{id:msg.id,status:'busy'}); return true; }
    if (typeof msg.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(msg.email) || msg.email.length > 254 ||
        typeof msg.appPassword !== 'string' || !msg.appPassword.trim() || msg.appPassword.length > 128 || !Number.isFinite(msg.since)) {
      send(ws,{id:msg.id,status:'not-configured'}); return true;
    }
    void run(ws,msg,key); return true;
  }};
};

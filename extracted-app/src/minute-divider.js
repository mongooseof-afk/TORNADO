'use strict';
function distribute(rows, config) {
  const {targetTime, endMs, each, extra, interval} = config;
  const startMs = ((targetTime % 60000) + 60000) % 60000;
  if (!Number.isSafeInteger(targetTime) || !Number.isInteger(endMs) || endMs < startMs || endMs > 59999 ||
      !Number.isSafeInteger(each) || each < 0 || each > 86400 || !Number.isInteger(extra) || extra < 0 || extra > 20 ||
      !Number.isInteger(interval) || interval < 1 || interval > 60000 || (extra > 0 && each > 0 && extra * interval >= each * 1000)) throw Error('Invalid time range or repeat settings.');
  const minute = targetTime - startMs;
  return rows.map((row, i) => ({...row, index:i, count:rows.length,
    submitAt:minute + (i % 7) * 60000 + startMs + (rows.length === 1 ? 0 : Math.round(i * (endMs - startMs) / (rows.length - 1))),
    each, extra:row.country === 'Portugal' ? extra : 0, interval}));
}
function install({app, ipcMain, getWindow, browserClients, windowStateByProfile, WebSocket, fs, path, crypto}) {
  const rows = new Map(), plans = new Map();
  const file = () => path.join(app.getPath('userData'),'tornado-minute-divider.json');
  let enabled = false;
  // Each launcher session starts OFF; the user explicitly enables it.
  const key = row => row.profileId + ':' + row.country + ':' + row.tabId;
  const live = row => {
    const ws = browserClients.get(row.profileId), state = windowStateByProfile.get(row.profileId);
    return row.ready && Date.now() - row.at < 6000 && ws?.readyState === WebSocket.OPEN && state?.open === true && Date.now() - state.lastSeen < 30000;
  };
  function candidates(country, sourceKey) {
    const profiles = new Map();
    const joined = new Map();
    for (const [k,row] of rows) {
      if (Date.now()-row.at > 6000) { rows.delete(k); continue; }
      if (row.country !== country || !live(row)) continue;
      joined.set(row.profileId, Math.min(joined.get(row.profileId) ?? row.joined, row.joined));
      const old = profiles.get(row.profileId);
      if (!old || k === sourceKey || (key(old) !== sourceKey && (Number(row.active) > Number(old.active) || row.active === old.active && row.tabId > old.tabId))) profiles.set(row.profileId,row);
    }
    return [...profiles.values()].sort((a,b) => Number(key(b) === sourceKey)-Number(key(a) === sourceKey) || joined.get(a.profileId)-joined.get(b.profileId) || a.profileId.localeCompare(b.profileId));
  }
  const send = (row, message) => browserClients.get(row.profileId).send(JSON.stringify({...message, tabId:row.tabId, country:row.country}));
  function stop(plan) {
    if (!plan) return;
    for (const row of plan.rows) { try { send(row,{type:'TORNADO_MINUTE_STOP',planId:plan.id}); } catch {} }
    plans.delete(plan.country);
  }
  const validRow = b => typeof b.profileId === 'string' && b.profileId.length > 0 && b.profileId.length <= 128 &&
    ['Spain','Portugal'].includes(b.country) && Number.isInteger(b.tabId) && b.tabId >= 0;
  function action(route, body) {
    if (!validRow(body)) throw Error('Invalid calendar profile.');
    const k = key(body);
    if (route === 'presence') {
      const old = rows.get(k);
      rows.set(k,{profileId:body.profileId,country:body.country,tabId:body.tabId,ready:body.ready === true,active:body.active === true,at:Date.now(),joined:old?.joined || Date.now()});
      return {ok:true,enabled,count:candidates(body.country).length};
    }
    if (route === 'stop') {
      const plan = plans.get(body.country);
      if (!plan || plan.id !== body.planId || !plan.rows.some(row=>row.profileId === body.profileId && row.tabId === body.tabId)) return {ok:true};
      stop(plan); return {ok:true};
    }
    if (route !== 'distribute' || !enabled) throw Error('Enable Minute Distribution in Tornado Launcher.');
    if (!rows.has(k) || !live(rows.get(k))) throw Error('This calendar is not ready.');
    const list = candidates(body.country,k);
    if (!list.length || key(list[0]) !== k) throw Error('No ready calendar profiles.');
    if (!Number.isSafeInteger(body.config?.targetTime) || body.config.targetTime < Date.now()+500 || body.config.targetTime > Date.now()+2*86400000) throw Error('Choose a future submit time.');
    const schedule = distribute(list,body.config),id = crypto.randomUUID();
    stop(plans.get(body.country));
    const plan = {id,country:body.country,rows:schedule};
    plans.set(body.country,plan);
    try { for (const row of schedule) send(row,{type:'TORNADO_MINUTE_SCHEDULE',planId:id,schedule:{submitAt:row.submitAt,index:row.index,count:row.count,each:row.each,extra:row.extra,interval:row.interval}}); }
    catch { stop(plan); throw Error('A profile disconnected. Check calendars and press Mass Set again.'); }
    return {ok:true,planId:id,count:schedule.length};
  }
  function authorize(event) {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error('Invalid sender');
  }
  ipcMain.handle('tornado-minute-divider-get',event=>{authorize(event);return {enabled};});
  ipcMain.handle('tornado-minute-divider-set',(event,value)=>{
    authorize(event);if(typeof value !== 'boolean')throw Error('Invalid setting');
    fs.writeFileSync(file(),JSON.stringify({enabled:value}),{encoding:'utf8',mode:0o600});enabled=value;
    if(!enabled) for(const plan of [...plans.values()])stop(plan);
    return {enabled};
  });
  function handle(req,res) {
    const route = req.url?.match(/^\/minute-divider\/(presence|distribute|stop)$/)?.[1];
    if (!route) return false;
    const reply = (status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if (req.method !== 'POST' || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {reply(403,{ok:false,error:'Local request required.'});return true;}
    let raw='',large=false;
    req.on('data',chunk=>{if(large)return;raw+=chunk;if(raw.length>8192){large=true;reply(413,{ok:false,error:'Request too large.'});}});
    req.on('end',()=>{if(large)return;try{reply(200,action(route,JSON.parse(raw)));}catch(error){reply(400,{ok:false,error:error.message});}});
    return true;
  }
  return {handle};
}
module.exports = {install,distribute};

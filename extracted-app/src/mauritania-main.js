'use strict';
module.exports=function install({ipcMain,getWindow,getCountry,browserClients,windowStateByProfile,pushUserCount,crypto,config}){
  const assets=require('./portal-assets-main')({ipcMain,getWindow,getCountry,country:'Mauritania',prefix:'mauritania',notify:()=>publish()});const core=require('./mauritania-core');let rows=[],revision=0,enabled=false,retryEnabled=false,bookEnabled=false,policy=core.policy(),flow=core.flow(),proxyPool=[],proxyCursor=0;const peers=new Set();
  const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id);
  function authorize(event){const w=getWindow();if(!w||event.sender!==w.webContents||event.senderFrame!==w.webContents.mainFrame)throw Error('Invalid sender');}
  function status(){const active=getCountry()==='Mauritania';return {enabled:active&&enabled,retryEnabled:active&&retryEnabled,bookEnabled:active&&bookEnabled,flow:active?flow:core.flow(),policy,schedule:{...secClock.snapshot(),enabled:active&&secClock.snapshot().enabled},accounts:(active?rows:[]).map(({email,name})=>({email,name,autoCode:assets.enabled(email)})),revision,extensionVersion:config.version,connected:[...peers].filter(ws=>ws.readyState===1&&ws.browserId).length};}
  function send(ws,message){if(ws.readyState===1)ws.send(JSON.stringify(message));}
  function sync(ws){send(ws,{type:'MAURITANIA_STATE',...status()});}
  function publish(){for(const ws of peers)sync(ws);getWindow()?.webContents.send('tornado-mauritania-options',{enabled,retryEnabled,bookEnabled,flow,policy,schedule:secClock.snapshot(),revision});}
  function log(message){getWindow()?.webContents.send('tornado-mauritania-log',message);}
  ipcMain.handle('tornado-mauritania-publish',(event,value)=>{
    authorize(event);if(getCountry()!=='Mauritania')throw Error('Wrong country');const next=core.accounts(value);assets.syncAccounts(value);
    if(JSON.stringify(next)!==JSON.stringify(rows)){rows=next;revision++;publish();}return {saved:true,count:rows.length};
  });
  ipcMain.handle('tornado-mauritania-state',event=>{authorize(event);return {...status(),accounts:undefined};});
  ipcMain.handle('tornado-mauritania-auto',(event,value)=>{
    authorize(event);if(getCountry()!=='Mauritania'||typeof value!=='boolean')throw Error('Choose MAURITANIA first');
    enabled=value;publish();return {...status(),accounts:undefined};
  });
  ipcMain.handle('tornado-mauritania-retry',(event,value)=>{authorize(event);if(getCountry()!=='Mauritania'||typeof value!=='boolean')throw Error('Choose MAURITANIA first');if(value)secClock.stop();retryEnabled=value;publish();return {...status(),accounts:undefined};});

  // A batch contains only registered peers in the selected country. Each peer
  // checks its existing Retry tabs; this command never navigates another page.
  const retryBatches=new Map();
  function retryResult(ws,msg){
    const batch=retryBatches.get(msg.id);if(!batch||!batch.targets.has(ws))return;
    if(!['checked','successful','skipped','failed'].every(k=>Number.isInteger(msg[k])&&msg[k]>=0&&msg[k]<=10000))return;
    batch.targets.delete(ws);for(const k of ['checked','successful','skipped','failed'])batch.result[k]+=msg[k];
    if(!batch.targets.size)batch.done();
  }

  function cancelScheduled(){for(const batch of [...retryBatches.values()])if(batch.scheduled)batch.cancel();}
  const secClock=new core.MinuteSchedule({onStop:cancelScheduled,onChange:()=>publish(),onFire:()=>{if(getCountry()==='Mauritania')return retryAll(true,secClock.snapshot().profileDelayMs);},onError:()=>log('MAURITANIA · Scheduled Retry failed.')});
  function configureSchedule(value){const next=core.schedule(value);if(next.enabled)retryEnabled=false;const result=secClock.configure(next);publish();return result;}
  async function retryAll(scheduled=false,profileDelayMs=0){
    if(getCountry()!=='Mauritania')throw Error('Choose MAURITANIA first');if(retryBatches.size)return {sent:0,busy:true};
    const targets=new Set([...peers].filter(ws=>ws.readyState===1&&ws.browserId&&browserClients.get(ws.browserId)===ws));
    if(!targets.size)return {sent:0,checked:0,successful:0,skipped:0,failed:0};
    const id=crypto.randomUUID(),result={sent:targets.size,checked:0,successful:0,skipped:0,failed:0};
    return new Promise(resolve=>{
      let timer;const queued=new Set(),dispatched=new Set();
      const done=()=>{clearTimeout(timer);for(const t of queued)clearTimeout(t);queued.clear();retryBatches.delete(id);resolve(result);};
      const cancel=()=>{for(const ws of dispatched)send(ws,{type:'MAURITANIA_RETRY_CANCEL',id});result.cancelled=true;result.skipped+=targets.size;targets.clear();done();};
      timer=setTimeout(()=>{result.failed+=targets.size;targets.clear();done();},Math.min(2147483647,25000+(targets.size-1)*profileDelayMs));
      retryBatches.set(id,{targets,result,done,cancel,scheduled});let index=0;
      for(const ws of targets){const dispatch=()=>{if(!retryBatches.has(id)||!targets.has(ws))return;if(getCountry()!=='Mauritania'||scheduled&&!secClock.snapshot().enabled){retryResult(ws,{id,checked:0,successful:0,skipped:1,failed:0});return;}dispatched.add(ws);send(ws,{type:'MAURITANIA_RETRY_ALL',id});};const delay=index++*profileDelayMs;if(delay){const t=setTimeout(()=>{queued.delete(t);dispatch();},delay);queued.add(t);}else dispatch();}
    });
  }
  ipcMain.handle('tornado-mauritania-retry-all',async event=>{authorize(event);return retryAll();});
  ipcMain.handle('tornado-mauritania-schedule',(event,value)=>{authorize(event);if(getCountry()!=='Mauritania')throw Error('Choose MAURITANIA first');return configureSchedule(value);});

  ipcMain.handle('tornado-mauritania-open',(event,route)=>{
    authorize(event);if(getCountry()!=='Mauritania'||!Object.hasOwn(core.routes,route))throw Error('Invalid navigation');
    let sent=0;for(const ws of peers)if(ws.readyState===1&&ws.browserId){send(ws,{type:'MAURITANIA_OPEN',id:crypto.randomUUID(),url:core.origin+core.routes[route]});sent++;}return {sent};
  });
  ipcMain.handle('tornado-mauritania-booking',(event,value)=>{authorize(event);if(getCountry()!=='Mauritania'||typeof value!=='boolean')throw Error('Choose MAURITANIA first');bookEnabled=value;publish();return status();});
  ipcMain.handle('tornado-mauritania-policy',(event,value)=>{authorize(event);if(getCountry()!=='Mauritania')throw Error('Choose MAURITANIA first');policy=core.policy(value);publish();return policy;});
  ipcMain.handle('tornado-mauritania-proxies',(event,value)=>{authorize(event);if(getCountry()!=='Mauritania'||!Array.isArray(value)||value.length>10000)throw Error('Invalid proxy list');proxyPool=value.map(core.proxy).filter(Boolean);return {count:proxyPool.length};});
  ipcMain.handle('tornado-mauritania-flow',(event,value)=>{authorize(event);if(getCountry()!=='Mauritania')throw Error('Choose MAURITANIA first');flow=core.flow(value);publish();return flow;});
  function accept(ws,req){
    let u;try{u=new URL(req.url,'http://localhost');}catch{return false;}
    if(u.pathname!=='/mauritania')return false;
    ws.mauritaniaAdapter=true; // Exclude this peer from every legacy command broadcast.
    const remote=req.socket?.remoteAddress;
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)||req.headers.origin!==config.extensionOrigin||u.searchParams.get('key')!==config.key){ws.close(1008,'Not authorized');return true;}
    peers.add(ws);ws.isAlive=true;ws.country='Mauritania';ws.on('pong',()=>ws.isAlive=true);
    const registerTimer=setTimeout(()=>{if(!ws.browserId)ws.close(1008,'Registration required');},10000);
    ws.on('message',raw=>{
      if(raw.length>4096)return ws.close(1009,'Message too large');let msg;try{msg=JSON.parse(raw.toString());}catch{return;}
      if(msg.type==='MAURITANIA_REGISTER'){
        if(!validId(msg.browserId)||msg.version!==config.version||typeof msg.open!=='boolean')return ws.close(1008,'Unsupported helper');
        if(ws.browserId&&ws.browserId!==msg.browserId)return ws.close(1008,'Profile changed');
        const previous=browserClients.get(msg.browserId);if(previous&&previous!==ws&&previous.mauritaniaAdapter)previous.close(1000,'Reconnected');
        ws.browserId=msg.browserId;browserClients.set(ws.browserId,ws);windowStateByProfile.set(ws.browserId,{ws,open:msg.open,lastSeen:Date.now()});clearTimeout(registerTimer);sync(ws);pushUserCount();return;
      }
      if(!ws.browserId||browserClients.get(ws.browserId)!==ws)return;
      if(msg.type==='MAURITANIA_ASSETS'){if(typeof msg.id!=='string'||msg.id.length>80||getCountry()!=='Mauritania')return;const reply=value=>send(ws,{type:'MAURITANIA_ASSETS_RESULT',id:msg.id,...value});if(msg.action==='list')reply({ok:true,photos:assets.list()});else if(msg.action==='photo')reply({ok:true,data:assets.photo(msg.photoId)});else if(msg.action==='otp'&&rows.some(a=>a.email===core.email(msg.email)))void assets.otp(ws,msg).then(reply);else if(msg.action==='cancel')assets.cancel(ws,msg.jobId);else reply({ok:false});return;}
      if(msg.type==='MAURITANIA_RETRY_ALL_RESULT'){retryResult(ws,msg);return;}
      if(msg.type==='MAURITANIA_HEARTBEAT'){
        if(typeof msg.open==='boolean')windowStateByProfile.set(ws.browserId,{ws,open:msg.open,lastSeen:Date.now()});sync(ws);pushUserCount();return;
      }
      if(msg.type==='MAURITANIA_SET_SCHEDULE'){if(typeof msg.id!=='string')return;try{if(getCountry()!=='Mauritania')throw Error('Choose MAURITANIA first');configureSchedule(msg.schedule);send(ws,{type:'MAURITANIA_OPTION_RESULT',id:msg.id,ok:true});}catch(e){send(ws,{type:'MAURITANIA_OPTION_RESULT',id:msg.id,ok:false,error:e.message});}return;}
      if(msg.type==='MAURITANIA_SET_FLOW'){if(getCountry()!=='Mauritania'||typeof msg.id!=='string')return;try{flow=core.flow(msg.flow);publish();send(ws,{type:'MAURITANIA_OPTION_RESULT',id:msg.id,ok:true});}catch(e){send(ws,{type:'MAURITANIA_OPTION_RESULT',id:msg.id,ok:false,error:e.message});}return;}
      if(msg.type==='MAURITANIA_SET_BOOK'||msg.type==='MAURITANIA_SET_POLICY'||msg.type==='MAURITANIA_PROXY_REQUEST'){
        if(typeof msg.id!=='string'||msg.id.length>80)return;if(getCountry()!=='Mauritania'){send(ws,{type:'MAURITANIA_OPTION_RESULT',id:msg.id,ok:false,error:'Choose MAURITANIA first.'});return;}
        try{if(msg.type==='MAURITANIA_SET_BOOK'){if(typeof msg.enabled!=='boolean')throw Error('Invalid option');bookEnabled=msg.enabled;publish();}
        if(msg.type==='MAURITANIA_SET_POLICY'){policy=core.policy(msg.policy);publish();}
        if(msg.type==='MAURITANIA_PROXY_REQUEST'){if(!proxyPool.length)throw Error('Add proxies in Launcher > Manage > Proxy first.');if(Date.now()-(ws.lastProxyAt||0)<15000)throw Error('Wait before changing proxy again.');ws.lastProxyAt=Date.now();send(ws,{type:'MAURITANIA_PROXY_RESULT',id:msg.id,ok:true,proxy:proxyPool[proxyCursor++%proxyPool.length]});return;}
        send(ws,{type:'MAURITANIA_OPTION_RESULT',id:msg.id,ok:true});}catch(e){send(ws,{type:msg.type==='MAURITANIA_PROXY_REQUEST'?'MAURITANIA_PROXY_RESULT':'MAURITANIA_OPTION_RESULT',id:msg.id,ok:false,error:e.message});}return;
      }
      if(msg.type==='MAURITANIA_SET_RETRY'){
        if(typeof msg.id!=='string'||msg.id.length>80||typeof msg.enabled!=='boolean')return;
        if(getCountry()!=='Mauritania'){send(ws,{type:'MAURITANIA_OPTION_RESULT',id:msg.id,ok:false,error:'Choose MAURITANIA in Launcher first.'});return;}
        if(msg.enabled)secClock.stop();retryEnabled=msg.enabled;publish();send(ws,{type:'MAURITANIA_OPTION_RESULT',id:msg.id,ok:true,retryEnabled});return;
      }
      if(msg.type==='MAURITANIA_SET_AUTO'){
        if(typeof msg.id!=='string'||msg.id.length>80||typeof msg.enabled!=='boolean')return;
        if(getCountry()!=='Mauritania'){send(ws,{type:'MAURITANIA_OPTION_RESULT',id:msg.id,ok:false,error:'Choose MAURITANIA in Launcher first.'});return;}
        enabled=msg.enabled;publish();send(ws,{type:'MAURITANIA_OPTION_RESULT',id:msg.id,ok:true,enabled});return;
      }
      if(msg.type==='MAURITANIA_CREDENTIAL'){
        if(typeof msg.id!=='string'||msg.id.length>80||!['auto','manual'].includes(msg.intent))return;
        const a=rows.find(a=>a.email===core.email(msg.email));
        const allowed=getCountry()==='Mauritania'&&a&&(msg.intent==='manual'||enabled);
        send(ws,{type:'MAURITANIA_CREDENTIAL_RESULT',id:msg.id,ok:!!allowed,email:allowed?a.email:undefined,password:allowed?a.password:undefined});return;
      }
      if(msg.type==='MAURITANIA_LOG'&&['submitted','missing-form','locked','login-route-left'].includes(msg.event)){
        const names={submitted:'Login submitted', 'missing-form':'Login form not ready',locked:'Website login is unavailable or locked','login-route-left':'Left login page'};
        log(`MAURITANIA · ${ws.browserId.slice(0,8)} · ${names[msg.event]}`);
      }
    });
    ws.on('close',()=>{for(const [id]of retryBatches)retryResult(ws,{id,checked:0,successful:0,skipped:0,failed:1});clearTimeout(registerTimer);peers.delete(ws);if(browserClients.get(ws.browserId)===ws){browserClients.delete(ws.browserId);if(windowStateByProfile.get(ws.browserId)?.ws===ws)windowStateByProfile.delete(ws.browserId);}pushUserCount();});
    return true;
  }
  return {accept};
};

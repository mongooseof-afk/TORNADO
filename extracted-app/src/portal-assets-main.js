'use strict';
// Installed separately for each country; secrets are encrypted by Electron safeStorage.
module.exports=function({ipcMain,getWindow,getCountry,country,prefix,notify}){
 const fs=require('fs'),path=require('path'),{app,safeStorage}=require('electron'),mail=require('./portal-mail');
 if(!ipcMain.__tornadoAssets){ipcMain.__tornadoAssets=new Map();ipcMain.handle('tornado-portal-assets',(e,m)=>{const handler=ipcMain.__tornadoAssets.get(getCountry());if(!handler)throw Error('Select country');return handler(e,m);});}
 const file=path.join(app.getPath('userData'),'tornado-'+prefix+'-assets.json');let data={mail:{},photos:{}},clients=[];try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}data.mail||={};data.photos||={};
 const jobs=new Map(),last=new Map(),mailSignatures=new Map();const email=v=>typeof v==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)&&v.length<255?v.toLowerCase():'';
 const save=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(file+'.tmp',file);notify();};
 const authorize=e=>{const w=getWindow();if(getCountry()!==country||e.sender!==w?.webContents||e.senderFrame!==w.webContents.mainFrame)throw Error('Invalid sender');};
 function list(){return clients.filter(c=>data.photos[c.id]).map(c=>({id:c.id,name:c.name,thumbnail:data.photos[c.id].thumbnail}));}
 const config=()=>({mail:Object.fromEntries(Object.entries(data.mail).map(([id,v])=>[id,{enabled:v.enabled,mailbox:v.mailbox,configured:!!v.secret}])),photos:list()});
 ipcMain.__tornadoAssets.set(country,async(e,m={})=>{authorize(e);
 if(m.action==='clients'){if(!Array.isArray(m.clients)||m.clients.length>3000)throw Error('Invalid clients');clients=m.clients.filter(c=>typeof c.id==='string'&&c.id.length<180&&typeof c.name==='string').map(c=>({id:c.id,name:c.name.slice(0,100)}));return config();}
 if(m.action==='export-photos')return Object.fromEntries(clients.filter(c=>data.photos[c.id]).map(c=>[c.id,data.photos[c.id]]));
 if(m.action==='mail'){const id=email(m.email),mailbox=email(m.mailbox);if(!id||!mailbox)throw Error('Enter account email and Gmail mailbox');const old=data.mail[id]||{};let secret=old.secret;
 if(m.password){if(!safeStorage.isEncryptionAvailable())throw Error('Windows secure storage unavailable');const p=String(m.password).replace(/\s/g,'');if(!/^[a-z]{16}$/i.test(p))throw Error('Enter the 16-character Gmail App Password');secret=safeStorage.encryptString(p).toString('base64');}
 if(!secret)throw Error('Enter Gmail App Password');if(old.mailbox&&old.mailbox!==mailbox&&!m.password)throw Error('Enter App Password for the new mailbox');data.mail[id]={mailbox,secret,enabled:m.enabled===true};save();return config();}
 if(m.action==='photo'){if(!clients.some(c=>c.id===m.id))throw Error('Select a saved client');if(m.remove)delete data.photos[m.id];else{const valid=(s,max)=>typeof s==='string'&&s.length<=max&&/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(s);if(!valid(m.data,2800000)||!valid(m.thumbnail,100000))throw Error('Use a JPEG or PNG photo below 2 MB');if(!data.photos[m.id]&&Object.keys(data.photos).length>=200)throw Error('Photo limit reached');data.photos[m.id]={data:m.data,thumbnail:m.thumbnail};}save();return config();}return config();});
 return {syncAccounts(rows){let changed=false;const present=new Set();for(const row of rows){const id=email(row.email);if(!id)continue;present.add(id);const password=String(row['app-password']||'').replace(/\s/g,'');if(mailSignatures.get(id)===password)continue;mailSignatures.set(id,password);if(!/^[a-z]{16}$/i.test(password)){if(data.mail[id]?.enabled){data.mail[id].enabled=false;changed=true;}continue;}if(!safeStorage.isEncryptionAvailable())throw Error('Windows secure storage unavailable');data.mail[id]={mailbox:id,secret:safeStorage.encryptString(password).toString('base64'),enabled:true};changed=true;}for(const id of Object.keys(data.mail))if(!present.has(id)){delete data.mail[id];mailSignatures.delete(id);changed=true;}if(changed)save();},enabled:account=>!!data.mail[email(account)]?.enabled,list,
 photo:id=>clients.some(c=>c.id===id)?data.photos[id]?.data:null,
 cancel(ws,id){const active=jobs.get(ws),job=active?.get(id);if(job){job.abort();active.delete(id);}},
 async otp(ws,msg){const id=email(msg.email),entry=data.mail[id];if(getCountry()!==country||!entry?.enabled)return {ok:false,error:'Auto Code is not configured'};
 if(!Number.isFinite(msg.since)||msg.since<Date.now()-300000||msg.since>Date.now()+5000)return {ok:false,error:'Code request expired'};
 let active=jobs.get(ws);if(!active){active=new Map();jobs.set(ws,active);ws.once('close',()=>{for(const c of active.values())c.abort();jobs.delete(ws);});}if(active.size||Date.now()-(last.get(id)||0)<10000)return {ok:false,error:'A code check is already running'};
 const control=new AbortController();active.set(msg.id,control);last.set(id,Date.now());const timeout=setTimeout(()=>control.abort(),70000);
 try{const password=safeStorage.decryptString(Buffer.from(entry.secret,'base64')),code=await mail.read({email:entry.mailbox,password,recipient:id,since:msg.since,signal:control.signal});return control.signal.aborted?{ok:false}:{ok:!!code,code,error:code?undefined:'No matching recent BLS code found'};}catch{return {ok:false,error:'Could not read Gmail. Check App Password and mailbox.'};}finally{clearTimeout(timeout);active.delete(msg.id);}
 }};
};

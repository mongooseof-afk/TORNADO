(function(root){
  'use strict';
  const origin='https://spain-mauritania.blsinternational.com';
  const routes={login:'/login',account:'/my-account',book:'/book-appointment',manage:'/manage-appointments',drafts:'/manage-appointments?tornado=delete-drafts',retry:'/book-appointment?tornado=retry'};
  const text=(value,max=180)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
  const email=value=>{const s=text(value,254).toLowerCase();return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)?s:'';};
  function accounts(value){
    if(!Array.isArray(value)||value.length>3000)throw Error('Invalid Spain account list');
    const mapped=value.filter(a=>a&&typeof a==='object'&&email(a.email)&&typeof a.password==='string'&&a.password.length>0&&a.password.length<=1024).map(a=>({email:email(a.email),name:text(a.name,100)||email(a.email),password:a.password}));
    const counts=new Map();for(const a of mapped)counts.set(a.email,(counts.get(a.email)||0)+1);
    return mapped.filter(a=>counts.get(a.email)===1);
  }
  function page(value){try{const u=new URL(value);return u.origin===origin?{url:u.href,path:u.pathname.replace(/\/+$/,'')||'/'}:null;}catch{return null;}}
  const isLogin=value=>['/','/login'].includes(page(value)?.path);
  function policy(value={}){const n=value.maxAttempts===''||value.maxAttempts==null?0:Number(value.maxAttempts);if(!Number.isInteger(n)||n<0||n>999)throw Error('Attempts must be 1–999 or empty');if(!['','new-app','proxy'].includes(value.onMax||''))throw Error('Invalid max action');const delaySeconds=value.delaySeconds===''||value.delaySeconds==null?null:Number(value.delaySeconds);if(delaySeconds!==null&&(!Number.isInteger(delaySeconds)||delaySeconds<1||delaySeconds>120))throw Error('Delay must be 1–120 seconds or empty');return {maxAttempts:n,onMax:value.onMax||'',delaySeconds};}
  function proxy(value){try{let host,port,username='',password='';if(typeof value==='string'){const s=value.trim();if(s.includes('@')||s.includes('://')){const u=new URL(s.includes('://')?s:'http://'+s);if(!['http:','https:'].includes(u.protocol))return null;host=u.hostname;port=Number(u.port||80);username=decodeURIComponent(u.username);password=decodeURIComponent(u.password);}else{const parts=s.split(':');if(![2,4].includes(parts.length))return null;[host,port,username='',password='']=parts;port=Number(port);}}else if(value&&typeof value==='object'){({host,port,username='',password=''}=value);port=Number(port);}if(typeof host!=='string'||!/^[a-z0-9.-]{1,253}$/i.test(host)||!Number.isInteger(port)||port<1||port>65535||typeof username!=='string'||typeof password!=='string'||username.length>256||password.length>256)return null;return {host,port,username,password};}catch{return null;}}
  function flow(value={}){if(!['random','first','last'].includes(value.dateMode||'random'))throw Error('Invalid date selection');const members=Number(value.members??1);if(!Number.isInteger(members)||members<1||members>5)throw Error('Members must be 1–5');const centre=text(value.centre,80)||(origin.includes('mauritania')?'Nouadhibou':'');if(origin.includes('mauritania')&&centre!=='Nouadhibou')throw Error('Mauritania supports Nouadhibou only');return {account:value.account===true,calendar:value.calendar===true,dateMode:value.dateMode||'random',centre,visa:text(value.visa,80),members,autoCancelDrafts:value.autoCancelDrafts===true};}

  function schedule(value={}){
    const time=String(value.time||'').trim();let normalized='';
    if(time){const m=/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(time);if(!m)throw Error('Use HH:mm:ss.SSS');normalized=m[1]+':'+m[2]+':'+(m[3]||'00')+'.'+(m[4]||'0').padEnd(3,'0');}
    const profileDelayMs=Number(value.profileDelayMs??0),anchorAt=Number(value.anchorAt??0);
    if(!Number.isInteger(profileDelayMs)||profileDelayMs<0||profileDelayMs>60000)throw Error('Profile delay must be 0–60000 ms');
    if(!Number.isSafeInteger(anchorAt)||anchorAt<0)throw Error('Invalid saved start time');
    return {enabled:value.enabled===true,time:normalized,profileDelayMs,anchorAt};
  }
  // Absolute local-device start time, then a fixed minute cadence. Missed
  // occurrences are skipped, never replayed as a burst after a delayed wakeup.
  class MinuteSchedule{
    constructor({now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,onFire=()=>{},onChange=()=>{},onStop=()=>{},onError=()=>{}}={}){Object.assign(this,{now,setTimer,clearTimer,onFire,onChange,onStop,onError});this.value=schedule();this.timer=null;this.nextAt=0;this.epoch=0;}
    snapshot(){return {...this.value,nextAt:this.nextAt};}
    stop(){this.epoch++;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;this.nextAt=0;this.value={...this.value,enabled:false};this.onStop();this.onChange(this.snapshot());return this.snapshot();}
    configure(value){const next=schedule(value);this.stop();if(next.enabled&&next.time&&!next.anchorAt){const now=this.now(),d=new Date(now),parts=next.time.split(/[:.]/).map(Number);d.setHours(parts[0],parts[1],parts[2],parts[3]);if(d.getTime()<=now)d.setDate(d.getDate()+1);next.anchorAt=d.getTime();}this.value=next;if(next.enabled&&next.time){this.nextAt=next.anchorAt;if(this.nextAt<=this.now())this.nextAt+=((Math.floor((this.now()-this.nextAt)/60000))+1)*60000;this.arm();}this.onChange(this.snapshot());return this.snapshot();}
    arm(){if(!this.value.enabled||!this.value.time||!this.nextAt)return;const epoch=this.epoch,due=this.nextAt;this.timer=this.setTimer(()=>{this.timer=null;if(epoch!==this.epoch||!this.value.enabled)return;if(this.now()<due){this.arm();return;}this.nextAt=due+(Math.floor((this.now()-due)/60000)+1)*60000;this.arm();this.onChange(this.snapshot());Promise.resolve().then(()=>{if(epoch===this.epoch&&this.value.enabled)return this.onFire({due,...this.snapshot()});}).catch(this.onError);},Math.max(0,due-this.now()));}
  }

  const api={schedule,MinuteSchedule,flow,policy,proxy,origin,routes,text,email,accounts,page,isLogin};if(typeof module==='object'&&module.exports)module.exports=api;else root.TornadoMauritania=Object.freeze(api);
})(globalThis);

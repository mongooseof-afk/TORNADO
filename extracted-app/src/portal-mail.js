'use strict';
// Match only recent BLS mail addressed to this account. Never return message bodies.
function extract(mail,recipient,since,received,now=Date.now()){
 const date=new Date(received||mail.date).getTime();if(!Number.isFinite(date)||date<since||date>now+120000)return null;
 if(!mail.from?.value?.some(v=>/@(?:[a-z0-9-]+\.)?blsinternational\.com$/i.test(v.address||'')))return null;
 const body=mail.text||String(mail.html||'').replace(/<[^>]*>/g,' ');
 const addressed=body.match(/Dear\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i)?.[1];
 if(addressed?addressed.toLowerCase()!==recipient:!mail.to?.value?.some(v=>v.address?.toLowerCase()===recipient))return null;
 const code=body.match(/(?:verification\s+code|one[ -]time\s+(?:password|code)|otp|security\s+code|code\s+(?:de\s+)?(?:vérification|verification|sécurité))\b[^\d]{0,80}(\d{6})\b/i)?.[1];
 return code||null;
}
async function read({email,password,recipient,since,signal},deps={}){
 const ImapFlow=deps.ImapFlow||require('imapflow').ImapFlow,parse=deps.parse||require('mailparser').simpleParser;
 const client=new ImapFlow({host:'imap.gmail.com',port:993,secure:true,auth:{user:email,pass:password},logger:false,connectionTimeout:12000,greetingTimeout:12000,socketTimeout:15000});
 const close=()=>{try{client.close();}catch{}};signal.addEventListener('abort',close,{once:true});client.on('error',()=>{});let lock;
 try{await client.connect();lock=await client.getMailboxLock('INBOX');const end=Date.now()+60000,checked=new Set();
 while(!signal.aborted&&Date.now()<end){const ids=(await client.search({since:new Date(since)},{uid:true})).sort((a,b)=>b-a).slice(0,40);
 for(const uid of ids){if(signal.aborted)return null;if(checked.has(uid))continue;checked.add(uid);const message=await client.fetchOne(uid,{source:true,internalDate:true},{uid:true});if(!message?.source||message.source.length>2*1024*1024)continue;const code=extract(await parse(message.source),recipient,since,message.internalDate);if(code)return code;}
 await new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,3000);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});}return null;
 }finally{signal.removeEventListener('abort',close);try{lock?.release();}catch{}close();}
}
module.exports={extract,read};


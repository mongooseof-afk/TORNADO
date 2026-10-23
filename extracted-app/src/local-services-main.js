'use strict';
module.exports=({app,ipcMain,utilityProcess,path,getWindow,fetchImpl=fetch,resourcesPath=process.resourcesPath,ports={windows:3000,timer:8766,captcha:3001}})=>{
  let child=null,closing=false,restarts=0;
  const states=Object.fromEntries(Object.entries(ports).map(([name,port])=>[name,{state:'starting',port}]));
  const snapshot=()=>JSON.parse(JSON.stringify(states));
  ipcMain.handle('tornado-local-services-get',event=>{
    const win=getWindow();
    if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('Invalid sender');
    return snapshot();
  });
  function start(){
    if(closing||child)return;
    for(const name of Object.keys(states))states[name]={state:'starting',port:ports[name]};
    try{
      const root=path.join(resourcesPath,'local-services');
      child=utilityProcess.fork(path.join(root,'host.js'),[],{cwd:root,serviceName:'Tornado Local Services',stdio:'pipe',env:{...process.env,TORNADO_DATA_DIR:path.join(app.getPath('userData'),'local-services'),TORNADO_WINDOWS_PORT:String(ports.windows),TORNADO_TIMER_PORT:String(ports.timer),TORNADO_CAPTCHA_PORT:String(ports.captcha)}});
      child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});
      child.on('message',message=>{
        if(message?.type!=='STATUS'||!Object.hasOwn(states,message.name)||!['starting','loading','ready','error'].includes(message.state))return;
        states[message.name]={state:message.state,port:ports[message.name],detail:typeof message.detail==='string'?message.detail.slice(0,160):''};
      });
      child.once('exit',()=>{
        child=null;
        for(const name of Object.keys(states))states[name]={state:'error',port:ports[name],detail:closing?'Stopped':'Local service process stopped.'};
        if(!closing&&restarts++<1)setTimeout(start,1000);
      });
    }catch{
      child=null;for(const name of Object.keys(states))states[name]={state:'error',port:ports[name],detail:'Bundled local services could not start.'};
    }
  }
  function stop(){closing=true;try{child?.kill();}catch{}child=null;}
  app.once('before-quit',stop);
  async function solve(job){
    const images=Array.isArray(job?.images)?job.images.map(image=>typeof image==='string'?image:image?.image):[];
    const target=String(job?.target||'').trim();
    if(!/^\d{3}$/.test(target)||images.length<1||images.length>30||images.some(image=>typeof image!=='string'||!/^data:image\/(?:png|jpeg|webp);base64,/i.test(image)||image.length>2000000))throw Error('Invalid CAPTCHA job');
    const started=Date.now();
    while(['starting','loading'].includes(states.captcha.state)&&Date.now()-started<25000)await new Promise(resolve=>setTimeout(resolve,100));
    if(states.captcha.state!=='ready')throw Error('Local CAPTCHA service is not ready');
    const response=await fetchImpl('http://127.0.0.1:'+ports.captcha+'/api/predict',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:images,ids:images.map((_,i)=>String(i)),targetNumber:target,pageType:'numberGrid'}),signal:AbortSignal.timeout(60000)});
    const body=await response.json();
    if(!response.ok||body.ok!==true||!Array.isArray(body.solution?.text)||body.solution.text.length!==images.length)throw Error('Invalid local CAPTCHA response');
    const result=body.solution.text.map(number=>({number:/^\d{3}$/.test(String(number))?String(number):'-'}));
    if(!result.some(item=>item.number===target)){
      const error=new Error('No matching CAPTCHA tile');error.code='CAPTCHA_NO_MATCH';throw error;
    }
    return result;
  }
  return {start,stop,solve,snapshot};
};

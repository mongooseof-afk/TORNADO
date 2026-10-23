'use strict';
const path=require('path'),fs=require('fs');
const parent=process.parentPort;
const report=value=>{if(parent)parent.postMessage(value);else if(process.send)process.send(value);};
const status=(name,value)=>report({type:'STATUS',name,...value});
const {startWindows,startTimer}=require('./legacy-services');
const windows=startWindows(Number(process.env.TORNADO_WINDOWS_PORT||3000),value=>status('windows',value));
const timer=startTimer(Number(process.env.TORNADO_TIMER_PORT||8766),value=>status('timer',value));
process.env.HOST='127.0.0.1';process.env.PORT=process.env.TORNADO_CAPTCHA_PORT||'3001';
process.env.SERVER_LOG_LEVEL='silent';
// Identical images use deterministic preprocessing/inference. Repeating a
// no-match result after 500 ms adds latency without improving the prediction.
process.env.SEMANTIC_RETRY_MAX='0';
process.env.BLS_LOCAL_DATA_DIR=process.env.TORNADO_DATA_DIR||path.join(__dirname,'test-data');
fs.mkdirSync(process.env.BLS_LOCAL_DATA_DIR,{recursive:true});
let captcha;
try{
  captcha=require('./captcha/server');
  captcha.server.on('listening',async()=>{
    status('captcha',{state:'loading',port:Number(process.env.PORT)});
    try{await captcha.ready();status('captcha',{state:'ready',port:Number(process.env.PORT)});}
    catch{status('captcha',{state:'error',port:Number(process.env.PORT),detail:'CAPTCHA model could not load.'});}
  });
  captcha.server.on('error',error=>status('captcha',{state:'error',port:Number(process.env.PORT),detail:error.code==='EADDRINUSE'?'Port in use. Close the old service.':'CAPTCHA service could not start.'}));
}catch{status('captcha',{state:'error',port:Number(process.env.PORT),detail:'Bundled CAPTCHA runtime could not load.'});}
let stopping=false;
function stop(){
  if(stopping)return;stopping=true;
  windows.stop();timer.stop();captcha?.server.close();
  setTimeout(()=>process.exit(0),200).unref();
}
if(parent)parent.on('message',event=>{if(event.data?.type==='STOP')stop();});
else process.on('message',message=>{if(message?.type==='STOP')stop();});
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('disconnect',stop);

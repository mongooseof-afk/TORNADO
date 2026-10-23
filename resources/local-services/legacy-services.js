'use strict';
const WebSocket=require('ws');
const layouts={1:[1],2:[2],3:[3],4:[2,2],5:[3,2],6:[3,3],7:[4,3],8:[4,4],9:[3,3,3],10:[5,5],11:[4,4,3],12:[4,4,4],13:[5,4,4],14:[5,5,4],15:[5,5,5],16:[4,4,4,4],20:[5,5,5,5],25:[5,5,5,5,5]};
function grid(count,width,height){
  const cols=Math.ceil(Math.sqrt(count));
  const rows=layouts[count]||Array.from({length:Math.ceil(count/cols)},(_,i)=>Math.min(cols,count-i*cols));
  const positions=[];
  rows.forEach((n,row)=>{for(let col=0;col<n;col++)positions.push({left:Math.floor(width/n)*col,top:Math.floor(height/rows.length)*row,width:Math.floor(width/n),height:Math.floor(height/rows.length)});});
  return positions;
}
const send=(socket,payload)=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(payload));};
function create(port,onStatus){
  const server=new WebSocket.Server({host:'127.0.0.1',port,maxPayload:65536});
  server.on('listening',()=>onStatus({state:'ready',port}));
  server.on('error',error=>onStatus({state:'error',port,detail:error.code==='EADDRINUSE'?'Port in use. Close the old service.':'Service could not start ('+(error.code||'error')+').'}));
  return server;
}
function startWindows(port,onStatus){
  const server=create(port,onStatus),clients=new Map();
  let width=1920,height=1030,timer;
  function arrange(){
    clearTimeout(timer);timer=setTimeout(()=>{
      const list=[...clients.values()].filter(client=>client.socket.readyState===WebSocket.OPEN);
      const positions=grid(list.length,width,height);
      list.forEach((client,index)=>send(client.socket,{type:'arrange',windowId:client.id,position:positions[index]}));
    },400);
  }
  const heartbeat=setInterval(()=>{for(const client of clients.values()){if(!client.alive){client.socket.terminate();continue;}client.alive=false;client.socket.ping();}},10000);
  server.on('connection',socket=>{
    let id=null;
    socket.on('pong',()=>{if(clients.get(id)?.socket===socket)clients.get(id).alive=true;});
    socket.on('message',raw=>{
      let message;try{message=JSON.parse(raw);}catch{return;}
      if(message.type==='NAV_ALL'&&typeof message.path==='string'&&/^\/(?!\/)/.test(message.path)&&message.path.length<8192){
        for(const other of server.clients)if(other!==socket)send(other,{type:'NAV_ALL',path:message.path});
      }
      if(message.type==='register'&&Number.isSafeInteger(message.windowId)&&message.windowId>=0){
        if(clients.get(id)?.socket===socket)clients.delete(id);
        id=message.windowId;
        if(Number.isFinite(message.screenWidth)&&message.screenWidth>=320&&message.screenWidth<=32768)width=message.screenWidth;
        if(Number.isFinite(message.screenHeight)&&message.screenHeight>=200&&message.screenHeight<=32768)height=message.screenHeight;
        clients.set(id,{id,socket,alive:true});arrange();
      }
      if(message.type==='unregister'&&clients.get(id)?.socket===socket){clients.delete(id);id=null;arrange();}
    });
    socket.on('close',()=>{if(clients.get(id)?.socket===socket){clients.delete(id);arrange();}});
    socket.on('error',()=>{});
  });
  return {server,stop(){clearInterval(heartbeat);clearTimeout(timer);for(const socket of server.clients)socket.terminate();server.close();}};
}
function startTimer(port,onStatus){
  const server=create(port,onStatus),clients=new Map();let nextId=1;
  server.on('connection',socket=>{
    const id=nextId++;clients.set(id,socket);
    send(socket,{type:'WELCOME',id,server_time:Date.now(),multi_submit:true});
    socket.on('message',raw=>{
      let message;try{message=JSON.parse(raw);}catch{return;}
      if(message.type==='MASS_STOP'){
        for(const other of clients.values())send(other,{type:'DISARM_ALL',source_id:id,server_time:Date.now()});
        return;
      }
      if(message.type!=='MASS_SET')return;
      const {target_time:target,scaled_ms:scaled,each_seconds:each}=message;
      const extra=message.country==='PT'?(message.extra_tries??0):0;
      const gap=message.country==='PT'?(message.interval_ms??100):100;
      if(!Number.isSafeInteger(target)||Math.abs(target)>8640000000000000||!Number.isSafeInteger(scaled)||scaled<0||
         !Number.isSafeInteger(each)||each<0||!Number.isSafeInteger(extra)||extra<0||extra>20||
         !Number.isSafeInteger(gap)||gap<1||gap>60000||(extra>0&&each>0&&extra*gap>=each*1000))return;
      const ids=[...clients.keys()].filter(other=>other!==id);
      for(let i=ids.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[ids[i],ids[j]]=[ids[j],ids[i]];}
      [id,...ids].forEach((other,index)=>{
        const at=target+index*scaled;
        if(!Number.isSafeInteger(at)||Math.abs(at)>8640000000000000)return;
        send(clients.get(other),{type:'SCHEDULE',submit_at:at,offset_ms:index*scaled,each_seconds:each,source_id:id,scaled_ms:scaled,target_time:target,extra_tries:extra,interval_ms:gap});
      });
    });
    socket.on('close',()=>clients.delete(id));socket.on('error',()=>{});
  });
  return {server,stop(){for(const socket of server.clients)socket.terminate();server.close();}};
}
module.exports={startWindows,startTimer,grid};

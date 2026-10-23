'use strict';
module.exports=function(){
  const actions=['auto-login','auto-redirect','auto-slot-sec','auto-visatype','auto-proxy','auto-captcha','auto-submit-slot'];
  const states=new Map(['Spain','SpainNew','Portugal','Mauritania'].map(country=>[country,new Map(actions.map(action=>[action,false]))]));
  return {
    remember(message,country){if(message?.type==='COMMAND'&&states.get(country)?.has(message.action)&&typeof message.data?.enabled==='boolean')states.get(country).set(message.action,message.data.enabled);},
    sync(socket,country){for(const[action,enabled]of states.get(country)||[])socket.send(JSON.stringify({type:'COMMAND',action,country,data:{enabled}}));},
    snapshot:country=>Object.fromEntries(states.get(country)||[])
  };
};

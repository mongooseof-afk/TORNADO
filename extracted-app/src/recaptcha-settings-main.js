'use strict';
module.exports = ({app, ipcMain, fs, path, getWindow, broadcast}) => {
  const file=path.join(app.getPath('userData'),'tornado-recaptcha.json');
  let value=null;
  try { const stored=JSON.parse(fs.readFileSync(file,'utf8')); if(typeof stored.value==='string')value=stored.value; } catch {}
  const valid=event=>{const win=getWindow();return win&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame;};
  ipcMain.on('tornado-recaptcha-read',event=>{event.returnValue=valid(event)?value:null;});
  ipcMain.handle('tornado-recaptcha-save',(event,next)=>{
    if(!valid(event)||typeof next!=='string'||next.length>8192)throw Error('Invalid setting');
    const normalized=next.trim();
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file+'.tmp',JSON.stringify({value:normalized}),{encoding:'utf8',mode:0o600});
    fs.renameSync(file+'.tmp',file);
    value=normalized;
    broadcast({type:'COMMAND',action:'recaptcha-token',country:'Spain',data:value});
    return {saved:true};
  });
  return {sync(socket,country){if(country==='Spain'&&value!==null)socket.send(JSON.stringify({type:'COMMAND',action:'recaptcha-token',country,data:value}));}};
};

'use strict';
module.exports = ({ipcMain,getWindow}) => {
  let settings={enabled:false,delaySeconds:2};
  const current=()=>({...settings});
  const authorize=event=>{const win=getWindow();if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('Invalid sender');};
  ipcMain.handle('tornado-site-error-get',event=>{authorize(event);return current();});
  ipcMain.handle('tornado-site-error-set',(event,value)=>{
    authorize(event);
    if(typeof value?.enabled!=='boolean'||!Number.isInteger(value.delaySeconds)||value.delaySeconds<1||value.delaySeconds>120)throw Error('Use a delay of 1–120 seconds');
    settings={enabled:value.enabled,delaySeconds:value.delaySeconds};return current();
  });
  return {handle(req,res){if(req.method!=='GET'||req.url!=='/site-error-reload-settings')return false;res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(current()));return true;}};
};

'use strict';
module.exports = function({app,fs,path,ipcMain,getWindow,onChange,getOptions}) {
  // Country selection lasts for this process only. Saved account keys are untouched.
  let country=null;
  const context=()=>({country,options:getOptions(country)});
  function authorize(event){const win=getWindow();if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('Invalid sender');}
  ipcMain.on('tornado-country-bootstrap',event=>{authorize(event);event.returnValue=context();});
  ipcMain.handle('tornado-country-select',(event,next)=>{
    authorize(event);if(!['SpainNew','Portugal','Mauritania'].includes(next))throw Error('Invalid country');
    country=next;
    // A disconnected profile must not turn a committed switch into a UI failure.
    try{onChange();}catch{}
    return context();
  });
  return {current:()=>country};
};

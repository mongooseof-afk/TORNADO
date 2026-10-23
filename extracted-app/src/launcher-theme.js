(() => {
  'use strict';
  const key='tornado.launcher.theme.v1';let dark=document.documentElement.dataset.launcherTheme==='dark';
  try{dark=window.localStorage.getItem(key)==='dark';}catch{}
  const input=document.getElementById('darkModeToggle');
  if(input){const item=input.closest('.toggle-item');if(item)item.dataset.spainNewOption='launcher-theme';document.querySelector('#secondary .spain-new-empty')?.remove();}
  function apply(){
    document.documentElement.classList.toggle('dark-mode',dark);document.body.classList.toggle('dark-mode',dark);document.documentElement.dataset.launcherTheme=dark?'dark':'light';
    if(input)input.checked=dark;
  }
  function save(value){dark=value;try{window.localStorage.setItem(key,dark?'dark':'light');}catch{}apply();}
  // Own the existing Launcher theme toggle so the legacy startup reset cannot overwrite this preference.
  window.addEventListener('change',event=>{if(event.target!==input)return;event.stopImmediatePropagation();save(input.checked);},true);
  const observer=new MutationObserver(()=>{if(document.body.classList.contains('dark-mode')!==dark||document.documentElement.classList.contains('dark-mode')!==dark)apply();});
  observer.observe(document.documentElement,{attributes:true,attributeFilter:['class']});observer.observe(document.body,{attributes:true,attributeFilter:['class']});
  window.addEventListener('storage',event=>{if(event.key===key){dark=event.newValue==='dark';apply();}});
  window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});apply();
})();

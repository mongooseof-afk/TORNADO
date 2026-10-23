(() => {
  'use strict';
  const country=window.tornadoCountry.initial.country;
  const options=window.tornadoCountry.initial.options;
  const ids={'auto-login':'autoLoginToggle','auto-redirect':'autoRedirectToggle','auto-slot-sec':'autoSlotSecToggle','auto-visatype':'autoVTToggle','auto-proxy':'autoProxyRotate','auto-captcha':'autoCaptchaToggle','auto-submit-slot':'autoSubmitSlot'};
  for(const[action,id]of Object.entries(ids))document.getElementById(id).checked=options[action]===true;
  function refreshCounts(){for(const button of document.querySelectorAll('[data-country-choice]')){
    const key=({Mauritania:'tornado.mauritania.accounts.v1',Spain:'accounts',Portugal:'tornado.portugal.accounts.v1',SpainNew:'tornado.spain-new.accounts.v1'})[button.dataset.countryChoice];
    let count=0;try{const rows=JSON.parse(window.localStorage.getItem(key)||'[]');if(Array.isArray(rows))count=rows.length;}catch{}
    button.querySelector('small').textContent=count+(count===1?' saved account':' saved accounts');
  }}
  for(const button of document.querySelectorAll('[data-country-choice]')){
    const selected=button.dataset.countryChoice===country;button.setAttribute('aria-pressed',String(selected));
    button.addEventListener('click',async()=>{
      if(selected){document.querySelector('.nav-item[data-section="settings"]')?.click();return;}
      const buttons=[...document.querySelectorAll('[data-country-choice]')];buttons.forEach(b=>b.disabled=true);
      try{await window.tornadoCountry.select(button.dataset.countryChoice);location.reload();}
      catch{buttons.forEach(b=>b.disabled=false);document.getElementById('tornado-country-error').textContent='Could not switch country. Your accounts remain saved.';}
    });
  }
  refreshCounts();
  const accounts=document.getElementById('accounts-container');
  if(accounts)new MutationObserver(refreshCounts).observe(accounts,{childList:true,subtree:true});
  window.addEventListener('storage',refreshCounts);
  // A fresh process has no country. Require an explicit choice before other tabs.
  document.addEventListener('click',event=>{
    const tab=event.target.closest('.nav-item');
    if(!country&&tab&&tab.dataset.section!=='home'){
      event.preventDefault();event.stopImmediatePropagation();
      document.getElementById('tornado-country-error').textContent='Choose SPAIN NEW, Portugal or Mauritania first.';
    }
  },true);
  if(country){
    // Native authentication may finish after this script; navigate once it does.
    const auth=document.getElementById('auth-section');
    const ready=()=>{
      if(auth.classList.contains('active'))return false;
      document.querySelector('.nav-item[data-section="settings"]')?.click();return true;
    };
    const observer=new MutationObserver(()=>{if(ready())observer.disconnect();});
    observer.observe(auth,{attributes:true,attributeFilter:['class']});
    document.addEventListener('DOMContentLoaded',()=>{if(ready())observer.disconnect();},{once:true});
  }
})();

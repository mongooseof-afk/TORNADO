(() => {
  'use strict';
  if(document.documentElement.dataset.tornadoCountry!=='Spain')return;
  const input=document.getElementById('recaptchaToken');
  const storage=window.tornadoCountryStorage;
  if(!input||!storage||!window.tornadoRecaptcha)return;
  const initial=window.tornadoRecaptcha.initial;
  const legacy=storage.getItem('RecaptchaTokenValue');
  input.value=typeof initial==='string'?initial:(legacy||'');
  storage.setItem('RecaptchaTokenValue',input.value);
  let lastSaved=null;
  function save(){
    const value=input.value.trim();
    storage.setItem('RecaptchaTokenValue',value);
    if(value===lastSaved)return;
    lastSaved=value;
    window.tornadoRecaptcha.save(value).catch(()=>{lastSaved=null;input.setAttribute('title','Could not save. Change the value to retry.');});
  }
  input.addEventListener('input',save);
  input.addEventListener('change',save);
  document.getElementById('refreshRecaptcha')?.addEventListener('click',()=>setTimeout(save,0));
  window.addEventListener('beforeunload',save);
  if(typeof initial==='string'||legacy!==null)save();
})();

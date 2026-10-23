(() => {
  'use strict';
  const toggle=document.getElementById('autoDivideMinutesToggle');
  if(!toggle||!window.tornadoMinuteDivider)return;
  window.tornadoMinuteDivider.get().then(value=>{toggle.checked=value.enabled===true;}).catch(()=>{});
  toggle.addEventListener('change',async()=>{
    const requested=toggle.checked;toggle.disabled=true;
    try{const value=await window.tornadoMinuteDivider.set(requested);toggle.checked=value.enabled===true;}
    catch{toggle.checked=!requested;}
    finally{toggle.disabled=false;}
  });
})();

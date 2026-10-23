(() => {
  'use strict';
  const country=window.tornadoCountry.initial.country,native=window.localStorage;
  document.documentElement.dataset.tornadoCountry=country||'';
  const buckets={Mauritania:{accounts:'tornado.mauritania.accounts.v1',clients:'tornado.mauritania.clients.v1'},Spain:{accounts:'accounts',clients:'clients'},Portugal:{accounts:'tornado.portugal.accounts.v1',clients:'tornado.portugal.clients.v1'},SpainNew:{accounts:'tornado.spain-new.accounts.v1',clients:'tornado.spain-new.clients.v1'}};
  const scoped=new Set(Object.values(buckets).flatMap(Object.values)),aliases=['accounts','clients'];
  const mapped=key=>buckets[country]?.[key]||key;
  function visibleKeys(){const keys=[];for(let i=0;i<native.length;i++){const key=native.key(i);if(!scoped.has(key))keys.push(key);}if(buckets[country])for(const key of aliases)if(native.getItem(mapped(key))!==null)keys.push(key);return keys;}
  function authorize(key){if(aliases.includes(key)&&!buckets[country])throw Error('Choose SPAIN NEW, Portugal or Mauritania first');}
  function changed(key){if(key==='accounts')window.dispatchEvent(new Event('tornado-accounts-changed'));}
  window.tornadoCountryStorage=Object.freeze({
    getItem:key=>{key=String(key);return aliases.includes(key)&&!buckets[country]?null:native.getItem(mapped(key));},
    setItem:(key,value)=>{key=String(key);authorize(key);native.setItem(mapped(key),String(value));changed(key);},
    removeItem:key=>{key=String(key);authorize(key);native.removeItem(mapped(key));changed(key);},
    key:index=>visibleKeys()[index]??null,get length(){return visibleKeys().length;},
    clear(){for(const key of visibleKeys())native.removeItem(mapped(key));changed('accounts');}
  });
})();

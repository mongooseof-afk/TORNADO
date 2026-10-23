'use strict';
module.exports=deps=>{
 const morocco=require('./spain-new-adapter')(deps);
 const mauritania=require('./mauritania-main')({...deps,config:require('./mauritania-config.json')});
 return {accept:(ws,req)=>morocco.accept(ws,req)||mauritania.accept(ws,req)};
};

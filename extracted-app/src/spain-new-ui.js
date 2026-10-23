(() => {
  'use strict';
  const api=window.tornadoSpainNew,core=window.TornadoSpainNew;if(!api||!core||window.tornadoCountry?.initial.country!=='SpainNew')return;
  let syncTimer,last='',syncing=false,again=false;
  async function sync(){if(syncing){again=true;return;}syncing=true;
    try{const value=JSON.parse(window.localStorage.getItem('tornado.spain-new.accounts.v1')||'[]'),serialized=JSON.stringify([core.accounts(value),value.map(a=>[a.email,a['app-password']||''])]);if(serialized!==last){await api.publish(value);last=serialized;}}
    catch{/* Keep the last valid new-site account snapshot if its JSON cannot be read. */}
    finally{syncing=false;if(again){again=false;sync();}}
  }
  const queue=()=>{clearTimeout(syncTimer);syncTimer=setTimeout(sync,100);};
  window.addEventListener('storage',queue);window.addEventListener('tornado-accounts-changed',queue);
  const accounts=document.getElementById('accounts-container');if(accounts)new MutationObserver(queue).observe(accounts,{childList:true,subtree:true});sync();
  // Operational notices stay out of the Launcher interface.
  if(window.tornadoCountry?.initial.country!=='SpainNew')return;
  document.documentElement.classList.add('tornado-spain-new');
  const settings=document.getElementById('settings-section'),controls=settings.querySelector('.controls');
  const status=document.createElement('p');status.id='spain-new-status';status.setAttribute('role','status');status.className='spain-new-status';status.hidden=true;controls.after(status);
  const definitions=[['login','Go Login','loginBtn'],['retry','Retry all','startBtn'],['drafts','Delete Appointments','reloginBtn']];
  for(const[key,label,original]of definitions){const button=document.createElement('button');button.type='button';button.className=document.getElementById(original).className;button.textContent=label;button.dataset.spainNewControl=key;
    button.addEventListener('click',async()=>{button.disabled=true;try{if(key==='retry')await api.retryAll();else await api.open(key);}catch{/* Keep command failures out of transient UI. */}finally{status.textContent='';button.disabled=false;}});controls.append(button);
  }
  const item=document.createElement('div');item.className='toggle-item';item.dataset.spainNewOption='auto-login';const label=document.createElement('span');label.className='toggle-label';label.textContent='Auto Login';
  const toggle=document.createElement('label');toggle.className='toggle-switch';const input=document.createElement('input');input.type='checkbox';input.id='spainNewAutoLogin';
  const slider=document.createElement('span');slider.className='toggle-slider';toggle.append(input,slider);item.append(label,toggle);document.getElementById('primary').prepend(item);
  input.addEventListener('change',async()=>{const desired=input.checked;input.disabled=true;try{const state=await api.auto(desired);input.checked=state.enabled;status.textContent='';}catch{input.checked=!desired;status.textContent='Could not change Auto Login.';}finally{input.disabled=false;}});
  const retryItem=item.cloneNode(true),retryInput=retryItem.querySelector('input');retryItem.dataset.spainNewOption='retry-calendar';retryInput.id='spainNewRetryCalendar';retryItem.querySelector('.toggle-label').textContent='Auto Retry Calendar';item.after(retryItem);
  retryInput.addEventListener('change',async()=>{const desired=retryInput.checked;retryInput.disabled=true;try{const state=await api.retry(desired);retryInput.checked=state.retryEnabled===true;status.textContent='';}catch{retryInput.checked=!desired;status.textContent='Could not change Auto Retry Calendar.';}finally{retryInput.disabled=false;}});
  const flowInputs={};let flowState=core.flow();
  for(const [key,name]of [['account','Auto Account Page'],['booking','Auto Book Appointment'],['calendar','Auto Submit Calendar'],['autoCancelDrafts','Auto Cancel Appointments']]){const row=item.cloneNode(true),check=row.querySelector('input');row.dataset.spainNewOption=key;check.id='spainNewFlow_'+key;row.querySelector('.toggle-label').textContent=name;retryItem.before(row);flowInputs[key]=check;check.addEventListener('change',async()=>{const desired=check.checked;check.disabled=true;try{if(key==='booking')await api.booking(desired);else flowState=await api.flow({...flowState,[key]:desired});}catch{check.checked=!desired;}finally{check.disabled=false;}});}
  const dateRow=document.createElement('div');dateRow.dataset.spainNewOption='date-selection';dateRow.className='spain-new-policy';dateRow.innerHTML='<fieldset><legend>Date Selection :</legend><select id="spainNewDateMode"><option value="random">Random</option><option value="first">First</option><option value="last">Last</option></select></fieldset>';document.getElementById('primary').append(dateRow);const dateMode=dateRow.querySelector('select');dateMode.addEventListener('change',async()=>{try{flowState=await api.flow({...flowState,dateMode:dateMode.value});}catch{dateMode.value=flowState.dateMode;}});
  const advanced=document.createElement('div');advanced.dataset.spainNewOption='booking-settings';advanced.className='filters-div';advanced.innerHTML='<div class="filters"><div class="form-group"><select id="spainNewCentre" class="filter"></select><label for="spainNewCentre">Centre</label></div><div class="form-group"><select id="spainNewVisa" class="filter"></select><label for="spainNewVisa">Visa Type</label></div></div><div class="filters"><div class="form-group"><select id="spainNewMembers" class="filter"></select><label for="spainNewMembers">Members</label></div><div class="log-controls"><button type="button" class="control-btn btn-submit">Update</button></div></div>';document.getElementById('advanced').append(advanced);const centre=advanced.querySelector('#spainNewCentre'),visa=advanced.querySelector('#spainNewVisa'),members=advanced.querySelector('#spainNewMembers');const options=(el,values)=>{for(const value of values){const o=document.createElement('option');o.value=value;o.textContent=value||'From applicant';el.append(o);}};options(centre,core.origin.includes('mauritania')?['Nouadhibou']:['','Casablanca','Tangier','Nador','Agadir','Rabat','Tetouan']);options(visa,['','Schengen Visa','National Visa']);options(members,['1','2','3','4','5']);const savedKey='tornado.spain-new.advanced.v1';advanced.querySelector('button').onclick=async()=>{try{flowState=await api.flow({...flowState,centre:centre.value,visa:visa.value,members:Number(members.value)});localStorage.setItem(savedKey,JSON.stringify({centre:flowState.centre,visa:flowState.visa,members:flowState.members}));status.textContent='Saved';setTimeout(()=>{if(status.textContent==='Saved')status.textContent='';},2000);}catch(e){status.textContent=e.message;}};api.state().then(async state=>{try{const saved=JSON.parse(localStorage.getItem(savedKey)||'{}');if(Object.keys(saved).length)await api.flow({...core.flow(state.flow),...saved});}catch{}});
  const syncFlow=state=>{flowState=core.flow(state.flow);flowInputs.autoCancelDrafts.checked=flowState.autoCancelDrafts;flowInputs.account.checked=flowState.account;flowInputs.calendar.checked=flowState.calendar;flowInputs.booking.checked=state.bookEnabled===true;dateMode.value=flowState.dateMode;centre.value=flowState.centre;visa.value=flowState.visa;members.value=String(flowState.members);};api.state().then(syncFlow).catch(()=>{});api.onState?.(syncFlow);
  const policyBox=document.createElement('div');policyBox.dataset.spainNewOption='retry-policy';policyBox.className='spain-new-policy';policyBox.innerHTML='<fieldset><legend>On Max Attempts :</legend><select id="spainNewOnMax"><option value=""></option><option value="new-app">New App</option><option value="proxy">Switch Proxy</option></select></fieldset><label>Delay (seconds) : <input id="spainNewRetryDelay" type="number" min="1" max="120" placeholder="1-120"></label><label>Attempts (value) : <input id="spainNewAttempts" type="number" min="1" max="999" placeholder="1-999"></label>';
  document.getElementById('others').append(policyBox);const delay=policyBox.querySelector('#spainNewRetryDelay'),max=policyBox.querySelector('#spainNewAttempts'),action=policyBox.querySelector('select');
  function displayPolicy(value){const v=core.policy(value);max.value=v.maxAttempts||'';delay.value=v.delaySeconds??'';action.value=v.onMax;}
  async function savePolicy(){try{const value=await api.policy({maxAttempts:max.value,onMax:action.value,delaySeconds:delay.value});localStorage.setItem('tornado.spain-new.retry-policy.v1',JSON.stringify(value));displayPolicy(value);status.textContent='';}catch(e){status.textContent=e.message||'Invalid Retry options.';}}
  delay.addEventListener('change',savePolicy);max.addEventListener('change',savePolicy);action.addEventListener('change',savePolicy);
  try{const saved=core.policy(JSON.parse(localStorage.getItem('tornado.spain-new.retry-policy.v1')||'{}'));displayPolicy(saved);api.policy(saved).catch(()=>{});}catch{}
  const syncProxies=async()=>{try{const value=await window.electronAPI?.getProxies();await api.proxies(Array.isArray(value)?value:typeof value==='string'?value.split(/\r?\n/):value?.proxies||[]);}catch{}};syncProxies();setInterval(syncProxies,3000);
  api.onState?.(state=>{input.checked=state.enabled===true;retryInput.checked=state.retryEnabled===true;if(state.policy){localStorage.setItem('tornado.spain-new.retry-policy.v1',JSON.stringify(core.policy(state.policy)));if(document.activeElement!==delay&&document.activeElement!==max&&document.activeElement!==action)displayPolicy(state.policy);}});
  api.state().then(state=>retryInput.checked=state.retryEnabled===true).catch(()=>{});
  api.state().then(state=>input.checked=state.enabled).catch(()=>{});
  const themeRow=document.getElementById('darkModeToggle')?.closest('.toggle-item');if(themeRow)themeRow.dataset.spainNewOption='launcher-theme';

  let secState=core.schedule(),restorePending=true,scheduleDirty=false,scheduleBusy=false,scheduleNotice='';
  const secRow=item.cloneNode(true),secToggle=secRow.querySelector('input');secRow.dataset.spainNewOption='retry-sec';secToggle.id='spainNewRetrySec';secRow.querySelector('.toggle-label').textContent='Auto Retry Calendar /Sec';retryItem.after(secRow);
  // Use the same two-column card and Set/Stop colors as the legacy Timing tab.
  // Separate IDs keep the new-site scheduler away from legacy IPC handlers.
  const timing=document.createElement('div');timing.className='automation-panel spain-new-timing';timing.dataset.spainNewTiming='retry-sec';
  timing.innerHTML='<div class="spain-new-scheduler"><h3>Retry Calendar Scheduler /delay</h3><input type="time" id="spainNewRetryTime" step="0.001" aria-label="Start time (device local)" aria-describedby="spainNewScheduleHelp"><input type="number" id="spainNewProfileDelay" min="0" max="60000" step="1" placeholder="delay in ms" aria-label="Delay between profiles in milliseconds" aria-describedby="spainNewScheduleHelp"><button type="button" class="control-btn btn-submit" id="spainNewScheduleSet">Set</button><button type="button" class="control-btn" id="spainNewScheduleStop">Stop</button><p id="spainNewScheduleHelp">Device time · First start, then every minute.</p><p id="spainNewScheduleStatus" role="status" aria-live="polite"></p></div>';
  document.getElementById('timing-section').append(timing);
  const secTime=timing.querySelector('input[type=time]'),profileDelay=timing.querySelector('input[type=number]'),secStatus=timing.querySelector('[role=status]');
  const setButton=timing.querySelector('#spainNewScheduleSet'),stopButton=timing.querySelector('#spainNewScheduleStop');
  const secFeedback=document.createElement('p'); // Detached: no operation messages below Settings toggles.
  for(const field of [secTime,profileDelay])for(const event of ['input','change'])field.addEventListener(event,()=>{scheduleDirty=true;field.removeAttribute('aria-invalid');if(scheduleNotice){scheduleNotice='';renderScheduleStatus();}});
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  secTime.title='Local device time: '+zone;
  function renderScheduleStatus(){
    const d=secState.nextAt?new Date(secState.nextAt):null;
    const next=d&&secState.enabled?'Next: '+d.toLocaleDateString('en-GB')+' '+d.toLocaleTimeString('en-GB',{hour12:false})+'.'+String(d.getMilliseconds()).padStart(3,'0')+' · '+zone:secState.enabled?'Enabled · No time configured':'Disabled';
    secStatus.textContent=scheduleNotice||next;
    secFeedback.textContent=scheduleNotice||(secState.enabled?next:'');
    timing.dataset.scheduleError=scheduleNotice?'true':'false';
  }
  function displaySchedule(value){
    secState={...core.schedule(value),nextAt:Number(value?.nextAt)||0};secToggle.checked=secState.enabled;
    if(!scheduleDirty&&document.activeElement!==secTime)secTime.value=secState.time;
    if(!scheduleDirty&&document.activeElement!==profileDelay)profileDelay.value=secState.profileDelayMs||'';
    if(!restorePending)localStorage.setItem('tornado.spain-new.retry-sec.v1',JSON.stringify(secState));
    renderScheduleStatus();
  }
  function openTiming(){
    document.querySelector('.nav-item[data-section="timing"]')?.click();
    // Also activate the requested tab explicitly: native navigation may still
    // be finishing its initial setup when the user first enables this option.
    document.querySelectorAll('#app-content > .content-section').forEach(section=>section.classList.toggle('active',section.id==='timing-section'));
    document.querySelectorAll('.nav-item').forEach(nav=>nav.classList.toggle('active',nav.dataset.section==='timing'));
    secTime.focus();
  }
  async function setSchedule(enabled,restart=true){
    if(scheduleBusy)return;
    // Enabling without a time is allowed. The scheduler remains idle until Set
    // supplies a time; no default clock tick or automatic request is created.
    let desired;
    try{desired=core.schedule(enabled?{enabled:true,time:secTime.value,profileDelayMs:profileDelay.value,anchorAt:restart?0:secState.anchorAt}:{...secState,enabled:false});}
    catch(e){secToggle.checked=secState.enabled;scheduleNotice=e.message||'Check the schedule values.';status.textContent=scheduleNotice;if(!secTime.value)secTime.setAttribute('aria-invalid','true');else profileDelay.setAttribute('aria-invalid','true');renderScheduleStatus();openTiming();return;}
    scheduleBusy=true;secToggle.disabled=setButton.disabled=stopButton.disabled=true;scheduleNotice='';secStatus.textContent='Saving…';secFeedback.textContent='Saving…';
    try{const value=await api.schedule(desired);scheduleDirty=false;displaySchedule(value);status.textContent='';}
    catch(e){secToggle.checked=secState.enabled;scheduleNotice=e.message||'Could not update schedule. Try again.';status.textContent=scheduleNotice;renderScheduleStatus();}
    finally{scheduleBusy=false;secToggle.disabled=setButton.disabled=stopButton.disabled=false;}
  }
  secToggle.addEventListener('change',()=>setSchedule(secToggle.checked));
  setButton.onclick=()=>setSchedule(true);
  stopButton.onclick=()=>{scheduleNotice='';return setSchedule(false,false);};
  api.onState?.(value=>{if(value.schedule)displaySchedule(value.schedule);});
  try{const saved=core.schedule(JSON.parse(localStorage.getItem('tornado.spain-new.retry-sec.v1')||'{}'));api.schedule(saved).then(value=>{restorePending=false;displaySchedule(value);},()=>{restorePending=false;});}catch{restorePending=false;}

})();

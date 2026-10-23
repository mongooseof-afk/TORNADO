(() => {
  'use strict';
  let mode='light';try{if(window.localStorage.getItem('tornado.launcher.theme.v1')==='dark')mode='dark';}catch{}
  document.documentElement.classList.toggle('dark-mode',mode==='dark');
  document.documentElement.dataset.launcherTheme=mode;
})();

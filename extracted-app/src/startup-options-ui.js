// Reset option flags; keep accounts, credentials and the saved Recaptcha value.
(() => {
  'use strict';
  for (const key of ['status-submit','status-submit-rt','status-submit-vt','notif-sound-status']) window.tornadoCountryStorage.removeItem(key);
  window.tornadoCountryStorage.setItem('theme','light');
  for (const input of document.querySelectorAll('input[type="checkbox"]')) input.checked = false;
})();

(() => {
  'use strict';
  if (!window.tornadoLocalServices) return;
  let busy = false, connected = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const states = await window.tornadoLocalServices.get();
      const ready = ['windows', 'timer', 'captcha'].every(name => states[name]?.state === 'ready');
      const log = document.getElementById('activityLog');
      if (ready && !connected && log) {
        const now = new Date(), pad = (n, digits = 2) => String(n).padStart(digits, '0');
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}:${pad(now.getMilliseconds(), 3)} | Online Server Connected ✅`;
        log.prepend(entry);
        connected = true;
      } else if (!ready) connected = false;
    } catch { /* An IPC timeout is not a service-state transition. */ }
    finally { busy = false; }
  }
  void refresh();
  const timer = setInterval(refresh, 2000);
  window.addEventListener('pagehide', () => clearInterval(timer), {once: true});
})();

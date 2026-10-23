'use strict';
(() => {
  function bind(toggleId, inputId, statusId, api) {
    const toggle = document.getElementById(toggleId);
    const input = document.getElementById(inputId);
    const status = document.getElementById(statusId);
    if (!toggle || !input || !api) return;
    let ready = false, queue = Promise.resolve();
    const report = text => { if (status) status.textContent = text; };
    input.disabled = toggle.disabled = true;
    api.get().then(value => {
      toggle.checked = value.enabled === true;
      input.value = value.delaySeconds === 2 ? '' : String(value.delaySeconds);
      ready = true;
      input.disabled = toggle.disabled = false;
    }).catch(() => report('Could not load reload settings. Reopen Settings.'));
    function save() {
      if (!ready) return;
      const delaySeconds = input.value.trim() === '' ? 2 : Number(input.value);
      if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 120) {
        input.setCustomValidity('Enter 1–120 seconds, or leave empty for 2 seconds.');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      const value = {enabled: toggle.checked, delaySeconds};
      // Each controller has its own queue, input and API. Rapid edits cannot
      // restore older settings or overwrite the other controller's delay.
      queue = queue.catch(() => {}).then(() => api.set(value))
        .then(() => report(''))
        .catch(() => report('Could not apply reload setting. Try again.'));
    }
    toggle.addEventListener('change', save);
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('change', save);
  }
  bind('autoReloadErrorToggle', 'errorReloadDelaySeconds', 'errorOccurredReloadStatus', window.tornadoErrorReload);
  bind('siteErrorReloadToggle', 'siteErrorReloadDelaySeconds', 'siteErrorReloadStatus', window.tornadoSiteError);
})();

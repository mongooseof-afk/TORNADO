/* Optional CaptchaAI key. Local CAPTCHA runs first. */
(function () {
  'use strict';
  if (document.documentElement.dataset.tornadoCountry === 'Portugal') return;
  var FIELDS = [
    { ls: 'captchaai-key', inputId: 'captchaAIKey', label: 'CaptchaAI Key', defaultVal: '',
      saveAction: 'captchaai-key', testAction: 'captchaai-test', replyType: 'CAPTCHAAI_TEST' }
  ];
  function makeGroup(cfg, prev) {
    var wrap = document.createElement('div');
    wrap.className = 'recaptcha-group';
    wrap.style.marginTop = '12px';
    var input = document.createElement('input');
    input.type = 'text';
    input.id = cfg.inputId;
    input.placeholder = ' ';
    input.autocomplete = 'off';
    var label = document.createElement('label');
    label.htmlFor = cfg.inputId;
    label.textContent = cfg.label;
    var btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'recaptcha-refresh';
    btnSave.title = 'Save ' + cfg.label;
    btnSave.innerHTML = '<i class="fas fa-save"></i>';
    var btnTest = document.createElement('button');
    btnTest.type = 'button';
    btnTest.className = 'recaptcha-refresh';
    btnTest.title = 'Test ' + cfg.label;
    btnTest.style.marginLeft = '6px';
    btnTest.innerHTML = '<i class="fas fa-plug"></i>';
    var status = document.createElement('span');
    status.style.cssText = 'display:block;font-size:11px;margin-top:4px;opacity:.9;';
    wrap.appendChild(input);
    wrap.appendChild(label);
    wrap.appendChild(btnSave);
    wrap.appendChild(btnTest);
    wrap.appendChild(status);
    prev.parentNode.insertBefore(wrap, prev.nextSibling);
    return { input: input, btnSave: btnSave, btnTest: btnTest, status: status };
  }
  function inject() {
    var group = document.querySelector('.recaptcha-group');
    if (!group || document.getElementById('captchaAIKey')) return;
    var ws = null;
    function ensureWs() {
      return new Promise(function (resolve) {
        if (ws && ws.readyState === 1) return resolve(ws);
        try {
          ws = new WebSocket('ws://localhost:8080/key?key=fe337f955f9decd2f9e09b8361841d8a');
          ws.onopen = function () { resolve(ws); };
          ws.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }
    function send(obj) { ensureWs().then(function (s) { if (s) s.send(JSON.stringify(obj)); }); }

    var prev = group;
    FIELDS.forEach(function (cfg) {
      var ui = makeGroup(cfg, prev);
      prev = ui.input.parentNode;
      var saved = window.tornadoCountryStorage.getItem(cfg.ls) || cfg.defaultVal || '';
      if (saved) {
        ui.input.value = saved;
        try { window.tornadoCountryStorage.setItem(cfg.ls, saved); } catch (e) {}
      }

      ui.btnSave.addEventListener('click', function () {
        var v = ui.input.value.trim();
        try { window.tornadoCountryStorage.setItem(cfg.ls, v); } catch (e) {}
        send({ type: 'COMMAND', action: cfg.saveAction, data: v, timestamp: Date.now() });
        ui.status.style.color = '';
        ui.status.textContent = v ? cfg.label + ' saved (' + v.slice(0, 8) + '...)' : cfg.label + ' cleared';
      });

      ui.btnTest.addEventListener('click', function () {
        var v = ui.input.value.trim();
        if (!v) { ui.status.style.color = '#e57373'; ui.status.textContent = 'enter a key first'; return; }
        ui.status.style.color = '';
        ui.status.textContent = 'Testing...';
        send({ type: 'COMMAND', action: cfg.testAction, data: v, timestamp: Date.now() });
        var to = setTimeout(function () { ui.status.style.color = '#e57373'; ui.status.textContent = 'test timed out'; }, 25000);
        var h = function (ev) {
          try {
            var m = JSON.parse(ev.data);
            if (m.type !== cfg.replyType) return;
            clearTimeout(to);
            ws.removeEventListener('message', h);
            ui.status.style.color = m.ok ? '#4caf50' : '#e57373';
            if (m.ok) {
              ui.status.textContent = cfg.label + ' OK' + (m.balance !== undefined ? ' — balance: $' + m.balance : '') + (m.days !== undefined ? ' — valid ' + m.days + 'd' : '');
            } else {
              ui.status.textContent = cfg.label + ' error: ' + m.error;
            }
          } catch (e) {}
        };
        ensureWs().then(function (s) { if (s) s.addEventListener('message', h); });
      });

      if (saved) {
        send({ type: 'COMMAND', action: cfg.saveAction, data: saved, timestamp: Date.now() });
        ui.status.textContent = cfg.label + ' loaded';
      }
    });
    console.log('[Tornado] optional CaptchaAI field ready');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();

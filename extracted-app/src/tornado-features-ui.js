(() => {
  'use strict';
  const form = document.getElementById('addAccountForm');
  const accountList = document.getElementById('accounts-container');
  if (!form || !accountList) return;
  const emailInput = form.querySelector('input[name="email"]');
  if (!emailInput) return;
  const warning = document.createElement('div');
  warning.id = 'tornado-duplicate-email-warning';
  warning.setAttribute('role', 'alert');
  warning.textContent = 'that email already saved';
  warning.style.cssText = 'display:none;color:#d32f2f;font-size:12px;font-weight:700;margin:5px 0 0;';
  emailInput.parentElement.appendChild(warning);
  const normalize = value => String(value || '').trim().toLowerCase();
  const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const fromRenderedAccounts = () => {
    const result = new Set((accountList.textContent.match(emailPattern) || []).map(normalize));
    for (const node of accountList.querySelectorAll('input[type="email"], [data-email]')) {
      const email = normalize(node.value || node.getAttribute('data-email'));
      if (email) result.add(email);
    }
    return result;
  };
  // The legacy manager persists account rows in browser storage. Only account-named keys are read.
  const fromSavedAccounts = () => {
    const result = new Set();
    try { const rows=JSON.parse(window.tornadoCountryStorage.getItem('accounts')||'[]');for(const row of Array.isArray(rows)?rows:[]) {const email=normalize(row?.email||row?.Email);if(email)result.add(email);} } catch {}
    return result;
  };
  const duplicate = () => {
    const email = normalize(emailInput.value);
    return !!email && (fromRenderedAccounts().has(email) || fromSavedAccounts().has(email));
  };
  const update = () => {
    const exists = duplicate();
    warning.style.display = exists ? 'block' : 'none';
    emailInput.style.borderColor = exists ? '#d32f2f' : '';
    emailInput.style.color = exists ? '#d32f2f' : '';
    emailInput.setCustomValidity(exists ? 'that email already saved' : '');
    return exists;
  };
  const clearWarning = () => {
    warning.style.display = 'none';
    emailInput.style.borderColor = '';
    emailInput.style.color = '';
    emailInput.setCustomValidity('');
  };
  emailInput.addEventListener('input', update);
  const popup = document.getElementById('addAccountPopup');
  document.getElementById('cancelAccountPopup')?.addEventListener('click', clearWarning);
  document.getElementById('add-account')?.addEventListener('click', () => queueMicrotask(() => {
    if (emailInput.value.trim()) update();
    else clearWarning();
  }));
  if (popup) new MutationObserver(() => {
    if (!popup.classList.contains('active') && getComputedStyle(popup).display === 'none') clearWarning();
  }).observe(popup, { attributes: true, attributeFilter: ['class', 'style'] });
  form.addEventListener('submit', event => {
    if (!update()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    emailInput.reportValidity();
    emailInput.focus();
  }, true);
  new MutationObserver(() => { if (document.activeElement === emailInput) update(); }).observe(accountList, { childList: true, subtree: true, characterData: true });
})();

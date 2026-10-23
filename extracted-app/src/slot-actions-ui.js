(() => {
  const buttons = [document.getElementById('superRefreshBtn'), document.getElementById('changeDaysBtn'), document.getElementById('clearDaysBtn'), document.getElementById('stopInVisaTypeBtn'), document.getElementById('submitPreSlotBtn'), document.getElementById('reloadSessionBtn')];
  const status = document.getElementById('slotActionStatus');
  const submitSlot = document.getElementById('submitBtn');
  const controlled = [...buttons, submitSlot].filter(Boolean);
  async function send(action) {
    controlled.forEach(b => { b.disabled = true; });
    try {
      const result = await window.mongooseSlotActions.run(action);
      status.textContent = result.sent > 0
        ? (result.unsupported ? `${result.unsupported} profiles need the new extension.` : '')
        : result.message;
    } catch (error) { status.textContent = `Could not send command: ${error.message}`; }
    finally { setTimeout(() => controlled.forEach(b => { b.disabled = false; }), 1500); }
  }
  buttons.forEach((button, index) => button.addEventListener('click', () => {
    void send(['refresh', 'change-day', 'clear-days', 'submit-visatype', 'submit-pre-slot', 'reload-session'][index]);
  }));
  // Stop the old mixed submit handler before target/delegated listeners run.
  window.addEventListener('click', event => {
    if (!event.target.closest?.('#submitBtn')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!submitSlot?.disabled) void send('submit-slot');
  }, true);
})();

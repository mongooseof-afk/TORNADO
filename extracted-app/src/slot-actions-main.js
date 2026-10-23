'use strict';
module.exports = function install({ ipcMain, browserClients, WebSocket, getWindow, crypto, getCountry }) {
  let lastCommandAt = 0;
  ipcMain.handle('mongoose-slot-action', (event, action) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      throw new Error('Invalid sender');
    if (!['refresh', 'change-day', 'clear-days', 'submit-pre-slot', 'submit-slot', 'reload-session', 'submit-visatype'].includes(action)) throw new Error('Invalid action');
    const now = Date.now();
    if (now - lastCommandAt < 1500) return { sent: 0, message: 'Please wait before sending another command.' };
    lastCommandAt = now;
    const command = { type: 'MONGOOSE_SLOT_ACTION', id: crypto.randomUUID(), action, executeAt: ['submit-visatype', 'submit-pre-slot', 'submit-slot'].includes(action) ? now : now + 1000 };
    let sent = 0, unsupported = 0;
    for (const ws of new Set(browserClients.values())) {
      if (ws.readyState !== WebSocket.OPEN || ws.country !== getCountry()) continue;
      if ((ws.mongooseSlotActions || 0) < (action === 'submit-visatype' ? 5 : action === 'reload-session' ? 4 : 3)) { unsupported++; continue; }
      try { ws.send(JSON.stringify(command)); sent++; } catch { /* Disconnected during dispatch. */ }
    }
    return { sent, unsupported, message: sent
      ? `Sent to ${sent} connected profiles. Only eligible BLS tabs will run.`
      : 'No compatible connected profile. Load the latest Tornado extension and reconnect.' };
  });
};

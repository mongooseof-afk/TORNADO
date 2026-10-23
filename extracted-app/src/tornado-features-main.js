'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

module.exports = function install({ ipcMain, browserClients, WebSocket, getWindow }) {
  let enabled = false;
  let loaded = false;
  const settingsFile = () => path.join(app.getPath('userData'), 'tornado-browser-theme.json');
  const ensureLoaded = () => {
    if (loaded) return;
    // Start disabled on every launch, regardless of the last saved preference.
    enabled = false;
    loaded = true;
  };
  const frame = () => JSON.stringify({ type: 'TORNADO_BROWSER_DARK_MODE', enabled });
  const send = ws => { if (ws?.readyState === WebSocket.OPEN) try { ws.send(frame()); } catch { /* A profile disconnected. */ } };
  const sync = ws => { ensureLoaded(); send(ws); };
  const current = () => { ensureLoaded(); return enabled; };
  ipcMain.handle('tornado-browser-theme-get', event => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid sender');
    return current();
  });
  ipcMain.handle('tornado-browser-theme-set', (event, value) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || typeof value !== 'boolean') throw new Error('Invalid theme request');
    ensureLoaded();
    const next = value;
    fs.writeFileSync(settingsFile(), JSON.stringify({ enabled: next }), { encoding: 'utf8', mode: 0o600 });
    enabled = next;
    for (const ws of new Set(browserClients.values())) send(ws);
    return enabled;
  });
  return { sync, current };
};

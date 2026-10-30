'use strict';
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
let mainWindow;
let serverModule;

async function createWindow() {
  const configPath = path.join(app.getPath('userData'), 'server.json');
  let savedServer = '';
  try { savedServer = JSON.parse(fs.readFileSync(configPath, 'utf8')).serverUrl || ''; } catch {}
  const remoteServer = String(process.env.MESSENGER_SERVER_URL || savedServer || '').trim().replace(/\/$/, '');
  let appUrl;
  if (remoteServer) {
    if (!/^https:\/\//i.test(remoteServer)) throw new Error('MESSENGER_SERVER_URL должен начинаться с https://');
    appUrl = remoteServer;
  } else {
    process.env.MESSENGER_DATA_DIR = path.join(app.getPath('userData'), 'data');
    serverModule = require('./backend/server');
    const port = await serverModule.startServer(0);
    appUrl = `http://127.0.0.1:${port}`;
  }
  mainWindow = new BrowserWindow({
    width: 1240, height: 820, minWidth: 760, minHeight: 560,
    title: 'Мессенджер', backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) shell.openExternal(url); return { action: 'deny' }; });
  await mainWindow.loadURL(appUrl);
  mainWindow.on('closed', () => { mainWindow = null; });
}
app.whenReady().then(createWindow).catch(err => { console.error(err); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error); });

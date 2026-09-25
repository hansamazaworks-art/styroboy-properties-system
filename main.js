'use strict';

const { app, BrowserWindow, Menu, dialog, shell, clipboard, ipcMain } = require('electron');
const os = require('os');
const path = require('path');
const { start } = require('./server');

const DEFAULT_PORT = Number(process.env.PORT) || 8843;

let mainWindow = null;
let httpServer = null;
let boundPort = null;

/* All non-internal, non-loopback IPv4 addresses this machine has on the
   LAN. Usually just one, but laptops with Wi-Fi + Ethernet can have two. */
function lanAddresses(){
  const nets = os.networkInterfaces();
  const out = [];
  for(const name of Object.keys(nets)){
    for(const net of nets[name] || []){
      if(net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

async function startServerWithFallback(preferredPort){
  // Packaged builds run app/ and server.js from a read-only asar archive,
  // so the shared data file has to live in Electron's writable per-user
  // data folder instead of next to server.js.
  const dataDir = path.join(app.getPath('userData'), 'data');
  let port = preferredPort;
  for(let attempt = 0; attempt < 10; attempt++){
    try{
      const server = await start(port, dataDir);
      return { server, port, dataDir };
    }catch(err){
      if(err && err.code === 'EADDRINUSE'){ port += 1; continue; }
      throw err;
    }
  }
  throw new Error('Could not find a free port after 10 attempts.');
}

function networkSummary(port){
  const addrs = lanAddresses();
  const urls = addrs.length
    ? addrs.map(a => `http://${a}:${port}`)
    : ['(no network address found — this machine may not be connected to a LAN)'];
  return { addrs, urls };
}

function buildMenu(port){
  const { urls } = networkSummary(port);
  const template = [
    {
      label: 'Styroboy Properties',
      submenu: [
        {
          label: 'Show LAN Address…',
          click: () => showAddressDialog(port)
        },
        {
          label: 'Copy LAN Address',
          enabled: urls.length > 0 && !urls[0].startsWith('('),
          click: () => { clipboard.writeText(urls[0]); }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAddressDialog(port){
  const { urls } = networkSummary(port);
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Styroboy Properties — Network Address',
    message: 'Other devices on this network can open:',
    detail: urls.join('\n') +
      '\n\nThis computer is the host — keep this app running for other devices to stay in sync. ' +
      'They just need a web browser; nothing needs to be installed on them.',
    buttons: ['OK', 'Copy address']
  }).then(result => {
    if(result.response === 1 && urls.length && !urls[0].startsWith('(')) clipboard.writeText(urls[0]);
  });
}

async function createWindow(){
  const { server, port } = await startServerWithFallback(DEFAULT_PORT);
  httpServer = server;
  boundPort = port;

  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#EFF3F8',
    title: 'Styroboy Properties — Property Operations',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(`http://localhost:${port}`);

  // Keep external links (there are none by default, but just in case)
  // opening in the system browser rather than inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    const { urls } = networkSummary(port);
    mainWindow.setTitle(
      `Styroboy Properties — Property Operations   ·   LAN: ${urls[0] || 'not connected'}`
    );
    // First-run convenience: surface the address once at launch so the
    // host operator immediately knows what to give everyone else.
    showAddressDialog(port);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* Native printing for statements/receipts, invoked from the renderer via
   preload's printAPI. We print through Electron's own print pipeline
   (rather than window.print() inside the page) so we can force
   margins.marginType 'none', which removes Chromium's default page
   header/footer (title, URL, date, page number) — no "file:///…" line
   at the bottom of printed documents. */
ipcMain.handle('app:print-html', (_evt, html) => {
  return new Promise((resolve, reject) => {
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true }
    });
    printWin.webContents.once('did-finish-load', () => {
      printWin.webContents.print(
        { silent: false, printBackground: true, margins: { marginType: 'none' } },
        (success, reason) => {
          printWin.close();
          if(!success && reason !== 'cancelled') reject(new Error(reason));
          else resolve(success);
        }
      );
    });
    printWin.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html));
  });
});

/* Lets the Settings page show the LAN address on demand, now that the
   top menu bar (which used to host "Show LAN Address…") is gone. */
ipcMain.handle('app:show-lan-address', () => {
  if(boundPort != null) showAddressDialog(boundPort);
});

app.whenReady().then(createWindow).catch(err => {
  dialog.showErrorBox('Failed to start', String(err && err.message || err));
  app.quit();
});

app.on('window-all-closed', () => {
  if(process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if(BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if(httpServer){ try{ httpServer.close(); }catch(e){} }
});

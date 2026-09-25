/*
 * The app talks to its data purely over fetch() to the local server
 * (see server.js / app/index.html). The one privileged feature exposed
 * here is native printing for statements/receipts — routed through the
 * main process so headers/footers (and the "file:///…" line they add)
 * can be switched off, which isn't possible from window.print() alone.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printAPI', {
  printHTML: (html) => ipcRenderer.invoke('app:print-html', html)
});

contextBridge.exposeInMainWorld('networkAPI', {
  showLanAddress: () => ipcRenderer.invoke('app:show-lan-address')
});

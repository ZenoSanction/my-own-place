/*  My Own Place — Preload Script
    ─────────────────────────────
    Runs in a privileged context between the main process and the renderer.
    Exposes a strictly typed API via contextBridge so the renderer never
    gets direct access to Node.js or Electron internals.

    Changes from v1.0:
    • Added 'ping' so the renderer can test IPC connectivity at startup.
*/

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Shorthand: invoke a named IPC channel with optional arguments
const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {

  // ── Connectivity test ───────────────────────────────────────────────────────
  // Called by init() before anything else.  If this times out the main process
  // is not responding and we show a meaningful error instead of a hung spinner.
  ping: () => invoke('ping'),

  // ── Config ──────────────────────────────────────────────────────────────────
  config: {
    get:    ()        => invoke('config:get'),
    set:    updates   => invoke('config:set', updates),
    verify: password  => invoke('config:verify', password),
  },

  // ── Window controls ─────────────────────────────────────────────────────────
  win: {
    minimize:  () => invoke('win:minimize'),
    maximize:  () => invoke('win:maximize'),
    close:     () => invoke('win:close'),
    maximized: () => invoke('win:maximized'),
  },

  // ── Servers ─────────────────────────────────────────────────────────────────
  server: {
    start:  () => invoke('server:start'),
    stop:   () => invoke('server:stop'),
    status: () => invoke('server:status'),
  },

  // ── Network ─────────────────────────────────────────────────────────────────
  network: {
    ip:       () => invoke('network:ip'),
    publicip: () => invoke('network:publicip'),
  },

  // ── File system (scoped to wwwRoot) ─────────────────────────────────────────
  fs: {
    list:    rel              => invoke('fs:list',   rel),
    read:    rel              => invoke('fs:read',   rel),
    write:   (rel, content)   => invoke('fs:write',  rel, content),
    delete:  rel              => invoke('fs:delete', rel),
    mkdir:   rel              => invoke('fs:mkdir',  rel),
    rename:  (oldRel, newRel) => invoke('fs:rename', oldRel, newRel),
    upload:  (name, b64, dir) => invoke('fs:upload', name, b64, dir),
    wwwroot: ()               => invoke('fs:wwwroot'),
  },

  // ── Access log ──────────────────────────────────────────────────────────────
  log: {
    get:    limit => invoke('log:get',    limit),
    clear:  ()    => invoke('log:clear'),
    export: ()    => invoke('log:export'),
    stats:  ()    => invoke('log:stats'),
  },

  // ── Templates ───────────────────────────────────────────────────────────────
  templates: {
    list:    ()  => invoke('templates:list'),
    preview: id  => invoke('templates:preview', id),
    apply:   id  => invoke('templates:apply',   id),
  },

  // ── Shell / dialogs ─────────────────────────────────────────────────────────
  shell: {
    open:       url => invoke('shell:open',    url),
    openFolder: p   => invoke('shell:folder',  p),
    pickFolder: ()  => invoke('dialog:folder'),
  },

  // ── Auto-updater ────────────────────────────────────────────────────────────
  updater: {
    install: () => invoke('update:install'),
    onUpdateAvailable: cb => ipcRenderer.on('update:available', (_e, v) => cb(v)),
    onUpdateDownloaded: cb => ipcRenderer.on('update:downloaded', (_e, v) => cb(v)),
  },

});

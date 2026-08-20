import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  openPdf: () => ipcRenderer.invoke('dialog:open-pdf'),
  readFile: (path: string) => ipcRenderer.invoke('fs:read-file', path),
  saveFile: (name: string, content: string) => ipcRenderer.invoke('dialog:save-file', name, content),
  savePdf: (name: string, base64Data: string) => ipcRenderer.invoke('dialog:save-pdf', name, base64Data),
  savePdfInPlace: (path: string, base64Data: string) => ipcRenderer.invoke('fs:save-pdf-inplace', path, base64Data),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: object) => ipcRenderer.invoke('settings:save', settings),
  loadDigest: (fingerprint: string) => ipcRenderer.invoke('digest:load', fingerprint),
  saveDigest: (fingerprint: string, digest: object) => ipcRenderer.invoke('digest:save', fingerprint, digest),
  deleteDigest: (fingerprint: string) => ipcRenderer.invoke('digest:delete', fingerprint),

  // Menu events from main process
  onPdfOpened: (cb: (data: { path: string; name: string; data: string }) => void) => {
    ipcRenderer.on('pdf:opened', (_e, data) => cb(data));
  },
  onToggleSidebar: (cb: () => void) => {
    ipcRenderer.on('menu:toggle-sidebar', () => cb());
  },
  onZoomIn: (cb: () => void) => {
    ipcRenderer.on('menu:zoom-in', () => cb());
  },
  onZoomOut: (cb: () => void) => {
    ipcRenderer.on('menu:zoom-out', () => cb());
  },
  onZoomReset: (cb: () => void) => {
    ipcRenderer.on('menu:zoom-reset', () => cb());
  },
  onExportAnnotations: (cb: () => void) => {
    ipcRenderer.on('menu:export-annotations', () => cb());
  },
  onSavePdf: (cb: () => void) => {
    ipcRenderer.on('menu:save-pdf', () => cb());
  },
  onSavePdfAs: (cb: () => void) => {
    ipcRenderer.on('menu:save-pdf-as', () => cb());
  },
  onUndo: (cb: () => void) => {
    ipcRenderer.on('menu:undo', () => cb());
  },
  onRedo: (cb: () => void) => {
    ipcRenderer.on('menu:redo', () => cb());
  },
  onCopySelection: (cb: () => void) => {
    ipcRenderer.on('menu:copy-selection', () => cb());
  },
  onFind: (cb: () => void) => {
    ipcRenderer.on('menu:find', () => cb());
  },
});

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

// Each on* subscription returns an unsubscribe function so React effects can
// clean up (StrictMode mounts effects twice in development).
const subscribe = (channel: string) => (cb: (...args: any[]) => void) => {
  const listener = (_event: IpcRendererEvent, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
};

contextBridge.exposeInMainWorld('electronAPI', {
  openPdf: () => ipcRenderer.invoke('dialog:open-pdf'),
  // Only a real dropped File has a path. Page script cannot forge one.
  openDroppedPdf: (file: File) => {
    const filePath = webUtils.getPathForFile(file);
    return filePath ? ipcRenderer.invoke('pdf:open-dropped', filePath) : Promise.resolve(null);
  },
  saveFile: (name: string, content: string) => ipcRenderer.invoke('dialog:save-file', name, content),
  savePdf: (name: string, data: Uint8Array) => ipcRenderer.invoke('dialog:save-pdf', name, data),
  savePdfInPlace: (fileId: string, data: Uint8Array) => ipcRenderer.invoke('fs:save-pdf-inplace', fileId, data),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: object) => ipcRenderer.invoke('settings:save', settings),
  credentialStatus: () => ipcRenderer.invoke('settings:credential-status'),
  loadLibrary: (kind: string, key: string) => ipcRenderer.invoke('library:load', kind, key),
  saveLibrary: (kind: string, key: string, data: unknown) => ipcRenderer.invoke('library:save', kind, key, data),
  deleteLibrary: (kind: string, key: string) => ipcRenderer.invoke('library:delete', kind, key),
  userName: () => ipcRenderer.invoke('app:user-name'),
  embeddingStatus: () => ipcRenderer.invoke('embedding:status'),
  downloadEmbeddingModel: () => ipcRenderer.invoke('embedding:download'),
  loadEmbeddingModel: () => ipcRenderer.invoke('embedding:load'),
  onEmbeddingProgress: subscribe('embedding:progress'),

  // Menu events from main process
  onPdfOpened: subscribe('pdf:opened'),
  onToggleSidebar: subscribe('menu:toggle-sidebar'),
  onZoomIn: subscribe('menu:zoom-in'),
  onZoomOut: subscribe('menu:zoom-out'),
  onZoomReset: subscribe('menu:zoom-reset'),
  onExportAnnotations: subscribe('menu:export-annotations'),
  onSavePdf: subscribe('menu:save-pdf'),
  onSavePdfAs: subscribe('menu:save-pdf-as'),
  onUndo: subscribe('menu:undo'),
  onRedo: subscribe('menu:redo'),
  onCopySelection: subscribe('menu:copy-selection'),
  onFind: subscribe('menu:find'),
});

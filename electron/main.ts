import { app, BrowserWindow, ipcMain, dialog, Menu, safeStorage, session, shell } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { mergeSettingsApiKeys, splitSettingsApiKeys } from './credential-settings';

let mainWindow: BrowserWindow | null = null;

const DIST = path.join(__dirname, '../dist');
const PRELOAD = path.join(__dirname, 'preload.js');
const MAX_DIGEST_BYTES = 20 * 1024 * 1024;

// The renderer never receives a writable path. Every PDF the user opens through
// the dialog or a real drag-and-drop gets an opaque id, and in-place saves are
// only allowed for ids in this map. A compromised renderer can therefore not
// read or overwrite arbitrary files.
const grantedFiles = new Map<string, string>();
const fileIdsByPath = new Map<string, string>();

function createWindow() {
  const windowIcon = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../build/icon.png');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    icon: windowIcon,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(DIST, 'index.html'));
  }

  buildMenu();
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF…',
          accelerator: 'CmdOrCtrl+O',
          click: () => { void handleOpenPdf(); },
        },
        { type: 'separator' },
        {
          label: 'Save PDF',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save-pdf'),
        },
        {
          label: 'Save PDF As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu:save-pdf-as'),
        },
        { type: 'separator' },
        {
          label: 'Export Annotations…',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => mainWindow?.webContents.send('menu:export-annotations'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => mainWindow?.webContents.send('menu:undo'),
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => mainWindow?.webContents.send('menu:redo'),
        },
        { type: 'separator' },
        {
          label: 'Find in Document',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow?.webContents.send('menu:find'),
        },
        { type: 'separator' },
        { role: 'cut' },
        {
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          click: () => mainWindow?.webContents.send('menu:copy-selection'),
        },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle AI Sidebar',
          accelerator: 'CmdOrCtrl+\\',
          click: () => mainWindow?.webContents.send('menu:toggle-sidebar'),
        },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => mainWindow?.webContents.send('menu:zoom-in'),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => mainWindow?.webContents.send('menu:zoom-out'),
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow?.webContents.send('menu:zoom-reset'),
        },
        { type: 'separator' },
        // Developer tools stay out of packaged builds.
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as Electron.MenuItemConstructorOptions]),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'About',
      submenu: [
        {
          label: 'About Lexio',
          click: () => { void showAboutDialog(); },
        },
        {
          label: 'Open Original Repository',
          click: () => { void shell.openExternal('https://github.com/nikodemseb/lexio'); },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function readGrantedPdf(filePath: string) {
  const resolved = path.resolve(filePath);
  if (path.extname(resolved).toLowerCase() !== '.pdf') throw new Error('Only PDF files can be opened.');
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error('The selected path is not a file.');
  const buffer = await fs.readFile(resolved);

  // Windows and macOS file systems are case-insensitive by default, so the same
  // file opened with different casing keeps one id and one tab.
  const key = process.platform === 'linux' ? resolved : resolved.toLowerCase();
  let id = fileIdsByPath.get(key);
  if (!id) {
    id = randomUUID();
    fileIdsByPath.set(key, id);
    grantedFiles.set(id, resolved);
  }
  return {
    id,
    name: path.basename(resolved),
    // Copy into a standalone buffer: a view over Node's shared pool would
    // serialize the whole pool across IPC.
    data: new Uint8Array(buffer),
    fingerprint: createHash('sha256').update(buffer).digest('hex'),
    canSaveInPlace: true,
  };
}

async function handleOpenPdf() {
  if (!mainWindow) return;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    try {
      mainWindow.webContents.send('pdf:opened', await readGrantedPdf(result.filePaths[0]));
    } catch (error: any) {
      dialog.showErrorBox('Could not open PDF', error?.message || String(error));
    }
  }
}

function safeDefaultName(name: unknown, fallback: string): string {
  return typeof name === 'string' && name.trim() ? path.basename(name) : fallback;
}

async function writeAtomically(target: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, data);
  await fs.rename(temporary, target);
}

// ─── IPC Handlers ───

ipcMain.handle('dialog:open-pdf', async () => {
  await handleOpenPdf();
});

// The preload resolves a dropped File to its path with webUtils. A synthetic
// File built by page script has no path, so only real drops reach this handler.
ipcMain.handle('pdf:open-dropped', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || !filePath) return null;
  return readGrantedPdf(filePath);
});

ipcMain.handle('dialog:save-file', async (_event, defaultName: unknown, content: unknown) => {
  if (!mainWindow || typeof content !== 'string') return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: safeDefaultName(defaultName, 'annotations.json'),
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'Markdown', extensions: ['md'] },
    ],
  });
  if (!result.canceled && result.filePath) {
    await fs.writeFile(result.filePath, content, 'utf-8');
    return result.filePath;
  }
  return null;
});

ipcMain.handle('dialog:save-pdf', async (_event, defaultName: unknown, data: unknown) => {
  if (!mainWindow || !(data instanceof Uint8Array)) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: safeDefaultName(defaultName, 'document.pdf'),
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });
  if (!result.canceled && result.filePath) {
    await writeAtomically(result.filePath, data);
    return result.filePath;
  }
  return null;
});

ipcMain.handle('fs:save-pdf-inplace', async (_event, fileId: unknown, data: unknown) => {
  const target = typeof fileId === 'string' ? grantedFiles.get(fileId) : undefined;
  if (!target || !(data instanceof Uint8Array)) return false;
  try {
    await writeAtomically(target, data);
    return true;
  } catch {
    return false;
  }
});

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function showAboutDialog(): Promise<void> {
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: 'About Lexio',
    message: `Lexio ${app.getVersion()}`,
    detail: [
      'An AI-native desktop PDF reader with page-aware document retrieval, multi-document tabs, annotations, and configurable cloud or local language models.',
      '',
      'Original project and repository:',
      'Nikodem Zymla (nikodemseb)',
      'https://github.com/nikodemseb/lexio',
      '',
      'Current v1.x development: Mehdi Sadeghi',
      'License: MIT',
    ].join('\n'),
    buttons: ['Close', 'Open Repository'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (result.response === 1) {
    await shell.openExternal('https://github.com/nikodemseb/lexio');
  }
}

function credentialsPath(): string {
  return path.join(app.getPath('userData'), 'credentials.json');
}

// On Linux without a keyring, Electron falls back to the "basic_text" backend,
// which encrypts with a hardcoded password. Keys are still saved, but the
// Settings panel warns the user that they are not really protected.
function credentialStatus(): { persistent: boolean; weak: boolean } {
  const persistent = safeStorage.isEncryptionAvailable();
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : '';
  return { persistent, weak: persistent && backend === 'basic_text' };
}

async function loadEncryptedApiKeys(): Promise<Record<string, string>> {
  if (!safeStorage.isEncryptionAvailable()) return {};
  try {
    const stored = JSON.parse(await fs.readFile(credentialsPath(), 'utf-8')) as {
      version?: number;
      keys?: Record<string, string>;
    };
    const result: Record<string, string> = {};
    for (const [providerId, encrypted] of Object.entries(stored.keys || {})) {
      try {
        result[providerId] = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch {
        // Ignore a credential that cannot be decrypted for this OS user.
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function saveEncryptedApiKeys(apiKeys: Readonly<Record<string, string>>): Promise<void> {
  const nonEmptyKeys = Object.fromEntries(Object.entries(apiKeys).filter(([, value]) => value));
  if (Object.keys(nonEmptyKeys).length === 0) {
    await fs.unlink(credentialsPath()).catch(() => {});
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) return;
  const encrypted = Object.fromEntries(Object.entries(nonEmptyKeys).map(([providerId, apiKey]) => [
    providerId,
    safeStorage.encryptString(apiKey).toString('base64'),
  ]));
  await writeAtomically(credentialsPath(), JSON.stringify({ version: 1, keys: encrypted }, null, 2));
}

ipcMain.handle('settings:load', async () => {
  let settings: unknown = null;
  try {
    settings = JSON.parse(await fs.readFile(settingsPath(), 'utf-8'));
  } catch {}
  const apiKeys = await loadEncryptedApiKeys();
  if (!settings && Object.keys(apiKeys).length === 0) return null;
  return mergeSettingsApiKeys(settings, apiKeys);
});

ipcMain.handle('settings:save', async (_event, settings: unknown) => {
  const separated = splitSettingsApiKeys(settings);
  await saveEncryptedApiKeys(separated.apiKeys);
  await writeAtomically(settingsPath(), JSON.stringify(separated.settings, null, 2));
});

ipcMain.handle('settings:credential-status', () => credentialStatus());

async function digestPath(fingerprint: unknown): Promise<string> {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('Invalid document fingerprint');
  }
  const directory = path.join(app.getPath('userData'), 'digests');
  await fs.mkdir(directory, { recursive: true });
  return path.join(directory, `${fingerprint.toLowerCase()}.json`);
}

ipcMain.handle('digest:load', async (_event, fingerprint: unknown) => {
  try {
    return JSON.parse(await fs.readFile(await digestPath(fingerprint), 'utf-8'));
  } catch {
    return null;
  }
});

ipcMain.handle('digest:save', async (_event, fingerprint: unknown, digest: unknown) => {
  const serialized = JSON.stringify(digest);
  if (typeof serialized !== 'string' || serialized.length > MAX_DIGEST_BYTES) {
    throw new Error('Digest is too large to cache.');
  }
  await writeAtomically(await digestPath(fingerprint), serialized);
});

ipcMain.handle('digest:delete', async (_event, fingerprint: unknown) => {
  try {
    await fs.unlink(await digestPath(fingerprint));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
});

// Per-document data (extracted text, notes, chats, embeddings, OCR results),
// stored as one JSON file per kind and key in the app data folder. Keys are
// SHA-256 file hashes (or a hash of several for chats spanning documents),
// so the renderer can never choose a path.
const LIBRARY_KINDS = new Set(['text', 'notes', 'chats', 'cards', 'embeddings', 'ocr']);
const MAX_LIBRARY_BYTES = 80 * 1024 * 1024;

async function libraryPath(kind: unknown, key: unknown): Promise<string> {
  if (typeof kind !== 'string' || !LIBRARY_KINDS.has(kind)) throw new Error('Invalid data kind');
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid document key');
  const directory = path.join(app.getPath('userData'), 'library', kind);
  await fs.mkdir(directory, { recursive: true });
  return path.join(directory, `${key.toLowerCase()}.json`);
}

ipcMain.handle('library:load', async (_event, kind: unknown, key: unknown) => {
  try {
    return JSON.parse(await fs.readFile(await libraryPath(kind, key), 'utf-8'));
  } catch {
    return null;
  }
});

ipcMain.handle('library:save', async (_event, kind: unknown, key: unknown, data: unknown) => {
  const serialized = JSON.stringify(data);
  if (typeof serialized !== 'string' || serialized.length > MAX_LIBRARY_BYTES) {
    throw new Error('Document data is too large to save.');
  }
  await writeAtomically(await libraryPath(kind, key), serialized);
});

ipcMain.handle('library:delete', async (_event, kind: unknown, key: unknown) => {
  try {
    await fs.unlink(await libraryPath(kind, key));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
});

// ─── Navigation and window hardening ───

app.on('web-contents-created', (_event, contents) => {
  // Links such as "Get key" open in the user's browser, never in an Electron
  // window that could inherit the preload bridge.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    const current = contents.getURL().split('#')[0];
    if (url.split('#')[0] !== current) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

// ─── Lifecycle ───

app.whenReady().then(() => {
  // Only clipboard writes are needed (copy buttons). Camera, microphone,
  // notifications, geolocation and the rest are always refused.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

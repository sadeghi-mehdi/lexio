import { app, BrowserWindow, ipcMain, dialog, Menu, safeStorage, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { mergeSettingsApiKeys, splitSettingsApiKeys } from './credential-settings';

let mainWindow: BrowserWindow | null = null;

const DIST = path.join(__dirname, '../dist');
const PRELOAD = path.join(__dirname, 'preload.js');

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
      sandbox: false,
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
          click: () => handleOpenPdf(),
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
        { role: 'toggleDevTools' },
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

async function handleOpenPdf() {
  if (!mainWindow) return;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    const buffer = fs.readFileSync(filePath);
    const data = buffer.toString('base64');
    mainWindow.webContents.send('pdf:opened', {
      path: filePath,
      name: path.basename(filePath),
      data,
    });
  }
}

// ─── IPC Handlers ───

ipcMain.handle('dialog:open-pdf', async () => {
  await handleOpenPdf();
});

ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
  const buffer = fs.readFileSync(filePath);
  return buffer.toString('base64');
});

ipcMain.handle('dialog:save-file', async (_event, defaultName: string, content: string) => {
  if (!mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'Markdown', extensions: ['md'] },
    ],
  });
  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return result.filePath;
  }
  return null;
});

ipcMain.handle('dialog:save-pdf', async (_event, defaultName: string, base64Data: string) => {
  if (!mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });
  if (!result.canceled && result.filePath) {
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(result.filePath, buffer);
    return result.filePath;
  }
  return null;
});

ipcMain.handle('fs:save-pdf-inplace', async (_event, filePath: string, base64Data: string) => {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);
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

function loadEncryptedApiKeys(): Record<string, string> {
  if (!safeStorage.isEncryptionAvailable()) return {};
  try {
    const stored = JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8')) as {
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

function saveEncryptedApiKeys(apiKeys: Readonly<Record<string, string>>): void {
  const nonEmptyKeys = Object.fromEntries(Object.entries(apiKeys).filter(([, value]) => value));
  if (Object.keys(nonEmptyKeys).length === 0) {
    try { fs.unlinkSync(credentialsPath()); } catch {}
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) return;
  const encrypted = Object.fromEntries(Object.entries(nonEmptyKeys).map(([providerId, apiKey]) => [
    providerId,
    safeStorage.encryptString(apiKey).toString('base64'),
  ]));
  const target = credentialsPath();
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, keys: encrypted }, null, 2), 'utf-8');
  fs.renameSync(temporary, target);
}

ipcMain.handle('settings:load', async () => {
  let settings: unknown = null;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch {}
  const apiKeys = loadEncryptedApiKeys();
  if (!settings && Object.keys(apiKeys).length === 0) return null;
  return mergeSettingsApiKeys(settings, apiKeys);
});

ipcMain.handle('settings:save', async (_event, settings: unknown) => {
  const separated = splitSettingsApiKeys(settings);
  saveEncryptedApiKeys(separated.apiKeys);
  const target = settingsPath();
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(separated.settings, null, 2), 'utf-8');
  fs.renameSync(temporary, target);
});

function digestPath(fingerprint: string): string {
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Error('Invalid document fingerprint');
  const directory = path.join(app.getPath('userData'), 'digests');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${fingerprint.toLowerCase()}.json`);
}

ipcMain.handle('digest:load', async (_event, fingerprint: string) => {
  try {
    return JSON.parse(fs.readFileSync(digestPath(fingerprint), 'utf-8'));
  } catch {
    return null;
  }
});

ipcMain.handle('digest:save', async (_event, fingerprint: string, digest: object) => {
  const target = digestPath(fingerprint);
  const temporary = `${target}.tmp`;
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  fs.writeFileSync(temporary, JSON.stringify(digest, null, 2), 'utf-8');
  if (fs.existsSync(target)) fs.unlinkSync(target);
  fs.renameSync(temporary, target);
});

ipcMain.handle('digest:delete', async (_event, fingerprint: string) => {
  try {
    fs.unlinkSync(digestPath(fingerprint));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
});

// ─── Lifecycle ───

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

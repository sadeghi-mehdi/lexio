import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';
import fs from 'fs';

// Content-Security-Policy for built pages. Scripts, workers and fonts load only
// from the app itself, so a malicious PDF or model answer cannot pull in code.
// connect-src must stay open to http(s) because users configure their own AI
// endpoints (including Ollama on another machine). 'wasm-unsafe-eval' lets the
// bundled embedding runtime compile its WebAssembly; it does not allow eval or
// scripts from anywhere else. The development server is left without a CSP
// because Vite injects inline scripts for hot reload.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' https: http:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// pdf.js needs its character maps and standard fonts at runtime. In
// development they are served from node_modules; the build copies them next
// to index.html (see src/utils/pdfjs.ts).
const pdfjsAssetsAndCsp: Plugin = {
  name: 'lexio-pdfjs-assets-and-csp',
  apply: 'build',
  transformIndexHtml: () => [{
    tag: 'meta',
    attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
    injectTo: 'head-prepend',
  }],
  writeBundle(options) {
    const outDir = options.dir || path.resolve(__dirname, 'dist');
    for (const folder of ['cmaps', 'standard_fonts']) {
      fs.cpSync(
        path.resolve(__dirname, 'node_modules/pdfjs-dist', folder),
        path.join(outDir, 'pdfjs', folder),
        { recursive: true }
      );
    }
    // The embedding runtime loads this file at run time (see embedding-client.ts).
    fs.mkdirSync(path.join(outDir, 'ort'), { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'),
      path.join(outDir, 'ort', 'ort-wasm-simd-threaded.wasm')
    );
  },
};

export default defineConfig({
  plugins: [
    react(),
    pdfjsAssetsAndCsp,
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist', 'onnxruntime-web'],
  },
  worker: {
    format: 'es',
  },
});

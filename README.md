<p align="center">
  <img src="src/assets/logo.svg" alt="Lexio" width="80" height="80" />
</p>

<h1 align="center">Lexio</h1>

<p align="center">
  <strong>The AI-native PDF reader.</strong><br />
  Read, annotate, and ask AI about PDFs with page-aware document context.
</p>

<p align="center">
  <a href="#getting-started"><strong>Get Started</strong></a> &nbsp;&middot;&nbsp;
  <a href="#features"><strong>Features</strong></a> &nbsp;&middot;&nbsp;
  <a href="#ai-providers"><strong>AI Providers</strong></a> &nbsp;&middot;&nbsp;
  <a href="#change-catalog"><strong>Change Catalog</strong></a> &nbsp;&middot;&nbsp;
  <a href="#contributing"><strong>Contributing</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-8b7cf7?style=flat-square" alt="Platforms" />
  <img src="https://img.shields.io/badge/license-MIT-6c5ce7?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/electron-43-4834d4?style=flat-square&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/react-18-61dafb?style=flat-square&logo=react&logoColor=white" alt="React" />
</p>

<br />

<!-- Replace with an actual screenshot of your app -->
<!-- <p align="center">
  <img src="docs/screenshot.png" alt="Lexio in action" width="900" />
</p> -->

---

## Why Lexio?

Reading a PDF, copying a passage, switching to ChatGPT, pasting context, and explaining what you need — that workflow should be **one click**.

Lexio embeds AI directly into the reading experience. Select text for a focused question, or ask about the document and let the reusable page index retrieve the relevant original pages. No application switching or manual context pasting is required.

---

## Features

### PDF Reader
- Smooth rendering powered by **PDF.js** with zoom, scroll, and page navigation
- Character-precise **text selection** with professional overlay styling
- **Multi-color highlights** — yellow, green, blue, pink, orange
- **Underline** and **strikethrough** annotation tools
- **Comments** on any highlighted passage
- **Undo / Redo** for all annotation actions
- Export annotations to **JSON** or save directly into the **PDF**
- **Drag & drop** to open files
- **Ctrl+Scroll** zoom
- Full-document **Find** with `Ctrl/Cmd+F`, match navigation, and page highlighting

### AI Chat
- **One-click "Ask AI"** from the floating selection toolbar
- **Adaptive context** — selected-text questions stay focused, page-aware retrieval supplies relevant source pages, and whole-document requests use full or hierarchical context
- **Streaming responses** with real-time token rendering
- **Multiple conversations** per document
- Copy controls for both questions and AI responses
- **5 built-in providers** — bring your own API key, use an OpenAI-compatible institutional endpoint, or run locally

### Desktop App
- Native **macOS, Linux, and Windows** builds via Electron
- Keyboard shortcuts for everything
- Dark theme optimized for focused reading
- Resizable AI sidebar with conversation history
- Multiple PDF tabs with independent chats, page indexes, and viewer positions
- Page thumbnail sidebar for quick navigation

---

## AI Providers

Lexio ships with five providers out of the box. Use one — or all of them.

| Provider | Type | Default Model | Setup |
|----------|------|---------------|-------|
| **Ollama** | Local, free | `llama3.2` | Install [Ollama](https://ollama.com), run `ollama pull llama3.2` |
| **Claude** | Cloud API | `claude-sonnet-4` | [Get API key](https://console.anthropic.com/settings/keys) |
| **OpenAI** | Cloud API | `gpt-4o` | [Get API key](https://platform.openai.com/api-keys) |
| **Generic OpenAI-Compatible** | Custom endpoint | Endpoint-specific | Configure an API base URL and exact model ID; ASU users can follow the guide below |
| **Gemini** | Cloud API | `gemini-2.0-flash` | [Get API key](https://aistudio.google.com/app/apikey) |

> **Privacy first** — Ollama runs entirely on your machine. No data ever leaves your computer.

### ASU Research Computing API Setup

ASU Research Computing provides an OpenAI-compatible LLM gateway that can be used through Lexio's **Generic OpenAI-Compatible** provider. Access requires an eligible ASU Research Computing account and permission to use the AI LLM service.

#### Create an ASU API key

1. Sign in to the [ASU Research Computing Voyager portal](https://voyager.rc.asu.edu/profile?tab=llm-access) with your ASU account.
2. Open the **AI LLM** tab if the direct link does not select it automatically.
3. In **LLM API Access**, confirm that the displayed endpoint is:

   ```text
   https://openai.rc.asu.edu/v1
   ```

4. Under **API keys**, click **Create Key**.
5. Give the key a descriptive name, such as `Lexio`, and create it.
6. Copy the complete key when it is shown and store it securely. The portal may show only a masked version afterward. If a key is lost or exposed, rotate or replace it in Voyager.
7. Use the model catalog on the **AI LLM** page to copy the exact model ID available to your account. Availability can change, so use the ID shown in Voyager rather than a display name or an ID copied from an older guide.

> **Keep the key private.** Never put it in the Lexio source code, a `.env` file committed to Git, an issue, a screenshot, or a chat message. Lexio stores saved keys separately from ordinary settings using Electron's operating-system encryption.

#### Connect Lexio to ASU

1. Open Lexio and click the **Settings** icon in the top toolbar.
2. Select **Generic OpenAI-Compatible** from the provider list.
3. Turn **Enabled** on.
4. Set **API base URL** to `https://openai.rc.asu.edu/v1`.
5. Paste the ASU key into **API Key**.
6. Enter the exact Voyager model ID in **Model**. Generic endpoints accept custom model IDs, so the value must match the catalog exactly.
7. Optional: to use ASU for document indexing, select **Use Generic OpenAI-Compatible to build the reusable page index**. Leave the page-index model on the main model or enter another exact ASU model ID under **Custom model**.
8. Click **Save**, open a PDF, and send a short test question.

Common errors:

- **`400 Invalid model name`** — the model ID is unavailable, misspelled, or not enabled for your key. Copy a currently available ID from Voyager.
- **`401` or `403`** — verify the complete key, account access, and key status. Rotate the key if necessary.
- **Connection or endpoint error** — confirm the base URL includes `/v1` and uses `https://`.

---

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- *(Optional)* [Ollama](https://ollama.com) for local AI — no API key needed

### Install & Run

```bash
git clone https://github.com/nikodemseb/lexio.git
cd lexio
npm install
npm run dev
```

The app opens an Electron window with hot-reload. Edit any source file and see changes instantly.

### Configure AI

1. Click the **Settings** icon in the toolbar
2. Select a provider
3. For cloud providers — paste your API key and toggle **Enabled**
4. For Ollama — make sure the server is running (`ollama serve`)
5. Choose your model and start chatting

### Build for Distribution

```bash
npm run package          # Current platform
npm run package:linux    # AppImage + .deb
npm run package:mac      # .dmg
npm run package:win      # NSIS installer
```

Packages appear in the `release/` directory.

---

## Usage

### Workflow

1. **Open** a PDF — toolbar button, `Cmd/Ctrl+O`, or drag & drop
2. **Read** — scroll, zoom (`Ctrl+Scroll`), navigate pages
3. **Highlight** — pick a tool and color from the toolbar, then select text
4. **Ask AI** — select any passage, click **Ask AI** in the floating bar
5. **Chat** — follow up with more questions in the sidebar
6. **Save** — `Cmd/Ctrl+S` to save annotations into the PDF

### Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Open PDF | `Cmd/Ctrl + O` |
| Save PDF | `Cmd/Ctrl + S` |
| Save PDF As | `Cmd/Ctrl + Shift + S` |
| Undo | `Cmd/Ctrl + Z` |
| Redo | `Cmd/Ctrl + Shift + Z` |
| Toggle AI sidebar | `Cmd/Ctrl + \` |
| Zoom in / out | `Cmd/Ctrl + =` / `Cmd/Ctrl + -` |
| Reset zoom | `Cmd/Ctrl + 0` |
| Export annotations | `Cmd/Ctrl + Shift + E` |
| Find in document | `Cmd/Ctrl + F` |
| Send message | `Enter` |
| New line in chat | `Shift + Enter` |
| Next / previous PDF tab | `Ctrl + Tab` / `Ctrl + Shift + Tab` |
| Close active PDF tab | `Ctrl + W` |

---

## Architecture

```
lexio/
├── electron/
│   ├── main.ts              # Window management, menus, IPC handlers
│   └── preload.ts           # Secure context bridge
├── src/
│   ├── components/
│   │   ├── PDFViewer.tsx     # PDF.js rendering + text selection engine
│   │   ├── AISidebar.tsx     # Chat interface + conversation management
│   │   ├── Toolbar.tsx       # Tools, zoom, navigation, colors
│   │   ├── SettingsPanel.tsx # Provider configuration
│   │   ├── ThumbnailSidebar.tsx
│   │   ├── AnnotationsPanel.tsx
│   │   ├── SelectionActionBar.tsx
│   │   ├── CommentModal.tsx
│   │   └── WelcomeScreen.tsx
│   ├── providers/
│   │   └── ai-providers.ts  # Ollama, Claude, OpenAI, Gemini
│   ├── stores/
│   │   └── useStore.ts      # Zustand state (PDF, annotations, AI, UI)
│   ├── utils/
│   │   └── pdf-save.ts      # PDF annotation export
│   └── types.ts
├── vite.config.ts
└── package.json
```

### Design Decisions

| Choice | Rationale |
|--------|-----------|
| **PDF.js** | Battle-tested PDF rendering with text layer support |
| **Zustand** | Minimal boilerplate, excellent TypeScript DX |
| **Streaming** | All 4 providers use SSE for responsive real-time chat |
| **Page-aware context** | A reusable page index retrieves original source pages; explicit whole-document requests use complete or hierarchical context |
| **Relative rects** | Highlights stored as 0-1 fractions — zoom-independent by design |
| **Viewport math** | Text selection computed from PDF coordinates, not DOM — accurate at any zoom |

---

## Extending Lexio

### Adding a New AI Provider

Create a provider in `src/providers/ai-providers.ts`:

```typescript
const myProvider: AIProviderInterface = {
  async chat(messages, systemPrompt, config, signal, callbacks) {
    // 1. Make a streaming request to your API
    // 2. Parse the SSE / streaming response
    // 3. Call callbacks.onToken(text) for each chunk
    // 4. Call callbacks.onDone() when complete
  },
};
```

Then register it in `DEFAULT_PROVIDERS` in `src/types.ts`.

---

## Change Catalog

Lexio follows [Semantic Versioning](https://semver.org/). While the application remains in active pre-1.0 development, backward-compatible feature milestones increment the minor version and bug fixes increment the patch version. Version `1.0.0` is reserved for the first stable release. The entry matching the version in `package.json` is required; the automated test suite checks this, so every future version change must update this catalog before it can pass verification.

### v0.4.0 — Annotation and usability release

- Restored highlight, underline, strikethrough, and comment tools, including color selection and cross-page annotation creation.
- Added visible comment editing and annotation removal controls with undo/redo support.
- Corrected PDF tab rendering isolation, stale PDF.js work, page geometry, thumbnail selection, and page-counter synchronization.
- Centered the chat send/stop control using a fixed-size, layout-independent button container.
- Added bottom-aligned copy controls to both user messages and AI responses.
- Refined message copy controls to icon-only actions aligned beside the bottom of each chat bubble.
- Added provider-tab-specific page-index model selection with each provider's own presets, main-model fallback, custom model entry, and an explicit indexing-provider choice.
- Widened the Settings window to accommodate the provider-specific document-context layout.
- Changed drag selection from word-level to character-level precision and exposed all annotation actions in the selection toolbar.
- Added full-document Find with `Ctrl/Cmd+F`, automatic input focus, result navigation, exact-result scrolling, and a distinct active-match highlight.
- Removed the redundant filename label from the main toolbar; document names remain visible in tabs.
- Added an About application menu with the version, product description, original repository and developer attribution.
- Added a real enable/disable switch for Ollama and enforced disabled-provider status for chat and page indexing.
- Restricted `gemma4-e2b-it` to the Generic OpenAI-Compatible provider while preserving preset and custom model selection elsewhere.

### v0.3.0 — Multi-document workspace

- Added multiple PDF tabs with open, switch, close, and duplicate-document focusing behavior.
- Isolated viewer position, zoom, extracted text, annotations, chats, streaming state, and page indexes by document.
- Kept background AI responses attached to the PDF where they originated and canceled only the closed tab's request.
- Moved page-index status and controls from Settings into the active document interface.
- Displayed the exact provider and model used for AI responses.
- Added PDF-tab keyboard shortcuts and preserved extracted document state when revisiting a tab.

### v0.2.0 — Page-aware AI architecture

- Replaced the modified OpenAI configuration with the original OpenAI provider and added a separate Generic OpenAI-Compatible provider, defaulting to ASU Research Computing's endpoint.
- Added configurable context limits, custom instructions, document-aware retrieval, reusable per-page indexes, and hierarchical whole-document summarization.
- Changed Ask AI to send only the selected passage and improved multi-page text selection and clipboard behavior.
- Added resizable AI sidebar support and closable chat conversations.
- Added encrypted API-key storage through Electron's operating-system credential protection.
- Added Windows release icons, safer settings migration, provider/model attribution, and regression tests for context and retrieval behavior.

### v0.1.0 — Original prototype

- Original Lexio prototype by Nikodem Zymla (`nikodemseb`) with PDF.js viewing, text selection, highlighting, undo, AI chat, and Ollama support.
- Added OpenAI, Anthropic Claude, and Google Gemini provider integrations with streaming chat.
- Added annotation export and PDF saving through the Electron desktop application.
- Included the Japanese PDF text-rendering fix contributed by Moizumi.

## Contributing

Contributions are welcome! Here are some areas that could use help:

- [ ] Persistent annotation storage (save/load per PDF)
- [ ] Freehand drawing / ink annotations
- [ ] PDF form filling
- [ ] Full-text search within PDF
- [ ] Plugin system for custom AI tools
- [ ] i18n / localization

```bash
npm run dev        # Development with hot-reload
npm run build      # Production build
npm run package    # Create distributable
```

---

## Tech Stack

[Electron](https://electronjs.org) &middot; [React](https://react.dev) &middot; [TypeScript](https://typescriptlang.org) &middot; [Vite](https://vitejs.dev) &middot; [PDF.js](https://mozilla.github.io/pdf.js/) &middot; [pdf-lib](https://pdf-lib.js.org/) &middot; [Zustand](https://zustand-demo.pmnd.rs/) &middot; [Tailwind CSS](https://tailwindcss.com) &middot; [Lucide](https://lucide.dev)

## License

MIT — see [LICENSE](LICENSE) for details.

# Lexio AI workspace plan

Status: draft for review. Nothing here is implemented yet.

## Goal

One AI chat that works across all open PDFs:

- Retrieval that fits the model's real context size.
- Memory across follow-up questions.
- Clickable citations that can be checked against what was sent.
- Your highlights and notes as a strong signal.
- Annotations that other PDF readers can read and write too.
- Tools for literature review, comparison and gap finding.

## Decisions so far

| Topic | Decision |
|---|---|
| Chat scope | All open PDFs, up to a Settings limit (default 10, max 50). If more are open, the most recently viewed are included and you can swap others in. |
| Working set | Open tabs only. Saved projects can come later. |
| Embeddings | English-only model, downloaded on first use, checked against a SHA-256 hash. |
| OCR | Tesseract with English bundled. Vision-model re-OCR included. OCR is the last phase, since scanned PDFs are rare for you. |
| Deep mode (tools) | Opt-in toggle. |
| Cross-document analysis | Explicit button. |
| Chats | Saved to disk, per PDF, together with notes. |
| Annotations | Saved as standard PDF annotations that other readers understand (section 9). |
| Color labels | Yes, editable in Settings (section 6.3). |
| Flatten when saving | Yes, as an option, off by default. |
| Annotation author | Defaults to the computer's user name, editable in Settings. |
| Read-test files | 3 annotated papers supplied (see "Annotated test files"). |

Assumed until you say otherwise:

- Annotations made in other apps can be edited and deleted in Lexio. Drawings and shapes (ink, boxes, stamps) stay read-only.
- The unused `annotations` store field (point notes) becomes sticky notes, which other readers also use.
- Highlights get extra weight by default, with a Settings toggle.

## What the current code does (findings)

Retrieval and chat:

1. The tokenizer drops tokens shorter than 3 characters. "Table 3" loses the "3". In a test, a question about Table 3 ranked the Table 1 page first.
2. Chinese and Japanese queries match nothing, because a whole run of characters becomes one token.
3. Index-guided retrieval fills the budget in page order. The best page can be dropped while the status line still lists it.
4. The index scorers use a second, ASCII-only tokenizer with no stop words or plural handling.
5. Index and keyword scores are merged on different scales.
6. Chat retrieval only uses the newest question. Follow-ups lose their context.
7. Selected passages are not sent in the history, so "this" in a follow-up points to nothing.
8. The history has no size limit. Error and progress text is sent back as if it were an answer.
9. Chats belong to one tab. Text is only extracted in the tab being viewed.
10. Ollama gets no `num_ctx`, so a large prompt may be cut off without an error.
11. Claude is called with `max_tokens: 4096`. The page index JSON for a large chunk may not fit (not reproduced).

Annotations:

12. Save PDF draws highlights as flat shapes. Comment text is never written to the file, only a colored dot.
13. Notes live only in memory and are lost when the app closes. JSON export has no import.
14. Annotations made in other apps are drawn by pdf.js, but Lexio never reads their text.
15. Save maps positions with the page's MediaBox size. It ignores page rotation and CropBox offset, so highlights are probably misplaced on rotated or cropped pages. A test will confirm this.

## 1. Background document index

- **Shared document list:** a `documents` map in the store, keyed by file hash. Tabs point to a document. Chats no longer live inside tabs.
- **Background indexing:** a DocumentIndexer processes every open PDF one at a time. Steps:
  1. Extract text.
  2. OCR pages that need it (section 8).
  3. Rejoin hyphenated words.
  4. Read the outline, or detect headings from font size.
  5. Split into passages of about 1,500 characters at paragraph or sentence edges, never across a section boundary.
  6. Build the keyword index.
  7. Build embeddings (section 2).
- **Workers:** tokenizing and indexing run in a Web Worker.
- **Disk store:** everything is saved per file hash in the app data folder: index, embeddings, OCR text, notes and chats.
- **Tokenizer:**
  - Handles any language.
  - Keeps numbers and 2-letter all-caps words like "AI".
  - Splits Chinese/Japanese text into two-character pairs.
  - Handles hyphenated words (split parts plus the joined form).
  - One stop-word list and one light plural stemmer.
- **Budget:**
  - Context-size table per model, with an override in Settings.
  - Send `num_ctx` to Ollama.
  - Reserve room for output, history, notes and the system prompt.

## 2. Embeddings

- **Model:** a small English model (for example `all-MiniLM-L6-v2`, 384 dimensions).
  - Runs in a dedicated Web Worker with `onnxruntime-web`: WebGPU when available, WebAssembly otherwise.
  - `@huggingface/transformers` 4.x depends on the native modules `sharp` and `onnxruntime-node`. If that complicates the Electron build, use `onnxruntime-web` with a tokenizer package directly.
- **Download:** on first use, from a pinned URL, checked against a SHA-256 hash, and saved in the app data folder. Keyword search works until the download finishes.
- **Security policy:** add `'wasm-unsafe-eval'` to `script-src`. It allows compiling WebAssembly only. Scripts still load only from the app.
- **Other sources (optional):** Ollama, OpenAI or Gemini embeddings behind one `embed(texts)` interface. Saved vectors are keyed by embedding model.
- **Search:** compare the question against every passage directly. No vector database is needed at this scale.
- **Measure in phase 0:** model size, installer size change, and time to embed a 500-page report.

## 3. Retrieval router

| Question | What gets sent |
|---|---|
| All documents in scope fit | Full text of each, labeled `[D1 p.3]`. The document part stays identical across turns so provider prompt caching works. |
| Names a document (`@D2`, "the Smith paper") | Narrow the scope to that document, then use the paths below. |
| Specific fact | One search across all documents in scope, capped per document. |
| Comparison | Search each document separately, give each an equal share of the budget, include paper cards. |
| Synthesis, review or gaps | Cross-document analysis button (section 7). |
| About your markings ("my highlights", "what I marked") | Highlights and notes mode (section 6). |
| Deep mode on | Tool loop (section 5). |

- **Search:** keyword search plus embeddings, merged with reciprocal rank fusion (score = sum of 1 / (k + rank)). A third ranking list for highlights is added (section 6).
- **Budget packing:** add passages best-first, add neighboring passages, then show them grouped by document and in page order.
- **Always included:** a short list of documents in scope (label, name, page count, and outline if space allows).
- **Whole-document summaries:** built only when a broad question needs one, then cached.

## 4. Workspace chat, memory and citations

- **Chats:**
  - Conversations live at the top level, with a scope, document labels that never change (D1, D2, …), and messages.
  - Document chips and a "This PDF only" option above the input.
  - `@` mentions.
  - Selections keep their document and page.
- **Memory:**
  - The history drops error, progress and stopped messages.
  - Selected passages are included with their document and page.
  - User and assistant turns alternate.
  - History has its own budget. The newest turns are kept word for word and the oldest are dropped first.
- **Follow-ups:** detected from short questions, pronouns, "and / but / what about / why". The search then uses the new question plus the previous one, and the previous answer's passages carry over at lower priority.
- **Citations:**
  - Citations are written as `[D2 p.14]` for pages and `[D2 N7]` for notes.
  - Each becomes a chip that switches tab, scrolls, and briefly highlights the passage or note.
  - A chip is marked "not in the supplied text" if that page or note was not sent or returned by a tool.
  - OCR pages get a marker.
- **Saving:** chats are saved per PDF and restored when you reopen it. A chat spanning several PDFs is stored once, by the set of file hashes it uses.

## 5. Tools (deep mode)

- **Tools (read-only, local):**

  | Tool | Returns |
  |---|---|
  | `list_documents()` | labels, names, page counts, index and OCR status |
  | `get_outline(doc)` | sections with page ranges |
  | `search(query, docs?, k?)` | top passages; results flag highlighted text |
  | `read_pages(doc, from, to)` | page text with inline marks, capped per call |
  | `find_exact(doc?, phrase)` | exact matches, using the existing Find logic |
  | `get_notes(doc?, page?, color?, type?)` | highlights, comments and sticky notes |
  | `get_card(doc)` | the paper card, built on demand |

- **Loop:** call the model, run requested tools, append results, repeat. Limits: at most 8 steps and a total cap on characters read. Text streams as it arrives. Tool activity shows as short status lines. Every page a tool returns is recorded for citation checks.
- **Providers:** a new `chatWithTools` method per provider:
  - Anthropic: `tool_use` / `tool_result`.
  - OpenAI and compatible: `tool_calls` and `role: "tool"`.
  - Gemini: `functionCall` / `functionResponse`.
  - Ollama: `tools` and `message.tool_calls`.
  - A "supports tools" flag per model. If tools fail, fall back to the normal router automatically.
- **Safety:** PDF text is untrusted. All tools are read-only and local, so injected instructions can at most cause more reading. Never add tools that write files, use the network or change settings.

## 6. Highlights and notes as AI context

Your markings are a signal of what matters to you, not a claim about what is true. The design uses them to steer what the model reads and looks at. It never lets the model present your notes as the authors' words.

### 6.1 One note model

Every marking, from Lexio or another app, becomes:

```
{ id, docId, page, type, textRange, text, comment, color, author, source, createdAt, modifiedAt, replies[] }
```

- `type`: highlight, underline, strikeout, squiggly, sticky note, text box, ink or shape.
- `textRange`: character offsets into the page text. For Lexio highlights they are taken from the character boxes when you select. For imported annotations they are found by matching QuadPoints against those boxes. If the page text changes (for example after dehyphenation or OCR), the note is re-anchored by searching for its text.
- `source`: `lexio` or `file`.

### 6.2 Inline marks in the text the model sees

Wherever a passage containing a marking is sent (full text, retrieved passages, or tool results), the marked text is wrapped:

```
The results show <mark id="N7" color="yellow">rut depth doubled above 45 °C</mark> in all mixtures.
<note for="N7" by="you">Check if this holds for the modified binder.</note>
Earlier work <del id="N9">reported no temperature effect</del> [...]
```

- `<mark>` for highlights, `<u>` for underlines, `<del>` for strikethroughs. Comments follow as `<note>`.
- The system prompt explains:
  - Marked text is what you found important. Prefer it when answering and point it out.
  - `<del>` means you considered that text wrong, outdated or irrelevant. It is still the authors' text.
  - `<note>` is your own opinion. Never attribute it to the paper.

### 6.3 Extra weight in retrieval

- **Ranking:** a third ranking list, "passages overlapping your markings", is merged into rank fusion. Relevant highlighted passages then rise without drowning out better matches. Weights by type: highlight and underline highest, comment-only medium. Strikethrough adds no boost, but the passage still gets its `<del>` mark if sent.
- **Reserved share:** up to about 15% of the budget is held for highlighted passages that are relevant to the question, so they make it in even when slightly behind on keyword score.
- **Highlights index:** a compact list of all markings in scope goes at the top of the context, capped by budget. Example: `N7 D2 p.14 highlight: "rut depth doubled above 45 °C" · note: "Check if…"`. The model then knows what you marked even when that passage was not retrieved, and can ask for it in deep mode.
- **Settings:** "Give my highlights extra weight" (on by default).
- **Color labels:** each Lexio color gets an editable label. Starting defaults: yellow = important, green = use in my work, blue = method or definition, pink = disagree or question, orange = follow up. Labels are sent with each mark (`<mark color="pink" label="disagree">`) and can be used in questions ("list everything I marked as disagree"). Colors from other apps are matched to the nearest Lexio color for their label, but their exact color is kept in the file.

### 6.4 Other places

- **Highlights and notes mode:** "Summarize my highlights across all papers", "Turn my notes into an outline", "Which of my comments on D1 does D3 answer?"
- **Paper cards:** include a "your markings" section.
- **Cross-document analysis:** each per-document pass is told to pay attention to marked passages.
- **Chat controls:** "Include my notes" toggle next to the document chips, on by default. Notes go to a cloud provider only when you send a message, the same as document text.

## 7. Paper cards and cross-document analysis

- **Paper cards:** one model call per document, cached by file hash and model. Fields:
  - title, authors, year
  - question, method, data or sample
  - findings with pages
  - limitations, stated future work
  - your markings
- **Analyze across documents (button):**
  - Per-document pass: ask each document the question separately, with its full text if it fits, or its card plus retrieved passages if not.
  - Combine the per-document answers into one.
  - Shows progress and how many calls it will make.
- **Gap prompt:** separates gaps the authors state (cited) from topics none of the loaded papers cover. Never claims a gap in the whole field.
- **Tables:** render markdown tables in chat, with copy as markdown or CSV.

## 8. OCR (last phase)

- **Detection:** a page with almost no extracted text but visible content needs OCR.
- **Tesseract:** `tesseract.js` 7 in a Web Worker with English bundled. `workerPath`, `corePath` and `langPath` are set to local files, never a CDN. Pages are rendered at about 200-300 DPI. Results are cached per page with confidence scores.
- **Selectable text:** Tesseract's word boxes become the same character boxes `PDFViewer` uses. Selection, highlights, Ask AI and Find then work on scanned pages.
- **Vision-model re-OCR:** send page images to a vision-capable model for tables, equations and poor scans. Cloud use requires consent per document.
- **Later:** write the OCR text into the PDF as an invisible text layer.

## 9. Annotations other PDF readers understand

Target readers: Adobe Acrobat / Reader, macOS Preview, Chrome and Edge (PDFium), Firefox (pdf.js), Zotero, Okular / Evince (poppler), Foxit.

### 9.1 What Lexio writes

Standard annotation objects from the PDF specification (ISO 32000), replacing the current flat drawings:

| Lexio tool | PDF annotation |
|---|---|
| Highlight | `/Subtype /Highlight` |
| Underline | `/Subtype /Underline` |
| Strikethrough | `/Subtype /StrikeOut` |
| Comment on a marking | `/Contents` on that annotation, plus a linked `/Popup` |
| Sticky note | `/Subtype /Text` with `/Name /Comment` |

Each annotation includes:

- `/Rect`, and `/QuadPoints` in the order readers actually use (top-left, top-right, bottom-left, bottom-right per quad).
- `/C` color (RGB), `/CA` opacity, `/T` author (a new "Your name" setting), `/M` and `/CreationDate` as PDF dates, and `/F 4` (print flag).
- `/NM lexio-<id>`, so Lexio can recognize its own annotations later.
- An appearance stream (`/AP /N`), so every reader draws it the same way. Highlights use the Multiply blend mode, as Acrobat does, so the text stays readable.

Positions are converted with the page's viewport (`convertToPdfPoint`), which handles `/Rotate` and CropBox offsets. This fixes finding 15.

### 9.2 What Lexio reads

On open, `page.getAnnotations()` from pdf.js:

- Highlight, Underline, StrikeOut, Squiggly: the marked text is recovered from QuadPoints. Editable in Lexio.
- Text (sticky notes), FreeText (text boxes): editable.
- Replies (`/IRT`): shown as a thread under the note.
- Acrobat "replace text" (a StrikeOut grouped with a Caret): shown as a suggested replacement.
- Ink, Square, Circle, Line, Polygon, Stamp: listed with their comment, read-only.

Colors outside Lexio's 5 are kept exactly and shown with the nearest Lexio color.

### 9.3 Saving without damage

Saving still starts from the bytes the file was opened with, then applies the changes:

- New Lexio annotations are added.
- Edited annotations (Lexio's or another app's) are updated in place, found by their object reference, which is stable because we start from the original bytes. The appearance stream is regenerated if the color changed.
- Deleted annotations are removed from the page's `/Annots` list, together with their popup.
- Annotations Lexio did not touch are left exactly as they were.

Lexio no longer draws its own highlights on top of annotations pdf.js already renders. I still need to confirm the cleanest way to stop the double drawing in pdf.js. This is checked in the phase 4 spike.

Limits, shown to the user instead of failing silently:

- **Encrypted PDFs:** pdf-lib cannot write them. Notes stay in Lexio's own store, and the Save command explains why.
- **Digitally signed PDFs:** as far as I know pdf-lib rewrites the whole file instead of appending an update, which breaks the signature. Lexio warns before saving and offers Save As.
- **Optional "Flatten when saving":** draws markings into the page content for printing or sharing. Off by default.

### 9.4 Testing compatibility

- **Automated round trip in `npm test`:** write annotations with Lexio's code, read them back with pdf.js, and compare type, QuadPoints, color, comment, author and id. Include rotated and cropped test pages.
- **Rendering check:** render saved files with PDFium (`pypdfium2`, which I can install here) to confirm Chrome/Edge draw them. Poppler can be added if its tools can be installed here.
- **Manual check (needs you):** Acrobat Reader, macOS Preview and Zotero. I'd also like 3-5 PDFs annotated in those apps as read test fixtures.

## Annotated test files

Three Elsevier papers with annotations, checked with pdf.js and pdf-lib:

| File | Pages | Annotations | What they show |
|---|---|---|---|
| S0950061821038940 | 26 | 3 highlights (1 with a comment), 3 popups, 586 links | Saved as an appended update. No author. Unique ids (`/NM`) are UUIDs. The drawing uses a named form object (`MWFOForm`). |
| S2352340923007278 | 8 | 3 highlights (1 with a comment), 1 underline, 1 strikethrough, 5 popups, 43 links | Same app as the file above, with 2 appended updates. |
| S0262885616302153 | 17 | 1 highlight, 1 underline, 1 strikethrough, 3 popups, 189 links | A different app. It rewrote the whole file with compressed object streams. It records the author (`/T meesd`), a subject (`/Subj`) and a border, and draws highlights with the Multiply blend mode. |

What this confirms for the design:

- All files store the corners of each marked line as top-left, top-right, bottom-left, bottom-right. That is the order Lexio will write.
- Every markup has a linked `/Popup`. Its comment is duplicated on the parent annotation. Lexio reads the parent and keeps the popup linked when editing.
- The author can be missing. Lexio shows "unknown author" and never makes one up.
- Hundreds of link annotations sit in the same `/Annots` list. Saving must leave them untouched.
- A quick test recovered the marked words from the corner positions on all 11 markups. The edges were a character or two off because the test assumed equal-width characters. The app uses real per-character boxes and snaps to word edges.
- The recovered text contains line-break hyphens ("includ- ing"), which the hyphen fix in section 1 handles.

These papers are publisher content, so they are not committed to the repository. Tests in the repository use small generated PDFs that copy the same annotation structures. The real files are used for local checks only.

## Phases

| # | Phase | Main files |
|---|---|---|
| 0 | Test set (PDFs, about 30 questions with answer pages, some about highlights), speed measurements, pdf.js double-drawing spike | `tests/retrieval-eval.test.mjs`, `tests/fixtures/` |
| 1 | Background index, per-PDF disk store, model budget, Ollama `num_ctx` | new `text-index.ts`, `DocumentIndexer.tsx`, `workers/index-worker.ts`; `PDFViewer.tsx`, `useStore.ts`, `electron/main.ts`, `preload.ts` |
| 2 | Embeddings, rank fusion, retrieval router, budget packing | new `embeddings.ts`, `workers/embed-worker.ts`, `retrieval.ts`; `vite.config.ts` |
| 3 | Workspace chat, memory, citations, highlights and notes as AI context (section 6) | `useStore.ts`, `AISidebar.tsx`, new `chat-memory.ts`, `citations.ts`, `notes.ts`, `types.ts` |
| 4 | Annotations other readers understand: read, write, round trip, sticky notes, author setting (section 9) | `pdf-save.ts`, new `pdf-annotations.ts`, `PDFViewer.tsx`, `AnnotationsPanel.tsx`, `SettingsPanel.tsx` |
| 5 | Paper cards and cross-document analysis | new `paper-cards.ts`, `AISidebar.tsx` |
| 6 | Tools and deep mode | `ai-providers.ts`, new `tools.ts`, `AISidebar.tsx` |
| 7 | OCR: Tesseract, selectable OCR text, vision re-OCR | new `ocr.ts`, `workers/ocr-worker.ts`, `PDFViewer.tsx` |

Each phase is its own commit. Old page-index code is removed once phase 2 beats it on the test set.

## Done means

- `npm test` and `npm run build` pass.
- The new retrieval includes the right page at least as often as the current one on the test set. Embeddings stay only if they measurably help.
- Relevant highlighted passages make it into the context on the highlight questions in the test set.
- Annotations saved by Lexio read back identically with pdf.js, render in PDFium, and are confirmed by you in Acrobat, Preview and Zotero.
- Annotations from other apps in the fixtures are read, and edits to them survive a save.
- Tool-loop tests with a fake provider pass.
- The scanned test PDF can be searched and cited.
- The "Unreleased" entry in the README change list is updated.

## Risks

- **Store refactor:** tab switching copies about 30 fields. Tests will cover tab switching with a shared chat.
- **Annotation edge cases:** unusual PDFs (odd rotations, broken `/Annots` arrays, huge annotation counts). Lexio falls back to its own store and never writes a file it could not read back.
- **App size and speed:** embedding and OCR runtimes add size. Measured in phase 0.
- **Weak local models:** they handle tools, inline tags and strict citations poorly. Deep mode is opt-in, and invalid citations are marked.
- **Security policy:** `'wasm-unsafe-eval'` is a small, deliberate loosening.

## Open questions

1. Which apps made the three annotated test files? The first and third look like one app, the second a different one.

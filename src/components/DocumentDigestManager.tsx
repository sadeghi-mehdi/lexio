import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { isLocalProvider, providers } from '../providers/ai-providers';
import { useStore } from '../stores/useStore';
import type { ChatMessage, DigestTopic, PageRange } from '../types';
import { chunkDocument } from '../utils/document-context';
import {
  consolidateDigestFragments,
  completeDigestPageIndex,
  deleteCachedDigest,
  fingerprintPdf,
  loadCachedDigest,
  normalizeDigestFragment,
  parseJsonObject,
  saveCachedDigest,
  validateDocumentDigest,
  type DigestFragment,
} from '../utils/document-digest';

// Finished digest parts per document fingerprint. Switching tabs or providers
// aborts a running digest; when it restarts with the same provider, model and
// chunk size it continues from the first unfinished part.
const partialDigests = new Map<string, { key: string; fragments: DigestFragment[] }>();
import { requestProviderText } from '../utils/provider-request';

const DIGEST_SYSTEM_PROMPT = `You create a reusable, page-aware digest of PDF documents for later retrieval.
Return valid JSON only. Never use markdown fences. Every section and topic must retain accurate PDF page ranges from the supplied page labels. Do not invent headings or page numbers.`;

function fragmentPrompt(customInstructions: string): string {
  return `${DIGEST_SYSTEM_PROMPT}${customInstructions.trim()
    ? `\n\nUSER CUSTOM INSTRUCTIONS\n${customInstructions.trim()}\nEND USER CUSTOM INSTRUCTIONS`
    : ''}

Required JSON schema:
{
  "overview": "concise overview of these pages",
  "pages": [{
    "pageNumber": 1,
    "headings": ["headings or titles visibly present on this page"],
    "sectionTitle": "the section or appendix this page belongs to",
    "keywords": ["up to 20 specific retrieval keywords"],
    "description": "one or two sentences describing the page for retrieval"
  }],
  "sections": [{
    "title": "descriptive or detected section title",
    "startPage": 1,
    "endPage": 3,
    "summary": "methods, findings, quantitative results, limitations and recommendations",
    "keywords": ["specific retrieval terms"],
    "entities": ["named items"],
    "sectionType": "chapter|appendix|references|body|other"
  }],
  "topics": [{
    "name": "topic",
    "description": "what the pages say about it",
    "pageRanges": [{"startPage": 1, "endPage": 3}]
  }]
}

Include exactly one pages entry for every supplied page label. The pages entries are a search index only; make headings, section membership, keywords, and descriptions useful for locating the original page text.`;
}

function synthesisPrompt(customInstructions: string): string {
  return `${DIGEST_SYSTEM_PROMPT}${customInstructions.trim()
    ? `\n\nUSER CUSTOM INSTRUCTIONS\n${customInstructions.trim()}\nEND USER CUSTOM INSTRUCTIONS`
    : ''}

You are consolidating already-generated page-range summaries. Return JSON only:
{
  "overview": "cohesive whole-document overview",
  "topics": [{
    "name": "major topic",
    "description": "concise synthesis",
    "pageRanges": [{"startPage": 1, "endPage": 3}]
  }]
}`;
}

function normalizeSynthesis(raw: unknown, pageCount: number): { overview: string; topics: DigestTopic[] } {
  if (typeof raw !== 'object' || raw === null) return { overview: '', topics: [] };
  const source = raw as Record<string, unknown>;
  const overview = typeof source.overview === 'string' ? source.overview.trim() : '';
  const topics = (Array.isArray(source.topics) ? source.topics : [])
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((topic) => ({
      name: typeof topic.name === 'string' ? topic.name.trim() : '',
      description: typeof topic.description === 'string' ? topic.description.trim() : '',
      pageRanges: (Array.isArray(topic.pageRanges) ? topic.pageRanges : [])
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((range): PageRange => {
          const startPage = Math.max(1, Math.min(pageCount, Number(range.startPage) || 1));
          const endPage = Math.max(startPage, Math.min(pageCount, Number(range.endPage) || startPage));
          return { startPage, endPage };
        }),
    }))
    .filter((topic) => topic.name && topic.pageRanges.length > 0);
  return { overview, topics };
}

export default function DocumentDigestManager() {
  const abortRef = useRef<AbortController | null>(null);
  const lastRebuildRef = useRef(new Map<string, number>());
  // Only values that should restart the digest are subscribed to. Model
  // names are compared as strings, so editing an unrelated provider or
  // switching the chat provider (when the digest uses a fixed one) is ignored.
  const {
    activeDocumentTabId,
    hasPdf,
    documentSessionId,
    numPages,
    documentTextReady,
    digestRebuildToken,
    digestCancelToken,
    digestApproved,
    digestEnabled,
    digestAutoCloud,
    digestChunkChars,
    digestProviderId,
    digestModel,
    providerEnabled,
    providerIsLocal,
  } = useStore(useShallow((state) => {
    const { settings } = state;
    const providerId = settings.digestProvider === 'active' ? settings.activeProvider : settings.digestProvider;
    const baseConfig = settings.providers[providerId];
    return {
      activeDocumentTabId: state.activeDocumentTabId,
      hasPdf: Boolean(state.pdfFile),
      documentSessionId: state.documentSessionId,
      numPages: state.numPages,
      documentTextReady: state.documentTextReady,
      digestRebuildToken: state.digestRebuildToken,
      digestCancelToken: state.digestCancelToken,
      digestApproved: state.digestApproved,
      digestEnabled: settings.digestEnabled,
      digestAutoCloud: settings.digestAutoCloud,
      digestChunkChars: settings.digestChunkChars,
      digestProviderId: providerId,
      digestModel: settings.digestModels[providerId]?.trim() || baseConfig?.model || '',
      providerEnabled: Boolean(baseConfig?.enabled),
      providerIsLocal: baseConfig ? isLocalProvider(baseConfig) : false,
    };
  }));
  const { setDocumentFingerprint, setDocumentDigest, setDigestState } = useStore.getState();

  useEffect(() => {
    if (digestCancelToken === 0) return;
    abortRef.current?.abort();
  }, [digestCancelToken]);

  useEffect(() => {
    if (!hasPdf || !documentTextReady || !digestEnabled) {
      if (!digestEnabled && hasPdf) setDigestState('idle', 'Document digest is disabled');
      return;
    }

    const { settings } = useStore.getState();
    const provider = providers[digestProviderId];
    const baseConfig = settings.providers[digestProviderId];
    const config = baseConfig ? { ...baseConfig, model: digestModel } : undefined;
    if (!provider || !config) {
      setDigestState('error', '', 'The selected AI provider is unavailable.');
      return;
    }
    if (!providerEnabled) {
      setDigestState('error', '', `${config.name} is disabled. Enable it in Settings to build the page index.`);
      return;
    }

    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;
    let disposed = false;

    const run = async () => {
      try {
        setDigestState('loading', 'Checking the reusable document digest cache…');
        const { pdfFile, documentFingerprint, pageTexts } = useStore.getState();
        if (!pdfFile) return;
        // The main process hashes the file when it is opened, and the tab
        // session keeps the result, so this rarely hashes anything.
        const fingerprint = documentFingerprint || pdfFile.fingerprint || await fingerprintPdf(pdfFile.data);
        if (disposed || abort.signal.aborted) return;
        if (fingerprint !== documentFingerprint) setDocumentFingerprint(fingerprint);

        const tabId = activeDocumentTabId || 'no-document';
        const previousRebuildToken = lastRebuildRef.current.get(tabId) || 0;
        const rebuilding = digestRebuildToken > previousRebuildToken;
        lastRebuildRef.current.set(tabId, digestRebuildToken);
        if (rebuilding) {
          partialDigests.delete(fingerprint);
          await deleteCachedDigest(fingerprint);
        }

        if (!rebuilding) {
          const cached = validateDocumentDigest(
            await loadCachedDigest(fingerprint),
            fingerprint,
            numPages
          );
          if (cached) {
            setDocumentDigest(cached);
            setDigestState('ready', `Loaded cached page index for ${cached.pages.length} pages`);
            return;
          }
        }

        // A cloud provider receives the full document text. Ask first unless
        // the user opted in to building page indexes automatically.
        if (!providerIsLocal && !digestAutoCloud && !useStore.getState().digestApproved) {
          setDigestState(
            'needs-approval',
            `Building the page index sends the full text of this PDF to ${config.name}. Nothing is sent until you approve.`
          );
          return;
        }

        const chunks = chunkDocument(pageTexts, digestChunkChars);
        if (chunks.length === 0) {
          throw new Error('No extractable PDF text is available for digest generation.');
        }
        const partialKey = `${digestProviderId}:${config.model}:${digestChunkChars}`;
        const partial = partialDigests.get(fingerprint);
        const fragments: DigestFragment[] = partial?.key === partialKey ? partial.fragments : [];
        partialDigests.set(fingerprint, { key: partialKey, fragments });
        for (let index = fragments.length; index < chunks.length; index++) {
          const chunk = chunks[index];
          setDigestState(
            'generating',
            `Building document digest — part ${index + 1} / ${chunks.length} (pages ${chunk.startPage}–${chunk.endPage})`
          );
          const message: ChatMessage = {
            id: `digest-${index}`,
            role: 'user',
            content: `Analyze the following PDF pages and produce the required digest JSON.\n\n${chunk.text}`,
            timestamp: Date.now(),
          };
          const response = await requestProviderText(
            provider,
            [message],
            fragmentPrompt(useStore.getState().settings.customInstructions),
            config,
            abort.signal
          );
          let parsed: unknown;
          try {
            parsed = parseJsonObject(response);
          } catch {
            setDigestState(
              'generating',
              `Repairing digest JSON for part ${index + 1} / ${chunks.length}…`
            );
            const repaired = await requestProviderText(
              provider,
              [{
                id: `digest-repair-${index}`,
                role: 'user',
                content: `Return a valid JSON digest for these PDF pages. Output JSON only and follow the required schema exactly.\n\n${chunk.text}`,
                timestamp: Date.now(),
              }],
              fragmentPrompt(useStore.getState().settings.customInstructions),
              config,
              abort.signal
            );
            parsed = parseJsonObject(repaired);
          }
          fragments.push(normalizeDigestFragment(parsed, numPages, {
            startPage: chunk.startPage,
            endPage: chunk.endPage,
          }));
        }

        setDigestState('consolidating', 'Consolidating the reusable document digest…');
        let synthesizedOverview = '';
        let synthesizedTopics: DigestTopic[] = [];
        const compactFragments = fragments.map((fragment) => ({
          overview: fragment.overview,
          sections: fragment.sections.map((section) => ({
            title: section.title,
            startPage: section.startPage,
            endPage: section.endPage,
            summary: section.summary,
          })),
          topics: fragment.topics,
        }));
        const synthesisInput = JSON.stringify(compactFragments).slice(0, digestChunkChars);
        try {
          const response = await requestProviderText(
            provider,
            [{
              id: 'digest-synthesis',
              role: 'user',
              content: `Consolidate these page-range digests into a whole-document overview and major topics.\n\n${synthesisInput}`,
              timestamp: Date.now(),
            }],
            synthesisPrompt(useStore.getState().settings.customInstructions),
            config,
            abort.signal
          );
          const synthesis = normalizeSynthesis(parseJsonObject(response), numPages);
          synthesizedOverview = synthesis.overview;
          synthesizedTopics = synthesis.topics;
        } catch (error: any) {
          if (error?.name === 'AbortError') throw error;
        }

        let digest = consolidateDigestFragments(fragments, {
          fingerprint,
          documentName: pdfFile.name,
          pageCount: numPages,
          providerId: digestProviderId,
          model: config.model,
          overview: synthesizedOverview,
        });
        if (synthesizedTopics.length > 0) digest.majorTopics = synthesizedTopics;
        digest = completeDigestPageIndex(digest, pageTexts);
        await saveCachedDigest(digest);
        partialDigests.delete(fingerprint);
        if (disposed || abort.signal.aborted) return;
        setDocumentDigest(digest);
        setDigestState('ready', `Document page index ready — ${digest.pages.length} pages`);
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          if (!disposed) setDigestState('cancelled', 'Document digest generation cancelled');
          return;
        }
        if (!disposed) {
          setDocumentDigest(null);
          setDigestState('error', '', error?.message || 'Document digest generation failed.');
        }
      }
    };

    run();
    return () => {
      disposed = true;
      abort.abort();
    };
    // The setters from getState() are stable store actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    documentSessionId,
    activeDocumentTabId,
    hasPdf,
    documentTextReady,
    digestRebuildToken,
    digestApproved,
    numPages,
    digestEnabled,
    digestAutoCloud,
    digestChunkChars,
    digestProviderId,
    digestModel,
    providerEnabled,
    providerIsLocal,
  ]);

  return null;
}

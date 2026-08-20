const requests = new Map<string, AbortController>();

export function registerChatRequest(tabId: string, controller: AbortController): void {
  requests.get(tabId)?.abort();
  requests.set(tabId, controller);
}

export function abortChatRequest(tabId: string): void {
  requests.get(tabId)?.abort();
  requests.delete(tabId);
}

export function clearChatRequest(tabId: string, controller: AbortController): void {
  if (requests.get(tabId) === controller) requests.delete(tabId);
}

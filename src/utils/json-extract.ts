// Pulls one JSON object out of a model answer that may wrap it in prose,
// markdown fences or <think> blocks.

export function parseJsonObject(text: string): unknown {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Common case: prose around one object. Try first "{" to last "}".
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        // Fall through to the balanced scan.
      }
    }
    // Single pass over the text. Track brace depth, ignoring braces inside
    // JSON strings, and try to parse each top-level {...} span once. This is
    // linear in the text length, unlike trying every "{" with every "}".
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < cleaned.length; index++) {
      const character = cleaned[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"' && depth > 0) inString = true;
      else if (character === '{') {
        if (depth === 0) start = index;
        depth++;
      } else if (character === '}' && depth > 0) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, index + 1));
          } catch {
            // Keep scanning for the next top-level object.
          }
        }
      }
    }
  }
  throw new Error('The model did not return a valid JSON object.');
}


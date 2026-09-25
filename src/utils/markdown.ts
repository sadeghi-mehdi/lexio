// Small markdown renderer for chat answers.

// Escapes the text first, so the only HTML in the result is what this
// function (and the citation renderer after it) adds.
export function formatMarkdown(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Markdown tables: a header row, a separator row of dashes, then rows.
  const withTables = escaped.replace(
    /(^\|.*\|[ \t]*\n\|[ \t:|-]+\|[ \t]*\n(?:\|.*\|[ \t]*(?:\n|$))*)/gm,
    (table) => {
      const rows = table.trim().split('\n').map((row) =>
        row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
      );
      const [header, , ...body] = rows;
      return `<table><thead><tr>${header.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${
        body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`;
    }
  );
  return withTables
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code class="bg-surface-3 px-1 py-0.5 rounded text-accent-light text-[0.85em]">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<strong class="text-base">$1</strong>')
    .replace(/^## (.+)$/gm, '<strong class="text-lg">$1</strong>')
    .replace(/^# (.+)$/gm, '<strong class="text-xl">$1</strong>')
    .replace(/^- (.+)$/gm, '• $1');
}

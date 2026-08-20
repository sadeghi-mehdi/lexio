import { useState } from 'react';
import { MessageSquare, FileText, Highlighter, Underline, Strikethrough, Pencil, Trash2 } from 'lucide-react';
import { useStore } from '../stores/useStore';
import type { Highlight, HighlightColor, AnnotationType } from '../types';
import CommentModal from './CommentModal';

const COLOR_MAP: Record<HighlightColor, string> = {
  yellow: 'border-l-yellow-400 bg-yellow-400/5',
  green: 'border-l-emerald-400 bg-emerald-400/5',
  blue: 'border-l-blue-400 bg-blue-400/5',
  pink: 'border-l-pink-400 bg-pink-400/5',
  orange: 'border-l-orange-400 bg-orange-400/5',
};

const TYPE_ICONS: Record<AnnotationType, React.ReactNode> = {
  highlight: <Highlighter size={10} />,
  underline: <Underline size={10} />,
  strikeout: <Strikethrough size={10} />,
};

export default function AnnotationsPanel() {
  const { highlights, removeHighlight, updateHighlightComment, setCurrentPage } = useStore();
  const [editingHighlight, setEditingHighlight] = useState<Highlight | null>(null);

  const sorted = [...highlights].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return a.createdAt - b.createdAt;
  });

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6 opacity-60">
        <div className="w-12 h-12 rounded-2xl bg-surface-3 flex items-center justify-center mb-4">
          <FileText size={22} className="text-text-muted" />
        </div>
        <p className="text-sm text-text-secondary font-medium mb-1">No annotations yet</p>
        <p className="text-xs text-text-muted leading-relaxed">
          Choose a highlight, underline, strikethrough, or comment tool, then select text in the PDF.
        </p>
      </div>
    );
  }

  // Group by page
  const byPage = new Map<number, typeof sorted>();
  for (const h of sorted) {
    const arr = byPage.get(h.page) || [];
    arr.push(h);
    byPage.set(h.page, arr);
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
      {Array.from(byPage.entries()).map(([page, items]) => (
        <div key={page}>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
              Page {page}
            </span>
            <div className="flex-1 h-px bg-surface-3" />
          </div>

          <div className="space-y-2">
            {items.map((h) => (
              <div
                key={h.id}
                className={`border-l-2 rounded-r-lg px-3 py-2 ${COLOR_MAP[h.color]} cursor-pointer group transition-colors hover:bg-surface-2`}
                onClick={() => setCurrentPage(h.page)}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-text-muted">{TYPE_ICONS[h.type || 'highlight']}</span>
                  <span className="text-[10px] text-text-muted capitalize">{h.type || 'highlight'}</span>
                </div>
                <p className="text-xs text-text-primary leading-relaxed line-clamp-3">
                  "{h.text}"
                </p>

                {h.comment && (
                  <div className="flex items-start gap-1.5 mt-1.5">
                    <MessageSquare size={11} className="text-text-muted mt-0.5 flex-shrink-0" />
                    <p className="text-[11px] text-text-secondary">{h.comment}</p>
                  </div>
                )}

                <div className="mt-2 flex items-center gap-1.5 border-t border-surface-3/50 pt-1.5">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditingHighlight(h);
                    }}
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-text-muted transition-colors hover:bg-surface-3 hover:text-accent-light"
                    title={h.comment ? 'Edit comment' : 'Add comment'}
                  >
                    <Pencil size={10} />
                    {h.comment ? 'Edit comment' : 'Add comment'}
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeHighlight(h.id);
                    }}
                    className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
                    title="Remove annotation"
                    aria-label="Remove annotation"
                  >
                    <Trash2 size={11} />
                    Remove
                  </button>
                </div>

              </div>
            ))}
          </div>
        </div>
      ))}
      {editingHighlight && (
        <CommentModal
          text={editingHighlight.text}
          initialComment={editingHighlight.comment || ''}
          onSave={(comment) => {
            updateHighlightComment(editingHighlight.id, comment.trim());
            setEditingHighlight(null);
          }}
          onCancel={() => setEditingHighlight(null)}
        />
      )}
    </div>
  );
}

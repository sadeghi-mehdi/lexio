import { useState, useRef, useEffect } from 'react';
import { X, MessageSquare } from 'lucide-react';

interface Props {
  text: string;
  initialComment?: string;
  onSave: (comment: string) => void;
  onCancel: () => void;
}

export default function CommentModal({ text, initialComment = '', onSave, onCancel }: Props) {
  const [comment, setComment] = useState(initialComment);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(comment);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      onSave(comment);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
    >
      <div
        className="bg-surface-2 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-3">
          <div className="flex items-center gap-2 text-text-primary">
            <MessageSquare size={18} className="text-accent-light" />
            <span className="font-medium">Add Comment</span>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-4">
          {/* Selected text preview */}
          <div className="mb-4 p-3 bg-surface-1 rounded-lg border border-surface-3">
            <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">Selected text</p>
            <p className="text-sm text-text-secondary line-clamp-3">"{text}"</p>
          </div>

          {/* Comment input */}
          <textarea
            ref={textareaRef}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add your comment..."
            rows={4}
            className="w-full bg-surface-1 text-text-primary text-sm rounded-lg px-3 py-2 resize-none outline-none border border-surface-3 focus:border-accent/40 transition-colors placeholder-text-muted"
          />

          <p className="text-[10px] text-text-muted mt-2 mb-4">
            Press <kbd className="bg-surface-3 px-1 py-0.5 rounded">Cmd+Enter</kbd> to save
          </p>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm bg-accent/20 text-accent-light hover:bg-accent/30 rounded-lg transition-colors"
            >
              Save Comment
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

import {
  Check,
  Copy,
  Highlighter,
  MessageSquarePlus,
  Sparkles,
  Strikethrough,
  Underline,
} from 'lucide-react';
import { RefObject, useState } from 'react';
import { copyText } from '../utils/clipboard';
import type { AnnotationType } from '../types';

interface Props {
  rect: DOMRect;
  containerRef: RefObject<HTMLDivElement | null>;
  text: string;
  onAskAI: () => void;
  onAnnotate: (type: AnnotationType) => void;
  onComment: () => void;
}

export default function SelectionActionBar({
  rect,
  containerRef,
  text,
  onAskAI,
  onAnnotate,
  onComment,
}: Props) {
  const [copied, setCopied] = useState(false);
  const container = containerRef.current;
  if (!container) return null;

  const containerRect = container.getBoundingClientRect();

  // Position the bar above the selection
  const top = rect.top - containerRect.top + container.scrollTop - 44;
  const left = rect.left - containerRect.left + container.scrollLeft + rect.width / 2;

  const handleCopy = async () => {
    try {
      await copyText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      console.error('Failed to copy selected text:', error);
    }
  };

  return (
    <div
      className="selection-action-bar"
      style={{
        top: `${top}px`,
        left: `${left}px`,
        transform: 'translateX(-50%)',
      }}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <button className="primary" onClick={onAskAI}>
        <Sparkles size={14} />
        Ask AI
      </button>
      <button onClick={handleCopy} title={copied ? 'Copied' : 'Copy selected text'} aria-label="Copy selected text">
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <button onClick={() => onAnnotate('highlight')} title="Highlight selected text" aria-label="Highlight selected text">
        <Highlighter size={14} />
      </button>
      <button onClick={() => onAnnotate('underline')} title="Underline selected text" aria-label="Underline selected text">
        <Underline size={14} />
      </button>
      <button onClick={() => onAnnotate('strikeout')} title="Strikethrough selected text" aria-label="Strikethrough selected text">
        <Strikethrough size={14} />
      </button>
      <button onClick={onComment} title="Comment on selected text" aria-label="Comment on selected text">
        <MessageSquarePlus size={14} />
      </button>
    </div>
  );
}

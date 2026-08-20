import { Upload } from 'lucide-react';
import { useStore } from '../stores/useStore';
import logoSvg from '../assets/logo.svg';

export default function WelcomeScreen() {
  const { setPdfFile } = useStore();

  const handleClick = () => {
    if (window.electronAPI) {
      window.electronAPI.openPdf();
    } else {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf';
      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          setPdfFile({
            path: (file as File & { path?: string }).path || file.name,
            name: file.name,
            data: base64,
          });
        };
        reader.readAsDataURL(file);
      };
      input.click();
    }
  };

  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8">
      <div className="mb-6">
        <img src={logoSvg} alt="Lexio" className="w-24 h-24 drop-shadow-2xl" />
      </div>

      <h1 className="text-2xl font-semibold text-text-primary mb-2 tracking-tight">
        Welcome to Lexio
      </h1>
      <p className="text-sm text-text-secondary max-w-md leading-relaxed mb-8">
        Open a PDF to start reading, select passages, and build a reusable digest for fast,
        page-aware AI questions.
      </p>

      <button
        onClick={handleClick}
        className="flex items-center gap-2.5 px-6 py-3 bg-accent hover:bg-accent-dim text-white rounded-xl text-sm font-medium transition-colors shadow-lg shadow-accent/20"
      >
        <Upload size={18} />
        Open a PDF
      </button>

      <p className="text-xs text-text-muted mt-4">
        or drag & drop a file anywhere · <kbd className="font-mono bg-surface-2 px-1.5 py-0.5 rounded text-[11px]">⌘O</kbd> to open
      </p>

      <div className="mt-12 grid grid-cols-3 gap-6 max-w-xl">
        <Feature icon="📄" title="Read" desc="Page-aware PDF viewing" />
        <Feature icon="🔎" title="Select" desc="Focus on passages" />
        <Feature icon="✨" title="Ask AI" desc="Explain passages" />
      </div>
    </div>
  );
}

function Feature({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="text-center">
      <span className="text-2xl">{icon}</span>
      <p className="text-xs font-medium text-text-secondary mt-1">{title}</p>
      <p className="text-[10px] text-text-muted">{desc}</p>
    </div>
  );
}

import {
  FolderOpen,
  Save,
  ZoomIn,
  ZoomOut,
  MousePointer2,
  Highlighter,
  MessageSquarePlus,
  PanelRightOpen,
  PanelRightClose,
  PanelLeftOpen,
  PanelLeftClose,
  Settings,
  ChevronLeft,
  ChevronRight,
  Underline,
  Strikethrough,
} from 'lucide-react';
import { savePdfWithAnnotations } from '../utils/pdf-save';
import { useStore, type ToolType } from '../stores/useStore';
import type { HighlightColor } from '../types';
import logoSvg from '../assets/logo.svg';

const HIGHLIGHT_COLORS: Array<{ id: HighlightColor; label: string; bg: string }> = [
  { id: 'yellow', label: 'Yellow', bg: 'bg-yellow-400' },
  { id: 'green', label: 'Green', bg: 'bg-emerald-400' },
  { id: 'blue', label: 'Blue', bg: 'bg-blue-400' },
  { id: 'pink', label: 'Pink', bg: 'bg-pink-400' },
  { id: 'orange', label: 'Orange', bg: 'bg-orange-400' },
];

const COLOR_TOOLS: ToolType[] = ['highlight', 'underline', 'strikeout'];

export default function Toolbar() {
  const {
    pdfFile,
    currentPage,
    numPages,
    zoom,
    activeTool,
    activeHighlightColor,
    sidebarOpen,
    thumbnailSidebarOpen,
    highlights,
    setCurrentPage,
    zoomIn,
    zoomOut,
    zoomReset,
    setActiveTool,
    setActiveHighlightColor,
    toggleSidebar,
    toggleThumbnailSidebar,
    setSettingsOpen,
  } = useStore();

  const handleSave = async () => {
    if (!pdfFile) return;

    try {
      const modifiedPdf = await savePdfWithAnnotations(pdfFile.data, highlights);

      if (window.electronAPI) {
        // In Electron: save to file
        const savedPath = await window.electronAPI.savePdf(
          pdfFile.name.replace('.pdf', '-annotated.pdf'),
          modifiedPdf
        );
        if (savedPath) {
          console.log('PDF saved to:', savedPath);
        }
      } else {
        // In browser: download
        const blob = new Blob(
          [Uint8Array.from(atob(modifiedPdf), (c) => c.charCodeAt(0))],
          { type: 'application/pdf' }
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = pdfFile.name.replace('.pdf', '-annotated.pdf');
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('Failed to save PDF:', err);
    }
  };

  const openFile = () => {
    if (window.electronAPI) {
      window.electronAPI.openPdf();
    } else {
      // Fallback: file input for web/dev mode
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf';
      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          useStore.getState().setPdfFile({
            path: file.name,
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
    <div className="titlebar-drag flex items-center h-12 pl-20 pr-3 bg-surface-1 border-b border-surface-3 gap-1 flex-shrink-0">
      {/* Logo */}
      <img src={logoSvg} alt="Lexio" className="w-7 h-7 mr-1" />
      <span className="titlebar-nodrag text-sm font-semibold text-text-primary mr-2 select-none">Lexio</span>

      <Divider />

      {/* File */}
      <ToolbarButton icon={<FolderOpen size={16} />} label="Open PDF" onClick={openFile} />
      {pdfFile && (
        <ToolbarButton
          icon={<Save size={16} />}
          label="Save PDF with annotations"
          onClick={handleSave}
        />
      )}

      {/* Thumbnail sidebar toggle */}
      {pdfFile && (
        <ToolbarButton
          icon={thumbnailSidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          label="Toggle page thumbnails"
          onClick={toggleThumbnailSidebar}
        />
      )}

      {pdfFile && (
        <>
          <Divider />

          {/* Page nav */}
          <ToolbarButton
            icon={<ChevronLeft size={16} />}
            label="Previous page"
            onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
          />
          <span className="titlebar-nodrag text-xs text-text-secondary font-mono px-1 min-w-[80px] text-center select-none">
            {currentPage} / {numPages}
          </span>
          <ToolbarButton
            icon={<ChevronRight size={16} />}
            label="Next page"
            onClick={() => setCurrentPage(Math.min(numPages, currentPage + 1))}
            disabled={currentPage >= numPages}
          />

          <Divider />

          {/* Zoom */}
          <ToolbarButton icon={<ZoomOut size={16} />} label="Zoom out" onClick={zoomOut} />
          <button
            onClick={zoomReset}
            className="titlebar-nodrag text-xs text-text-secondary font-mono px-2 py-1 rounded hover:bg-surface-3 transition-colors min-w-[52px] text-center"
          >
            {Math.round(zoom * 100)}%
          </button>
          <ToolbarButton icon={<ZoomIn size={16} />} label="Zoom in" onClick={zoomIn} />

          <Divider />

          {/* Tools */}
          <ToolbarButton
            icon={<MousePointer2 size={16} />}
            label="Select"
            active={activeTool === 'select'}
            onClick={() => setActiveTool('select')}
          />
          <ToolbarButton
            icon={<Highlighter size={16} />}
            label="Highlight"
            active={activeTool === 'highlight'}
            onClick={() => setActiveTool('highlight')}
          />
          <ToolbarButton
            icon={<Underline size={16} />}
            label="Underline"
            active={activeTool === 'underline'}
            onClick={() => setActiveTool('underline')}
          />
          <ToolbarButton
            icon={<Strikethrough size={16} />}
            label="Strikethrough"
            active={activeTool === 'strikeout'}
            onClick={() => setActiveTool('strikeout')}
          />
          <ToolbarButton
            icon={<MessageSquarePlus size={16} />}
            label="Comment"
            active={activeTool === 'comment'}
            onClick={() => setActiveTool('comment')}
          />

          {COLOR_TOOLS.includes(activeTool) && (
            <div className="titlebar-nodrag ml-1 flex items-center gap-1">
              {HIGHLIGHT_COLORS.map((color) => (
                <button
                  key={color.id}
                  type="button"
                  title={`${color.label} annotation`}
                  aria-label={`${color.label} annotation color`}
                  onClick={() => setActiveHighlightColor(color.id)}
                  className={`h-4 w-4 rounded-full ${color.bg} transition-all ${
                    activeHighlightColor === color.id
                      ? 'scale-110 ring-2 ring-white ring-offset-1 ring-offset-surface-1'
                      : 'opacity-60 hover:opacity-100'
                  }`}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      <ToolbarButton
        icon={<Settings size={16} />}
        label="Settings"
        onClick={() => setSettingsOpen(true)}
      />
      <ToolbarButton
        icon={sidebarOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        label="Toggle sidebar"
        onClick={toggleSidebar}
      />
    </div>
  );
}

// ─── Sub-components ───

function ToolbarButton({
  icon,
  label,
  onClick,
  active,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`titlebar-nodrag p-1.5 rounded-md transition-colors ${
        active
          ? 'bg-accent/20 text-accent-light'
          : disabled
            ? 'text-text-muted cursor-not-allowed opacity-40'
            : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
      }`}
    >
      {icon}
    </button>
  );
}

function Divider() {
  return <div className="w-px h-5 bg-surface-3 mx-1" />;
}

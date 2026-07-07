import React, { useState, useCallback } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import HardBreak from '@tiptap/extension-hard-break';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import TextAlign from '@tiptap/extension-text-align';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { lowlight } from 'lowlight';
import { 
  Bold, 
  Italic, 
  List, 
  ListOrdered,
  Link as LinkIcon,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Quote,
  Code,
  Code2,
  Minus,
  Undo,
  Redo,
  RemoveFormatting,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  Eye,
  Edit3,
  Columns,
  Maximize2,
  HelpCircle,
  Save
} from 'lucide-react';
import { Button } from '../common';
import DOMPurify from 'dompurify';
import '../../styles/prose-overrides.css';

interface CMSEditorProps {
  content: string;
  onChange: (content: string) => void;
  onSave?: () => void;
  isSaving?: boolean;
}

type ViewMode = 'edit' | 'preview' | 'split';

export const CMSEditor: React.FC<CMSEditorProps> = ({ content, onChange, onSave, isSaving }) => {
  const [linkUrl, setLinkUrl] = useState('');
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('edit');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        hardBreak: false, // We'll use the separate HardBreak extension
        codeBlock: false, // We'll use CodeBlockLowlight instead
      }),
      HardBreak.configure({
        keepMarks: true,
        HTMLAttributes: {
          class: 'hard-break',
        },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right', 'justify'],
        defaultAlignment: 'left',
      }),
      CodeBlockLowlight.configure({
        lowlight,
        HTMLAttributes: {
          class: 'hljs',
        },
      }),
      Placeholder.configure({
        placeholder: 'Start typing your content here...',
      }),
      CharacterCount.configure({
        limit: null,
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
      updateCounts(editor);
    },
    onCreate: ({ editor }) => {
      updateCounts(editor);
    },
  });

  const updateCounts = useCallback((editorInstance: Editor) => {
    const textContent = editorInstance.state.doc.textContent;
    setCharCount(editorInstance.storage.characterCount.characters());
    const words = textContent.trim().split(/\s+/).filter((word: string) => word.length > 0);
    setWordCount(words.length);
  }, []);

  // Update editor content when prop changes
  React.useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content);
    }
  }, [content, editor]);

  if (!editor) {
    return null;
  }

  const addLink = () => {
    if (linkUrl) {
      editor.chain().focus().setLink({ href: linkUrl }).run();
      setLinkUrl('');
      setShowLinkDialog(false);
    }
  };

  const MenuButton: React.FC<{
    onClick: () => void;
    active?: boolean;
    children: React.ReactNode;
    title: string;
    disabled?: boolean;
  }> = ({ onClick, active, children, title, disabled }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`p-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors ${
        active
          ? 'bg-accent-dark/15 text-accent-dark'
          : 'text-neutral-700 dark:text-neutral-200'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      title={title}
      type="button"
    >
      {children}
    </button>
  );

  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  const getPreviewContent = () => {
    return DOMPurify.sanitize(editor?.getHTML() || '', {
      ALLOWED_TAGS: [
        'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'blockquote', 'a', 'em', 'strong',
        'code', 'pre', 'hr', 'div', 'span'
      ],
      ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style'],
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: true,
      ADD_TAGS: ['br'], // Explicitly allow br tags
      ADD_ATTR: ['style'], // Allow style for text alignment
    });
  };

  // Reusable view-mode chip — three states (edit/preview/split). Shared
  // styling block extracted as a const so the dark variants stay in sync.
  const viewModeChipClass = (mode: typeof viewMode) =>
    `px-3 py-1.5 text-sm font-medium rounded transition-colors ${
      viewMode === mode
        ? 'bg-accent-dark/15 text-accent-dark'
        : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
    }`;

  return (
    <div className={`relative ${isFullscreen ? 'fixed inset-0 z-50 bg-white dark:bg-neutral-900' : ''}`}>
      <div className="border border-neutral-300 dark:border-neutral-700 rounded-lg overflow-hidden h-full flex flex-col bg-white dark:bg-neutral-900">
        {/* Top Toolbar */}
        <div className="border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800">
          {/* View Mode Controls */}
          <div className="flex items-center justify-between p-2 border-b border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center gap-2">
              <button onClick={() => setViewMode('edit')} className={viewModeChipClass('edit')}>
                <Edit3 className="w-4 h-4 inline-block mr-1" />
                Edit
              </button>
              <button onClick={() => setViewMode('preview')} className={viewModeChipClass('preview')}>
                <Eye className="w-4 h-4 inline-block mr-1" />
                Preview
              </button>
              <button onClick={() => setViewMode('split')} className={viewModeChipClass('split')}>
                <Columns className="w-4 h-4 inline-block mr-1" />
                Split
              </button>
            </div>
            
            <div className="flex items-center gap-2">
              {onSave && (
                <Button
                  size="sm"
                  onClick={onSave}
                  isLoading={isSaving}
                  leftIcon={<Save className="w-4 h-4" />}
                >
                  Save
                </Button>
              )}
              
              <MenuButton
                onClick={() => setShowHelp(true)}
                title="Help & Keyboard Shortcuts"
              >
                <HelpCircle className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={toggleFullscreen}
                title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
                active={isFullscreen}
              >
                <Maximize2 className="w-4 h-4" />
              </MenuButton>
            </div>
          </div>

          {/* Formatting Toolbar */}
          {viewMode !== 'preview' && (
            <div className="flex items-center gap-1 p-2 flex-wrap">
              <MenuButton
                onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                active={editor.isActive('heading', { level: 1 })}
                title="Heading 1 (Ctrl+Alt+1)"
              >
                <Heading1 className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                active={editor.isActive('heading', { level: 2 })}
                title="Heading 2 (Ctrl+Alt+2)"
              >
                <Heading2 className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
                active={editor.isActive('heading', { level: 3 })}
                title="Heading 3 (Ctrl+Alt+3)"
              >
                <Heading3 className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}
                active={editor.isActive('heading', { level: 4 })}
                title="Heading 4 (Ctrl+Alt+4)"
              >
                <Heading4 className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleHeading({ level: 5 }).run()}
                active={editor.isActive('heading', { level: 5 })}
                title="Heading 5 (Ctrl+Alt+5)"
              >
                <Heading5 className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleHeading({ level: 6 }).run()}
                active={editor.isActive('heading', { level: 6 })}
                title="Heading 6 (Ctrl+Alt+6)"
              >
                <Heading6 className="w-4 h-4" />
              </MenuButton>

              <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-1" />
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleBold().run()}
                active={editor.isActive('bold')}
                title="Bold (Ctrl+B)"
              >
                <Bold className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleItalic().run()}
                active={editor.isActive('italic')}
                title="Italic (Ctrl+I)"
              >
                <Italic className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleCode().run()}
                active={editor.isActive('code')}
                title="Inline Code (Ctrl+E)"
              >
                <Code className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleCodeBlock().run()}
                active={editor.isActive('codeBlock')}
                title="Code Block (Ctrl+Alt+C)"
              >
                <Code2 className="w-4 h-4" />
              </MenuButton>

              <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-1" />
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleBulletList().run()}
                active={editor.isActive('bulletList')}
                title="Bullet List (Ctrl+Shift+8)"
              >
                <List className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                active={editor.isActive('orderedList')}
                title="Numbered List (Ctrl+Shift+9)"
              >
                <ListOrdered className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
                active={editor.isActive('blockquote')}
                title="Blockquote (Ctrl+Shift+B)"
              >
                <Quote className="w-4 h-4" />
              </MenuButton>

              <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-1" />
              
              <MenuButton
                onClick={() => setShowLinkDialog(true)}
                active={editor.isActive('link')}
                title="Add Link (Ctrl+K)"
              >
                <LinkIcon className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().setHorizontalRule().run()}
                title="Horizontal Rule"
              >
                <Minus className="w-4 h-4" />
              </MenuButton>

              <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-1" />
              
              <MenuButton
                onClick={() => editor.chain().focus().setTextAlign('left').run()}
                active={editor.isActive({ textAlign: 'left' })}
                title="Align Left"
              >
                <AlignLeft className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().setTextAlign('center').run()}
                active={editor.isActive({ textAlign: 'center' })}
                title="Align Center"
              >
                <AlignCenter className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().setTextAlign('right').run()}
                active={editor.isActive({ textAlign: 'right' })}
                title="Align Right"
              >
                <AlignRight className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().setTextAlign('justify').run()}
                active={editor.isActive({ textAlign: 'justify' })}
                title="Justify"
              >
                <AlignJustify className="w-4 h-4" />
              </MenuButton>

              <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-1" />
              
              <MenuButton
                onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
                title="Clear Formatting"
              >
                <RemoveFormatting className="w-4 h-4" />
              </MenuButton>

              <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-1" />
              
              <MenuButton
                onClick={() => editor.chain().focus().undo().run()}
                disabled={!editor.can().undo()}
                title="Undo (Ctrl+Z)"
              >
                <Undo className="w-4 h-4" />
              </MenuButton>
              
              <MenuButton
                onClick={() => editor.chain().focus().redo().run()}
                disabled={!editor.can().redo()}
                title="Redo (Ctrl+Y)"
              >
                <Redo className="w-4 h-4" />
              </MenuButton>
            </div>
          )}
        </div>

        {/* Link Dialog */}
        {showLinkDialog && (
          <div className="p-3 bg-accent-dark/15 border-b border-accent-dark/30 flex items-center gap-2">
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && addLink()}
              placeholder="Enter URL..."
              className="flex-1 px-3 py-1 border border-accent-dark/30 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 rounded-md focus:ring-2 focus:ring-primary-500"
              autoFocus
            />
            <Button size="sm" onClick={addLink}>Add Link</Button>
            <Button size="sm" variant="outline" onClick={() => {
              setShowLinkDialog(false);
              setLinkUrl('');
            }}>
              Cancel
            </Button>
          </div>
        )}

        {/* Editor Content Area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Editor — prose-invert in dark mode flips the prose typography
              palette without us having to override every prose-* class. */}
          {viewMode !== 'preview' && (
            <div className={`${viewMode === 'split' ? 'w-1/2 border-r border-neutral-200 dark:border-neutral-700' : 'w-full'} overflow-auto bg-white dark:bg-neutral-900`}>
              <EditorContent
                editor={editor}
                className="min-h-[400px] p-4 prose prose-neutral dark:prose-invert max-w-none focus:outline-none [&_.ProseMirror]:min-h-[400px] [&_.ProseMirror]:outline-none [&_.ProseMirror]:text-neutral-900 dark:[&_.ProseMirror]:text-neutral-100 [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-neutral-400 dark:[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-neutral-500 [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_br.hard-break]:display-block [&_.ProseMirror_br.hard-break]:content-[''] [&_.ProseMirror_br.hard-break]:margin-[0.5em_0] [&_.ProseMirror_pre]:bg-neutral-100 dark:[&_.ProseMirror_pre]:bg-neutral-800 [&_.ProseMirror_pre]:rounded-md [&_.ProseMirror_pre]:p-4 [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_code]:bg-neutral-100 dark:[&_.ProseMirror_code]:bg-neutral-800 [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:px-1 [&_.ProseMirror_code]:py-0.5 [&_.ProseMirror_code]:text-sm [&_.ProseMirror_pre_code]:bg-transparent [&_.ProseMirror_pre_code]:p-0"
              />
            </div>
          )}

          {/* Preview */}
          {viewMode !== 'edit' && (
            <div className={`${viewMode === 'split' ? 'w-1/2' : 'w-full'} overflow-auto bg-neutral-50 dark:bg-neutral-800 p-4`}>
              <div
                className="prose prose-neutral dark:prose-invert max-w-none"
                dangerouslySetInnerHTML={{ __html: getPreviewContent() }}
              />
            </div>
          )}
        </div>

        {/* Status Bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-neutral-50 dark:bg-neutral-800 border-t border-neutral-200 dark:border-neutral-700 text-sm text-neutral-600 dark:text-neutral-300">
          <div className="flex items-center gap-4">
            <span>{wordCount} words</span>
            <span>{charCount} characters</span>
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            Press Shift+Enter for line break, Enter for new paragraph
          </div>
        </div>
      </div>

      {/* Help Modal */}
      {showHelp && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 rounded-lg max-w-2xl w-full max-h-[80vh] overflow-auto">
            <div className="p-6">
              <h2 className="text-xl font-semibold mb-4">Editor Help & Keyboard Shortcuts</h2>
              
              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold mb-2">Text Formatting</h3>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><kbd>Ctrl+B</kbd> - Bold</div>
                    <div><kbd>Ctrl+I</kbd> - Italic</div>
                    <div><kbd>Ctrl+E</kbd> - Inline code</div>
                    <div><kbd>Ctrl+K</kbd> - Add link</div>
                  </div>
                </div>
                
                <div>
                  <h3 className="font-semibold mb-2">Headings</h3>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><kbd>Ctrl+Alt+1</kbd> - Heading 1</div>
                    <div><kbd>Ctrl+Alt+2</kbd> - Heading 2</div>
                    <div><kbd>Ctrl+Alt+3</kbd> - Heading 3</div>
                    <div><kbd>Ctrl+Alt+4</kbd> - Heading 4</div>
                    <div><kbd>Ctrl+Alt+5</kbd> - Heading 5</div>
                    <div><kbd>Ctrl+Alt+6</kbd> - Heading 6</div>
                  </div>
                </div>
                
                <div>
                  <h3 className="font-semibold mb-2">Lists & Blocks</h3>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><kbd>Ctrl+Shift+8</kbd> - Bullet list</div>
                    <div><kbd>Ctrl+Shift+9</kbd> - Numbered list</div>
                    <div><kbd>Ctrl+Shift+B</kbd> - Blockquote</div>
                    <div><kbd>Ctrl+Alt+C</kbd> - Code block</div>
                  </div>
                </div>
                
                <div>
                  <h3 className="font-semibold mb-2">Text Alignment</h3>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>Click alignment buttons in toolbar</div>
                    <div>Works on paragraphs and headings</div>
                  </div>
                </div>
                
                <div>
                  <h3 className="font-semibold mb-2">Line Breaks</h3>
                  <div className="space-y-1 text-sm">
                    <div><kbd>Enter</kbd> - New paragraph</div>
                    <div><kbd>Shift+Enter</kbd> - Line break (preserves formatting)</div>
                  </div>
                </div>
                
                <div>
                  <h3 className="font-semibold mb-2">Navigation</h3>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><kbd>Ctrl+Z</kbd> - Undo</div>
                    <div><kbd>Ctrl+Y</kbd> - Redo</div>
                  </div>
                </div>
              </div>
              
              <div className="mt-6 flex justify-end">
                <Button onClick={() => setShowHelp(false)}>Close</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

CMSEditor.displayName = 'CMSEditor';

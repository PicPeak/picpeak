import React, { useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import HardBreak from '@tiptap/extension-hard-break';
import TextAlign from '@tiptap/extension-text-align';
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Link as LinkIcon,
  Heading2,
  Heading3,
  Quote,
  Minus,
  Undo,
  Redo,
  RemoveFormatting,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Code2,
  Variable,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface EmailTemplateEditorProps {
  content: string;
  onChange: (content: string) => void;
  variables?: string[];
}

export const EmailTemplateEditor: React.FC<EmailTemplateEditorProps> = ({
  content,
  onChange,
  variables = [],
}) => {
  const { t } = useTranslation();
  const [isSourceMode, setIsSourceMode] = useState(false);
  const [sourceContent, setSourceContent] = useState(content);
  const [linkUrl, setLinkUrl] = useState('');
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [showVariables, setShowVariables] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        hardBreak: false,
      }),
      HardBreak.configure({
        keepMarks: true,
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
        alignments: ['left', 'center', 'right'],
        defaultAlignment: 'left',
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      onChange(html);
      setSourceContent(html);
    },
  });

  // Sync editor when content prop changes externally
  React.useEffect(() => {
    if (editor && !isSourceMode && content !== editor.getHTML()) {
      editor.commands.setContent(content);
      setSourceContent(content);
    }
  }, [content, editor, isSourceMode]);

  const handleSourceChange = useCallback((value: string) => {
    setSourceContent(value);
    onChange(value);
  }, [onChange]);

  const switchToVisual = useCallback(() => {
    if (editor) {
      editor.commands.setContent(sourceContent);
    }
    setIsSourceMode(false);
  }, [editor, sourceContent]);

  const switchToSource = useCallback(() => {
    if (editor) {
      setSourceContent(editor.getHTML());
    }
    setIsSourceMode(true);
  }, [editor]);

  const insertVariable = useCallback((variable: string) => {
    const tag = `{{${variable}}}`;
    if (isSourceMode) {
      // Insert at cursor in textarea
      const textarea = document.querySelector('[data-email-source]') as HTMLTextAreaElement;
      if (textarea) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newContent = sourceContent.substring(0, start) + tag + sourceContent.substring(end);
        setSourceContent(newContent);
        onChange(newContent);
        // Restore cursor position after React re-render
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + tag.length;
          textarea.focus();
        });
      }
    } else if (editor) {
      editor.chain().focus().insertContent(tag).run();
    }
    setShowVariables(false);
  }, [editor, isSourceMode, sourceContent, onChange]);

  const addLink = useCallback(() => {
    if (linkUrl && editor) {
      editor.chain().focus().setLink({ href: linkUrl }).run();
      setLinkUrl('');
      setShowLinkDialog(false);
    }
  }, [editor, linkUrl]);

  if (!editor) {
    return null;
  }

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
      className={`p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-600 transition-colors ${
        active
          ? 'bg-accent-dark/15 text-accent-dark'
          : 'text-neutral-700 dark:text-neutral-300'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      title={title}
      type="button"
    >
      {children}
    </button>
  );

  return (
    <div className="border border-neutral-300 dark:border-neutral-600 rounded-lg overflow-hidden">
      {/* Toolbar */}
      <div className="border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800">
        <div className="flex items-center justify-between p-2">
          {/* Formatting buttons */}
          <div className="flex items-center gap-0.5 flex-wrap">
            {!isSourceMode && (
              <>
                <MenuButton
                  onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                  active={editor.isActive('heading', { level: 2 })}
                  title="Heading 2"
                >
                  <Heading2 className="w-4 h-4" />
                </MenuButton>

                <MenuButton
                  onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
                  active={editor.isActive('heading', { level: 3 })}
                  title="Heading 3"
                >
                  <Heading3 className="w-4 h-4" />
                </MenuButton>

                <div className="w-px h-5 bg-neutral-300 dark:bg-neutral-600 mx-1" />

                <MenuButton
                  onClick={() => editor.chain().focus().toggleBold().run()}
                  active={editor.isActive('bold')}
                  title={`${t('email.editor.bold')} (Ctrl+B)`}
                >
                  <Bold className="w-4 h-4" />
                </MenuButton>

                <MenuButton
                  onClick={() => editor.chain().focus().toggleItalic().run()}
                  active={editor.isActive('italic')}
                  title={`${t('email.editor.italic')} (Ctrl+I)`}
                >
                  <Italic className="w-4 h-4" />
                </MenuButton>

                <div className="w-px h-5 bg-neutral-300 dark:bg-neutral-600 mx-1" />

                <MenuButton
                  onClick={() => editor.chain().focus().toggleBulletList().run()}
                  active={editor.isActive('bulletList')}
                  title={t('email.editor.bulletList')}
                >
                  <List className="w-4 h-4" />
                </MenuButton>

                <MenuButton
                  onClick={() => editor.chain().focus().toggleOrderedList().run()}
                  active={editor.isActive('orderedList')}
                  title={t('email.editor.numberedList')}
                >
                  <ListOrdered className="w-4 h-4" />
                </MenuButton>

                <MenuButton
                  onClick={() => editor.chain().focus().toggleBlockquote().run()}
                  active={editor.isActive('blockquote')}
                  title={t('email.editor.blockquote')}
                >
                  <Quote className="w-4 h-4" />
                </MenuButton>

                <div className="w-px h-5 bg-neutral-300 dark:bg-neutral-600 mx-1" />

                <MenuButton
                  onClick={() => setShowLinkDialog(true)}
                  active={editor.isActive('link')}
                  title={t('email.editor.link')}
                >
                  <LinkIcon className="w-4 h-4" />
                </MenuButton>

                <MenuButton
                  onClick={() => editor.chain().focus().setHorizontalRule().run()}
                  title={t('email.editor.horizontalRule')}
                >
                  <Minus className="w-4 h-4" />
                </MenuButton>

                <div className="w-px h-5 bg-neutral-300 dark:bg-neutral-600 mx-1" />

                <MenuButton
                  onClick={() => editor.chain().focus().setTextAlign('left').run()}
                  active={editor.isActive({ textAlign: 'left' })}
                  title={t('email.editor.alignLeft')}
                >
                  <AlignLeft className="w-4 h-4" />
                </MenuButton>

                <MenuButton
                  onClick={() => editor.chain().focus().setTextAlign('center').run()}
                  active={editor.isActive({ textAlign: 'center' })}
                  title={t('email.editor.alignCenter')}
                >
                  <AlignCenter className="w-4 h-4" />
                </MenuButton>

                <MenuButton
                  onClick={() => editor.chain().focus().setTextAlign('right').run()}
                  active={editor.isActive({ textAlign: 'right' })}
                  title={t('email.editor.alignRight')}
                >
                  <AlignRight className="w-4 h-4" />
                </MenuButton>

                <div className="w-px h-5 bg-neutral-300 dark:bg-neutral-600 mx-1" />

                <MenuButton
                  onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
                  title={t('email.editor.clearFormatting')}
                >
                  <RemoveFormatting className="w-4 h-4" />
                </MenuButton>

                <MenuButton
                  onClick={() => editor.chain().focus().undo().run()}
                  disabled={!editor.can().undo()}
                  title={`${t('email.editor.undo')} (Ctrl+Z)`}
                >
                  <Undo className="w-4 h-4" />
                </MenuButton>

                <MenuButton
                  onClick={() => editor.chain().focus().redo().run()}
                  disabled={!editor.can().redo()}
                  title={`${t('email.editor.redo')} (Ctrl+Y)`}
                >
                  <Redo className="w-4 h-4" />
                </MenuButton>
              </>
            )}
          </div>

          {/* Right side: Variables + Source toggle */}
          <div className="flex items-center gap-2">
            {variables.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowVariables(!showVariables)}
                  className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors ${
                    showVariables
                      ? 'bg-accent-dark/15 text-accent-dark'
                      : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-600'
                  }`}
                  type="button"
                >
                  <Variable className="w-3.5 h-3.5" />
                  {t('email.editor.insertVariable')}
                </button>

                {showVariables && (
                  <div className="absolute right-0 top-full mt-1 z-10 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-600 rounded-lg shadow-lg py-1 min-w-[200px] max-h-[240px] overflow-auto">
                    {variables.map(variable => (
                      <button
                        key={variable}
                        onClick={() => insertVariable(variable)}
                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
                        type="button"
                      >
                        <code className="text-accent">{`{{${variable}}}`}</code>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              onClick={isSourceMode ? switchToVisual : switchToSource}
              className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors ${
                isSourceMode
                  ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
                  : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-600'
              }`}
              type="button"
            >
              <Code2 className="w-3.5 h-3.5" />
              {isSourceMode ? t('email.editor.visualMode') : t('email.editor.sourceMode')}
            </button>
          </div>
        </div>
      </div>

      {/* Link Dialog */}
      {showLinkDialog && (
        <div className="p-3 bg-accent-dark/15 border-b border-accent-dark/30 flex items-center gap-2">
          <input
            type="url"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addLink()}
            placeholder={t('email.editor.enterUrl')}
            className="flex-1 px-3 py-1 text-sm border border-accent-dark/30 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-md focus:ring-2 focus:ring-primary-500"
            autoFocus
          />
          <button
            onClick={addLink}
            className="px-3 py-1 text-sm bg-accent-dark text-white rounded-md hover:opacity-90"
            type="button"
          >
            {t('email.editor.addLink')}
          </button>
          <button
            onClick={() => { setShowLinkDialog(false); setLinkUrl(''); }}
            className="px-3 py-1 text-sm bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded-md hover:bg-neutral-300 dark:hover:bg-neutral-600"
            type="button"
          >
            {t('email.editor.cancel')}
          </button>
        </div>
      )}

      {/* Editor / Source Content Area */}
      {isSourceMode ? (
        <textarea
          data-email-source=""
          value={sourceContent}
          onChange={(e) => handleSourceChange(e.target.value)}
          rows={15}
          className="w-full px-3 py-2 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 font-mono text-sm focus:outline-none resize-y"
          spellCheck={false}
        />
      ) : (
        <EditorContent
          editor={editor}
          className="min-h-[300px] p-4 prose prose-neutral dark:prose-invert max-w-none bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:outline-none [&_.ProseMirror]:min-h-[300px] [&_.ProseMirror]:outline-none [&_.ProseMirror]:text-neutral-900 [&_.ProseMirror]:dark:text-neutral-100 [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-neutral-400 [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0"
        />
      )}
    </div>
  );
};

EmailTemplateEditor.displayName = 'EmailTemplateEditor';

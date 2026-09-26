import React from 'react';
import { HelpCircle } from 'lucide-react';
import DOMPurify from 'dompurify';

interface WelcomeMessageEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

export const WelcomeMessageEditor: React.FC<WelcomeMessageEditorProps> = ({
  value,
  onChange,
  placeholder,
  rows = 6
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  };

  // Convert newlines to <br> tags for preview with XSS sanitization
  const getPreviewHtml = () => {
    // First sanitize the input to remove any malicious content
    const sanitized = DOMPurify.sanitize(value, {
      ALLOWED_TAGS: [], // Strip all HTML tags, only allow text
      ALLOWED_ATTR: [],
      KEEP_CONTENT: true
    });
    // Then convert newlines to <br> tags
    return sanitized
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('<br />');
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <textarea
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          rows={rows}
          className="w-full px-3 py-2 border border-line-strong bg-panel text-heading placeholder-faint rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark transition-colors resize-none font-mono text-sm"
        />
        <div className="absolute top-2 right-2 text-neutral-400" title="Line breaks will be preserved in emails">
          <HelpCircle className="w-4 h-4" aria-hidden="true" />
        </div>
      </div>
      
      <div className="text-xs text-muted">
        Tip: Press Enter to create a new line. Each line will appear as a separate paragraph in emails.
      </div>

      {value && (
        <div className="mt-4">
          <p className="text-sm font-medium text-body mb-2">Preview:</p>
          <div className="p-4 bg-subtle rounded-lg border border-line">
            <div
              className="text-sm text-body whitespace-pre-wrap"
              dangerouslySetInnerHTML={{ __html: getPreviewHtml() }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

WelcomeMessageEditor.displayName = 'WelcomeMessageEditor';

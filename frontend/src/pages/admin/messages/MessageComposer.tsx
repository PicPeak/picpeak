import React, { useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useMutation } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { Send as SendIcon } from 'lucide-react';
import { toast } from 'react-toastify';
import { emailService } from '../../../services/email.service';
import { Button, Modal } from '../../../components/common';

/**
 * Compose / reply modal. The body is pre-loaded with the rendered template (or a
 * reply stub) and is FULLY EDITABLE — the admin can rewrite it or drop a note
 * anywhere before sending. On send it goes out as-is (server-sanitized), no
 * template re-render, and is recorded as a manual send (Customers ▸ Sent).
 */
export interface ComposerInit {
  to: string;
  cc?: string;
  subject: string;
  html: string;
  replyToReceivedId?: number;
}

const inputCls = 'flex-1 px-3 py-2 rounded-lg border border-line-strong bg-canvas text-sm text-heading focus:outline-none focus:ring-2 focus:ring-accent';

export const MessageComposer: React.FC<{
  init: ComposerInit;
  title?: string;
  accountKey?: string;
  onClose: () => void;
  onSent: () => void;
  t: TFunction;
}> = ({ init, title, accountKey, onClose, onSent, t }) => {
  const [to, setTo] = useState(init.to);
  const [cc, setCc] = useState(init.cc || '');
  const [subject, setSubject] = useState(init.subject);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Sanitize before it hits the contentEditable innerHTML — the initial body
    // can include untrusted text (e.g. an inbound sender name in a reply stub).
    if (bodyRef.current) bodyRef.current.innerHTML = DOMPurify.sanitize(init.html || '');
    // Load initial body exactly once; further edits are the admin's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useMutation({
    mutationFn: () => emailService.sendMessage({
      to: to.trim(),
      cc: cc.trim() || undefined,
      subject: subject.trim(),
      html: bodyRef.current?.innerHTML || '',
      replyToReceivedId: init.replyToReceivedId,
      accountKey,
    }),
    onSuccess: () => { toast.success(t('messages.sentToast', 'Message sent.')); onSent(); onClose(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || t('messages.sendFailed', 'Failed to send message.')),
  });

  const canSend = !!to.trim() && !!subject.trim() && !send.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      title={title || t('messages.compose', 'Compose message')}
      size="xl"
      footer={(
        <>
          <span className="mr-auto self-center text-xs text-muted">{t('messages.sendsFromHint', 'Sends from your configured outgoing address.')}</span>
          <Button variant="outline" onClick={onClose}>{t('messages.cancel', 'Cancel')}</Button>
          <Button variant="primary" onClick={() => send.mutate()} isLoading={send.isPending} disabled={!canSend} leftIcon={<SendIcon className="w-4 h-4" />}>
            {t('messages.send', 'Send')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="w-16 text-muted">{t('messages.to', 'To')}</span>
          <input className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="w-16 text-muted">Cc</span>
          <input className={inputCls} value={cc} onChange={(e) => setCc(e.target.value)} placeholder={t('messages.optional', 'optional')} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="w-16 text-muted">{t('messages.subject', 'Subject')}</span>
          <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <div className="flex flex-col">
          <div className="text-xs text-muted mb-1">
            {t('messages.bodyHint', 'Edit the message freely — add a note anywhere before sending.')}
          </div>
          <div
            ref={bodyRef}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label={t('messages.body', 'Message')}
            className="min-h-[320px] rounded-lg border border-line-strong bg-canvas p-3 text-sm text-heading focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>
    </Modal>
  );
};

export default MessageComposer;

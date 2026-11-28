/**
 * Clicks in the editor's preview (issue 2618): a click selects its block;
 * a link or a form must not take the preview away, but a question (details/
 * summary) and the phone menu still open and close.
 */
import { describe, expect, it, vi } from 'vitest';
import { onPreviewClick } from '../PreviewFrame';

function click(html: string, selector: string) {
  document.body.innerHTML = html;
  const target = document.querySelector(selector) as Element;
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: target });
  const select = vi.fn();
  onPreviewClick(event, select);
  return { prevented: event.defaultPrevented, select };
}

describe('preview clicks', () => {
  it('a question opens: its summary click is not cancelled, and the block is still selected', () => {
    const { prevented, select } = click('<section data-block-id="faq"><details><summary><span>Q?</span></summary></details></section>', 'summary span');
    expect(prevented).toBe(false);
    expect(select).toHaveBeenCalledWith('faq');
  });

  it('the phone menu opens', () => {
    expect(click('<header><details class="pp-menu"><summary>Menu</summary></details></header>', 'summary').prevented).toBe(false);
  });

  it('a link, an image map area and a submit button do not navigate the preview', () => {
    expect(click('<section data-block-id="b"><a href="/about"><span>About</span></a></section>', 'span').prevented).toBe(true);
    expect(click('<map><area href="/x"></map>', 'area').prevented).toBe(true);
    expect(click('<form><button type="submit">Send</button></form>', 'button').prevented).toBe(true);
  });

  it('a plain click on a block is left alone and selects it', () => {
    const { prevented, select } = click('<section data-block-id="t"><p>Text</p></section>', 'p');
    expect(prevented).toBe(false);
    expect(select).toHaveBeenCalledWith('t');
  });

  it('works on the preview iframe\'s own document (its elements are another window\'s)', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument as Document;
    doc.body.innerHTML = '<section data-block-id="b"><a href="/about">About</a></section>';
    const event = new (frame.contentWindow as unknown as typeof window).MouseEvent('click', { bubbles: true, cancelable: true });
    const select = vi.fn();
    doc.addEventListener('click', (e) => onPreviewClick(e, select), true);
    (doc.querySelector('a') as HTMLElement).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(select).toHaveBeenCalledWith('b');
    frame.remove();
  });
});

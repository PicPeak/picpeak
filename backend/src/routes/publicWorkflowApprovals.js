/**
 * Public workflow-approval endpoint — the confirm/deny links emailed to the
 * admin when a workflow gate is reached. Token is the single-use raw value
 * (hashed at rest); acting resumes the run down the matching edge.
 *
 * Prefetch safety: GET is NEVER state-changing. Email clients + security
 * scanners (Outlook Safe Links, Gmail, Proofpoint, AV link-checkers) GET email
 * URLs before the human clicks — a GET that acted would silently advance a
 * payment-confirm gate. So GET renders an interstitial with buttons that POST
 * the decision; only POST calls actByToken. The token still gates everything
 * (256-bit, single-use), and prefetchers don't POST.
 */
const express = require('express');

const router = express.Router();
const { actByToken, peekApproval } = require('../services/workflows');

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${title}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;text-align:center;color:#1f2937">`
    + `<h2 style="font-weight:600">${title}</h2><p style="color:#4b5563;line-height:1.6">${body}</p></body></html>`;
}

// Escape any prompt text we echo into the interstitial HTML.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function decisionPage(token, emphasis, prompt) {
  const btn = (href, label, primary) => `<form method="POST" action="${href}" style="display:inline">`
    + `<button type="submit" style="cursor:pointer;margin:6px;padding:12px 20px;border-radius:8px;border:1px solid #d1d5db;`
    + `font-size:15px;font-weight:600;${primary
      ? 'background:#1d9e75;color:#fff;border-color:#1d9e75'
      : 'background:#fff;color:#374151'}">${label}</button></form>`;
  const body = (prompt ? `<span style="display:block;margin-bottom:16px">${esc(prompt)}</span>` : '')
    + `<div>`
    + btn(`confirm`, 'Confirm payment received', emphasis === 'confirm')
    + btn(`deny`, 'No payment received', emphasis === 'deny')
    + `</div>`
    + `<p style="color:#9ca3af;font-size:13px;margin-top:20px">Choosing is a single, final action.</p>`;
  return page('Confirm your response', body);
}

// GET — render the interstitial. READ-ONLY: never mutates / resumes.
router.get('/:token/:action', async (req, res) => {
  const { token, action } = req.params;
  if (!['confirm', 'deny'].includes(action)) {
    return res.status(400).send(page('Invalid link', 'This confirmation link is not valid.'));
  }
  try {
    const info = await peekApproval(token);
    if (!info.found) {
      return res.status(404).send(page('Link not found', 'This confirmation link is invalid or has been revoked.'));
    }
    if (info.status !== 'pending') {
      return res.send(page('Already recorded', `This request was already ${esc(info.status)}.`));
    }
    if (info.expired) {
      return res.status(410).send(page('Link expired', 'This confirmation link has expired. Use the workflow inbox in the admin panel instead.'));
    }
    // Relative form actions resolve against the current path's directory; the
    // emphasis just highlights the button matching the link they clicked.
    return res.send(decisionPage(token, action, info.prompt));
  } catch (e) {
    return res.status(500).send(page('Something went wrong', 'Please try again or use the admin panel.'));
  }
});

// POST — the actual decision. Only a human (or an explicit form submit) reaches
// here; prefetchers issue GET, not POST.
router.post('/:token/:action', async (req, res) => {
  const { token, action } = req.params;
  if (!['confirm', 'deny'].includes(action)) {
    return res.status(400).send(page('Invalid link', 'This confirmation link is not valid.'));
  }
  try {
    const result = await actByToken(token, action);
    if (!result.ok && result.reason === 'not_found') {
      return res.status(404).send(page('Link not found', 'This confirmation link is invalid or has been revoked.'));
    }
    if (!result.ok && result.reason === 'expired') {
      return res.status(410).send(page('Link expired', 'This confirmation link has expired. Use the workflow inbox in the admin panel instead.'));
    }
    if (result.already) {
      return res.send(page('Already recorded', `This request was already ${esc(result.status)}.`));
    }
    return res.send(page(
      'Thank you',
      action === 'confirm'
        ? 'Confirmed — the workflow will continue.'
        : 'Recorded — the workflow has been told there is no payment / to stop.',
    ));
  } catch (e) {
    return res.status(500).send(page('Something went wrong', 'We could not record your response. Please try again or use the admin panel.'));
  }
});

module.exports = router;

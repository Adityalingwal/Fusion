// Render untrusted markdown to HTML, then sanitize it before it touches innerHTML. marked does NOT
// strip scripts/event handlers, so a report containing <img onerror> / <script> would otherwise run.
// DOMPurify is the gate; every markdown sink goes through here.
function renderMarkdown(md) {
  const rawHtml = marked.parse(md ?? '');
  // Non-browser callers (tests) have no DOM to build the table wrapper in — sanitize and return.
  if (typeof document === 'undefined') return DOMPurify.sanitize(rawHtml);
  // Wrap every table in a horizontal-scroll box. A table wider than its card (many columns / long
  // cell values) would otherwise be clipped by the card's overflow:hidden with no way to reach the
  // hidden columns — on a phone especially. The wrapper is built in a <template>, whose content is
  // INERT (scripts don't run, img onerror doesn't fire), so parsing the not-yet-sanitized HTML here
  // is safe — and it only inserts a static-class <div>, adding no injection sink.
  const tpl = document.createElement('template');
  tpl.innerHTML = rawHtml;
  tpl.content.querySelectorAll('table').forEach((table) => {
    const scroller = document.createElement('div');
    scroller.className = 'table-scroll';
    table.replaceWith(scroller);
    scroller.appendChild(table);
  });
  // Sanitize LAST, right before the string reaches the caller's innerHTML sink, so DOMPurify's output
  // is parsed exactly once (its mXSS-safe contract) with no post-sanitize parse→serialize round-trip.
  return DOMPurify.sanitize(tpl.innerHTML);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// Safe to drop into a single-quoted JS string literal that itself lives inside a double-quoted HTML
// attribute, e.g. onclick="fn('${escapeJsArg(x)}')". escapeJsString alone left the `"` (and `<`) able
// to break out of the attribute; escapeHtml alone would let a `'` break the JS string. Both layers,
// JS first then HTML, are needed — the browser decodes the entities back to a valid JS literal.
function escapeJsArg(value) {
  return escapeHtml(escapeJsString(value));
}

function formatDateTime(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function apiErrorMessage(action) {
  if (location.protocol === 'file:') {
    return 'Open the dashboard from the printed http://localhost:<port>/ server URL, not this file path.';
  }
  return `Could not ${action}. Check that the Fusion dashboard server is running for this project.`;
}

// On a failed response, prefer the server's own explanation: API error responses carry a JSON
// { error } body (e.g. the unreadable-database message), which beats the generic "is the server
// running" guess. The message is tagged on the thrown error as `serverMessage` so callers can tell
// a server-explained persistent failure apart from a transient network blip.
async function ensureOk(response, label) {
  if (!response.ok) {
    let serverMessage = null;
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') serverMessage = body.error;
    } catch {
      // Body was not JSON (proxy error page, empty body) — fall through to the generic message.
    }
    const err = new Error(serverMessage || `${label} failed with HTTP ${response.status}`);
    if (serverMessage) err.serverMessage = serverMessage;
    throw err;
  }
  return response;
}

// Themed replacement for window.confirm()/alert(). Returns a Promise that resolves true when the
// user confirms and false when they cancel (Escape, backdrop click, or Cancel). Pass hideCancel to
// use it as a plain acknowledgement dialog (a single OK button) — resolves true either way.
function confirmModal({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  hideCancel = false,
} = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-modal-title');
    const msgEl = document.getElementById('confirm-modal-message');
    const okBtn = document.getElementById('confirm-modal-confirm');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    const backdrop = document.getElementById('confirm-modal-backdrop');

    // No modal markup on the page — fall back to native confirm so the action isn't silently lost.
    if (!modal || !okBtn || !cancelBtn) {
      resolve(hideCancel ? true : window.confirm(message || title));
      return;
    }

    titleEl.innerText = title;
    msgEl.innerText = message;
    okBtn.innerText = confirmLabel;
    cancelBtn.innerText = cancelLabel;
    cancelBtn.classList.toggle('hidden', hideCancel);

    const previouslyFocused = document.activeElement;

    function cleanup(result) {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); onOk(); }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);

    modal.classList.remove('hidden');
    okBtn.focus();
  });
}

function fallbackCopyText(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy'); // returns false when the copy didn't actually happen
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

async function copyTextToClipboard(text, button) {
  const original = button?.innerText || 'Copy';
  // Start both copy strategies inside the original click task. If the async Clipboard API rejects
  // after an await, the transient user activation may already be gone and execCommand will fail too.
  let clipboardWrite = null;
  try {
    if (navigator.clipboard?.writeText) {
      clipboardWrite = navigator.clipboard.writeText(text);
    }
  } catch {
    clipboardWrite = null;
  }

  const fallbackOk = fallbackCopyText(text);
  let clipboardOk = false;
  if (clipboardWrite) {
    try {
      await clipboardWrite;
      clipboardOk = true;
    } catch {
      clipboardOk = false;
    }
  }
  const ok = clipboardOk || fallbackOk;
  // Single feedback path: only claim "Copied" on a real success; surface failure honestly.
  if (button) {
    if (button.copyResetTimer) clearTimeout(button.copyResetTimer);
    button.innerText = ok ? '✓ Copied' : 'Copy failed';
    button.copyResetTimer = setTimeout(() => {
      button.innerText = original;
      button.copyResetTimer = null;
    }, 1800);
  }
}

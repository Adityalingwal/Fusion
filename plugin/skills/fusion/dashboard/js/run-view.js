// Main-panel view for one selected run: fetches its details, renders the four artifact tabs
// (brief / claude report / codex report / final plan), and owns the copy buttons and the
// delete-run flow. The sidebar tree that picks runs lives in tree.js; globals in shared-state.js.
function showRunsHome() {
  document.getElementById('details-panel').classList.add('hidden');
  document.getElementById('empty-state').classList.remove('hidden');
  selectedRunId = null;
  homeRequested = true;
  persistSelectedRun(null); // going home is deliberate — forget the saved run (a later refresh then falls back to the latest run)
  renderProjectTree();
}

// Per-tab wording for an empty artifact slot: the plain "not available" line, shown whenever an
// artifact is absent — whether the run is still running or finished without producing it.
const ARTIFACT_LABELS = {
  brief:  'No brief available',
  claude: 'No report available',
  codex:  'No report available',
  final:  'No final plan available',
};

// Body HTML for one artifact tab. Present content → rendered markdown; absent → the plain "not
// available" line. We deliberately show NO per-tab spinner while the run is running: the header
// RUNNING badge already signals in-progress, and a spinner here would spin forever if a run ever
// stalled in the running state. The 5s poll still swaps in the real content the moment it lands.
// Labels are static constants (no interpolation of run data) so this stays injection-safe.
function artifactSlotHtml(content, type) {
  if (content) return renderMarkdown(content);
  return `<p class="text-sm font-semibold text-dm-muted">${ARTIFACT_LABELS[type]}</p>`;
}

function artifactContent(type) {
  if (!selectedRunData) return '';
  const content = {
    brief: selectedRunData.brief,
    claude: selectedRunData.claudeReport,
    codex: selectedRunData.codexReport,
    final: selectedRunData.plan,
  }[type];
  return typeof content === 'string' ? content : '';
}

function updateCopyButton(type) {
  const button = document.getElementById(`${type}-copy-btn`);
  const available = artifactContent(type).trim().length > 0;
  button.classList.toggle('hidden', !available);
  button.disabled = !available;
  button.innerText = 'Copy';
}

function copyArtifact(button, type) {
  const content = artifactContent(type);
  if (!content.trim()) return;
  copyTextToClipboard(content, button);
}

async function selectRun(runId) {
  // A background poll re-selects the already-open run to refresh it — that isn't a real
  // navigation, so it shouldn't slam the mobile sidebar shut on someone mid-browse.
  const isNewSelection = runId !== selectedRunId;

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('details-panel').classList.remove('hidden');

  homeRequested = false;
  if (isNewSelection && window.innerWidth < 900) setSidebarCollapsed(true);

  selectedRunId = runId;
  if (isNewSelection) persistSelectedRun(runId); // remember across reloads (poll re-selects reuse the same id → skip)
  renderProjectTree(); // Update selected styles

  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (selectedRunId !== runId) return; // a newer selection superseded this fetch — drop the stale response
    if (res.status === 404) {
      // The run no longer exists (deleted, or a stale id restored from a prior session). Forget it and
      // let fetchData's auto-select reopen a valid run, instead of wedging on a blank panel forever.
      // Scoped to 404 only — a transient 5xx/network error goes to catch below and keeps the selection
      // so the next poll can recover it.
      selectedRunId = null;
      selectedRunData = null;
      restoreExpandPending = false;
      homeRequested = false; // let owesAutoSelect fall back to the latest run
      lastRenderedRunId = null;
      lastRenderedSignature = null;
      persistSelectedRun(null);
      document.getElementById('details-panel').classList.add('hidden');
      document.getElementById('empty-state').classList.remove('hidden');
      renderProjectTree();
      setTimeout(fetchData, 0); // deferred so the in-flight fetchData settles (fetchInFlight) before the retry
      return;
    }
    ensureOk(res, 'Run details request');
    const data = await res.json();
    if (selectedRunId !== runId) return; // re-check after the JSON await
    selectedRunData = data;

    // Restore-only: a run reopened from storage may sit in a collapsed / non-current folder whose runs
    // aren't loaded, so its sidebar row wouldn't render as selected. Expand + load that folder once.
    // Guarded by restoreExpandPending so ordinary clicks / poll re-selects never re-expand a folder the
    // user has since collapsed.
    if (restoreExpandPending) {
      restoreExpandPending = false;
      const pid = selectedRunData.projectId;
      if (pid && !expandedProjects.has(pid)) {
        expandedProjects.add(pid);
        persistExpanded();
        if (!runsByProject[pid]) {
          await fetchRunsFor(pid, { showLoader: false });
          if (selectedRunId !== runId) return; // superseded during the folder load
        }
        renderProjectTree();
      }
    }
    const runSummary = getRunSummary(runId) || {};
    const runStatus = selectedRunData.status || runSummary.status || 'unknown';
    const runCreatedAt = selectedRunData.createdAt || runSummary.createdAt;
    const runTitle = displayRunTitle(selectedRunData.title ? selectedRunData : runSummary);
    const projectLabel = selectedRunData.projectName || 'this project';

    // F7 no-change guard. The 5s poll re-selects the already-open run to pick up new artifacts;
    // re-writing identical innerHTML every tick wipes any in-progress text selection for no reason
    // (and is pure waste on a completed run that can never change). Build a signature of everything
    // this function paints below. When it matches what we last painted for THIS run on a background
    // poll — NOT a fresh user click (isNewSelection) — skip the DOM writes and leave the user's
    // selection intact. Any real change (an artifact landing, status flipping to completed) changes
    // the signature, so it still renders the instant it matters.
    const renderSignature = JSON.stringify([
      runTitle,
      projectLabel,
      runCreatedAt,
      runStatus,
      selectedRunData.brief,
      selectedRunData.claudeReport,
      selectedRunData.codexReport,
      selectedRunData.plan,
    ]);
    if (!isNewSelection && runId === lastRenderedRunId && renderSignature === lastRenderedSignature) {
      return; // nothing the panel shows has changed — leave the DOM (and the selection) alone
    }
    lastRenderedRunId = runId;
    lastRenderedSignature = renderSignature;

    // Render Header — the run title is the headline; project name + date are secondary.
    document.getElementById('run-title').innerText = runTitle;
    document.getElementById('run-meta-desc').innerText = `${projectLabel} · ${formatDateTime(runCreatedAt)}`;

    const isCompleted = runStatus === 'completed';
    const statusBadge = document.getElementById('run-status-badge');
    statusBadge.innerText = runStatus.toUpperCase();
    statusBadge.className = `shrink-0 whitespace-nowrap px-2.5 py-0.5 border-2 border-black rounded text-[9px] font-mono font-bold tracking-widest uppercase ${isCompleted ? 'bg-dm-panel-beige text-dm-text shadow-[1.5px_1.5px_0px_rgba(0,0,0,1)]' : 'bg-dm-panel-beige text-dm-muted shadow-[1.5px_1.5px_0px_rgba(0,0,0,1)]'}`;

    // Render Markdown content — an empty slot falls back to the plain "No X available" line (see
    // artifactSlotHtml), whether the run is still running or finished; the RUNNING badge above carries
    // the in-progress signal.
    document.getElementById('brief-content').innerHTML = artifactSlotHtml(selectedRunData.brief, 'brief');
    document.getElementById('report-claude-content').innerHTML = artifactSlotHtml(selectedRunData.claudeReport, 'claude');
    document.getElementById('report-codex-content').innerHTML = artifactSlotHtml(selectedRunData.codexReport, 'codex');

    document.getElementById('final-content-body').innerHTML = artifactSlotHtml(selectedRunData.plan, 'final');
    ['brief', 'claude', 'codex', 'final'].forEach(updateCopyButton);

    // Delete button click binding
    document.getElementById('delete-btn').onclick = () => deleteRun(runId, runTitle);

    // Retain current tab
    switchTab(currentTab);
  } catch (err) {
    if (selectedRunId !== runId) return; // stale error from a superseded selection — ignore
    console.error('Error fetching details for run:', runId, err);
    // Don't leave the previously-selected run's data + delete handler on screen after a failed load.
    selectedRunData = null;
    document.getElementById('details-panel').classList.add('hidden');
    document.getElementById('empty-state').classList.remove('hidden');
  }
}

async function deleteRun(runId, title) {
  const runTitle = displayRunTitle({ title });
  const confirmed = await confirmModal({
    title: 'Delete this run?',
    message: `Run "${runTitle}" and all its stored content will be permanently removed from the local Fusion database. This can't be undone.`,
    confirmLabel: 'Delete run',
    cancelLabel: 'Cancel',
  });
  if (!confirmed) {
    return;
  }
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      // After deleting the run you're viewing, land on the NEXT run in the SAME project (the row just
      // below the deleted one; if it was the oldest, the row just above) instead of the empty state —
      // so triaging several runs doesn't bounce through "select a report" each time. Compute the
      // neighbour from the CURRENT cached list, before fetchData() refreshes and drops the deleted row.
      const nextRunId = neighborRunId(runId);
      selectedRunData = null;
      if (nextRunId) {
        selectedRunId = nextRunId;
        homeRequested = false;
        persistSelectedRun(nextRunId); // remember the new selection across reloads
        // fetchData() below reopens it via its own `if (selectedRunId) selectRun(...)` path.
      } else {
        // Nothing left in that project → empty state, and forget the deleted run so a refresh doesn't
        // try to reopen it. homeRequested (same flag Fusion-home uses) suppresses the latest-run
        // auto-select until the user picks a run themselves.
        selectedRunId = null;
        homeRequested = true;
        persistSelectedRun(null);
        document.getElementById('details-panel').classList.add('hidden');
        document.getElementById('empty-state').classList.remove('hidden');
      }
      fetchData();
    } else {
      await confirmModal({
        title: 'Delete failed',
        message: 'Could not delete the run. Check that the Fusion dashboard server is still running, then try again.',
        confirmLabel: 'OK',
        hideCancel: true,
      });
    }
  } catch (err) {
    console.error('Error deleting run:', err);
    await confirmModal({
      title: 'Delete failed',
      message: 'Something went wrong while deleting the run. Check your connection and the dashboard server, then try again.',
      confirmLabel: 'OK',
      hideCancel: true,
    });
  }
}

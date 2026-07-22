// Find a run summary across every project's cached run list (a run row can live under any of the
// expanded folders, not just the current project).
function getRunSummary(runId) {
  for (const list of Object.values(runsByProject)) {
    const found = list.find(run => run.runId === runId);
    if (found) return found;
  }
  return null;
}

// The run to open after deleting `runId`: the next one DOWN in its project's list (the next-older
// run), or — if it was the last/oldest — the one just above (next-newer). null when it was the only
// run in that project. Reads the CURRENT cached list, so call it before a refresh drops the deleted
// row. Lists are created_at DESC, so index+1 is older and index-1 is newer.
function neighborRunId(runId) {
  for (const list of Object.values(runsByProject)) {
    const idx = list.findIndex(run => run.runId === runId);
    if (idx === -1) continue;
    const next = list[idx + 1] || list[idx - 1];
    return next ? next.runId : null;
  }
  return null;
}

// Whole-sidebar error (the projects list itself failed to load), distinct from a single folder's
// run fetch. showRetry adds a button that re-runs fetchData immediately instead of waiting on the
// 5s poll — but never under file://, where retrying can't help (the fix is to open the http URL,
// which the message already says).
function renderRunsError(message, { showRetry = false } = {}) {
  const listDiv = document.getElementById('runs-list');
  if (!listDiv) return;
  const canRetry = showRetry && location.protocol !== 'file:';
  const retryHtml = canRetry
    ? `<div class="mt-3"><button type="button" onclick="fetchData()" class="btn-brutal text-[11px] py-1.5 px-3.5 rounded-lg">Retry</button></div>`
    : '';
  listDiv.innerHTML = `
    <div class="text-center py-8 px-4 text-dm-text text-xs font-bold border border-dashed border-dm-text/40 rounded-xl bg-dm-bg shadow-[2px_2px_0px_rgba(0,0,0,0.05)]">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-5 h-5 mx-auto mb-2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
      </svg>
      ${escapeHtml(message)}
      ${retryHtml}
    </div>`;
}

let fetchInFlight = false;

// Consecutive failed /api/projects loads. One miss is almost always a transient blip (server
// restart, a momentary network hiccup) that the next 5s poll heals — reacting to it by wiping the
// sidebar is worse than doing nothing. Only a RUN of failures means the server is genuinely down.
// Reset to 0 on any success.
let consecutiveProjectLoadFailures = 0;
const PROJECT_LOAD_ERROR_THRESHOLD = 3; // ~3 straight failed polls (~10-15s) before the error screen

// Seed the expanded-folder set once per page load: honour the user's saved choice, otherwise
// default to the current project open (so its runs show + the auto-select below has something to
// pick). Runs only once — later polls must not re-expand folders the user has since collapsed.
function initExpandedState() {
  if (expandedInitialized) return;
  try {
    const raw = window.localStorage.getItem(expandedProjectsKey);
    if (raw) {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) expandedProjects = new Set(ids);
    } else if (currentProjectId) {
      expandedProjects.add(currentProjectId);
    }
  } catch {
    if (currentProjectId) expandedProjects.add(currentProjectId);
  }
  expandedInitialized = true;
}

function persistExpanded() {
  try {
    window.localStorage.setItem(expandedProjectsKey, JSON.stringify([...expandedProjects]));
  } catch {
    // LocalStorage can be unavailable in hardened browser contexts.
  }
}

// Remember which run is open across reloads. Pass a falsy id to forget the selection (home / delete
// with nothing left) so a refresh doesn't try to reopen a run the user deliberately left or removed.
function persistSelectedRun(runId) {
  try {
    if (runId) window.localStorage.setItem(selectedRunKey, runId);
    else window.localStorage.removeItem(selectedRunKey);
  } catch {
    // LocalStorage can be unavailable in hardened browser contexts.
  }
}

// Seed selectedRunId from storage exactly once per page load, BEFORE fetchData computes owesAutoSelect
// — so a saved selection wins over the "open the latest run" fallback. A stale/deleted saved id is
// handled downstream: selectRun's 404 branch clears it and lets the fallback run.
function restoreSelectedRun() {
  if (selectedRunRestored) return;
  selectedRunRestored = true;
  try {
    const stored = window.localStorage.getItem(selectedRunKey);
    if (stored) {
      selectedRunId = stored;
      restoreExpandPending = true; // expand + load its folder once, so the sidebar row highlights
    }
  } catch {
    // LocalStorage can be unavailable in hardened browser contexts.
  }
}

// Lazily load one project's run summaries. showLoader renders a compact spinner under the folder
// while the fetch is in flight; the initial batch load passes showLoader:false and renders once.
async function fetchRunsFor(projectId, { showLoader = true } = {}) {
  if (showLoader) {
    loadingProjects[projectId] = true;
    loadErrorProjects[projectId] = false;
    renderProjectTree();
  }
  try {
    const res = await fetch(`/api/runs?projectId=${encodeURIComponent(projectId)}`);
    await ensureOk(res, 'Runs request');
    runsByProject[projectId] = await res.json();
    loadErrorProjects[projectId] = false;
  } catch (err) {
    console.error('Error fetching runs for project:', projectId, err);
    // Flag the failure instead of writing an empty list — an empty [] would render as the
    // "No runs yet" empty state and hide that the fetch actually failed. Any previously loaded
    // runs are left in place so a failed background refresh keeps showing the stale list.
    loadErrorProjects[projectId] = true;
  } finally {
    loadingProjects[projectId] = false;
    if (showLoader) renderProjectTree();
  }
}

async function fetchData() {
  if (fetchInFlight) return; // a poll/refresh is already in flight — the next tick will catch up
  fetchInFlight = true;
  try {
    const res = await fetch('/api/projects');
    await ensureOk(res, 'Projects request');
    projects = await res.json();
    consecutiveProjectLoadFailures = 0; // a good load clears the failure streak

    const current = projects.find(p => p.isCurrent);
    currentProjectId = current ? current.id : (projects[0] ? projects[0].id : null);

    initExpandedState();
    restoreSelectedRun(); // must run before owesAutoSelect below so a saved run beats the latest-run fallback
    renderProjectTree();

    // Lazy refresh: only the expanded folders. Plus the current project (even if collapsed) when we
    // still owe an auto-select — its most recent run is what opens by default.
    const toFetch = new Set(expandedProjects);
    const owesAutoSelect = !selectedRunId && !homeRequested;
    if (owesAutoSelect && currentProjectId) toFetch.add(currentProjectId);
    await Promise.all([...toFetch].map(id => fetchRunsFor(id, { showLoader: false })));
    renderProjectTree();

    if (selectedRunId) {
      selectRun(selectedRunId);
    } else if (owesAutoSelect && currentProjectId) {
      const currentRuns = runsByProject[currentProjectId] || [];
      if (currentRuns.length > 0) selectRun(currentRuns[0].runId); // getRuns() orders created_at DESC
    }
  } catch (err) {
    console.error('Error fetching dashboard data:', err);
    consecutiveProjectLoadFailures++;
    // A tree that has already loaded once stays on screen through blips: wiping a usable, cached
    // list for a momentary hiccup is worse than showing slightly stale data, and the next good poll
    // refreshes it. The full error screen is only for the "nothing has ever loaded" case, and only
    // once failures persist enough to mean the server is genuinely down — not a single blip.
    const treeAlreadyShown = projects.length > 0;
    // A server-explained failure (5xx with a JSON error body, e.g. an unreadable database) is
    // persistent, not a poll blip — show the server's message right away instead of waiting out
    // the transient-failure threshold with a blank sidebar.
    if (!treeAlreadyShown && err && err.serverMessage) {
      renderRunsError(err.serverMessage, { showRetry: true });
    } else if (!treeAlreadyShown && consecutiveProjectLoadFailures >= PROJECT_LOAD_ERROR_THRESHOLD) {
      renderRunsError(apiErrorMessage('load dashboard data'), { showRetry: true });
    }
  } finally {
    fetchInFlight = false;
  }
}

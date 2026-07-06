// VS Code-style tree: every project in the local Fusion DB is a collapsible folder row; its runs
// nest underneath behind an indent guide. The launched ("current") project sorts to the top and
// opens by default. Runs load lazily per folder (see fetchRunsFor) so the tree stays light no
// matter how many projects/runs exist. Expansion survives the 5s poll re-render (module state) and
// page reloads (localStorage, via persistExpanded).
function toggleProject(projectId) {
  if (expandedProjects.has(projectId)) {
    expandedProjects.delete(projectId);
    persistExpanded();
    renderProjectTree();
    return;
  }
  expandedProjects.add(projectId);
  persistExpanded();
  if (runsByProject[projectId]) {
    renderProjectTree(); // already cached — just reveal
  } else {
    fetchRunsFor(projectId); // shows a compact loader, then re-renders with the runs
  }
}

const caretSvg = (expanded) => `
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" class="w-3 h-3 shrink-0 text-dm-text-soft transition-transform duration-150 ${expanded ? 'rotate-90' : ''}">
    <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
  </svg>`;

const folderSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4 shrink-0 text-dm-text-soft">
    <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
  </svg>`;

// Shimmer placeholders while a folder's runs load. We already know the run count from the projects
// list, so we render exactly that many rows (capped) — each row mirrors a real run row's height, so
// the swap to real content lands with no layout jump.
function skeletonRuns(runCount) {
  const n = Math.min(Math.max(runCount || 1, 1), 6);
  const rows = Array.from({ length: n }, () => `
    <div class="skeleton-run" aria-hidden="true">
      <span class="sk-shimmer sk-dot"></span>
      <span class="sk-shimmer sk-title"></span>
      <span class="sk-shimmer sk-date"></span>
    </div>`).join('');
  return `<div role="status" aria-label="Loading runs">${rows}</div>`;
}

function renderProjectChildren(project) {
  const runs = runsByProject[project.id];
  const hasRuns = runs && runs.length > 0;
  // Skeleton rows win while a fresh fetch is in flight with nothing cached to show yet.
  if (loadingProjects[project.id] && !hasRuns) {
    return skeletonRuns(project.runCount);
  }
  // Fetch failed and we have nothing cached → an explicit error + retry, never the empty state
  // (which would falsely imply the project simply has no runs).
  if (loadErrorProjects[project.id] && !hasRuns) {
    return `
      <div class="px-2.5 py-1.5 text-[11px] text-dm-text font-semibold flex items-center justify-between gap-2">
        <span>Couldn't load runs</span>
        <button type="button" onclick="fetchRunsFor('${escapeJsArg(project.id)}')" class="shrink-0 font-bold text-dm-text underline hover:text-dm-text">Retry</button>
      </div>`;
  }
  if (hasRuns) {
    return runs.map(renderRunRow).join('');
  }
  const hint = project.isCurrent
    ? ' — start one with <span class="font-mono not-italic">fusion plan</span>'
    : '';
  return `<p class="px-2.5 py-1.5 text-[11px] italic text-dm-muted">No runs yet${hint}</p>`;
}

function renderProjectNode(project) {
  const isExpanded = expandedProjects.has(project.id);
  return `
    <div class="mb-0.5">
      <button type="button" onclick="toggleProject('${escapeJsArg(project.id)}')" aria-expanded="${isExpanded}"
              class="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-bold text-dm-text hover:bg-black/5 transition-colors duration-150">
        ${caretSvg(isExpanded)}
        ${folderSvg}
        <span class="truncate flex-1 min-w-0 text-left" title="${escapeHtml(project.name)}">${escapeHtml(project.name)}</span>
        <span class="shrink-0 text-[10px] text-dm-muted font-mono">${escapeHtml(String(project.runCount))}</span>
      </button>
      ${isExpanded ? `<div class="mt-0.5 ml-3 pl-2.5 border-l border-black/15 space-y-0.5">${renderProjectChildren(project)}</div>` : ''}
    </div>`;
}

function renderProjectTree() {
  const listDiv = document.getElementById('runs-list');
  if (!listDiv) return;
  if (!projects || projects.length === 0) {
    // Fresh install / empty local DB. A centered folder glyph + heading reads as an intentional
    // empty state rather than a stray sentence, and tells the user exactly how to create the first
    // project. (Per-folder "No runs yet" stays the plain inline line — that's a leaf, not the whole view.)
    listDiv.innerHTML = `
      <div class="flex flex-col items-center text-center gap-2.5 px-5 pt-16 pb-12 text-dm-muted">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.6" stroke="currentColor" class="w-8 h-8 opacity-75" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
        </svg>
        <p class="text-[13px] font-bold text-dm-text-soft">No projects yet</p>
        <p class="text-[11px] leading-relaxed max-w-[30ch]">Run <span class="font-mono text-dm-text bg-dm-panel-beige px-1.5 py-0.5 rounded">fusion plan</span> in any repo to create your first one.</p>
      </div>`;
    return;
  }
  listDiv.innerHTML = projects.map(renderProjectNode).join('');
}

function renderRunRow(run) {
  const isSelected = run.runId === selectedRunId;
  const title = displayRunTitle(run);
  const runDate = new Date(run.createdAt);
  const timeStr = runDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase();
  const dateStr = runDate.toLocaleDateString([], { month: 'short', day: 'numeric' });

  return `
    <button type="button" onclick="selectRun('${escapeJsArg(run.runId)}')" aria-label="Open run ${escapeHtml(title)}"
            class="w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 text-xs transition-colors duration-150 ${isSelected ? 'bg-dm-panel-beige border-2 border-black font-bold shadow-[1.5px_1.5px_0px_rgba(0,0,0,1)]' : 'text-dm-text-soft hover:bg-black/5 hover:text-dm-text'}">
      <div class="flex items-center gap-2 min-w-0">
        <span class="w-1.5 h-1.5 rounded-full shrink-0 bg-dm-accent"></span>
        <span class="truncate flex-1 min-w-0" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
      </div>
      <span class="text-[10px] text-dm-muted font-mono shrink-0">${escapeHtml(dateStr)} ${escapeHtml(timeStr)}</span>
    </button>
  `;
}

function displayRunTitle(run) {
  const title = typeof run?.title === 'string' ? run.title.trim() : '';
  return title || 'Untitled run';
}

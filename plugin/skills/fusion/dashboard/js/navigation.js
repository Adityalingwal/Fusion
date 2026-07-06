// Initial load
window.addEventListener('DOMContentLoaded', () => {
  isCompactSidebarViewport = window.innerWidth < 900;
  isSidebarCollapsed = getInitialSidebarState();
  applySidebarState();

  if (location.protocol === 'file:') {
    renderRunsError(apiErrorMessage('load runs'));
    return;
  }
  fetchData();
});

window.addEventListener('resize', () => {
  const compactNow = window.innerWidth < 900;
  if (compactNow === isCompactSidebarViewport) return;
  isCompactSidebarViewport = compactNow;
  isSidebarCollapsed = compactNow ? true : getInitialSidebarState();
  applySidebarState();
});

// Keep the run list/detail fresh without a manual click: poll on a short interval while the
// tab is visible (local SQLite read — cheap).
setInterval(() => {
  if (document.visibilityState === 'visible') fetchData();
}, 5000);

function readSidebarPreference() {
  try {
    return window.localStorage.getItem(sidebarPreferenceKey);
  } catch {
    return null;
  }
}

function writeSidebarPreference(value) {
  try {
    window.localStorage.setItem(sidebarPreferenceKey, String(value));
  } catch {
    // LocalStorage can be unavailable in hardened browser contexts.
  }
}

function getInitialSidebarState() {
  if (window.innerWidth < 900) return true;
  const stored = readSidebarPreference();
  if (stored !== null) return stored === 'true';
  return false; // open by default on desktop — no hover peek anymore, toggle is click-only
}

function setSidebarCollapsed(collapsed) {
  isSidebarCollapsed = collapsed;
  if (!isCompactSidebarViewport) writeSidebarPreference(collapsed);
  applySidebarState();
}

function toggleSidebar() {
  setSidebarCollapsed(!isSidebarCollapsed);
}

function applySidebarState() {
  document.body.classList.toggle('sidebar-collapsed', isSidebarCollapsed);
  const expanded = !isSidebarCollapsed;
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const mainToggle = document.getElementById('main-sidebar-toggle');
  const label = expanded ? 'Collapse sidebar' : 'Expand sidebar';

  if (sidebar) {
    sidebar.style.left = isCompactSidebarViewport && isSidebarCollapsed ? '-22rem' : '';
  }

  if (sidebarToggle) {
    sidebarToggle.setAttribute('aria-expanded', String(expanded));
    sidebarToggle.setAttribute('aria-label', label);
    sidebarToggle.setAttribute('title', label);
  }

  if (mainToggle) {
    mainToggle.setAttribute('aria-expanded', String(expanded));
    mainToggle.setAttribute('aria-label', expanded ? 'Sidebar open' : 'Open sidebar');
    mainToggle.setAttribute('title', expanded ? 'Sidebar open' : 'Open sidebar');
  }

  // The mobile top strip has its own toggle instance — keep its a11y state in sync too.
  const topbarToggle = document.getElementById('mobile-topbar-toggle');
  if (topbarToggle) {
    topbarToggle.setAttribute('aria-expanded', String(expanded));
    topbarToggle.setAttribute('aria-label', expanded ? 'Sidebar open' : 'Open sidebar');
    topbarToggle.setAttribute('title', expanded ? 'Sidebar open' : 'Open sidebar');
  }
}

function switchTab(tabId) {
  currentTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('tab-active');
    btn.classList.add('tab-idle');
  });
  const activeBtn = document.getElementById(`tab-${tabId}`);
  if (activeBtn) {
    activeBtn.classList.remove('tab-idle');
    activeBtn.classList.add('tab-active');
  }

  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  document.getElementById(`content-${tabId}`).classList.remove('hidden');
}

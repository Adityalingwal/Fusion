// Shared state and class tokens for the dashboard scripts.

// State variables
let projects = [];              // [{ id, name, isCurrent, runCount, lastActivity }] — current project first
let currentProjectId = null;    // id of the project the dashboard was launched from (isCurrent)
let runsByProject = {};         // projectId -> RunSummary[] — lazily filled when a folder is expanded
let loadingProjects = {};       // projectId -> bool — true while that folder's runs are being fetched
let loadErrorProjects = {};     // projectId -> bool — true when the last run fetch failed (distinct from an empty project)
let expandedProjects = new Set(); // ids of expanded project folders (persisted to localStorage)
let expandedInitialized = false;  // one-time: seed expandedProjects from storage / default on first load
let selectedRunId = null;
let selectedRunData = null;
// One-time on first load: seed selectedRunId from localStorage so a refresh reopens the run the user
// was on, instead of the auto-select falling back to the current project's latest ("top") run.
let selectedRunRestored = false;
// Set when the seeded selection came from storage. Consumed once in selectRun to expand + load that
// run's project folder (it may live in a collapsed / non-current folder) so its sidebar row shows as
// selected. NOT done on ordinary clicks/poll re-selects — those must respect the user's collapse choices.
let restoreExpandPending = false;
// F7 no-change guard: the runId + paint-signature we last rendered into the detail panel, so the
// 5s poll can skip re-writing identical innerHTML (which would wipe an in-progress text selection).
let lastRenderedRunId = null;
let lastRenderedSignature = null;
let currentTab = 'brief';
let isSidebarCollapsed = false;
let isCompactSidebarViewport = false;
// True once the user explicitly goes "home" (clicking the Fusion wordmark) — blocks the
// auto-refresh poll from yanking them back into a run they deliberately navigated away from.
let homeRequested = false;
const sidebarPreferenceKey = 'fusion:sidebar-collapsed';
const expandedProjectsKey = 'fusion:expanded-projects';
const selectedRunKey = 'fusion:selected-run';

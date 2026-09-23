// Source unique de vérité pour la version de l'application
window.DOCSEEKER_VERSION = (typeof document !== 'undefined' && document.querySelector('meta[name="app-version"]')?.getAttribute('content')) || '8.6';

document.addEventListener("DOMContentLoaded", () => {
  // =========================================================================
  // Helper Réseau Sécurisé (Immunité WHATWG contre URL credentials)
  // =========================================================================
  function cleanOrigin() {
    return window.location.protocol + "//" + window.location.host;
  }

  async function apiFetch(input, init) {
    let cleanInput = input;
    if (typeof input === "string" && input.startsWith("/")) {
      cleanInput = cleanOrigin() + input;
    }
    const res = await fetch(cleanInput, init);
    if (res.status === 401 && !cleanInput.includes("/api/auth/")) {
      showLoginModal("Session expirée. Veuillez vous reconnecter.");
    }
    return res;
  }

  // =========================================================================
  // Éléments DOM
  // =========================================================================
  const searchInput = document.getElementById("searchInput");
  const clearSearchBtn = document.getElementById("clearSearchBtn");
  const searchStats = document.getElementById("searchStats");
  const workspace = document.getElementById("workspace");
  const resultsPane = document.getElementById("resultsPane");
  const generalView = document.getElementById("generalView");
  const docDetailView = document.getElementById("docDetailView");
  const resultsContainer = document.getElementById("resultsContainer");
  const sectionTitle = document.getElementById("sectionTitle");
  const emptyState = document.getElementById("emptyState");
  const emptyMessage = document.getElementById("emptyMessage");
  const brandBtn = document.getElementById("brandBtn");

  // Filtres de recherche
  const filterTitlesOnly = document.getElementById("filterTitlesOnly");
  const filterTitlesChip = document.getElementById("filterTitlesChip");
  const filterCurrentFolderOnly = document.getElementById("filterCurrentFolderOnly");
  const filterFolderChip = document.getElementById("filterFolderChip");
  const filterFolderLabel = document.getElementById("filterFolderLabel");
  const filterOfflineOnly = document.getElementById("filterOfflineOnly");
  const offlineNoticeBanner = document.getElementById("offlineNoticeBanner");

  // =========================================================================
  // État Global de l'Application (Déclaré au sommet pour éliminer le TDZ)
  // =========================================================================
  let debounceTimer = null;
  let docSearchDebounceTimer = null;
  let currentSearchQuery = "";
  let currentActiveDocId = null;
  let currentActiveDocTitle = "";
  let currentDocOriginalOccurrences = [];
  let savedGeneralResultsScrollTop = 0;
  let isRestoringScroll = false;
  let currentFolderId = null; // null = racine
  let currentFolderName = "Documents";
  let folderBreadcrumbs = [{ id: null, name: "Documents" }];
  let allFolders = [];
  let currentLoadedDocs = [];
  let rawLoadedDocs = [];
  let lastSearchResultsData = null;
  let selectedFolderColor = "#3b82f6";
  let currentSortMode = "name_asc";
  let userManuallyChangedSort = false;
  let isSearchActive = false;
  let loadFoldersSeq = 0;
  let isNavigatingFolder = false;

  class OfflineCropRenderer {
    constructor() {
      this.worker = null;
      this.reqId = 0;
      this.callbacks = new Map();
      this.initWorker();
    }

    initWorker() {
      if (this.worker) {
        try { this.worker.terminate(); } catch (e) {}
      }
      this.callbacks.clear();
      if (typeof Worker !== 'undefined') {
        const v = window.DOCSEEKER_VERSION || '8.6';
        this.worker = new Worker(`/crop-worker.js?v=${v}`, { type: 'module' });
        this.worker.onmessage = (e) => {
          const { id, success, blob, error, code } = e.data;
          if (this.callbacks.has(id)) {
            const { resolve, reject } = this.callbacks.get(id);
            this.callbacks.delete(id);
            if (success) {
              resolve(blob);
            } else {
              const err = new Error(error);
              err.code = code;
              reject(err);
            }
          }
        };
        this.worker.onerror = (err) => {
          console.warn('[OfflineCropRenderer] Worker error:', err);
          for (const [, { resolve }] of this.callbacks.entries()) {
            resolve(null);
          }
          this.callbacks.clear();
        };
      }
    }

    reinitializeWorker() {
      console.log('[OfflineCropRenderer] Réinitialisation du Worker de crop avec la version', window.DOCSEEKER_VERSION);
      this.initWorker();
    }

    clearQueue() {
      if (this.worker) {
        this.worker.postMessage({ type: 'CLEAR_QUEUE' });
      }
      for (const [, { resolve }] of this.callbacks.entries()) {
        resolve(null);
      }
      this.callbacks.clear();
    }

    cancelTask(id) {
      if (!id) return;
      if (this.worker) {
        this.worker.postMessage({ type: 'CANCEL_TASK', payload: { id } });
      }
      if (this.callbacks.has(id)) {
        const { resolve } = this.callbacks.get(id);
        this.callbacks.delete(id);
        resolve({ cancelled: true });
      }
    }

    async renderAndCache(docId, pageNumber, highlightRects, rect, cropUrl, isOffline = false, onReqIdAssigned = null) {
      const cropCacheKey = cropUrl || `/api/crop/${docId}/${pageNumber}/0`;

      // 1. Vérification immédiate dans CacheStorage (0ms, évite tout calcul PDF redondant)
      if (typeof caches !== 'undefined') {
        try {
          const cache = await caches.open('docseeker_offline_crops_v2');
          const cached = await cache.match(cropCacheKey);
          if (cached) {
            const blob = await cached.blob();
            if (blob && blob.size > 0) return blob;
          }
        } catch (e) {}
      }

      if (!this.worker) return null;
      const id = ++this.reqId;
      if (typeof onReqIdAssigned === 'function') {
        onReqIdAssigned(id);
      }
      const blobPromise = new Promise((resolve, reject) => {
        this.callbacks.set(id, { resolve, reject });
        this.worker.postMessage({
          id,
          type: 'RENDER_CROP',
          payload: { docId, pageNumber, highlightRects, rect, isOffline }
        });
      });

      const blob = await blobPromise;
      if (blob && typeof caches !== 'undefined') {
        try {
          const cache = await caches.open('docseeker_offline_crops_v2');
          const response = new Response(blob, {
            headers: {
              'Content-Type': 'image/webp',
              'Cache-Control': 'public, max-age=604800, immutable'
            }
          });
          await cache.put(cropCacheKey, response);
        } catch (e) {}
      }
      return blob;
    }
  }

  const offlineCropRenderer = new OfflineCropRenderer();
  window.offlineCropRenderer = offlineCropRenderer;

  // Navigation par dossiers & fil d'Ariane
  const breadcrumbsNav = document.getElementById("breadcrumbsNav");
  const foldersSection = document.getElementById("foldersSection");
  const foldersContainer = document.getElementById("foldersContainer");
  const syncDocsBtn = document.getElementById("syncDocsBtn");
  const newFolderBtn = document.getElementById("newFolderBtn");
  const pasteClipboardBtn = document.getElementById("pasteClipboardBtn");
  const pasteClipboardText = document.getElementById("pasteClipboardText");

  // Barre d'actions multi-sélection
  const selectionActionBar = document.getElementById("selectionActionBar");
  const selectionCountText = document.getElementById("selectionCountText");
  const batchMoveBtn = document.getElementById("batchMoveBtn");
  const batchCutBtn = document.getElementById("batchCutBtn");
  const batchCacheBtn = document.getElementById("batchCacheBtn");
  const batchUncacheBtn = document.getElementById("batchUncacheBtn");
  const batchDeleteBtn = document.getElementById("batchDeleteBtn");
  const clearSelectionBtn = document.getElementById("clearSelectionBtn");

  // Vues Déroulé Vertical Document (Split View)
  const backToResultsBtn = document.getElementById("backToResultsBtn");
  const docDetailTitle = document.getElementById("docDetailTitle");
  const docDetailCount = document.getElementById("docDetailCount");
  const docOccurrencesList = document.getElementById("docOccurrencesList");
  const docSearchInput = document.getElementById("docSearchInput");
  const clearDocSearchBtn = document.getElementById("clearDocSearchBtn");

  // Visualiseur Latéral
  const viewerPane = document.getElementById("viewerPane");
  const viewerDocTitle = document.getElementById("viewerDocTitle");
  const viewerPageBadge = document.getElementById("viewerPageBadge");
  const pdfFrame = document.getElementById("pdfFrame");
  const closeViewerBtn = document.getElementById("closeViewerBtn");
  const viewerBackBtn = document.getElementById("viewerBackBtn");
  const mobileOccurrencesBtn = document.getElementById("mobileOccurrencesBtn");
  const mobileOccurrencesCountText = document.getElementById("mobileOccurrencesCountText");
  const splitResizer = document.getElementById("splitResizer");
  const toggleSelectionModeBtn = document.getElementById("toggleSelectionModeBtn");

  // Recherche Interne au Document (Header Viewer & Tiroir Mobile)
  const viewerDocSearchToggleBtn = document.getElementById("viewerDocSearchToggleBtn");
  const viewerDocSearchWrapper = document.getElementById("viewerDocSearchWrapper");
  const viewerDocSearchInput = document.getElementById("viewerDocSearchInput");
  const viewerDocSearchClearBtn = document.getElementById("viewerDocSearchClearBtn");
  const viewerDocSearchResultCount = document.getElementById("viewerDocSearchResultCount");
  const viewerDocSearchCloseBtn = document.getElementById("viewerDocSearchCloseBtn");

  // Stepper d'occurrences (Navigation directe Suivant / Précédent)
  const occurrenceStepper = document.getElementById("occurrenceStepper");
  const occurrenceCounter = document.getElementById("occurrenceCounter");
  const prevOccBtn = document.getElementById("prevOccBtn");
  const nextOccBtn = document.getElementById("nextOccBtn");
  const searchStepperMini = document.getElementById("searchStepperMini");
  const searchPrevBtn = document.getElementById("searchPrevBtn");
  const searchNextBtn = document.getElementById("searchNextBtn");

  let currentActiveOccurrences = [];
  let currentActiveOccurrenceIndex = -1;

  // =========================================================================
  // État de Recherche Intra-Document — Propriétaire : l'ONGLET (tabManager).
  // Chaque onglet porte searchQuery / occurrences / searchActive /
  // activeOccurrenceIndex. Les variables ci-dessus ne sont que la PROJECTION
  // de l'état de l'onglet actif vers les vues (stepper, volet, tiroir).
  // Flux unique : onglet → projection → DOM. Aucun héritage inter-documents.
  // =========================================================================
  function getActiveTab() {
    return (typeof tabManager !== 'undefined' && tabManager.activeTabId)
      ? tabManager.openTabs.find(t => t.id === tabManager.activeTabId) || null
      : null;
  }

  // Terme de recherche intra-document de l'onglet actif (jamais le global)
  function getActiveDocSearchTerm() {
    return (getActiveTab()?.searchQuery || '').trim();
  }

  // Dernier terme projeté vers PDF.js (anti-doublon de dispatch 'find')
  let _projectedTabSearchQuery = null;

  // Projeter l'état de recherche de l'onglet actif vers les vues (canal 3)
  function projectTabSearchToActive() {
    const tab = getActiveTab();
    if (!tab) return;
    const searchChanged = tab.searchQuery !== _projectedTabSearchQuery;
    currentDocOriginalOccurrences = tab.occurrences || [];
    currentActiveOccurrences = sortDocOccurrences(tab.occurrences || [], currentDocOccurrencesSortMode);
    if (Number.isInteger(tab.activeOccurrenceIndex) && tab.activeOccurrenceIndex >= 0 && tab.activeOccurrenceIndex < currentActiveOccurrences.length) {
      currentActiveOccurrenceIndex = tab.activeOccurrenceIndex;
    } else {
      currentActiveOccurrenceIndex = currentActiveOccurrences.length > 0 ? 0 : -1;
      tab.activeOccurrenceIndex = currentActiveOccurrenceIndex;
    }
    syncDocSearchInputs(tab.searchQuery || "");
    if (searchChanged) {
      _projectedTabSearchQuery = tab.searchQuery || "";
      updateViewerSearchHighlight(tab.searchQuery || "");
    }
  }

  // Tiroir Mobile d'extraits
  const mobileDrawerOverlay = document.getElementById("mobileDrawerOverlay");
  const mobileOccurrencesDrawer = document.getElementById("mobileOccurrencesDrawer");
  const closeDrawerBtn = document.getElementById("closeDrawerBtn");
  const drawerDocTitle = document.getElementById("drawerDocTitle");
  const drawerDocCount = document.getElementById("drawerDocCount");
  const drawerOccurrencesList = document.getElementById("drawerOccurrencesList");
  const drawerDocSearchInput = document.getElementById("drawerDocSearchInput");
  const drawerDocSearchClearBtn = document.getElementById("drawerDocSearchClearBtn");

  // Menu Contextuel Universel
  const cardContextMenu = document.getElementById("cardContextMenu");
  const contextMenuTitle = document.getElementById("contextMenuTitle");
  const ctxMenuRename = document.getElementById("ctxMenuRename");
  const ctxMenuMove = document.getElementById("ctxMenuMove");
  const ctxMenuReindex = document.getElementById("ctxMenuReindex");
  const ctxMenuDelete = document.getElementById("ctxMenuDelete");

  // Upload Modal
  const openUploadBtn = document.getElementById("openUploadBtn");
  const uploadModal = document.getElementById("uploadModal");
  const closeUploadModalBtn = document.getElementById("closeUploadModalBtn");
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");
  const docTitleInput = document.getElementById("docTitleInput");
  const uploadProgressContainer = document.getElementById("uploadProgressContainer");
  const uploadProgressBar = document.getElementById("uploadProgressBar");
  const uploadStatusText = document.getElementById("uploadStatusText");

  // Pipeline Badge & Background Polling
  const pipelineStatusBadge = document.getElementById("pipelineStatusBadge");
  const pipelineStatusText = document.getElementById("pipelineStatusText");
  let pipelinePollingInterval = null;
  let isPipelineActive = false;

  // Duplicate Modal
  const duplicateModal = document.getElementById("duplicateModal");
  const closeDuplicateModalBtn = document.getElementById("closeDuplicateModalBtn");
  const duplicateTitle = document.getElementById("duplicateTitle");
  const duplicateFilename = document.getElementById("duplicateFilename");
  const duplicateDate = document.getElementById("duplicateDate");
  const confirmDuplicateOkBtn = document.getElementById("confirmDuplicateOkBtn");

  // Folder Modal
  const folderModal = document.getElementById("folderModal");
  const folderModalTitle = document.getElementById("folderModalTitle");
  const closeFolderModalBtn = document.getElementById("closeFolderModalBtn");
  const cancelFolderModalBtn = document.getElementById("cancelFolderModalBtn");
  const saveFolderBtn = document.getElementById("saveFolderBtn");
  const folderNameInput = document.getElementById("folderNameInput");
  const colorPicker = document.getElementById("colorPicker");

  // Move Doc Modal
  const moveDocModal = document.getElementById("moveDocModal");
  const moveDocModalTitle = document.getElementById("moveDocModalTitle");
  const moveDocCurrentName = document.getElementById("moveDocCurrentName");
  const closeMoveDocModalBtn = document.getElementById("closeMoveDocModalBtn");
  const cancelMoveDocBtn = document.getElementById("cancelMoveDocBtn");
  const confirmMoveDocBtn = document.getElementById("confirmMoveDocBtn");
  const folderSelectList = document.getElementById("folderSelectList");
  const modalCreateNewFolderBtn = document.getElementById("modalCreateNewFolderBtn");

  // Rename Doc Modal
  const renameDocModal = document.getElementById("renameDocModal");
  const closeRenameDocModalBtn = document.getElementById("closeRenameDocModalBtn");
  const cancelRenameDocBtn = document.getElementById("cancelRenameDocBtn");
  const confirmRenameDocBtn = document.getElementById("confirmRenameDocBtn");
  const renameDocInput = document.getElementById("renameDocInput");
  let docIdToRename = null;

  // Toast Container
  const toastContainer = document.getElementById("toastContainer");

  // Volet Latéral Coulissant de Navigation Globale (Accueil)
  const mainSidebarToggleBtn = document.getElementById("mainSidebarToggleBtn");
  const mainSidebarDrawer = document.getElementById("mainSidebarDrawer");
  const mainSidebarOverlay = document.getElementById("mainSidebarOverlay");
  const closeMainSidebarBtn = document.getElementById("closeMainSidebarBtn");
  const navBtnDocuments = document.getElementById("navBtnDocuments");
  const navBtnDownloads = document.getElementById("navBtnDownloads");
  const navBtnSettings = document.getElementById("navBtnSettings");
  const navDownloadsBadge = document.getElementById("navDownloadsBadge");

  // Vues Principales
  const viewDocuments = document.getElementById("resultsPane");
  const viewDownloads = document.getElementById("viewDownloads");
  const viewSettings = document.getElementById("viewSettings");

  // Reader Goodnotes
  const readerTopTabBar = document.getElementById("readerTopTabBar");
  const readerHomeBtn = document.getElementById("readerHomeBtn");
  const readerTabsStrip = document.getElementById("readerTabsStrip");
  const readerSidebarToggleBtn = document.getElementById("readerSidebarToggleBtn");
  const readerFitToWidthBtn = document.getElementById("readerFitToWidthBtn");
  const readerShareBtn = document.getElementById("readerShareBtn");
  const occurrenceQueryBadge = document.getElementById("occurrenceQueryBadge");
  const inDocSearchDrawer = document.getElementById("inDocSearchDrawer");
  const inDocDrawerSearchInput = document.getElementById("inDocDrawerSearchInput");
  const inDocDrawerClearBtn = document.getElementById("inDocDrawerClearBtn");
  const inDocDrawerCount = document.getElementById("inDocDrawerCount");
  const inDocDrawerOccurrencesList = document.getElementById("inDocDrawerOccurrencesList");
  const inDocSortByPageBtn = document.getElementById("inDocSortByPageBtn");
  const inDocSortByRelevanceBtn = document.getElementById("inDocSortByRelevanceBtn");
  const inDocDrawerCloseBtn = document.getElementById("inDocDrawerCloseBtn");
  const tabDocInfoPopover = document.getElementById("tabDocInfoPopover");
  const closePopoverDocBtn = document.getElementById("closePopoverDocBtn");
  const networkStatusPill = document.getElementById("networkStatusPill");
  const networkDot = document.getElementById("networkDot");
  const networkLabel = document.getElementById("networkLabel");

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 Ko";
    const k = 1024;
    const sizes = ["Octets", "Ko", "Mo", "Go"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  // =========================================================================
  // État de l'Application (Variables déclarées au sommet)
  // =========================================================================

  // Tri des documents et résultats
  const sortSelect = document.getElementById("sortSelect");
  const sortPillCurrent = document.getElementById("sortPillCurrent");

  function updateSortPillLabel() {
    if (sortPillCurrent && sortSelect && sortSelect.selectedOptions && sortSelect.selectedOptions[0]) {
      sortPillCurrent.textContent = sortSelect.selectedOptions[0].textContent;
    }
  }

  const PLACEHOLDER_CROP_SVG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22250%22 height=%22125%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23f1f5f9%22/%3E%3C/svg%3E";
  const PLACEHOLDER_COVER_SVG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22150%22 height=%22200%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23f1f5f9%22/%3E%3C/svg%3E";

  // =========================================================================
  // =========================================================================
  // Gestionnaire de Chargement Prioritaire Dynamique avec Debounce au défilement
  // pour la grille principale et le volet latéral
  // =========================================================================
  class DynamicCropManager {
    constructor(rootMargin = "180px 0px", debounceMs = 60) {
      this.rootMargin = rootMargin;
      this.debounceMs = debounceMs;
      this.pendingDebounce = new Map(); // img element -> timerId
      this.inFlightFetches = new Map(); // img element -> AbortController
      this._blobUrls = new Set();       // blob: URLs créées (pour révocation à clear())
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          const img = entry.target;
          if (entry.isIntersecting) {
            this.scheduleLoad(img);
          } else {
            this.cancelPending(img);
            if (img.dataset.loaded !== "true") {
              if (this.inFlightFetches.has(img)) {
                img._wasCancelled = true;
                const ctrl = this.inFlightFetches.get(img);
                try { ctrl.abort(); } catch (_) {}
                this.inFlightFetches.delete(img);
                img.dataset.loaded = "false";
              }
            }
          }
        });
      }, {
        rootMargin: this.rootMargin,
        threshold: 0.01
      });
    }

    observe(img) {
      if (!img) return;
      if (img.dataset.loaded === "true") {
        img.style.opacity = "1";
        return;
      }
      this.observer.observe(img);
    }

    cancelPending(img) {
      if (this.pendingDebounce.has(img)) {
        clearTimeout(this.pendingDebounce.get(img));
        this.pendingDebounce.delete(img);
      }
      if (img._cropReqId) {
        if (window.offlineCropRenderer) {
          window.offlineCropRenderer.cancelTask(img._cropReqId);
        }
        img._cropReqId = null;
      }
      if (this.inFlightFetches && this.inFlightFetches.has(img)) {
        img._wasCancelled = true;
        const ctrl = this.inFlightFetches.get(img);
        try { ctrl.abort(); } catch (_) {}
        this.inFlightFetches.delete(img);
      }
      if (img.dataset.loaded !== "true") {
        img._wasCancelled = true;
        img.dataset.loaded = "false";
      }
    }

    scheduleLoad(img) {
      img._wasCancelled = false;
      if (img.dataset.loaded === "true") return;
      if (this.pendingDebounce.has(img)) {
        clearTimeout(this.pendingDebounce.get(img));
      }
      const timer = setTimeout(() => {
        this.pendingDebounce.delete(img);
        this.loadImg(img);
      }, this.debounceMs);
      this.pendingDebounce.set(img, timer);
    }

    applySnippetFallback(img, vEl) {
      if (!vEl) {
        img.dataset.loaded = "false";
        return;
      }
      if (vEl.querySelector('.vignette-snippet-fallback')) {
        img.style.display = 'none';
        img.dataset.loaded = "true";
        return;
      }
      const snippetRaw = vEl.getAttribute('data-snippet');
      let snippet = '';
      try { snippet = snippetRaw ? decodeURIComponent(snippetRaw) : ''; } catch (_) {}
      if (snippet) {
        const fallbackDiv = document.createElement('div');
        fallbackDiv.className = 'vignette-snippet-fallback';
        const highlightedText = (typeof currentSearchQuery !== 'undefined' && currentSearchQuery) 
          ? highlightTitle(snippet, currentSearchQuery) 
          : escapeHtml(snippet);
        fallbackDiv.innerHTML = `<div class="vignette-snippet-text">${highlightedText}</div>`;
        const badge = vEl.querySelector('.vignette-page-badge');
        if (badge) {
          vEl.insertBefore(fallbackDiv, badge);
        } else {
          vEl.appendChild(fallbackDiv);
        }
        img.style.display = 'none';
        img.dataset.loaded = "true";
      } else {
        img.dataset.loaded = "false";
      }
    }

    loadImg(img) {
      const srcUrl = img.getAttribute("data-src");
      if (!srcUrl || img.dataset.loaded === "true") return;

      img._wasCancelled = false;
      if (this.pendingDebounce.has(img)) {
        clearTimeout(this.pendingDebounce.get(img));
        this.pendingDebounce.delete(img);
      }

      const vEl = img.closest('.vignette-item') || img.closest('.vertical-occ-card');
      const docId = vEl && vEl.dataset.docId ? Number(vEl.dataset.docId) : null;
      const isDocCached = Boolean(docId && window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(docId));
      const isOfflineFilter = document.getElementById("filterOfflineOnly")?.checked || false;
      const isOfflineMode = !navigator.onLine || isOfflineFilter || isDocCached;

      const renderOfflineCrop = () => {
        if (srcUrl.startsWith('/api/crop/') && window.offlineCropRenderer) {
          if (vEl && docId) {
            const pageNum = Number(vEl.dataset.page);
            let rect = [];
            let hlRects = [];
            try { rect = JSON.parse(vEl.dataset.rect || '[]'); } catch (e) {}
            try { hlRects = JSON.parse(vEl.dataset.hlRects || '[]'); } catch (e) {}
            if (!hlRects || hlRects.length === 0) {
              if (rect && rect.length === 4) hlRects = [rect];
            }
            if (rect && rect.length === 4) {
              window.offlineCropRenderer.renderAndCache(docId, pageNum, hlRects, rect, srcUrl, isOfflineMode, (id) => {
                img._cropReqId = id;
              }).then(blob => {
                img._cropReqId = null;
                if (img._wasCancelled || (blob && blob.cancelled)) {
                  img.dataset.loaded = "false";
                  return;
                }
                if (blob && blob instanceof Blob) {
                  // Révoquer l'ancienne blob URL de cet élément si elle existait
                  if (img._blobUrl) {
                    URL.revokeObjectURL(img._blobUrl);
                    this._blobUrls.delete(img._blobUrl);
                  }
                  const blobUrl = URL.createObjectURL(blob);
                  img._blobUrl = blobUrl;
                  this._blobUrls.add(blobUrl);
                  img.src = blobUrl;
                  img.dataset.loaded = "true";
                  img.style.display = "block";
                  img.style.opacity = "1";
                  try { this.observer.unobserve(img); } catch (e) {}
                } else {
                  this.applySnippetFallback(img, vEl);
                  try { this.observer.unobserve(img); } catch (e) {}
                }
              }).catch(err => {
                img._cropReqId = null;
                if (img._wasCancelled) {
                  img.dataset.loaded = "false";
                  return;
                }
                const isExpectedOffline = (err?.code === 'PDF_OFFLINE_UNAVAILABLE' || isOfflineMode || !navigator.onLine);
                if (!isExpectedOffline) {
                  console.warn('[DynamicCropManager] offlineCropRenderer error:', err);
                }
                this.applySnippetFallback(img, vEl);
                try { this.observer.unobserve(img); } catch (e) {}
              });
              return true;
            }
          }
        }
        return false;
      };

      // Si hors-ligne OU si le document est disponible en cache local, déléguer immédiatement au crop worker local
      if ((isOfflineMode || isDocCached) && srcUrl.startsWith('/api/crop/')) {
        if (renderOfflineCrop()) return;
      }

      // Requête réseau en ligne avec annulation AbortController au défilement
      const controller = new AbortController();
      this.inFlightFetches.set(img, controller);

      fetch(srcUrl, { signal: controller.signal })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        })
        .then(blob => {
          this.inFlightFetches.delete(img);
          if (img._wasCancelled) {
            img.dataset.loaded = "false";
            return;
          }
          if (img._blobUrl) {
            URL.revokeObjectURL(img._blobUrl);
            this._blobUrls.delete(img._blobUrl);
          }
          const blobUrl = URL.createObjectURL(blob);
          img._blobUrl = blobUrl;
          this._blobUrls.add(blobUrl);
          img.src = blobUrl;
          img.dataset.loaded = "true";
          img.style.opacity = "1";
          try { this.observer.unobserve(img); } catch (e) {}
        })
        .catch(err => {
          this.inFlightFetches.delete(img);
          if (err.name === 'AbortError' || img._wasCancelled) {
            img.dataset.loaded = "false";
            return;
          }

          if (renderOfflineCrop()) return;

          const vEl = img.closest('.vignette-item') || img.closest('.vertical-occ-card');
          if (isOfflineMode && vEl) {
            this.applySnippetFallback(img, vEl);
            try { this.observer.unobserve(img); } catch (e) {}
            return;
          }

          // En cas d'erreur standard, réessayer une fois après 500ms
          if (!img.dataset.retried) {
            img.dataset.retried = "true";
            setTimeout(() => {
              this.loadImg(img);
            }, 500);
          } else if (vEl) {
            this.applySnippetFallback(img, vEl);
            try { this.observer.unobserve(img); } catch (e) {}
          }
        });
    }

    clear() {
      for (const [, timer] of this.pendingDebounce.entries()) {
        clearTimeout(timer);
      }
      this.pendingDebounce.clear();
      if (this.inFlightFetches) {
        for (const [, ctrl] of this.inFlightFetches.entries()) {
          try { ctrl.abort(); } catch (e) {}
        }
        this.inFlightFetches.clear();
      }
      // Révoquer toutes les blob: URLs de la session précédente pour libérer la mémoire
      for (const url of this._blobUrls) {
        try { URL.revokeObjectURL(url); } catch (e) {}
      }
      this._blobUrls.clear();
      if (window.offlineCropRenderer) {
        window.offlineCropRenderer.clearQueue();
      }
    }
  }

  const verticalCropManager = new DynamicCropManager("180px 0px");
  const mainGridCropManager = new DynamicCropManager("200px 300px");

  // Sélection multiple & Presse-papier
  let selectedDocIds = new Set();
  let lastSelectedDocId = null;
  let clipboardDocIds = [];
  let isSelectionModeActive = false;

  // État du menu contextuel flottant
  let activeContextMenuDoc = null;

  // =========================================================================
  // Pipeline d'Indexation en Arrière-Plan & Polling
  // =========================================================================
  let currentPollingDelay = 10000; // 10 secondes par défaut au repos

  async function checkPipelineStatus() {
    if (navigator.onLine === false) return;
    try {
      const res = await fetch("/api/pipeline/status");
      if (!res.ok) return;
      const data = await res.json();

      const isProcessing = Boolean(data.is_processing || (data.queue_length > 0) || data.current_job);
      const remaining = (data.queue_length || 0) + (data.current_job ? 1 : 0);

      // Adapter la cadence de polling : 5s pendant une indexation active, 10s au repos
      // (2s était trop agressif : un wakeup CPU + requête réseau toutes les 2s pendant l'indexation)
      const targetDelay = isProcessing ? 5000 : 10000;
      if (targetDelay !== currentPollingDelay) {
        currentPollingDelay = targetDelay;
        if (pipelinePollingInterval) {
          clearInterval(pipelinePollingInterval);
          pipelinePollingInterval = setInterval(checkPipelineStatus, currentPollingDelay);
        }
      }

      if (isProcessing) {
        isPipelineActive = true;
        if (pipelineStatusBadge) {
          pipelineStatusBadge.style.display = "inline-flex";
          if (pipelineStatusText) {
            pipelineStatusText.textContent = remaining > 1 
              ? `Indexation : ${remaining} restants...` 
              : (data.current_job ? `Indexation de ${data.current_job.title || data.current_job.filename}...` : "Indexation...");
          }
        }
      } else {
        if (isPipelineActive) {
          // Vient tout juste de se terminer !
          isPipelineActive = false;
          if (pipelineStatusBadge) {
            pipelineStatusBadge.style.display = "inline-flex";
            if (pipelineStatusText) {
              pipelineStatusText.textContent = "✅ Indexation terminée";
            }
            setTimeout(() => {
              if (!isPipelineActive && pipelineStatusBadge) {
                pipelineStatusBadge.style.display = "none";
              }
            }, 3500);
          }
          // Rafraîchir les documents sans perdre le focus
          if (!currentSearchQuery) {
            loadFoldersAndDocuments();
          }
        } else {
          if (pipelineStatusBadge && !isPipelineActive) {
            pipelineStatusBadge.style.display = "none";
          }
        }
      }
    } catch (err) {
      if (navigator.onLine !== false) {
        console.warn("Erreur vérification statut pipeline:", err);
      }
    }
  }

  function startPipelinePolling(delay = null) {
    if (delay) currentPollingDelay = delay;
    checkPipelineStatus();
    if (pipelinePollingInterval) {
      clearInterval(pipelinePollingInterval);
    }
    pipelinePollingInterval = setInterval(checkPipelineStatus, currentPollingDelay);
  }

  function stopPipelinePolling() {
    if (pipelinePollingInterval) {
      clearInterval(pipelinePollingInterval);
      pipelinePollingInterval = null;
    }
  }

  // =========================================================================
  // Menu Contextuel Universel (•••)
  // =========================================================================
  function openDocContextMenu(e, docId, docTitle) {
    e.stopPropagation();
    activeContextMenuDoc = { id: docId, title: docTitle };
    if (contextMenuTitle) {
      contextMenuTitle.textContent = docTitle;
    }

    const ctxMenuToggleCache = document.getElementById("ctxMenuToggleCache");
    const ctxMenuToggleCacheText = document.getElementById("ctxMenuToggleCacheText");
    if (ctxMenuToggleCache && ctxMenuToggleCacheText && window.downloadQueueManager) {
      const isCached = window.downloadQueueManager.isDocumentCached(docId);
      const isTaskActive = window.downloadQueueManager.activeTasks.has(docId);
      const isTaskQueued = window.downloadQueueManager.queue.includes(docId);
      const stats = window.pdfCacheManager ? window.pdfCacheManager.progressCache.get(docId) : null;
      const hasChunks = Boolean(stats && stats.downloadedBytes > 0);
      const canDelete = isCached || isTaskActive || isTaskQueued || hasChunks;

      if (canDelete) {
        ctxMenuToggleCacheText.textContent = "Supprimer du cache local";
        ctxMenuToggleCache.classList.add("danger");
      } else {
        ctxMenuToggleCacheText.textContent = "Mettre en cache local";
        ctxMenuToggleCache.classList.remove("danger");
      }
    }

    if (!cardContextMenu) return;

    cardContextMenu.style.display = "flex";
    const popoverWidth = 195;
    const popoverHeight = 190;

    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();

    let left = rect.right - popoverWidth;
    if (left < 10) left = 10;
    if (left + popoverWidth > window.innerWidth - 10) {
      left = window.innerWidth - popoverWidth - 10;
    }

    let top = rect.bottom + 4;
    if (top + popoverHeight > window.innerHeight - 10) {
      top = rect.top - popoverHeight - 4;
    }

    cardContextMenu.style.left = `${left}px`;
    cardContextMenu.style.top = `${top}px`;
  }

  function closeContextMenu() {
    if (cardContextMenu) {
      cardContextMenu.style.display = "none";
      activeContextMenuDoc = null;
    }
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#cardContextMenu") && !e.target.closest(".doc-menu-trigger-btn")) {
      closeContextMenu();
    }
  });

  window.addEventListener("resize", closeContextMenu);
  window.addEventListener("scroll", closeContextMenu, true);

  if (ctxMenuRename) {
    ctxMenuRename.addEventListener("click", () => {
      if (!activeContextMenuDoc) return;
      const { id, title } = activeContextMenuDoc;
      closeContextMenu();
      openRenameModal(id, title);
    });
  }

  if (ctxMenuMove) {
    ctxMenuMove.addEventListener("click", () => {
      if (!activeContextMenuDoc) return;
      const { id } = activeContextMenuDoc;
      closeContextMenu();
      openBatchMoveModal([id]);
    });
  }

  if (ctxMenuReindex) {
    ctxMenuReindex.addEventListener("click", () => {
      if (!activeContextMenuDoc) return;
      const { id, title } = activeContextMenuDoc;
      closeContextMenu();
      handleReindexDocument(id, title, null);
    });
  }

  const ctxMenuToggleCache = document.getElementById("ctxMenuToggleCache");
  const ctxMenuToggleCacheText = document.getElementById("ctxMenuToggleCacheText");
  if (ctxMenuToggleCache) {
    ctxMenuToggleCache.addEventListener("click", async () => {
      if (!activeContextMenuDoc) return;
      const { id, title } = activeContextMenuDoc;
      closeContextMenu();
      if (!window.downloadQueueManager) return;
      const isCached = window.downloadQueueManager.isDocumentCached(id);
      const isTaskActive = window.downloadQueueManager.activeTasks.has(id);
      const isTaskQueued = window.downloadQueueManager.queue.includes(id);

      if (isCached) {
        await window.downloadQueueManager.removeDocumentFromCache(id);
        showToast(`"${title}" supprimé du cache local`, "info");
        updateDocCardCacheUI(id);
        if (Number(currentActiveDocId) === Number(id)) {
          const badge = document.getElementById("viewerCacheBadge");
          if (badge) {
            badge.style.display = "none";
            badge.className = "viewer-doc-badge viewer-cache-badge";
          }
        }
        if (filterOfflineOnly && filterOfflineOnly.checked) {
          if (currentSearchQuery) performSearch(currentSearchQuery);
          else loadFoldersAndDocuments();
        }
      } else if (isTaskActive || isTaskQueued) {
        await window.downloadQueueManager.cancelDownload(id);
        showToast(`Téléchargement interrompu pour "${title}"`, "info");
        updateDocCardCacheUI(id);
      } else {
        await window.downloadQueueManager.enqueueDocument(id);
        updateDocCardCacheUI(id);
        showToast(`Document "${title}" ajouté à la file de téléchargement`, "info");
      }
    });
  }

  if (ctxMenuDelete) {
    ctxMenuDelete.addEventListener("click", () => {
      if (!activeContextMenuDoc) return;
      const { id, title } = activeContextMenuDoc;
      closeContextMenu();
      confirmDeleteDocument(id, title);
    });
  }

  // =========================================================================
  // Séparateur Redimensionnable Split-View (Desktop)
  // =========================================================================
  if (splitResizer) {
    let isResizing = false;

    const stopResizing = () => {
      if (!isResizing) return;
      isResizing = false;
      workspace.classList.remove("resizing");
      splitResizer.classList.remove("resizing");
      if (pdfFrame) {
        pdfFrame.style.pointerEvents = "";
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    splitResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      isResizing = true;
      workspace.classList.add("resizing");
      splitResizer.classList.add("resizing");
      if (pdfFrame) {
        pdfFrame.style.pointerEvents = "none";
      }
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    window.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      const workspaceRect = workspace.getBoundingClientRect();
      const minW = 260;
      const maxW = Math.min(window.innerWidth - 300, 750);
      const calculatedW = e.clientX - workspaceRect.left;
      const newW = Math.max(minW, Math.min(calculatedW, maxW));
      workspace.style.setProperty("--results-pane-width", `${newW}px`);
    });

    window.addEventListener("mouseup", stopResizing);
    window.addEventListener("mouseleave", stopResizing);
  }

  // Bouton retour mobile dans le lecteur PDF
  if (viewerBackBtn) {
    viewerBackBtn.addEventListener("click", () => {
      closeSplitViewer();
    });
  }

  // Prise en charge du bouton retour matériel / gestuel mobile
  window.addEventListener("popstate", () => {
    if (workspace.classList.contains("split-active")) {
      closeSplitViewer();
    }
  });

  // Mémorisation de la position de défilement vertical de la vue générale
  if (resultsPane) {
    resultsPane.addEventListener("scroll", () => {
      if (isRestoringScroll) return;
      if (generalView && generalView.style.display !== "none") {
        savedGeneralResultsScrollTop = resultsPane.scrollTop;
      }
    }, { passive: true });
  }

  // =========================================================================
  // Tiroir Mobile d'extraits (Bottom Sheet)
  // =========================================================================
  function openMobileOccurrencesDrawer() {
    if (mobileDrawerOverlay && mobileOccurrencesDrawer) {
      mobileDrawerOverlay.style.display = "block";
      mobileOccurrencesDrawer.style.display = "flex";
      setTimeout(() => {
        const activeCard = drawerOccurrencesList ? drawerOccurrencesList.querySelector(".vertical-occ-card.active") : null;
        if (activeCard) {
          activeCard.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }, 100);
    }
  }

  function closeMobileOccurrencesDrawer() {
    if (mobileDrawerOverlay && mobileOccurrencesDrawer) {
      mobileDrawerOverlay.style.display = "none";
      mobileOccurrencesDrawer.style.display = "none";
    }
  }

  if (mobileOccurrencesBtn) {
    mobileOccurrencesBtn.addEventListener("click", openMobileOccurrencesDrawer);
  }
  if (closeDrawerBtn) {
    closeDrawerBtn.addEventListener("click", closeMobileOccurrencesDrawer);
  }
  if (mobileDrawerOverlay) {
    mobileDrawerOverlay.addEventListener("click", closeMobileOccurrencesDrawer);
  }

  function renderDrawerOccurrences(docId, docTitle, occurrences, activePage, activeOccId = null) {
    if (!drawerOccurrencesList) return;
    drawerOccurrencesList.innerHTML = "";
    if (!occurrences || occurrences.length === 0) {
      drawerOccurrencesList.innerHTML = `<div style="color:var(--text-muted); font-size:12.5px; padding:10px;">Aucun extrait pour ce document.</div>`;
      return;
    }

    const placeholderSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='120'%3E%3Crect width='100%25' height='100%25' fill='%23f1f5f9'/%3E%3C/svg%3E";

    const drawerSearchTerm = getActiveDocSearchTerm();

    let activeTargetIndex = -1;
    if (activeOccId && occurrences) {
      activeTargetIndex = occurrences.findIndex(o => String(o.occ_id) === String(activeOccId));
    }
    if (activeTargetIndex === -1 && activePage && occurrences) {
      activeTargetIndex = occurrences.findIndex(o => o.page_number === activePage);
    }
    if (activeTargetIndex === -1 && occurrences && occurrences.length > 0) {
      activeTargetIndex = 0;
    }

    occurrences.forEach((occ, index) => {
      const item = document.createElement("div");
      const isActive = (index === activeTargetIndex);
      item.className = `vertical-occ-card ${isActive ? 'active' : ''}`;
      item.setAttribute("data-doc-id", docId);
      item.setAttribute("data-page", occ.page_number);
      item.setAttribute("data-occ-id", occ.occ_id || '');
      item.setAttribute("data-rect", JSON.stringify(occ.rect || []));
      item.setAttribute("data-hl-rects", JSON.stringify(occ.highlight_rects || (occ.rect ? [occ.rect] : [])));

      item.innerHTML = `
        <div class="vertical-occ-img-wrapper">
          <img src="${placeholderSvg}" data-src="${occ.crop_url}" class="vertical-occ-img dynamic-crop" alt="Extrait p. ${occ.page_number}" style="opacity: 0.6; transition: opacity 0.2s ease-in-out;" />
        </div>
        <div class="vertical-occ-footer">
          <span class="vertical-occ-page">Page ${occ.page_number}</span>
          <span class="vertical-occ-snippet">${drawerSearchTerm ? highlightTitle(occ.text_snippet || '', drawerSearchTerm) : escapeHtml(occ.text_snippet || '')}</span>
        </div>
      `;
      item.addEventListener("click", () => {
        closeMobileOccurrencesDrawer();
        currentActiveOccurrenceIndex = index;
        updateOccurrenceStepperUI();
        const targetRect = (occ.highlight_rects && occ.highlight_rects.length > 0) ? occ.highlight_rects[0] : occ.rect;
        // Héritage EXPLICITE de la recherche globale au moment du clic (résultat de recherche)
        openDocumentInSplitView(docId, docTitle, occ.page_number, occurrences, targetRect, occ.y_ratio || 0, occ.occ_id, currentSearchQuery || null);
      });
      drawerOccurrencesList.appendChild(item);
      const img = item.querySelector(".dynamic-crop");
      if (img) verticalCropManager.observe(img);
    });
  }

  // =========================================================================
  // Mode Sélection Tactile
  // =========================================================================
  if (toggleSelectionModeBtn) {
    toggleSelectionModeBtn.addEventListener("click", () => {
      isSelectionModeActive = !isSelectionModeActive;
      toggleSelectionModeBtn.classList.toggle("active", isSelectionModeActive);
      document.body.classList.toggle("selection-mode-active", isSelectionModeActive);
      if (!isSelectionModeActive && selectedDocIds.size === 0) {
        clearSelection();
      }
    });
  }

  // =========================================================================
  // Volet Latéral Coulissant de Navigation Globale (Accueil) & Vues Dédiées
  // =========================================================================
  function toggleMainSidebar(show) {
    if (!mainSidebarDrawer || !mainSidebarOverlay) return;
    const willShow = (show !== undefined) ? show : !mainSidebarDrawer.classList.contains("open");
    mainSidebarDrawer.classList.toggle("open", willShow);
    mainSidebarOverlay.style.display = willShow ? "block" : "none";
  }

  if (mainSidebarToggleBtn) {
    mainSidebarToggleBtn.addEventListener("click", () => toggleMainSidebar());
  }
  if (closeMainSidebarBtn) {
    closeMainSidebarBtn.addEventListener("click", () => toggleMainSidebar(false));
  }
  if (mainSidebarOverlay) {
    mainSidebarOverlay.addEventListener("click", () => toggleMainSidebar(false));
  }

  function switchMainView(tabName) {
    [navBtnDocuments, navBtnDownloads, navBtnSettings].forEach(b => {
      if (b) b.classList.toggle("active", b.getAttribute("data-tab") === tabName);
    });

    if (viewDocuments) viewDocuments.style.display = (tabName === "documents") ? "flex" : "none";
    if (viewDownloads) {
      viewDownloads.style.display = (tabName === "downloads") ? "flex" : "none";
      if (tabName === "downloads") refreshDownloadsView();
    }
    if (viewSettings) {
      viewSettings.style.display = (tabName === "settings") ? "flex" : "none";
      if (tabName === "settings") refreshSettingsView();
    }
    toggleMainSidebar(false);
  }

  if (navBtnDocuments) navBtnDocuments.addEventListener("click", () => switchMainView("documents"));
  if (navBtnDownloads) navBtnDownloads.addEventListener("click", () => switchMainView("downloads"));
  if (navBtnSettings) navBtnSettings.addEventListener("click", () => switchMainView("settings"));

  // Statut Réseau discret dans le Header
  function updateNetworkPillUI() {
    const isOnline = navigator.onLine;
    if (networkDot) {
      networkDot.className = `network-dot ${isOnline ? 'green' : 'orange'}`;
    }
    if (networkLabel) {
      networkLabel.textContent = isOnline ? "Connecté" : "Hors-ligne";
    }
    const sidebarStatus = document.getElementById("sidebarNetworkStatusText");
    if (sidebarStatus) {
      sidebarStatus.textContent = isOnline ? "Connecté" : "Hors-ligne";
    }
  }
  window.addEventListener("online", updateNetworkPillUI);
  window.addEventListener("offline", updateNetworkPillUI);
  updateNetworkPillUI();

  if (networkStatusPill) {
    networkStatusPill.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (res.ok) {
          showToast("Connexion au serveur opérationnelle", "success");
        } else {
          showToast("Serveur injoignable", "warning");
        }
      } catch (e) {
        showToast("Impossible de joindre le serveur", "warning");
      }
      updateNetworkPillUI();
    });
  }

  // Mise à jour de la Vue Transferts
  async function refreshDownloadsView() {
    if (!window.downloadQueueManager) return;
    const queueSummary = document.getElementById("downloadsQueueSummaryText");
    const activePill = document.getElementById("downloadsActivePill");
    const offlineCountText = document.getElementById("downloadsOfflineCountText");
    const activeList = document.getElementById("fullDownloadsActiveList");
    const cachedList = document.getElementById("fullDownloadsCachedList");
    const pauseBtn = document.getElementById("downloadsGlobalPauseBtn");
    const pauseText = document.getElementById("downloadsGlobalPauseText");

    const isPaused = window.downloadQueueManager.isPaused;
    if (pauseText) pauseText.textContent = isPaused ? "Reprendre les téléchargements" : "Mettre en pause";

    const activeCount = window.downloadQueueManager.activeTasks.size;
    const queueCount = window.downloadQueueManager.queue.length;
    if (queueSummary) queueSummary.textContent = `${activeCount} actif(s), ${queueCount} en attente`;
    if (activePill) {
      activePill.textContent = (activeCount > 0 || queueCount > 0) ? (isPaused ? "Suspendu" : "Actif") : "Inactif";
      activePill.className = `badge-pill ${(activeCount > 0 || queueCount > 0) ? (isPaused ? 'warning' : 'primary') : ''}`;
    }

    if (activeList) {
      activeList.innerHTML = "";
      if (activeCount === 0 && queueCount === 0) {
        activeList.innerHTML = `<div class="empty-list-note">Aucun téléchargement en cours</div>`;
      } else {
        window.downloadQueueManager.activeTasks.forEach((task) => {
          const row = document.createElement("div");
          row.className = "download-task-row";
          row.innerHTML = `
            <div style="flex:1; min-width:0;">
              <div style="font-weight:600; font-size:13px; color:var(--text-main);">Document #${task.docId}</div>
              <div class="download-progress-bar-bg" style="margin-top:6px;">
                <div class="download-progress-bar-fill" style="width: ${task.progress || 0}%;"></div>
              </div>
            </div>
            <span style="font-size:12px; font-weight:700; color:var(--accent);">${task.progress || 0}%</span>
            <button class="btn btn-sm btn-icon btn-cancel-task" title="Annuler" data-id="${task.docId}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          `;
          row.querySelector(".btn-cancel-task").addEventListener("click", () => {
            window.downloadQueueManager.cancelDownload(task.docId);
            refreshDownloadsView();
          });
          activeList.appendChild(row);
        });
      }
    }

    // Documents en cache
    const cachedDocs = await window.downloadQueueManager.getAllCachedDocs().catch(() => []);
    if (offlineCountText) offlineCountText.textContent = `${cachedDocs.length} document${cachedDocs.length > 1 ? 's' : ''} disponible${cachedDocs.length > 1 ? 's' : ''} localement`;
    if (cachedList) {
      cachedList.innerHTML = "";
      if (!cachedDocs || cachedDocs.length === 0) {
        cachedList.innerHTML = `<div class="empty-list-note">Aucun document en cache local</div>`;
      } else {
        cachedDocs.forEach(d => {
          const row = document.createElement("div");
          row.className = "download-task-row";
          row.innerHTML = `
            <div style="flex:1; min-width:0;">
              <div style="font-weight:600; font-size:13px; color:var(--text-main);">${escapeHtml(d.title || d.filename)}</div>
              <div style="font-size:11.5px; color:var(--text-muted);">${d.total_pages || 1} pages ${d.file_size ? '• ' + formatBytes(d.file_size) : ''}</div>
            </div>
            <button class="btn btn-sm btn-secondary btn-del-cache" title="Supprimer du cache" data-id="${d.id}">
              Retirer
            </button>
          `;
          row.querySelector(".btn-del-cache").addEventListener("click", async () => {
            await window.downloadQueueManager.removeDocumentFromCache(d.id);
            refreshDownloadsView();
            loadFoldersAndDocuments();
          });
          cachedList.appendChild(row);
        });
      }
    }
  }

  const downloadsGlobalPauseBtn = document.getElementById("downloadsGlobalPauseBtn");
  if (downloadsGlobalPauseBtn) {
    downloadsGlobalPauseBtn.addEventListener("click", () => {
      if (!window.downloadQueueManager) return;
      if (window.downloadQueueManager.isPaused) {
        window.downloadQueueManager.resume();
      } else {
        window.downloadQueueManager.pause();
      }
      refreshDownloadsView();
    });
  }

  const refreshCachedDocsBtn = document.getElementById("refreshCachedDocsBtn");
  if (refreshCachedDocsBtn) {
    refreshCachedDocsBtn.addEventListener("click", () => refreshDownloadsView());
  }

  // Mise à jour de la Vue Réglages
  async function refreshSettingsView() {
    const cachedCountEl = document.getElementById("settingsCachedCount");
    const storageUsedEl = document.getElementById("settingsStorageUsed");
    if (window.downloadQueueManager && cachedCountEl) {
      cachedCountEl.textContent = window.downloadQueueManager.cachedDocIds.size;
    }
    if (storageUsedEl) {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate().catch(() => null);
        if (est && est.usage) {
          storageUsedEl.textContent = formatBytes(est.usage);
        }
      }
    }
  }

  // Thème clair systématique
  document.body.className = "light-theme";

  // Bouton Purger le Cache Local
  const settingsClearCacheBtn = document.getElementById("settingsClearCacheBtn");
  if (settingsClearCacheBtn) {
    settingsClearCacheBtn.addEventListener("click", async () => {
      if (confirm("Voulez-vous supprimer tous les documents mis en cache localement et réinitialiser la base SQLite hors-ligne ?")) {
        try {
          if (window.pdfCacheManager) await window.pdfCacheManager.clearAll();
          if (typeof caches !== 'undefined') {
            await caches.delete('docseeker_covers').catch(() => {});
            await caches.delete('docseeker_offline_crops').catch(() => {});
            await caches.delete('docseeker-pdf-v1').catch(() => {});
          }
          if (window.downloadQueueManager) {
            window.downloadQueueManager.reinitializeWorker();
            window.downloadQueueManager.cachedDocIds.clear();
          }
          showToast("Cache local vidé avec succès", "success");
          refreshSettingsView();
          loadFoldersAndDocuments();
        } catch (e) {
          console.error("Erreur vidage cache:", e);
          showToast("Erreur lors de la suppression du cache", "error");
        }
      }
    });
  }

  const settingsLoginModalBtn = document.getElementById("settingsLoginModalBtn");
  if (settingsLoginModalBtn) {
    settingsLoginModalBtn.addEventListener("click", () => showLoginModal());
  }

  // =========================================================================
  // Authentification Native (Compte Unique Administrateur)
  // =========================================================================
  const loginModal = document.getElementById("loginModal");
  const loginForm = document.getElementById("loginForm");
  const loginPasswordInput = document.getElementById("loginPasswordInput");
  const loginErrorMsg = document.getElementById("loginErrorMsg");
  const submitLoginBtn = document.getElementById("submitLoginBtn");
  const togglePasswordVisibilityBtn = document.getElementById("togglePasswordVisibilityBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  function showLoginModal(errorText = "") {
    if (!loginModal) return;
    loginModal.style.display = "flex";
    if (loginPasswordInput) {
      loginPasswordInput.value = "";
      setTimeout(() => loginPasswordInput.focus(), 150);
    }
    if (loginErrorMsg) {
      if (errorText) {
        loginErrorMsg.textContent = errorText;
        loginErrorMsg.style.display = "block";
      } else {
        loginErrorMsg.style.display = "none";
      }
    }
  }

  function hideLoginModal() {
    if (loginModal) loginModal.style.display = "none";
  }

  async function checkAuthStatus() {
    const localSessionExpiry = parseInt(localStorage.getItem('docseeker_session_valid_until') || '0', 10);
    const isLocallyValid = localSessionExpiry > Date.now();

    if (!navigator.onLine && isLocallyValid) {
      console.log('[Auth] Mode hors-ligne actif avec session locale valide');
      hideLoginModal();
      loadFoldersAndDocuments();
      return;
    }

    try {
      const res = await fetch(cleanOrigin() + "/api/auth/status");
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated) {
          localStorage.setItem('docseeker_session_valid_until', String(Date.now() + 30 * 24 * 3600 * 1000));
          hideLoginModal();
          loadFoldersAndDocuments();
          return;
        }
      } else if (res.status === 503 && isLocallyValid) {
        console.log('[Auth] Réseau indisponible (503 Service Worker) : session locale valide acceptée');
        hideLoginModal();
        loadFoldersAndDocuments();
        return;
      }
      if ((!navigator.onLine || res.status === 503) && isLocallyValid) {
        hideLoginModal();
        loadFoldersAndDocuments();
        return;
      }
      showLoginModal();
    } catch (_) {
      if (isLocallyValid) {
        hideLoginModal();
        loadFoldersAndDocuments();
        return;
      }
      showLoginModal();
    }
  }

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pwd = loginPasswordInput ? loginPasswordInput.value : "";
      if (!pwd) return;

      if (submitLoginBtn) {
        submitLoginBtn.disabled = true;
        submitLoginBtn.textContent = "Connexion...";
      }
      if (loginErrorMsg) loginErrorMsg.style.display = "none";

      try {
        const res = await fetch(cleanOrigin() + "/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd })
        });

        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          localStorage.setItem('docseeker_session_valid_until', String(Date.now() + 30 * 24 * 3600 * 1000));
          hideLoginModal();
          showToast("Connexion réussie", "success");
          loadFoldersAndDocuments();
        } else {
          showLoginModal(data.error || "Mot de passe incorrect");
        }
      } catch (err) {
        showLoginModal("Erreur de communication avec le serveur");
      } finally {
        if (submitLoginBtn) {
          submitLoginBtn.disabled = false;
          submitLoginBtn.textContent = "Se connecter";
        }
      }
    });
  }

  if (togglePasswordVisibilityBtn && loginPasswordInput) {
    togglePasswordVisibilityBtn.addEventListener("click", () => {
      const isPwd = loginPasswordInput.type === "password";
      loginPasswordInput.type = isPwd ? "text" : "password";
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      if (!confirm("Voulez-vous vraiment vous déconnecter ?")) return;
      try {
        await fetch(cleanOrigin() + "/api/auth/logout", { method: "POST" });
      } catch (_) {}
      showToast("Vous avez été déconnecté", "info");
      showLoginModal();
    });
  }

  // Initialisation du nuancier dans la modale dossier
  initColorPalette();

  // Chargement initial sécurisé
  checkAuthStatus();

  // =========================================================================
  // Notifications Toast
  // =========================================================================
  function showToast(message, type = "info", duration = 3500) {
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    
    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
    } else {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = iconSvg;
    const msgSpan = document.createElement("span");
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(15px)";
      toast.style.transition = "all 0.3s";
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // =========================================================================
  // Gestion de la Sélection Multiple & Presse-Papier
  // =========================================================================
  // Map docId -> cardElement pour mise à jour O(1) de la sélection (C4)
  const _docCardMap = new Map();

  function updateSelectionUI() {
    if (_docCardMap.size > 0) {
      // Chemin rapide : mettre à jour seulement les cartes connues en O(1) par doc
      for (const [docId, card] of _docCardMap) {
        const isSelected = selectedDocIds.has(docId);
        card.classList.toggle('selected', isSelected);
        const chk = card.querySelector('.doc-selection-checkbox');
        if (chk) chk.checked = isSelected;
      }
    } else {
      // Chemin fallback si la Map n'est pas encore peuplée
      document.querySelectorAll('.doc-card').forEach(card => {
        const docId = parseInt(card.getAttribute('data-doc-id'), 10);
        const isSelected = selectedDocIds.has(docId);
        card.classList.toggle('selected', isSelected);
        const chk = card.querySelector('.doc-selection-checkbox');
        if (chk) chk.checked = isSelected;
      });
    }

    const count = selectedDocIds.size;
    if (count > 0) {
      selectionActionBar.style.display = 'flex';
      selectionCountText.textContent = `${count} document${count > 1 ? 's' : ''} sélectionné${count > 1 ? 's' : ''}`;
    } else {
      selectionActionBar.style.display = 'none';
    }
  }

  function clearSelection() {
    selectedDocIds.clear();
    lastSelectedDocId = null;
    updateSelectionUI();
  }

  function updatePasteButtonUI() {
    if (clipboardDocIds && clipboardDocIds.length > 0) {
      pasteClipboardBtn.style.display = "inline-flex";
      pasteClipboardText.textContent = `Coller ici (${clipboardDocIds.length})`;
    } else {
      pasteClipboardBtn.style.display = "none";
    }
  }

  function cutSelection() {
    if (selectedDocIds.size === 0) return;
    clipboardDocIds = Array.from(selectedDocIds);
    updatePasteButtonUI();
    showToast(`${clipboardDocIds.length} document(s) coupé(s). Ouvrez un dossier ou le fil d'Ariane et appuyez sur Cmd+V ou 'Coller ici'.`, "info", 4500);
    clearSelection();
  }

  async function pasteClipboard() {
    if (!clipboardDocIds || clipboardDocIds.length === 0) return;
    await batchMoveDocuments(clipboardDocIds, currentFolderId, currentFolderName);
    clipboardDocIds = [];
    updatePasteButtonUI();
  }

  clearSelectionBtn.addEventListener("click", clearSelection);
  batchCutBtn.addEventListener("click", cutSelection);
  pasteClipboardBtn.addEventListener("click", pasteClipboard);

  batchMoveBtn.addEventListener("click", () => {
    if (selectedDocIds.size === 0) return;
    openBatchMoveModal(Array.from(selectedDocIds));
  });

  if (batchCacheBtn) {
    batchCacheBtn.addEventListener("click", async () => {
      if (selectedDocIds.size === 0 || !window.downloadQueueManager) return;
      const ids = Array.from(selectedDocIds);
      let enqueuedCount = 0;
      for (const id of ids) {
        if (!window.downloadQueueManager.isDocumentCached(id)) {
          await window.downloadQueueManager.enqueueDocument(id);
          updateDocCardCacheUI(id);
          enqueuedCount++;
        }
      }
      if (enqueuedCount > 0) {
        showToast(`${enqueuedCount} document${enqueuedCount > 1 ? 's' : ''} ajouté${enqueuedCount > 1 ? 's' : ''} à la file de téléchargement.`, "info");
      } else {
        showToast("Tous les documents sélectionnés sont déjà en cache.", "info");
      }
    });
  }

  if (batchUncacheBtn) {
    batchUncacheBtn.addEventListener("click", async () => {
      if (selectedDocIds.size === 0 || !window.downloadQueueManager) return;
      const ids = Array.from(selectedDocIds);
      const cachedIds = ids.filter(id => window.downloadQueueManager.isDocumentCached(id));
      if (cachedIds.length === 0) {
        showToast("Aucun des documents sélectionnés n'est actuellement en cache.", "info");
        return;
      }
      if (!confirm(`Retirer ${cachedIds.length} document${cachedIds.length > 1 ? 's' : ''} du cache local hors-ligne ?`)) return;

      for (const id of cachedIds) {
        await window.downloadQueueManager.removeDocumentFromCache(id);
        updateDocCardCacheUI(id);
      }
      showToast(`${cachedIds.length} document${cachedIds.length > 1 ? 's' : ''} retiré${cachedIds.length > 1 ? 's' : ''} du cache local.`, "info");
      if (filterOfflineOnly && filterOfflineOnly.checked) {
        if (currentSearchQuery) performSearch(currentSearchQuery);
        else loadFoldersAndDocuments();
      }
    });
  }

  batchDeleteBtn.addEventListener("click", async () => {
    const count = selectedDocIds.size;
    if (count === 0) return;
    if (!confirm(`Supprimer définitivement les ${count} documents sélectionnés ?`)) return;

    const idsToDelete = Array.from(selectedDocIds);
    clearSelection();

    try {
      const delOpts = { method: "DELETE" };
      for (const id of idsToDelete) {
        await apiFetch(`/api/documents/${id}`, delOpts);
        if (window.pdfCacheManager) window.pdfCacheManager.invalidate(id).catch(() => {});
      }
      showToast(`${count} document(s) supprimé(s).`, "info");
      clearFolderDocsCache();
      if (currentSearchQuery) {
        performSearch(currentSearchQuery);
      } else {
        loadFoldersAndDocuments();
      }
    } catch (err) {
      console.error(err);
      showToast("Erreur lors de la suppression par lot.", "error");
    }
  });

  // Raccourcis Clavier Globaux (Cmd/Ctrl + X, Cmd/Ctrl + V, Cmd/Ctrl + A, Échap)
  window.addEventListener("keydown", (e) => {
    // Ne pas intercepter si l'utilisateur est en train de taper dans un champ de saisie
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
    if (activeTag === "input" || activeTag === "textarea") return;

    const isCmdOrCtrl = e.metaKey || e.ctrlKey;

    if (isCmdOrCtrl && e.key.toLowerCase() === "x") {
      if (selectedDocIds.size > 0) {
        e.preventDefault();
        cutSelection();
      }
    } else if (isCmdOrCtrl && e.key.toLowerCase() === "v") {
      if (clipboardDocIds.length > 0) {
        e.preventDefault();
        pasteClipboard();
      }
    } else if (isCmdOrCtrl && e.key.toLowerCase() === "f") {
      e.preventDefault();
      if (workspace.classList.contains("split-active")) {
        if (viewerDocSearchWrapper) {
          viewerDocSearchWrapper.style.display = "flex";
          if (viewerDocSearchInput) {
            viewerDocSearchInput.focus();
            viewerDocSearchInput.select();
          }
        } else if (docSearchInput) {
          docSearchInput.focus();
          docSearchInput.select();
        }
      } else {
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      }
    } else if (e.key === "F3" || (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp"))) {
      if (workspace.classList.contains("split-active")) {
        e.preventDefault();
        if (e.shiftKey || e.key === "ArrowUp") {
          goToPrevOccurrence();
        } else {
          goToNextOccurrence();
        }
      }
    } else if (e.key === "Escape") {
      if (viewerDocSearchWrapper && viewerDocSearchWrapper.style.display === "flex") {
        viewerDocSearchWrapper.style.display = "none";
      } else if (selectedDocIds.size > 0) {
        clearSelection();
      }
    }
  });

  // =========================================================================
  // Gestion de la Recherche & des Filtres (0ms sur titres + debounced FTS)
  // =========================================================================
  searchInput.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    clearSearchBtn.style.display = val ? "flex" : "none";

    // Si le champ est entièrement vidé, réinitialiser immédiatement
    if (!val) {
      currentSearchQuery = "";
      isSearchActive = false;
      lastSearchResultsData = null;
      document.querySelectorAll(".doc-card").forEach(card => card.style.opacity = "1");
      loadFoldersAndDocuments();
    }
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      clearSearchBtn.style.display = "none";
      currentSearchQuery = "";
      isSearchActive = false;
      lastSearchResultsData = null;
      loadFoldersAndDocuments();
    } else if (e.key === "Enter") {
      e.preventDefault();
      document.querySelectorAll(".doc-card").forEach(card => card.style.opacity = "1");
      performSearch(searchInput.value.trim());
    }
  });

  clearSearchBtn.addEventListener("click", (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    searchInput.value = "";
    clearSearchBtn.style.display = "none";
    currentSearchQuery = "";
    isSearchActive = false;
    lastSearchResultsData = null;
    loadFoldersAndDocuments();
    searchInput.focus();
  });

  // Filtre : Titres uniquement
  filterTitlesOnly.addEventListener("change", () => {
    filterTitlesChip.classList.toggle("active", filterTitlesOnly.checked);
    if (searchInput.value.trim()) {
      performSearch(searchInput.value.trim());
    }
  });

  // Filtre : Dans ce dossier uniquement
  filterCurrentFolderOnly.addEventListener("change", () => {
    filterFolderChip.classList.toggle("active", filterCurrentFolderOnly.checked);
    if (searchInput.value.trim()) {
      performSearch(searchInput.value.trim());
    }
  });

  // Filtre : Hors-ligne uniquement
  if (filterOfflineOnly) {
    filterOfflineOnly.addEventListener("change", () => {
      if (filterOfflineChip) {
        filterOfflineChip.classList.toggle("active", filterOfflineOnly.checked);
      }
      if (searchInput.value.trim()) {
        performSearch(searchInput.value.trim());
      } else {
        loadFoldersAndDocuments();
      }
    });
  }

  brandBtn.addEventListener("click", () => {
    isNavigatingFolder = false;
    if (foldersContainer) foldersContainer.style.pointerEvents = "";
    searchInput.value = "";
    clearSearchBtn.style.display = "none";
    currentSearchQuery = "";
    isSearchActive = false;
    lastSearchResultsData = null;
    currentFolderId = null;
    currentFolderName = "Documents";
    folderBreadcrumbs = [{ id: null, name: "Documents" }];
    updateFolderFilterVisibility();
    closeSplitViewer();
    clearSelection();
    loadFoldersAndDocuments();
  });

  backToResultsBtn.addEventListener("click", () => {
    showGeneralResultsView();
  });

  closeViewerBtn.addEventListener("click", () => {
    closeSplitViewer();
  });

  // Changement du critère de tri
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      currentSortMode = e.target.value;
      userManuallyChangedSort = true;
      updateSortPillLabel();
      savedGeneralResultsScrollTop = 0;
      if (currentSearchQuery && lastSearchResultsData) {
        renderSearchResults(lastSearchResultsData);
      } else {
        renderFolders(allFolders);
        renderDocumentLibrary(rawLoadedDocs);
      }
    });
    updateSortPillLabel();
  }

  // Gestion du verrouillage du zoom de l'application hôte sur mobile lors de la lecture d'un PDF
  function setDocumentZoomLock(locked) {
    const viewportMeta = document.querySelector('meta[name="viewport"]');
    if (!viewportMeta) return;
    if (locked) {
      viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover');
    } else {
      viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
    }
  }

  // Neutralisation des gestes de pincement Safari iOS sur l'interface hôte lorsque le PDF est affiché
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(eventName => {
    window.addEventListener(eventName, (e) => {
      if (document.body.classList.contains('doc-open')) {
        e.preventDefault();
      }
    }, { passive: false });
    document.addEventListener(eventName, (e) => {
      if (document.body.classList.contains('doc-open')) {
        e.preventDefault();
      }
    }, { passive: false });
  });

  // Empêcher Safari iOS d'activer le zoom viewport global lors d'un toucher multi-doigts sur l'app hôte
  window.addEventListener('touchmove', (e) => {
    if (document.body.classList.contains('doc-open') && e.touches && e.touches.length > 1) {
      e.preventDefault();
    }
  }, { passive: false });

  // Empêcher le double-tap zoom intempestif sur l'en-tête et les actions du visualiseur
  let lastTouchEndTime = 0;
  document.addEventListener('touchend', (e) => {
    if (!document.body.classList.contains('doc-open')) return;
    const now = Date.now();
    if (now - lastTouchEndTime <= 300) {
      if (e.target.closest('.viewer-header, .viewer-actions, .btn, input')) {
        e.preventDefault();
      }
    }
    lastTouchEndTime = now;
  }, { passive: false });

  // Injection et sécurisation des événements gestuels dans l'iframe du lecteur PDF
  function hookIframePinchZoomIsolation() {
    try {
      const win = pdfFrame ? pdfFrame.contentWindow : null;
      if (!win) return;
      ['gesturestart', 'gesturechange', 'gestureend'].forEach(evt => {
        win.addEventListener(evt, e => e.preventDefault(), { passive: false });
        if (win.document) {
          win.document.addEventListener(evt, e => e.preventDefault(), { passive: false });
        }
      });
      win.addEventListener('touchmove', e => {
        if (e.touches && e.touches.length > 1) {
          e.preventDefault();
        }
      }, { passive: false });
    } catch (e) {
      console.warn("[Pinch Isolation Hook]", e);
    }
  }

  // Masquage dynamique et réactif du header viewer au défilement (Mobile & Tablette - Mesure 4)
  let lastViewerScrollTop = 0;
  function hookIframeScrollAutoHide() {
    try {
      const win = pdfFrame ? pdfFrame.contentWindow : null;
      if (!win || !win.document) return;
      const viewerContainer = win.document.getElementById("viewerContainer");
      if (!viewerContainer || viewerContainer.__autoHideHooked) return;
      viewerContainer.__autoHideHooked = true;

      viewerContainer.addEventListener("scroll", () => {
        const st = viewerContainer.scrollTop;
        if (typeof tabManager !== 'undefined' && tabManager.activeTabId) {
          const curTab = tabManager.openTabs.find(t => t.id === tabManager.activeTabId);
          if (curTab) {
            curTab.scrollTop = st;
            curTab.scrollLeft = viewerContainer.scrollLeft;
          }
        }
        if (window.innerWidth > 900) {
          if (viewerPane && viewerPane.classList.contains("header-hidden")) {
            viewerPane.classList.remove("header-hidden");
          }
          return;
        }
        if (st <= 15) {
          if (viewerPane) viewerPane.classList.remove("header-hidden");
        } else if (st > lastViewerScrollTop + 20) {
          if (viewerPane) viewerPane.classList.add("header-hidden");
        } else if (st < lastViewerScrollTop - 20) {
          if (viewerPane) viewerPane.classList.remove("header-hidden");
        }
        lastViewerScrollTop = Math.max(0, st);
      }, { passive: true });
    } catch (e) {
      console.warn("[Viewer Auto-Hide Hook]", e);
    }
  }

  function closeSplitViewer() {
    if (viewerPane) {
      viewerPane.classList.remove("header-hidden");
      viewerPane.style.display = "none";
    }
    if (typeof tabManager !== 'undefined') {
      tabManager.openTabs = [];
      tabManager.activeTabId = null;
      if (typeof tabManager.renderTabsUI === 'function') tabManager.renderTabsUI();
    }
    lastViewerScrollTop = 0;
    if (currentActiveDocId && window.pdfCacheManager) {
      window.pdfCacheManager.pauseDownload(currentActiveDocId);
      window.pdfCacheManager.cleanup(currentActiveDocId); // Libère les listeners zombie (P6)
    }
    workspace.classList.remove("split-active");
    document.documentElement.classList.remove("doc-open");
    document.body.classList.remove("doc-open");
    const appEl = document.getElementById("app");
    if (appEl) appEl.classList.remove("doc-open");
    setDocumentZoomLock(false);
    if (viewerDocSearchWrapper) viewerDocSearchWrapper.style.display = "none";
    if (inDocSearchDrawer) inDocSearchDrawer.style.display = "none";
    if (readerSidebarToggleBtn) readerSidebarToggleBtn.classList.remove("active");
    syncDocSearchInputs("");
    // Libérer les tableaux d'occurrences du document actif (P4/P5)
    currentActiveOccurrences = [];
    currentDocOriginalOccurrences = null;
    _lastVerticalRenderHash = '';  // Forcer un rebuild complet au prochain document (C2)
    currentActiveOccurrenceIndex = -1;
    updateOccurrenceStepperUI();
    try {
      if (pdfFrame && pdfFrame.contentWindow && pdfFrame.contentWindow.PDFViewerApplication) {
        pdfFrame.contentWindow.PDFViewerApplication.close();
      }
    } catch (e) {}
    if (window._currentPdfBlobUrl) {
      try { URL.revokeObjectURL(window._currentPdfBlobUrl); } catch (e) {}
      window._currentPdfBlobUrl = null;
    }
    currentActiveDocId = null;
    showGeneralResultsView();
  }

  function showGeneralResultsView() {
    if (resultsPane) resultsPane.style.display = "";
    docDetailView.style.display = "none";
    generalView.style.display = "block";
    document.querySelectorAll(".vignette-item.active").forEach(el => el.classList.remove("active"));

    // Restauration du scroll : assignation immédiate + confirmation en RAF (C5)
    // L'assignation immédiate fonctionne maintenant que generalView est visible.
    // Le RAF garantit l'application après le prochain cycle de layout.
    isRestoringScroll = true;
    const targetScroll = savedGeneralResultsScrollTop;
    if (resultsPane) resultsPane.scrollTop = targetScroll;
    requestAnimationFrame(() => {
      if (resultsPane) resultsPane.scrollTop = targetScroll;
      isRestoringScroll = false;
    });
  }

  function updateFolderFilterVisibility() {
    if (currentFolderId === null) {
      filterFolderLabel.textContent = "Dans ce dossier";
      filterFolderChip.style.display = "none";
      filterCurrentFolderOnly.checked = false;
      filterFolderChip.classList.remove("active");
    } else {
      filterFolderLabel.textContent = `"${currentFolderName}"`;
      filterFolderChip.style.display = "inline-flex";
    }
  }

  // =========================================================================
  // Recherche Interne au Document (Split View, Header Viewer, Tiroir Mobile, Tiroir Lecteur)
  // Propriétaire de l'état : l'onglet actif (tabManager). Cette fonction écrit
  // la requête + occurrences dans l'onglet puis projette vers les vues.
  // =========================================================================
  function syncDocSearchInputs(val, sourceInput = null) {
    if (docSearchInput && docSearchInput !== sourceInput && docSearchInput.value !== val) docSearchInput.value = val;
    if (viewerDocSearchInput && viewerDocSearchInput !== sourceInput && viewerDocSearchInput.value !== val) viewerDocSearchInput.value = val;
    if (drawerDocSearchInput && drawerDocSearchInput !== sourceInput && drawerDocSearchInput.value !== val) drawerDocSearchInput.value = val;
    if (inDocDrawerSearchInput && inDocDrawerSearchInput !== sourceInput && inDocDrawerSearchInput.value !== val) inDocDrawerSearchInput.value = val;

    const hasVal = Boolean(val && val.trim().length > 0);
    if (clearDocSearchBtn) clearDocSearchBtn.style.display = hasVal ? "flex" : "none";
    if (viewerDocSearchClearBtn) viewerDocSearchClearBtn.style.display = hasVal ? "flex" : "none";
    if (drawerDocSearchClearBtn) drawerDocSearchClearBtn.style.display = hasVal ? "flex" : "none";
    if (inDocDrawerClearBtn) inDocDrawerClearBtn.style.display = hasVal ? "flex" : "none";
  }

  if (docSearchInput) {
    docSearchInput.addEventListener("input", (e) => {
      const rawVal = e.target.value;
      syncDocSearchInputs(rawVal, docSearchInput);
      if (!rawVal.trim()) {
        performDocSearch("", false);
      }
    });
  }

  if (clearDocSearchBtn) {
    clearDocSearchBtn.addEventListener("click", () => {
      syncDocSearchInputs("");
      performDocSearch("", true);
    });
  }

  // Écouteurs pour le Header Viewer (Mobile & Desktop)
  if (viewerDocSearchToggleBtn && viewerDocSearchWrapper) {
    viewerDocSearchToggleBtn.addEventListener("click", () => {
      const isHidden = (viewerDocSearchWrapper.style.display === "none" || !viewerDocSearchWrapper.style.display);
      if (isHidden) {
        viewerDocSearchWrapper.style.display = "flex";
        if (viewerDocSearchInput) {
          viewerDocSearchInput.focus();
          const tabTerm = getActiveDocSearchTerm();
          if (currentSearchQuery && tabTerm && !viewerDocSearchInput.value) {
            syncDocSearchInputs(tabTerm);
          }
        }
      } else {
        viewerDocSearchWrapper.style.display = "none";
      }
    });
  }

  if (viewerDocSearchCloseBtn && viewerDocSearchWrapper) {
    viewerDocSearchCloseBtn.addEventListener("click", () => {
      viewerDocSearchWrapper.style.display = "none";
    });
  }

  if (viewerDocSearchInput) {
    viewerDocSearchInput.addEventListener("input", (e) => {
      const rawVal = e.target.value;
      syncDocSearchInputs(rawVal, viewerDocSearchInput);
      if (!rawVal.trim()) {
        performDocSearch("", false);
      }
    });
  }

  if (viewerDocSearchClearBtn) {
    viewerDocSearchClearBtn.addEventListener("click", () => {
      syncDocSearchInputs("");
      performDocSearch("", true);
    });
  }

  // Écouteurs pour le Tiroir Mobile d'extraits
  if (drawerDocSearchInput) {
    drawerDocSearchInput.addEventListener("input", (e) => {
      const rawVal = e.target.value;
      syncDocSearchInputs(rawVal, drawerDocSearchInput);
      if (!rawVal.trim()) {
        performDocSearch("", false);
      }
    });
  }

  if (drawerDocSearchClearBtn) {
    drawerDocSearchClearBtn.addEventListener("click", () => {
      syncDocSearchInputs("");
      performDocSearch("", true);
    });
  }

  // Écouteurs pour le Volet Latéral du Lecteur PDF (Goodnotes inDocSearchDrawer)
  if (inDocDrawerSearchInput) {
    inDocDrawerSearchInput.addEventListener("input", (e) => {
      const rawVal = e.target.value;
      syncDocSearchInputs(rawVal, inDocDrawerSearchInput);
      if (!rawVal.trim()) {
        performDocSearch("", false);
      }
    });
  }

  if (inDocDrawerClearBtn) {
    inDocDrawerClearBtn.addEventListener("click", () => {
      syncDocSearchInputs("");
      performDocSearch("", true);
    });
  }

  if (inDocDrawerCloseBtn) {
    inDocDrawerCloseBtn.addEventListener("click", () => {
      if (inDocSearchDrawer) inDocSearchDrawer.style.display = "none";
      if (readerSidebarToggleBtn) readerSidebarToggleBtn.classList.remove("active");
    });
  }

  // =========================================================================
  // Stepper d'Occurrences (Suivant / Précédent & Raccourcis Clavier)
  // =========================================================================
  function updateOccurrenceStepperUI() {
    const total = currentActiveOccurrences ? currentActiveOccurrences.length : 0;
    if (!occurrenceStepper) return;

    if (total === 0) {
      occurrenceStepper.style.display = "none";
      if (searchStepperMini) searchStepperMini.style.display = "none";
      return;
    }

    occurrenceStepper.style.display = "inline-flex";
    if (searchStepperMini) searchStepperMini.style.display = "inline-flex";

    const currentDisplayIndex = currentActiveOccurrenceIndex >= 0 ? currentActiveOccurrenceIndex + 1 : 0;
    const text = `${currentDisplayIndex} / ${total}`;

    if (occurrenceCounter) occurrenceCounter.textContent = text;
    if (prevOccBtn) prevOccBtn.disabled = total <= 1;
    if (nextOccBtn) nextOccBtn.disabled = total <= 1;
    if (searchPrevBtn) searchPrevBtn.disabled = total <= 1;
    if (searchNextBtn) searchNextBtn.disabled = total <= 1;
  }

  function getCurrentViewerPage() {
    try {
      const win = pdfFrame?.contentWindow;
      if (win && win.PDFViewerApplication && typeof win.PDFViewerApplication.page === "number" && win.PDFViewerApplication.page > 0) {
        return win.PDFViewerApplication.page;
      }
    } catch (e) {}

    if (viewerPageBadge) {
      const m = viewerPageBadge.textContent.match(/\d+/);
      if (m) return parseInt(m[0], 10);
    }
    return 1;
  }

  function findClosestOccurrenceIndex(occs, currentPage) {
    if (!occs || occs.length === 0) return -1;
    let bestIdx = 0;
    let minDiff = Infinity;

    for (let i = 0; i < occs.length; i++) {
      const p = occs[i].page_number;
      if (p === currentPage) {
        return i; // Correspondance exacte sur la page courante
      }
      const diff = Math.abs(p - currentPage);
      // En cas d'égalité de distance, priorité vers l'avant (p > currentPage)
      if (diff < minDiff || (diff === minDiff && p > currentPage)) {
        minDiff = diff;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function scrollActiveCardIntoView(card) {
    if (!card) return;
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (!card || !card.isConnected) return;
        if (resultsPane && resultsPane.contains(card)) {
          const paneRect = resultsPane.getBoundingClientRect();
          const cardRect = card.getBoundingClientRect();
          const targetScrollTop = resultsPane.scrollTop + (cardRect.top - paneRect.top) - (paneRect.height / 2) + (cardRect.height / 2);
          resultsPane.scrollTo({
            top: Math.max(0, targetScrollTop),
            behavior: "smooth"
          });
        } else {
          card.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 50);
    });
  }

  function jumpToOccurrenceByIndex(index) {
    if (!currentActiveOccurrences || currentActiveOccurrences.length === 0) return;
    if (index < 0) index = currentActiveOccurrences.length - 1;
    if (index >= currentActiveOccurrences.length) index = 0;

    const prevIndex = currentActiveOccurrenceIndex;
    currentActiveOccurrenceIndex = index;
    const occ = currentActiveOccurrences[index];

    updateOccurrenceStepperUI();

    // Mettre à jour la sélection visuelle dans la liste latérale — C6 :
    // Ciblage par index (nth-child) au lieu de querySelectorAll complet
    const cards = docOccurrencesList ? docOccurrencesList.children : [];
    if (cards.length > 0) {
      if (prevIndex >= 0 && prevIndex < cards.length) {
        cards[prevIndex].classList.remove('active');
      }
      if (index < cards.length) {
        cards[index].classList.add('active');
        scrollActiveCardIntoView(cards[index]);
      }
    }

    // Mettre à jour la sélection visuelle dans le tiroir mobile — même optimisation
    if (drawerOccurrencesList) {
      const drawerCards = drawerOccurrencesList.children;
      if (drawerCards.length > 0) {
        if (prevIndex >= 0 && prevIndex < drawerCards.length) {
          drawerCards[prevIndex].classList.remove('active');
        }
        if (index < drawerCards.length) {
          drawerCards[index].classList.add('active');
          scrollActiveCardIntoView(drawerCards[index]);
        }
      }
    }

    // Mettre à jour la sélection visuelle dans le volet Goodnotes du Lecteur
    if (inDocDrawerOccurrencesList) {
      const inDocCards = inDocDrawerOccurrencesList.children;
      if (inDocCards.length > 0) {
        if (prevIndex >= 0 && prevIndex < inDocCards.length) {
          inDocCards[prevIndex].classList.remove('active');
        }
        if (index < inDocCards.length) {
          inDocCards[index].classList.add('active');
          scrollActiveCardIntoView(inDocCards[index]);
        }
      }
    }

    if (occ) {
      if (viewerPageBadge) {
        viewerPageBadge.textContent = `Page ${occ.page_number}`;
      }
      const targetRect = (occ.highlight_rects && occ.highlight_rects.length > 0) ? occ.highlight_rects[0] : occ.rect;
      // L'onglet actif est le propriétaire : la position ET l'index de stepper y sont persistés
      const activeTab = getActiveTab();
      if (activeTab) {
        activeTab.page = occ.page_number;
        activeTab.rect = targetRect;
        activeTab.yRatio = occ.y_ratio || 0;
        activeTab.occId = occ.occ_id;
        activeTab.activeOccurrenceIndex = index;
      }
      goToPageAndScrollToOccurrence(occ.page_number, targetRect, occ.y_ratio);
    }
  }

  function goToNextOccurrence() {
    // F3 / stepper : piloter l'occurrence du document AFFICHÉ (onglet actif).
    // On n'relance la recherche QUE si ses occurrences ne sont pas chargées :
    // sinon chaque clic re-exécuterait la recherche et recalerait l'index sur
    // l'occurrence la plus proche (flèches inopérantes, spam SQLite/F3).
    const tab = getActiveTab();
    if (tab && (!Array.isArray(tab.occurrences) || tab.occurrences.length === 0) && tab.searchQuery) {
      performDocSearch(tab.searchQuery, true);
      return;
    }
    jumpToOccurrenceByIndex(currentActiveOccurrenceIndex + 1);
  }

  function goToPrevOccurrence() {
    const tab = getActiveTab();
    if (tab && (!Array.isArray(tab.occurrences) || tab.occurrences.length === 0) && tab.searchQuery) {
      performDocSearch(tab.searchQuery, true);
      return;
    }
    jumpToOccurrenceByIndex(currentActiveOccurrenceIndex - 1);
  }

  if (prevOccBtn) prevOccBtn.addEventListener("click", goToPrevOccurrence);
  if (nextOccBtn) nextOccBtn.addEventListener("click", goToNextOccurrence);
  if (searchPrevBtn) searchPrevBtn.addEventListener("click", goToPrevOccurrence);
  if (searchNextBtn) searchNextBtn.addEventListener("click", goToNextOccurrence);

  // Support de la touche Entrée dans les champs de recherche du document
  let lastExecutedDocSearchQuery = "";
  let lastExecutedDocSearchDocId = null;
  [viewerDocSearchInput, docSearchInput, drawerDocSearchInput, inDocDrawerSearchInput].forEach(inp => {
    if (inp) {
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const query = (inp.value || "").trim();
          if (query !== lastExecutedDocSearchQuery || lastExecutedDocSearchDocId !== Number(currentActiveDocId)) {
            lastExecutedDocSearchQuery = query;
            lastExecutedDocSearchDocId = Number(currentActiveDocId);
            performDocSearch(query, false);
          } else {
            if (e.shiftKey) {
              goToPrevOccurrence();
            } else {
              goToNextOccurrence();
            }
          }
        }
      });
    }
  });

  // Raccourcis clavier globaux : F3 / Shift+F3 et Alt+Flèche
  window.addEventListener("keydown", (e) => {
    if (!workspace.classList.contains("split-active")) return;
    if (e.key === "F3") {
      e.preventDefault();
      if (e.shiftKey) {
        goToPrevOccurrence();
      } else {
        goToNextOccurrence();
      }
    } else if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      goToNextOccurrence();
    } else if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      goToPrevOccurrence();
    }
  });

  let currentDocOccurrencesSortMode = 'page'; // 'page' (défaut) | 'relevance'

  function sortDocOccurrences(occs, mode = currentDocOccurrencesSortMode) {
    if (!occs || occs.length <= 1) return occs ? [...occs] : [];
    const arr = [...occs];
    if (mode === 'relevance') {
      arr.sort((a, b) => {
        const termsDiff = (b.distinct_terms_count || 0) - (a.distinct_terms_count || 0);
        if (termsDiff !== 0) return termsDiff;
        const fontDiff = (b.font_size || 0) - (a.font_size || 0);
        if (fontDiff !== 0) return fontDiff;
        const bm25Diff = (a.bm25_score || 0) - (b.bm25_score || 0);
        if (bm25Diff !== 0) return bm25Diff;
        return (a.page_number || 0) - (b.page_number || 0);
      });
    } else {
      arr.sort((a, b) => {
        const pageDiff = (a.page_number || 0) - (b.page_number || 0);
        if (pageDiff !== 0) return pageDiff;
        return String(a.occ_id || '').localeCompare(String(b.occ_id || ''));
      });
    }
    return arr;
  }

  function setDocOccurrencesSortMode(mode) {
    currentDocOccurrencesSortMode = mode;
    document.querySelectorAll('#sortOccByPageBtn, #drawerSortOccByPageBtn, #inDocSortByPageBtn').forEach(btn => btn.classList.toggle('active', mode === 'page'));
    document.querySelectorAll('#sortOccByRelevanceBtn, #drawerSortOccByRelevanceBtn, #inDocSortByRelevanceBtn').forEach(btn => btn.classList.toggle('active', mode === 'relevance'));

    if (currentActiveOccurrences && currentActiveOccurrences.length > 0) {
      currentActiveOccurrences = sortDocOccurrences(currentActiveOccurrences, mode);
      _lastVerticalRenderHash = '';
      const curPage = getCurrentViewerPage();
      renderVerticalOccurrences(currentActiveDocId, currentActiveDocTitle, currentActiveOccurrences, curPage);
      renderDrawerOccurrences(currentActiveDocId, currentActiveDocTitle, currentActiveOccurrences, curPage);
    }
  }

  const sortOccByPageBtn = document.getElementById("sortOccByPageBtn");
  const sortOccByRelevanceBtn = document.getElementById("sortOccByRelevanceBtn");
  const drawerSortOccByPageBtn = document.getElementById("drawerSortOccByPageBtn");
  const drawerSortOccByRelevanceBtn = document.getElementById("drawerSortOccByRelevanceBtn");

  if (sortOccByPageBtn) sortOccByPageBtn.addEventListener("click", () => setDocOccurrencesSortMode('page'));
  if (sortOccByRelevanceBtn) sortOccByRelevanceBtn.addEventListener("click", () => setDocOccurrencesSortMode('relevance'));
  if (drawerSortOccByPageBtn) drawerSortOccByPageBtn.addEventListener("click", () => setDocOccurrencesSortMode('page'));
  if (drawerSortOccByRelevanceBtn) drawerSortOccByRelevanceBtn.addEventListener("click", () => setDocOccurrencesSortMode('relevance'));
  if (inDocSortByPageBtn) inDocSortByPageBtn.addEventListener("click", () => setDocOccurrencesSortMode('page'));
  if (inDocSortByRelevanceBtn) inDocSortByRelevanceBtn.addEventListener("click", () => setDocOccurrencesSortMode('relevance'));

  async function performDocSearch(query, updateInputs = true) {
    // Propriétaire : l'onglet actif. Une recherche frappe TOUJOURS le document
    // de l'onglet courant, jamais un état global hérité d'un autre document.
    const tab = getActiveTab();
    if (!tab || !currentActiveDocId || Number(tab.docId) !== Number(currentActiveDocId)) {
      console.warn("[DocSearch] ignorée : aucun onglet actif cohérent avec le document affiché");
      return;
    }
    const searchDocId = Number(currentActiveDocId);
    const searchDocTitle = currentActiveDocTitle;
    // Une recherche explicite (saisie, effacement) met TOUJOURS à jour l'état de
    // l'onglet ; updateInputs ne concerne que la synchronisation des champs.
    tab.searchQuery = query;
    if (updateInputs) {
      syncDocSearchInputs(query);
    }

    if (!query) {
      // Effacement : restaurer la base de l'ONGLET (extrait cliqué), pas un autre document
      tab.searchActive = false;
      currentDocOriginalOccurrences = tab.occurrences || [];
      const origCount = currentDocOriginalOccurrences ? currentDocOriginalOccurrences.length : 0;
      const countText = `${origCount} résultat${origCount > 1 ? 's' : ''}`;
      const pillText = `${origCount} extrait${origCount > 1 ? 's' : ''}`;

      if (docDetailCount) docDetailCount.textContent = countText;
      if (viewerDocSearchResultCount) viewerDocSearchResultCount.textContent = "";
      if (mobileOccurrencesCountText) mobileOccurrencesCountText.textContent = pillText;
      if (drawerDocCount) drawerDocCount.textContent = pillText;
      if (inDocDrawerCount) inDocDrawerCount.textContent = countText;

      if (workspace && workspace.classList.contains("split-active")) {
        generalView.style.display = "none";
        docDetailView.style.display = "block";
      }

      currentActiveOccurrences = sortDocOccurrences(currentDocOriginalOccurrences || [], currentDocOccurrencesSortMode);
      renderVerticalOccurrences(currentActiveDocId, currentActiveDocTitle, currentActiveOccurrences);
      renderDrawerOccurrences(currentActiveDocId, currentActiveDocTitle, currentActiveOccurrences);
      updateViewerSearchHighlight(tab.searchQuery || "");

      if (currentActiveOccurrences.length > 0) {
        const curPage = getCurrentViewerPage();
        const bestIdx = findClosestOccurrenceIndex(currentActiveOccurrences, curPage);
        jumpToOccurrenceByIndex(bestIdx);
      } else {
        currentActiveOccurrenceIndex = -1;
        updateOccurrenceStepperUI();
      }
      return;
    }

    try {
      let occs = [];
      const isDocCached = window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(currentActiveDocId);
      const isOfflineMode = !navigator.onLine || (filterOfflineOnly && filterOfflineOnly.checked);

      if (isDocCached || isOfflineMode) {
        console.log(`[DocSearch] Recherche locale SQLite-Wasm pour le document ${currentActiveDocId}`);
        if (window.downloadQueueManager) {
          const res = await window.downloadQueueManager.sendToWorker('DOC_SEARCH', {
            docId: currentActiveDocId,
            query: query
          });
          occs = res ? (res.occurrences || []) : [];
        }
      } else {
        console.log(`[DocSearch] Recherche en ligne backend pour le document ${currentActiveDocId}`);
        const res = await fetch(`/api/doc-search?doc_id=${currentActiveDocId}&q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        occs = data.occurrences || [];
      }

      // S'assurer que le volet de gauche affiche les résultats du document ouvert
      if (workspace && workspace.classList.contains("split-active")) {
        generalView.style.display = "none";
        docDetailView.style.display = "block";
      }

      const resultLabel = `${occs.length} résultat${occs.length > 1 ? 's' : ''}`;
      const pillLabel = `${occs.length} extrait${occs.length > 1 ? 's' : ''}`;

      if (docDetailCount) docDetailCount.textContent = resultLabel;
      if (viewerDocSearchResultCount) viewerDocSearchResultCount.textContent = resultLabel;
      if (mobileOccurrencesCountText) mobileOccurrencesCountText.textContent = pillLabel;
      if (drawerDocCount) drawerDocCount.textContent = pillLabel;
      if (inDocDrawerCount) inDocDrawerCount.textContent = resultLabel;

      currentActiveOccurrences = sortDocOccurrences(occs, currentDocOccurrencesSortMode);
      // Race : ne rien écrire si l'onglet actif a changé pendant la recherche
      if (Number(tab.docId) !== searchDocId || getActiveTab() !== tab) return;
      tab.occurrences = occs;
      tab.searchActive = true;
      renderVerticalOccurrences(searchDocId, searchDocTitle, currentActiveOccurrences);
      renderDrawerOccurrences(searchDocId, searchDocTitle, currentActiveOccurrences);

      if (occs.length > 0) {
        const curPage = getCurrentViewerPage();
        const bestIdx = findClosestOccurrenceIndex(occs, curPage);
        jumpToOccurrenceByIndex(bestIdx);
      } else {
        currentActiveOccurrenceIndex = -1;
        updateOccurrenceStepperUI();
      }
    } catch (err) {
      console.error("Erreur recherche document:", err);
    }
  }

  function updateViewerSearchHighlight(query) {
    try {
      const win = pdfFrame.contentWindow;
      if (!win) return;
      const app = win.PDFViewerApplication;
      if (app && app.eventBus) {
        app.eventBus.dispatch('find', {
          type: '',
          query: (query || '').trim(),
          phraseSearch: true,
          caseSensitive: false,
          entireWord: false,
          highlightAll: true,
          findPrevious: false
        });
      }
    } catch (e) {
      console.warn("Erreur synchronisation surbrillance PDF.js:", e);
    }
  }

  // =========================================================================
  // Navigation Dossiers & Fil d'Ariane (Goodnotes-like) avec Cibles de Drop
  // =========================================================================
  function renderBreadcrumbs() {
    breadcrumbsNav.innerHTML = "";

    // Sécurité défensive : dédupliquer les entrées consécutives dans le fil d'Ariane
    const deduplicated = [];
    folderBreadcrumbs.forEach((crumb) => {
      if (deduplicated.length === 0 || deduplicated[deduplicated.length - 1].id !== crumb.id) {
        deduplicated.push(crumb);
      }
    });
    folderBreadcrumbs = deduplicated;

    folderBreadcrumbs.forEach((crumb, index) => {
      const isLast = (index === folderBreadcrumbs.length - 1);

      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "breadcrumb-separator";
        sep.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        `;
        breadcrumbsNav.appendChild(sep);
      }

      const item = document.createElement("span");
      item.className = `breadcrumb-item ${isLast ? 'active' : ''}`;
      item.setAttribute("data-folder-id", crumb.id === null ? "root" : crumb.id);
      
      if (index === 0) {
        item.title = "Racine de la bibliothèque";
        item.setAttribute("aria-label", "Racine de la bibliothèque");
        item.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
            <polyline points="10 9 9 9 8 9"></polyline>
          </svg>
        `;
      } else {
        item.textContent = crumb.name;
      }

      // Clic pour naviguer en arrière ou réinitialiser la recherche
      item.addEventListener("click", () => {
        if (!isLast || isSearchActive) {
          if (isSearchActive) {
            searchInput.value = "";
            clearSearchBtn.style.display = "none";
            currentSearchQuery = "";
            isSearchActive = false;
            lastSearchResultsData = null;
          }
          navigateToCrumb(index);
        }
      });

      // Drop Zone sur TOUS les éléments du fil d'ariane (y compris la racine Documents)
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        item.classList.add("drag-over");
      });

      item.addEventListener("dragleave", () => {
        item.classList.remove("drag-over");
      });

      item.addEventListener("drop", async (e) => {
        e.preventDefault();
        item.classList.remove("drag-over");

        let docIds = [];
        const jsonPayload = e.dataTransfer.getData("application/json");
        if (jsonPayload) {
          try { docIds = JSON.parse(jsonPayload); } catch (err) {}
        }
        if (!docIds || docIds.length === 0) {
          const plainId = e.dataTransfer.getData("text/plain");
          if (plainId) docIds = [parseInt(plainId, 10)];
        }

        if (docIds.length > 0) {
          await batchMoveDocuments(docIds, crumb.id, crumb.name);
        }
      });

      breadcrumbsNav.appendChild(item);
    });
  }

  // Cache LRU en mémoire vive des documents par dossier (folderId -> docs[])
  const _folderDocsCache = new Map();
  const FOLDER_DOCS_CACHE_MAX = 25;

  function setFolderDocsCache(folderId, docs) {
    const key = (folderId !== null && folderId !== undefined) ? String(folderId) : "root";
    if (_folderDocsCache.has(key)) {
      _folderDocsCache.delete(key);
    } else if (_folderDocsCache.size >= FOLDER_DOCS_CACHE_MAX) {
      const oldestKey = _folderDocsCache.keys().next().value;
      _folderDocsCache.delete(oldestKey);
    }
    _folderDocsCache.set(key, docs);
  }

  function getFolderDocsCache(folderId) {
    const key = (folderId !== null && folderId !== undefined) ? String(folderId) : "root";
    if (_folderDocsCache.has(key)) {
      const docs = _folderDocsCache.get(key);
      _folderDocsCache.delete(key);
      _folderDocsCache.set(key, docs);
      return docs;
    }
    return null;
  }

  function clearFolderDocsCache() {
    _folderDocsCache.clear();
  }

  // Rendu progressif avec cartes de chargement squelettes élégantes
  function renderFolderLoadingSkeletons(count = 4) {
    emptyState.style.display = "none";
    resultsContainer.innerHTML = "";
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const card = document.createElement("div");
      card.className = "doc-card doc-card-skeleton";
      card.innerHTML = `
        <div class="doc-card-header">
          <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
            <div class="skeleton-shimmer skeleton-title"></div>
          </div>
          <div style="display: flex; gap: 6px;">
            <div class="skeleton-shimmer skeleton-badge"></div>
          </div>
        </div>
        <div class="doc-card-body" style="padding-top: 4px;">
          <div class="skeleton-shimmer skeleton-cover"></div>
          <div style="flex: 1; padding: 4px 0 0 12px;">
            <div class="skeleton-shimmer skeleton-line" style="width: 75%;"></div>
            <div class="skeleton-shimmer skeleton-line" style="width: 50%;"></div>
            <div class="skeleton-shimmer skeleton-line" style="width: 65%;"></div>
          </div>
        </div>
      `;
      fragment.appendChild(card);
    }
    resultsContainer.appendChild(fragment);
  }

  function navigateToCrumb(index) {
    if (isNavigatingFolder) return;
    currentSearchQuery = "";
    isSearchActive = false;
    lastSearchResultsData = null;
    folderBreadcrumbs = folderBreadcrumbs.slice(0, index + 1);
    const target = folderBreadcrumbs[index];
    if (!target) return;
    if (currentFolderId === target.id && !isSearchActive) return;

    isNavigatingFolder = true;
    if (foldersContainer) foldersContainer.style.pointerEvents = "none";

    currentFolderId = target.id;
    currentFolderName = target.name;
    updateFolderFilterVisibility();
    clearSelection();

    // Rendu instantané immédiat (0 ms) des sous-dossiers depuis la mémoire
    if (Array.isArray(allFolders) && allFolders.length > 0) {
      const currentSubfolders = allFolders.filter(f => {
        if (currentFolderId === null) return f.parent_id === null || f.parent_id === undefined;
        return Number(f.parent_id) === Number(currentFolderId);
      });
      renderFolders(currentSubfolders);
    }

    // Rendu instantané des documents si déjà dans le cache LRU, sinon skeletons progressifs
    const cachedDocs = getFolderDocsCache(currentFolderId);
    if (cachedDocs) {
      currentLoadedDocs = cachedDocs;
      renderDocumentLibrary(cachedDocs);
    } else {
      renderFolderLoadingSkeletons(4);
    }

    loadFoldersAndDocuments();
  }

  function enterFolder(folder) {
    if (!folder || folder.id === undefined || folder.id === null) return;
    // Si une navigation est déjà en cours ou qu'on est déjà dans ce dossier, ignorer les clics multiples
    if (isNavigatingFolder) return;
    if (currentFolderId === folder.id) return;
    const lastCrumb = folderBreadcrumbs[folderBreadcrumbs.length - 1];
    if (lastCrumb && lastCrumb.id === folder.id) return;

    isNavigatingFolder = true;
    if (foldersContainer) foldersContainer.style.pointerEvents = "none";

    currentFolderId = folder.id;
    currentFolderName = folder.name;
    if (!lastCrumb || lastCrumb.id !== folder.id) {
      folderBreadcrumbs.push({ id: folder.id, name: folder.name });
    }
    updateFolderFilterVisibility();
    clearSelection();

    // Rendu instantané immédiat (0 ms) des sous-dossiers depuis la mémoire
    if (Array.isArray(allFolders) && allFolders.length > 0) {
      const subfolders = allFolders.filter(f => Number(f.parent_id) === Number(folder.id));
      renderFolders(subfolders);
    }

    // Rendu instantané des documents si déjà dans le cache LRU, sinon skeletons progressifs
    const cachedDocs = getFolderDocsCache(folder.id);
    if (cachedDocs) {
      currentLoadedDocs = cachedDocs;
      renderDocumentLibrary(cachedDocs);
    } else {
      renderFolderLoadingSkeletons(4);
    }

    loadFoldersAndDocuments();
  }

  async function loadFoldersAndDocuments() {
    const currentSeq = ++loadFoldersSeq;
    isSearchActive = false;
    currentSearchQuery = "";
    lastSearchResultsData = null;
    savedGeneralResultsScrollTop = 0;
    foldersSection.style.display = "";
    resultsContainer.innerHTML = "";
    if (searchStats) searchStats.textContent = "";
    if (clearSearchBtn && (!searchInput || !searchInput.value.trim())) {
      clearSearchBtn.style.display = "none";
    }
    showGeneralResultsView();
    renderBreadcrumbs();
    updateFolderFilterVisibility();
    updatePasteButtonUI();

    sectionTitle.textContent = currentFolderId ? `Documents dans "${currentFolderName}"` : "Documents";

    try {
      // Si complètement hors-ligne réseau : initialiser et charger directement depuis SQLite-Wasm local
      if (!navigator.onLine) {
        if (window.downloadQueueManager) {
          await window.downloadQueueManager.ensureInitialized(1500).catch(() => {});
        }
        let cachedDocs = [];
        let cachedFolders = [];
        if (window.downloadQueueManager) {
          cachedDocs = await window.downloadQueueManager.getAllCachedDocs().catch(() => []);
          cachedFolders = await window.downloadQueueManager.getAllCachedFolders().catch(() => []);
        }
        allFolders = cachedFolders || [];

        // Filtrer les dossiers du niveau courant (currentFolderId ou root)
        const currentLocalFolders = (cachedFolders || []).filter(f => {
          if (currentFolderId === null) {
            return f.parent_id === null || f.parent_id === undefined;
          }
          return Number(f.parent_id) === Number(currentFolderId);
        });

        // Filtrer les dossiers contenant au moins 1 document en cache
        const visibleFolders = currentLocalFolders.filter(f => {
          return window.downloadQueueManager ? window.downloadQueueManager.getCachedDocsCountForFolder(f.id) > 0 : true;
        });

        renderFolders(visibleFolders);

        if (currentFolderId !== null) {
          currentLoadedDocs = (cachedDocs || []).filter(d => Number(d.folder_id) === Number(currentFolderId));
        } else {
          currentLoadedDocs = (cachedDocs || []).filter(d => d.folder_id === null || d.folder_id === undefined);
        }
        renderDocumentLibrary(currentLoadedDocs);
        return;
      }

      // Si les dossiers sont déjà en mémoire, afficher immédiatement les dossiers du niveau courant
      if (Array.isArray(allFolders) && allFolders.length > 0) {
        const currentFolders = allFolders.filter(f => {
          if (currentFolderId === null) return f.parent_id === null || f.parent_id === undefined;
          return Number(f.parent_id) === Number(currentFolderId);
        });
        renderFolders(currentFolders);
      }

      // Si les documents du dossier ne sont pas encore affichés, afficher les skeletons progressifs
      if (!getFolderDocsCache(currentFolderId) && resultsContainer.querySelectorAll(".doc-card").length === 0) {
        renderFolderLoadingSkeletons(4);
      }

      // Charger tous les dossiers UNIQUEMENT si allFolders est encore vide
      const foldersPromise = (!allFolders || allFolders.length === 0)
        ? fetch("/api/folders").then(r => r.ok ? r.json() : null).catch(() => null)
        : Promise.resolve(null);

      // Charger en parallèle les documents du dossier courant
      const docFolderParam = currentFolderId ? currentFolderId : "root";
      const docsPromise = fetch(`/api/documents?folder_id=${docFolderParam}`);

      const [foldersData, docsRes] = await Promise.all([foldersPromise, docsPromise]);

      if (foldersData && Array.isArray(foldersData.folders)) {
        allFolders = foldersData.folders;
        const currentFolders = allFolders.filter(f => {
          if (currentFolderId === null) return f.parent_id === null || f.parent_id === undefined;
          return Number(f.parent_id) === Number(currentFolderId);
        });
        renderFolders(currentFolders);
        if (window.downloadQueueManager) {
          window.downloadQueueManager.syncFolders(allFolders).catch(() => {});
        }
      }

      if (!docsRes.ok) {
        throw new Error(`Réseau indisponible (HTTP ${docsRes.status})`);
      }
      const docsData = await docsRes.json();
      if (!docsData || !Array.isArray(docsData.documents)) {
        throw new Error("Réponse documents invalide");
      }
      const fetchedDocs = docsData.documents;

      // Mettre en cache LRU en RAM
      setFolderDocsCache(currentFolderId, fetchedDocs);

      // Synchronisation locale asynchrone non-bloquante
      if (window.downloadQueueManager && fetchedDocs.length > 0) {
        window.downloadQueueManager.syncDocFolders(fetchedDocs).catch(() => {});
      }

      // Si le filtre "Hors-ligne uniquement" est coché, restreindre l'affichage
      if (filterOfflineOnly && filterOfflineOnly.checked && window.downloadQueueManager) {
        const currentFolders = (allFolders || []).filter(f => {
          if (currentFolderId === null) return f.parent_id === null || f.parent_id === undefined;
          return Number(f.parent_id) === Number(currentFolderId);
        });
        const visibleFolders = currentFolders.filter(f => window.downloadQueueManager.getCachedDocsCountForFolder(f.id) > 0);
        renderFolders(visibleFolders);
        currentLoadedDocs = fetchedDocs.filter(d => window.downloadQueueManager.isDocumentCached(d.id));
      } else {
        currentLoadedDocs = fetchedDocs;
      }

      // Si une recherche a été lancée entre-temps par l'utilisateur, ne pas écraser l'affichage
      if (currentSeq !== loadFoldersSeq || currentSearchQuery || isSearchActive) {
        return;
      }

      renderDocumentLibrary(currentLoadedDocs);

    } catch (err) {
      console.error("Erreur chargement arborescence:", err);
      // Fallback automatique vers SQLite-Wasm en cas d'erreur de requête
      if (window.downloadQueueManager) {
        const cachedDocs = await window.downloadQueueManager.getAllCachedDocs().catch(() => []);
        const cachedFolders = await window.downloadQueueManager.getAllCachedFolders().catch(() => []);
        allFolders = cachedFolders || [];

        const currentLocalFolders = (cachedFolders || []).filter(f => {
          if (currentFolderId === null) {
            return f.parent_id === null || f.parent_id === undefined;
          }
          return Number(f.parent_id) === Number(currentFolderId);
        });

        const visibleFolders = currentLocalFolders.filter(f => {
          return window.downloadQueueManager ? window.downloadQueueManager.getCachedDocsCountForFolder(f.id) > 0 : true;
        });

        renderFolders(visibleFolders);

        if (currentFolderId !== null) {
          currentLoadedDocs = (cachedDocs || []).filter(d => Number(d.folder_id) === Number(currentFolderId));
        } else {
          currentLoadedDocs = (cachedDocs || []).filter(d => d.folder_id === null || d.folder_id === undefined);
        }

        if (filterOfflineOnly && !filterOfflineOnly.checked) {
          filterOfflineOnly.checked = true;
          if (filterOfflineChip) filterOfflineChip.classList.add("active");
        }
        if (offlineNoticeBanner) {
          offlineNoticeBanner.style.display = "flex";
        }

        renderDocumentLibrary(currentLoadedDocs);
      } else {
        showToast("Erreur de chargement des documents et dossiers", "error");
      }
    } finally {
      isNavigatingFolder = false;
      if (foldersContainer) foldersContainer.style.pointerEvents = "";
    }
  }

  function renderFolders(folders) {
    foldersContainer.innerHTML = "";

    if (!folders || folders.length === 0) {
      foldersSection.style.display = "none";
      return;
    }

    foldersSection.style.display = "block";

    // Trier les dossiers selon le mode de tri si applicable
    let sortedFolders = [...folders];
    if (currentSortMode === "name_asc") {
      sortedFolders.sort((a, b) => (a.name || "").localeCompare(b.name || "", "fr", { numeric: true, sensitivity: "base" }));
    } else if (currentSortMode === "name_desc") {
      sortedFolders.sort((a, b) => (b.name || "").localeCompare(a.name || "", "fr", { numeric: true, sensitivity: "base" }));
    } else if (currentSortMode === "date_add_desc" || currentSortMode === "date_mod_desc") {
      sortedFolders.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } else if (currentSortMode === "date_add_asc" || currentSortMode === "date_mod_asc") {
      sortedFolders.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    }

    sortedFolders.forEach(folder => {
      const card = document.createElement("div");
      card.className = "goodnotes-item-row folder-row folder-card";
      card.setAttribute("data-folder-id", folder.id);
      card.setAttribute("data-doc-count", folder.doc_count || 0);

      const totalDocsInFolder = folder.doc_count || 0;
      const cachedDocsInFolder = window.downloadQueueManager ? window.downloadQueueManager.getCachedDocsCountForFolder(folder.id) : 0;
      const isFolderComplete = totalDocsInFolder > 0 && cachedDocsInFolder >= totalDocsInFolder;
      const isFolderPartial = cachedDocsInFolder > 0 && (!totalDocsInFolder || cachedDocsInFolder < totalDocsInFolder);

      let folderSyncHtml = "";
      if (isFolderComplete) {
        folderSyncHtml = `
          <button class="folder-btn-action sync-action-btn complete btn-delete-folder-cache" title="Supprimer tous les documents de ce dossier du cache local" data-id="${folder.id}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </button>
        `;
      } else if (isFolderPartial) {
        folderSyncHtml = `
          <button class="folder-btn-action sync-action-btn partial btn-download-folder" title="Télécharger les documents manquants (${cachedDocsInFolder}/${totalDocsInFolder})" data-id="${folder.id}">
            <span class="sync-badge-count">${cachedDocsInFolder}/${totalDocsInFolder}</span>
          </button>
        `;
      } else if (totalDocsInFolder > 0) {
        folderSyncHtml = `
          <button class="folder-btn-action sync-action-btn btn-download-folder" title="Télécharger tous les documents de ce dossier" data-id="${folder.id}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><polyline points="8 12 12 16 16 12"></polyline><line x1="12" y1="8" x2="12" y2="16"></line></svg>
          </button>
        `;
      }

      card.innerHTML = `
        <div class="goodnotes-row-icon folder">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <div class="goodnotes-row-main">
          <div class="goodnotes-row-title" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</div>
          <div class="goodnotes-row-meta folder-meta">
            <span>${totalDocsInFolder > 0 ? `${totalDocsInFolder} document${totalDocsInFolder > 1 ? 's' : ''}` : '0 document'}</span>
          </div>
        </div>
        <div class="goodnotes-row-actions">
          ${folderSyncHtml}
          <button class="folder-btn-action btn-delete-folder" title="Supprimer ce dossier" data-id="${folder.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
          <svg class="goodnotes-row-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>
      `;

      // Clic pour entrer dans le dossier
      card.addEventListener("click", (e) => {
        if (e.target.closest(".folder-btn-action")) return;
        enterFolder(folder);
      });

      // Bouton télécharger dossier pour le mode hors-ligne
      const downloadFolderBtn = card.querySelector(".btn-download-folder");
      if (downloadFolderBtn) {
        downloadFolderBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (window.downloadQueueManager) {
            await window.downloadQueueManager.enqueueFolder(folder.id);
            showToast(`Téléchargement de l'ensemble du dossier "${folder.name}" enclenché`, "info");
          }
        });
      }

      // Bouton supprimer le dossier du cache local
      const deleteFolderCacheBtn = card.querySelector(".btn-delete-folder-cache");
      if (deleteFolderCacheBtn) {
        deleteFolderCacheBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (confirm(`Supprimer tous les documents du dossier "${folder.name}" du cache local hors-ligne ?`)) {
            if (window.downloadQueueManager) {
              await window.downloadQueueManager.removeFolderFromCache(folder.id);
              showToast(`Dossier "${folder.name}" retiré du cache local`, "info");
              loadFoldersAndDocuments();
            }
          }
        });
      }

      // Bouton supprimer dossier
      const delBtn = card.querySelector(".btn-delete-folder");
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDeleteFolder(folder.id, folder.name);
      });


      // Drop Zone pour Glisser-Déposer de documents (multi ou unique)
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        card.classList.add("drag-over");
      });

      card.addEventListener("dragleave", () => {
        card.classList.remove("drag-over");
      });

      card.addEventListener("drop", async (e) => {
        e.preventDefault();
        card.classList.remove("drag-over");

        let docIds = [];
        const jsonPayload = e.dataTransfer.getData("application/json");
        if (jsonPayload) {
          try { docIds = JSON.parse(jsonPayload); } catch (err) {}
        }
        if (!docIds || docIds.length === 0) {
          const plainId = e.dataTransfer.getData("text/plain");
          if (plainId) docIds = [parseInt(plainId, 10)];
        }

        if (docIds.length > 0) {
          await batchMoveDocuments(docIds, folder.id, folder.name);
        }
      });

      foldersContainer.appendChild(card);
    });
  }

  // =========================================================================
  // Fonctions de Tri
  // =========================================================================
  function sortDocumentsList(docs, sortMode) {
    if (!docs || docs.length === 0) return [];
    const copy = [...docs];

    switch (sortMode) {
      case "name_asc":
        copy.sort((a, b) => (a.title || a.filename || "").localeCompare(b.title || b.filename || "", "fr", { numeric: true, sensitivity: "base" }));
        break;
      case "name_desc":
        copy.sort((a, b) => (b.title || b.filename || "").localeCompare(a.title || a.filename || "", "fr", { numeric: true, sensitivity: "base" }));
        break;
      case "date_mod_desc":
        copy.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
        break;
      case "date_mod_asc":
        copy.sort((a, b) => new Date(a.updated_at || a.created_at || 0) - new Date(b.updated_at || b.created_at || 0));
        break;
      case "date_add_desc":
        copy.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        break;
      case "date_add_asc":
        copy.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
        break;
      case "relevance":
        copy.sort((a, b) => (b.relevance_score ?? b.total_occurrences ?? 0) - (a.relevance_score ?? a.total_occurrences ?? 0));
        break;
      default:
        break;
    }
    return copy;
  }

  function updateSortOptionsForSearch(isSearch) {
    if (!sortSelect) return;
    let relOpt = sortSelect.querySelector("option[value='relevance']");
    if (isSearch) {
      if (!relOpt) {
        relOpt = document.createElement("option");
        relOpt.value = "relevance";
        relOpt.textContent = "Pertinence";
        sortSelect.insertBefore(relOpt, sortSelect.firstChild);
      }
    } else {
      if (relOpt) {
        if (sortSelect.value === "relevance") {
          sortSelect.value = "name_asc";
          currentSortMode = "name_asc";
        }
        relOpt.remove();
      }
    }
    updateSortPillLabel();
  }

  // =========================================================================
  // Affichage des Documents (Bibliothèque & Résultats)
  // =========================================================================
  function renderDocumentLibrary(docs) {
    mainGridCropManager.clear();
    resultsContainer.innerHTML = "";
    rawLoadedDocs = docs || [];

    updateSortOptionsForSearch(false);

    if (!docs || docs.length === 0) {
      currentLoadedDocs = [];
      if (foldersContainer.children.length === 0) {
        emptyState.style.display = "flex";
        emptyMessage.textContent = currentFolderId ? "Ce dossier est vide. Glissez-y des documents ou importez un PDF." : "Aucun document indexé. Cliquez sur 'Importer PDF' ou 'Scanner' pour commencer.";
      } else {
        emptyState.style.display = "none";
      }
      return;
    }

    emptyState.style.display = "none";

    const sortedDocs = sortDocumentsList(rawLoadedDocs, currentSortMode);
    currentLoadedDocs = sortedDocs;

    _docCardMap.clear();
    sortedDocs.forEach(doc => {
      const card = createDocCardElement(doc, false);
      _docCardMap.set(doc.id, card);
      resultsContainer.appendChild(card);
    });

    updateSelectionUI();
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Cache LRU de RegExp compilées par query (max 5 entrées) — C3
  const _highlightRegexpCache = new Map();

  function highlightTitle(title, query) {
    if (!title) return "";
    // Les titres provenant de fichiers macOS sont souvent en Unicode NFD (décomposé :
    // « é » = « e » + U+0301). La requête est normalisée mais le titre doit l'être aussi,
    // sinon les classes d'accents [eèéêë…] butent sur le combining mark → aucun surlignage.
    title = String(title).normalize("NFC");
    if (!query || !query.trim()) return escapeHtml(title);

    try {
      const rawTerms = query.trim().split(/\s+/).filter(t => t.length >= 1);
      if (rawTerms.length === 0) return escapeHtml(title);

      // Chercher dans le cache avant de compiler
      const cacheKey = query.trim().toLowerCase();
      let pattern = _highlightRegexpCache.get(cacheKey);

      if (!pattern) {
        const accentMap = {
          'a': '[aàáâãäåAÀÁÂÃÄÅ]',
          'e': '[eèéêëEÈÉÊË]',
          'i': '[iìíîïIÌÍÎÏ]',
          'o': '[oòóôõöOÒÓÔÕÖ]',
          'u': '[uùúûüUÙÚÛÜ]',
          'c': '[cçCÇ]',
          'n': '[nñNÑ]'
        };

        const patterns = [];
        rawTerms.forEach(term => {
          const variants = [term];
          if ((term.endsWith('s') || term.endsWith('x')) && term.length > 3) {
            variants.push(term.slice(0, -1));
          }
          variants.forEach(v => {
            const normalized = v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
            const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regexStr = escaped.split('').map(ch => accentMap[ch] || `[${ch.toUpperCase()}${ch.toLowerCase()}]`).join('');
            if (v.length <= 2) {
              patterns.push(`(?<!\\w)${regexStr}(?!\\w)`);
            } else {
              patterns.push(`(?<!\\w)${regexStr}`);
            }
          });
        });

        if (patterns.length === 0) return escapeHtml(title);

        // Trier par longueur décroissante pour privilégier la variante la plus longue (ex: 'complications' avant 'complication')
        patterns.sort((a, b) => b.length - a.length);
        pattern = new RegExp(`(${patterns.join('|')})`, 'gi');

        // Insérer dans le cache LRU (éviction de la plus ancienne entrée si > 5)
        _highlightRegexpCache.set(cacheKey, pattern);
        if (_highlightRegexpCache.size > 5) {
          _highlightRegexpCache.delete(_highlightRegexpCache.keys().next().value);
        }
      }

      // Réinitialiser l'index pour la recherche (la RegExp est sticky via 'g')
      pattern.lastIndex = 0;
      let lastIndex = 0;
      let result = '';
      let match;
      while ((match = pattern.exec(title)) !== null) {
        result += escapeHtml(title.substring(lastIndex, match.index));
        result += `<mark class="title-highlight">${escapeHtml(match[0])}</mark>`;
        lastIndex = pattern.lastIndex;
      }
      result += escapeHtml(title.substring(lastIndex));
      return result;
    } catch (e) {
      console.warn("highlightTitle exception:", e);
      return escapeHtml(title);
    }
  }

  function createDocCardElement(doc, isSearch = false) {
    const isIndexing = doc.status === "pending" || doc.status === "indexing";
    const isFailed = doc.status === "failed";
    const statusCardClass = isIndexing ? "is-indexing" : (isFailed ? "is-failed" : "");
    const isCached = Boolean(window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(doc.id));

    const card = document.createElement("div");
    card.setAttribute("draggable", "true");
    card.setAttribute("data-doc-id", doc.id);

    // Glisser-Déposer (Support multi-sélection)
    card.addEventListener("dragstart", (e) => {
      // Si la carte traînée n'est pas dans la sélection, la sélectionner exclusivement
      if (!selectedDocIds.has(doc.id)) {
        if (!e.metaKey && !e.ctrlKey) {
          selectedDocIds.clear();
        }
        selectedDocIds.add(doc.id);
        updateSelectionUI();
      }

      const idsToDrag = Array.from(selectedDocIds);
      e.dataTransfer.setData("application/json", JSON.stringify(idsToDrag));
      e.dataTransfer.setData("text/plain", doc.id.toString());
      e.dataTransfer.effectAllowed = "move";

      card.classList.add("dragging");
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
    });

    // Clic pour sélection avec Cmd / Ctrl ou Maj
    card.addEventListener("click", (e) => {
      // Si le clic vient d'un bouton d'action ou d'une vignette, ne pas modifier la sélection globale
      if (e.target.closest("button") || e.target.closest(".vignette-item")) return;

      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;

      if (isCmdOrCtrl) {
        // Toggle unique
        if (selectedDocIds.has(doc.id)) {
          selectedDocIds.delete(doc.id);
        } else {
          selectedDocIds.add(doc.id);
        }
        lastSelectedDocId = doc.id;
        updateSelectionUI();
        return;
      }

      if (isShift && lastSelectedDocId && currentLoadedDocs.length > 0) {
        // Sélection par plage (Shift+Click)
        const ids = currentLoadedDocs.map(d => d.id);
        const startIdx = ids.indexOf(lastSelectedDocId);
        const endIdx = ids.indexOf(doc.id);
        if (startIdx !== -1 && endIdx !== -1) {
          const [low, high] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
          for (let i = low; i <= high; i++) {
            selectedDocIds.add(ids[i]);
          }
          updateSelectionUI();
          return;
        }
      }

      // Clic normal : si une sélection était active, la vider
      if (selectedDocIds.size > 0) {
        clearSelection();
      }
    });

    // Propriétaire de l'état : currentSearchQuery (la lecture de searchInput.value ici
    // est fragile : le rendu asynchrone peut s'exécuter alors que le champ a été vidé/modifié).
    const query = (isSearch && currentSearchQuery && currentSearchQuery.trim())
      ? currentSearchQuery.trim()
      : (searchInput ? searchInput.value.trim() : "");
    const displayTitle = (isSearch && query) 
      ? highlightTitle(doc.title, query) 
      : escapeHtml(doc.title);

    if (!isSearch) {
      // Affichage Goodnotes unifié (ligne continue élégante comme sur mobile)
      card.className = `goodnotes-item-row document-row doc-card ${selectedDocIds.has(doc.id) ? 'selected' : ''} ${statusCardClass}`;
      card.innerHTML = `
        <input type="checkbox" class="doc-selection-checkbox goodnotes-row-checkbox" data-id="${doc.id}" ${selectedDocIds.has(doc.id) ? 'checked' : ''} title="Sélectionner ce document" />
        <div class="goodnotes-row-icon document ${isCached ? 'cached' : ''}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
          </svg>
        </div>
        <div class="goodnotes-row-main">
          <div class="goodnotes-row-title doc-title-main" title="${escapeHtml(doc.title)}">${displayTitle}</div>
          <div class="goodnotes-row-meta">
            <span>${isIndexing ? (doc.status === 'indexing' ? '⏳ Indexation...' : '⌛ En attente') : (isFailed ? '❌ Échec' : `${doc.total_pages || 1} page${(doc.total_pages || 1) > 1 ? 's' : ''}`)}</span>
            ${doc.file_size ? `<span>•</span><span>${formatBytes(doc.file_size)}</span>` : ''}
            ${doc.created_at ? `<span>•</span><span>${new Date(doc.created_at).toLocaleDateString('fr-FR')}</span>` : ''}
          </div>
        </div>
        <div class="goodnotes-row-actions">
          <button class="doc-cache-btn ${isCached ? 'cached' : ''}" data-id="${doc.id}" title="${isCached ? 'Disponible hors-ligne' : 'Télécharger pour consultation hors-ligne'}" aria-label="Cache hors-ligne">
            ${isCached ? `
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            ` : `
              <svg class="cache-icon-cloud" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 16.9A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"></path>
                <polyline points="8 17 12 21 16 17"></polyline>
                <line x1="12" y1="12" x2="12" y2="21"></line>
              </svg>
            `}
          </button>
          <button class="doc-menu-trigger-btn" data-id="${doc.id}" title="Options du document (Renommer, Déplacer, Réindexer, Supprimer)" aria-label="Options">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2.2"></circle>
              <circle cx="12" cy="12" r="2.2"></circle>
              <circle cx="12" cy="19" r="2.2"></circle>
            </svg>
          </button>
          <svg class="goodnotes-row-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>
      `;
    } else {
      card.className = `doc-card ${selectedDocIds.has(doc.id) ? 'selected' : ''} ${statusCardClass}`;
      let vignettesHtml = '';
      if (doc.vignettes && doc.vignettes.length > 0) {
        doc.vignettes.forEach(v => {
          vignettesHtml += `
            <div class="vignette-item" data-doc-id="${doc.id}" data-page="${v.page_number}" data-occ="${v.occ_id}" data-rect='${JSON.stringify(v.rect || [])}' data-hl-rects='${JSON.stringify(v.highlight_rects || (v.rect ? [v.rect] : []))}' data-yratio="${v.y_ratio || 0}" data-snippet="${encodeURIComponent(v.text_snippet || '')}" title="Page ${v.page_number}${v.font_size >= 14 ? ' (Titre)' : ''} - Cliquer pour ouvrir">
              <img src="${PLACEHOLDER_CROP_SVG}" data-src="${v.crop_url}" class="vignette-crop-img dynamic-main-crop" alt="Extrait p. ${v.page_number}" style="opacity: 0.6; transition: opacity 0.2s ease-in-out;" />
              <span class="vignette-page-badge">${v.font_size >= 14 ? '📌 ' : ''}p. ${v.page_number}</span>
            </div>
          `;
        });
      } else if (filterTitlesOnly.checked) {
        vignettesHtml = `<div style="display:flex; align-items:center; color:var(--accent); font-size:12.5px; font-weight:600;">Correspondance dans le titre du document.</div>`;
      } else {
        vignettesHtml = `<div style="color:var(--text-dim); font-size:12.5px; align-self:center;">Aucun extrait visuel.</div>`;
      }

      card.innerHTML = `
        <div class="doc-card-header">
          <div style="display: flex; align-items: center; gap: 8px; overflow: hidden; flex: 1;">
            <input type="checkbox" class="doc-selection-checkbox" data-id="${doc.id}" ${selectedDocIds.has(doc.id) ? 'checked' : ''} title="Sélectionner ce document" />
            <div class="doc-title-main" title="${escapeHtml(doc.title)}">${displayTitle}</div>
          </div>
          <div class="doc-meta-badges">
            ${doc.is_top_result ? `<span class="doc-badge-pill top-badge" title="Score de pertinence le plus élevé">★ Plus pertinent</span>` : ''}
            <span class="doc-badge-pill highlight">${doc.total_occurrences} occ.</span>
            ${isIndexing ? `<span class="doc-badge-pill" style="background:rgba(37,99,235,0.1); color:var(--accent);">${doc.status === 'indexing' ? '⏳ Indexation...' : '⌛ En attente'}</span>` : `<span class="doc-badge-pill">${doc.total_pages} p.</span>`}
            
            <button class="doc-cache-btn ${window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(doc.id) ? 'cached' : ''}" data-id="${doc.id}" title="${window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(doc.id) ? 'Disponible hors-ligne' : 'Télécharger pour consultation hors-ligne'}" aria-label="Cache hors-ligne">
              ${window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(doc.id) ? `
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              ` : `
                <svg class="cache-icon-cloud" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M19 16.9A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"></path>
                  <polyline points="8 17 12 21 16 17"></polyline>
                  <line x1="12" y1="12" x2="12" y2="21"></line>
                </svg>
              `}
            </button>
            <button class="doc-menu-trigger-btn" data-id="${doc.id}" title="Options du document (Renommer, Déplacer, Réindexer, Supprimer)" aria-label="Options">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2.2"></circle>
                <circle cx="12" cy="12" r="2.2"></circle>
                <circle cx="12" cy="19" r="2.2"></circle>
              </svg>
            </button>
          </div>
        </div>
        <div class="doc-card-body">
          <div class="doc-cover-wrapper" title="${isIndexing ? 'Document en cours d\'indexation...' : (isFailed ? 'Échec d\'indexation' : 'Ouvrir le document')}">
            ${isIndexing ? `
              <div class="doc-indexing-overlay">
                <span class="spin-indicator"></span>
                <span>${doc.status === 'indexing' ? 'Indexation...' : 'En attente'}</span>
              </div>
            ` : ''}
            ${isFailed ? `
              <div class="doc-failed-overlay" title="${escapeHtml(doc.error_message || 'Erreur d\'indexation')}">
                <span>Échec</span>
              </div>
            ` : ''}
            <img src="${PLACEHOLDER_COVER_SVG}" data-src="${doc.cover_url}" class="doc-cover-img dynamic-main-crop" alt="Couverture" style="opacity: 0.6; transition: opacity 0.2s ease-in-out;" />
          </div>
          <div class="doc-card-vignettes">
            <div class="vignettes-ribbon-container">
              ${vignettesHtml}
            </div>
          </div>
        </div>
      `;
    }

    // Clic case à cocher de sélection tactile
    const checkbox = card.querySelector(".doc-selection-checkbox");
    if (checkbox) {
      const toggleSelect = (e) => {
        e.stopPropagation();
        if (checkbox.checked) {
          selectedDocIds.add(doc.id);
        } else {
          selectedDocIds.delete(doc.id);
        }
        lastSelectedDocId = doc.id;
        updateSelectionUI();
      };
      checkbox.addEventListener("click", toggleSelect);
      checkbox.addEventListener("change", toggleSelect);
    }

    // Gestion de la suppression du cache local
    let lastCacheActionTime = 0;
    const handleDeleteDocCache = async (e) => {
      e.stopPropagation();
      if (!window.downloadQueueManager) return;
      const now = Date.now();
      if (now - lastCacheActionTime < 60) return;
      lastCacheActionTime = now;

      const isCached = window.downloadQueueManager.isDocumentCached(doc.id);
      const isTaskActive = window.downloadQueueManager.activeTasks.has(doc.id);
      const isTaskQueued = window.downloadQueueManager.queue.includes(doc.id);
      const stats = window.pdfCacheManager ? window.pdfCacheManager.progressCache.get(doc.id) : null;
      const hasChunks = Boolean(stats && stats.downloadedBytes > 0);
      const canDelete = isCached || isTaskActive || isTaskQueued || hasChunks;

      if (!canDelete) return;

      lastCacheActionTime = Date.now();
      if (cacheBtn) {
        cacheBtn.style.pointerEvents = "none";
        setTimeout(() => { if (cacheBtn) cacheBtn.style.pointerEvents = ""; }, 60);
      }
      await window.downloadQueueManager.removeDocumentFromCache(doc.id);
      updateDocCardCacheUI(doc.id);
      if (Number(currentActiveDocId) === Number(doc.id)) {
        const badge = document.getElementById("viewerCacheBadge");
        if (badge) {
          badge.className = "viewer-doc-badge viewer-cache-badge cloud";
          badge.textContent = "☁️ Non téléchargé";
          badge.title = "Document en ligne (non stocké localement). Cliquez pour le mettre en cache hors-ligne.";
        }
      }
      showToast(`"${doc.title || doc.filename}" retiré du cache local`, "info");
      if (filterOfflineOnly && filterOfflineOnly.checked) {
        if (currentSearchQuery) performSearch(currentSearchQuery);
        else loadFoldersAndDocuments();
      }
    };

    // Clic bouton cache hors-ligne
    const cacheBtn = card.querySelector(".doc-cache-btn");
    if (cacheBtn) {
      if (window.pdfCacheManager) {
        window.pdfCacheManager.isComplete(doc.id).then(complete => {
          if (complete && window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(doc.id)) {
            updateDocCardCacheUI(doc.id);
          }
        });
      }

      cacheBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!window.downloadQueueManager) return;
        const now = Date.now();
        if (now - lastCacheActionTime < 60 || e.detail > 1) {
          // Ignorer le clic fantôme consécutif à une suppression (double-clic décalé sous la souris)
          return;
        }
        await window.downloadQueueManager.ensureInitialized(1500).catch(() => {});
        const isCurrentlyCached = window.downloadQueueManager.isDocumentCached(doc.id);
        const isTaskActive = window.downloadQueueManager.activeTasks.has(doc.id);
        const isTaskQueued = window.downloadQueueManager.queue.includes(doc.id);
        const stats = window.pdfCacheManager ? window.pdfCacheManager.progressCache.get(doc.id) : null;
        if (isCurrentlyCached) {
          await handleDeleteDocCache(e);
        } else if (isTaskActive || isTaskQueued) {
          await window.downloadQueueManager.cancelDownload(doc.id);
          showToast(`Téléchargement interrompu pour "${doc.title || doc.filename}"`, "info");
          updateDocCardCacheUI(doc.id);
        } else {
          lastCacheActionTime = now;
          await window.downloadQueueManager.enqueueDocument(doc.id);
          updateDocCardCacheUI(doc.id);
          showToast(`Document "${doc.title || doc.filename}" ajouté à la file de téléchargement`, "info");
        }
      });
    }

    // Clic menu contextuel d'options •••
    const menuBtn = card.querySelector(".doc-menu-trigger-btn");
    if (menuBtn) {
      menuBtn.addEventListener("click", (e) => {
        openDocContextMenu(e, doc.id, doc.title);
      });
    }


    // Support de l'appui long tactile pour sélectionner facilement sur tablette et smartphone
    let touchTimer = null;
    let touchMoved = false;

    card.addEventListener("touchstart", (e) => {
      if (e.target.closest("button") || e.target.closest(".vignette-item") || e.target.closest("input")) return;
      touchMoved = false;
      touchTimer = setTimeout(() => {
        if (!touchMoved) {
          if (!selectedDocIds.has(doc.id)) {
            selectedDocIds.add(doc.id);
          } else {
            selectedDocIds.delete(doc.id);
          }
          updateSelectionUI();
          if (navigator.vibrate) navigator.vibrate(35);
        }
      }, 480);
    }, { passive: true });

    card.addEventListener("touchmove", () => {
      touchMoved = true;
      if (touchTimer) clearTimeout(touchTimer);
    }, { passive: true });

    card.addEventListener("touchend", () => {
      if (touchTimer) clearTimeout(touchTimer);
    }, { passive: true });

    // Défilement par glisser à la souris du ruban Goodnotes sur ordinateur
    const ribbon = card.querySelector(".vignettes-ribbon-container");
    if (ribbon) {
      let isMouseDown = false;
      let hasDragged = false;
      let startX;
      let scrollLeftPos;

      ribbon.addEventListener("mousedown", (e) => {
        isMouseDown = true;
        hasDragged = false;
        startX = e.pageX - ribbon.offsetLeft;
        scrollLeftPos = ribbon.scrollLeft;
      });
      ribbon.addEventListener("mouseleave", () => { isMouseDown = false; });
      ribbon.addEventListener("mouseup", () => { isMouseDown = false; });
      ribbon.addEventListener("mousemove", (e) => {
        if (!isMouseDown) return;
        const x = e.pageX - ribbon.offsetLeft;
        const walk = (x - startX) * 1.5;
        if (Math.abs(walk) > 4) hasDragged = true;
        e.preventDefault();
        ribbon.scrollLeft = scrollLeftPos - walk;
      });

      // Clics vignettes (délégation d'événements pour toutes les vignettes, initiales et scroll infini)
      ribbon.addEventListener("click", (e) => {
        if (hasDragged) return;
        const vEl = e.target.closest(".vignette-item");
        if (!vEl) return;
        const dPage = parseInt(vEl.getAttribute("data-page"), 10);
        const yRatio = parseFloat(vEl.getAttribute("data-yratio") || 0);
        const occId = vEl.getAttribute("data-occ");
        let rect = null;
        try { rect = JSON.parse(vEl.getAttribute("data-rect") || "[]"); } catch(e) {}
        // Héritage EXPLICITE de la recherche globale au moment du clic (vignette de résultat)
        openDocumentInSplitView(doc.id, doc.title, dPage, doc.occurrences_by_page || doc.vignettes || [], rect, yRatio, occId, currentSearchQuery || null);
      });

      // Scroll infini horizontal : chargement transparent des occurrences suivantes au scroll vers la droite
      const initialVignettesCount = doc.vignettes ? doc.vignettes.length : 0;
      const totalAvailableOccurrences = doc.total_occurrences || initialVignettesCount;

      if (isSearch && totalAvailableOccurrences > initialVignettesCount) {
        let loadedCount = initialVignettesCount;
        let isLoadingChunk = false;
        const CHUNK_SIZE = 25;

        const loadMoreVignettes = async () => {
          if (isLoadingChunk || loadedCount >= totalAvailableOccurrences) return;
          isLoadingChunk = true;

          try {
            let data = null;
            const isDocCached = Boolean(window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(doc.id));
            const isOfflineFilter = document.getElementById("filterOfflineOnly")?.checked || false;
            const isOfflineMode = !navigator.onLine || isOfflineFilter || isDocCached;

            if (isOfflineMode && window.downloadQueueManager) {
              try {
                data = await window.downloadQueueManager.sendToWorker('DOC_SEARCH', {
                  docId: doc.id,
                  query: currentSearchQuery || '',
                  offset: loadedCount,
                  limit: CHUNK_SIZE
                });
              } catch (offlineErr) {
                console.warn('[DocSeeker] Erreur recherche offline dans loadMoreVignettes:', offlineErr);
              }
            }

            if (!data) {
              const fetchUrl = `/api/doc-search?doc_id=${doc.id}&q=${encodeURIComponent(currentSearchQuery || '')}&offset=${loadedCount}&limit=${CHUNK_SIZE}`;
              const res = await fetch(fetchUrl);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              data = await res.json();
            }

            const newOccs = data?.occurrences || [];

            if (newOccs.length === 0) {
              loadedCount = totalAvailableOccurrences;
              return;
            }

            loadedCount += newOccs.length;
            if (doc.occurrences_by_page) {
              doc.occurrences_by_page.push(...newOccs);
            }
            if (doc.vignettes) {
              doc.vignettes.push(...newOccs);
            }

            const fragment = document.createDocumentFragment();
            newOccs.forEach(v => {
              const vEl = document.createElement("div");
              vEl.className = "vignette-item";
              vEl.setAttribute("data-doc-id", doc.id);
              vEl.setAttribute("data-page", v.page_number);
              vEl.setAttribute("data-occ", v.occ_id);
              vEl.setAttribute("data-rect", JSON.stringify(v.rect || []));
              vEl.setAttribute("data-hl-rects", JSON.stringify(v.highlight_rects || (v.rect ? [v.rect] : [])));
              vEl.setAttribute("data-yratio", v.y_ratio || 0);
              vEl.setAttribute("data-snippet", encodeURIComponent(v.text_snippet || ''));
              vEl.title = `Page ${v.page_number} - Cliquer pour ouvrir`;

              vEl.innerHTML = `
                <img src="${PLACEHOLDER_CROP_SVG}" data-src="${v.crop_url}" class="vignette-crop-img dynamic-main-crop" alt="Extrait p. ${v.page_number}" style="opacity: 0.6; transition: opacity 0.2s ease-in-out;" />
                <span class="vignette-page-badge">p. ${v.page_number}</span>
              `;

              const img = vEl.querySelector(".dynamic-main-crop");
              if (img) mainGridCropManager.observe(img);

              fragment.appendChild(vEl);
            });

            ribbon.appendChild(fragment);
          } catch (err) {
            console.error("Erreur chargement vignettes supplémentaires:", err);
          } finally {
            isLoadingChunk = false;
          }
        };

        ribbon.addEventListener("scroll", () => {
          if (ribbon.scrollLeft + ribbon.clientWidth >= ribbon.scrollWidth - 120) {
            loadMoreVignettes();
          }
        }, { passive: true });
      }
    }

    // Observer pour le chargement prioritaire dynamique avec annulation au défilement
    card.querySelectorAll(".dynamic-main-crop").forEach(img => mainGridCropManager.observe(img));

    // Clics couverture et titre (double-clic ou clic si pas en sélection modale)
    const openDocAction = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (selectedDocIds.size > 0) return;
      if (doc.status === "pending" || doc.status === "indexing") {
        showToast("Ce document est en cours d'indexation en tâche de fond. Il sera consultable dans quelques instants.", "info");
        return;
      }
      if (doc.status === "failed") {
        showToast(`Document en échec : ${doc.error_message || 'Erreur d\'indexation'}. Relance de l'indexation...`, "warning");
        handleReindexDocument(doc.id, doc.title, null);
        return;
      }
      const firstOcc = (doc.occurrences_by_page && doc.occurrences_by_page.length > 0) ? doc.occurrences_by_page[0] : null;
      const firstPage = firstOcc ? firstOcc.page_number : 1;
      const firstRect = firstOcc ? ((firstOcc.highlight_rects && firstOcc.highlight_rects.length > 0) ? firstOcc.highlight_rects[0] : firstOcc.rect) : null;
      const yRatio = firstOcc ? firstOcc.y_ratio : 0;
      const firstOccId = firstOcc ? firstOcc.occ_id : null;
      // Héritage EXPLICITE de la recherche globale au moment du clic (couverture/titre de résultat)
      openDocumentInSplitView(doc.id, doc.title, firstPage, doc.occurrences_by_page || doc.vignettes || [], firstRect, yRatio, firstOccId, currentSearchQuery || null);
    };

    if (!isSearch) {
      card.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest(".doc-selection-checkbox") || e.target.closest("input")) return;
        openDocAction(e);
      });
    } else {
      const coverWrapper = card.querySelector(".doc-cover-wrapper");
      if (coverWrapper) coverWrapper.addEventListener("click", openDocAction);
      const titleEl = card.querySelector(".doc-title-main");
      if (titleEl) titleEl.addEventListener("click", openDocAction);
    }

    return card;
  }

  // =========================================================================
  // Recherche avec Filtres (Titres & Dossier) et Routage Hors-Ligne
  // =========================================================================
  async function performSearchRequest(query, isTitlesOnly, isFolderOnly, folderId, limit = 15, offset = 0) {
    const isOffline = !navigator.onLine || (filterOfflineOnly && filterOfflineOnly.checked);
    if (isOffline) {
      if (window.downloadQueueManager) {
        const searchResult = await window.downloadQueueManager.sendToWorker('SEARCH', {
          query,
          titlesOnly: isTitlesOnly,
          folderId: isFolderOnly ? folderId : null,
          limit,
          offset,
        });
        if (searchResult && Array.isArray(searchResult.results)) {
          searchResult.results = searchResult.results.filter(d => window.downloadQueueManager.isDocumentCached(d.id));
          searchResult.total_documents = searchResult.results.length;
        }
        return searchResult;
      }
      throw new Error("Moteur de recherche hors-ligne indisponible");
    }

    let url = `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
    if (isTitlesOnly) url += `&titles_only=true`;
    if (isFolderOnly && folderId !== null) url += `&folder_id=${folderId}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      return await res.json();
    } catch (netErr) {
      console.warn("[Search] Échec requête en ligne, bascule automatique sur le moteur local hors-ligne :", netErr);
      if (filterOfflineOnly && !filterOfflineOnly.checked) {
        filterOfflineOnly.checked = true;
        if (filterOfflineChip) filterOfflineChip.classList.add("active");
      }
      if (window.downloadQueueManager) {
        const searchResult = await window.downloadQueueManager.sendToWorker('SEARCH', {
          query,
          titlesOnly: isTitlesOnly,
          folderId: isFolderOnly ? folderId : null,
          limit,
          offset,
        });
        if (searchResult && Array.isArray(searchResult.results)) {
          searchResult.results = searchResult.results.filter(d => window.downloadQueueManager.isDocumentCached(d.id));
          searchResult.total_documents = searchResult.results.length;
        }
        return searchResult;
      }
      throw netErr;
    }
  }

  async function performSearch(query) {

    if (!query) {
      loadFoldersAndDocuments();
      return;
    }

    currentSearchQuery = query;
    isSearchActive = true;
    currentLoadedDocs = [];
    savedGeneralResultsScrollTop = 0;
    foldersSection.style.display = "none";
    showGeneralResultsView();

    // Sur mobile : fermer le visualiseur pour que l'utilisateur voie immédiatement la liste des résultats de recherche
    if (window.innerWidth <= 768 && workspace.classList.contains("split-active")) {
      closeSplitViewer();
    }

    const isTitlesOnly = filterTitlesOnly.checked;
    const isFolderOnly = filterCurrentFolderOnly.checked && currentFolderId !== null;

    let searchScopeLabel = "";
    if (isTitlesOnly && isFolderOnly) {
      searchScopeLabel = ` (dans les titres de "${currentFolderName}")`;
    } else if (isTitlesOnly) {
      searchScopeLabel = " (titres uniquement)";
    } else if (isFolderOnly) {
      searchScopeLabel = ` (dans "${currentFolderName}")`;
    }

    sectionTitle.textContent = `Résultats pour "${query}"${searchScopeLabel}`;
    mainGridCropManager.clear();
    _docCardMap.clear();
    resultsContainer.innerHTML = `<div style="padding: 16px; color: var(--text-muted);">Recherche en cours...</div>`;

    try {
      const data = await performSearchRequest(query, isTitlesOnly, isFolderOnly, currentFolderId, 15, 0);
      lastSearchResultsData = data;

      // Par défaut, mettre le tri sur "Pertinence" lors d'une nouvelle recherche
      updateSortOptionsForSearch(true);
      if (!userManuallyChangedSort) {
        currentSortMode = "relevance";
        if (sortSelect) sortSelect.value = "relevance";
      }
      updateSortPillLabel();

      renderSearchResults(data);
    } catch (err) {
      console.error("Erreur recherche:", err);
      _docCardMap.clear();
      resultsContainer.innerHTML = `<div style="padding: 16px; color: var(--danger);">Erreur lors de la recherche (${escapeHtml(err.message)}).</div>`;
    }
  }

  let searchPaginationObserver = null;
  let isFetchingNextSearchPage = false;

  async function fetchNextSearchPage() {
    if (isFetchingNextSearchPage || !lastSearchResultsData || !lastSearchResultsData.has_more) return;
    isFetchingNextSearchPage = true;

    try {
      const query = currentSearchQuery;
      const isTitlesOnly = filterTitlesOnly ? filterTitlesOnly.checked : false;
      const isFolderOnly = filterCurrentFolderOnly ? filterCurrentFolderOnly.checked : false;
      const currentOffset = lastSearchResultsData.results ? lastSearchResultsData.results.length : 0;

      const data = await performSearchRequest(query, isTitlesOnly, isFolderOnly, currentFolderId, 15, currentOffset);
      if (data && data.results && data.results.length > 0) {
        lastSearchResultsData.has_more = data.has_more;
        lastSearchResultsData.results = (lastSearchResultsData.results || []).concat(data.results);
        appendSearchResults(data);
      } else {
        lastSearchResultsData.has_more = false;
        const sentinel = document.getElementById("search-scroll-sentinel");
        if (sentinel) sentinel.remove();
      }
    } catch (e) {
      console.error("Erreur pagination recherche:", e);
    } finally {
      isFetchingNextSearchPage = false;
    }
  }

  function appendSearchResults(data) {
    const sentinel = document.getElementById("search-scroll-sentinel");
    const rawResults = data.results || [];
    currentLoadedDocs = currentLoadedDocs.concat(rawResults);

    rawResults.forEach(doc => {
      try {
        const card = createDocCardElement(doc, true);
        _docCardMap.set(doc.id, card);
        if (sentinel && sentinel.parentNode === resultsContainer) {
          resultsContainer.insertBefore(card, sentinel);
        } else {
          resultsContainer.appendChild(card);
        }
      } catch (cardErr) {
        console.error("Erreur rendu carte document pagination:", doc.id, cardErr);
      }
    });

    if (!data.has_more && sentinel) {
      sentinel.remove();
    }
    updateSelectionUI();
  }

  function renderSearchResults(data) {
    mainGridCropManager.clear();
    lastSearchResultsData = data;
    _docCardMap.clear();
    if (foldersSection) foldersSection.style.display = "none";
    resultsContainer.innerHTML = "";
    const rawResults = data.results || [];

    if (filterTitlesOnly.checked) {
      searchStats.textContent = `${data.total_documents} document${data.total_documents > 1 ? 's' : ''} correspondant${data.total_documents > 1 ? 's' : ''}`;
    } else {
      searchStats.textContent = `${data.total_occurrences} occurrence${data.total_occurrences > 1 ? 's' : ''} dans ${data.total_documents} document${data.total_documents > 1 ? 's' : ''}`;
    }

    if (rawResults.length === 0) {
      currentLoadedDocs = [];
      emptyState.style.display = "flex";
      emptyMessage.textContent = `Aucun résultat correspondant à "${data.query}".`;
      return;
    }

    emptyState.style.display = "none";

    updateSortOptionsForSearch(true);

    const sortedResults = sortDocumentsList(rawResults, currentSortMode);
    currentLoadedDocs = sortedResults;

    sortedResults.forEach(doc => {
      try {
        const card = createDocCardElement(doc, true);
        _docCardMap.set(doc.id, card);
        resultsContainer.appendChild(card);
      } catch (cardErr) {
        console.error("Erreur rendu carte document:", doc.id, cardErr);
      }
    });

    // Configuration de l'IntersectionObserver pour le scroll infini des résultats
    if (searchPaginationObserver) {
      searchPaginationObserver.disconnect();
    }

    if (data.has_more) {
      const sentinel = document.createElement("div");
      sentinel.id = "search-scroll-sentinel";
      sentinel.style.cssText = "height: 40px; width: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 13px;";
      sentinel.innerHTML = `<span style="opacity: 0.7;">Chargement de résultats supplémentaires...</span>`;
      resultsContainer.appendChild(sentinel);

      searchPaginationObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          fetchNextSearchPage();
        }
      }, { rootMargin: "300px 0px" });

      searchPaginationObserver.observe(sentinel);
    }

    updateSelectionUI();
  }

  // =========================================================================
  // Réindexation d'un Document
  // =========================================================================
  async function handleReindexDocument(docId, docTitle, btnElement) {
    if (btnElement) {
      btnElement.classList.add("spinning");
      btnElement.disabled = true;
    }

    try {
      const res = await fetch(`/api/documents/${docId}/reindex`, { method: "POST" });
      if (!res.ok) throw new Error("Échec de la réindexation");
      showToast(`"${docTitle}" relancé avec succès ! Indexation en cours...`, "success");
      
      if (currentSearchQuery) {
        performSearch(currentSearchQuery);
      } else {
        loadFoldersAndDocuments();
      }
    } catch (err) {
      console.error(err);
      showToast(`Erreur lors de la réindexation de "${docTitle}"`, "error");
    } finally {
      if (btnElement) {
        btnElement.classList.remove("spinning");
        btnElement.disabled = false;
      }
    }
  }

  // =========================================================================
  // Synchronisation Automatique / Scan
  // =========================================================================
  syncDocsBtn.addEventListener("click", async () => {
    syncDocsBtn.disabled = true;
    syncDocsBtn.querySelector("svg").style.animation = "spin 1s linear infinite";

    // Réinitialiser immédiatement la recherche si active pour un retour visuel instantané
    if (currentSearchQuery || isSearchActive) {
      searchInput.value = "";
      clearSearchBtn.style.display = "none";
      currentSearchQuery = "";
      isSearchActive = false;
      lastSearchResultsData = null;
      loadFoldersAndDocuments();
    }

    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      
      const totalProcessed = (data.added || 0) + (data.retried || 0);
      if (totalProcessed > 0) {
        const parts = [];
        if (data.added > 0) parts.push(`${data.added} nouveau(x) document(s) détecté(s)`);
        if (data.retried > 0) parts.push(`${data.retried} document(s) relancé(s)`);
        showToast(`${parts.join(" et ")} ! Indexation en cours...`, "success", 4500);
        loadFoldersAndDocuments();
      } else {
        showToast("Tous les documents PDF sont déjà synchronisés.", "info");
      }
    } catch (err) {
      console.error(err);
      showToast("Erreur lors de la synchronisation des fichiers", "error");
    } finally {
      syncDocsBtn.disabled = false;
      syncDocsBtn.querySelector("svg").style.animation = "none";
    }
  });

  // =========================================================================
  // Modale Nouveau Dossier & Couleurs
  // =========================================================================
  function initColorPalette() {
    colorPicker.innerHTML = "";
    const colors = [
      { color: "#ef4444", name: "Corail / Rouge" },
      { color: "#3b82f6", name: "Bleu Océan" },
      { color: "#10b981", name: "Vert Émeraude" },
      { color: "#f59e0b", name: "Ambre Chaud" },
      { color: "#8b5cf6", name: "Violet Doux" },
      { color: "#ec4899", name: "Rose Bonbon" },
      { color: "#64748b", name: "Gris Ardoise" }
    ];

    colors.forEach((preset, idx) => {
      const circle = document.createElement("div");
      circle.className = `color-preset-circle ${idx === 0 ? 'selected' : ''}`;
      circle.style.backgroundColor = preset.color;
      circle.setAttribute("title", preset.name);

      circle.addEventListener("click", () => {
        document.querySelectorAll(".color-preset-circle").forEach(el => el.classList.remove("selected"));
        circle.classList.add("selected");
        selectedFolderColor = preset.color;
      });

      colorPicker.appendChild(circle);
    });
  }

  newFolderBtn.addEventListener("click", () => {
    folderModalTitle.textContent = currentFolderId ? `Nouveau sous-dossier dans "${currentFolderName}"` : "Nouveau dossier";
    folderNameInput.value = "";
    folderModal.style.display = "flex";
    folderNameInput.focus();
  });

  closeFolderModalBtn.addEventListener("click", () => folderModal.style.display = "none");
  cancelFolderModalBtn.addEventListener("click", () => folderModal.style.display = "none");
  folderModal.addEventListener("click", (e) => {
    if (e.target === folderModal) folderModal.style.display = "none";
  });

  saveFolderBtn.addEventListener("click", async () => {
    const name = folderNameInput.value.trim();
    if (!name) {
      showToast("Veuillez saisir un nom pour le dossier.", "warning");
      folderNameInput.focus();
      return;
    }

    try {
      const payload = {
        name: name,
        parent_id: currentFolderId,
        color: selectedFolderColor
      };

      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error("Erreur création dossier");

      folderModal.style.display = "none";
      showToast(`Dossier "${name}" créé avec succès !`, "success");
      clearFolderDocsCache();
      allFolders = [];
      loadFoldersAndDocuments();
    } catch (err) {
      console.error(err);
      showToast("Impossible de créer le dossier", "error");
    }
  });

  folderNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveFolderBtn.click();
  });

  // Suppression de Dossier
  async function confirmDeleteFolder(folderId, folderName) {
    if (!confirm(`Supprimer le dossier "${folderName}" ? Les documents qu'il contient seront replacés à la racine.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/folders/${folderId}`, { method: "DELETE" });
      if (res.ok) {
        showToast(`Dossier "${folderName}" supprimé.`, "info");
        clearFolderDocsCache();
        allFolders = [];
        loadFoldersAndDocuments();
      } else {
        showToast("Erreur lors de la suppression du dossier.", "error");
      }
    } catch (err) {
      console.error(err);
      showToast("Erreur réseau.", "error");
    }
  }

  // =========================================================================
  // Déplacement par Lot (Multi-documents & Glisser-Déposer / Modale)
  // =========================================================================
  async function batchMoveDocuments(docIds, folderId, folderName = "Racine") {
    if (!docIds || docIds.length === 0) return;

    try {
      const res = await fetch(`/api/documents/batch-move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc_ids: docIds,
          folder_id: folderId
        })
      });

      if (!res.ok) throw new Error("Erreur de déplacement");

      const count = docIds.length;
      if (window.downloadQueueManager) {
        await window.downloadQueueManager.syncDocFolders(docIds.map(id => ({ id, folder_id: folderId })));
      }
      showToast(`${count} document${count > 1 ? 's' : ''} déplacé${count > 1 ? 's' : ''} dans "${folderName}"`, "success");
      clearSelection();
      clearFolderDocsCache();

      if (currentSearchQuery) {
        performSearch(currentSearchQuery);
      } else {
        loadFoldersAndDocuments();
      }
    } catch (err) {
      console.error(err);
      showToast("Erreur lors du déplacement", "error");
    }
  }

  let moveModalDocIds = [];
  let moveModalTargetFolderId = null;

  async function openBatchMoveModal(docIds) {
    if (!docIds || docIds.length === 0) return;
    moveModalDocIds = docIds;
    moveModalTargetFolderId = null;
    confirmMoveDocBtn.disabled = true;

    // Charger les dossiers frais depuis l'API
    try {
      const res = await fetch("/api/folders");
      const data = await res.json();
      allFolders = data.folders || [];
    } catch (e) {
      console.error(e);
    }

    const foldersMap = new Map();
    allFolders.forEach(f => foldersMap.set(f.id, f));

    // Déterminer l'emplacement actuel
    let currentCommonFolderId = undefined;
    const docTitles = [];
    docIds.forEach(id => {
      const d = currentLoadedDocs.find(x => x.id === id);
      if (d) {
        docTitles.push(d.title);
        if (currentCommonFolderId === undefined) {
          currentCommonFolderId = d.folder_id;
        } else if (currentCommonFolderId !== d.folder_id) {
          currentCommonFolderId = "multiple";
        }
      }
    });

    // Titre de la boîte de dialogue
    if (docIds.length === 1) {
      moveDocModalTitle.textContent = `Déplacer "${docTitles[0] || 'ce document'}"`;
    } else {
      moveDocModalTitle.textContent = `Déplacer ${docIds.length} documents`;
    }

    // Libellé de l'emplacement actuel
    let currentLocName = "Racine";
    if (currentCommonFolderId && currentCommonFolderId !== "multiple") {
      const curF = foldersMap.get(currentCommonFolderId);
      currentLocName = curF ? curF.name : "Racine";
    } else if (currentCommonFolderId === "multiple") {
      currentLocName = "Emplacements multiples";
    } else if (currentFolderId) {
      currentLocName = currentFolderName;
    }
    moveDocCurrentName.textContent = currentLocName;

    folderSelectList.innerHTML = "";

    function getFolderPath(folder) {
      const parts = [folder.name];
      let curr = folder;
      while (curr.parent_id && foldersMap.has(curr.parent_id)) {
        curr = foldersMap.get(curr.parent_id);
        parts.unshift(curr.name);
      }
      return parts.join(" / ");
    }

    // 1. Option Racine
    const isRootCurrent = (currentCommonFolderId === null || (currentCommonFolderId === undefined && !currentFolderId));
    const rootItem = document.createElement("label");
    rootItem.className = `folder-select-item ${isRootCurrent ? 'disabled' : ''}`;
    rootItem.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-radius: 8px; background-color: #ffffff; cursor: pointer; border: 2px solid #e2e8f0; margin-bottom: 6px; user-select: none;";
    rootItem.innerHTML = `
      <div class="folder-select-item-left" style="display: flex; align-items: center; gap: 10px; flex: 1;">
        <input type="radio" name="targetFolderRadio" class="folder-select-radio" value="root" ${isRootCurrent ? 'disabled' : ''} style="width:18px; height:18px; cursor:pointer;" />
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <span style="font-weight: 600;">Racine (aucun dossier)</span>
      </div>
      <span class="folder-select-badge" style="font-size: 11px; padding: 2px 7px; border-radius: 5px; background: #f1f5f9; color: #64748b; font-weight: 600; border: 1px solid #cbd5e1;">${isRootCurrent ? 'Actuel' : 'Racine'}</span>
    `;

    if (!isRootCurrent) {
      const radio = rootItem.querySelector("input[type='radio']");
      const selectRoot = () => {
        radio.checked = true;
        document.querySelectorAll(".folder-select-item").forEach(el => {
          el.classList.remove("selected");
          el.style.borderColor = "#e2e8f0";
          el.style.backgroundColor = "#ffffff";
        });
        rootItem.classList.add("selected");
        rootItem.style.borderColor = "#2563eb";
        rootItem.style.backgroundColor = "#eff6ff";
        moveModalTargetFolderId = null;
        confirmMoveDocBtn.disabled = false;
      };

      rootItem.addEventListener("click", selectRoot);
      radio.addEventListener("change", selectRoot);
      rootItem.addEventListener("dblclick", () => {
        selectRoot();
        confirmMoveDocBtn.click();
      });
    }
    folderSelectList.appendChild(rootItem);

    // 2. Dossiers classés par arborescence
    const sortedFolders = [...allFolders].map(f => ({
      ...f,
      fullPath: getFolderPath(f)
    })).sort((a, b) => a.fullPath.localeCompare(b.fullPath, 'fr', { sensitivity: 'base' }));

    sortedFolders.forEach(f => {
      const isCurrent = (currentCommonFolderId === f.id);
      const item = document.createElement("label");
      item.className = `folder-select-item ${isCurrent ? 'disabled' : ''}`;
      
      const depth = (f.fullPath.match(/\//g) || []).length;
      const indentPx = depth * 16;

      item.style.cssText = `display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-radius: 8px; background-color: ${isCurrent ? '#f8fafc' : '#ffffff'}; cursor: ${isCurrent ? 'not-allowed' : 'pointer'}; border: 2px solid #e2e8f0; margin-bottom: 6px; user-select: none; opacity: ${isCurrent ? '0.6' : '1'};`;

      item.innerHTML = `
        <div class="folder-select-item-left" style="display: flex; align-items: center; gap: 10px; flex: 1; padding-left: ${indentPx}px;">
          <input type="radio" name="targetFolderRadio" class="folder-select-radio" value="${f.id}" ${isCurrent ? 'disabled' : ''} style="width:18px; height:18px; cursor:pointer;" />
          <svg width="17" height="17" viewBox="0 0 24 24" fill="#3b82f6" stroke="#3b82f6" stroke-width="1">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <span style="font-weight: 600;" title="${escapeHtml(f.fullPath)}">${escapeHtml(f.name)}</span>
        </div>
        <span class="folder-select-badge" style="font-size: 11px; padding: 2px 7px; border-radius: 5px; background: #f1f5f9; color: #64748b; font-weight: 600; border: 1px solid #cbd5e1;">${isCurrent ? 'Actuel' : (f.doc_count ? `${f.doc_count} doc.` : '0 doc.')}</span>
      `;

      if (!isCurrent) {
        const radio = item.querySelector("input[type='radio']");
        const selectFolder = () => {
          radio.checked = true;
          document.querySelectorAll(".folder-select-item").forEach(el => {
            el.classList.remove("selected");
            el.style.borderColor = "#e2e8f0";
            el.style.backgroundColor = "#ffffff";
          });
          item.classList.add("selected");
          item.style.borderColor = "#2563eb";
          item.style.backgroundColor = "#eff6ff";
          moveModalTargetFolderId = f.id;
          confirmMoveDocBtn.disabled = false;
        };

        item.addEventListener("click", selectFolder);
        radio.addEventListener("change", selectFolder);
        item.addEventListener("dblclick", () => {
          selectFolder();
          confirmMoveDocBtn.click();
        });
      }

      folderSelectList.appendChild(item);
    });

    moveDocModal.style.display = "flex";
  }

  if (modalCreateNewFolderBtn) {
    modalCreateNewFolderBtn.addEventListener("click", () => {
      folderModalTitle.textContent = "Nouveau dossier";
      folderNameInput.value = "";
      folderModal.style.display = "flex";
      folderNameInput.focus();
    });
  }

  closeMoveDocModalBtn.addEventListener("click", () => moveDocModal.style.display = "none");
  cancelMoveDocBtn.addEventListener("click", () => moveDocModal.style.display = "none");
  moveDocModal.addEventListener("click", (e) => {
    if (e.target === moveDocModal) moveDocModal.style.display = "none";
  });

  confirmMoveDocBtn.addEventListener("click", async () => {
    if (moveModalDocIds.length > 0) {
      const targetFolder = allFolders.find(f => f.id === moveModalTargetFolderId);
      const folderName = targetFolder ? targetFolder.name : "Racine";
      await batchMoveDocuments(moveModalDocIds, moveModalTargetFolderId, folderName);
      moveDocModal.style.display = "none";
    }
  });

  // =========================================================================
  // Renommage Document
  // =========================================================================
  function openRenameModal(docId, currentTitle) {
    docIdToRename = docId;
    if (renameDocInput) {
      renameDocInput.value = currentTitle || "";
    }
    if (renameDocModal) {
      renameDocModal.style.display = "flex";
      setTimeout(() => {
        if (renameDocInput) {
          renameDocInput.focus();
          renameDocInput.select();
        }
      }, 50);
    }
  }

  function closeRenameModal() {
    docIdToRename = null;
    if (renameDocModal) {
      renameDocModal.style.display = "none";
    }
  }

  if (closeRenameDocModalBtn) {
    closeRenameDocModalBtn.addEventListener("click", closeRenameModal);
  }
  if (cancelRenameDocBtn) {
    cancelRenameDocBtn.addEventListener("click", closeRenameModal);
  }
  if (renameDocModal) {
    renameDocModal.addEventListener("click", (e) => {
      if (e.target === renameDocModal) closeRenameModal();
    });
  }

  async function handleRenameDocument() {
    // Synchronisation de l'état : rawLoadedDocs et lastSearchResultsData
    if (!docIdToRename) return;
    const newTitle = renameDocInput.value.trim();
    if (!newTitle) {
      showToast("Le titre ne peut pas être vide.", "warning");
      return;
    }

    try {
      if (confirmRenameDocBtn) confirmRenameDocBtn.disabled = true;

      const res = await apiFetch(`/api/documents/${docIdToRename}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Erreur lors du renommage");
      }

      clearFolderDocsCache();

      // Mettre à jour dans les données en mémoire
      const docItem = currentLoadedDocs.find(d => d.id === docIdToRename);
      if (docItem) {
        docItem.title = newTitle;
      }
      if (Array.isArray(rawLoadedDocs)) {
        const rawItem = rawLoadedDocs.find(d => d.id === docIdToRename);
        if (rawItem) rawItem.title = newTitle;
      }
      if (lastSearchResultsData && Array.isArray(lastSearchResultsData.results)) {
        const searchItem = lastSearchResultsData.results.find(d => d.id === docIdToRename);
        if (searchItem) searchItem.title = newTitle;
      }

      // Mettre à jour dans le DOM si présent
      const card = document.querySelector(`.doc-card[data-doc-id="${docIdToRename}"]`);
      if (card) {
        const titleEl = card.querySelector(".doc-title-main");
        if (titleEl) {
          titleEl.textContent = newTitle;
          titleEl.title = newTitle;
        }
      }

      // Si ouvert dans le visualiseur
      if (currentActiveDocId === docIdToRename) {
        currentActiveDocTitle = newTitle;
        if (viewerDocTitle) viewerDocTitle.textContent = newTitle;
        if (docDetailTitle) docDetailTitle.textContent = newTitle;
      }

      closeRenameModal();
      showToast("Document renommé avec succès !", "success");
    } catch (err) {
      showToast("Erreur : " + err.message, "error");
    } finally {
      if (confirmRenameDocBtn) confirmRenameDocBtn.disabled = false;
    }
  }

  if (confirmRenameDocBtn) {
    confirmRenameDocBtn.addEventListener("click", handleRenameDocument);
  }
  if (renameDocInput) {
    renameDocInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleRenameDocument();
      } else if (e.key === "Escape") {
        closeRenameModal();
      }
    });
  }

  // =========================================================================
  // Cache dans le CacheStorage du navigateur pour réouverture instantanée et support hors-ligne
  async function cacheDocumentPdf(docId) {
    if (!("caches" in window)) return;
    try {
      const cache = await caches.open("docseeker-pdf-v1");
      const url = `/api/pdf/${docId}`;
      const match = await cache.match(url);
      if (!match) {
        fetch(url).then(res => {
          if (res.ok) cache.put(url, res.clone());
        }).catch(() => {});
      }
    } catch (e) {
      console.warn("[CacheStorage]", e);
    }
  }

  // =========================================================================
  // Gestionnaire Multi-Onglets Lecteur PDF Goodnotes (tabManager)
  // =========================================================================
  const tabManager = {
    openTabs: [],
    activeTabId: null,

    saveCurrentTabState() {
      const currentTab = this.openTabs.find(t => t.id === this.activeTabId);
      if (!currentTab) return;
      currentTab.page = getCurrentViewerPage();
      currentTab.activeOccurrenceIndex = currentActiveOccurrenceIndex;
      try {
        const win = pdfFrame?.contentWindow;
        const container = win?.document?.getElementById("viewerContainer");
        if (container) {
          currentTab.scrollTop = container.scrollTop;
          currentTab.scrollLeft = container.scrollLeft;
        }
      } catch (e) {}
      if (currentActiveOccurrences && currentActiveOccurrences[currentActiveOccurrenceIndex]) {
        const activeOcc = currentActiveOccurrences[currentActiveOccurrenceIndex];
        currentTab.page = activeOcc.page_number;
        currentTab.rect = (activeOcc.highlight_rects && activeOcc.highlight_rects.length > 0) ? activeOcc.highlight_rects[0] : activeOcc.rect;
        currentTab.yRatio = activeOcc.y_ratio || 0;
        currentTab.occId = activeOcc.occ_id;
      }
    },

    openTab(docId, docTitle, targetPage = 1, occurrences = [], targetRect = null, targetYRatio = 0, targetOccId = null, searchQuery = null) {
      const numericDocId = Number(docId);
      this.saveCurrentTabState();
      // Quitter le mode accueil
      document.body.classList.remove("home-tab-active");
      document.documentElement.classList.remove("home-tab-active");
      const appEl = document.getElementById("app");
      if (appEl) appEl.classList.remove("home-tab-active");

      let existingTab = this.openTabs.find(t => Number(t.docId) === numericDocId);
      if (existingTab) {
        this.activeTabId = existingTab.id;
        existingTab.page = targetPage;
        existingTab.rect = targetRect;
        existingTab.yRatio = targetYRatio;
        existingTab.occId = targetOccId;
        existingTab.scrollTop = null; // nouvelle navigation demandée
        if (searchQuery) {
          existingTab.searchQuery = searchQuery;
          existingTab.occurrences = (occurrences && occurrences.length > 0) ? occurrences : existingTab.occurrences;
          existingTab.searchActive = true;
        } else {
          // CANAL 2 : une ouverture sans recherche explicite ne réactive pas une
          // ancienne recherche (ni celle d'un autre document).
          existingTab.searchQuery = "";
          existingTab.searchActive = false;
        }
      } else {
        const newTab = {
          id: `tab_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          docId: numericDocId,
          title: docTitle || `Document #${numericDocId}`,
          page: targetPage,
          rect: targetRect,
          yRatio: targetYRatio,
          occId: targetOccId,
          // CANAL 2 : plus d'héritage du global — une ouverture sans recherche
          // explicite démarre toujours sans recherche intra-doc.
          searchQuery: searchQuery || "",
          occurrences: occurrences || [],
          activeOccurrenceIndex: 0,
          scrollTop: null
        };
        this.openTabs.push(newTab);
        this.activeTabId = newTab.id;
      }
      this.renderTabsUI();
      _executeLoadDocumentInViewer(numericDocId, docTitle, targetPage, occurrences, targetRect, targetYRatio, targetOccId, existingTab?.scrollTop ?? null);
    },

    selectTab(tabId) {
      if (tabId === 'home') {
        this.returnToHome();
        return;
      }
      if (this.activeTabId === tabId) return;
      this.saveCurrentTabState();

      // Quitter le mode accueil
      document.body.classList.remove("home-tab-active");
      document.documentElement.classList.remove("home-tab-active");
      const appEl = document.getElementById("app");
      if (appEl) appEl.classList.remove("home-tab-active");

      const targetTab = this.openTabs.find(t => t.id === tabId);
      if (!targetTab) return;
      this.activeTabId = tabId;
      this.renderTabsUI();
      // CANAL 3 : _executeLoadDocumentInViewer lit l'état de recherche de
      // targetTab (champ, occurrences, surbrillance) — voir getActiveTab().
      _executeLoadDocumentInViewer(
        targetTab.docId,
        targetTab.title,
        targetTab.page,
        targetTab.occurrences,
        targetTab.rect,
        targetTab.yRatio,
        targetTab.occId,
        targetTab.scrollTop,
        targetTab.activeOccurrenceIndex
      );
    },

    closeTab(tabId) {
      const idx = this.openTabs.findIndex(t => t.id === tabId);
      if (idx === -1) return;
      this.openTabs.splice(idx, 1);
      if (this.activeTabId === tabId) {
        if (this.openTabs.length > 0) {
          const nextIdx = Math.min(idx, this.openTabs.length - 1);
          const nextTab = this.openTabs[nextIdx];
          this.activeTabId = nextTab.id;
          this.renderTabsUI();
          _executeLoadDocumentInViewer(
            nextTab.docId,
            nextTab.title,
            nextTab.page,
            nextTab.occurrences,
            nextTab.rect,
            nextTab.yRatio,
            nextTab.occId,
            nextTab.scrollTop,
            nextTab.activeOccurrenceIndex
          );
        } else {
          this.activeTabId = 'home';
          this.renderTabsUI();
          this.returnToHome();
          document.body.classList.remove("doc-open");
          document.documentElement.classList.remove("doc-open");
          document.body.classList.remove("home-tab-active");
          document.documentElement.classList.remove("home-tab-active");
          const appEl = document.getElementById("app");
          if (appEl) appEl.classList.remove("home-tab-active");
          if (readerTopTabBar) readerTopTabBar.style.display = "none";
          closeSplitViewer();
        }
      } else {
        this.renderTabsUI();
      }
    },

    returnToHome() {
      this.saveCurrentTabState();
      // Geler l'état de l'onglet courant AVANT de détacher activeTabId,
      // sinon saveCurrentTabState ne trouve plus l'onglet.
      const frozenTab = getActiveTab();
      this.activeTabId = 'home';
      this.renderTabsUI();

      if (currentActiveDocId && window.pdfCacheManager) {
        window.pdfCacheManager.pauseDownload(currentActiveDocId);
      }

      // Appliquer le mode onglet accueil
      document.body.classList.add("home-tab-active");
      document.documentElement.classList.add("home-tab-active");
      const appEl = document.getElementById("app");
      if (appEl) appEl.classList.add("home-tab-active");

      workspace.classList.remove("split-active");
      if (viewerPane) {
        viewerPane.style.display = "none";
      }
      if (inDocSearchDrawer) inDocSearchDrawer.style.display = "none";
      if (readerSidebarToggleBtn) readerSidebarToggleBtn.classList.remove("active");
      if (docDetailView) docDetailView.style.display = "none";
      if (generalView) generalView.style.display = "";
      // Bug sœur : réafficher les extraits de la RECHERCHE GLOBALE (liste de
      // gauche), pas ceux du dernier document consulté.
      if (frozenTab && currentSearchQuery && lastSearchResultsData) {
        const searchDoc = (lastSearchResultsData.results || []).find(d => Number(d.id) === Number(frozenTab.docId));
        if (searchDoc) {
          const searchOccs = searchDoc.occurrences_by_page || searchDoc.vignettes || [];
          currentDocOriginalOccurrences = searchOccs;
          currentActiveOccurrences = sortDocOccurrences(searchOccs, currentDocOccurrencesSortMode);
          renderVerticalOccurrences(frozenTab.docId, frozenTab.title, currentActiveOccurrences);
          renderDrawerOccurrences(frozenTab.docId, frozenTab.title, currentActiveOccurrences);
        }
      }
      if (resultsPane) {
        resultsPane.style.display = "";
        if (savedGeneralResultsScrollTop > 0) {
          resultsPane.scrollTop = savedGeneralResultsScrollTop;
        }
      }
      setDocumentZoomLock(false);
      if (clearSearchBtn && searchInput) {
        clearSearchBtn.style.display = searchInput.value.trim() ? "flex" : "none";
      }
    },

    renderTabsUI() {
      if (!readerTopTabBar) return;
      if (this.openTabs.length === 0 && this.activeTabId !== 'home') {
        readerTopTabBar.style.display = "none";
        return;
      }
      readerTopTabBar.style.display = "flex";

      if (readerHomeBtn) {
        readerHomeBtn.classList.toggle("active", this.activeTabId === 'home');
      }

      if (!readerTabsStrip) return;
      readerTabsStrip.innerHTML = "";
      this.openTabs.forEach(tab => {
        const isActive = tab.id === this.activeTabId;
        const tabEl = document.createElement("div");
        tabEl.className = `reader-tab-item ${isActive ? 'active' : ''}`;
        tabEl.setAttribute("data-tab-id", tab.id);
        tabEl.innerHTML = `
          <span class="reader-tab-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</span>
          <button class="reader-tab-chevron" title="Détails du document" data-tab-id="${tab.id}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <button class="reader-tab-close" title="Fermer l'onglet" data-tab-id="${tab.id}">&times;</button>
        `;

        tabEl.addEventListener("click", (e) => {
          if (e.target.closest(".reader-tab-close") || e.target.closest(".reader-tab-chevron")) return;
          this.selectTab(tab.id);
        });

        const closeBtn = tabEl.querySelector(".reader-tab-close");
        if (closeBtn) {
          closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.closeTab(tab.id);
          });
        }

        const chevronBtn = tabEl.querySelector(".reader-tab-chevron");
        if (chevronBtn) {
          chevronBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            showTabDocInfoPopover(tab, chevronBtn);
          });
        }

        readerTabsStrip.appendChild(tabEl);
      });
    }
  };

  function showTabDocInfoPopover(tab, anchorEl) {
    if (!tabDocInfoPopover) return;
    const rect = anchorEl.getBoundingClientRect();
    tabDocInfoPopover.style.top = `${rect.bottom + 6}px`;
    tabDocInfoPopover.style.left = `${Math.max(10, Math.min(window.innerWidth - 310, rect.left - 40))}px`;
    tabDocInfoPopover.style.display = "block";

    const matchedDoc = Array.isArray(currentLoadedDocs) ? currentLoadedDocs.find(d => Number(d.id) === Number(tab.docId)) : null;

    const popoverTitle = document.getElementById("popoverDocTitle");
    const popoverFilename = document.getElementById("popoverDocFilename");
    const popoverPages = document.getElementById("popoverDocPages");
    const popoverSize = document.getElementById("popoverDocSize");
    const popoverCache = document.getElementById("popoverDocCacheStatus");

    if (popoverTitle) popoverTitle.textContent = tab.title;
    if (popoverFilename) popoverFilename.textContent = matchedDoc?.filename || `${tab.title}.pdf`;
    if (popoverPages) popoverPages.textContent = `${matchedDoc?.total_pages || tab.page || 1} pages`;
    if (popoverSize) popoverSize.textContent = matchedDoc?.file_size ? formatBytes(matchedDoc.file_size) : "-";
    
    const isCached = window.downloadQueueManager ? window.downloadQueueManager.isDocumentCached(tab.docId) : false;
    if (popoverCache) popoverCache.textContent = isCached ? "⚡ Disponible hors-ligne" : "☁️ Sur le serveur";
  }

  if (closePopoverDocBtn) {
    closePopoverDocBtn.addEventListener("click", () => {
      if (tabDocInfoPopover) tabDocInfoPopover.style.display = "none";
    });
  }

  document.addEventListener("click", (e) => {
    if (tabDocInfoPopover && tabDocInfoPopover.style.display !== "none") {
      if (!e.target.closest("#tabDocInfoPopover") && !e.target.closest(".reader-tab-chevron")) {
        tabDocInfoPopover.style.display = "none";
      }
    }
  });

  if (readerHomeBtn) {
    readerHomeBtn.addEventListener("click", () => {
      tabManager.returnToHome();
    });
  }

  if (readerSidebarToggleBtn) {
    readerSidebarToggleBtn.addEventListener("click", () => {
      const drawerEl = document.getElementById("inDocSearchDrawer");
      if (!drawerEl) return;
      const isHidden = (drawerEl.style.display === "none" || !drawerEl.style.display);
      drawerEl.style.display = isHidden ? "flex" : "none";
      readerSidebarToggleBtn.classList.toggle("active", isHidden);
      if (isHidden) {
        const tabTerm = getActiveDocSearchTerm();
        if (inDocDrawerSearchInput && !inDocDrawerSearchInput.value && tabTerm) {
          inDocDrawerSearchInput.value = tabTerm;
        }
        if (inDocDrawerOccurrencesList) {
          const activeCard = inDocDrawerOccurrencesList.querySelector(".vertical-occ-card.active");
          if (activeCard) {
            scrollActiveCardIntoView(activeCard);
          }
        }
      }
    });
  }

  let isReaderFitToWidth = false;
  if (readerFitToWidthBtn) {
    readerFitToWidthBtn.addEventListener("click", () => {
      isReaderFitToWidth = !isReaderFitToWidth;
      readerFitToWidthBtn.classList.toggle("active", isReaderFitToWidth);
      try {
        const win = pdfFrame?.contentWindow;
        if (win && win.PDFViewerApplication && win.PDFViewerApplication.pdfViewer) {
          win.PDFViewerApplication.pdfViewer.currentScaleValue = isReaderFitToWidth ? "page-width" : "auto";
        }
      } catch (e) {}
    });
  }

  if (readerShareBtn) {
    readerShareBtn.addEventListener("click", () => {
      if (!currentActiveDocId) return;
      const a = document.createElement("a");
      a.href = `/api/pdf/${currentActiveDocId}`;
      a.download = `${currentActiveDocTitle || "document"}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  function openDocumentInSplitView(docId, docTitle, targetPage, occurrences, targetRect = null, targetYRatio = 0, targetOccId = null, searchQuery = null) {
    tabManager.openTab(docId, docTitle, targetPage, occurrences, targetRect, targetYRatio, targetOccId, searchQuery);
  }
  window.tabManager = tabManager;
  window.openDocumentInSplitView = openDocumentInSplitView;

  let currentViewerLoadSeq = 0;

  function _executeLoadDocumentInViewer(docId, docTitle, targetPage, occurrences, targetRect = null, targetYRatio = 0, targetOccId = null, targetScrollTop = null, targetOccIndex = null) {
    const numericDocId = Number(docId);
    const thisLoadSeq = ++currentViewerLoadSeq;
    targetPage = parseInt(targetPage, 10) || 1;
    const isSameDoc = (Number(currentActiveDocId) === numericDocId);
    if (!isSameDoc && currentActiveDocId && window.pdfCacheManager) {
      window.pdfCacheManager.pauseDownload(currentActiveDocId);
    }
    currentActiveDocId = numericDocId;
    currentActiveDocTitle = docTitle;

    // CANAL 2 : la requête intra-doc vient de l'ONGLET cible, jamais du global.
    // Un onglet ouvert sans recherche (vignette, accueil) démarre avec "".
    const targetTab = (typeof tabManager !== 'undefined')
      ? tabManager.openTabs.find(t => Number(t.docId) === numericDocId)
      : null;
    const effectiveSearchQuery = (targetTab && targetTab.searchQuery) || "";

    // Le streaming HTTP 206 et le cache natif HTTP du navigateur gèrent le chargement et la mise en cache de manière optimale sans collision réseau.
    if (window.pdfCacheManager) {
      const matchedDoc = Array.isArray(currentLoadedDocs) ? currentLoadedDocs.find(d => Number(d.id) === numericDocId) : null;
      const knownSize = matchedDoc && matchedDoc.file_size ? matchedDoc.file_size : 0;
      if (knownSize > 0) {
        window.pdfCacheManager.setDocumentTotalBytes(numericDocId, knownSize);
      } else {
        fetch(`/api/pdf/${numericDocId}`, { method: 'HEAD' }).then(res => {
          const cl = res.headers.get("Content-Length");
          if (cl && Number(cl) > 0 && window.pdfCacheManager) {
            window.pdfCacheManager.setDocumentTotalBytes(numericDocId, Number(cl));
          }
        }).catch(() => {});
      }
    }

    // Indexation locale immédiate dans SQLite-Wasm si connecté et non encore indexé
    if (window.downloadQueueManager) {
      window.downloadQueueManager.ensureDocumentIndexedLocally(numericDocId);
    }

    // Support de l'historique de navigation pour le bouton retour mobile
    if (!workspace.classList.contains("split-active")) {
      window.history.pushState({ view: "split" }, "");
    }

    workspace.classList.add("split-active");
    if (mainSidebarDrawer) mainSidebarDrawer.classList.remove("open");
    if (mainSidebarOverlay) mainSidebarOverlay.style.display = "none";

    // Ouvrir automatiquement le volet latéral des résultats in-doc dès qu'un document est ouvert avec des résultats
    if (inDocSearchDrawer) {
      const hasResults = (occurrences && occurrences.length > 0) || (effectiveSearchQuery && effectiveSearchQuery.trim());
      if (hasResults) {
        inDocSearchDrawer.style.display = "flex";
      }
    }
    if (readerSidebarToggleBtn) {
      const isDrawerOpen = inDocSearchDrawer && inDocSearchDrawer.style.display === "flex";
      readerSidebarToggleBtn.classList.toggle("active", isDrawerOpen);
    }
    document.body.classList.remove("home-tab-active");
    document.documentElement.classList.remove("home-tab-active");
    const appEl = document.getElementById("app");
    if (appEl) appEl.classList.remove("home-tab-active");

    if (viewerPane) {
      viewerPane.classList.remove("header-hidden");
      viewerPane.style.display = "";
    }
    if (resultsPane) {
      resultsPane.style.display = "none";
    }
    lastViewerScrollTop = 0;
    document.documentElement.classList.add("doc-open");
    document.body.classList.add("doc-open");
    if (appEl) appEl.classList.add("doc-open");
    setDocumentZoomLock(true);

    // CANAL 1 : synchroniser les champs avec la recherche de l'ONGLET cible
    syncDocSearchInputs(effectiveSearchQuery);
    if (viewerDocSearchWrapper) viewerDocSearchWrapper.style.display = "none";
    if (viewerDocSearchResultCount) {
      viewerDocSearchResultCount.textContent = effectiveSearchQuery ? `${occurrences.length} résultat${occurrences.length > 1 ? 's' : ''}` : "";
    }

    currentActiveOccurrences = occurrences || [];
    if (!effectiveSearchQuery && (!occurrences || occurrences.length === 0)) {
      if (inDocDrawerCount) inDocDrawerCount.textContent = "0 résultat";
      if (inDocDrawerOccurrencesList) {
        inDocDrawerOccurrencesList.innerHTML = `<div style="color:var(--text-muted); font-size:12.5px; padding:20px; text-align:center;">Recherchez un terme ci-dessus pour afficher les extraits correspondants dans ce document.</div>`;
      }
    }
    let initialIdx = 0;
    if (targetOccIndex !== null && targetOccIndex !== undefined && targetOccIndex >= 0 && occurrences && targetOccIndex < occurrences.length) {
      initialIdx = targetOccIndex;
    } else if (targetOccId && targetPage && occurrences && occurrences.length > 0) {
      const foundIdx = occurrences.findIndex(o => String(o.occ_id) === String(targetOccId) && Number(o.page_number) === Number(targetPage));
      if (foundIdx !== -1) initialIdx = foundIdx;
    } else if (initialIdx === 0 && targetPage && occurrences && occurrences.length > 0) {
      const foundIdx = occurrences.findIndex(o => Number(o.page_number) === Number(targetPage));
      if (foundIdx !== -1) initialIdx = foundIdx;
    } else if (initialIdx === 0 && targetOccId && occurrences && occurrences.length > 0) {
      const foundIdx = occurrences.findIndex(o => String(o.occ_id) === String(targetOccId));
      if (foundIdx !== -1) initialIdx = foundIdx;
    }
    currentActiveOccurrenceIndex = currentActiveOccurrences.length > 0 ? initialIdx : -1;
    updateOccurrenceStepperUI();

    // Persister l'état de recherche initial dans l'ONGLET (propriétaire de l'état)
    const loadTab = getActiveTab();
    if (loadTab && Number(loadTab.docId) === numericDocId) {
      loadTab.searchQuery = effectiveSearchQuery;
      loadTab.occurrences = currentActiveOccurrences;
      loadTab.activeOccurrenceIndex = currentActiveOccurrenceIndex;
      loadTab.searchActive = Boolean(effectiveSearchQuery);
    }

    if (resultsPane && generalView && generalView.style.display !== "none") {
      savedGeneralResultsScrollTop = resultsPane.scrollTop;
    }

    generalView.style.display = "none";
    docDetailView.style.display = "block";
    if (resultsPane) {
      resultsPane.scrollTop = 0;
    }
    docDetailTitle.textContent = docTitle;
    docDetailCount.textContent = `${occurrences.length} résultat${occurrences.length > 1 ? 's' : ''}`;

    currentDocOriginalOccurrences = occurrences || [];
    currentActiveOccurrences = sortDocOccurrences(occurrences || [], currentDocOccurrencesSortMode);

    renderVerticalOccurrences(numericDocId, docTitle, currentActiveOccurrences, targetPage, targetOccId);

    // Synchronisation du tiroir mobile d'extraits
    if (mobileOccurrencesCountText) {
      mobileOccurrencesCountText.textContent = `${occurrences.length} extrait${occurrences.length > 1 ? 's' : ''}`;
    }
    if (drawerDocTitle) {
      drawerDocTitle.textContent = docTitle;
    }
    if (drawerDocCount) {
      drawerDocCount.textContent = `${occurrences.length} extrait${occurrences.length > 1 ? 's' : ''}`;
    }
    renderDrawerOccurrences(numericDocId, docTitle, currentActiveOccurrences, targetPage, targetOccId);

    // Si ouvert depuis une recherche globale, charger en tâche de fond l'intégralité des occurrences du document
    // pour un parcours séquentiel complet (stepper et tiroir) sans bloquer l'affichage immédiat
    if (effectiveSearchQuery && (!occurrences || occurrences.length >= 25)) {
      const activeQuery = effectiveSearchQuery;
      const isDocCached = window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(numericDocId);
      const isOfflineMode = !navigator.onLine || (filterOfflineOnly && filterOfflineOnly.checked);

      const fetchFullDocOccs = async () => {
        if (isDocCached || isOfflineMode) {
          if (window.downloadQueueManager) {
            return await window.downloadQueueManager.sendToWorker('DOC_SEARCH', {
              docId: numericDocId,
              query: activeQuery
            });
          }
        }
        const res = await fetch(`/api/doc-search?doc_id=${numericDocId}&q=${encodeURIComponent(activeQuery)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      };

      fetchFullDocOccs()
        .then(data => {
          if (currentActiveDocId !== numericDocId || getActiveTab() !== targetTab || targetTab.searchQuery !== activeQuery) return;
          const fullOccs = data.occurrences || [];
          if (fullOccs.length > 0 && (!occurrences || fullOccs.length !== occurrences.length)) {
            currentDocOriginalOccurrences = fullOccs;
            currentActiveOccurrences = fullOccs;
            // Priorité absolue à l'extrait sélectionné sur la page cible
            let activeIdx = -1;
            if (targetOccId && targetPage) {
              activeIdx = fullOccs.findIndex(o => String(o.occ_id) === String(targetOccId) && Number(o.page_number) === Number(targetPage));
            }
            if (activeIdx === -1 && targetPage) {
              activeIdx = fullOccs.findIndex(o => Number(o.page_number) === Number(targetPage));
            }
            if (activeIdx === -1 && targetOccId) {
              activeIdx = fullOccs.findIndex(o => String(o.occ_id) === String(targetOccId));
            }
            if (activeIdx === -1) {
              // Priorité à targetPage (source de vérité du clic) : le viewer iframe n'a
              // pas encore navigué vers la page cible quand cette callback async s'exécute,
              // donc getCurrentViewerPage() renverrait 1 (page par défaut) et ferait scroller
              // le panneau vers la 1ère occurrence au lieu de celle cliquée.
              activeIdx = findClosestOccurrenceIndex(fullOccs, targetPage);
            }
            currentActiveOccurrenceIndex = activeIdx >= 0 ? activeIdx : 0;
            updateOccurrenceStepperUI();
            const activeOcc = fullOccs[currentActiveOccurrenceIndex];
            const curPage = activeOcc ? activeOcc.page_number : targetPage;
            const countLabel = `${fullOccs.length} résultat${fullOccs.length > 1 ? 's' : ''}`;
            const pillLabel = `${fullOccs.length} extrait${fullOccs.length > 1 ? 's' : ''}`;
            if (docDetailCount) docDetailCount.textContent = countLabel;
            if (viewerDocSearchResultCount) viewerDocSearchResultCount.textContent = `${fullOccs.length} résultat${fullOccs.length > 1 ? 's' : ''}`;
            if (mobileOccurrencesCountText) mobileOccurrencesCountText.textContent = pillLabel;
            if (drawerDocCount) drawerDocCount.textContent = pillLabel;
            currentDocOriginalOccurrences = fullOccs;
            currentActiveOccurrences = sortDocOccurrences(fullOccs, currentDocOccurrencesSortMode);
            renderVerticalOccurrences(numericDocId, docTitle, currentActiveOccurrences, curPage, targetOccId);
            renderDrawerOccurrences(numericDocId, docTitle, currentActiveOccurrences, curPage, targetOccId);
          }
        })
        .catch(err => console.warn("Erreur chargement occurrences complètes document:", err));
    }

    viewerDocTitle.textContent = docTitle;
    viewerPageBadge.textContent = `Page ${targetPage}`;

    const viewerCacheBadge = document.getElementById("viewerCacheBadge");
    const updateCacheUI = (status, progress, downloadedBytes = 0, totalBytes = 0) => {
      if (!viewerCacheBadge) return;
      // Si le document est déjà validé 100% en cache, interdire la régression vers "downloading" (due à la lecture locale des chunks par PDF.js)
      if (viewerCacheBadge.classList.contains("complete") && status === "downloading") {
        return;
      }
      if (status === "complete") {
        viewerCacheBadge.style.display = "inline-flex";
        viewerCacheBadge.className = "viewer-doc-badge viewer-cache-badge complete";
        viewerCacheBadge.textContent = "⚡ En cache";
        viewerCacheBadge.title = "Document disponible à 100% en cache local (0 ms réseau)";
      } else if (status === "offline") {
        viewerCacheBadge.style.display = "inline-flex";
        viewerCacheBadge.className = "viewer-doc-badge viewer-cache-badge paused";
        viewerCacheBadge.textContent = "⏸️ Hors-ligne";
        viewerCacheBadge.title = "Connexion réseau coupée. Le téléchargement reprendra automatiquement dès la reconnexion.";
      } else if (status === "retrying") {
        viewerCacheBadge.style.display = "inline-flex";
        viewerCacheBadge.className = "viewer-doc-badge viewer-cache-badge downloading";
        viewerCacheBadge.textContent = "🔄 Reconnexion...";
        viewerCacheBadge.title = "Tentative de reconnexion au serveur...";
      } else if (status === "paused" && progress > 0) {
        viewerCacheBadge.style.display = "inline-flex";
        viewerCacheBadge.className = "viewer-doc-badge viewer-cache-badge paused";
        const mbDl = downloadedBytes > 0 ? (downloadedBytes / (1024 * 1024)).toFixed(1) : null;
        const mbTot = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(0) : null;
        if (mbDl && mbTot) {
          viewerCacheBadge.textContent = `⏸️ ${progress}% (${mbDl}/${mbTot} Mo)`;
        } else {
          viewerCacheBadge.textContent = `⏸️ ${progress}%`;
        }
        viewerCacheBadge.title = `Téléchargement suspendu : ${progress}%`;
      } else if (status === "downloading") {
        viewerCacheBadge.style.display = "inline-flex";
        viewerCacheBadge.className = "viewer-doc-badge viewer-cache-badge downloading";
        const mbDl = downloadedBytes > 0 ? (downloadedBytes / (1024 * 1024)).toFixed(1) : null;
        const mbTot = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(0) : null;
        if (mbDl && mbTot && progress > 0) {
          viewerCacheBadge.textContent = `📥 ${progress}% (${mbDl}/${mbTot} Mo)`;
          viewerCacheBadge.title = `Mise en cache hors-ligne : ${mbDl} Mo sur ${mbTot} Mo (${progress}%) - Lecture fluide disponible`;
        } else if (mbDl) {
          viewerCacheBadge.textContent = `📥 ${mbDl} Mo`;
          viewerCacheBadge.title = `Mise en cache hors-ligne : ${mbDl} Mo reçus - Lecture fluide disponible`;
        } else if (progress > 0) {
          viewerCacheBadge.textContent = `📥 ${progress}%`;
          viewerCacheBadge.title = `Mise en cache hors-ligne : ${progress}% - Lecture fluide disponible`;
        } else {
          viewerCacheBadge.textContent = `📥 Téléchargement...`;
          viewerCacheBadge.title = `Mise en cache hors-ligne en cours...`;
        }
      } else if (status === "error") {
        viewerCacheBadge.style.display = "inline-flex";
        viewerCacheBadge.className = "viewer-doc-badge viewer-cache-badge paused";
        viewerCacheBadge.textContent = "⚠️ Erreur (Cliquer pour réparer)";
        viewerCacheBadge.title = "Une erreur est survenue lors du chargement. Cliquez pour vider le cache et recharger.";
      } else {
        viewerCacheBadge.style.display = "inline-flex";
        viewerCacheBadge.className = "viewer-doc-badge viewer-cache-badge cloud";
        viewerCacheBadge.textContent = "☁️ Non téléchargé";
        viewerCacheBadge.title = "Document en ligne (non stocké localement). Cliquez pour le mettre en cache hors-ligne.";
      }

    };

    if (viewerCacheBadge && !viewerCacheBadge._hasClickHandler) {
      viewerCacheBadge._hasClickHandler = true;
      viewerCacheBadge.style.cursor = "pointer";
      viewerCacheBadge.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentActiveDocId) return;
        const isComplete = window.downloadQueueManager ? window.downloadQueueManager.isDocumentCached(currentActiveDocId) : false;
        const isTaskActive = window.downloadQueueManager && window.downloadQueueManager.activeTasks.has(Number(currentActiveDocId));
        if (isComplete || isTaskActive) {
          if (window.downloadQueueManager) {
            await window.downloadQueueManager.cancelDownload(currentActiveDocId);
            await window.downloadQueueManager.removeDocumentFromCache(currentActiveDocId);
          } else if (window.pdfCacheManager) {
            await window.pdfCacheManager.invalidate(currentActiveDocId);
          }
          updateCacheUI("none", 0);
          updateDocCardCacheUI(currentActiveDocId);
          showToast("Cache local supprimé pour ce document", "info");
        } else {
          if (window.downloadQueueManager) {
            await window.downloadQueueManager.enqueueDocument(currentActiveDocId);
            updateDocCardCacheUI(currentActiveDocId);
            showToast("Mise en cache hors-ligne lancée", "info");
          }
        }
      });
    }

    if (window.pdfCacheManager) {
      window.pdfCacheManager.getProgress(numericDocId).then(p => {
        if (thisLoadSeq === currentViewerLoadSeq && Number(currentActiveDocId) === numericDocId && p) {
          updateCacheUI(p.status, p.progress, p.downloadedBytes, p.totalBytes);
        }
      }).catch(() => {});

      window.pdfCacheManager.onProgress(numericDocId, (info) => {
        if (thisLoadSeq === currentViewerLoadSeq && Number(currentActiveDocId) === numericDocId) {
          updateCacheUI(info.status, info.progress, info.downloadedBytes, info.totalBytes);
        }
      });
    }

    // Écouteur global des messages de progression et fragments émis par le visualiseur PDF.js
    if (!window._pdfViewerMessageListenerAttached) {
      window._pdfViewerMessageListenerAttached = true;
      window.addEventListener("message", (evt) => {
        if (!evt.data) return;
        const msgDocId = evt.data.docId || (evt.data.cacheKey ? Number(String(evt.data.cacheKey).match(/\/api\/pdf\/(\d+)/)?.[1]) : null);
        const targetId = msgDocId || currentActiveDocId;

        if (evt.data.type === "docseeker_pdf_progress") {
          const { loaded, total, percent } = evt.data;
          if (window.pdfCacheManager && targetId) {
            window.pdfCacheManager.updateProgressFromViewer(targetId, loaded, total);
          }
          if (targetId && Number(targetId) === Number(currentActiveDocId)) {
            updateCacheUI(percent >= 100 ? "complete" : "downloading", percent, loaded, total);
          }
        } else if (evt.data.type === "docseeker_pdf_meta") {
          const { total } = evt.data;
          if (window.pdfCacheManager && targetId && total > 0) {
            window.pdfCacheManager.setDocumentTotalBytes(targetId, total);
          }
        } else if (evt.data.type === "docseeker_chunk_saved") {
          const { chunkSize, totalBytes } = evt.data;
          if (window.pdfCacheManager && targetId) {
            window.pdfCacheManager.recordChunkDownloaded(targetId, chunkSize, totalBytes);
          }
        } else if (evt.data.type === "docseeker_pdf_complete") {
          const { length } = evt.data;
          if (window.pdfCacheManager && targetId) {
            window.pdfCacheManager.markComplete(targetId, length);
          }
          if (targetId && Number(targetId) === Number(currentActiveDocId)) {
            updateCacheUI("complete", 100, length, length);
          }
        }
      });
    }

    if (isSameDoc && pdfFrame.contentWindow && pdfFrame.contentWindow.PDFViewerApplication) {
      goToPageAndScrollToOccurrence(targetPage, targetRect, targetYRatio);
      hookIframePinchZoomIsolation();
      hookIframeScrollAutoHide();
      if (window.pdfCacheManager) {
        window.pdfCacheManager.getProgress(numericDocId).then(p => {
          if (Number(currentActiveDocId) === numericDocId) {
            updateCacheUI(p.status, p.progress, p.downloadedBytes, p.totalBytes);
          }
        }).catch(() => {});
      }
    } else {
      (async () => {
        let pdfTargetUrl = `/api/pdf/${numericDocId}`;

        if (window.pdfCacheManager) {
          const complete = await window.pdfCacheManager.isComplete(numericDocId);
          if (thisLoadSeq !== currentViewerLoadSeq) return;

          if (complete) {
            updateCacheUI("complete", 100);
          } else {
            window.pdfCacheManager.getProgress(numericDocId).then(p => {
              if (thisLoadSeq === currentViewerLoadSeq && Number(currentActiveDocId) === numericDocId) {
                updateCacheUI(p.status, p.progress, p.downloadedBytes, p.totalBytes);
              }
            }).catch(() => {});
          }

          // Si déconnecté (mode hors-ligne) OU si le document est disponible en cache binaire local :
          const isDocCached = (window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(numericDocId));
          if (navigator.onLine === false || isDocCached || complete) {
            try {
              const localBlobUrl = await window.pdfCacheManager.getBlobUrl(numericDocId);
              if (thisLoadSeq !== currentViewerLoadSeq) return;
              if (localBlobUrl) {
                if (window._currentPdfBlobUrl) {
                  try { URL.revokeObjectURL(window._currentPdfBlobUrl); } catch (e) {}
                }
                window._currentPdfBlobUrl = localBlobUrl;
                pdfTargetUrl = localBlobUrl;
              }
            } catch (blobErr) {
              console.warn('[DocSeeker] Erreur chargement blob PDF local:', blobErr);
            }
          }
        }

        if (thisLoadSeq !== currentViewerLoadSeq) return;

        let viewerUrl = `/pdfjs/web/viewer.html?v=5.9&verbosity=0&file=${encodeURIComponent(pdfTargetUrl)}#page=${targetPage}`;
        // CANAL 4 : le hash ne porte QUE la recherche de l'onglet cible.
        // Jamais la requête d'un autre document (le global).
        if (effectiveSearchQuery) {
          viewerUrl += `&search=${encodeURIComponent(effectiveSearchQuery)}`;
        } else {
          viewerUrl += `&search=`;
        }

        const win = pdfFrame.contentWindow;
        if (win) {
          win._suppressPdfJsFindScroll = true;
        }
        const isWarm = Boolean(
          win &&
          win.PDFViewerApplication &&
          win.PDFViewerApplication.initialized &&
          typeof win.PDFViewerApplication.open === "function"
        );

        if (isWarm) {
          // --- ACCÉLÉRATION : RÉOUVERTURE À CHAUD SANS RECHARGEMENT D'IFRAME ---
          // L'iframe, les scripts PDF.js (3.5 Mo) et le WebWorker sont déjà prêts en mémoire.
          try {
            win.history.replaceState(null, "", viewerUrl);
            win._suppressPdfJsFindScroll = true;
          } catch (e) {}

          try {
            const app = win.PDFViewerApplication;

            const onDocReady = () => {
              if (thisLoadSeq !== currentViewerLoadSeq || Number(currentActiveDocId) !== numericDocId) return;
              try {
                const maxPages = app.pagesCount || (app.pdfDocument ? app.pdfDocument.numPages : 0);
                const safePage = (maxPages > 0 && targetPage > maxPages) ? maxPages : Math.max(1, targetPage || 1);
                if (app.page !== safePage) {
                  app.page = safePage;
                }
              } catch (e) {}
              setTimeout(() => {
                if (thisLoadSeq !== currentViewerLoadSeq || Number(currentActiveDocId) !== numericDocId) return;
                goToPageAndScrollToOccurrence(targetPage, targetRect, targetYRatio, targetScrollTop);
                hookIframePinchZoomIsolation();
                hookIframeScrollAutoHide();
              }, 60);
            };

            if (app.eventBus) {
              app.eventBus._on("pagesinit", onDocReady, { once: true });
            }

            if (thisLoadSeq !== currentViewerLoadSeq) return;
            await app.open({ url: pdfTargetUrl });
            if (thisLoadSeq !== currentViewerLoadSeq) return;

            // Sécurité si pagesinit s'est déjà produit ou pour assurer le cadrage exact
            setTimeout(() => {
              if (thisLoadSeq !== currentViewerLoadSeq || Number(currentActiveDocId) !== numericDocId) return;
              try {
                const maxPages = app.pagesCount || (app.pdfDocument ? app.pdfDocument.numPages : 0);
                const safePage = (maxPages > 0 && targetPage > maxPages) ? maxPages : Math.max(1, targetPage || 1);
                if (app.page !== safePage) {
                  app.page = safePage;
                }
              } catch (e) {}
              goToPageAndScrollToOccurrence(targetPage, targetRect, targetYRatio, targetScrollTop);
              hookIframePinchZoomIsolation();
              hookIframeScrollAutoHide();
            }, 180);

            return;
          } catch (warmErr) {
            console.warn("[DocSeeker] Réouverture à chaud échouée, repli vers rechargement complet :", warmErr);
          }
        }

        // Micro-différé de 120ms : garantit que les 3-4 vignettes visibles
        // occupent les slots réseau du navigateur en priorité avant le chargement lourd du PDF
        setTimeout(() => {
          if (thisLoadSeq !== currentViewerLoadSeq || Number(currentActiveDocId) !== numericDocId) return;
          pdfFrame.src = viewerUrl;
          pdfFrame.onload = () => {
            if (thisLoadSeq !== currentViewerLoadSeq || Number(currentActiveDocId) !== numericDocId) return;
            try {
              if (pdfFrame.contentWindow) pdfFrame.contentWindow._suppressPdfJsFindScroll = true;
            } catch (e) {}
            hookIframePinchZoomIsolation();
            hookIframeScrollAutoHide();

            // Synchronisation de la progression dès le chargement de l'iframe
            if (window.pdfCacheManager) {
              window.pdfCacheManager.getProgress(numericDocId).then(p => {
                if (Number(currentActiveDocId) === numericDocId) {
                  updateCacheUI(p.status, p.progress, p.downloadedBytes, p.totalBytes);
                }
              }).catch(() => {});
            }

            // Liaison directe avec l'eventBus de PDF.js (moteur unique avec cache IndexedDB)
            try {
              const win = pdfFrame.contentWindow;
              if (win && win.PDFViewerApplication && win.PDFViewerApplication.eventBus) {
                win.PDFViewerApplication.eventBus._on("docprogress", (evt) => {
                  if (Number(currentActiveDocId) === numericDocId) {
                    if (window.pdfCacheManager) {
                      window.pdfCacheManager.updateProgressFromViewer(numericDocId, evt.loaded, evt.total);
                    }
                    const percent = Math.min(100, Math.round((evt.loaded / evt.total) * 100));
                    updateCacheUI(percent >= 100 ? "complete" : "downloading", percent, evt.loaded, evt.total);
                  }
                });
                win.PDFViewerApplication.eventBus._on("doccomplete", (evt) => {
                  if (Number(currentActiveDocId) === numericDocId) {
                    if (window.pdfCacheManager) {
                      window.pdfCacheManager.markComplete(numericDocId, evt.length);
                    }
                    updateCacheUI("complete", 100, evt.length, evt.length);
                  }
                });
              }
            } catch (e) {}

            // Fallback résilient en cas d'erreur de chargement (ex: ancien cache corrompu)
            try {
              const win = pdfFrame.contentWindow;
              if (win && win.PDFViewerApplication && win.PDFViewerApplication.eventBus) {
                win.PDFViewerApplication.eventBus._on("documenterror", async (err) => {
                  console.warn(`[DocSeeker] Erreur chargement document ${numericDocId} :`, err);
                  if (window.pdfCacheManager) {
                    await window.pdfCacheManager.invalidate(numericDocId);
                  }
                  updateCacheUI("error", 0);
                }, { once: true });
              }
            } catch (e) {}

            setTimeout(() => {
              goToPageAndScrollToOccurrence(targetPage, targetRect, targetYRatio, targetScrollTop);
              hookIframePinchZoomIsolation();
              hookIframeScrollAutoHide();
            }, 400);
          };
        }, 120);
      })();
    }
  }

  // Empreinte du dernier rendu pour éviter un rebuild DOM complet inutile (C2)
  let _lastVerticalRenderHash = '';

  function renderVerticalOccurrences(docId, docTitle, occurrences, activePage, activeOccId = null) {
    // Calculer une empreinte légère de la liste pour détecter un render identique
    const renderHash = `${docId}|${occurrences ? occurrences.length : 0}|${occurrences && occurrences[0] ? occurrences[0].occ_id : ''}`;
    const isSameRender = (renderHash === _lastVerticalRenderHash) && docOccurrencesList.children.length > 0;

    if (isSameRender) {
      // La liste est identique : mettre à jour seulement la carte active sans rebuild DOM
      const cards = docOccurrencesList.querySelectorAll('.vertical-occ-card');
      let activeIdx = -1;
      if (activeOccId && activePage) activeIdx = (occurrences || []).findIndex(o => String(o.occ_id) === String(activeOccId) && Number(o.page_number) === Number(activePage));
      if (activeIdx === -1 && activePage) activeIdx = (occurrences || []).findIndex(o => Number(o.page_number) === Number(activePage));
      if (activeIdx === -1 && activeOccId) activeIdx = (occurrences || []).findIndex(o => String(o.occ_id) === String(activeOccId));
      if (activeIdx === -1) activeIdx = 0;
      cards.forEach((card, idx) => {
        const isActive = idx === activeIdx;
        card.classList.toggle('active', isActive);
        if (isActive) scrollActiveCardIntoView(card);
      });
      if (inDocDrawerOccurrencesList) {
        const drawerCards = inDocDrawerOccurrencesList.querySelectorAll('.vertical-occ-card');
        drawerCards.forEach((card, idx) => {
          const isActive = idx === activeIdx;
          card.classList.toggle('active', isActive);
          if (isActive) scrollActiveCardIntoView(card);
        });
      }
      return;
    }

    _lastVerticalRenderHash = renderHash;
    verticalCropManager.clear();
    docOccurrencesList.innerHTML = "";

    if (inDocDrawerCount) {
      const count = occurrences ? occurrences.length : 0;
      inDocDrawerCount.textContent = `${count} résultat${count > 1 ? 's' : ''}`;
    }
    if (inDocDrawerOccurrencesList) {
      inDocDrawerOccurrencesList.innerHTML = "";
    }

    if (!occurrences || occurrences.length === 0) {
      docOccurrencesList.innerHTML = `<div style="color:var(--text-muted); font-size:12.5px; padding:10px;">Aucun extrait trouvé pour ce terme dans ce document.</div>`;
      if (inDocDrawerOccurrencesList) {
        inDocDrawerOccurrencesList.innerHTML = `<div style="color:var(--text-muted); font-size:12.5px; padding:10px;">Aucun extrait trouvé pour ce terme dans ce document.</div>`;
      }
      return;
    }

    const placeholderSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='120'%3E%3Crect width='100%25' height='100%25' fill='%23f1f5f9'/%3E%3C/svg%3E";

    let activeTargetIndex = -1;
    if (activeOccId && activePage && occurrences) {
      activeTargetIndex = occurrences.findIndex(o => String(o.occ_id) === String(activeOccId) && Number(o.page_number) === Number(activePage));
    }
    if (activeTargetIndex === -1 && activePage && occurrences) {
      activeTargetIndex = occurrences.findIndex(o => Number(o.page_number) === Number(activePage));
    }
    if (activeTargetIndex === -1 && activeOccId && occurrences) {
      activeTargetIndex = occurrences.findIndex(o => String(o.occ_id) === String(activeOccId));
    }
    if (activeTargetIndex === -1 && occurrences && occurrences.length > 0) {
      activeTargetIndex = 0;
    }

    // Terme de surbrillance : la recherche intra-doc de l'onglet actif (jamais le global)
    const activeDocSearchTerm = getActiveDocSearchTerm();

    occurrences.forEach((occ, index) => {
      const card = document.createElement("div");
      const isActive = (index === activeTargetIndex);
      card.className = `vertical-occ-card ${isActive ? 'active' : ''}`;
      card.setAttribute("data-doc-id", docId);
      card.setAttribute("data-page", occ.page_number);
      card.setAttribute("data-occ-id", occ.occ_id || '');
      card.setAttribute("data-rect", JSON.stringify(occ.rect || []));
      card.setAttribute("data-hl-rects", JSON.stringify(occ.highlight_rects || (occ.rect ? [occ.rect] : [])));

      card.innerHTML = `
        <div class="vertical-occ-img-wrapper">
          <img src="${placeholderSvg}" data-src="${occ.crop_url}" class="vertical-occ-img dynamic-crop" alt="Extrait p. ${occ.page_number}" style="opacity: 0.6; transition: opacity 0.2s ease-in-out;" />
        </div>
        <div class="vertical-occ-footer">
          <span class="vertical-occ-page">Page ${occ.page_number}</span>
          <span class="vertical-occ-snippet" title="${escapeHtml(occ.text_snippet || '')}">${activeDocSearchTerm ? highlightTitle(occ.text_snippet || '', activeDocSearchTerm) : escapeHtml(occ.text_snippet || '')}</span>
        </div>
      `;

      card.addEventListener("click", () => {
        document.querySelectorAll(".vertical-occ-card.active").forEach(el => el.classList.remove("active"));
        card.classList.add("active");
        currentActiveOccurrenceIndex = index;
        updateOccurrenceStepperUI();
        viewerPageBadge.textContent = `Page ${occ.page_number}`;
        const targetRect = (occ.highlight_rects && occ.highlight_rects.length > 0) ? occ.highlight_rects[0] : occ.rect;
        goToPageAndScrollToOccurrence(occ.page_number, targetRect, occ.y_ratio);
      });

      docOccurrencesList.appendChild(card);
      const img = card.querySelector(".dynamic-crop");
      if (img) verticalCropManager.observe(img);

      if (inDocDrawerOccurrencesList) {
        const drawerCard = document.createElement("div");
        drawerCard.className = `vertical-occ-card ${isActive ? 'active' : ''}`;
        drawerCard.setAttribute("data-doc-id", docId);
        drawerCard.setAttribute("data-page", occ.page_number);
        drawerCard.setAttribute("data-occ-id", occ.occ_id || '');
        drawerCard.setAttribute("data-rect", JSON.stringify(occ.rect || []));
        drawerCard.setAttribute("data-hl-rects", JSON.stringify(occ.highlight_rects || (occ.rect ? [occ.rect] : [])));
        drawerCard.setAttribute("data-yratio", occ.y_ratio || 0);
        drawerCard.innerHTML = `
          <div class="vertical-occ-img-wrapper">
            <img src="${placeholderSvg}" data-src="${occ.crop_url}" class="vertical-occ-img dynamic-crop" alt="Extrait p. ${occ.page_number}" style="opacity: 0.6; transition: opacity 0.2s ease-in-out;" />
          </div>
          <div class="vertical-occ-footer">
            <span class="vertical-occ-page">Page ${occ.page_number}</span>
            <span class="vertical-occ-snippet" title="${escapeHtml(occ.text_snippet || '')}">${activeDocSearchTerm ? highlightTitle(occ.text_snippet || '', activeDocSearchTerm) : escapeHtml(occ.text_snippet || '')}</span>
          </div>
        `;
        drawerCard.addEventListener("click", () => {
          jumpToOccurrenceByIndex(index);
        });
        inDocDrawerOccurrencesList.appendChild(drawerCard);
        const drawerImg = drawerCard.querySelector(".dynamic-crop");
        if (drawerImg) verticalCropManager.observe(drawerImg);
      }
    });

    const activeCard = docOccurrencesList.querySelector(".vertical-occ-card.active");
    if (activeCard) {
      scrollActiveCardIntoView(activeCard);
    }
    if (inDocDrawerOccurrencesList) {
      const activeDrawerCard = inDocDrawerOccurrencesList.querySelector(".vertical-occ-card.active");
      if (activeDrawerCard) {
        scrollActiveCardIntoView(activeDrawerCard);
      }
    }
  }

  function goToPageAndScrollToOccurrence(pageNumber, rect = null, yRatio = 0.0, targetScrollTop = null) {
    try {
      if (!document.body.classList.contains('doc-open') || (viewerPane && viewerPane.style.display === 'none')) return;
      const pNum = parseInt(pageNumber, 10) || 1;
      pageNumber = pNum;
      const win = pdfFrame.contentWindow;
      if (!win) return;

      const app = win.PDFViewerApplication;
      if (app && app.pdfViewer) {
        const docViewer = win.document;
        const container = docViewer.getElementById("viewerContainer");

        const maxPages = app.pagesCount || (app.pdfDocument ? app.pdfDocument.numPages : 0);
        if (maxPages > 0 && pageNumber > maxPages) {
          pageNumber = maxPages;
        }
        if (pageNumber < 1) pageNumber = 1;

        if (app.page !== pageNumber) {
          try {
            app.page = pageNumber;
          } catch (pageErr) {
            console.warn('[DocSeeker] Impossible d\'assigner app.page immédiatement:', pageErr);
          }
        }

        const alignOccurrence = () => {
          const pageDiv = docViewer.querySelector(`.page[data-page-number="${pageNumber}"]`);
          if (!pageDiv || !container) return;

          docViewer.querySelectorAll(".active-occ-overlay").forEach(el => el.remove());

          // Si un scroll précis était mémorisé pour cet onglet, le restaurer directement au pixel près
          if (targetScrollTop !== null && targetScrollTop !== undefined && targetScrollTop >= 0) {
            container.scrollTop = targetScrollTop;
          }

          // Vérifier si une recherche active est en cours
          const hasActiveSearch = Boolean(
            (currentSearchQuery && currentSearchQuery.trim()) ||
            (docSearchInput && docSearchInput.value.trim()) ||
            getActiveDocSearchTerm()
          );

          // Si pas de recherche ou pas de coordonnées valides : NE PAS afficher de cadre bleu
          if (!hasActiveSearch || !rect || !Array.isArray(rect) || rect.length !== 4) {
            if (targetScrollTop === null || targetScrollTop === undefined) {
              if (yRatio && yRatio > 0) {
                const top = pageDiv.clientHeight * yRatio;
                const calcScroll = pageDiv.offsetTop + top - (container.clientHeight / 2);
                container.scrollTo({
                  top: Math.max(0, calcScroll),
                  behavior: "smooth"
                });
              }
            }
            return;
          }

          let left = 20, top = 100, width = 120, height = 24;

          const pageView = (app.pdfViewer.getPageView && app.pdfViewer.getPageView(pageNumber - 1)) ? app.pdfViewer.getPageView(pageNumber - 1) : null;
          
          if (pageView && pageView.viewport) {
            try {
              const [x0, y0, x1, y1] = rect;
              const pageHeightPts = pageView.viewport.rawDims ? pageView.viewport.rawDims.pageHeight : 842.0;
              const pdfY0 = pageHeightPts - y1;
              const pdfY1 = pageHeightPts - y0;
              const vpRect = pageView.viewport.convertToViewportRectangle([x0, pdfY0, x1, pdfY1]);
              
              left = Math.min(vpRect[0], vpRect[2]) - 4;
              top = Math.min(vpRect[1], vpRect[3]) - 3;
              width = Math.abs(vpRect[2] - vpRect[0]) + 8;
              height = Math.abs(vpRect[3] - vpRect[1]) + 6;
            } catch (convErr) {
              const scaleX = pageDiv.clientWidth / 595.0;
              const scaleY = pageDiv.clientHeight / 842.0;
              left = (rect[0] * scaleX) - 4;
              top = (rect[1] * scaleY) - 3;
              width = ((rect[2] - rect[0]) * scaleX) + 8;
              height = ((rect[3] - rect[1]) * scaleY) + 6;
            }
          } else {
            const scaleX = pageDiv.clientWidth / 595.0;
            const scaleY = pageDiv.clientHeight / 842.0;
            left = (rect[0] * scaleX) - 4;
            top = (rect[1] * scaleY) - 3;
            width = ((rect[2] - rect[0]) * scaleX) + 8;
            height = ((rect[3] - rect[1]) * scaleY) + 6;
          }

          const overlay = docViewer.createElement("div");
          overlay.className = "active-occ-overlay";
          overlay.style.position = "absolute";
          overlay.style.left = `${Math.max(0, left)}px`;
          overlay.style.top = `${Math.max(0, top)}px`;
          overlay.style.width = `${Math.max(20, width)}px`;
          overlay.style.height = `${Math.max(16, height)}px`;
          overlay.style.backgroundColor = "rgba(37, 99, 235, 0.28)";
          overlay.style.border = "2px solid #2563eb";
          overlay.style.borderRadius = "4px";
          overlay.style.boxShadow = "0 0 14px rgba(37, 99, 235, 0.6), inset 0 0 6px rgba(37, 99, 235, 0.4)";
          overlay.style.pointerEvents = "none";
          overlay.style.zIndex = "50";
          pageDiv.appendChild(overlay);

          if (targetScrollTop !== null && targetScrollTop !== undefined && targetScrollTop >= 0) {
            container.scrollTop = targetScrollTop;
          } else {
            const calcScrollTop = pageDiv.offsetTop + top - (container.clientHeight / 2) + (height / 2);
            container.scrollTo({
              top: Math.max(0, calcScrollTop),
              behavior: "smooth"
            });
          }
        };

        alignOccurrence();
        setTimeout(alignOccurrence, 150);
        return;
      }
    } catch (e) {
      console.warn("Erreur scroll PDFViewer:", e);
    }

    if (pdfFrame.contentWindow) {
      pdfFrame.contentWindow.location.hash = `#page=${pageNumber}`;
    }
  }

  // =========================================================================
  // Suppression de Document
  // =========================================================================
  async function confirmDeleteDocument(docId, docTitle) {
    if (!confirm(`Voulez-vous vraiment supprimer le document "${docTitle}" ? Cette action est irréversible.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/documents/${docId}`, { method: "DELETE" });
      if (res.ok) {
        showToast(`Document "${docTitle}" supprimé.`, "info");
        if (window.pdfCacheManager) window.pdfCacheManager.invalidate(docId).catch(() => {});
        selectedDocIds.delete(docId);
        updateSelectionUI();
        clearFolderDocsCache();
        if (currentActiveDocId === docId) {
          closeSplitViewer();
        }
        if (currentSearchQuery) {
          performSearch(currentSearchQuery);
        } else {
          loadFoldersAndDocuments();
        }
      } else {
        showToast("Erreur lors de la suppression.", "error");
      }
    } catch (err) {
      console.error(err);
      showToast("Erreur réseau.", "error");
    }
  }

  // =========================================================================
  // Upload, Dropzone & Doublons Stricts
  // =========================================================================
  openUploadBtn.addEventListener("click", () => {
    if (!navigator.onLine) {
      showToast("L'importation de documents nécessite une connexion réseau active.", "warning");
      return;
    }
    uploadModal.style.display = "flex";
    uploadProgressContainer.style.display = "none";
    uploadProgressBar.style.width = "0%";
    uploadProgressBar.style.backgroundColor = "var(--accent)";
    fileInput.value = "";
    docTitleInput.value = "";
    const singleTitleGroup = document.getElementById("singleTitleGroup");
    if (singleTitleGroup) singleTitleGroup.style.display = "block";
  });

  closeUploadModalBtn.addEventListener("click", () => uploadModal.style.display = "none");
  uploadModal.addEventListener("click", (e) => {
    if (e.target === uploadModal) uploadModal.style.display = "none";
  });

  closeDuplicateModalBtn.addEventListener("click", () => duplicateModal.style.display = "none");
  confirmDuplicateOkBtn.addEventListener("click", () => duplicateModal.style.display = "none");
  duplicateModal.addEventListener("click", (e) => {
    if (e.target === duplicateModal) duplicateModal.style.display = "none";
  });

  dropZone.addEventListener("click", () => fileInput.click());

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (!navigator.onLine) {
      showToast("L'importation de documents nécessite une connexion réseau active.", "warning");
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesUpload(e.dataTransfer.files);
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleFilesUpload(fileInput.files);
    }
  });

  // Support du glisser-déposer de PDF n'importe où sur la fenêtre
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      e.preventDefault();
    }
  });

  window.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const hasPdfs = Array.from(e.dataTransfer.files).some(f => f.name.toLowerCase().endsWith(".pdf"));
      if (hasPdfs) {
        e.preventDefault();
        if (!navigator.onLine) {
          showToast("L'importation de documents nécessite une connexion réseau active.", "warning");
          return;
        }
        uploadModal.style.display = "flex";
        handleFilesUpload(e.dataTransfer.files);
      }
    }
  });

  async function computeFileSha256(file) {
    try {
      if (!window.crypto || !window.crypto.subtle) {
        return null;
      }
      const buffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
    } catch (err) {
      console.warn("Pré-calcul du hash SHA-256 impossible :", err);
      return null;
    }
  }

  async function handleFilesUpload(fileList) {
    if (!navigator.onLine) {
      showToast("L'importation de documents nécessite une connexion réseau active.", "warning");
      return;
    }

    const rawFiles = Array.from(fileList || []);
    const pdfFiles = rawFiles.filter(f => f.name.toLowerCase().endsWith(".pdf"));

    if (pdfFiles.length === 0) {
      showToast("Veuillez sélectionner au moins un fichier PDF valide.", "warning");
      return;
    }

    uploadProgressContainer.style.display = "block";
    uploadProgressBar.style.backgroundColor = "var(--accent)";
    
    // Si plusieurs fichiers, masquer le champ de titre personnalisé unique
    const singleTitleGroup = document.getElementById("singleTitleGroup");
    if (pdfFiles.length > 1 && singleTitleGroup) {
      singleTitleGroup.style.display = "none";
    }

    let successCount = 0;
    let networkAborted = false;
    const duplicates = [];
    const errors = [];
    const total = pdfFiles.length;

    for (let i = 0; i < total; i++) {
      const file = pdfFiles[i];
      const percentBase = Math.round((i / total) * 100);
      uploadProgressBar.style.width = `${percentBase}%`;
      uploadStatusText.textContent = total === 1 
        ? `Vérification de ${file.name}...` 
        : `[${i + 1}/${total}] Vérification de ${file.name}...`;

      // Pré-vérification par empreinte SHA-256 pour éviter tout transfert réseau inutile
      const fileHash = await computeFileSha256(file);
      if (fileHash) {
        try {
          const checkRes = await fetch(`/api/check-hash/${fileHash}`);
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            if (checkData.exists) {
              duplicates.push({ file: file.name, info: checkData.existing_doc });
              uploadProgressBar.style.width = `${Math.round(((i + 1) / total) * 100)}%`;
              continue; // Document identique déjà en base : téléversement réseau évité !
            }
          }
        } catch (checkErr) {
          console.warn(`Vérification d'empreinte impossible pour ${file.name}:`, checkErr);
        }
      }

      uploadStatusText.textContent = total === 1 
        ? `Envoi de ${file.name}...` 
        : `[${i + 1}/${total}] Envoi de ${file.name}...`;

      const formData = new FormData();
      formData.append("file", file);
      if (total === 1 && docTitleInput && docTitleInput.value.trim()) {
        formData.append("title", docTitleInput.value.trim());
      }
      if (currentFolderId) {
        formData.append("folder_id", currentFolderId);
      }

      try {
        const res = await fetch("/api/upload?sync=false", {
          method: "POST",
          body: formData
        });

        if (res.status === 409) {
          const conflictData = await res.json().catch(() => ({}));
          duplicates.push({ file: file.name, info: conflictData.existing_doc });
          continue;
        }

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          const errMsg = errorData.error || errorData.message || errorData.detail || `Erreur HTTP ${res.status}`;
          errors.push({ file: file.name, error: errMsg });
          continue;
        }

        successCount++;
        uploadProgressBar.style.width = `${Math.round(((i + 1) / total) * 100)}%`;
      } catch (err) {
        console.error(`Upload error for ${file.name}:`, err);
        const errMsg = err.message || "Erreur réseau";
        errors.push({ file: file.name, error: errMsg });

        const isNetworkFailure = !navigator.onLine || 
          err.name === "TypeError" || 
          (err.message && (err.message.includes("fetch") || err.message.includes("network") || err.message.includes("Network")));
        if (isNetworkFailure) {
          networkAborted = true;
          for (let j = i + 1; j < total; j++) {
            errors.push({ file: pdfFiles[j].name, error: "Non envoyé (coupure réseau)" });
          }
          break;
        }
      }
    }

    uploadProgressBar.style.width = "100%";

    if (networkAborted) {
      uploadProgressBar.style.backgroundColor = "var(--warning)";
      uploadStatusText.textContent = `Coupure réseau : ${successCount} conservé(s), ${errors.length} non envoyé(s)`;
      showToast(`Coupure réseau : ${successCount} document(s) sauvegardé(s).`, successCount > 0 ? "warning" : "error");
    } else if (successCount > 0 && duplicates.length === 0 && errors.length === 0) {
      uploadProgressBar.style.backgroundColor = "var(--success)";
      uploadStatusText.textContent = total === 1
        ? "Document téléversé ! Indexation en arrière-plan..."
        : `${successCount} documents téléversés ! Indexation en arrière-plan...`;
    } else if (successCount > 0) {
      uploadProgressBar.style.backgroundColor = "var(--accent)";
      uploadStatusText.textContent = `${successCount} envoyé(s), ${duplicates.length} doublon(s), ${errors.length} erreur(s)`;
    } else if (duplicates.length > 0 && errors.length === 0) {
      uploadProgressBar.style.backgroundColor = "var(--warning)";
      uploadStatusText.textContent = total === 1 
        ? "Ce document existe déjà dans la base !" 
        : `${duplicates.length} document(s) déjà présent(s) (doublons ignorés)`;
    } else {
      uploadProgressBar.style.backgroundColor = "var(--danger)";
      uploadStatusText.textContent = `Échec de l'envoi (${errors.length} erreur(s))`;
    }

    // Démarrer immédiatement le suivi du pipeline et rafraîchir la liste
    if (successCount > 0) {
      startPipelinePolling();
      loadFoldersAndDocuments();
    }

    setTimeout(() => {
      uploadModal.style.display = "none";
      if (singleTitleGroup) singleTitleGroup.style.display = "block";

      // Si un seul fichier et doublon, afficher la modale d'alerte doublon détaillée
      if (total === 1 && duplicates.length === 1) {
        const exist = duplicates[0].info || {};
        duplicateTitle.textContent = exist.title || "Document sans titre";
        duplicateFilename.textContent = exist.filename || duplicates[0].file;
        duplicateDate.textContent = exist.created_at ? new Date(exist.created_at).toLocaleString("fr-FR") : "Date inconnue";
        duplicateModal.style.display = "flex";
        return;
      }

      // Notifications toast adaptées
      if (successCount > 0) {
        const dupMsg = duplicates.length > 0 ? ` (${duplicates.length} doublon(s) ignoré(s))` : "";
        const errMsg = errors.length > 0 ? ` (${errors.length} erreur(s))` : "";
        showToast(`${successCount} document(s) reçu(s) ! Indexation en cours en tâche de fond...${dupMsg}${errMsg}`, "success");
      } else if (duplicates.length > 0 && errors.length === 0) {
        showToast(`${duplicates.length} document(s) ignoré(s) car déjà présent(s) dans la base.`, "warning");
      } else if (errors.length > 0) {
        showToast(`Erreur lors de l'import de ${errors.length} document(s).`, "danger");
      }
    }, 700);
  }

  // Chargement et affichage discret uniquement du numéro de commit
  async function loadAppVersion() {
    if (!navigator.onLine) return;
    try {
      const res = await apiFetch("/api/version");
      if (res.ok) {
        const data = await res.json();
        const badge = document.getElementById("appVersionBadge");
        if (badge) {
          const shortCommit = data.commit && data.commit !== "unknown" ? data.commit.substring(0, 7) : "";
          if (shortCommit) {
            badge.textContent = shortCommit;
            badge.title = `Commit: ${data.commit}`;
            badge.style.display = "inline-flex";
          } else {
            badge.style.display = "none";
          }
        }
      }
    } catch (e) {
      console.warn("Impossible de charger la version:", e);
    }
  }

  // =========================================================================
  // Intégration PWA & Mode Hors-Ligne Résilient
  // =========================================================================
  const downloadDrawer = document.getElementById("downloadDrawer");
  const downloadDrawerSummary = document.getElementById("downloadDrawerSummary");
  const downloadDrawerBody = document.getElementById("downloadDrawerBody");
  const downloadDrawerList = document.getElementById("downloadDrawerList");
  const drawerPauseBtn = document.getElementById("drawerPauseBtn");
  const drawerPauseIcon = document.getElementById("drawerPauseIcon");
  const drawerToggleBtn = document.getElementById("drawerToggleBtn");
  const drawerToggleIcon = document.getElementById("drawerToggleIcon");
  const downloadDrawerHeader = document.getElementById("downloadDrawerHeader");

  let isDrawerCollapsed = false;

  if (drawerToggleBtn && downloadDrawerBody) {
    drawerToggleBtn.addEventListener("click", () => {
      isDrawerCollapsed = !isDrawerCollapsed;
      downloadDrawerBody.style.display = isDrawerCollapsed ? "none" : "block";
      if (drawerToggleIcon) {
        drawerToggleIcon.style.transform = isDrawerCollapsed ? "rotate(180deg)" : "rotate(0deg)";
      }
    });
  }

  if (drawerPauseBtn) {
    drawerPauseBtn.addEventListener("click", () => {
      if (window.downloadQueueManager) {
        if (window.downloadQueueManager.isPaused) {
          window.downloadQueueManager.resume();
        } else {
          window.downloadQueueManager.pause();
        }
      }
    });
  }

  if (window.downloadQueueManager) {
    window.downloadQueueManager.onUpdate((state) => {
      if (!downloadDrawer) return;

      const totalActiveOrQueued = state.queueCount + state.activeCount;
      if (totalActiveOrQueued === 0) {
        downloadDrawer.style.display = "none";
        return;
      }

      downloadDrawer.style.display = "block";
      if (downloadDrawerSummary) {
        downloadDrawerSummary.textContent = `${state.activeCount} actif(s), ${state.queueCount} en attente`;
      }

      if (drawerPauseIcon) {
        drawerPauseIcon.innerHTML = state.isPaused
          ? `<polygon points="5 3 19 12 5 21 5 3"></polygon>`
          : `<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>`;
      }

      if (downloadDrawerList) {
        downloadDrawerList.innerHTML = "";
        for (const task of state.activeTasks) {
          const item = document.createElement("div");
          item.className = "download-drawer-item";
          item.innerHTML = `
            <div class="download-item-title">Doc #${task.docId}</div>
            <div class="download-item-progress">
              <div class="download-item-bar" style="width: ${task.progress || 0}%;"></div>
            </div>
            <div class="download-item-pct">${task.progress || 0}%</div>
          `;
          downloadDrawerList.appendChild(item);
        }
      }
    });
  }

  function updateNetworkStatusUI() {
    const isOnline = navigator.onLine;
    if (offlineNoticeBanner) {
      offlineNoticeBanner.style.display = isOnline ? "none" : "flex";
    }
    if (!isOnline && filterOfflineOnly) {
      filterOfflineOnly.checked = true;
      if (filterOfflineChip) filterOfflineChip.classList.add("active");
    }
  }

  window.addEventListener("online", () => {
    updateNetworkStatusUI();
    showToast("Connexion rétablie — synchronisation avec le serveur", "success");
    if (window.downloadQueueManager) {
      window.downloadQueueManager.checkSync();
    }
  });

  window.addEventListener("offline", () => {
    updateNetworkStatusUI();
    showToast("Connexion perdue — passage automatique en mode hors-ligne", "warning");
  });

  updateNetworkStatusUI();

  // Enregistrement du Service Worker & Persistance du stockage
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js")
      .then((reg) => {
        console.log("[ServiceWorker] Enregistré avec succès:", reg.scope);
        reg.update().catch(() => {});
      })
      .catch((err) => console.warn("[ServiceWorker] Échec enregistrement:", err));

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      console.log("[ServiceWorker] Nouveau contrôleur actif (mise à jour Service Worker activée)");
      if (window.offlineCropRenderer && typeof window.offlineCropRenderer.reinitializeWorker === "function") {
        window.offlineCropRenderer.reinitializeWorker();
      }
      if (window.downloadQueueManager && typeof window.downloadQueueManager.reinitializeWorker === "function") {
        window.downloadQueueManager.reinitializeWorker();
      }
      // La page qui tourne peut encore exécuter du code périmé (scripts en cache HTTP
      // antérieurs à la nouvelle version du SW) : un seul rechargement automatique
      // aligne la page sur le contrôleur actif. Garde anti-boucle de 30 s.
      try {
        const RELOAD_KEY = "docseeker_last_sw_controller_reload";
        const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
        if (Date.now() - last > 30000) {
          sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
          location.reload();
        }
      } catch (_) {}
    });
  }

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then((persistent) => {
      console.log("[Storage] Persistance du stockage accordée :", persistent);
    });
  }

  window.performSearch = performSearch;

  function updateDocCardCacheUI(docId) {
    const id = Number(docId);
    if (!id) return;
    const cards = document.querySelectorAll(`.doc-card[data-doc-id="${id}"], .doc-card[data-id="${id}"]`);
    cards.forEach(card => {
      const btn = card.querySelector(".doc-cache-btn");
      if (!btn) return;
      const isTaskActive = window.downloadQueueManager && window.downloadQueueManager.activeTasks.has(id);
      const isTaskQueued = window.downloadQueueManager && window.downloadQueueManager.queue.includes(id);
      const isCached = window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(id);

      const stats = window.pdfCacheManager ? window.pdfCacheManager.progressCache.get(id) : null;
      const hasChunks = Boolean(stats && stats.downloadedBytes > 0);

      // Rayon r=10, circonférence = 2 * PI * 10 ≈ 62.83
      const circumference = 62.83;

      if (isTaskActive) {
        const task = window.downloadQueueManager.activeTasks.get(id);
        const progress = Math.max(1, Math.min(100, task ? (task.progress || 0) : 0));
        const offset = (circumference * (1 - progress / 100)).toFixed(2);

        btn.className = "doc-cache-btn downloading";
        btn.title = `Téléchargement en cours : ${progress}% (cliquer pour interrompre)`;
        btn.innerHTML = `
          <svg class="progress-ring" viewBox="0 0 26 26">
            <circle cx="13" cy="13" r="10" stroke="rgba(37, 99, 235, 0.18)" stroke-width="2.2" fill="none" />
            <circle class="progress-ring-circle" cx="13" cy="13" r="10" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" fill="none" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 13 13)" />
            <rect class="progress-stop-square" x="9.5" y="9.5" width="7" height="7" rx="1.5" fill="var(--accent)" />
          </svg>
        `;
      } else if (isTaskQueued) {
        btn.className = "doc-cache-btn downloading";
        btn.title = "En attente de téléchargement... (cliquer pour annuler)";
        btn.innerHTML = `
          <svg class="progress-ring spinning" viewBox="0 0 26 26">
            <circle cx="13" cy="13" r="10" stroke="rgba(37, 99, 235, 0.18)" stroke-width="2.2" fill="none" />
            <circle class="progress-ring-circle" cx="13" cy="13" r="10" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" fill="none" stroke-dasharray="18 45" />
            <rect class="progress-stop-square" x="9.5" y="9.5" width="7" height="7" rx="1.5" fill="var(--accent)" />
          </svg>
        `;
      } else if (isCached) {
        btn.className = "doc-cache-btn cached";
        btn.title = "Disponible hors-ligne (cliquer pour retirer du cache)";
        btn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;
      } else if (hasChunks) {
        const progress = stats && stats.totalBytes > 0 
          ? Math.max(5, Math.min(95, Math.round((stats.downloadedBytes / stats.totalBytes) * 100))) 
          : 20;
        const offset = (circumference * (1 - progress / 100)).toFixed(2);

        btn.className = "doc-cache-btn";
        btn.title = `Cache partiel (${progress}%) - Cliquer pour compléter le téléchargement`;
        btn.innerHTML = `
          <svg class="progress-ring" viewBox="0 0 26 26">
            <circle cx="13" cy="13" r="10" stroke="rgba(100, 116, 139, 0.2)" stroke-width="2" fill="none" />
            <circle class="progress-ring-circle" cx="13" cy="13" r="10" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" fill="none" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 13 13)" />
            <path d="M13 8.5v6.5M10.5 12.5l2.5 2.5 2.5-2.5" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" />
          </svg>
        `;
      } else {
        btn.className = "doc-cache-btn";
        btn.title = "Télécharger pour consultation hors-ligne";
        btn.innerHTML = `
          <svg class="cache-icon-cloud" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 16.9A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"></path>
            <polyline points="8 17 12 21 16 17"></polyline>
            <line x1="12" y1="12" x2="12" y2="21"></line>
          </svg>
        `;
      }
    });
  }

  function updateFolderCardCacheUI(folderEl) {
    if (!folderEl || !window.downloadQueueManager) return;
    const folderId = Number(folderEl.getAttribute("data-folder-id"));
    const totalDocs = Number(folderEl.getAttribute("data-doc-count") || 0);
    if (!folderId) return;

    const cachedCount = window.downloadQueueManager.getCachedDocsCountForFolder(folderId);
    const isComplete = totalDocs > 0 && cachedCount >= totalDocs;
    const isPartial = cachedCount > 0 && (!totalDocs || cachedCount < totalDocs);

    const actionBtn = folderEl.querySelector(".folder-btn-action.btn-download-folder, .folder-btn-action.btn-delete-folder-cache, .sync-action-btn");
    if (actionBtn) {
      if (isComplete) {
        actionBtn.className = "folder-btn-action sync-action-btn complete btn-delete-folder-cache";
        actionBtn.title = "Supprimer tous les documents de ce dossier du cache local";
        actionBtn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
        `;
      } else {
        actionBtn.className = `folder-btn-action sync-action-btn ${isPartial ? 'partial' : ''} btn-download-folder`;
        actionBtn.title = isPartial ? `Télécharger les documents manquants (${cachedCount}/${totalDocs})` : "Télécharger tous les documents de ce dossier";
        if (isPartial) {
          actionBtn.innerHTML = `<span class="sync-badge-count">${cachedCount}/${totalDocs}</span>`;
        } else {
          actionBtn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><polyline points="8 12 12 16 16 12"></polyline><line x1="12" y1="8" x2="12" y2="16"></line></svg>
          `;
        }
      }
    }
  }

  if (window.downloadQueueManager) {
    window.downloadQueueManager.onUpdate((state) => {
      document.querySelectorAll(".doc-card[data-doc-id], .doc-card[data-id]").forEach(card => {
        const id = Number(card.getAttribute("data-doc-id") || card.getAttribute("data-id"));
        if (id) updateDocCardCacheUI(id);
      });
      document.querySelectorAll(".folder-card[data-folder-id]").forEach(folderEl => {
        updateFolderCardCacheUI(folderEl);
      });
      if (filterOfflineOnly && filterOfflineOnly.checked) {
        document.querySelectorAll(".doc-card[data-doc-id], .doc-card[data-id]").forEach(card => {
          const id = Number(card.getAttribute("data-doc-id") || card.getAttribute("data-id"));
          if (id) {
            card.style.display = window.downloadQueueManager.isDocumentCached(id) ? "" : "none";
          }
        });
        document.querySelectorAll(".folder-card[data-folder-id]").forEach(folderEl => {
          const folderId = Number(folderEl.getAttribute("data-folder-id"));
          if (folderId) {
            const count = window.downloadQueueManager.getCachedDocsCountForFolder(folderId);
            folderEl.style.display = count > 0 ? "" : "none";
          }
        });
        const visibleFolderCards = Array.from(document.querySelectorAll(".folder-card")).filter(el => el.style.display !== "none");
        foldersSection.style.display = visibleFolderCards.length > 0 ? "block" : "none";
      } else {
        document.querySelectorAll(".folder-card[data-folder-id]").forEach(folderEl => {
          folderEl.style.display = "";
        });
        if (!isSearchActive && !currentSearchQuery && document.querySelectorAll(".folder-card").length > 0) {
          foldersSection.style.display = "block";
        }
      }
    });
  }

  // Initialisation au chargement de l'application
  loadAppVersion();
  startPipelinePolling();
});


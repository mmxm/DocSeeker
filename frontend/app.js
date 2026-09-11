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
  const viewerDocTitle = document.getElementById("viewerDocTitle");
  const viewerPageBadge = document.getElementById("viewerPageBadge");
  const pdfFrame = document.getElementById("pdfFrame");
  const closeViewerBtn = document.getElementById("closeViewerBtn");
  const saveAnnotationsBtn = document.getElementById("saveAnnotationsBtn");
  const viewerBackBtn = document.getElementById("viewerBackBtn");
  const mobileOccurrencesBtn = document.getElementById("mobileOccurrencesBtn");
  const mobileOccurrencesCountText = document.getElementById("mobileOccurrencesCountText");
  const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");
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

  // =========================================================================
  // État de l'Application
  // =========================================================================
  let debounceTimer = null;
  let docSearchDebounceTimer = null;
  let currentSearchQuery = "";
  let currentActiveDocId = null;
  let currentActiveDocTitle = "";
  let currentDocOriginalOccurrences = [];
  let savedGeneralResultsScrollTop = 0;
  let isRestoringScroll = false;

  // État des dossiers
  let currentFolderId = null; // null = racine
  let currentFolderName = "Documents";
  let folderBreadcrumbs = [{ id: null, name: "Documents" }];
  let allFolders = [];
  let currentLoadedDocs = [];
  let rawLoadedDocs = [];
  let lastSearchResultsData = null;
  let selectedFolderColor = "#3b82f6"; // Uniforme bleu par défaut

  // Tri des documents et résultats
  const sortSelect = document.getElementById("sortSelect");
  const sortPillCurrent = document.getElementById("sortPillCurrent");
  let currentSortMode = "name_asc";
  let userManuallyChangedSort = false;

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
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          const img = entry.target;
          if (entry.isIntersecting) {
            this.scheduleLoad(img);
          } else {
            this.cancelPending(img);
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
    }

    scheduleLoad(img) {
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

    loadImg(img) {
      const srcUrl = img.getAttribute("data-src");
      if (!srcUrl || img.dataset.loaded === "true") return;

      img.dataset.loaded = "true";
      this.cancelPending(img);
      try {
        this.observer.unobserve(img);
      } catch (e) {}

      img.onload = () => {
        img.style.opacity = "1";
      };
      img.onerror = () => {
        // En cas d'erreur de chargement réseau, réessayer une fois après 500ms
        if (!img.dataset.retried) {
          img.dataset.retried = "true";
          setTimeout(() => {
            img.src = srcUrl;
          }, 500);
        }
      };

      img.src = srcUrl;
    }

    clear() {
      for (const [, timer] of this.pendingDebounce.entries()) {
        clearTimeout(timer);
      }
      this.pendingDebounce.clear();
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
    try {
      const res = await fetch("/api/pipeline/status");
      if (!res.ok) return;
      const data = await res.json();

      const isProcessing = Boolean(data.is_processing || (data.queue_length > 0) || data.current_job);
      const remaining = (data.queue_length || 0) + (data.current_job ? 1 : 0);

      // Adapter la cadence de polling : 2s pendant une indexation active, 10s au repos
      const targetDelay = isProcessing ? 2000 : 10000;
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
      console.warn("Erreur vérification statut pipeline:", err);
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

    if (!cardContextMenu) return;

    cardContextMenu.style.display = "flex";
    const popoverWidth = 180;
    const popoverHeight = 160;

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

  // Bouton replier/déplier volet latéral gauche (Desktop)
  if (toggleSidebarBtn) {
    toggleSidebarBtn.addEventListener("click", () => {
      workspace.classList.toggle("sidebar-collapsed");
    });
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

  function renderDrawerOccurrences(docId, docTitle, occurrences, activePage) {
    if (!drawerOccurrencesList) return;
    drawerOccurrencesList.innerHTML = "";
    if (!occurrences || occurrences.length === 0) {
      drawerOccurrencesList.innerHTML = `<div style="color:var(--text-muted); font-size:12.5px; padding:10px;">Aucun extrait pour ce document.</div>`;
      return;
    }

    const placeholderSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='120'%3E%3Crect width='100%25' height='100%25' fill='%23f1f5f9'/%3E%3C/svg%3E";

    occurrences.forEach((occ, index) => {
      const item = document.createElement("div");
      const isActive = (occ.page_number === activePage);
      item.className = `vertical-occ-card ${isActive ? 'active' : ''}`;
      item.innerHTML = `
        <div class="vertical-occ-img-wrapper">
          <img src="${placeholderSvg}" data-src="${occ.crop_url}" class="vertical-occ-img dynamic-crop" alt="Extrait p. ${occ.page_number}" style="opacity: 0.6; transition: opacity 0.2s ease-in-out;" />
        </div>
        <div class="vertical-occ-footer">
          <span class="vertical-occ-page">Page ${occ.page_number}</span>
          <span class="vertical-occ-snippet">${currentSearchQuery ? highlightTitle(occ.text_snippet || '', currentSearchQuery) : escapeHtml(occ.text_snippet || '')}</span>
        </div>
      `;
      item.addEventListener("click", () => {
        closeMobileOccurrencesDrawer();
        currentActiveOccurrenceIndex = index;
        updateOccurrenceStepperUI();
        const targetRect = (occ.highlight_rects && occ.highlight_rects.length > 0) ? occ.highlight_rects[0] : occ.rect;
        openDocumentInSplitView(docId, docTitle, occ.page_number, occurrences, targetRect, occ.y_ratio || 0);
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
    try {
      const res = await fetch(cleanOrigin() + "/api/auth/status");
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated) {
          hideLoginModal();
          loadFoldersAndDocuments();
          return;
        }
      }
      showLoginModal();
    } catch (_) {
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
  function updateSelectionUI() {
    // Mettre à jour la classe .selected sur toutes les cartes affichées
    document.querySelectorAll(".doc-card").forEach(card => {
      const docId = parseInt(card.getAttribute("data-doc-id"), 10);
      const isSelected = selectedDocIds.has(docId);
      if (isSelected) {
        card.classList.add("selected");
      } else {
        card.classList.remove("selected");
      }
      const chk = card.querySelector(".doc-selection-checkbox");
      if (chk) chk.checked = isSelected;
    });

    const count = selectedDocIds.size;
    if (count > 0) {
      selectionActionBar.style.display = "flex";
      selectionCountText.textContent = `${count} document${count > 1 ? 's' : ''} sélectionné${count > 1 ? 's' : ''}`;
    } else {
      selectionActionBar.style.display = "none";
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

    // Si le champ est entièrement vidé alors qu'une recherche était active, réinitialiser
    if (!val && currentSearchQuery) {
      currentSearchQuery = "";
      document.querySelectorAll(".doc-card").forEach(card => card.style.opacity = "1");
      loadFoldersAndDocuments();
    }
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.querySelectorAll(".doc-card").forEach(card => card.style.opacity = "1");
      performSearch(searchInput.value.trim());
    }
  });

  clearSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearSearchBtn.style.display = "none";
    searchInput.focus();
    loadFoldersAndDocuments();
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

  brandBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearSearchBtn.style.display = "none";
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

  if (saveAnnotationsBtn) {
    saveAnnotationsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      saveAnnotationsToServer(true);
    });
  }

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

  function closeSplitViewer() {
    if (currentActiveDocId && window.pdfCacheManager) {
      window.pdfCacheManager.pauseDownload(currentActiveDocId);
    }
    workspace.classList.remove("split-active");
    document.documentElement.classList.remove("doc-open");
    document.body.classList.remove("doc-open");
    const appEl = document.getElementById("app");
    if (appEl) appEl.classList.remove("doc-open");
    setDocumentZoomLock(false);
    if (viewerDocSearchWrapper) viewerDocSearchWrapper.style.display = "none";
    syncDocSearchInputs("");
    currentActiveOccurrences = [];
    currentActiveOccurrenceIndex = -1;
    updateOccurrenceStepperUI();
    try {
      if (pdfFrame && pdfFrame.contentWindow && pdfFrame.contentWindow.PDFViewerApplication) {
        pdfFrame.contentWindow.PDFViewerApplication.close();
      }
    } catch (e) {}
    currentActiveDocId = null;
    showGeneralResultsView();
  }

  function showGeneralResultsView() {
    docDetailView.style.display = "none";
    generalView.style.display = "block";
    document.querySelectorAll(".vignette-item.active").forEach(el => el.classList.remove("active"));

    // Restauration robuste et protégée du niveau de défilement vertical initial
    isRestoringScroll = true;
    const targetScroll = savedGeneralResultsScrollTop;
    const restore = () => {
      if (resultsPane) {
        resultsPane.scrollTop = targetScroll;
      }
    };
    restore();
    requestAnimationFrame(() => {
      restore();
      requestAnimationFrame(() => {
        restore();
        setTimeout(() => {
          restore();
          isRestoringScroll = false;
        }, 50);
      });
    });
  }

  function updateFolderFilterVisibility() {
    if (currentFolderId === null) {
      filterFolderLabel.textContent = "Dans ce dossier uniquement";
      filterFolderChip.style.display = "none";
      filterCurrentFolderOnly.checked = false;
      filterFolderChip.classList.remove("active");
    } else {
      filterFolderLabel.textContent = `Dans "${currentFolderName}" uniquement`;
      filterFolderChip.style.display = "inline-flex";
    }
  }

  // =========================================================================
  // Recherche Interne au Document (Split View, Header Viewer, Tiroir Mobile)
  // =========================================================================
  function syncDocSearchInputs(val, sourceInput = null) {
    if (docSearchInput && docSearchInput !== sourceInput && docSearchInput.value !== val) docSearchInput.value = val;
    if (viewerDocSearchInput && viewerDocSearchInput !== sourceInput && viewerDocSearchInput.value !== val) viewerDocSearchInput.value = val;
    if (drawerDocSearchInput && drawerDocSearchInput !== sourceInput && drawerDocSearchInput.value !== val) drawerDocSearchInput.value = val;

    const hasVal = Boolean(val && val.trim().length > 0);
    if (clearDocSearchBtn) clearDocSearchBtn.style.display = hasVal ? "flex" : "none";
    if (viewerDocSearchClearBtn) viewerDocSearchClearBtn.style.display = hasVal ? "flex" : "none";
    if (drawerDocSearchClearBtn) drawerDocSearchClearBtn.style.display = hasVal ? "flex" : "none";
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
          if (currentSearchQuery && !viewerDocSearchInput.value) {
            syncDocSearchInputs(currentSearchQuery);
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

  function jumpToOccurrenceByIndex(index) {
    if (!currentActiveOccurrences || currentActiveOccurrences.length === 0) return;
    if (index < 0) index = currentActiveOccurrences.length - 1;
    if (index >= currentActiveOccurrences.length) index = 0;

    currentActiveOccurrenceIndex = index;
    const occ = currentActiveOccurrences[index];

    updateOccurrenceStepperUI();

    // Mettre à jour la sélection visuelle dans la liste latérale
    document.querySelectorAll(".vertical-occ-card").forEach((el, idx) => {
      const isCardActive = (idx === index);
      el.classList.toggle("active", isCardActive);
      if (isCardActive) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });

    // Mettre à jour la sélection visuelle dans le tiroir mobile
    if (drawerOccurrencesList) {
      drawerOccurrencesList.querySelectorAll(".vertical-occ-card").forEach((el, idx) => {
        const isCardActive = (idx === index);
        el.classList.toggle("active", isCardActive);
        if (isCardActive) {
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      });
    }

    if (occ) {
      if (viewerPageBadge) {
        viewerPageBadge.textContent = `Page ${occ.page_number}`;
      }
      const targetRect = (occ.highlight_rects && occ.highlight_rects.length > 0) ? occ.highlight_rects[0] : occ.rect;
      goToPageAndScrollToOccurrence(occ.page_number, targetRect, occ.y_ratio);
    }
  }

  function goToNextOccurrence() {
    jumpToOccurrenceByIndex(currentActiveOccurrenceIndex + 1);
  }

  function goToPrevOccurrence() {
    jumpToOccurrenceByIndex(currentActiveOccurrenceIndex - 1);
  }

  if (prevOccBtn) prevOccBtn.addEventListener("click", goToPrevOccurrence);
  if (nextOccBtn) nextOccBtn.addEventListener("click", goToNextOccurrence);
  if (searchPrevBtn) searchPrevBtn.addEventListener("click", goToPrevOccurrence);
  if (searchNextBtn) searchNextBtn.addEventListener("click", goToNextOccurrence);

  // Support de la touche Entrée dans les champs de recherche du document
  let lastExecutedDocSearchQuery = "";
  [viewerDocSearchInput, docSearchInput, drawerDocSearchInput].forEach(inp => {
    if (inp) {
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const query = (inp.value || "").trim();
          if (query !== lastExecutedDocSearchQuery) {
            lastExecutedDocSearchQuery = query;
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

  async function performDocSearch(query, updateInputs = true) {
    if (updateInputs) {
      syncDocSearchInputs(query);
    }

    if (!query) {
      const origCount = currentDocOriginalOccurrences ? currentDocOriginalOccurrences.length : 0;
      const countText = `${origCount} occurrence${origCount > 1 ? 's' : ''} dans ce document`;
      const pillText = `${origCount} extrait${origCount > 1 ? 's' : ''}`;

      if (docDetailCount) docDetailCount.textContent = countText;
      if (viewerDocSearchResultCount) viewerDocSearchResultCount.textContent = "";
      if (mobileOccurrencesCountText) mobileOccurrencesCountText.textContent = pillText;
      if (drawerDocCount) drawerDocCount.textContent = pillText;

      currentActiveOccurrences = currentDocOriginalOccurrences || [];
      renderVerticalOccurrences(currentActiveDocId, currentActiveDocTitle, currentDocOriginalOccurrences);
      renderDrawerOccurrences(currentActiveDocId, currentActiveDocTitle, currentDocOriginalOccurrences);
      updateViewerSearchHighlight(currentSearchQuery);

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
      const res = await fetch(`/api/doc-search?doc_id=${currentActiveDocId}&q=${encodeURIComponent(query)}`);
      const data = await res.json();
      const occs = data.occurrences || [];

      const resultLabel = `${occs.length} résultat${occs.length > 1 ? 's' : ''}`;
      const pillLabel = `${occs.length} extrait${occs.length > 1 ? 's' : ''}`;

      if (docDetailCount) docDetailCount.textContent = `${resultLabel} pour "${query}"`;
      if (viewerDocSearchResultCount) viewerDocSearchResultCount.textContent = resultLabel;
      if (mobileOccurrencesCountText) mobileOccurrencesCountText.textContent = pillLabel;
      if (drawerDocCount) drawerDocCount.textContent = pillLabel;

      currentActiveOccurrences = occs;
      renderVerticalOccurrences(currentActiveDocId, currentActiveDocTitle, occs);
      renderDrawerOccurrences(currentActiveDocId, currentActiveDocTitle, occs);
      updateViewerSearchHighlight(query);

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
        item.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          ${crumb.name}
        `;
      } else {
        item.textContent = crumb.name;
      }

      // Clic pour naviguer en arrière
      if (!isLast) {
        item.addEventListener("click", () => {
          navigateToCrumb(index);
        });
      }

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

  function navigateToCrumb(index) {
    folderBreadcrumbs = folderBreadcrumbs.slice(0, index + 1);
    const target = folderBreadcrumbs[index];
    currentFolderId = target.id;
    currentFolderName = target.name;
    updateFolderFilterVisibility();
    clearSelection();
    loadFoldersAndDocuments();
  }

  function enterFolder(folder) {
    currentFolderId = folder.id;
    currentFolderName = folder.name;
    folderBreadcrumbs.push({ id: folder.id, name: folder.name });
    updateFolderFilterVisibility();
    clearSelection();
    loadFoldersAndDocuments();
  }

  async function loadFoldersAndDocuments() {
    currentSearchQuery = "";
    savedGeneralResultsScrollTop = 0;
    showGeneralResultsView();
    renderBreadcrumbs();
    updateFolderFilterVisibility();
    updatePasteButtonUI();

    sectionTitle.textContent = currentFolderId ? `Documents dans "${currentFolderName}"` : "Documents";
    searchStats.textContent = "";

    try {
      // 1. Récupérer les dossiers
      const parentParam = currentFolderId ? currentFolderId : "root";
      const foldersRes = await fetch(`/api/folders?parent_id=${parentParam}`);
      const foldersData = await foldersRes.json();
      const currentFolders = foldersData.folders || [];

      // Charger également tous les dossiers en mémoire pour le déplacement
      const allFoldersRes = await fetch("/api/folders");
      const allFoldersData = await allFoldersRes.json();
      allFolders = allFoldersData.folders || [];

      renderFolders(currentFolders);

      // 2. Récupérer les documents du dossier courant
      const docFolderParam = currentFolderId ? currentFolderId : "root";
      const docsRes = await fetch(`/api/documents?folder_id=${docFolderParam}`);
      const docsData = await docsRes.json();
      currentLoadedDocs = docsData.documents || [];
      renderDocumentLibrary(currentLoadedDocs);

    } catch (err) {
      console.error("Erreur chargement arborescence:", err);
      showToast("Erreur de chargement des documents et dossiers", "error");
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
      card.className = "folder-card";
      card.setAttribute("data-folder-id", folder.id);

      const folderColor = "#3b82f6";

      card.innerHTML = `
        <div class="folder-icon-wrapper" style="background-color: ${folderColor};">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <div class="folder-info">
          <div class="folder-name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</div>
          <div class="folder-meta">${folder.doc_count || 0} document${(folder.doc_count || 0) > 1 ? 's' : ''}</div>
        </div>
        <div class="folder-actions">
          <button class="folder-btn-action btn-delete-folder" title="Supprimer ce dossier" data-id="${folder.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
          <div class="folder-chevron">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </div>
        </div>
      `;

      // Clic pour entrer dans le dossier
      card.addEventListener("click", (e) => {
        if (e.target.closest(".folder-btn-action")) return;
        enterFolder(folder);
      });

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

    sortedDocs.forEach(doc => {
      const card = createDocCardElement(doc, false);
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

  function highlightTitle(title, query) {
    if (!title) return "";
    if (!query || !query.trim()) return escapeHtml(title);

    try {
      const rawTerms = query.trim().split(/\s+/).filter(t => t.length >= 1);
      if (rawTerms.length === 0) return escapeHtml(title);

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

      const pattern = new RegExp(`(${patterns.join('|')})`, 'gi');
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

    const card = document.createElement("div");
    card.className = `doc-card ${selectedDocIds.has(doc.id) ? 'selected' : ''} ${statusCardClass}`;
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

    let vignettesHtml = '';
    if (isSearch) {
      if (doc.vignettes && doc.vignettes.length > 0) {
        doc.vignettes.forEach(v => {
          vignettesHtml += `
            <div class="vignette-item" data-doc-id="${doc.id}" data-page="${v.page_number}" data-occ="${v.occ_id}" data-rect='${JSON.stringify((v.highlight_rects && v.highlight_rects.length > 0) ? v.highlight_rects[0] : (v.rect || []))}' data-yratio="${v.y_ratio || 0}" data-snippet="${encodeURIComponent(v.text_snippet || '')}" title="Page ${v.page_number}${v.font_size >= 14 ? ' (Titre)' : ''} - Cliquer pour ouvrir">
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
    } else {
      vignettesHtml = `
        <div style="display:flex; align-items:center; height:100%; color:var(--text-dim); font-size:12.5px;">
          Tapez un mot-clé ci-dessus pour afficher les extraits cropés avec surbrillance.
        </div>
      `;
    }

    const query = searchInput ? searchInput.value.trim() : "";
    const displayTitle = (isSearch && query) 
      ? highlightTitle(doc.title, query) 
      : escapeHtml(doc.title);

    card.innerHTML = `
      <div class="doc-card-header">
        <div style="display: flex; align-items: center; gap: 8px; overflow: hidden; flex: 1;">
          <input type="checkbox" class="doc-selection-checkbox" data-id="${doc.id}" ${selectedDocIds.has(doc.id) ? 'checked' : ''} title="Sélectionner ce document" />
          <div class="doc-title-main" title="${escapeHtml(doc.title)}">${displayTitle}</div>
        </div>
        <div class="doc-meta-badges">
          ${doc.is_top_result ? `<span class="doc-badge-pill top-badge" title="Score de pertinence le plus élevé">★ Plus pertinent</span>` : ''}
          ${isSearch ? `<span class="doc-badge-pill highlight">${doc.total_occurrences} occ.</span>` : ''}
          ${isIndexing ? `<span class="doc-badge-pill" style="background:rgba(37,99,235,0.1); color:var(--accent);">${doc.status === 'indexing' ? '⏳ Indexation...' : '⌛ En attente'}</span>` : `<span class="doc-badge-pill">${doc.total_pages} p.</span>`}
          
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

    // Clic case à cocher de sélection tactile
    const checkbox = card.querySelector(".doc-selection-checkbox");
    if (checkbox) {
      checkbox.addEventListener("click", (e) => {
        e.stopPropagation();
        if (selectedDocIds.has(doc.id)) {
          selectedDocIds.delete(doc.id);
        } else {
          selectedDocIds.add(doc.id);
        }
        lastSelectedDocId = doc.id;
        updateSelectionUI();
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
        let rect = null;
        try { rect = JSON.parse(vEl.getAttribute("data-rect") || "[]"); } catch(e) {}
        openDocumentInSplitView(doc.id, doc.title, dPage, doc.occurrences_by_page || doc.vignettes || [], rect, yRatio);
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
            const fetchUrl = `/api/doc-search?doc_id=${doc.id}&q=${encodeURIComponent(currentSearchQuery || '')}&offset=${loadedCount}&limit=${CHUNK_SIZE}`;
            const res = await fetch(fetchUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const newOccs = data.occurrences || [];

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
              vEl.setAttribute("data-rect", JSON.stringify((v.highlight_rects && v.highlight_rects.length > 0) ? v.highlight_rects[0] : (v.rect || [])));
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
        showToast(`Impossible d'ouvrir ce document : ${doc.error_message || 'Échec lors de l\'indexation'}`, "danger");
        return;
      }
      const firstOcc = (doc.occurrences_by_page && doc.occurrences_by_page.length > 0) ? doc.occurrences_by_page[0] : null;
      const firstPage = firstOcc ? firstOcc.page_number : 1;
      const firstRect = firstOcc ? ((firstOcc.highlight_rects && firstOcc.highlight_rects.length > 0) ? firstOcc.highlight_rects[0] : firstOcc.rect) : null;
      const yRatio = firstOcc ? firstOcc.y_ratio : 0;
      openDocumentInSplitView(doc.id, doc.title, firstPage, doc.occurrences_by_page || doc.vignettes || [], firstRect, yRatio);
    };

    card.querySelector(".doc-cover-wrapper").addEventListener("click", openDocAction);
    card.querySelector(".doc-title-main").addEventListener("click", openDocAction);

    return card;
  }

  // =========================================================================
  // Recherche avec Filtres (Titres & Dossier)
  // =========================================================================
  async function performSearch(query) {
    if (!query) {
      loadFoldersAndDocuments();
      return;
    }

    currentSearchQuery = query;
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
    resultsContainer.innerHTML = `<div style="padding: 16px; color: var(--text-muted);">Recherche en cours...</div>`;

    try {
      let url = `/api/search?q=${encodeURIComponent(query)}&limit=15&offset=0`;
      if (isTitlesOnly) url += `&titles_only=true`;
      if (isFolderOnly) url += `&folder_id=${currentFolderId}`;

      const res = await fetch(url);
      const data = await res.json();
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
      resultsContainer.innerHTML = `<div style="padding: 16px; color: var(--danger);">Erreur lors de la recherche.</div>`;
    }
  }

  let searchPaginationObserver = null;
  let isFetchingNextSearchPage = false;

  async function fetchNextSearchPage() {
    if (isFetchingNextSearchPage || !lastSearchResultsData || !lastSearchResultsData.has_more) return;
    isFetchingNextSearchPage = true;

    const query = currentSearchQuery;
    const isTitlesOnly = filterTitlesOnly.checked;
    const isFolderOnly = filterCurrentFolderOnly.checked && currentFolderId !== null;
    const offset = currentLoadedDocs.length;

    try {
      let url = `/api/search?q=${encodeURIComponent(query)}&limit=15&offset=${offset}`;
      if (isTitlesOnly) url += `&titles_only=true`;
      if (isFolderOnly) url += `&folder_id=${currentFolderId}`;

      const res = await fetch(url);
      const data = await res.json();
      if (data && data.results && data.results.length > 0) {
        lastSearchResultsData.has_more = data.has_more;
        lastSearchResultsData.results = (lastSearchResultsData.results || []).concat(data.results);
        appendSearchResults(data);
      } else {
        lastSearchResultsData.has_more = false;
        const sentinel = document.getElementById("search-scroll-sentinel");
        if (sentinel) sentinel.remove();
      }
    } catch (err) {
      console.error("Erreur chargement page suivante recherche:", err);
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
    btnElement.classList.add("spinning");
    btnElement.disabled = true;

    try {
      const res = await fetch(`/api/documents/${docId}/reindex`, { method: "POST" });
      if (!res.ok) throw new Error("Échec de la réindexation");
      showToast(`"${docTitle}" réindexé avec succès !`, "success");
      
      if (currentSearchQuery) {
        performSearch(currentSearchQuery);
      } else {
        loadFoldersAndDocuments();
      }
    } catch (err) {
      console.error(err);
      showToast(`Erreur lors de la réindexation de "${docTitle}"`, "error");
    } finally {
      btnElement.classList.remove("spinning");
      btnElement.disabled = false;
    }
  }

  // =========================================================================
  // Synchronisation Automatique / Scan
  // =========================================================================
  syncDocsBtn.addEventListener("click", async () => {
    syncDocsBtn.disabled = true;
    syncDocsBtn.querySelector("svg").style.animation = "spin 1s linear infinite";

    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      
      if (data.added > 0) {
        showToast(`${data.added} nouveau(x) document(s) détecté(s) et indexé(s) !`, "success", 4500);
      } else {
        showToast("Tous les documents PDF sont déjà synchronisés.", "info");
      }

      loadFoldersAndDocuments();
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
      showToast(`${count} document${count > 1 ? 's' : ''} déplacé${count > 1 ? 's' : ''} dans "${folderName}"`, "success");
      clearSelection();

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
  // Sauvegarde Légère des Annotations & Surlignages (Économe en bande passante)
  // =========================================================================
  async function saveAnnotationsToServer(showFeedback = true) {
    if (!currentActiveDocId) {
      if (showFeedback) showToast("Aucun document ouvert dans le visualiseur.", "info");
      return;
    }

    const btn = saveAnnotationsBtn;
    const span = btn ? btn.querySelector("span") : null;
    const origText = span ? span.textContent : "Sauvegarder";

    try {
      if (btn) {
        btn.disabled = true;
        if (span) span.textContent = "Sauvegarde...";
      }

      const win = pdfFrame ? pdfFrame.contentWindow : null;
      if (!win) {
        if (showFeedback) showToast("Le visualiseur PDF n'est pas accessible.", "warning");
        return;
      }

      const app = win.PDFViewerApplication;
      if (!app) {
        if (showFeedback) showToast("Le lecteur PDF n'est pas encore prêt.", "warning");
        return;
      }

      // 1. Déclencher le hook willSave pour forcer les éditeurs en cours (surlignage, texte, dessin) à commiter
      try {
        if (app.pdfScriptingManager && typeof app.pdfScriptingManager.dispatchWillSave === "function") {
          await app.pdfScriptingManager.dispatchWillSave();
        }
      } catch (e) {
        console.warn("[Annotations] dispatchWillSave warning:", e);
      }

      const doc = app.pdfDocument;
      if (!doc) {
        if (showFeedback) showToast("Le document PDF n'est pas encore complètement chargé.", "warning");
        return;
      }

      // 2. Générer les octets du PDF mis à jour avec les annotations directement cuites par PDF.js
      let pdfBytes;
      try {
        if (typeof doc.saveDocument === "function") {
          pdfBytes = await doc.saveDocument();
        } else if (typeof doc.getData === "function") {
          pdfBytes = await doc.getData();
        }
      } catch (e) {
        console.warn("[Annotations] saveDocument fallback to getData:", e);
        if (typeof doc.getData === "function") {
          pdfBytes = await doc.getData();
        }
      }

      if (!pdfBytes || pdfBytes.length === 0) {
        throw new Error("Impossible d'extraire les données du document PDF.");
      }

      // 3. Envoyer directement le fichier PDF sauvegardé au serveur (/api/documents/{id}/save-pdf)
      const response = await fetch(`/api/documents/${currentActiveDocId}/save-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: pdfBytes
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || `Erreur serveur HTTP ${response.status}`);
      }

      // 4. Récupérer et sauvegarder également le JSON d'annotations pour SQLite
      const storage = doc.annotationStorage;
      let annots = [];
      if (storage) {
        try {
          const ser = storage.serializable;
          if (ser && ser.map) {
            const m = ser.map;
            if (typeof m.values === "function") {
              for (const val of m.values()) {
                if (val && !val.deleted) annots.push(val);
              }
            } else if (typeof m.forEach === "function") {
              m.forEach(val => {
                if (val && !val.deleted) annots.push(val);
              });
            } else if (typeof m === "object") {
              for (const k in m) {
                if (m[k] && !m[k].deleted) annots.push(m[k]);
              }
            }
          }
        } catch (e) {
          console.warn("[Annotations] Erreur extraction JSON:", e);
        }

        fetch(`/api/documents/${currentActiveDocId}/annotations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ annotations: annots })
        }).catch(e => console.warn("[Annotations] Sync JSON optionnelle:", e));

        if (typeof storage.resetModified === "function") {
          storage.resetModified();
        }
      }
      if (app) delete app._annotationStorageModified;

      // Invalider le cache du navigateur pour ce PDF spécifique afin de recharger la version modifiée
      if ("caches" in window) {
        caches.open("docseeker-pdf-v1").then(cache => {
          cache.delete(`/api/pdf/${currentActiveDocId}`);
        }).catch(() => {});
      }
      if (window.pdfCacheManager) {
        window.pdfCacheManager.invalidate(currentActiveDocId).catch(() => {});
      }

      // Mettre à jour updated_at localement
      const docItem = currentLoadedDocs.find(d => d.id === currentActiveDocId);
      if (docItem) {
        docItem.updated_at = new Date().toISOString();
      }

      if (btn) {
        btn.style.backgroundColor = "#059669";
        btn.style.borderColor = "#047857";
        if (span) span.textContent = "Enregistré ✓";
      }

      if (showFeedback) {
        showToast("✓ Modifications enregistrées avec succès dans le PDF !", "success", 4000);
      }

    } catch (err) {
      console.error("[Annotations] Erreur saveAnnotationsToServer:", err);
      if (btn) {
        btn.style.backgroundColor = "#dc2626";
        btn.style.borderColor = "#b91c1c";
        if (span) span.textContent = "Erreur !";
      }
      if (showFeedback) {
        showToast("Erreur lors de l'enregistrement : " + err.message, "error");
      }
      setTimeout(() => {
        if (btn) {
          btn.style.backgroundColor = "";
          btn.style.borderColor = "";
          if (span) span.textContent = origText;
        }
      }, 3000);
    } finally {
      if (btn) {
        btn.disabled = false;
        if (span && span.textContent === "Sauvegarde...") {
          span.textContent = origText;
        }
      }
    }
  }

  // Exposer pour les appels directs depuis l'iframe PDF.js
  window.saveAnnotationsToServer = saveAnnotationsToServer;

  function resetSaveButtonState() {
    if (saveAnnotationsBtn) {
      saveAnnotationsBtn.style.backgroundColor = "";
      saveAnnotationsBtn.style.borderColor = "";
      const span = saveAnnotationsBtn.querySelector("span");
      if (span) span.textContent = "Sauvegarder";
    }
  }

  function markAnnotationsUnsaved() {
    if (saveAnnotationsBtn) {
      saveAnnotationsBtn.style.backgroundColor = "";
      saveAnnotationsBtn.style.borderColor = "";
      const span = saveAnnotationsBtn.querySelector("span");
      if (span && span.textContent !== "Sauvegarder *") {
        span.textContent = "Sauvegarder *";
      }
    }
  }

  function hookAnnotationStorageModified() {
    try {
      const win = pdfFrame ? pdfFrame.contentWindow : null;
      if (!win) return;
      const app = win.PDFViewerApplication;
      if (!app || !app.pdfDocument) return;
      const storage = app.pdfDocument.annotationStorage;
      if (storage) {
        storage.onSetModified = () => {
          markAnnotationsUnsaved();
        };
      }
    } catch (e) {
      console.warn("[Hook Modified]", e);
    }
  }

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
  // Split View & Lecteur PDF
  // =========================================================================
  function openDocumentInSplitView(docId, docTitle, targetPage, occurrences, targetRect = null, targetYRatio = 0) {
    const numericDocId = Number(docId);
    const isSameDoc = (Number(currentActiveDocId) === numericDocId);
    if (!isSameDoc && currentActiveDocId && window.pdfCacheManager) {
      window.pdfCacheManager.pauseDownload(currentActiveDocId);
    }
    currentActiveDocId = numericDocId;
    currentActiveDocTitle = docTitle;
    currentDocOriginalOccurrences = occurrences;

    resetSaveButtonState();
    // Le streaming HTTP 206 et le cache natif HTTP du navigateur gèrent le chargement et la mise en cache de manière optimale sans collision réseau.

    // Support de l'historique de navigation pour le bouton retour mobile
    if (!workspace.classList.contains("split-active")) {
      window.history.pushState({ view: "split" }, "");
    }

    workspace.classList.add("split-active");
    document.documentElement.classList.add("doc-open");
    document.body.classList.add("doc-open");
    const appEl = document.getElementById("app");
    if (appEl) appEl.classList.add("doc-open");
    setDocumentZoomLock(true);

    // Réinitialiser / synchroniser la recherche interne
    syncDocSearchInputs(currentSearchQuery || "");
    if (viewerDocSearchWrapper) viewerDocSearchWrapper.style.display = "none";
    if (viewerDocSearchResultCount) {
      viewerDocSearchResultCount.textContent = currentSearchQuery ? `${occurrences.length} résultat${occurrences.length > 1 ? 's' : ''}` : "";
    }

    currentActiveOccurrences = occurrences || [];
    let initialIdx = 0;
    if (targetPage && occurrences && occurrences.length > 0) {
      const foundIdx = occurrences.findIndex(o => o.page_number === targetPage);
      if (foundIdx !== -1) initialIdx = foundIdx;
    }
    currentActiveOccurrenceIndex = currentActiveOccurrences.length > 0 ? initialIdx : -1;
    updateOccurrenceStepperUI();

    if (resultsPane && generalView && generalView.style.display !== "none") {
      savedGeneralResultsScrollTop = resultsPane.scrollTop;
    }

    generalView.style.display = "none";
    docDetailView.style.display = "block";
    if (resultsPane) {
      resultsPane.scrollTop = 0;
    }
    docDetailTitle.textContent = docTitle;
    docDetailCount.textContent = `${occurrences.length} occurrence${occurrences.length > 1 ? 's' : ''} dans ce document`;

    renderVerticalOccurrences(numericDocId, docTitle, occurrences, targetPage);

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
    renderDrawerOccurrences(numericDocId, docTitle, occurrences, targetPage);

    // Si ouvert depuis une recherche globale, charger en tâche de fond l'intégralité des occurrences du document
    // pour un parcours séquentiel complet (stepper et tiroir) sans bloquer l'affichage immédiat
    if (currentSearchQuery && (!occurrences || occurrences.length >= 25)) {
      const activeQuery = currentSearchQuery;
      fetch(`/api/doc-search?doc_id=${numericDocId}&q=${encodeURIComponent(activeQuery)}`)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(data => {
          if (currentActiveDocId !== numericDocId || currentSearchQuery !== activeQuery) return;
          const fullOccs = data.occurrences || [];
          if (fullOccs.length > 0 && (!occurrences || fullOccs.length !== occurrences.length)) {
            currentDocOriginalOccurrences = fullOccs;
            currentActiveOccurrences = fullOccs;
            const curPage = getCurrentViewerPage() || targetPage;
            currentActiveOccurrenceIndex = findClosestOccurrenceIndex(fullOccs, curPage);
            updateOccurrenceStepperUI();
            const countLabel = `${fullOccs.length} occurrence${fullOccs.length > 1 ? 's' : ''} dans ce document`;
            const pillLabel = `${fullOccs.length} extrait${fullOccs.length > 1 ? 's' : ''}`;
            if (docDetailCount) docDetailCount.textContent = countLabel;
            if (viewerDocSearchResultCount) viewerDocSearchResultCount.textContent = `${fullOccs.length} résultat${fullOccs.length > 1 ? 's' : ''}`;
            if (mobileOccurrencesCountText) mobileOccurrencesCountText.textContent = pillLabel;
            if (drawerDocCount) drawerDocCount.textContent = pillLabel;
            renderVerticalOccurrences(numericDocId, docTitle, fullOccs, curPage);
            renderDrawerOccurrences(numericDocId, docTitle, fullOccs, curPage);
          }
        })
        .catch(err => console.warn("Erreur chargement occurrences complètes document:", err));
    }

    viewerDocTitle.textContent = docTitle;
    viewerPageBadge.textContent = `Page ${targetPage}`;

    const viewerCacheBadge = document.getElementById("viewerCacheBadge");
    const updateCacheUI = (status, progress, downloadedBytes = 0, totalBytes = 0) => {
      if (!viewerCacheBadge) return;
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
      } else if (status === "downloading" && progress > 0) {
        viewerCacheBadge.style.display = "inline-flex";
        viewerCacheBadge.className = "viewer-doc-badge viewer-cache-badge downloading";
        const mbDl = downloadedBytes > 0 ? (downloadedBytes / (1024 * 1024)).toFixed(1) : null;
        const mbTot = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(0) : null;
        if (mbDl && mbTot) {
          viewerCacheBadge.textContent = `📥 ${progress}% (${mbDl}/${mbTot} Mo)`;
          viewerCacheBadge.title = `Mise en cache hors-ligne : ${mbDl} Mo sur ${mbTot} Mo (${progress}%) - Lecture fluide disponible`;
        } else {
          viewerCacheBadge.textContent = `📥 ${progress}%`;
          viewerCacheBadge.title = `Mise en cache hors-ligne : ${progress}% - Lecture fluide disponible`;
        }
      } else if (status === "error") {
        viewerCacheBadge.style.display = "inline-flex";
        viewerCacheBadge.className = "viewer-doc-badge viewer-cache-badge paused";
        viewerCacheBadge.textContent = "⚠️ Erreur (Cliquer pour réparer)";
        viewerCacheBadge.title = "Une erreur est survenue lors du chargement. Cliquez pour vider le cache et recharger.";
      } else {
        viewerCacheBadge.style.display = "none";
      }

      // Synchronisation directe avec la barre de progression bleue dans le lecteur PDF.js
      try {
        const win = pdfFrame.contentWindow;
        if (win && win.PDFViewerApplication && typeof win.PDFViewerApplication.setDownloadProgress === "function") {
          win.PDFViewerApplication.setDownloadProgress(status, progress);
        }
      } catch (e) {}
    };

    if (viewerCacheBadge && !viewerCacheBadge._hasClickHandler) {
      viewerCacheBadge._hasClickHandler = true;
      viewerCacheBadge.style.cursor = "pointer";
      viewerCacheBadge.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentActiveDocId) return;
        if (confirm("Voulez-vous réinitialiser le cache local pour ce document et le recharger ?")) {
          if (window.pdfCacheManager) {
            await window.pdfCacheManager.invalidate(currentActiveDocId);
          }
          updateCacheUI("none", 0);
          pdfFrame.src = `/pdfjs/web/viewer.html?v=5.2&file=/api/pdf/${currentActiveDocId}#page=${getCurrentViewerPage() || 1}&_nocache=${Date.now()}`;
        }
      });
    }

    if (window.pdfCacheManager) {
      window.pdfCacheManager.onProgress(numericDocId, (info) => {
        if (Number(currentActiveDocId) === numericDocId) {
          updateCacheUI(info.status, info.progress, info.downloadedBytes, info.totalBytes);
        }
      });
    }

    // Écouteur global des messages de progression émis par le visualiseur PDF.js
    if (!window._pdfViewerMessageListenerAttached) {
      window._pdfViewerMessageListenerAttached = true;
      window.addEventListener("message", (evt) => {
        if (!evt.data) return;
        if (evt.data.type === "docseeker_pdf_progress") {
          const { loaded, total, percent } = evt.data;
          if (window.pdfCacheManager && currentActiveDocId) {
            window.pdfCacheManager.updateProgressFromViewer(currentActiveDocId, loaded, total);
          }
          updateCacheUI(percent >= 100 ? "complete" : "downloading", percent, loaded, total);
        } else if (evt.data.type === "docseeker_pdf_complete") {
          const { length } = evt.data;
          if (window.pdfCacheManager && currentActiveDocId) {
            window.pdfCacheManager.markComplete(currentActiveDocId, length);
          }
          updateCacheUI("complete", 100, length, length);
        }
      });
    }

    if (isSameDoc && pdfFrame.contentWindow && pdfFrame.contentWindow.PDFViewerApplication) {
      goToPageAndScrollToOccurrence(targetPage, targetRect, targetYRatio);
      hookAnnotationStorageModified();
      hookIframePinchZoomIsolation();
    } else {
      (async () => {
        let pdfTargetUrl = `/api/pdf/${numericDocId}`;

        if (window.pdfCacheManager) {
          const complete = await window.pdfCacheManager.isComplete(numericDocId);
          if (complete) {
            updateCacheUI("complete", 100);
          } else {
            window.pdfCacheManager.getProgress(numericDocId).then(p => {
              if (Number(currentActiveDocId) === numericDocId) {
                updateCacheUI(p.status, p.progress, p.downloadedBytes, p.totalBytes);
              }
            }).catch(() => {});
          }
        }

        let viewerUrl = `/pdfjs/web/viewer.html?v=5.2&file=${encodeURI(pdfTargetUrl)}#page=${targetPage}`;
        if (currentSearchQuery) {
          viewerUrl += `&search=${encodeURIComponent(currentSearchQuery)}`;
        }

        const win = pdfFrame.contentWindow;
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
          } catch (e) {}

          try {
            const app = win.PDFViewerApplication;

            const onDocReady = () => {
              try {
                if (app.page !== targetPage) {
                  app.page = targetPage;
                }
              } catch (e) {}
              setTimeout(() => {
                goToPageAndScrollToOccurrence(targetPage, targetRect, targetYRatio);
                hookAnnotationStorageModified();
                hookIframePinchZoomIsolation();
              }, 60);
            };

            if (app.eventBus) {
              app.eventBus._on("pagesinit", onDocReady, { once: true });
            }

            await app.open({ url: pdfTargetUrl });

            // Sécurité si pagesinit s'est déjà produit ou pour assurer le cadrage exact
            setTimeout(() => {
              if (app.page !== targetPage) {
                try { app.page = targetPage; } catch (e) {}
              }
              goToPageAndScrollToOccurrence(targetPage, targetRect, targetYRatio);
              hookAnnotationStorageModified();
              hookIframePinchZoomIsolation();
            }, 180);

            return;
          } catch (warmErr) {
            console.warn("[DocSeeker] Réouverture à chaud échouée, repli vers rechargement complet :", warmErr);
          }
        }

        // Micro-différé de 120ms : garantit que les 3-4 vignettes visibles
        // occupent les slots réseau du navigateur en priorité avant le chargement lourd du PDF
        setTimeout(() => {
          pdfFrame.src = viewerUrl;
          pdfFrame.onload = () => {
            hookIframePinchZoomIsolation();

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
              goToPageAndScrollToOccurrence(targetPage, targetRect, targetYRatio);
              hookAnnotationStorageModified();
              hookIframePinchZoomIsolation();
            }, 400);
          };
        }, 120);
      })();
    }
  }

  function renderVerticalOccurrences(docId, docTitle, occurrences, activePage) {
    verticalCropManager.clear();
    docOccurrencesList.innerHTML = "";

    if (!occurrences || occurrences.length === 0) {
      docOccurrencesList.innerHTML = `<div style="color:var(--text-muted); font-size:12.5px; padding:10px;">Aucun extrait trouvé pour ce terme dans ce document.</div>`;
      return;
    }

    const placeholderSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='120'%3E%3Crect width='100%25' height='100%25' fill='%23f1f5f9'/%3E%3C/svg%3E";

    occurrences.forEach((occ, index) => {
      const card = document.createElement("div");
      const isActive = (occ.page_number === activePage);
      card.className = `vertical-occ-card ${isActive ? 'active' : ''}`;
      card.setAttribute("data-page", occ.page_number);
      card.setAttribute("data-occ-id", occ.occ_id);

      card.innerHTML = `
        <div class="vertical-occ-img-wrapper">
          <img src="${placeholderSvg}" data-src="${occ.crop_url}" class="vertical-occ-img dynamic-crop" alt="Extrait p. ${occ.page_number}" style="opacity: 0.6; transition: opacity 0.2s ease-in-out;" />
        </div>
        <div class="vertical-occ-footer">
          <span class="vertical-occ-page">Page ${occ.page_number}</span>
          <span class="vertical-occ-snippet" title="${escapeHtml(occ.text_snippet || '')}">${currentSearchQuery ? highlightTitle(occ.text_snippet || '', currentSearchQuery) : escapeHtml(occ.text_snippet || '')}</span>
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
    });

    const activeCard = docOccurrencesList.querySelector(".vertical-occ-card.active");
    if (activeCard) {
      activeCard.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function goToPageAndScrollToOccurrence(pageNumber, rect = null, yRatio = 0.0) {
    try {
      const win = pdfFrame.contentWindow;
      if (!win) return;

      const app = win.PDFViewerApplication;
      if (app && app.pdfViewer) {
        const docViewer = win.document;
        const container = docViewer.getElementById("viewerContainer");

        if (app.page !== pageNumber) {
          app.page = pageNumber;
        }

        const alignOccurrence = () => {
          const pageDiv = docViewer.querySelector(`.page[data-page-number="${pageNumber}"]`);
          if (!pageDiv || !container) return;

          docViewer.querySelectorAll(".active-occ-overlay").forEach(el => el.remove());

          // Vérifier si une recherche active est en cours
          const hasActiveSearch = Boolean(
            (currentSearchQuery && currentSearchQuery.trim()) ||
            (docSearchInput && docSearchInput.value.trim())
          );

          // Si pas de recherche ou pas de coordonnées valides : NE PAS afficher de cadre bleu
          if (!hasActiveSearch || !rect || !Array.isArray(rect) || rect.length !== 4) {
            if (yRatio && yRatio > 0) {
              const top = pageDiv.clientHeight * yRatio;
              const targetScrollTop = pageDiv.offsetTop + top - (container.clientHeight / 2);
              container.scrollTo({
                top: Math.max(0, targetScrollTop),
                behavior: "smooth"
              });
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

          const targetScrollTop = pageDiv.offsetTop + top - (container.clientHeight / 2) + (height / 2);
          container.scrollTo({
            top: Math.max(0, targetScrollTop),
            behavior: "smooth"
          });
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
          errors.push({ file: file.name, error: errorData.detail || "Erreur serveur" });
          continue;
        }

        successCount++;
        uploadProgressBar.style.width = `${Math.round(((i + 1) / total) * 100)}%`;
      } catch (err) {
        console.error(`Upload error for ${file.name}:`, err);
        errors.push({ file: file.name, error: err.message });
      }
    }

    uploadProgressBar.style.width = "100%";

    if (successCount > 0 && duplicates.length === 0 && errors.length === 0) {
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

  // Initialisation au chargement de l'application
  loadAppVersion();
  startPipelinePolling();
});

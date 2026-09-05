document.addEventListener("DOMContentLoaded", () => {
  // =========================================================================
  // Éléments DOM
  // =========================================================================
  const searchInput = document.getElementById("searchInput");
  const clearSearchBtn = document.getElementById("clearSearchBtn");
  const searchStats = document.getElementById("searchStats");
  const workspace = document.getElementById("workspace");
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
  let currentSortMode = "name_asc";
  let userManuallyChangedSort = false;

  // Observateur pour lazy-loading horizontal des extraits cropés
  const cropObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          delete img.dataset.src;
        }
        observer.unobserve(img);
      }
    });
  }, {
    rootMargin: "80px 200px" // Pré-chargement fluide avant entrée dans le viewport
  });

  // Sélection multiple & Presse-papier
  let selectedDocIds = new Set();
  let lastSelectedDocId = null;
  let clipboardDocIds = [];

  // Initialisation du nuancier dans la modale dossier
  initColorPalette();

  // Chargement initial
  loadFoldersAndDocuments();

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

    toast.innerHTML = `${iconSvg}<span>${message}</span>`;
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
      if (selectedDocIds.has(docId)) {
        card.classList.add("selected");
      } else {
        card.classList.remove("selected");
      }
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
      for (const id of idsToDelete) {
        await fetch(`/api/documents/${id}`, { method: "DELETE" });
      }
      showToast(`${count} document(s) supprimé(s).`, "info");
      loadFoldersAndDocuments();
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
    } else if (isCmdOrCtrl && e.key.toLowerCase() === "a") {
      // Tout sélectionner dans la vue actuelle
      if (currentLoadedDocs.length > 0) {
        e.preventDefault();
        currentLoadedDocs.forEach(d => selectedDocIds.add(d.id));
        updateSelectionUI();
      }
    } else if (e.key === "Escape") {
      if (selectedDocIds.size > 0) {
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

    // Filtre visuel instantané à 0ms sur les titres déjà affichés
    if (val && resultsContainer.children.length > 0 && !currentSearchQuery) {
      const lower = val.toLowerCase();
      document.querySelectorAll(".doc-card").forEach(card => {
        const title = (card.querySelector(".doc-title-main")?.getAttribute("title") || "").toLowerCase();
        card.style.opacity = title.includes(lower) ? "1" : "0.35";
      });
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      document.querySelectorAll(".doc-card").forEach(card => card.style.opacity = "1");
      performSearch(val);
    }, 250);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(debounceTimer);
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
      if (currentSearchQuery && lastSearchResultsData) {
        renderSearchResults(lastSearchResultsData);
      } else {
        renderFolders(allFolders);
        renderDocumentLibrary(rawLoadedDocs);
      }
    });
  }

  async function closeSplitViewer() {
    await saveAnnotationsToServer(false);
    workspace.classList.remove("split-active");
    pdfFrame.src = "about:blank";
    currentActiveDocId = null;
    showGeneralResultsView();
  }

  function showGeneralResultsView() {
    docDetailView.style.display = "none";
    generalView.style.display = "block";
    document.querySelectorAll(".vignette-item.active").forEach(el => el.classList.remove("active"));
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
  // Recherche Interne au Document (Split View)
  // =========================================================================
  docSearchInput.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    clearDocSearchBtn.style.display = val ? "flex" : "none";
    clearTimeout(docSearchDebounceTimer);
    docSearchDebounceTimer = setTimeout(() => {
      performDocSearch(val);
    }, 250);
  });

  clearDocSearchBtn.addEventListener("click", () => {
    docSearchInput.value = "";
    clearDocSearchBtn.style.display = "none";
    docDetailCount.textContent = `${currentDocOriginalOccurrences.length} occurrence${currentDocOriginalOccurrences.length > 1 ? 's' : ''} dans ce document`;
    renderVerticalOccurrences(currentActiveDocId, currentActiveDocTitle, currentDocOriginalOccurrences);
    updateViewerSearchHighlight(currentSearchQuery);
  });

  async function performDocSearch(query) {
    if (!query) {
      docDetailCount.textContent = `${currentDocOriginalOccurrences.length} occurrence${currentDocOriginalOccurrences.length > 1 ? 's' : ''} dans ce document`;
      renderVerticalOccurrences(currentActiveDocId, currentActiveDocTitle, currentDocOriginalOccurrences);
      updateViewerSearchHighlight(currentSearchQuery);
      return;
    }

    try {
      const res = await fetch(`/api/doc-search?doc_id=${currentActiveDocId}&q=${encodeURIComponent(query)}`);
      const data = await res.json();
      const occs = data.occurrences || [];

      docDetailCount.textContent = `${occs.length} résultat${occs.length > 1 ? 's' : ''} pour "${query}"`;
      renderVerticalOccurrences(currentActiveDocId, currentActiveDocTitle, occs);
      updateViewerSearchHighlight(query);

      if (occs.length > 0) {
        goToPageAndScrollToOccurrence(occs[0].page_number, occs[0].rect, occs[0].y_ratio);
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
          query: query || '',
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
          <div class="folder-name" title="${folder.name}">${folder.name}</div>
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
        copy.sort((a, b) => (b.total_occurrences || 0) - (a.total_occurrences || 0));
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
        relOpt.textContent = "Pertinence (Occurrences)";
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
  }

  // =========================================================================
  // Affichage des Documents (Bibliothèque & Résultats)
  // =========================================================================
  function renderDocumentLibrary(docs) {
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

    const rawTerms = query.trim().split(/\s+/).filter(t => t.length >= 2);
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

    const regexParts = rawTerms.map(term => {
      const normalized = term.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return escaped.split('').map(ch => accentMap[ch] || `[${ch.toUpperCase()}${ch.toLowerCase()}]`).join('');
    });

    const pattern = new RegExp(`(${regexParts.join('|')})`, 'gi');
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
  }

  function createDocCardElement(doc, isSearch = false) {
    const card = document.createElement("div");
    card.className = `doc-card ${selectedDocIds.has(doc.id) ? 'selected' : ''}`;
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
            <div class="vignette-item" data-doc-id="${doc.id}" data-page="${v.page_number}" data-occ="${v.occ_id}" data-rect='${JSON.stringify(v.rect || [])}' data-yratio="${v.y_ratio || 0}" data-snippet="${encodeURIComponent(v.text_snippet || '')}" title="Page ${v.page_number} - Cliquer pour ouvrir">
              <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='250' height='125'%3E%3Crect width='100%25' height='100%25' fill='%23f1f5f9'/%3E%3C/svg%3E" data-src="${v.crop_url}" class="vignette-crop-img lazy-crop" alt="Extrait p. ${v.page_number}" loading="lazy" decoding="async" />
              <span class="vignette-page-badge">p. ${v.page_number}</span>
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
        <div class="doc-title-main" title="${escapeHtml(doc.title)}">${displayTitle}</div>
        <div class="doc-meta-badges">
          ${isSearch ? `<span class="doc-badge-pill highlight">${doc.total_occurrences} occ.</span>` : ''}
          <span class="doc-badge-pill">${doc.total_pages} p.</span>
          
          <button class="btn-reindex-doc" data-id="${doc.id}" title="Réindexer ce document">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <polyline points="23 4 23 10 17 10"></polyline>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
            </svg>
            Réindexer
          </button>

          <button class="btn-rename-doc" data-id="${doc.id}" title="Renommer ce document">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
            Renommer
          </button>

          <button class="btn-move-doc" data-id="${doc.id}" title="Déplacer vers un autre dossier">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            Déplacer
          </button>

          <button class="btn-delete-doc" data-id="${doc.id}" title="Supprimer ce document">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            Supprimer
          </button>
        </div>
      </div>
      <div class="doc-card-body">
        <div class="doc-cover-wrapper" title="Ouvrir le document">
          <img src="${doc.cover_url}" class="doc-cover-img" alt="Couverture" loading="lazy" onerror="this.src='/placeholder-cover.png'" />
        </div>
        <div class="doc-card-vignettes">
          <div class="vignettes-ribbon-container">
            ${vignettesHtml}
          </div>
        </div>
      </div>
    `;

    // Clics vignettes
    card.querySelectorAll(".vignette-item").forEach(vEl => {
      vEl.addEventListener("click", () => {
        const dPage = parseInt(vEl.getAttribute("data-page"), 10);
        const yRatio = parseFloat(vEl.getAttribute("data-yratio") || 0);
        let rect = null;
        try { rect = JSON.parse(vEl.getAttribute("data-rect") || "[]"); } catch(e) {}
        openDocumentInSplitView(doc.id, doc.title, dPage, doc.occurrences_by_page || doc.vignettes || [], rect, yRatio);
      });
    });

    // Observer pour le chargement paresseux horizontal
    card.querySelectorAll(".lazy-crop").forEach(img => cropObserver.observe(img));

    // Clics couverture et titre (double-clic ou clic si pas en sélection modale)
    const openDocAction = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (selectedDocIds.size > 0) return;
      const firstOcc = (doc.occurrences_by_page && doc.occurrences_by_page.length > 0) ? doc.occurrences_by_page[0] : null;
      const firstPage = firstOcc ? firstOcc.page_number : 1;
      const firstRect = firstOcc ? firstOcc.rect : null;
      const yRatio = firstOcc ? firstOcc.y_ratio : 0;
      openDocumentInSplitView(doc.id, doc.title, firstPage, doc.occurrences_by_page || doc.vignettes || [], firstRect, yRatio);
    };

    card.querySelector(".doc-cover-wrapper").addEventListener("click", openDocAction);
    card.querySelector(".doc-title-main").addEventListener("click", openDocAction);

    // Clic Réindexer
    const reindexBtn = card.querySelector(".btn-reindex-doc");
    reindexBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleReindexDocument(doc.id, doc.title, reindexBtn);
    });

    // Clic Renommer
    const renameBtn = card.querySelector(".btn-rename-doc");
    if (renameBtn) {
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openRenameModal(doc.id, doc.title);
      });
    }

    // Clic Déplacer
    const moveBtn = card.querySelector(".btn-move-doc");
    moveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openBatchMoveModal([doc.id]);
    });

    // Clic Supprimer
    const delBtn = card.querySelector(".btn-delete-doc");
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteDocument(doc.id, doc.title);
    });

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
    foldersSection.style.display = "none";
    showGeneralResultsView();

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
    resultsContainer.innerHTML = `<div style="padding: 16px; color: var(--text-muted);">Recherche en cours...</div>`;

    try {
      let url = `/api/search?q=${encodeURIComponent(query)}`;
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

      renderSearchResults(data);
    } catch (err) {
      console.error("Erreur recherche:", err);
      resultsContainer.innerHTML = `<div style="padding: 16px; color: var(--danger);">Erreur lors de la recherche.</div>`;
    }
  }

  function renderSearchResults(data) {
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
      const card = createDocCardElement(doc, true);
      resultsContainer.appendChild(card);
    });

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
      alert("Veuillez saisir un nom pour le dossier.");
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
          <span style="font-weight: 600;" title="${f.fullPath}">${f.name}</span>
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
    if (!docIdToRename) return;
    const newTitle = renameDocInput.value.trim();
    if (!newTitle) {
      showToast("Le titre ne peut pas être vide.", "warning");
      return;
    }

    try {
      if (confirmRenameDocBtn) confirmRenameDocBtn.disabled = true;

      const res = await fetch(`/api/documents/${docIdToRename}`, {
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

      // 1. Déclencher le hook willSave pour forcer les éditeurs en cours à commiter
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

      const storage = doc.annotationStorage;
      let annots = [];

      // 2. Extraction résiliente des annotations (support cross-realm iframe / parent)
      if (storage) {
        // A. Via serializable
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
          console.warn("[Annotations] Erreur serializable:", e);
        }

        // B. Si vide ou incomplet, essayer via getAll()
        if (annots.length === 0 && typeof storage.getAll === "function") {
          try {
            const allObj = storage.getAll();
            if (allObj && typeof allObj === "object") {
              for (const k in allObj) {
                const item = allObj[k];
                if (!item) continue;
                if (typeof item.serialize === "function") {
                  const s = item.serialize(false);
                  if (s && !s.deleted) annots.push(s);
                } else if (!item.deleted) {
                  annots.push(item);
                }
              }
            }
          } catch (e) {
            console.warn("[Annotations] Erreur getAll():", e);
          }
        }
      }

      console.log(`[Annotations] Annotations trouvées (${annots.length}):`, annots);

      if (annots.length === 0) {
        if (showFeedback) {
          showToast("Aucune nouvelle annotation ou surlignage à enregistrer.", "info");
        }
        return;
      }

      // Envoi du JSON ultra-léger (~1-2 Ko) au serveur
      const response = await fetch(`/api/documents/${currentActiveDocId}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: annots })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || `Erreur serveur HTTP ${response.status}`);
      }

      const resData = await response.json();
      const count = resData.count !== undefined ? resData.count : annots.length;

      // Mettre à jour updated_at localement
      const docItem = currentLoadedDocs.find(d => d.id === currentActiveDocId);
      if (docItem) {
        docItem.updated_at = new Date().toISOString();
      }

      if (showFeedback) {
        showToast(`${count} annotation(s) enregistrée(s) avec succès sur le serveur !`, "success");
      }

      // Feedback visuel sur le bouton
      if (span) span.textContent = "Enregistré ✓";
      setTimeout(() => {
        if (span) span.textContent = origText;
      }, 2200);

    } catch (err) {
      console.error("[Annotations] Erreur saveAnnotationsToServer:", err);
      if (showFeedback) {
        showToast("Erreur lors de l'enregistrement : " + err.message, "error");
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        if (span && span.textContent === "Sauvegarde...") {
          span.textContent = origText;
        }
      }
    }
  }

  // =========================================================================
  // Split View & Lecteur PDF
  // =========================================================================
  function openDocumentInSplitView(docId, docTitle, targetPage, occurrences, targetRect = null, targetYRatio = 0) {
    const isSameDoc = (currentActiveDocId === docId);
    currentActiveDocId = docId;
    currentActiveDocTitle = docTitle;
    currentDocOriginalOccurrences = occurrences;

    docSearchInput.value = "";
    clearDocSearchBtn.style.display = "none";

    workspace.classList.add("split-active");

    generalView.style.display = "none";
    docDetailView.style.display = "block";
    docDetailTitle.textContent = docTitle;
    docDetailCount.textContent = `${occurrences.length} occurrence${occurrences.length > 1 ? 's' : ''} dans ce document`;

    renderVerticalOccurrences(docId, docTitle, occurrences, targetPage);

    viewerDocTitle.textContent = docTitle;
    viewerPageBadge.textContent = `Page ${targetPage}`;

    if (isSameDoc && pdfFrame.contentWindow && pdfFrame.contentWindow.PDFViewerApplication) {
      goToPageAndScrollToOccurrence(targetPage, targetRect, targetYRatio);
    } else {
      const pdfStreamUrl = `/api/pdf/${docId}`;
      let viewerUrl = `/pdfjs/web/viewer.html?file=${encodeURIComponent(pdfStreamUrl)}#page=${targetPage}`;
      if (currentSearchQuery) {
        viewerUrl += `&search=${encodeURIComponent(currentSearchQuery)}`;
      }
      pdfFrame.src = viewerUrl;

      pdfFrame.onload = () => {
        setTimeout(() => {
          goToPageAndScrollToOccurrence(targetPage, targetRect, targetYRatio);
        }, 400);
      };
    }
  }

  function renderVerticalOccurrences(docId, docTitle, occurrences, activePage) {
    docOccurrencesList.innerHTML = "";

    if (!occurrences || occurrences.length === 0) {
      docOccurrencesList.innerHTML = `<div style="color:var(--text-muted); font-size:12.5px; padding:10px;">Aucun extrait trouvé pour ce terme dans ce document.</div>`;
      return;
    }

    occurrences.forEach((occ) => {
      const card = document.createElement("div");
      const isActive = (occ.page_number === activePage);
      card.className = `vertical-occ-card ${isActive ? 'active' : ''}`;
      card.setAttribute("data-page", occ.page_number);
      card.setAttribute("data-occ-id", occ.occ_id);

      card.innerHTML = `
        <div class="vertical-occ-img-wrapper">
          <img src="${occ.crop_url}" class="vertical-occ-img" alt="Extrait p. ${occ.page_number}" loading="lazy" />
        </div>
        <div class="vertical-occ-footer">
          <span class="vertical-occ-page">Page ${occ.page_number}</span>
          <span class="vertical-occ-snippet" title="${occ.text_snippet}">${occ.text_snippet || ''}</span>
        </div>
      `;

      card.addEventListener("click", () => {
        document.querySelectorAll(".vertical-occ-card.active").forEach(el => el.classList.remove("active"));
        card.classList.add("active");
        viewerPageBadge.textContent = `Page ${occ.page_number}`;
        goToPageAndScrollToOccurrence(occ.page_number, occ.rect, occ.y_ratio);
      });

      docOccurrencesList.appendChild(card);
    });
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

          let left = 20, top = 100, width = 120, height = 24;

          const pageView = (app.pdfViewer.getPageView && app.pdfViewer.getPageView(pageNumber - 1)) ? app.pdfViewer.getPageView(pageNumber - 1) : null;
          
          if (pageView && pageView.viewport && rect && rect.length === 4) {
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
          } else if (rect && rect.length === 4) {
            const scaleX = pageDiv.clientWidth / 595.0;
            const scaleY = pageDiv.clientHeight / 842.0;
            left = (rect[0] * scaleX) - 4;
            top = (rect[1] * scaleY) - 3;
            width = ((rect[2] - rect[0]) * scaleX) + 8;
            height = ((rect[3] - rect[1]) * scaleY) + 6;
          } else {
            top = (yRatio && yRatio > 0) ? (pageDiv.clientHeight * yRatio) : 100;
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
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleFileUpload(fileInput.files[0]);
    }
  });

  async function handleFileUpload(file) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      alert("Veuillez sélectionner un fichier PDF valide.");
      return;
    }

    uploadProgressContainer.style.display = "block";
    uploadProgressBar.style.width = "30%";
    uploadStatusText.textContent = "Téléversement et calcul d'empreinte SHA-256...";

    const formData = new FormData();
    formData.append("file", file);
    const customTitle = docTitleInput.value.trim();
    if (customTitle) {
      formData.append("title", customTitle);
    }
    if (currentFolderId) {
      formData.append("folder_id", currentFolderId);
    }

    try {
      uploadProgressBar.style.width = "60%";
      uploadStatusText.textContent = "Extraction du texte et indexation des mots...";

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData
      });

      if (res.status === 409) {
        const conflictData = await res.json();
        uploadModal.style.display = "none";
        
        const exist = conflictData.existing_doc || {};
        duplicateTitle.textContent = exist.title || "Document sans titre";
        duplicateFilename.textContent = exist.filename || file.name;
        duplicateDate.textContent = exist.created_at ? new Date(exist.created_at).toLocaleString("fr-FR") : "Date inconnue";
        duplicateModal.style.display = "flex";
        return;
      }

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.detail || "Erreur lors de l'import");
      }

      uploadProgressBar.style.width = "100%";
      uploadStatusText.textContent = "Indexation terminée avec succès !";

      setTimeout(() => {
        uploadModal.style.display = "none";
        showToast(`Document indexé avec succès !`, "success");
        if (currentSearchQuery) {
          performSearch(currentSearchQuery);
        } else {
          loadFoldersAndDocuments();
        }
      }, 500);

    } catch (err) {
      console.error("Upload error:", err);
      uploadStatusText.textContent = `Erreur : ${err.message}`;
      uploadProgressBar.style.backgroundColor = "var(--danger)";
    }
  }
});

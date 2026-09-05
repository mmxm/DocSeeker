document.addEventListener("DOMContentLoaded", () => {
  // Éléments DOM
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

  // Vues Déroulé Vertical Document
  const backToResultsBtn = document.getElementById("backToResultsBtn");
  const docDetailTitle = document.getElementById("docDetailTitle");
  const docDetailCount = document.getElementById("docDetailCount");
  const docOccurrencesList = document.getElementById("docOccurrencesList");

  // Visualiseur
  const viewerDocTitle = document.getElementById("viewerDocTitle");
  const viewerPageBadge = document.getElementById("viewerPageBadge");
  const pdfFrame = document.getElementById("pdfFrame");
  const closeViewerBtn = document.getElementById("closeViewerBtn");

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

  let debounceTimer = null;
  let currentSearchQuery = "";
  let currentResultsData = null;
  let currentActiveDocId = null;
  let currentActivePage = 1;

  // Charger la liste initiale
  loadRecentDocuments();

  // Recherche
  searchInput.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    clearSearchBtn.style.display = val ? "flex" : "none";
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      performSearch(val);
    }, 280);
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
    loadRecentDocuments();
  });

  brandBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearSearchBtn.style.display = "none";
    closeSplitViewer();
    loadRecentDocuments();
  });

  // Bouton retour aux résultats généraux
  backToResultsBtn.addEventListener("click", () => {
    showGeneralResultsView();
  });

  // Fermeture du lecteur latéral
  closeViewerBtn.addEventListener("click", () => {
    closeSplitViewer();
  });

  function closeSplitViewer() {
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

  // =========================================================================
  // Chargement des Documents Récents
  // =========================================================================
  async function loadRecentDocuments() {
    currentSearchQuery = "";
    currentResultsData = null;
    sectionTitle.textContent = "Documents disponibles";
    searchStats.textContent = "";
    showGeneralResultsView();

    try {
      const res = await fetch("/api/documents");
      const data = await res.json();
      renderDocumentLibrary(data.documents || []);
    } catch (err) {
      console.error("Erreur chargement documents:", err);
    }
  }

  function renderDocumentLibrary(docs) {
    resultsContainer.innerHTML = "";

    if (!docs || docs.length === 0) {
      emptyState.style.display = "flex";
      emptyMessage.textContent = "Aucun document indexé. Cliquez sur 'Importer PDF' pour commencer.";
      return;
    }

    emptyState.style.display = "none";

    docs.forEach(doc => {
      const card = document.createElement("div");
      card.className = "doc-card";
      card.innerHTML = `
        <div class="doc-card-info">
          <div class="doc-cover-wrapper" title="Ouvrir le document">
            <img src="${doc.cover_url}" class="doc-cover-img" alt="Couverture" loading="lazy" onerror="this.src='/placeholder-cover.png'" />
          </div>
          <div class="doc-meta">
            <div class="doc-title" title="${doc.title}">${doc.title}</div>
            <div class="doc-stats">${doc.total_pages} page${doc.total_pages > 1 ? 's' : ''}</div>
            <div class="doc-actions-inline">
              <button class="btn-delete-doc" data-id="${doc.id}" title="Supprimer ce document">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                Supprimer
              </button>
            </div>
          </div>
        </div>
        <div class="doc-card-vignettes">
          <div style="display:flex; align-items:center; height:100%; color:var(--text-dim); font-size:13px;">
            Tapez un mot-clé ci-dessus pour rechercher et voir les extraits cropés avec surbrillance.
          </div>
        </div>
      `;

      card.querySelector(".doc-cover-wrapper").addEventListener("click", () => {
        openDocumentInSplitView(doc.id, doc.title, 1, []);
      });
      card.querySelector(".doc-title").addEventListener("click", () => {
        openDocumentInSplitView(doc.id, doc.title, 1, []);
      });

      card.querySelector(".btn-delete-doc").addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDeleteDocument(doc.id, doc.title);
      });

      resultsContainer.appendChild(card);
    });
  }

  // =========================================================================
  // Exécution de la Recherche Goodnotes
  // =========================================================================
  async function performSearch(query) {
    if (!query) {
      loadRecentDocuments();
      return;
    }

    currentSearchQuery = query;
    sectionTitle.textContent = `Résultats pour "${query}"`;
    resultsContainer.innerHTML = `<div style="padding: 20px; color: var(--text-muted);">Recherche en cours...</div>`;
    showGeneralResultsView();

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      currentResultsData = data;
      renderSearchResults(data);
    } catch (err) {
      console.error("Erreur recherche:", err);
      resultsContainer.innerHTML = `<div style="padding: 20px; color: var(--danger);">Erreur lors de la recherche.</div>`;
    }
  }

  function renderSearchResults(data) {
    resultsContainer.innerHTML = "";
    const results = data.results || [];

    searchStats.textContent = `${data.total_occurrences} occurrence${data.total_occurrences > 1 ? 's' : ''} dans ${data.total_documents} document${data.total_documents > 1 ? 's' : ''}`;

    if (results.length === 0) {
      emptyState.style.display = "flex";
      emptyMessage.textContent = `Aucun résultat correspondant à "${data.query}". Vérifiez l'orthographe ou essayez d'autres termes.`;
      return;
    }

    emptyState.style.display = "none";

    results.forEach(doc => {
      const card = document.createElement("div");
      card.className = "doc-card";

      // Ruban horizontal : vignettes ordonnées avec les plus pertinentes à gauche
      let vignettesHtml = '';
      if (doc.vignettes && doc.vignettes.length > 0) {
        doc.vignettes.forEach(v => {
          vignettesHtml += `
            <div class="vignette-item" data-doc-id="${doc.id}" data-page="${v.page_number}" data-occ="${v.occ_id}" title="Page ${v.page_number} - Cliquer pour ouvrir">
              <img src="${v.crop_url}" class="vignette-crop-img" alt="Extrait p. ${v.page_number}" loading="lazy" />
              <span class="vignette-page-badge">p. ${v.page_number}</span>
            </div>
          `;
        });
      } else {
        vignettesHtml = `<div style="color:var(--text-dim); font-size:13px; align-self:center;">Aucun extrait visuel.</div>`;
      }

      card.innerHTML = `
        <div class="doc-card-info">
          <div class="doc-cover-wrapper" title="Ouvrir le document">
            <img src="${doc.cover_url}" class="doc-cover-img" alt="Couverture" loading="lazy" onerror="this.src='/placeholder-cover.png'" />
          </div>
          <div class="doc-meta">
            <div class="doc-title" title="${doc.title}">${doc.title}</div>
            <div class="doc-stats">${doc.total_occurrences} occurrence${doc.total_occurrences > 1 ? 's' : ''} • ${doc.total_pages} p.</div>
            <div class="doc-actions-inline">
              <button class="btn-delete-doc" data-id="${doc.id}" title="Supprimer ce document">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                Supprimer
              </button>
            </div>
          </div>
        </div>
        <div class="doc-card-vignettes">
          <div class="vignettes-ribbon-container">
            ${vignettesHtml}
          </div>
        </div>
      `;

      // Clics sur les vignettes du ruban horizontal
      card.querySelectorAll(".vignette-item").forEach(vEl => {
        vEl.addEventListener("click", () => {
          const dPage = parseInt(vEl.getAttribute("data-page"), 10);
          openDocumentInSplitView(doc.id, doc.title, dPage, doc.occurrences_by_page || doc.vignettes || []);
        });
      });

      // Clic sur la couverture
      card.querySelector(".doc-cover-wrapper").addEventListener("click", () => {
        const firstPage = (doc.occurrences_by_page && doc.occurrences_by_page.length > 0) ? doc.occurrences_by_page[0].page_number : 1;
        openDocumentInSplitView(doc.id, doc.title, firstPage, doc.occurrences_by_page || doc.vignettes || []);
      });

      // Clic sur le titre
      card.querySelector(".doc-title").addEventListener("click", () => {
        const firstPage = (doc.occurrences_by_page && doc.occurrences_by_page.length > 0) ? doc.occurrences_by_page[0].page_number : 1;
        openDocumentInSplitView(doc.id, doc.title, firstPage, doc.occurrences_by_page || doc.vignettes || []);
      });

      // Bouton supprimer
      card.querySelector(".btn-delete-doc").addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDeleteDocument(doc.id, doc.title);
      });

      resultsContainer.appendChild(card);
    });
  }

  // =========================================================================
  // Split View & Navigation Verticale par Document
  // =========================================================================
  function openDocumentInSplitView(docId, docTitle, targetPage, occurrences) {
    const isSameDoc = (currentActiveDocId === docId);
    currentActiveDocId = docId;
    currentActivePage = targetPage;

    // 1. Activer le layout Split View
    workspace.classList.add("split-active");

    // 2. Basculer la colonne gauche sur la vue verticale des occurrences du document
    generalView.style.display = "none";
    docDetailView.style.display = "block";
    docDetailTitle.textContent = docTitle;
    docDetailCount.textContent = `${occurrences.length} occurrence${occurrences.length > 1 ? 's' : ''} dans ce document`;

    renderVerticalOccurrences(docId, docTitle, occurrences, targetPage);

    // 3. Piloter le lecteur PDF
    viewerDocTitle.textContent = docTitle;
    viewerPageBadge.textContent = `Page ${targetPage}`;

    if (isSameDoc && pdfFrame.contentWindow && pdfFrame.contentWindow.PDFViewerApplication) {
      // MÊME DOCUMENT : Aucun rechargement d'iframe ! Changement de page instantané
      goToPageWithoutReload(targetPage);
    } else {
      // NOUVEAU DOCUMENT : Chargement initial de l'iframe
      const pdfStreamUrl = `/api/pdf/${docId}`;
      let viewerUrl = `/pdfjs/web/viewer.html?file=${encodeURIComponent(pdfStreamUrl)}#page=${targetPage}`;
      if (currentSearchQuery) {
        viewerUrl += `&search=${encodeURIComponent(currentSearchQuery)}`;
      }
      pdfFrame.src = viewerUrl;
    }
  }

  function renderVerticalOccurrences(docId, docTitle, occurrences, activePage) {
    docOccurrencesList.innerHTML = "";

    if (!occurrences || occurrences.length === 0) {
      docOccurrencesList.innerHTML = `<div style="color:var(--text-muted); font-size:13px; padding:12px;">Document ouvert (aucune occurrence de recherche spécifique).</div>`;
      return;
    }

    occurrences.forEach((occ, idx) => {
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
        currentActivePage = occ.page_number;
        goToPageWithoutReload(occ.page_number);
      });

      docOccurrencesList.appendChild(card);
    });
  }

  // Saut de page ultra-fluide sans rechargement de l'iframe
  function goToPageWithoutReload(pageNumber) {
    try {
      if (pdfFrame.contentWindow && pdfFrame.contentWindow.PDFViewerApplication) {
        const app = pdfFrame.contentWindow.PDFViewerApplication;
        if (app.pdfViewer) {
          app.page = pageNumber;
          // Synchroniser aussi la recherche si disponible
          if (currentSearchQuery && app.eventBus) {
            app.eventBus.dispatch('find', {
              type: '',
              query: currentSearchQuery,
              phraseSearch: true,
              caseSensitive: false,
              entireWord: false,
              highlightAll: true,
              findPrevious: false
            });
          }
          return;
        }
      }
    } catch (e) {
      console.warn("Accès PDFViewerApplication en direct:", e);
    }

    // Si l'application PDF.js n'était pas encore initialisée
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
        if (currentActiveDocId === docId) {
          closeSplitViewer();
        }
        if (currentSearchQuery) {
          performSearch(currentSearchQuery);
        } else {
          loadRecentDocuments();
        }
      } else {
        alert("Erreur lors de la suppression du document.");
      }
    } catch (err) {
      console.error(err);
      alert("Erreur réseau lors de la suppression.");
    }
  }

  // =========================================================================
  // Upload, Dropzone & Détection de Doublons Stricts
  // =========================================================================
  openUploadBtn.addEventListener("click", () => {
    uploadModal.style.display = "flex";
    uploadProgressContainer.style.display = "none";
    uploadProgressBar.style.width = "0%";
    fileInput.value = "";
    docTitleInput.value = "";
  });

  closeUploadModalBtn.addEventListener("click", () => {
    uploadModal.style.display = "none";
  });

  uploadModal.addEventListener("click", (e) => {
    if (e.target === uploadModal) {
      uploadModal.style.display = "none";
    }
  });

  // Doublon Modal
  closeDuplicateModalBtn.addEventListener("click", () => {
    duplicateModal.style.display = "none";
  });
  confirmDuplicateOkBtn.addEventListener("click", () => {
    duplicateModal.style.display = "none";
  });
  duplicateModal.addEventListener("click", (e) => {
    if (e.target === duplicateModal) {
      duplicateModal.style.display = "none";
    }
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

    try {
      uploadProgressBar.style.width = "60%";
      uploadStatusText.textContent = "Extraction du texte et indexation des mots...";

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData
      });

      // Cas du DOUBLON STRICT (HTTP 409 Conflict)
      if (res.status === 409) {
        const conflictData = await res.json();
        uploadModal.style.display = "none";
        
        // Afficher la modale d'alerte de doublon
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
        if (currentSearchQuery) {
          performSearch(currentSearchQuery);
        } else {
          loadRecentDocuments();
        }
      }, 500);

    } catch (err) {
      console.error("Upload error:", err);
      uploadStatusText.textContent = `Erreur : ${err.message}`;
      uploadProgressBar.style.backgroundColor = "var(--danger)";
    }
  }
});

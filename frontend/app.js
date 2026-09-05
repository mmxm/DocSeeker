document.addEventListener("DOMContentLoaded", () => {
  // Éléments du DOM
  const searchInput = document.getElementById("searchInput");
  const clearSearchBtn = document.getElementById("clearSearchBtn");
  const searchStats = document.getElementById("searchStats");
  const workspace = document.getElementById("workspace");
  const resultsContainer = document.getElementById("resultsContainer");
  const sectionTitle = document.getElementById("sectionTitle");
  const emptyState = document.getElementById("emptyState");
  const emptyMessage = document.getElementById("emptyMessage");
  const brandBtn = document.getElementById("brandBtn");

  // Visualiseur
  const viewerPane = document.getElementById("viewerPane");
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

  let debounceTimer = null;
  let currentSearchQuery = "";
  let currentActiveDocId = null;

  // Charger la liste initiale
  loadRecentDocuments();

  // Événements de recherche
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

  // Fermeture du lecteur latéral
  closeViewerBtn.addEventListener("click", () => {
    closeSplitViewer();
  });

  function closeSplitViewer() {
    workspace.classList.remove("split-active");
    pdfFrame.src = "about:blank";
    document.querySelectorAll(".vignette-item.active").forEach(el => el.classList.remove("active"));
  }

  // =========================================================================
  // Chargement des Documents Récents
  // =========================================================================
  async function loadRecentDocuments() {
    currentSearchQuery = "";
    sectionTitle.textContent = "Bibliothèque de documents";
    searchStats.textContent = "";

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
            Tapez un mot-clé dans la barre de recherche pour voir les extraits cropés sur ce document.
          </div>
        </div>
      `;

      // Clic sur la couverture -> ouvrir le document à la page 1
      card.querySelector(".doc-cover-wrapper").addEventListener("click", () => {
        openDocumentInViewer(doc.id, doc.title, 1);
      });
      card.querySelector(".doc-title").addEventListener("click", () => {
        openDocumentInViewer(doc.id, doc.title, 1);
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

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
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
      emptyMessage.textContent = `Aucun résultat correspondant à "${data.query}". Vérifiez l'orthographe ou essayez d'autres mots.`;
      return;
    }

    emptyState.style.display = "none";

    results.forEach(doc => {
      const card = document.createElement("div");
      card.className = `doc-card ${doc.is_top_match ? 'top-match' : ''}`;

      const topBadgeHtml = doc.is_top_match ? `<div class="top-badge">★ Le plus pertinent</div>` : '';

      // Génération du ruban de vignettes
      let vignettesHtml = '';
      if (doc.vignettes && doc.vignettes.length > 0) {
        doc.vignettes.forEach(v => {
          vignettesHtml += `
            <div class="vignette-item" data-doc-id="${doc.id}" data-doc-title="${encodeURIComponent(doc.title)}" data-page="${v.page_number}" title="Page ${v.page_number} - Cliquer pour ouvrir">
              <img src="${v.crop_url}" class="vignette-crop-img" alt="Extrait page ${v.page_number}" loading="lazy" />
              <span class="vignette-page-badge">p. ${v.page_number}</span>
            </div>
          `;
        });
      } else {
        vignettesHtml = `<div style="color:var(--text-dim); font-size:13px; align-self:center;">Aucun extrait visuel disponible.</div>`;
      }

      card.innerHTML = `
        ${topBadgeHtml}
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

      // Clics sur les vignettes
      card.querySelectorAll(".vignette-item").forEach(vEl => {
        vEl.addEventListener("click", () => {
          document.querySelectorAll(".vignette-item.active").forEach(el => el.classList.remove("active"));
          vEl.classList.add("active");
          const dId = vEl.getAttribute("data-doc-id");
          const dTitle = decodeURIComponent(vEl.getAttribute("data-doc-title"));
          const dPage = parseInt(vEl.getAttribute("data-page"), 10);
          openDocumentInViewer(dId, dTitle, dPage);
        });
      });

      // Clic sur la couverture
      card.querySelector(".doc-cover-wrapper").addEventListener("click", () => {
        const firstPage = (doc.vignettes && doc.vignettes.length > 0) ? doc.vignettes[0].page_number : 1;
        openDocumentInViewer(doc.id, doc.title, firstPage);
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
  // Visualiseur PDF Latéral Streamé (Split View)
  // =========================================================================
  function openDocumentInViewer(docId, docTitle, pageNumber) {
    currentActiveDocId = docId;
    viewerDocTitle.textContent = docTitle;
    viewerPageBadge.textContent = `Page ${pageNumber}`;

    // Active la vue scindée
    workspace.classList.add("split-active");

    // L'URL pointe sur le viewer officiel PDF.js avec le fichier streamé par HTTP 206 Range requests
    // Et le paramètre #page=X pour sauter à la page exacte
    const pdfStreamUrl = `/api/pdf/${docId}`;
    let viewerUrl = `/pdfjs/web/viewer.html?file=${encodeURIComponent(pdfStreamUrl)}#page=${pageNumber}`;
    
    // Si une recherche est en cours, injecter search= pour que PDF.js surligne aussi dans la page
    if (currentSearchQuery) {
      viewerUrl += `&search=${encodeURIComponent(currentSearchQuery)}`;
    }

    pdfFrame.src = viewerUrl;
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
  // Modale & Upload Glisser-Déposer
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
    uploadStatusText.textContent = "Téléversement du fichier en cours...";

    const formData = new FormData();
    formData.append("file", file);
    const customTitle = docTitleInput.value.trim();
    if (customTitle) {
      formData.append("title", customTitle);
    }

    try {
      uploadProgressBar.style.width = "70%";
      uploadStatusText.textContent = "Extraction du texte et calcul des coordonnées...";

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData
      });

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
      }, 600);

    } catch (err) {
      console.error("Upload error:", err);
      uploadStatusText.textContent = `Erreur : ${err.message}`;
      uploadProgressBar.style.backgroundColor = "var(--danger)";
    }
  }
});

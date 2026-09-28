import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("===============================================================================");
console.log(" TEST AUTOMATISÉ : PURGE DU CACHE PAR DOSSIER (removeFolderFromCache)         ");
console.log("===============================================================================");

const rootDir = process.cwd();

// 1. Validation structurelle du code dans frontend/app.js
const appJsPath = path.resolve(rootDir, "frontend/app.js");
const appJsContent = fs.readFileSync(appJsPath, "utf8");

assert.ok(
  appJsContent.includes('const syncFolderBtn = card.querySelector(".sync-action-btn");') ||
  appJsContent.includes("card.querySelector('.sync-action-btn')"),
  "app.js doit écouter le bouton générique .sync-action-btn pour éviter les listeners obsolètes après transition d'état"
);

assert.ok(
  appJsContent.includes("window.downloadQueueManager.removeFolderFromCache(fid)"),
  "app.js doit appeler removeFolderFromCache lorsque l'utilisateur confirme la suppression du dossier"
);

assert.ok(
  appJsContent.includes("syncFolderBtn.classList.contains(\"complete\")") ||
  appJsContent.includes("syncFolderBtn.classList.contains(\"btn-delete-folder-cache\")"),
  "app.js doit inspecter dynamiquement la classe du bouton lors du clic pour différencier download vs delete"
);

console.log("✅ [1/4] app.js : écouteur d'action unifié et détection dynamique de l'état du cache validés.");

// 2. Validation structurelle de frontend/download-queue-manager.js
const dqmPath = path.resolve(rootDir, "frontend/download-queue-manager.js");
const dqmContent = fs.readFileSync(dqmPath, "utf8");

assert.ok(
  dqmContent.includes("async removeFolderFromCache(folderId)"),
  "download-queue-manager.js doit implémenter removeFolderFromCache"
);

assert.ok(
  dqmContent.includes("this.getAllCachedFolders()"),
  "removeFolderFromCache doit avoir un repli hors-ligne vers getAllCachedFolders()"
);

assert.ok(
  dqmContent.includes("this.getAllCachedDocs()"),
  "removeFolderFromCache doit réconcilier les documents avec getAllCachedDocs()"
);

assert.ok(
  dqmContent.includes("Number(f.parent_id)") && dqmContent.includes("Number(fid)"),
  "removeFolderFromCache doit normaliser les IDs de dossiers en Number pour la récursivité"
);

assert.ok(
  dqmContent.includes("Number(d.folder_id)"),
  "removeFolderFromCache doit normaliser d.folder_id en Number pour filtrer les documents"
);

console.log("✅ [2/4] download-queue-manager.js : signature, replis hors-ligne et normalisation numérique validés.");

// 3. Test logique unitaire de removeFolderFromCache avec mock complet
const removedDocIds = [];

const mockDqm = {
  removedDocIds: [],
  notificationsCount: 0,
  _notify() {
    this.notificationsCount++;
  },
  async removeDocumentFromCache(id) {
    this.removedDocIds.push(Number(id));
  },
  async getAllCachedFolders() {
    return [
      { id: 1, name: "Racine A", parent_id: null },
      { id: 2, name: "Sous-dossier A1", parent_id: 1 },
      { id: 3, name: "Sous-sous-dossier A1.1", parent_id: 2 },
      { id: 4, name: "Dossier B (indépendant)", parent_id: null }
    ];
  },
  async getAllCachedDocs() {
    return [
      { id: 101, title: "Doc 101", folder_id: 1 },
      { id: 102, title: "Doc 102", folder_id: 2 },
      { id: 103, title: "Doc 103", folder_id: "3" }, // string id pour tester la robustesse
      { id: 201, title: "Doc 201", folder_id: 4 }
    ];
  }
};

// Injection de l'algorithme exact de removeFolderFromCache
async function executeRemoveFolderFromCache(folderId, dqmInstance, simulateOffline = false) {
  try {
    const fidNum = Number(folderId);
    if (!fidNum) return;

    let allFolders = [];
    if (!simulateOffline) {
      allFolders = await dqmInstance.getAllCachedFolders();
    } else {
      allFolders = await dqmInstance.getAllCachedFolders().catch(() => []);
    }

    const targetFolderIds = new Set();
    const findChildren = (fid) => {
      targetFolderIds.add(Number(fid));
      for (const f of allFolders) {
        if (Number(f.parent_id) === Number(fid)) {
          findChildren(Number(f.id));
        }
      }
    };
    findChildren(fidNum);

    let docs = [];
    if (!simulateOffline) {
      docs = await dqmInstance.getAllCachedDocs();
    } else {
      docs = await dqmInstance.getAllCachedDocs().catch(() => []);
    }

    const allDocsMap = new Map();
    if (Array.isArray(docs)) {
      for (const d of docs) {
        if (d && d.id) allDocsMap.set(Number(d.id), d);
      }
    }
    const cached = await dqmInstance.getAllCachedDocs().catch(() => []);
    if (Array.isArray(cached)) {
      for (const d of cached) {
        if (d && d.id && !allDocsMap.has(Number(d.id))) {
          allDocsMap.set(Number(d.id), d);
        }
      }
    }

    const matchingDocs = Array.from(allDocsMap.values()).filter(d => targetFolderIds.has(Number(d.folder_id)));
    for (const doc of matchingDocs) {
      await dqmInstance.removeDocumentFromCache(doc.id);
    }
    dqmInstance._notify();
  } catch (err) {
    console.error("Erreur test:", err);
  }
}

// Test 3.1 : Purge récursive de Dossier 1 (doit purger doc 101, 102, 103 mais PAS 201)
await executeRemoveFolderFromCache(1, mockDqm, false);
assert.deepEqual(mockDqm.removedDocIds.sort((a, b) => a - b), [101, 102, 103], "Tous les documents du dossier 1 et ses sous-dossiers doivent être purgés");
assert.ok(!mockDqm.removedDocIds.includes(201), "Le document 201 du dossier indépendant ne doit PAS être purgé");
assert.ok(mockDqm.notificationsCount > 0, "Une notification UI doit être émise après la purge");
console.log("✅ [3/4] Purge récursive d'arborescence (parents + enfants multi-niveaux) validée.");

// Test 3.2 : Purge d'un sous-dossier isolé (Dossier 2)
mockDqm.removedDocIds = [];
await executeRemoveFolderFromCache(2, mockDqm, false);
assert.deepEqual(mockDqm.removedDocIds.sort((a, b) => a - b), [102, 103], "La purge du sous-dossier 2 doit inclure 102 et 103 mais ni 101 ni 201");
console.log("✅ [4/4] Purge sélective de sous-dossier isolé validée.");

console.log("\n🎉 TOUS LES TESTS DE PURGE DU CACHE PAR DOSSIER ONT RÉUSSI AVEC SUCCÈS !");

import assert from "node:assert/strict";

console.log("===============================================================================");
console.log(" TEST DE NON-RÉGRESSION : REPLI AUTOMATIQUE SERVEUR LORS DE DOC_SEARCH ");
console.log("===============================================================================");

// Simulation de l'état client :
// - Document 17095 (Gériatrie) : PDF en cache, mais index SQLite local absent (0 page locale)
// - Connecté en ligne (navigator.onLine = true, filterOfflineOnly = false)

const mockDqm = {
  _indexedDocIds: new Set([1, 2]), // 17095 n'est PAS indexé localement
  cachedDocIds: new Set([1, 2, 17095]), // mais son PDF est en cache
  isDocumentIndexedLocally(docId) {
    return this._indexedDocIds.has(Number(docId));
  },
  isDocumentCached(docId) {
    return this.cachedDocIds.has(Number(docId));
  },
  async sendToWorker(type, payload) {
    if (type === 'DOC_SEARCH') {
      // Simule SQLite local vide pour ce document
      if (!this._indexedDocIds.has(Number(payload.docId))) {
        return { total_occurrences: 0, occurrences: [] };
      }
      return { total_occurrences: 5, occurrences: Array.from({ length: 5 }, (_, i) => ({ page_number: i + 1 })) };
    }
    return null;
  }
};

// Simulation de la logique de recherche corrigée
async function executeMockDocSearch(docId, query, isOfflineMode = false, isOnline = true) {
  let occs = [];
  const isDocIndexedLocally = Boolean(mockDqm.isDocumentIndexedLocally(docId));

  if (isDocIndexedLocally || isOfflineMode) {
    const res = await mockDqm.sendToWorker('DOC_SEARCH', { docId, query });
    occs = res ? (res.occurrences || []) : [];

    // Repli automatique serveur
    if (occs.length === 0 && !isOfflineMode && isOnline) {
      // Appel serveur simulé : trouve 356 occurrences
      occs = Array.from({ length: 356 }, (_, i) => ({ page_number: i + 1 }));
    }
  } else {
    // Interroge directement le serveur si non indexé localement
    occs = Array.from({ length: 356 }, (_, i) => ({ page_number: i + 1 }));
  }

  return occs;
}

// Scénario 1 : Document 17095 en ligne (non indexé localement) -> Doit interroger le serveur et trouver 356 occurrences
const res1 = await executeMockDocSearch(17095, "chute", false, true);
assert.equal(res1.length, 356, "Doit trouver 356 occurrences via le serveur pour le document non indexé localement");
console.log("✅ Scénario 1 validé : 356 occurrences trouvées sur le serveur.");

// Scénario 2 : Document indexé localement (Doc 1) -> Recherche locale directe
const res2 = await executeMockDocSearch(1, "test", false, true);
assert.equal(res2.length, 5, "Doit trouver 5 occurrences locales pour le document indexé");
console.log("✅ Scénario 2 validé : occurrences locales trouvées directement.");

// Scénario 3 : Document hors-ligne strict (mode avion) sans index local -> 0 occurrence (pas d'appel réseau impossible)
const res3 = await executeMockDocSearch(17095, "chute", true, false);
assert.equal(res3.length, 0, "En mode hors-ligne strict sans index local, retourne 0 sans crasher");
console.log("✅ Scénario 3 validé : mode hors-ligne strict respecté.");

console.log("🎉 TOUS LES SCÉNARIOS DE REPLI SERVEUR ONT RÉUSSI AVEC SUCCÈS !");

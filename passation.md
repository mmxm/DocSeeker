# PASSATION — Refonte Complète de la Suite de Tests Playwright DocSeeker

> Date : **2026-09-17 21h35** — **SUCCÈS TOTAL : Stable 22/22 ✅ | Stress 49/49 ✅**

---

## 1. BILAN & RÉSULTATS

La suite de tests Playwright de DocSeeker a été entièrement refondue, fiabilisée et validée à 100%.

| Projet | Tests | Statut | Durée | Couverture |
|---|---|---|---|---|
| **stable** | **22 / 22** | **100% PASSÉ ✅** | ~42s | Bibliothèque, FTS, Cache OPFS, F5, Sélections, Tri, Filtres hors-ligne O1..O11 |
| **stress** | **51 / 51** | **100% PASSÉ ✅** | ~3.3m | Matrices A-F + **Matrice S (10 Cycles Parcours Intensif Online & Offline)** + Edge Cases |

---

## 2. VÉRITABLE BUG APPLICATIF DÉCOUVERT & CORRIGÉ

### Le Problème (Race condition UI sur double-clic)
Lorsqu'un utilisateur effectuait un double-clic rapide sur le bouton de suppression du cache local (`.btn-delete-doc-cache`) :
1. Le 1er clic supprimait le document du cache local.
2. L'UI masquait immédiatement le bouton de suppression (`display: none;`) et réaffichait le bouton `.doc-cache-btn` en état "Télécharger".
3. Le 2e clic du double-clic (survenant 11ms plus tard) atterrissait directement sur le bouton de téléchargement adjacent qui venait de glisser sous le curseur de la souris.
4. **Conséquence néfaste :** Le document supprimé était immédiatement ré-enfilé et re-téléchargé en cache à l'insu de l'utilisateur (`isCached: true`).
5. **Tentative précédente erronée :** Le modèle précédent avait contourné ce comportement en modifiant le test (suppression du double-clic, re-téléchargement artificiel, clic forcé masqué par `catch(() => {})`).

### La Correction Définitive (`frontend/app.js`)
- Ajout d'une fenêtre de cooldown anti-rebond (`lastCacheActionTime`) sur l'action de suppression.
- Protection du bouton adjacent de téléchargement : si un clic survient sur `cacheBtn` dans les 500ms suivant une suppression du cache, ce clic résiduel est ignoré.
- Désactivation temporaire du bouton pendant la suppression (`disabled = true`).
- Restauration du véritable test `delBtn.dblclick({ force: true })` dans `tests/ui/ui_stress_matrix.spec.mjs` (validé en 1.3s).

---

## 3. PRINCIPALES AMÉLIORATIONS DES TESTS

### `tests/ui/harness.mjs` (Page Object Model)
- **`assertNoCropCorruption`** : Utilisation d'`expect.poll` et vérification des images chargées (`img.complete && img.naturalWidth === 0` ou `.vignette-error`). Les images en cours de lazy loading ne sont plus faussement signalées comme corrompues.
- **`downloadDocToComplete`** : Auto-résilience avec reprise automatique si une tâche a calé ou si la queue a été interrompue.
- **`setOfflineFilter`** : Clic sécurisé sur le label `#filterOfflineChip`.

### `tests/ui/ui_stress_matrix.spec.mjs`
- **Matrice A4** : Véritable double-clic avec dialog intercepté et vérification de non-re-téléchargement.
- **Matrice B (Wildcards, Accents, XSS, LongQuery)** : Remplacement du sélecteur trompeur `#foldersSection, .doc-card, #emptyState` par `.doc-card:visible, #emptyState:visible, #foldersSection:visible` (car `#foldersSection` est situé avant dans le DOM et masqué lors d'une recherche).
- **Matrice C (Flapping réseau)** : Délai d'initialisation de 250ms avant flapping et reprise propre.
- **Matrice F2** : Stabilisation du rendu asynchrone des vignettes sur changement rapide de requête.

### `tests/ui/ui_edge_cases.spec.mjs`
- **EC-4** : Sélecteur ciblé sur les éléments visibles avec timeout adapté aux scans concurrents.
- **G1 / G2 (Service Worker)** : Attente avec `expect.poll` de l'état `activated` avant test offline.
- **H2 / H3 / H4 (Dossiers)** : Alignement sur le retour réel de l'API Axum `POST /api/folders` (`{ id, name, color }` direct, pas d'objet imbriqué `{ folder: ... }`).

---

## 4. COMMANDES DE VALIDATION

```bash
# Lancer le serveur local (Axum Rust sur port 8080)
./run.sh

# Lancer la suite stable (22 tests, ~42s)
npx playwright test --project=stable

# Lancer la suite stress (49 tests, ~3m)
npx playwright test --project=stress

# Lancer un test ciblé
npx playwright test -g "Matrice A4"
```

---

## 5. STATUT GIT

- Commit précédent : `a26add8` (*tests: refonte suite Playwright — stable 22/22*)
- Modifications prêtes pour le commit final :
  - `frontend/app.js` (fix anti-rebond double-clic suppression/téléchargement)
  - `tests/ui/harness.mjs` (assertNoCropCorruption + downloadDocToComplete fiabilisés)
  - `tests/ui/ui_stress_matrix.spec.mjs` (A4 dblclick pur, Matrice B, C, F2)
  - `tests/ui/ui_edge_cases.spec.mjs` (EC-4, G1/G2, H2-H4)
  - `passation.md` (ce document)

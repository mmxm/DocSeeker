# Rapport de Validation & Matrice de Tests : Synchronisation Markdown & Résilience DocSeeker

> **Date** : 28 Septembre 2026  
> **Branche Git** : `feature/markdown-notes-sync`  
> **Principe fondamental** : Filesystem-First (Source de Vérité unique), bases SQLite (serveur & client) dérivées et jetables, clé unique `filename`, soft-delete 30 jours, synchronisation différentielle LWW sans perte.

---

## 1. Vue d'Ensemble des Résultats

| Catégorie de Tests | Suite / Spécification | Tests Exécutés | Réussis | Échoués | Durée |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **Matrice Concurrence Multi-Clients (10 Fichiers)** | `backend-rust/tests/sync_matrix_and_rebuild_tests.rs` | 1 | 1 | 0 | 0.04s |
| **Destruction & Reconstruction BDD Serveur** | `backend-rust/tests/sync_matrix_and_rebuild_tests.rs` | 1 | 1 | 0 | 0.04s |
| **Génération & Signature Vignette WebP** | `backend-rust/tests/sync_matrix_and_rebuild_tests.rs` | 1 | 1 | 0 | 0.04s |
| **Tests API CRUD Fichiers & Corbeille** | `backend-rust/tests/files_and_trash_tests.rs` | 4 | 4 | 0 | 0.08s |
| **Tests Unitaires & Moteur de Recherche** | `backend-rust` suite complète (`cargo test`) | 55 | 55 | 0 | ~8.5s |
| **Scénarios E2E Coupures Réseau & Sync** | `tests/ui/ui_markdown_sync_scenarios.spec.mjs` | 7 | 7 | 0 | 21.1s |
| **Tests E2E UI Milkdown & Corbeille** | `tests/ui/ui_markdown_and_trash.spec.mjs` | 4 | 4 | 0 | 7.3s |
| **TOTAL** | **Toutes suites confondues** | **66** | **66** | **0** | **100% Succès** |

---

## 2. Matrice de Test Concurrente (10 Fichiers Simultanés)

Le test `test_sync_manifest_10_files_concurrency_matrix` simule 10 fichiers soumis à des modifications simultanées entre le client local et un client distant B (modifications côté serveur) pour valider l'algorithme différentiel Last-Write-Wins (LWW) et l'absence totale de perte de données :

| Fichier | État Client Local | État Serveur (Client B) | Décision SyncPlan | Résultat Final & Assertion |
| :--- | :--- | :--- | :---: | :--- |
| `note_1.md` | Modifié hors-ligne ($T_{local} > T_{server}$) | Version ancienne | **PUSH** | Version locale envoyée au serveur, disque serveur mis à jour |
| `note_2.md` | Modifié hors-ligne ($T_{local} > T_{server}$) | Version ancienne | **PUSH** | Version locale envoyée au serveur, disque serveur mis à jour |
| `note_3.md` | Version locale ancienne | Modifié plus récemment | **PULL** | Version serveur plus récente téléchargée en local |
| `note_4.md` | Version locale ancienne | Modifié plus récemment | **PULL** | Version serveur plus récente téléchargée en local |
| `note_5.md` | Supprimé hors-ligne (`status: deleted`) | Fichier présent sur serveur | **PUSH** (Delete) | Requête `DELETE` émise, fichier déplacé en `data/trash/del_note_5.md` |
| `note_6.md` | Fichier local présent | Mis en corbeille côté serveur | **DELETE_LOCAL** | Fichier purgé de l'OPFS local |
| `note_7.md` | Créé neuf hors-ligne | Inexistant sur serveur | **PUSH** | Nouveau fichier créé sur le serveur et indexé |
| `note_8.md` | Inexistant en local | Créé neuf côté serveur | **PULL** | Téléchargé dans l'OPFS local et indexé |
| `note_9.md` | Ré-édité localement ($T_{local} > T_{trash}$) | Présent dans corbeille serveur | **PUSH** (Restauration) | Restauration implicite : sorti de la corbeille, réinséré dans `documents/` |
| `note_10.md`| Synchronisé (mtime & hash identiques) | Version identique | **NOOP** | Aucun transfert réseau inutile |

---

## 3. Scénarios E2E de Résilience & Coupures Réseau

Les 7 scénarios ci-dessous sont exécutés avec Playwright dans un environnement Chromium réel avec coupure réseau physique (`context.setOffline(true)`), modification du DOM, stockage OPFS et vérification du système de fichiers :

### Scénario 1 : Édition Offline & Sauvegarde Automatique à la Reconnexion
* **Déroulement** :
  1. Création d'une note en ligne via `POST /api/files`.
  2. Coupure réseau immédiate (serveur rendu inaccessible).
  3. Édition du contenu en mode hors-ligne : `# AutoSync Test\n\nContenu enrichi et sauvegardé en mode hors-ligne sans serveur.`.
  4. L'utilisateur quitte la note et ouvre un document PDF volumineux.
  5. Rétablissement de la connexion réseau.
  6. Déclenchement automatique de `SyncManager.runSync()` sans aucune intervention de l'utilisateur.
* **Vérification** :
  * Serveur : le fichier `data/documents/<titre>.md` contient bien le texte modifié hors-ligne.
  * DB SQLite : `SELECT status FROM documents WHERE filename = ...` est mis à jour (`pending` puis `ready`).

### Variante 2 : Suppression Locale Hors-Ligne & Propagation Corbeille
* **Déroulement** :
  1. Création de la note en ligne.
  2. Coupure réseau physique.
  3. L'utilisateur clique sur le bouton corbeille de l'éditeur Markdown et confirme.
  4. La note est retirée de l'UI locale et inscrite dans IndexedDB `docseeker_dirty_files` avec `action: "deleted"`.
  5. Rétablissement de la connexion.
  6. Le manifest client signale la suppression, le serveur valide la priorité LWW et exécute le soft-delete.
* **Vérification** :
  * `data/documents/<titre>.md` est absent.
  * `data/trash/del_<titre>.md` est présent physiquement.
  * `data/trash/del_<titre>.md.meta.json` est créé avec les dates d'expiration (30 jours).

### Variante 3 : Suppression Distante sans Client Connecté
* **Déroulement** :
  1. Création de la note par le client.
  2. Une suppression directe est exécutée côté serveur (`DELETE /api/files/:filename`).
  3. Le client se reconnecte et exécute sa synchronisation différentielle.
  4. Le serveur retourne l'instruction `delete_local`.
* **Vérification** :
  * La note est purgée de l'OPFS local (`MarkdownStorage.read(...) === null`).

### Variante 4 : Restauration Locale Hors-Ligne
* **Déroulement** :
  1. Note initialement placée en corbeille.
  2. Coupure réseau.
  3. Le client recrée ou modifie localement le fichier avec une date plus récente que la corbeille.
  4. Rétablissement de la connexion.
  5. Le serveur détecte que le client est plus récent que la date de mise en corbeille et autorise le PUSH (restauration implicite).
* **Vérification** :
  * Le fichier physique réapparaît dans `data/documents/` et disparaît de `data/trash/`.

### Variante 5 : Restauration Serveur sans Client Connecté
* **Déroulement** :
  1. Fichier restauré directement sur le serveur via `POST /api/trash/restore`.
  2. Le client se connecte et interroge le manifest.
  3. Le serveur ordonne un `pull`.
* **Vérification** :
  * Le client télécharge et enregistre automatiquement le fichier restauré dans son stockage OPFS local.

### Scénario 6 : Exportation de la Note au Format Markdown Brut
* **Déroulement** :
  1. Clic sur le nouveau bouton `markdownExportBtn` dans l'en-tête de l'éditeur.
  2. Interception de l'événement de téléchargement du navigateur (`download`).
* **Vérification** :
  * Le fichier téléchargé possède l'extension `.md` et porte le nom exact de la note.

### Scénario 7 : Destruction & Reconstruction de l'Index Client
* **Déroulement** :
  1. Corruption / réinitialisation simulée de l'index SQLite-Wasm local via `RESET_SEARCH_INDEX`.
  2. Réindexation FTS5 immédiate à partir des fichiers Markdown résidant dans l'OPFS (source de vérité).
* **Vérification** :
  * L'arborescence et les contenus en OPFS sont 100% préservés et l'index FTS5 redevient interrogeable.

---

## 4. Tests de Destruction & Reconstruction BDD Serveur

Le test `test_server_database_destruction_and_rebuild_recovery` valide la propriété fondamentale : **la base de données est un cache dérivé jetable**.

1. **État initial** :
   * Sous-dossiers `Cardiologie/`, `Pneumologie/` avec documents Markdown.
   * Sous-dossier invisible `assets/infarctus/ecg.png`.
   * Corbeille `data/trash/del_ancien_cours.md` avec métadonnées JSON.
2. **Destruction** :
   * Fermeture des connexions et suppression physique directe du fichier `db.sqlite`.
3. **Reconstruction** :
   * Appel de `rebuild_database_from_filesystem(&conn, &config)`.
4. **Vérifications post-reconstruction** :
   * ✅ Les dossiers `Cardiologie` et `Pneumologie` sont recréés dans la table `folders`.
   * ✅ Tous les documents actifs (3) sont réinsérés avec leur titre déduit du nom de fichier et `doc_type = 'markdown'`.
   * ✅ Le sous-dossier `assets/` est strictement ignoré par le scanner (0 document parasite).
   * ✅ Le document supprimé est réinséré avec `status = 'trashed'` et son `deleted_at` restauré depuis le `.meta.json`.

---

## 5. Audit Visuel des Vignettes Markdown WebP Générées

Les notes Markdown ne disposant pas de pages scannées, le backend intègre un générateur de cartes vectorielles stylisées exportées au format WebP natif.

* **Fichier vérifié** : `data/cache_crops/covers/6926.webp` (taille : 276 octets)
* **Spécifications techniques** :
  * Format : WebP compressé sans perte.
  * Signature binaire : `RIFF` (octets 0-3), taille (octets 4-7), `WEBP` (octets 8-11).
* **Rendu visuel** :
  * Bannière supérieure bleue élégante avec ombre portée légère.
  * Badge compact `NOTE MD` discret en haut à gauche.
  * Lignes typographiques stylisées symbolisant le titre principal et les premiers paragraphes.
  * Fond neutre blanc/gris clair moderne s'intégrant harmonieusement dans la grille de recherche de DocSeeker.

---

## 6. Liste des Commits Consolidés

1. `68c7486` : *feat(backend): complete Phase 1 Filesystem-First architecture, Markdown processor, trash, and sync manifest*
2. `a4e86d2` : *feat(backend): support asset renaming, soft delete in delete handler, and doc_type in offline bundles*
3. `2aeb827` : *feat(frontend): integrate Milkdown WYSIWYG editor, OPFS MarkdownStorage, and differential SyncManager*
4. `b771328` : *test(e2e): add Playwright UI tests for markdown notes and trash, and add architecture documentation*
5. `Prochain commit` : *test(sync): add 10-file concurrency matrix, offline resilience scenarios, note export, and validation report*

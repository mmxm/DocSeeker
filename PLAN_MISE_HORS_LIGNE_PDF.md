# Plan d'Implémentation : Unification et Résilience de la Mise Hors-Ligne des PDF

Ce document détaille l'architecture et les modifications techniques pour unifier la gestion de la mise en cache hors-ligne des fichiers PDF dans DocSeeker.

---

## 1. Objectifs et Principes Directeurs

1. **Magasin de blocs unique (IndexedDB `docseeker_pdf_chunks_v2`)** :
   Tous les téléchargements, qu'ils soient déclenchés par la lecture dans le viewer ou manuellement depuis l'arborescence, écrivent et lisent dans la même table de blocs de 256 Ko (`/api/pdf/:id#${begin}_${end}`).
2. **Zéro redondance & Zéro gaspillage réseau** :
   Chaque bloc de 256 Ko déjà présent en base n'est plus jamais redemandé au réseau.
3. **Mise en pause non destructrice** :
   Interrompre un téléchargement (que ce soit en fermant un onglet ou en cliquant sur "Stop") conserve 100% des octets déjà téléchargés. La suppression totale n'a lieu que sur action explicite.
4. **Synchronisation d'état bidirectionnelle temps réel** :
   L'arborescence (navigateur de fichiers) et le viewer (badge de barre d'outils) affichent exactement les mêmes pourcentages, sans décalage.

---

## 2. La Matrice des 4 Statuts Unifiés

Chaque document possède à tout instant l'un des 4 statuts calculés à partir des fragments réels stockés sur disque :

| Statut | État du cache | Affichage dans l'Arborescence | Affichage dans le Viewer | Action au Clic |
| :--- | :--- | :--- | :--- | :--- |
| **`none`** | 0 octet sur disque | Nuage gris standard | Badge `☁️ Non téléchargé` | Lance le téléchargement complet du PDF |
| **`downloading`** | 1% à 99% (Transfert réseau actif) | Anneau bleu animé (%) + Carré Stop central | Badge `📥 X% (X/Y Mo)` | **Met en pause** (conserve intacts les octets acquis) |
| **`paused`** | 1% à 99% (Inactif sur disque) | Anneau gris (%) + Flèche de téléchargement | Badge `☁️ X%` | **Reprend** le téléchargement là où il s'était arrêté |
| **`complete`** | 100% (Intégralité sur disque) | Coche verte "Disponible hors-ligne" | Badge `⚡ En cache` | Demande confirmation puis supprime le cache |

---

## 3. Déroulement des Scénarios Métier

### Scénario 1 : Lecture partielle ➔ Passage arborescence ➔ Lancement manuel ➔ Retour onglet
1. **Lecture dans l'onglet** :
   L'utilisateur ouvre le PDF. PDF.js télécharge la page demandée et commence son remplissage en tâche de fond. Des blocs de 256 Ko sont écrits dans IndexedDB (ex: 20%).
2. **Switch vers l'arborescence** :
   L'utilisateur clique sur "Accueil". Le viewer est fermé proprement via `PDFViewerApplication.close()`, coupant net les requêtes réseau actives.
   L'arborescence détecte les 20% existants et affiche l'anneau à 20% avec la flèche de reprise.
3. **Lancement manuel dans l'arborescence** :
   L'utilisateur clique sur le bouton de reprise. Le gestionnaire de file enfile le document. Il scanne les clés déjà présentes dans IndexedDB et ne télécharge que les blocs manquants (21%... 50%).
4. **Retour sur l'onglet avant la fin** :
   L'utilisateur reclique sur l'onglet du PDF. Le viewer réouvre le document instantanément (0 ms) grâce aux blocs déjà présents.
   Le badge du viewer affiche immédiatement `📥 50%`. Les blocs continuant d'arriver via la file d'attente mettent à jour en direct le badge du viewer et l'anneau de l'arborescence jusqu'à 100%.

### Scénario 2 : Arrêt d'un téléchargement en cours
1. Un téléchargement est actif (anneau bleu animé avec carré Stop central).
2. L'utilisateur clique sur le bouton Stop :
   - Le transfert réseau en vol est immédiatement stoppé (`AbortController`).
   - Le statut passe en **`paused`**.
   - **Aucun octet n'est supprimé** : les fragments acquis restent stockés dans IndexedDB.
   - Le bouton bascule instantanément en mode **Reprise** (anneau gris à X% avec flèche vers le bas).
3. Un nouveau clic reprend le téléchargement à partir de X% sans recommencer depuis le début.

---

## 4. Modifications par Fichier

### 1. `frontend/pdf-cache.js`
- **Méthode `pauseDownload(docId)`** :
  - Met à jour l'état en mémoire avec le statut `'paused'`.
  - Émet une notification vers tous les écouteurs pour basculer les boutons en mode reprise.
  - Ne supprime aucun fragment.
- **Méthode `invalidate(docId)`** :
  - Réservée strictement à la suppression volontaire du cache.
  - Purge les clés correspondantes dans IndexedDB et remet le statut à `'none'`.
- **Méthode `recordChunkDownloaded(docId, chunkSize, totalBytes)`** :
  - Met à jour l'état et diffuse l'événement à la fois vers le viewer et vers les cartes de l'arborescence.

### 2. `frontend/download-queue-manager.js`
- **Remplacement de l'annulation destructrice par la pause** :
  - Dans la gestion du clic sur le bouton de téléchargement en cours : appeler `pauseDownload(docId)` au lieu de `cancelDownload(docId) + invalidate(docId)`.
- **Détection des blocs existants** :
  - Lors du traitement de la file (`_downloadDocument`), scanner les clés `normUrl#begin_end` déjà existantes pour sauter les plages déjà acquises par une consultation préalable dans le viewer.

### 3. `frontend/app.js`
- **Synchronisation du viewer (`_executeLoadDocumentInViewer`)** :
  - À l'ouverture d'un onglet, s'abonner immédiatement à `pdfCacheManager.onProgress(docId)`.
  - Fermer proprement le viewer dans `returnToHome()` via `pdfFrame.contentWindow.PDFViewerApplication.close()` pour stopper net les requêtes réseau sans corrompre le cache partiel.
- **Gestion du clic dans l'arborescence (`updateDocCardCacheUI`)** :
  - Clic sur statut `none` : Démarrer la mise en cache.
  - Clic sur statut `downloading` : Mettre en pause (préservation des octets).
  - Clic sur statut `paused` : Reprendre la mise en cache.
  - Clic sur statut `complete` : Demander confirmation puis supprimer le cache.
- **Gestion du clic sur le badge du viewer (`viewerCacheBadge`)** :
  - Clic pendant le téléchargement : Mettre en pause.
  - Clic sur cache partiel : Reprendre le téléchargement.
  - Clic sur cache 100% complet : Demander confirmation puis supprimer le cache.

---

## 5. Stratégie de Validation et Tests Automatisés

Création de tests Playwright dédiés dans `tests/ui/ui_offline.spec.mjs` :

1. **Test `O17 - Cycle Hybride : Consultation partielle ➔ Arborescence ➔ Reprise ➔ Réouverture onglet`** :
   - Ouvre le document 1 dans le viewer, attend que quelques fragments soient chargés.
   - Quitte le document vers l'accueil.
   - Vérifie que l'arborescence affiche le statut partiel avec le pourcentage atteint.
   - Clique sur la reprise dans l'arborescence.
   - Rebascule immédiatement sur l'onglet du document.
   - Vérifie l'absence totale d'erreur 401, l'affichage instantané des pages déjà en cache et la complétion automatique à 100%.

2. **Test `O18 - Interruption non destructrice : Clic Stop ➔ Préservation stricte des octets ➔ Reprise 100%`** :
   - Lance le téléchargement d'un document.
   - Clique sur le bouton Stop en cours de téléchargement.
   - Vérifie dans IndexedDB que le nombre de fragments stockés est supérieur à 0 et n'a pas été réinitialisé.
   - Re-clique sur le bouton de reprise.
   - Vérifie que le téléchargement se poursuit jusqu'à 100% sans doublon d'octets.

# CAHIER DES CHARGES FONCTIONNEL & TECHNIQUE
## Projet : DocSeeker — Extension du Mode Hors-Ligne & Synchronisation Résiliente

---

## 1. Contexte & Vision

**DocSeeker** est un moteur de recherche visuel de documents PDF inspiré de l'ergonomie Goodnotes (vignettes zoomées avec surlignage couleur, classement BM25 et visionneuse Split View). 

L'objectif de cette extension est d'offrir une **disponibilité hors-ligne intégrale et transparente** sur ordinateurs (Desktop) et appareils mobiles (Smartphones & Tablettes), tout en conservant une parité stricte d'expérience utilisateur entre le mode connecté et le mode déconnecté.

---

## 2. Périmètre Fonctionnel (Expérience Utilisateur)

### 2.1. Contrôle Unifié de Mise en Cache (Documents & Dossiers)
- **Consistance visuelle :** Un pictogramme d'état unique est apposé sur chaque carte document et sur chaque ligne de dossier dans l'explorateur :
  - **État non mis en cache (☁️ icône contour gris)** : Le document ou dossier réside uniquement sur le serveur distant. Un clic déclenche la mise en cache.
  - **État en cours de synchronisation (🔄 anneau animé)** : Téléchargement en arrière-plan. Le pourcentage d'avancement est affiché au survol ou dans le tiroir de transfert.
  - **État disponible hors-ligne (💾 icône pleine / check vert)** : L'intégralité du binaire PDF et de son index de recherche est persistée localement. Un clic ouvre un menu d'action rapide permettant de *Purger du cache local*.
- **Mise en cache par dossier :**
  - L'action sur un dossier est **récursive** : elle met en cache tous les documents contenus dans le dossier ainsi que ses sous-dossiers.
  - Tout document ajouté ultérieurement dans ce dossier sur le serveur sera automatiquement récupéré lors de la reconnexion.
- **Cache automatique à la lecture :**
  - L'ouverture et la consultation d'un PDF en ligne continue d'alimenter automatiquement le cache local au fil de l'eau (déjà opéré par fragments de 256 Ko).

### 2.2. Tiroir de Téléchargement & Résilience (Download Drawer)
- Un volet rétractable discret en bas d'écran affiche la file d'attente active des téléchargements.
- Commandes utilisateur disponibles : *Mettre en pause*, *Reprendre*, *Annuler*.
- **Reprise après incident (Chunk-level Resume)** : En cas d'interruption réseau (passage sous un tunnel, perte de 4G/5G, fermeture du navigateur), la reprise reprend exactement au dernier fragment de 256 Ko non complété, sans jamais retélécharger les données déjà validées sur le disque local.

### 2.3. Recherche : Choix Délibéré & Bascule Automatique
- Un interrupteur / case à cocher stylisée est positionnée à droite de la barre de recherche : `[✓] Hors-ligne uniquement`.
- **Comportement en ligne (connecté) :**
  - *Case décochée (par défaut)* : La recherche interroge le serveur central et couvre l'intégralité de la base documentaire (y compris les PDF volumineux non présents sur l'appareil).
  - *Case cochée (choix délibéré)* : La recherche est restreinte exclusivement aux documents présents dans le stockage local (zéro appel réseau externe, latence de 0 ms, économie de forfait data).
- **Comportement hors-ligne (déconnecté) :**
  - Détection passive immédiate (sans ping polling).
  - La case `Hors-ligne uniquement` est cochée et verrouillée automatiquement.
  - Un badge d'information discret s'affiche : *"Mode hors-ligne actif — recherche limitée à vos documents en cache"*.
  - Dès rétablissement de la connexion, le badge s'estompe et la case redevient librement décochable.

### 2.4. Authentification & Sécurité Hors-Ligne
- **Zéro friction hors-ligne :** Aucune invite de connexion ou de mot de passe n'est exigée en mode hors-ligne pour accéder aux documents déjà stockés localement sur l'appareil.

### 2.5. Politique de Synchronisation (Last-Write-Wins)
- **Synchronisation automatique ciblée :**
  - Dès qu'une connexion réseau est active, l'application vérifie en tâche de fond l'horodatage `updated_at` et le hash `file_hash` des documents enregistrés localement.
  - Si une version plus récente existe sur le serveur, les fragments modifiés et l'index local sont mis à jour silencieusement.
  - Si un document a été supprimé sur le serveur, il est retiré du cache local.
  - Aucun téléchargement massif imprévu de documents tiers n'est déclenché sans accord utilisateur.

---

## 3. Exigences Techniques & Non-Fonctionnelles

### 3.1. Volumétrie & Quotas de Stockage
- **Base de référence :** ~70 à 100 documents, ~18 000 pages, poids moyen de 125 Mo par fichier (avec des fichiers individuels atteignant jusqu'à **500 Mo**).
- **Garantie de non-éviction :** L'application doit solliciter l'autorisation de persistance via `navigator.storage.persist()`.
- **Efficacité I/O :** Utilisation conjointe d'IndexedDB pour les blocs binaires (256 Ko) et de l'**Origin Private File System (OPFS)** pour la base de données locale, assurant des débits optimaux sur mobiles et tablettes sans saturer la mémoire vive (RAM).

### 3.2. Parité Rigoureuse de l'Index de Recherche
- Le paquet d'index de recherche exploité hors-ligne doit être **strictement identique** à celui du serveur Rust :
  - Même tokenizer et normalisation (suppression des diacritiques/accents Unicode, insensibilité casse).
  - Mêmes scores de pertinence BM25 multi-termes.
  - Mêmes coordonnées spatiales de bounding boxes (`words_json` avec `x0, y0, x1, y1`, `block_no`, `line_no`).

### 3.3. Détection Réseau Sans Ping Périodique
- Interdiction stricte des boucles de ping régulier (`setInterval(fetch(...), 3000)` proscrit pour préserver batterie et données mobiles).
- Détection basée exclusivement sur :
  1. Les événements système `window.addEventListener('online')` et `window.addEventListener('offline')`.
  2. L'interception passive des erreurs de fetch (TypeError `Failed to fetch`, timeout réseau à 3 secondes).

---

## 4. Critères d'Acceptation (Recette Fonctionnelle)

| Identifiant | Scénario de Test | Résultat Attendu |
| :--- | :--- | :--- |
| **AC-01** | Clic sur l'icône de cache d'un document de 300 Mo. | Le document passe à l'état de synchronisation avec suivi en direct, puis à l'état disponible hors-ligne. |
| **AC-02** | Coupure réseau simulée (Mode Avion) à 50% du téléchargement. | Le transfert se suspend sans crash. Au retour du réseau, le téléchargement reprend à 50% sans recommencer à zéro. |
| **AC-03** | Clic sur l'icône de cache d'un dossier parent contenant 5 sous-dossiers et 20 PDF. | Tous les documents de l'arborescence sont ajoutés à la file d'attente et mis en cache séquentiellement. |
| **AC-04** | Recherche en ligne avec la case `Hors-ligne uniquement` décochée. | Les résultats englobent tous les documents du fonds documentaire distant. |
| **AC-05** | Recherche en ligne avec la case `Hors-ligne uniquement` cochée. | Les résultats sont restreints aux seuls documents présents sur le disque local ; la latence est quasi-nulle. |
| **AC-06** | Passage en Mode Avion lors d'une session active. | L'application reste immédiatement navigable ; la recherche s'exécute sur le cache local avec le même ruban visuel Goodnotes (crops et surlignage jaune). |
| **AC-07** | Fermeture et réouverture du navigateur hors connexion. | L'application démarre instantanément (App Shell Service Worker) et permet la lecture des PDF mis en cache sans invite de connexion. |

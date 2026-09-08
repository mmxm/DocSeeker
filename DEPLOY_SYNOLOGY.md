# Guide de Déploiement DocSeeker sur NAS Synology

Ce guide vous explique comment déployer **DocSeeker** sur votre NAS Synology avec **Container Manager** (DSM 7.2+) ou **Docker** (DSM 7.0/7.1), **sans aucune compilation sur le NAS**.

---

## 🚀 Méthode 1 : Récupération Automatique via GitHub (ghcr.io - Recommandé)

À chaque `git push` sur la branche `main`, l'image est automatiquement compilée, testée et publiée sur **GitHub Container Registry** (`ghcr.io/mmxm/docseeker-app:latest`).

### Déploiement / Mise à jour en 1 clic sur le NAS :
1. Sur votre NAS dans `/docker/docseeker/`, déposez `docker-compose.yml`, `Caddyfile` et `.env` (disponibles dans [docseeker.zip](file:///Users/francois/Documents/DocFastExplorer/dist/docseeker.zip)).
2. Dans **Container Manager** > **Projet** > **Créer** (Chemin: `/docker/docseeker`).
3. Le NAS télécharge automatiquement la dernière image `latest` depuis GitHub et démarre !
4. **Pour les futures mises à jour :**
   Faites un clic droit sur le projet `docseeker` dans Container Manager > **Action** > **Mettre à jour** (ou *Extraire*). Le NAS télécharge la dernière image et redémarre instantanément.

---

## 📦 Méthode 2 : Import Manuel d'archive (0 connexion internet requise sur le NAS)

### Étape 1 : Générer l'archive de l'image sur votre ordinateur
Depuis le terminal de votre projet, lancez :
```bash
./scripts/export_image.sh amd64
```
*(Si votre NAS utilise une puce ARM comme le DS223, passez `arm64` au lieu de `amd64`).*

Cette commande crée automatiquement l'archive Docker tagguée avec le commit Git actuel :
📁 **`dist/docseeker-app-1.0.0-<commit>-amd64.tar.gz`** (environ 112 Mo).

### Étape 2 : Importer l'image dans Container Manager
1. Ouvrez **Container Manager** sur votre NAS Synology.
2. Cliquez sur l'onglet **Image** dans le menu de gauche.
3. Cliquez sur le bouton **Importer** > **Ajouter depuis un fichier**.
4. Sélectionnez le fichier `docseeker-app-1.0.0-<commit>-amd64.tar.gz` depuis votre ordinateur.
5. En quelques secondes, l'image `docseeker-app:1.0.0-<commit>` apparaît dans la liste de vos images sur DSM !

### Étape 3 : Déposer la configuration sur le NAS
Sur votre NAS, dans le dossier partagé `docker/`, déposez les fichiers de configuration (ou extrayez `docseeker.zip`) :
```text
/docker/docseeker/
├── docker-compose.yml
├── Caddyfile
└── .env
```
*(Le dossier `data/` est créé automatiquement au premier démarrage par le conteneur. Il n'est intentionnellement pas inclus dans l'archive afin que vos futures mises à jour ne risquent jamais d'écraser vos documents existants !)*

### Étape 4 : Lancer le projet
1. Dans **Container Manager**, allez dans **Projet** > **Créer**.
2. Nom : `docseeker`. Chemin : `/docker/docseeker`.
3. Validez et démarrez : comme l'image `docseeker-app:1.0.0` est déjà importée, **le NAS démarre les conteneurs instantanément sans rien compiler** !

---

## 🚀 Accès à l'application

Ouvrez votre navigateur :
```text
https://IP_DE_VOTRE_NAS:8443
```
* **Identifiants** : `admin` / `admin1234` *(personnalisable dans le `.env`)*.
* *Note* : Si vous utilisez l'IP locale du NAS, acceptez l'avertissement de sécurité du certificat autosigné de Caddy (*« Avancé > Continuer vers le site »*).

---

## 🛡️ Sauvegardes automatiques sur le NAS

Pour sauvegarder l'ensemble de vos documents et votre base d'indexation :
1. Ouvrez **Hyper Backup** sur DSM.
2. Créez une tâche de sauvegarde incluant le dossier :
   ```text
   /docker/docseeker/data
   ```
Toutes vos données (fichiers originaux, vignettes, recadrages et base de données SQLite) seront sauvegardées de façon cohérente sans couper le service.

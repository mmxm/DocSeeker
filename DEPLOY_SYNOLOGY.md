# Guide de Déploiement DocSeeker v2.0 sur NAS Synology

Ce guide vous explique comment déployer **DocSeeker v2.0** (Backend Rust & Authentification Native) sur votre NAS Synology avec **Container Manager** (DSM 7.2+) ou **Docker** (DSM 7.0/7.1), **sans aucune compilation sur le NAS**.

---

## 🚀 Déploiement / Mise à Jour Automatique via GitHub (GHCR)

L'image est automatiquement compilée et publiée sur **GitHub Container Registry** (`ghcr.io/mmxm/docseeker-app:latest`).

### 1. Fichiers à déposer sur le NAS
Sur votre NAS dans le dossier partagé (ex: `/docker/docseeker/`), vous n'avez besoin que de **2 fichiers** :

```text
/docker/docseeker/
├── docker-compose.yml
└── .env
```
*(Plus aucun `Caddyfile` n'est nécessaire ! Vous pouvez supprimer l'ancien `Caddyfile` s'il est présent sur le NAS).*

### 2. Configuration du fichier `.env` sur le NAS :
```env
# Mot de passe administrateur en clair (l'application le hache automatiquement en Argon2id)
ADMIN_PASSWORD=VotreMotDePasseSecret123!

# Port d'écoute hôte
HOST_HTTP_PORT=8080

# PUID/PGID Synology (généralement 1026:100 sur DSM)
PUID=1026
PGID=100
```

### 3. Démarrer ou Mettre à jour sur le NAS :
- **Dans Container Manager** :
  1. Allez dans **Projet** > sélectionnez `docseeker`.
  2. Cliquez sur **Action** > **Mettre à jour** (ou *Extraire* la dernière image).
  3. Le NAS télécharge l'image Rust allégée et redémarre instantanément.
- **Ou en SSH** :
  ```bash
  cd /volume1/docker/docseeker
  docker compose pull
  docker compose up -d
  ```

---

## 🌐 Accès à l'application

Ouvrez votre navigateur :
```text
http://IP_DE_VOTRE_NAS:8080
```
*(Ou votre URL HTTPS si vous utilisez le Reverse Proxy Synology intégré dans Panneau de Configuration > Portail de connexion > Avancé).*

- **Connexion** : Saisissez votre mot de passe configuré dans `ADMIN_PASSWORD`.
- **Mémoire** : L'empreinte RAM sur votre NAS est désormais inférieure à 50 Mo (au lieu de plusieurs centaines de Mo auparavant avec Python + Caddy).

---

## 🛡️ Sauvegardes sur le NAS

Pour sauvegarder l'ensemble de vos documents et votre base d'indexation :
1. Ouvrez **Hyper Backup** sur DSM.
2. Créez une tâche de sauvegarde incluant le dossier :
   ```text
   /docker/docseeker/data
   ```
Toutes vos données (PDF originaux, vignettes et base SQLite FTS5) sont dans ce dossier unique.

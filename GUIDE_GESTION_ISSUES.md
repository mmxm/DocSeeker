# Guide de Gestion des Bugs avec `git-bug` — DocSeeker

Le suivi des anomalies et régressions de **DocSeeker** est géré directement via [**`git-bug`**](https://github.com/git-bug/git-bug), un outil de bug tracking 100% décentralisé, offline et embarqué dans le dépôt Git.

Les bugs sont stockés dans les objets internes Git (`refs/bugs/`) et ne polluent pas l'arbre des fichiers source.

---

## 🔄 Cycle de Vie des Bugs (Workflow à 3 États)

Pour garantir une double vérification systématique (*Four-Eyes Principle*), la clôture d'un bug respecte 3 étapes strictes :

```
[ 1. Ouvert ] --------(Dev: Correctif + TU)-------> [ 2. Corrigé par Dev ] --------(QA: Recette Globale)-------> [ 3. Validé & Fermé ]
  status:ouvert                                        status:corrige-dev                                           status:valide-qa
  (Responsable: QA)                                    (Responsable: Dev)                                           (Responsable: QA)
```

| Étape | Statut `git-bug` | Label de workflow | Responsable | Action |
|---|---|---|---|---|
| **1. Ouvert** | `open` | `status:ouvert` | **QA** | Le QA identifie le bug, écrit le test unitaire manquant démontrant la faille, et ouvre le ticket. |
| **2. Corrigé Dev** | `open` | `status:corrige-dev` | **Développeur** | Le dev code le correctif, vérifie que le test du QA passe en vert, met à jour le label et commente le commit. |
| **3. Validé QA** | `closed` | `status:valide-qa` | **QA** | Le QA rejoue la suite complète (`./run_tests.sh`), valide la non-régression, met à jour le label et **ferme définitivement l'issue**. |

---

## 1. Consulter les Bugs et les Files d'Attente

- **Pour les Développeurs : Voir les bugs à traiter** :
  ```bash
  git-bug bug -l status:ouvert
  ```

- **Pour le QA : Voir les correctifs prêts à être validés** :
  ```bash
  git-bug bug -l status:corrige-dev
  ```

- **Lister tous les bugs ouverts (tous statuts confondus)** :
  ```bash
  git-bug bug
  ```

- **Afficher le détail complet d'un bug (reproduction, test associé)** :
  ```bash
  git-bug bug show <ID_DU_BUG>
  # Exemple : git-bug bug show ffcaba1
  ```

---

## 2. Interfaces Graphiques Interactives

Pour visualiser les bugs sous forme d'interface visuelle :

- **Interface Web Locale dans le navigateur** :
  ```bash
  git-bug webui
  ```
  *(Ouvre automatiquement un tableau de bord local sur `http://localhost:port` avec recherche et filtres par labels)*.

- **Interface Terminal Interactive (TUI)** :
  ```bash
  git-bug termui
  ```

---

## 3. Guide Développeur : Corriger un Bug pas à pas

1. **Choisir un bug dans la file d'attente** :
   ```bash
   git-bug bug -l status:ouvert
   git-bug bug show <ID_DU_BUG>
   ```
2. **Créer une branche Git dédiée** :
   ```bash
   git checkout -b fix/issue-<ID_DU_BUG>
   ```
3. **Appliquer la correction et vérifier le test unitaire du QA** :
   ```bash
   # Exécuter le test ciblé fourni par le QA dans la description du bug
   PYTHONPATH=. ./venv/bin/pytest tests/test_qa_business_bugs_hunter.py -k "<NOM_DU_TEST>"
   ```
4. **Valider la non-régression globale et la sécurité** :
   ```bash
   ./run_tests.sh
   ```
5. **Committer la correction** :
   ```bash
   git add backend/
   git commit -m "fix: resolve issue <ID_DU_BUG>"
   ```
6. **Passer le témoin au QA (Transition vers Corrigé par Dev)** :
   ```bash
   # 1. Retirer le statut ouvert
   git-bug bug label rm <ID_DU_BUG> status:ouvert

   # 2. Ajouter le statut corrigé par dev
   git-bug bug label new <ID_DU_BUG> status:corrige-dev

   # 3. Ajouter un commentaire avec le hash du commit
   git-bug bug comment new <ID_DU_BUG> -m "Corrigé dans le commit $(git rev-parse --short HEAD). Tests unitaires validés, prêt pour recette QA."
   ```
7. **Merger sur `main`** :
   ```bash
   git checkout main
   git merge --no-ff fix/issue-<ID_DU_BUG>
   git branch -d fix/issue-<ID_DU_BUG>
   ```

> ⚠️ **Important pour les développeurs** : Ne fermez **JAMAIS** le statut à `closed` vous-même ! La clôture finale est réservée au QA après recette de confirmation.

---

## 4. Guide QA : Valider et Fermer un Bug

1. **Consulter la file des correctifs en attente** :
   ```bash
   git-bug bug -l status:corrige-dev
   ```
2. **Exécuter la recette complète sur `main`** :
   ```bash
   git checkout main
   git pull
   ./run_tests.sh
   ```
3. **Si le test passe et aucune régression n'apparaît (Clôture)** :
   ```bash
   # 1. Remplacer le label
   git-bug bug label rm <ID_DU_BUG> status:corrige-dev
   git-bug bug label new <ID_DU_BUG> status:valide-qa

   # 2. Clôturer officiellement l'issue
   git-bug bug status close <ID_DU_BUG>

   # 3. Commentaire de clôture
   git-bug bug comment new <ID_DU_BUG> -m "Vérifié et validé par QA : tests au vert et non-régression confirmée."
   ```
4. **Si le bug persiste ou s'il y a régression (Rejet)** :
   ```bash
   git-bug bug label rm <ID_DU_BUG> status:corrige-dev
   git-bug bug label new <ID_DU_BUG> status:ouvert
   git-bug bug comment new <ID_DU_BUG> -m "Rejet QA : Le bug persiste lors du test X ou entraîne la régression Y."
   ```

---

## 5. Résumé des Rôles

- **Ingénieur QA** :
  - Identifie les failles de sécurité, régressions et bugs fonctionnels/métiers.
  - Implémente systématiquement le test unitaire manquant démontrant le bug.
  - Ouvre l'issue avec `status:ouvert`.
  - Recette les correctifs des développeurs (`status:corrige-dev`).
  - Clôture l'issue (`status:valide-qa` + `status closed`).
  - **Ne modifie pas le code applicatif**.

- **Développeurs** :
  - Prennent en charge les tickets étiquetés `status:ouvert`.
  - Implémentent les correctifs dans le code source applicatif (`backend/`).
  - Font passer au vert les tests fournis par le QA.
  - Passent le ticket en `status:corrige-dev` sans le fermer.

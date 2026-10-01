import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import init, {
  initSync,
  get_schema_sql,
  build_search_sql_wasm,
  build_search_sql_with_folders_wasm,
  build_title_search_sql_wasm,
  build_title_search_sql_with_folders_wasm,
  get_subfolder_ids_sql_wasm,
  build_doc_search_sql_wasm,
  calculate_crop_bounds_wasm,
  find_occurrences_wasm,
  batch_find_and_process_doc_occurrences_wasm,
  process_search_results_wasm,
  get_shared_constants_wasm,
} from "../frontend/wasm/search_wasm/search_wasm.js";

console.log("===============================================================================");
console.log(" TEST AUTOMATISÉ PROTOCOLE WASM & MOTEUR HORS-LIGNE (VOLUMES RÉELS & SCORING) ");
console.log("===============================================================================");

// 1. Initialisation du module Wasm compilé depuis search-core
const wasmPath = path.resolve("./frontend/wasm/search_wasm/search_wasm_bg.wasm");
const wasmBuffer = fs.readFileSync(wasmPath);
initSync({ module: wasmBuffer });
console.log("✅ Module search_wasm initialisé avec succès.");

// 2. Vérification du schéma SQL partagé
const schemaSql = get_schema_sql();
assert.ok(schemaSql.length > 500, "Le schéma SQL doit être non vide");
assert.ok(schemaSql.includes("pages_fts USING fts5"), "Le schéma doit contenir la table FTS5");
assert.ok(schemaSql.includes("TRIGGER IF NOT EXISTS pages_ai"), "Le schéma doit contenir les triggers FTS5");

// 3. Création de la base SQLite locale cliente simulée (exactement comme sqlite3.wasm dans le navigateur)
const clientDb = new DatabaseSync(":memory:");
clientDb.exec("PRAGMA foreign_keys = OFF;");
clientDb.exec(schemaSql);
console.log("✅ Instance SQLite locale cliente initialisée avec le schéma unifié.");

// 4. Ingestion depuis la base médicale réelle (data/db.sqlite)
const realDbPath = path.resolve("./data/db.sqlite");
if (!fs.existsSync(realDbPath)) {
  console.warn("⚠️  data/db.sqlite non trouvé, test limité.");
  process.exit(0);
}

const realDb = new DatabaseSync(realDbPath, { readOnly: true });
const totalDocsReal = realDb.prepare("SELECT count(*) as count FROM documents").get().count;
const totalPagesReal = realDb.prepare("SELECT count(*) as count FROM pages").get().count;
console.log(`📦 Base réelle ouverte : ${totalDocsReal} documents, ${totalPagesReal} pages médicales.`);

// Ingestion préalable des dossiers
const realFolders = realDb.prepare("SELECT id, name, parent_id, color FROM folders").all();
const insertFolderStmt = clientDb.prepare("INSERT OR REPLACE INTO folders (id, name, parent_id, color) VALUES (?, ?, ?, ?)");
for (const f of realFolders) {
  insertFolderStmt.run(f.id, f.name, f.parent_id, f.color || '#3b82f6');
}

// Sélection des documents médicaux pertinents pour le test réaliste
const realDocs = realDb.prepare(`
  SELECT id, filename, title, file_hash, folder_id, total_pages, file_size, created_at, updated_at
  FROM documents
  WHERE status = 'ready' AND (filename LIKE '%grossesse%' OR title LIKE '%grossesse%')
  LIMIT 6
`).all();

console.log(`Ingestion de ${realDocs.length} livres/documents médicaux réels dans le moteur offline...`);

let totalPagesIngested = 0;
const insertDocStmt = clientDb.prepare(`
  INSERT OR REPLACE INTO documents 
  (id, filename, title, file_hash, folder_id, status, total_pages, file_size, created_at, updated_at) 
  VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)
`);

const insertPageStmt = clientDb.prepare(`
  INSERT INTO pages (doc_id, page_number, text_content, words_json) 
  VALUES (?, ?, ?, ?)
`);

for (const doc of realDocs) {
  insertDocStmt.run(
    doc.id,
    doc.filename,
    doc.title || doc.filename,
    doc.file_hash,
    doc.folder_id,
    doc.total_pages,
    doc.file_size,
    doc.created_at,
    doc.updated_at
  );

  const pages = realDb.prepare(`
    SELECT page_number, text_content, words_json 
    FROM pages 
    WHERE doc_id = ?
    LIMIT 50
  `).all(doc.id);

  for (const page of pages) {
    insertPageStmt.run(doc.id, page.page_number, page.text_content, page.words_json);
    totalPagesIngested++;
  }
}

console.log(`✅ ${totalPagesIngested} pages réelles insérées.`);

// Vérifier l'alimentation automatique de l'index FTS5 via les triggers
const ftsCount = clientDb.prepare("SELECT count(*) as count FROM pages_fts").get().count;
assert.equal(ftsCount, totalPagesIngested, "Chaque page doit être indexée dans pages_fts");
console.log(`✅ Trigger FTS5 pages_ai validé : ${ftsCount} pages indexées.`);

// 5. Recherche FTS5 + BM25 avec Wasm (build_search_sql_wasm)
console.log("\n--- TEST RECHERCHE FTS5 & SCORING STRICT ---");
const searchSqlJson = build_search_sql_wasm("grossesse", null, 10, 0);
const searchData = JSON.parse(searchSqlJson);
assert.ok(searchData.sql && searchData.sql.length > 0);
assert.deepEqual(searchData.terms, ["grossesse"]);

const rows = clientDb.prepare(searchData.sql).all();
assert.ok(rows.length > 0, "La recherche doit retourner des résultats pertinents");
console.log(`Résultats bruts trouvés : ${rows.length} lignes de pages correspondantes.`);

// Regroupement par document et validation des scores
const docsMap = new Map();
for (const r of rows) {
  if (!docsMap.has(r.doc_id)) {
    docsMap.set(r.doc_id, {
      id: r.doc_id,
      filename: r.filename,
      title: r.title,
      doc_relevance_score: r.doc_relevance_score,
      matching_pages_count: r.matching_pages_count,
      best_page_bm25: r.page_bm25,
      pages: []
    });
  }
  const d = docsMap.get(r.doc_id);
  d.pages.push({ page_number: r.page_number, page_bm25: r.page_bm25, words_json: r.words_json });
  if (r.page_bm25 < d.best_page_bm25) {
    d.best_page_bm25 = r.page_bm25;
  }
}

const docResults = Array.from(docsMap.values());
console.log(`Documents uniques trouvés : ${docResults.length}`);

// Vérification de l'ordre strictement décroissant de pertinence
for (let i = 1; i < docResults.length; i++) {
  assert.ok(
    docResults[i - 1].doc_relevance_score >= docResults[i].doc_relevance_score,
    `Tri incorrect à l'index ${i} : ${docResults[i - 1].doc_relevance_score} < ${docResults[i].doc_relevance_score}`
  );
}
console.log("✅ Tri par pertinence strictement décroissant vérifié.");

// Vérification de la formule mathématique Goodnotes
for (const doc of docResults) {
  const titleMatch = (
    doc.filename.toLowerCase().includes("grossesse") || 
    doc.title.toLowerCase().includes("grossesse")
  );
  const expectedTitleBonus = titleMatch ? 1500.0 : 0.0;
  const expectedDensityBonus = Math.min(doc.matching_pages_count * 5.0, 300.0);
  const bm25Component = Math.abs(doc.best_page_bm25) * 100.0;
  const theoreticalScore = expectedTitleBonus + bm25Component + expectedDensityBonus;

  // L'écart entre le score SQL et le calcul théorique doit être inférieur à 0.01
  const diff = Math.abs(doc.doc_relevance_score - theoreticalScore);
  assert.ok(
    diff < 0.01,
    `Écart de score anormal pour doc ${doc.id}: SQL=${doc.doc_relevance_score} vs Théorie=${theoreticalScore}`
  );

  console.log(`  📄 Doc #${doc.id} "${doc.filename.substring(0, 35)}..." : score=${doc.doc_relevance_score.toFixed(2)} [Titre=+${expectedTitleBonus}, BM25=+${bm25Component.toFixed(2)}, Pages=+${expectedDensityBonus}]`);
}
console.log("✅ Respect mathématique de la formule de score Goodnotes validé à 100%.");

// 6. Test de l'algorithme spatial d'occurrences Wasm (find_occurrences_wasm)
console.log("\n--- TEST SPATIAL D'OCCURRENCES & CLUSTERING ---");
const samplePage = docResults[0].pages[0];
if (samplePage && samplePage.words_json) {
  const occsRaw = find_occurrences_wasm(
    samplePage.words_json,
    JSON.stringify(["grossesse"]),
    searchData.query_hash,
    BigInt(docResults[0].id),
    BigInt(samplePage.page_number),
    samplePage.page_bm25,
    842.0
  );

  const occs = JSON.parse(occsRaw);
  assert.ok(occs.length > 0, "L'algorithme spatial doit détecter les occurrences sur la page");
  for (const occ of occs) {
    assert.ok(occ.rect[2] > occ.rect[0], "Coordonnées X valides");
    assert.ok(occ.rect[3] > occ.rect[1], "Coordonnées Y valides");
    assert.ok(occ.crop_url.startsWith("/api/crop/"), "URL de crop formatée");
    assert.ok(occ.highlight_rects.length > 0, "Au moins un rectangle de surlignage");
  }
  console.log(`✅ ${occs.length} occurrence(s) spatiale(s) extraite(s) avec succès pour la page ${samplePage.page_number}.`);
}

// 7. Test du calcul de recadrage Wasm (calculate_crop_bounds_wasm)
console.log("\n--- TEST RECADRAGE SPATIAL (CROP BOUNDS) ---");
const cropJson = calculate_crop_bounds_wasm(120.0, 200.0, 180.0, 215.0, 595.0, 842.0, 300.0, 120.0);
const crop = JSON.parse(cropJson);
assert.equal(crop.width, 300.0);
assert.equal(crop.height, 120.0);
assert.ok(crop.x0 >= 0 && crop.x1 <= 595.0);
assert.ok(crop.y0 >= 0 && crop.y1 <= 842.0);
console.log(`✅ Calcul de crop validé : [${crop.x0}, ${crop.y0}, ${crop.x1}, ${crop.y1}] (Dimensions: ${crop.width}x${crop.height}).`);

// 8. Test de la recherche par titre (build_title_search_sql_wasm)
console.log("\n--- TEST RECHERCHE PAR TITRE ---");
const titleSqlJson = build_title_search_sql_wasm("grossesse", null, 10, 0);
const titleData = JSON.parse(titleSqlJson);
const titleMatches = clientDb.prepare(titleData.sql).all();
assert.equal(titleMatches.length, realDocs.length, `Tous les ${realDocs.length} documents doivent correspondre au titre 'grossesse'`);
console.log(`✅ Recherche par titre : ${titleMatches.length}/${realDocs.length} documents trouvés.`);

// 8 bis. Test de la recherche par sous-mots / mots composés dans les titres (calcé / calce dans Hypercalcémie)
insertDocStmt.run(88801, "268_ecg_hypercalcemie.pdf", "268 - ECG - Hypercalcémie", "hash88801", null, 2, 1024, new Date().toISOString(), new Date().toISOString());
insertDocStmt.run(88802, "268_hypercalcemie_hypocalcemie.pdf", "268 - Hypercalcémie - Hypocalcémie", "hash88802", null, 7, 2048, new Date().toISOString(), new Date().toISOString());

const calceAccentJson = build_title_search_sql_wasm("calcé", null, 10, 0);
const calceAccentData = JSON.parse(calceAccentJson);
const calceAccentMatches = clientDb.prepare(calceAccentData.sql).all();
assert.ok(calceAccentMatches.length >= 2, "Doit trouver au moins les 2 documents Hypercalcémie avec 'calcé'");
assert.ok(calceAccentMatches.some(d => d.id === 88801) && calceAccentMatches.some(d => d.id === 88802));
console.log(`✅ Recherche par mot-clé sous-chaîne accentué ('calcé') : ${calceAccentMatches.length} document(s) trouvé(s).`);

const calceNoAccentJson = build_title_search_sql_wasm("calce", null, 10, 0);
const calceNoAccentData = JSON.parse(calceNoAccentJson);
const calceNoAccentMatches = clientDb.prepare(calceNoAccentData.sql).all();
assert.ok(calceNoAccentMatches.length >= 2, "Doit trouver au moins les 2 documents Hypercalcémie avec 'calce'");
assert.ok(calceNoAccentMatches.some(d => d.id === 88801) && calceNoAccentMatches.some(d => d.id === 88802));
console.log(`✅ Recherche par mot-clé sous-chaîne sans accent ('calce') : ${calceNoAccentMatches.length} document(s) trouvé(s).`);

// 9. Test de la recherche interne à un document (build_doc_search_sql_wasm)
console.log("\n--- TEST RECHERCHE AU SEIN D'UN DOCUMENT ---");
const docSearchJson = build_doc_search_sql_wasm(BigInt(docResults[0].id), "grossesse");
const docSearchData = JSON.parse(docSearchJson);
const docMatches = clientDb.prepare(docSearchData.sql).all();
assert.ok(docMatches.length > 0, "Doit trouver des pages pour ce document");

// Test de traitement en lot Wasm (batch_find_and_process_doc_occurrences_wasm)
const batchRows = docMatches.map(r => [Number(r.page_number), r.words_json, Number(r.page_bm25) || 0.0]);
const batchResultJson = batch_find_and_process_doc_occurrences_wasm(
  JSON.stringify(batchRows),
  JSON.stringify(docSearchData.terms),
  docSearchData.query_hash,
  BigInt(docResults[0].id),
  842.0,
  null,
  null
);
const batchResult = JSON.parse(batchResultJson);
assert.ok(batchResult.total_occurrences > 0, "Le traitement batch Wasm doit trouver des occurrences");
assert.ok(batchResult.occurrences.length > 0, "Le traitement batch Wasm doit retourner des occurrences");
console.log(`✅ Traitement batch Wasm intra-document validé : ${batchResult.total_occurrences} occurrence(s) extraite(s) en 1 seul appel.`);

// 9 bis. Test spécifique de la recherche intra-document avec caractères accentués (fréquent, hémorragie)
console.log("\n--- TEST RECHERCHE INTRA-DOCUMENT AVEC ACCENTS (FRÉQUENT & HÉMORRAGIE) ---");
const testAccentedDocId = 999999n;
insertDocStmt.run(
  Number(testAccentedDocId),
  "test_accents.pdf",
  "Document Test Accents",
  "hash_accents",
  null,
  3,
  1024,
  new Date().toISOString(),
  new Date().toISOString()
);

const wordsAccented = JSON.stringify([
  [100.0, 200.0, 150.0, 215.0, "Fréquent", 0, 1],
  [155.0, 200.0, 220.0, 215.0, "symptôme", 0, 1],
  [100.0, 230.0, 180.0, 245.0, "Hémorragie", 0, 2],
  [185.0, 230.0, 240.0, 245.0, "aiguë", 0, 2]
]);

insertPageStmt.run(
  Number(testAccentedDocId),
  3,
  "Tableau clinique : Fréquent symptôme. Risque d'hémorragie aiguë.",
  wordsAccented
);

// Recherche avec "fréquent"
const docSearchAccentedJson = build_doc_search_sql_wasm(testAccentedDocId, "fréquent");
const docSearchAccentedData = JSON.parse(docSearchAccentedJson);
const accentedMatches = clientDb.prepare(docSearchAccentedData.sql).all();
assert.ok(accentedMatches.length > 0, "Doit trouver la page 3 pour la recherche 'fréquent'");

const batchAccentedResult = JSON.parse(batch_find_and_process_doc_occurrences_wasm(
  JSON.stringify(accentedMatches.map(r => [Number(r.page_number), r.words_json, Number(r.page_bm25) || 0.0])),
  JSON.stringify(docSearchAccentedData.terms),
  docSearchAccentedData.query_hash,
  testAccentedDocId,
  842.0,
  null,
  null
));
assert.ok(batchAccentedResult.total_occurrences > 0, "Le traitement Wasm doit extraire l'occurrence 'fréquent'");
assert.equal(batchAccentedResult.occurrences[0].page_number, 3);
console.log(`✅ Recherche intra-document avec accent ('fréquent') validée : ${batchAccentedResult.total_occurrences} occurrence(s) sur page 3.`);

// Recherche avec "hémorragie"
const docSearchHemoJson = build_doc_search_sql_wasm(testAccentedDocId, "hémorragie");
const docSearchHemoData = JSON.parse(docSearchHemoJson);
const hemoMatches = clientDb.prepare(docSearchHemoData.sql).all();
assert.ok(hemoMatches.length > 0, "Doit trouver la page 3 pour 'hémorragie'");
console.log(`✅ Recherche intra-document avec accent ('hémorragie') validée : ${hemoMatches.length} page(s) trouvée(s).`);

// 10. Test de non-régression & Parité Absolue : 'insuffisance rénale aigue' dans Néphrologie (doc #544)
console.log("\n--- TEST PARITÉ STRICTE HORS-LIGNE : 'insuffisance rénale aigue' DANS NÉPHROLOGIE (#544) ---");
const nephroDoc = realDb.prepare("SELECT id, filename, title, file_hash, folder_id, total_pages, file_size, created_at, updated_at FROM documents WHERE id = 544").get();
if (nephroDoc) {
  insertDocStmt.run(
    nephroDoc.id,
    nephroDoc.filename,
    nephroDoc.title || nephroDoc.filename,
    nephroDoc.file_hash,
    nephroDoc.folder_id,
    nephroDoc.total_pages,
    nephroDoc.file_size,
    nephroDoc.created_at,
    nephroDoc.updated_at
  );

  const nephroPages = realDb.prepare("SELECT page_number, text_content, words_json FROM pages WHERE doc_id = 544").all();
  for (const p of nephroPages) {
    insertPageStmt.run(nephroDoc.id, p.page_number, p.text_content, p.words_json);
  }
  console.log(`Ingéré Néphrologie (${nephroPages.length} pages) dans la base cliente locale.`);

  const nephroQueryStr = "insuffisance rénale aigue";
  const nephroSearchData = JSON.parse(build_search_sql_wasm(nephroQueryStr, null, 15, 0));
  const nephroRows = clientDb.prepare(nephroSearchData.sql).all();
  assert.ok(nephroRows.length > 0, "Doit trouver des lignes pour 'insuffisance rénale aigue'");

  // Appel direct de la fonction Rust WebAssembly unifiée (search-core)
  const processedResultsJson = process_search_results_wasm(
    JSON.stringify(nephroRows),
    JSON.stringify(nephroSearchData.terms),
    nephroSearchData.query_hash
  );
  const processedResults = JSON.parse(processedResultsJson);
  assert.ok(processedResults.length > 0, "Doit retourner des résultats de documents");

  const nephroResult = processedResults.find(d => d.id === 544);
  assert.ok(nephroResult, "Le document 544 Néphrologie doit être présent dans les résultats");

  const ribbonVignettes = nephroResult.vignettes;
  console.log(`Nombre de vignettes dans le ruban : ${ribbonVignettes.length}`);
  assert.equal(ribbonVignettes.length, 25, "Le ruban doit comporter exactement 25 vignettes (MAX_OCCURRENCES_PER_DOC)");

  const firstVignette = ribbonVignettes[0];
  console.log(`Première vignette : Page ${firstVignette.page_number}, font_size=${firstVignette.font_size}, texte="${firstVignette.text_snippet}"`);

  // Vérifications capitales
  assert.ok(firstVignette.page_number === 243 || firstVignette.page_number === 267, "La première vignette doit être sur la page du chapitre (243 ou 267)");
  assert.ok(firstVignette.text_snippet.toUpperCase().includes("INSUFFISANCE RÉNALE AIGUË"), "La première vignette doit être le grand titre de chapitre");
  assert.ok(firstVignette.font_size > 18.0, "La police du titre doit être de taille supérieure à 18");
  console.log(`✅ Parité absolue validée via process_search_results_wasm : Titre p. ${firstVignette.page_number} en 1ère vignette et 25 vignettes générées !`);
}

// 5. Test spécifique de migration de schéma rétrocompatible (ex: doc_type manquant sur base OPFS client existante)
console.log("\n--- TEST MIGRATION ET RÉSILIENCE doc_type SUR BASE HÉRITÉE ---");
const legacyDb = new DatabaseSync(":memory:");
legacyDb.exec(`
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    title TEXT,
    folder_id INTEGER,
    total_pages INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'ready'
  );
  INSERT INTO documents (id, filename, title, folder_id, total_pages, file_size)
  VALUES (1, 'legacy.pdf', 'Legacy PDF Document', 10, 10, 1024);
`);

// Simulation de ensureColumn et de la migration
function ensureColumnNode(db, table, column, colType) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some(c => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${colType}`);
  }
}

// Vérifier que doc_type est absent initialement
let tableInfo = legacyDb.prepare("PRAGMA table_info(documents)").all();
assert.equal(tableInfo.some(c => c.name === "doc_type"), false, "La base legacy ne doit pas avoir doc_type initialement");

// Appliquer la migration comme le fait le worker
ensureColumnNode(legacyDb, "documents", "doc_type", "TEXT DEFAULT 'pdf'");

// Vérifier que doc_type est maintenant présent
tableInfo = legacyDb.prepare("PRAGMA table_info(documents)").all();
assert.equal(tableInfo.some(c => c.name === "doc_type"), true, "doc_type doit exister après la migration");

// Vérifier que la requête getAllCachedDocuments s'exécute sans erreur
const cachedDocs = legacyDb.prepare(`
  SELECT id, filename, title, folder_id, total_pages, file_size, created_at, updated_at, COALESCE(doc_type, 'pdf') as doc_type
  FROM documents WHERE status != 'meta-only' ORDER BY title ASC
`).all();

assert.equal(cachedDocs.length, 1);
assert.equal(cachedDocs[0].doc_type, 'pdf');
console.log("✅ Migration automatique de doc_type et requête getAllCachedDocuments validées avec succès !");

// 6. Test de résolution récursive des sous-dossiers et recherche locale offline
console.log("\n--- TEST RÉSOLUTION RÉCURSIVE DES DOSSIERS & RECHERCHE HORS-LIGNE ---");
const subfolderSql = get_subfolder_ids_sql_wasm();
assert.ok(subfolderSql.includes("WITH RECURSIVE subfolders"), "get_subfolder_ids_sql_wasm doit retourner la CTE récursive");

// Créer une hiérarchie de dossiers de test : Parent(900) -> Enfant(901) -> Petit-enfant(902)
const folderStmt = clientDb.prepare("INSERT OR REPLACE INTO folders (id, name, parent_id, color) VALUES (?, ?, ?, ?)");
folderStmt.run(900, "Dossier Parent Racine", null, "#3b82f6");
folderStmt.run(901, "Sous-dossier Niveau 1", 900, "#3b82f6");
folderStmt.run(902, "Sous-dossier Niveau 2", 901, "#3b82f6");
folderStmt.run(903, "Autre Dossier Indépendant", null, "#ef4444");

// Tester la résolution récursive des IDs de dossiers
const resolvedFolderRows = clientDb.prepare(subfolderSql).all(900);
const resolvedFolderIds = resolvedFolderRows.map(r => r.id);
assert.deepEqual(resolvedFolderIds.sort(), [900, 901, 902].sort(), "La CTE récursive doit trouver le parent et tous ses descendants");

// Insérer un document dans le sous-dossier le plus profond (902)
insertDocStmt.run(
  9999,
  "guide_diagnostic_foie.pdf",
  "Guide Diagnostic Hépatite",
  "hash_9999",
  902, // Réside dans le sous-dossier 902
  1,
  2048,
  "2026-01-01",
  "2026-01-01"
);
insertPageStmt.run(9999, 1, "Diagnostic de l'hépatite virale et suivi clinique", "[]");

// Ancien comportement : build_search_sql_wasm avec folder_id = 900 uniquement
const oldSqlJson = build_search_sql_wasm("hépatite", BigInt(900), 10, 0);
const oldSqlData = JSON.parse(oldSqlJson);
const oldResults = clientDb.prepare(oldSqlData.sql).all();
assert.equal(oldResults.length, 0, "L'ancienne recherche limitée au dossier direct 900 doit rater le document dans 902");

// Nouveau comportement : build_search_sql_with_folders_wasm avec tous les IDs résolus [900, 901, 902]
const newSqlJson = build_search_sql_with_folders_wasm("hépatite", JSON.stringify(resolvedFolderIds), 10, 0);
const newSqlData = JSON.parse(newSqlJson);
assert.ok(newSqlData.sql.includes("d.folder_id IN (900,901,902)") || newSqlData.sql.includes("d.folder_id IN (900, 901, 902)") || newSqlData.sql.includes("folder_id IN"), "Le SQL doit filtrer sur IN (...)");

const newResults = clientDb.prepare(newSqlData.sql).all();
assert.equal(newResults.length, 1, "La nouvelle recherche récursive doit trouver le document dans le sous-dossier");
assert.equal(newResults[0].doc_id, 9999);
assert.equal(newResults[0].title, "Guide Diagnostic Hépatite");

// Test de la recherche par titre avec plusieurs dossiers
const subfolderTitleSqlJson = build_title_search_sql_with_folders_wasm("Guide Diagnostic", JSON.stringify(resolvedFolderIds), 10, 0);
const subfolderTitleSqlData = JSON.parse(subfolderTitleSqlJson);
const subfolderTitleResults = clientDb.prepare(subfolderTitleSqlData.sql).all();
assert.equal(subfolderTitleResults.length, 1, "La recherche par titre doit également inclure les sous-dossiers");
assert.equal(subfolderTitleResults[0].id, 9999);

console.log("✅ Résolution récursive des sous-dossiers et filtrage IN (...) validés avec succès !");

// 13. Test indexation d'une note Markdown avec folder_id dans SQLite client
console.log("\n--- TEST INDEXATION ET RECHERCHE NOTE MARKDOWN DANS UN DOSSIER ---");
const mdInsertStmt = clientDb.prepare(`
  INSERT INTO documents (id, filename, title, folder_id, total_pages, file_size, status, doc_type, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, 1, ?5, 'ready', 'markdown', ?6, ?6)
  ON CONFLICT(id) DO UPDATE SET
    filename = excluded.filename,
    title = excluded.title,
    folder_id = COALESCE(excluded.folder_id, documents.folder_id),
    file_size = excluded.file_size,
    status = 'ready',
    doc_type = 'markdown',
    updated_at = excluded.updated_at
`);
const mdDocId = 8888;
const mdFilename = "Cardiologie/HTA_recommandations.md";
const mdTitle = "HTA recommandations";
const mdFolderId = 901; // Sous-dossier Hépatologie & Gastro
const mdContent = "# HTA et Recommandations\n\nPrise en charge de l'hypertension artérielle résistante.";

mdInsertStmt.run(mdDocId, mdFilename, mdTitle, mdFolderId, mdContent.length, "2026-02-01");
insertPageStmt.run(mdDocId, 1, "Prise en charge de l'hypertension artérielle résistante", "[]");

// Vérifier que le document a bien été enregistré avec doc_type = 'markdown' et folder_id = 901
const insertedMd = clientDb.prepare("SELECT id, filename, title, folder_id, doc_type FROM documents WHERE id = ?").get(mdDocId);
assert.equal(insertedMd.doc_type, "markdown");
assert.equal(insertedMd.folder_id, 901);

// Vérifier la recherche récursive sur le dossier parent 900
const mdSearchSql = JSON.parse(build_search_sql_with_folders_wasm("hypertension", JSON.stringify(resolvedFolderIds), 10, 0));
const mdSearchResults = clientDb.prepare(mdSearchSql.sql).all();
assert.equal(mdSearchResults.length, 1);
assert.equal(mdSearchResults[0].doc_id, mdDocId);
console.log("✅ Indexation et recherche de note Markdown dans un dossier validées avec succès !");

// 14. Test recherche globale d'une note par son titre (sans cocher 'Titres', 0 occurrence dans le corps)
console.log("\n--- TEST RECHERCHE GLOBALE PAR TITRE SANS COCHER 'TITRES' (EX: NOTE PAR SON NOM) ---");
const noteDocId = 7777;
const noteFilename = "Notes/Ma première note 1.md";
const noteTitle = "Ma première note 1";
const noteFolderId = 900;
const noteContent = "Contenu sans le mot-clé recherché.";

mdInsertStmt.run(noteDocId, noteFilename, noteTitle, noteFolderId, noteContent.length, "2026-02-01");
insertPageStmt.run(noteDocId, 1, "Contenu sans le mot-clé recherché", "[]");

// Recherche globale "note" SANS cocher Titres (build_search_sql_with_folders_wasm)
const noteSearchSql = JSON.parse(build_search_sql_with_folders_wasm("note", null, 10, 0));
const noteSearchRows = clientDb.prepare(noteSearchSql.sql).all();
assert.ok(noteSearchRows.length > 0, "La recherche globale 'note' DOIT trouver 'Ma première note 1'");
const matchedNoteRow = noteSearchRows.find(r => r.doc_id === noteDocId);
assert.ok(matchedNoteRow, "Le document 'Ma première note 1' doit être présent dans les résultats");
assert.equal(matchedNoteRow.matching_pages_count, 0, "Doit avoir 0 page matchée");

// Traitement via process_search_results_wasm
const processedNoteResults = JSON.parse(process_search_results_wasm(
  JSON.stringify(noteSearchRows),
  JSON.stringify(noteSearchSql.terms),
  noteSearchSql.query_hash
));
const processedNote = processedNoteResults.find(d => d.id === noteDocId);
assert.ok(processedNote, "La note doit être dans les résultats traités par search_wasm");
assert.equal(processedNote.total_occurrences, 0, "0 occurrence dans le corps");
assert.equal(processedNote.title, noteTitle);
console.log("✅ Recherche globale d'une note par son titre sans cocher 'Titres' validée avec succès !");

console.log("\n===============================================================================");
console.log(" TOUS LES TESTS DU MOTEUR HORS-LIGNE & SCORING ONT RÉUSSI AVEC SUCCÈS ! (100%)");
console.log("===============================================================================");



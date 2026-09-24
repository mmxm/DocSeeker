import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import init, {
  initSync,
  get_schema_sql,
  build_search_sql_wasm,
  build_title_search_sql_wasm,
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
assert.equal(titleMatches.length, 6, "Tous les 6 documents doivent correspondre au titre 'grossesse'");
console.log(`✅ Recherche par titre : 6/6 documents trouvés.`);

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
  assert.equal(firstVignette.page_number, 267, "La première vignette doit STRICTEMENT être sur la page 267");
  assert.ok(firstVignette.text_snippet.toUpperCase().includes("INSUFFISANCE RÉNALE AIGUË"), "La première vignette doit être le grand titre de chapitre");
  assert.ok(firstVignette.font_size > 18.0, "La police du titre doit être de taille supérieure à 18");
  console.log("✅ Parité absolue validée via process_search_results_wasm : Titre p. 267 en 1ère vignette et 25 vignettes générées !");
}

console.log("\n===============================================================================");
console.log(" TOUS LES TESTS DU MOTEUR HORS-LIGNE & SCORING ONT RÉUSSI AVEC SUCCÈS ! (100%)");
console.log("===============================================================================");


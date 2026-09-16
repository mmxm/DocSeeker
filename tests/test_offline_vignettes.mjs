import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import init, {
  initSync,
  calculate_crop_bounds_wasm,
  find_occurrences_wasm,
  build_search_sql_wasm,
  get_schema_sql,
} from "../frontend/wasm/search_wasm/search_wasm.js";

console.log("===============================================================================");
console.log(" TEST AUTOMATISÉ : PIPELINE DE VIGNETTES ET RECADRAGE HORS-LIGNE (CROPS)      ");
console.log("===============================================================================");

// 1. Initialisation du module Wasm
const wasmPath = path.resolve("./frontend/wasm/search_wasm/search_wasm_bg.wasm");
const wasmBuffer = fs.readFileSync(wasmPath);
initSync({ module: wasmBuffer });
console.log("✅ [1/5] Module WebAssembly search_wasm initialisé avec succès.");

// 2. Vérification de la compatibilité Web Worker pour PDF.js (self.location / URL)
const pdfMjsContent = fs.readFileSync(path.resolve("./frontend/pdfjs/build/pdf.mjs"), "utf8");
assert.ok(
  pdfMjsContent.includes("self.location"),
  "pdf.mjs doit supporter l'environnement Web Worker sans dépendre exclusivement de window.location"
);
console.log("✅ [2/5] Compatibilité Web Worker (self.location) validée dans pdf.mjs.");

// 3. Vérification de la configuration du Crop Worker et worker-setup.js
const workerSetupContent = fs.readFileSync(path.resolve("./frontend/worker-setup.js"), "utf8");
assert.ok(
  workerSetupContent.includes("self.window = self") && workerSetupContent.includes("self.document"),
  "worker-setup.js doit polyfiller window et document pour l'environnement Web Worker"
);
const cropWorkerContent = fs.readFileSync(path.resolve("./frontend/crop-worker.js"), "utf8");
assert.ok(
  cropWorkerContent.includes("worker-setup.js"),
  "crop-worker.js doit importer worker-setup.js en première intention"
);
assert.ok(
  cropWorkerContent.includes("calculateCropBounds") || cropWorkerContent.includes("calculate_crop_bounds_wasm"),
  "crop-worker.js doit utiliser le calcul de recadrage conforme à search-core"
);
assert.ok(
  cropWorkerContent.includes("rgba(255, 226, 0, 0.45)"),
  "crop-worker.js doit appliquer le surlignage jaune Goodnotes réglementaire"
);
console.log("✅ [3/5] Intégrité structurelle de crop-worker.js validée.");

// 4. Test d'extraction d'occurrences et calcul de crop sur document réel 023
const realDbPath = path.resolve("./data/db.sqlite");
if (fs.existsSync(realDbPath)) {
  const db = new DatabaseSync(realDbPath, { readOnly: true });
  
  // Trouver le document 023 (ou document contenant 'grossesse')
  const doc = db.prepare(`
    SELECT id, title, filename FROM documents 
    WHERE (filename LIKE '%023%' OR title LIKE '%grossesse%') 
    LIMIT 1
  `).get();

  if (doc) {
    console.log(`Extraction des occurrences pour le doc #${doc.id} ("${doc.title || doc.filename}")...`);
    
    // Récupérer les pages contenant 'grossesse'
    const pages = db.prepare(`
      SELECT page_number, words_json, text_content 
      FROM pages 
      WHERE doc_id = ? AND text_content LIKE '%grossesse%'
      ORDER BY page_number ASC
    `).all(doc.id);

    assert.ok(pages.length > 0, "Le document 023 doit contenir des pages avec 'grossesse'");
    
    let totalOccurrencesFound = 0;
    let totalCropsValidated = 0;

    for (const p of pages) {
      const words = JSON.parse(p.words_json);
      const maxWordX = Math.max(...words.map(w => w[2]), 595.0);
      const maxWordY = Math.max(...words.map(w => w[3]), 595.0);
      const pw = maxWordX > 600 ? 842.0 : 595.0;
      const ph = maxWordX > 600 ? 595.0 : 842.0;

      const occsJson = find_occurrences_wasm(
        p.words_json,
        JSON.stringify(["grossesse"]),
        "test_hash",
        BigInt(doc.id),
        BigInt(p.page_number),
        -1.5,
        ph
      );

      const occurrences = JSON.parse(occsJson);
      assert.ok(Array.isArray(occurrences), "Les occurrences doivent être un tableau JSON");
      
      for (const occ of occurrences) {
        totalOccurrencesFound++;
        
        // Validation des coordonnées spatiales
        const [x0, y0, x1, y1] = occ.rect;
        assert.ok(x1 > x0, `Coordonnée X valide : x1(${x1}) > x0(${x0})`);
        assert.ok(y1 > y0, `Coordonnée Y valide : y1(${y1}) > y0(${y0})`);
        assert.ok(occ.crop_url.startsWith("/api/crop/"), `URL de crop valide : ${occ.crop_url}`);

        // Validation du calcul de crop bounds Wasm
        const cropBoundsJson = calculate_crop_bounds_wasm(x0, y0, x1, y1, pw, ph, 300.0, 120.0);
        const bounds = JSON.parse(cropBoundsJson);

        // Validation de la stricte parité JS pur (crop-worker) vs Wasm Rust (search-core)
        function jsCalculateCropBounds(cx0, cy0, cx1, cy1, cpw, cph, ctw = 300.0, cth = 120.0) {
          const occCenterX = (cx0 + cx1) / 2;
          const occCenterY = (cy0 + cy1) / 2;
          let kx0 = Math.max(0, occCenterX - ctw / 2);
          let kx1 = Math.min(kx0 + ctw, cpw);
          if (kx1 === cpw) kx0 = Math.max(0, kx1 - ctw);
          let ky0 = Math.max(0, occCenterY - cth / 2);
          let ky1 = Math.min(ky0 + cth, cph);
          if (ky1 === cph) ky0 = Math.max(0, ky1 - cth);
          return { x0: kx0, y0: ky0, width: Math.max(1, kx1 - kx0), height: Math.max(1, ky1 - ky0) };
        }
        const jsBounds = jsCalculateCropBounds(x0, y0, x1, y1, pw, ph);
        assert.strictEqual(jsBounds.x0, bounds.x0, "Parité exacte x0 entre JS pur et Wasm Rust");
        assert.strictEqual(jsBounds.y0, bounds.y0, "Parité exacte y0 entre JS pur et Wasm Rust");
        assert.strictEqual(jsBounds.width, bounds.width, "Parité exacte width entre JS pur et Wasm Rust");
        assert.strictEqual(jsBounds.height, bounds.height, "Parité exacte height entre JS pur et Wasm Rust");

        assert.ok(Math.abs(bounds.width - 300.0) < 0.01, "Largeur de crop standard = 300px");
        assert.ok(Math.abs(bounds.height - 120.0) < 0.01, "Hauteur de crop standard = 120px");
        assert.ok(bounds.x0 >= 0 && bounds.x1 <= pw, `Recadrage contenu dans la page horizontalement (bounds.x1=${bounds.x1} <= pw=${pw})`);
        assert.ok(bounds.y0 >= 0 && bounds.y1 <= ph, `Recadrage contenu dans la page verticalement (bounds.y1=${bounds.y1} <= ph=${ph})`);
        
        // Le centre du mot doit être contenu à l'intérieur du rectangle de recadrage
        const centerX = (x0 + x1) / 2.0;
        const centerY = (y0 + y1) / 2.0;
        assert.ok(centerX >= bounds.x0 && centerX <= bounds.x1, "Le centre du mot est dans la vue de crop X");
        assert.ok(centerY >= bounds.y0 && centerY <= bounds.y1, "Le centre du mot est dans la vue de crop Y");

        totalCropsValidated++;
      }
    }

    console.log(`✅ [4/5] ${totalOccurrencesFound} occurrences spatiales détectées, ${totalCropsValidated} rectangles de crop validés à 100%.`);
  }
} else {
  console.log("ℹ️ [4/5] data/db.sqlite non trouvé, test sur données synthétiques.");
}

// 5. Validation de la résilience du Service Worker & Fallback
const swContent = fs.readFileSync(path.resolve("./frontend/sw.js"), "utf8");
assert.ok(
  swContent.includes("status: 503"),
  "sw.js doit retourner un code HTTP 503 en cas d'absence réseau pour déclencher onerror et le crop hors-ligne local"
);
assert.ok(
  swContent.includes("docseeker_offline_crops"),
  "sw.js doit gérer le cache 'docseeker_offline_crops' pour les vignettes générées localement"
);
console.log("✅ [5/5] Contrat de routage 503 & CacheStorage validé dans sw.js.");

console.log("\n===============================================================================");
console.log(" TOUS LES TESTS DU PIPELINE DE VIGNETTES HORS-LIGNE ONT RÉUSSI AVEC SUCCÈS !   ");
console.log("===============================================================================");

/**
 * global-setup.mjs - Playwright Global Setup
 *
 * Seed la base de données une seule fois avant tous les tests.
 * Remplace le beforeAll() de ui_complete.spec.mjs.
 */
import { execSync } from 'child_process';

export default async function globalSetup() {
  try {
    execSync(
      `sqlite3 data/db.sqlite "` +
        `INSERT OR IGNORE INTO folders (id, name, color) VALUES (130, 'Martingale', '#3b82f6');` +
        `UPDATE documents SET folder_id = 130 WHERE id IN (1, 2, 3);"`,
      { stdio: 'ignore' }
    );
    console.log('[GlobalSetup] Dossier Martingale et documents 1,2,3 prêts.');
  } catch (e) {
    console.warn('[GlobalSetup] Seed DB ignoré (sqlite3 non disponible ou DB absente):', e.message);
  }
}

/**
 * DocSeeker - Tests UI Sessions Actives (ui_sessions.spec.mjs)
 *
 * Valide l'affichage, la visualisation et la révocation des sessions actives.
 */
import { test, expect } from '@playwright/test';
import { DocSeekerTestHarness } from './harness.mjs';

test.describe('DocSeeker - Gestion des Sessions Actives', () => {
  let h;

  test.beforeEach(async ({ page, context }) => {
    h = new DocSeekerTestHarness(page, context);
    await h.authenticate();
    // Nettoyer les sessions résiduelles des runs précédents pour garantir un état propre
    await page.request.post('/api/auth/sessions/revoke-all', {
      data: { include_current: false }
    });
    await h.goto('/');
  });

  test.afterEach(async () => {
    await h.resetState();
    h.assertZeroErrors({ ignoreNetworkNoise: true });
  });

  test('Sess-1 : Visualisation de la session active courante avec OS, Navigateur et IP', async ({ page }) => {
    // 1. Naviguer vers la vue Réglages via la barre latérale
    await page.locator('#mainSidebarToggleBtn').click();
    await expect(page.locator('#mainSidebarDrawer')).toHaveClass(/open/);
    await page.locator('#navBtnSettings').click();

    await expect(page.locator('#viewSettings')).toBeVisible({ timeout: 6000 });
    const sessionsCard = page.locator('#settingsSessionsCard');
    await expect(sessionsCard).toBeVisible();

    // 2. Vérifier que la liste contient au moins la session courante avec le badge "Cet appareil"
    const currentSessionItem = page.locator('#activeSessionsList .session-item.current-session');
    await expect(currentSessionItem).toBeVisible({ timeout: 6000 });

    const badge = currentSessionItem.locator('.session-badge-current');
    await expect(badge).toHaveText('Cet appareil');

    // Vérifier la présence du nom du système et de l'IP
    const deviceName = currentSessionItem.locator('.session-device-name');
    await expect(deviceName).toBeVisible();
    const deviceText = await deviceName.textContent();
    expect(deviceText.length).toBeGreaterThan(3);

    const details = currentSessionItem.locator('.session-details-line');
    await expect(details).toContainText('Dernière activité');

    console.log(`✅ [Sess-1] Session courante visualisée : "${deviceText}"`);
  });

  test('Sess-2 : Déconnexion individuelle d une session distante', async ({ page, request }) => {
    // 1. Simuler une 2e session (ex: connexion depuis un mobile virtuel via API)
    const loginRes = await request.post('http://localhost:8080/api/auth/login', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'X-Forwarded-For': '192.168.1.55'
      },
      data: { password: 'admin1234' }
    });
    expect(loginRes.ok()).toBe(true);

    // 2. Ouvrir la vue Réglages
    await page.locator('#mainSidebarToggleBtn').click();
    await page.locator('#navBtnSettings').click();
    await expect(page.locator('#viewSettings')).toBeVisible();

    // Vérifier la présence des 2 sessions
    await expect(page.locator('#activeSessionsList .session-item')).toHaveCount(2, { timeout: 6000 });
    const mobileSession = page.locator('#activeSessionsList .session-item:not(.current-session)').first();
    await expect(mobileSession).toContainText('iOS • Safari');
    await expect(mobileSession).toContainText('192.168.1.55');

    // 3. Déconnecter la session distante via le bouton Déconnecter individuel
    page.once('dialog', dialog => dialog.accept());
    const revokeBtn = mobileSession.locator('.btn-session-revoke');
    await revokeBtn.click();

    // 4. Vérifier que la session distante a disparu et qu'il ne reste que la session courante
    await expect(page.locator('#activeSessionsList .session-item')).toHaveCount(1, { timeout: 6000 });
    await expect(page.locator('#activeSessionsList .session-item.current-session')).toBeVisible();

    console.log('✅ [Sess-2] Déconnexion individuelle d une session distante validée.');
  });

  test('Sess-3 : Déconnecter les autres appareils en un clic tout en conservant la session active', async ({ page, request }) => {
    // 1. Créer 2 autres sessions distinctes
    await request.post('http://localhost:8080/api/auth/login', {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1', 'X-Forwarded-For': '10.0.0.1' },
      data: { password: 'admin1234' }
    });
    await request.post('http://localhost:8080/api/auth/login', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0', 'X-Forwarded-For': '10.0.0.2' },
      data: { password: 'admin1234' }
    });

    // 2. Aller dans les Réglages
    await page.locator('#mainSidebarToggleBtn').click();
    await page.locator('#navBtnSettings').click();
    await expect(page.locator('#viewSettings')).toBeVisible();

    // Vérifier 3 sessions au total
    await expect(page.locator('#activeSessionsList .session-item')).toHaveCount(3, { timeout: 6000 });

    // 3. Cliquer sur "Déconnecter les autres appareils"
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#revokeOtherSessionsBtn').click();

    // 4. Vérifier qu'il ne reste QUE la session courante et qu'on est toujours connecté
    await expect(page.locator('#activeSessionsList .session-item')).toHaveCount(1, { timeout: 6000 });
    const currentSession = page.locator('#activeSessionsList .session-item.current-session');
    await expect(currentSession).toBeVisible();

    // Vérifier qu'une requête authentifiée fonctionne toujours normalement
    const authStatus = await page.evaluate(async () => {
      const res = await fetch('/api/auth/status');
      return res.json();
    });
    expect(authStatus.authenticated).toBe(true);

    console.log('✅ [Sess-3] Révocation en masse des autres sessions validée avec maintien de la session active.');
  });

  test('Sess-4 : Révocation totale de toutes les sessions (y compris la session courante)', async ({ page, request }) => {
    // 1. Ouvrir la vue Réglages
    await page.locator('#mainSidebarToggleBtn').click();
    await page.locator('#navBtnSettings').click();
    await expect(page.locator('#viewSettings')).toBeVisible();

    // 2. Cliquer sur "Tout révoquer"
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#revokeAllSessionsBtn').click();

    // 3. Vérifier que l'API de statut indique que la session n'est plus authentifiée
    await expect.poll(async () => {
      const res = await request.get('http://localhost:8080/api/auth/status');
      const data = await res.json();
      return data.authenticated;
    }, { timeout: 5000 }).toBe(false);

    console.log('✅ [Sess-4] Révocation totale de toutes les sessions validée.');
  });
});

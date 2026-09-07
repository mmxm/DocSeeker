import unittest
import os
import re

class TestQAErgonomicsAndUXBugs(unittest.TestCase):
    """
    Suite de tests QA traquant les bugs ergonomiques, visuels, UX et d'état front-end.
    Chaque test démontre un manquement ergonomique ou un défaut de cohérence d'interface
    dans les sources front-end (app.js, style.css, index.html) ou les flux clients.
    """

    @classmethod
    def setUpClass(cls):
        cls.frontend_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
        with open(os.path.join(cls.frontend_dir, "app.js"), "r", encoding="utf-8") as f:
            cls.app_js = f.read()
        with open(os.path.join(cls.frontend_dir, "style.css"), "r", encoding="utf-8") as f:
            cls.style_css = f.read()
        with open(os.path.join(cls.frontend_dir, "index.html"), "r", encoding="utf-8") as f:
            cls.index_html = f.read()

    # ----------------------------------------------------------------------
    # BUG 15 : Crash Fetch sur URL avec Basic Auth (credentials dans l'URL)
    # ----------------------------------------------------------------------
    def test_bug_fetch_sanitized_against_url_credentials(self):
        """
        [Technique/Ergonomie] Conformément à WHATWG Fetch, un fetch('/api/...')
        depuis une page 'https://user:pass@host/' lève un TypeError bloquant.
        L'application doit utiliser une fonction d'URL sécurisée sans credentials
        (ex: base origin nettoyée ou helper apiFetch).
        """
        # Vérifier si fetch est utilisé directement avec des chemins relatifs /api/
        # sans nettoyage préalable de l'origine
        has_raw_api_fetch = bool(re.search(r'fetch\(\s*["`]/api/', self.app_js))
        has_credentials_sanitizer = "cleanOrigin" in self.app_js or "apiFetch" in self.app_js
        self.assertFalse(
            has_raw_api_fetch and not has_credentials_sanitizer,
            "Des appels fetch('/api/...') directs sont effectués sans assainissement d'origine, "
            "provoquant un TypeError lors d'un accès avec identifiants Basic Auth !"
        )

    # ----------------------------------------------------------------------
    # BUG 16 : Compteur Stepper trompeur (affiche '1 / N' quand aucun extrait n'est actif)
    # ----------------------------------------------------------------------
    def test_bug_stepper_counter_display_when_no_active_occurrence(self):
        """
        [Ergonomie/Visuel] updateOccurrenceStepperUI() affiche faussement '1 / N'
        quand currentActiveOccurrenceIndex est à -1 (aucun extrait sélectionné).
        Il doit afficher '0 / N' ou '- / N'.
        """
        # Recherche du calcul du currentDisplayIndex
        match = re.search(r'const\s+currentDisplayIndex\s*=\s*currentActiveOccurrenceIndex\s*>=\s*0\s*\?\s*currentActiveOccurrenceIndex\s*\+\s*1\s*:\s*1\s*;', self.app_js)
        self.assertIsNone(
            match,
            "Le Stepper d'occurrences calcule '1' par défaut quand aucun extrait n'est actif (currentActiveOccurrenceIndex = -1), trompant l'utilisateur !"
        )

    # ----------------------------------------------------------------------
    # BUG 17 : batchDeleteBtn détruit la vue de recherche en cours
    # ----------------------------------------------------------------------
    def test_bug_batch_delete_preserves_search_view(self):
        """
        [UX/Cohérence] batchDeleteBtn appelle directement loadFoldersAndDocuments()
        au lieu de préserver la recherche active avec :
        if (currentSearchQuery) performSearch(currentSearchQuery); else loadFoldersAndDocuments();
        """
        batch_delete_block = re.search(r'batchDeleteBtn\.addEventListener\("click",\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);', self.app_js)
        self.assertIsNotNone(batch_delete_block, "Bloc batchDeleteBtn introuvable.")
        content = batch_delete_block.group(1)

        preserves_search = "currentSearchQuery" in content and "performSearch" in content
        self.assertTrue(
            preserves_search,
            "batchDeleteBtn ne préserve pas la recherche active et réinitialise brutalement la vue à la bibliothèque !"
        )

    # ----------------------------------------------------------------------
    # BUG 18 : Desynchronisation d'état au renommage de document (Title Reversion on Sort)
    # ----------------------------------------------------------------------
    def test_bug_rename_updates_raw_loaded_docs_and_search_cache(self):
        """
        [Visuel/State Desync] handleRenameDocument met à jour currentLoadedDocs mais
        oublie rawLoadedDocs et lastSearchResultsData.results.
        Dès que l'utilisateur change le tri (sortSelect), le titre du document
        redevient immédiatement l'ancien titre !
        """
        rename_block = re.search(r'async\s+function\s+handleRenameDocument\(\)\s*\{([\s\S]*?)\}', self.app_js)
        self.assertIsNotNone(rename_block, "Fonction handleRenameDocument introuvable.")
        content = rename_block.group(1)

        updates_raw = "rawLoadedDocs" in content
        updates_search = "lastSearchResultsData" in content
        self.assertTrue(
            updates_raw and updates_search,
            "handleRenameDocument ne met pas à jour rawLoadedDocs ni lastSearchResultsData.results, "
            "provoquant la réapparition de l'ancien titre dès qu'un tri est sélectionné !"
        )

    # ----------------------------------------------------------------------
    # BUG 19 : Absence d'échappement HTML dans les notifications showToast (XSS / Glitch)
    # ----------------------------------------------------------------------
    def test_bug_toast_html_escaping(self):
        """
        [Sécurité/Visuel] showToast insère le message directement dans innerHTML :
        toast.innerHTML = `${iconSvg}<span>${message}</span>`;
        Les titres avec caractères spéciaux (<, >, &) cassent l'affichage ou injectent du HTML.
        """
        toast_block = re.search(r'function\s+showToast[\s\S]*?toastContainer\.appendChild', self.app_js)
        self.assertIsNotNone(toast_block, "Fonction showToast introuvable.")
        content = toast_block.group(0)

        uses_unescaped_inner_html = "<span>${message}</span>" in content
        self.assertFalse(
            uses_unescaped_inner_html,
            "showToast insère le message sans échappement dans innerHTML, créant un risque XSS et des glitches visuels sur les caractères spéciaux !"
        )

    # ----------------------------------------------------------------------
    # BUG 20 : Présence d'alertes bloquantes alert() dans app.js
    # ----------------------------------------------------------------------
    def test_bug_no_blocking_alerts_in_app_js(self):
        """
        [Ergonomie/Accessibilité] L'application ne doit pas utiliser window.alert()
        qui fige le thread de rendu du navigateur et l'expérience mobile/tablette.
        Des toasts non-bloquants doivent être utilisés à la place.
        """
        alert_calls = re.findall(r'(\balert\s*\([^)]*\))', self.app_js)
        self.assertEqual(
            len(alert_calls),
            0,
            f"Des appels bloquants alert() ont été trouvés dans app.js : {alert_calls}"
        )

if __name__ == "__main__":
    unittest.main()

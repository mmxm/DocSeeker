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

    # ----------------------------------------------------------------------
    # BUG 21 : Écrasement vertical des cartes d'extraits dans le tiroir mobile
    # ----------------------------------------------------------------------
    def test_bug_21_mobile_drawer_occurrences_cards_collapsed_by_flex_shrink(self):
        """
        [Affichage Mobile/CSS] Dans le tiroir coulissant mobile (.drawer-occurrences-list),
        les cartes .vertical-occ-card sont écrasées à 2px de haut car flex-shrink vaut 1
        par défaut dans un conteneur flex vertical.
        .vertical-occ-card et ses composants (.vertical-occ-img-wrapper, .vertical-occ-footer)
        doivent impérativement avoir flex-shrink: 0, et .drawer-occurrences-list doit avoir
        min-height: 0 pour assurer un défilement complet et fluide.
        De plus, openMobileOccurrencesDrawer() doit centrer automatiquement la carte active.
        """
        # Vérifier que .vertical-occ-card a bien flex-shrink: 0
        card_match = re.search(r'\.vertical-occ-card\s*\{([^}]+)\}', self.style_css)
        self.assertIsNotNone(card_match, "Règle CSS .vertical-occ-card introuvable.")
        card_css = card_match.group(1)
        self.assertIn(
            "flex-shrink: 0",
            card_css,
            ".vertical-occ-card ne possède pas 'flex-shrink: 0', provoquant l'écrasement à 2px de haut dans le tiroir mobile !"
        )

        # Vérifier que .drawer-occurrences-list a min-height: 0
        drawer_list_match = re.search(r'\.drawer-occurrences-list\s*\{([^}]+)\}', self.style_css)
        self.assertIsNotNone(drawer_list_match, "Règle CSS .drawer-occurrences-list introuvable.")
        drawer_list_css = drawer_list_match.group(1)
        self.assertIn(
            "min-height: 0",
            drawer_list_css,
            ".drawer-occurrences-list doit définir 'min-height: 0' pour permettre le défilement vertical complet en flexbox."
        )

        # Vérifier l'auto-centrage de la carte active dans openMobileOccurrencesDrawer
        drawer_open_block = re.search(r'function\s+openMobileOccurrencesDrawer\(\)\s*\{([\s\S]*?)\}', self.app_js)
        self.assertIsNotNone(drawer_open_block, "Fonction openMobileOccurrencesDrawer introuvable.")
        self.assertIn(
            "scrollIntoView",
            drawer_open_block.group(1),
            "openMobileOccurrencesDrawer() doit auto-défiler vers l'extrait actif (.vertical-occ-card.active) lors de son ouverture."
        )

    # ----------------------------------------------------------------------
    # BUG 22 : Débordement vertical du conteneur de recherche en vue mobile
    # ----------------------------------------------------------------------
    def test_bug_22_mobile_search_container_height_overflow(self):
        """
        [Affichage Mobile / Layout]
        Sur desktop, .search-container a été défini avec height: 34px pour
        aligner la recherche en une seule ligne.
        En responsive mobile (@media (max-width: 768px)), .search-container
        bascule en flex-direction: column (pour empiler l'input de 40px et la barre
        de filtres de 28px).
        Cependant, la règle mobile omet d'écraser la hauteur fixe 'height: 34px'
        par 'height: auto', bloquant le conteneur à 34px alors que son contenu
        mesure 74px. Les filtres et statistiques débordent verticalement et
        chevauchent l'en-tête de résultats en dessous.
        """
        mobile_media = re.search(r'@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}', self.style_css)
        self.assertIsNotNone(mobile_media, "Bloc @media (max-width: 768px) introuvable dans style.css")
        media_content = mobile_media.group(1)

        search_container_match = re.search(r'\.search-container\s*\{([^}]+)\}', media_content)
        self.assertIsNotNone(search_container_match, "Règle .search-container introuvable dans @media (max-width: 768px)")
        search_container_rules = search_container_match.group(1)

        self.assertTrue(
            "height: auto" in search_container_rules or "height:auto" in search_container_rules,
            "En vue mobile (<768px), .search-container doit impérativement redéfinir 'height: auto' pour annuler le 'height: 34px' desktop et éviter que la barre de filtres ne déborde verticalement de 40px !"
        )

    # ----------------------------------------------------------------------
    # BUG 23 : Absence de scroll automatique sur l'occurrence active en Split View Desktop
    # ----------------------------------------------------------------------
    def test_bug_23_desktop_split_view_active_occurrence_auto_scroll(self):
        """
        [UX / Ergonomie Desktop]
        Lors de l'ouverture d'un document en vue scindée (openDocumentInSplitView),
        renderVerticalOccurrences génère la liste des occurrences et active la carte
        cible avec la classe 'active' (.vertical-occ-card.active).
        Cependant, contrairement au tiroir mobile, renderVerticalOccurrences ne fait
        aucun scrollIntoView() sur cette carte active. Si l'utilisateur clique sur une
        occurrence en page 25 (ex: occurrence 28/30), le panneau latéral gauche reste
        figé en haut (page 1), masquant complètement la carte active sélectionnée.
        """
        render_occ_block = re.search(r'function\s+renderVerticalOccurrences\([^)]*\)\s*\{([\s\S]*?)\n  \}', self.app_js)
        self.assertIsNotNone(render_occ_block, "Fonction renderVerticalOccurrences introuvable dans app.js")
        self.assertIn(
            "scrollIntoView",
            render_occ_block.group(1),
            "renderVerticalOccurrences() doit exécuter un scrollIntoView() sur la carte active initiale pour assurer la cohérence visuelle avec le visualiseur."
        )

    # ----------------------------------------------------------------------
    # BUG 24 : Alignement et rendu des deux croix dans le tiroir mobile
    # ----------------------------------------------------------------------
    def test_bug_24_drawer_search_wrapper_relative_position_and_close_icons(self):
        """
        [Visuel / Ergonomie Mobile]
        Dans le tiroir mobile (#mobileOccurrencesDrawer) :
        1. .drawer-search-wrapper doit posséder 'position: relative' pour que le bouton
           d'effacement .clear-btn (#drawerDocSearchClearBtn) soit correctement calé à l'intérieur
           du champ de recherche, et ne s'échappe pas à droite sur la bordure extérieure du tiroir.
        2. Le bouton de fermeture du tiroir (#closeDrawerBtn) doit utiliser une icône SVG
           vectorielle soignée (au lieu de l'entité texte brute '&times;' décentrée).
        """
        # 1. Vérifier position: relative sur .drawer-search-wrapper
        wrapper_match = re.search(r'\.drawer-search-wrapper\s*\{([^}]+)\}', self.style_css)
        self.assertIsNotNone(wrapper_match, "Règle .drawer-search-wrapper introuvable dans style.css")
        wrapper_css = wrapper_match.group(1)
        self.assertIn(
            "position: relative",
            wrapper_css,
            ".drawer-search-wrapper doit avoir 'position: relative' pour que le bouton .clear-btn soit contenu dans le champ et non projeté sur la bordure extérieure du tiroir."
        )

        # 2. Vérifier l'icône SVG pour closeDrawerBtn
        with open("frontend/index.html", "r", encoding="utf-8") as f:
            html_content = f.read()
        close_btn_match = re.search(r'<button\s+id="closeDrawerBtn"[^>]*>([\s\S]*?)</button>', html_content)
        self.assertIsNotNone(close_btn_match, "Bouton #closeDrawerBtn introuvable dans index.html")
        self.assertIn(
            "<svg",
            close_btn_match.group(1),
            "#closeDrawerBtn doit utiliser une icône SVG vectorielle au lieu du caractère texte brut '&times;'."
        )

if __name__ == "__main__":
    unittest.main()

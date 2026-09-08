# ==============================================================================
# DocSeeker - Configuration globale Pytest (Initialisation CI / Local)
# ==============================================================================
import os
import pytest
from scripts.generate_sample_pdfs import generate

@pytest.fixture(scope="session", autouse=True)
def setup_test_suite_environment():
    """Initialise les répertoires et les documents PDF de test avant l'exécution des tests."""
    os.makedirs("data/documents", exist_ok=True)
    os.makedirs("data/covers", exist_ok=True)
    os.makedirs("data/crops", exist_ok=True)
    
    from backend.database import init_db
    init_db()
    # Génération et indexation des documents médicaux d'exemple pour la suite de tests
    generate()


import os
import pymupdf
from backend.indexer import index_pdf_file

SAMPLE_DATA = [
    {
        "filename": "025_grossesse_extra_uterine.pdf",
        "title": "025 - Grossesse extra-utérine",
        "pages": [
            """UNIVERSITÉ DE MÉDECINE - COURS D'OBSTÉTRIQUE
Chapitre 1 : Introduction et définitions

La grossesse extra-utérine (GEU) représente la première cause de mortalité maternelle au premier trimestre.
Le diagnostic précoce repose sur le dosage quantitatif de la bêta-hCG et l'échographie pelvienne endovaginale.
Une vacuité utérine avec un taux supérieur à 1500 UI/L est hautement évocatrice.""",
            """Chapitre 2 : Signes cliniques et complications

La douleur pelvienne unilatérale et les métrorragies sépia sont les maîtres symptômes.
En cas de rupture tubaire, le tableau devient cataclysmique : état de choc hémorragique avec hémorragie intra-abdominale massive.
L'hémorragie interne nécessite une laparotomie ou coelioscopie d'extrême urgence pour hémostase."""
        ]
    },
    {
        "filename": "024_principales_complications_grossesse.pdf",
        "title": "024 - Principales complications de la grossesse",
        "pages": [
            """MODULE DE GYNÉCOLOGIE ET SANTÉ DE LA FEMME
Item 24 : Complications hémorragiques

Hémorragie génitale du premier trimestre :
Environ 25 % des grossesses s'accompagnent de saignements. Les causes majeures sont la fausse couche précoce et la GEU.""",
            """Item 24 (suite) : Hémorragie du troisième trimestre

Les deux causes principales sont le placenta praevia et l'hématome rétroplacentaire (HRP).
Toute hémorragie au 3ème trimestre impose une hospitalisation immédiate, la pose d'une voie veineuse de gros calibre et un bilan d'hémostase.""",
            """Item 24 (fin) : Prise en charge de l'hémorragie de la délivrance

L'hémorragie de la délivrance est une urgence vitale.
Une surveillance rigoureuse pendant les deux heures suivant l'expulsion permet de dépister précocement toute hémorragie anormale.
Le massage utérin et l'injection d'ocytocine sont systématiques."""
        ]
    },
    {
        "filename": "gynecologie_obstetrique_college.pdf",
        "title": "Gynécologie Obstétrique - Collège des Enseignants (6e édition)",
        "pages": [
            """COLLÈGE NATIONAL DES GYNÉCOLOGUES ET OBSTÉTRICIENS FRANÇAIS
Sommaire et grandes orientations diagnostiques :
- Item 35 : Contraception et suivi gynécologique
- Item 43 : Douleurs pelviennes de la femme
- Item 22 : Grossesse normale et suivi prénatal
- Item 24 : Hémorragie génitale et hémorragie du post-partum""",
            """Section 2 : Conduite à tenir devant une hémorragie génitale
L'examen au spéculum confirme l'origine endo-utérine du saignement.
Une hémorragie abondante avec caillots nécessite une transfusion rapide et une surveillance continue des constantes hémodynamiques.""",
            """Section 3 : Complications vasculaires et hémostase
Les troubles de coagulation peuvent aggraver considérablement une hémorragie débutante.
L'acide tranexamique et le fibrinogène doivent être injectés rapidement lors d'une hémorragie massive réfractaire."""
        ]
    }
]

def generate():
    docs_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "documents")
    os.makedirs(docs_dir, exist_ok=True)

    for item in SAMPLE_DATA:
        filepath = os.path.join(docs_dir, item["filename"])
        doc = pymupdf.open()

        for p_idx, text_content in enumerate(item["pages"]):
            page = doc.new_page(width=595, height=842)
            # Insérer en-tête et texte
            page.insert_textbox(pymupdf.Rect(40, 50, 550, 800), text_content, fontsize=12)

        doc.save(filepath)
        doc.close()

        # Indexer
        res = index_pdf_file(filepath, item["filename"], custom_title=item["title"])
        print(f"Document indexé : {res['title']} ({res['total_pages']} pages)")

if __name__ == "__main__":
    generate()

# Fichier WSGI pour PythonAnywhere : copiez ce contenu dans le fichier WSGI de votre application web
# (onglet « Web » › « WSGI configuration file »), en remplaçant VOTRE_NOM par votre nom d'utilisateur.
import os
import sys

sys.path.insert(0, "/home/VOTRE_NOM/runbpm/server")
os.environ.setdefault("RUNBPM_DB", "/home/VOTRE_NOM/runbpm-data/runbpm.sqlite")

from runbpm_server import create_app  # noqa: E402

application = create_app()

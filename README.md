# CodexAudio (VS Code Extension)

CodexAudio lit à voix haute les réponses du modèle (via les fichiers `~/.codex/sessions/**/rollout-*.jsonl`) et affiche une barre latérale **Options** ainsi qu’un panneau **Traduction**.

## Installation (.vsix)

1. Construire le VSIX :
   - `npm install`
   - `npm run package`
2. Installer dans VS Code :
   - Command Palette → **Extensions: Install from VSIX...**
   - choisir le fichier `.vsix` généré à la racine.

## Prérequis

- Windows 10/11
- Python 3.12 + venv : `C:\Users\treha\Desktop\CodexAudio\.venv`
- Les dépendances Python sont listées dans `requirements.txt`.


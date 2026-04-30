# CodexAudio

CodexAudio est une extension VS Code pour Windows qui lit a voix haute les reponses Codex a partir des fichiers de session `~/.codex/sessions/**/rollout-*.jsonl`.

Elle fournit aussi une vue **Options**, une barre flottante de controle et une fenetre texte/traduction.

## Fonctionnalites

- Lecture automatique des nouvelles reponses assistant.
- Selection de voix Windows/WinRT par langue.
- Pause, stop, muet et pause du service.
- Fenetre texte avec traduction optionnelle via `googletrans`.
- Filtrage par workspace pour eviter que plusieurs fenetres VS Code lisent la meme reponse.

## Prerequis

- Windows 10/11.
- VS Code 1.108 ou plus recent.
- Node.js et npm.
- Python 3.12 recommande.
- Dependances Python listees dans `requirements.txt`.

## Installation developpement

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Par defaut, l'extension cherche Python ici :

```text
${workspaceFolder}\.venv\Scripts\python.exe
```

Ce chemin est configurable dans VS Code avec `codexAudio.pythonPath`.

Si ce chemin n'existe pas dans le workspace ouvert, le backend Python reste inactif sans afficher d'erreur. Pour utiliser un Python global, configure explicitement `codexAudio.pythonPath` avec `python` ou avec le chemin complet vers `python.exe`.

## Build

```powershell
npm run compile
```

La compilation lance d'abord `tsc --noEmit`, puis genere `dist/extension.js` avec esbuild.

## Generer un VSIX

```powershell
npm run package
```

Le fichier `.vsix` genere a la racine est ignore par Git.

## Installer le VSIX

Dans VS Code :

1. Ouvrir la palette de commandes.
2. Lancer **Extensions: Install from VSIX...**.
3. Choisir le fichier `codexaudio-*.vsix`.

## Licence

ISC

# CodexAudio

CodexAudio est une extension VS Code pour Windows qui lit a voix haute les reponses Codex de la conversation actuellement reprise dans l'extension OpenAI/Codex.

La conversation active est detectee en surveillant les logs VS Code de l'extension `openai.chatgpt`, notamment les lignes:

```text
Conversation created conversationId=...
maybe_resume_success conversationId=...
```

Quand une conversation est detectee comme active, l'extension retrouve son fichier `~/.codex/sessions/**/rollout-*<conversationId>.jsonl`, charge la derniere reponse assistant dans la fenetre texte, puis surveille les nouvelles reponses.

## Fonctionnement

- Ouverture de VS Code ou d'un dossier: affiche uniquement les titres des conversations liees au dossier ouvert.
- Ouverture/reprise d'une conversation: detectee via `Codex.log`, meme si c'est le meme `conversationId` que precedemment.
- Sortie/fermeture d'une conversation: non journalisee de facon fiable par VS Code/Codex.
- Changement vers une autre conversation: l'ancienne conversation est marquee `inactive` par inference.
- Derniere reponse: lue depuis le fichier `.jsonl` de session Codex, sans bloquer sur le dossier d'origine de la conversation.
- Nouvelles reponses: lues en continu depuis le meme `.jsonl`.
- Conversation hors contexte: affiche un avertissement propre et la liste des titres disponibles pour le dossier courant.
- Conversation dans le contexte: affiche `Derniere reponse :`, puis uniquement la derniere reponse, sans details de session.
- La fenetre texte est aussi lue en TTS lorsque la lecture automatique est active.

## Fonctionnalites

- Lecture automatique des nouvelles reponses assistant.
- Chargement de la derniere reponse quand une conversation est reprise.
- Liste des conversations du contexte courant au demarrage.
- Avertissement quand une conversation ouverte appartient a un autre dossier.
- Selection de voix Windows/WinRT par langue.
- Pause, stop, muet et pause du service.
- Fenetre texte avec traduction optionnelle via `googletrans`.
- Filtrage par workspace pour eviter que plusieurs fenetres VS Code lisent la meme reponse.

## Prerequis

- Windows 10/11.
- VS Code 1.108 ou plus recent.
- Extension OpenAI/Codex installee dans VS Code.
- Node.js et npm.
- Python 3.12 recommande.
- Dependances Python listees dans `requirements.txt`.

## Installation developpement

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Par defaut, l'extension utilise `python` depuis le `PATH` Windows.

Tu peux aussi pointer vers un environnement local:

```text
${workspaceFolder}\.venv\Scripts\python.exe
```

Ce chemin est configurable dans VS Code avec `codexAudio.pythonPath`.

## Build

```powershell
npm run compile
```

La compilation lance `tsc --noEmit`, puis genere `dist/extension.js` avec esbuild.

## VSIX

```powershell
npm run package
```

Le fichier `.vsix` genere a la racine est ignore par Git.

## Licence

ISC

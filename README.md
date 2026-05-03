# CodexAudio

CodexAudio is a Windows VS Code extension that reads OpenAI Codex responses aloud and shows the active response in a floating text window.

It is designed for the OpenAI/Codex VS Code extension. CodexAudio watches the OpenAI extension log file, detects the active Codex conversation, then reads the matching Codex session file from `~/.codex/sessions`.

## Features

- Detects active Codex conversations from `Codex.log`.
- Lists only the conversation titles available for the currently opened folder.
- Warns when the user opens a Codex conversation from another folder/context.
- Displays only the latest response when the conversation belongs to the current folder.
- Reads the displayed text aloud with Windows/WinRT voices.
- Supports pause, stop, mute, service pause, voice selection, speed and volume.
- Optional text translation through `googletrans`.
- Floating text window and floating toolbar support an explicit light/dark theme setting.

## How It Works

CodexAudio watches log lines such as:

```text
Conversation created conversationId=...
maybe_resume_success conversationId=...
```

When a conversation is opened, CodexAudio finds the related file:

```text
~/.codex/sessions/**/rollout-*<conversationId>.jsonl
```

If the session belongs to the currently opened folder, CodexAudio displays:

```text
Derniere reponse :

...
```

If the session belongs to another folder, CodexAudio shows a context warning and lists the conversation titles available for the current folder. CodexAudio cannot block the OpenAI/Codex extension UI itself, but it does block its own loading and TTS for out-of-context conversations.

## Requirements

- Windows 10/11.
- VS Code 1.108 or later.
- OpenAI/Codex extension installed in VS Code.
- Node.js and npm for development.
- Python 3.12 recommended for development/backend builds.

## Development Setup

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

By default, CodexAudio uses `python` from the Windows `PATH`.

You can configure a specific Python interpreter in VS Code:

```text
codexAudio.pythonPath
```

Examples:

```text
python
C:\path\to\python.exe
${workspaceFolder}\.venv\Scripts\python.exe
```

## Build

Compile the extension:

```powershell
npm run compile
```

Build the Python backend executable:

```powershell
npm run build:backend
```

Package the VSIX:

```powershell
npm run package
```

The generated `.vsix`, `dist/`, `build/`, `backend-win/`, `node_modules/` and `.venv/` folders are ignored by Git.

## Install From VSIX

In VS Code:

1. Open the command palette.
2. Run `Extensions: Install from VSIX...`.
3. Select the generated `codexaudio-*.vsix`.
4. Reload VS Code.

## Limitations

- CodexAudio relies on the current OpenAI/Codex VS Code log format.
- Closing/leaving a Codex conversation is not logged reliably by the OpenAI extension.
- Opening a conversation from another folder is detected as out-of-context, but the OpenAI/Codex UI cannot be prevented from opening it.
- This project is not affiliated with OpenAI.

## License

ISC

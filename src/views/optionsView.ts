import * as vscode from "vscode";
import type { AppState } from "../state";

export type OptionsViewModel = {
  state: AppState;
  voices: { id: string; name: string; languages: string[] }[];
  availableLanguages: string[];
  statusText: string;
  detectedLang: string;
  backendOk: boolean;
  translateAvailable: boolean;
};

export class OptionsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codexAudio.options";

  private view: vscode.WebviewView | undefined;
  private model: OptionsViewModel | undefined;
  private readonly onMessage: (msg: unknown) => void;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    onMessage: (msg: unknown) => void,
  ) {
    this.onMessage = onMessage;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    if (this.model) this.postModel(this.model);
  }

  show(): void {
    this.view?.show?.(true);
  }

  setModel(model: OptionsViewModel): void {
    this.model = model;
    this.postModel(model);
  }

  private postModel(model: OptionsViewModel): void {
    if (!this.view) return;
    this.view.webview.postMessage({ type: "model", model });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "options.js"));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "options.css"));

    return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>CodexAudio - Options</title>
</head>
<body>
  <div id="app">
    <div class="header">
      <div class="title">CodexAudio</div>
      <div id="status" class="status"></div>
    </div>

    <div class="group">
      <div class="groupTitle" id="grpGeneralTitle">Général</div>
      <label class="row">
        <span class="label">
          <span id="uiLangSpeaker" class="speaker" aria-hidden="true"></span>
          <span id="lblUiLang">Langue interface :</span>
        </span>
        <div id="uiLangSelect" class="select"></div>
      </label>
      <label class="row checkbox">
        <input type="checkbox" id="autoRead" />
        <span id="lblAutoRead">Lecture automatique des nouvelles réponses</span>
      </label>
      <label class="row checkbox">
        <input type="checkbox" id="barTop" />
        <span id="lblBarTop">Afficher la barre flottante</span>
      </label>
      <label class="row checkbox">
        <input type="checkbox" id="barStart" />
        <span id="lblBarStart">Afficher la barre flottante au démarrage</span>
      </label>
      <label class="row checkbox">
        <input type="checkbox" id="showText" />
        <span id="lblShowText">Afficher la fenêtre de traduction</span>
      </label>
    </div>

    <div class="group">
      <div class="groupTitle" id="grpTtsTitle">TTS</div>
      <label class="row checkbox">
        <input type="checkbox" id="pauseService" />
        <span id="lblPauseService">Mettre le service en pause</span>
      </label>
      <label class="row checkbox">
        <input type="checkbox" id="mute" />
        <span id="lblMute">Muet (coupe la lecture)</span>
      </label>

      <label class="row">
        <span id="lblVoice">Voix :</span>
        <select id="voice"></select>
      </label>

      <label class="row">
        <span id="lblRateCaption">Vitesse :</span>
        <input type="range" id="rate" min="50" max="200" step="5" />
        <span id="rateVal" class="mono"></span>
      </label>

      <label class="row">
        <span id="lblVolCaption">Volume :</span>
        <input type="range" id="volume" min="0" max="100" step="1" />
        <span id="volVal" class="mono"></span>
      </label>

      <div class="footer">
        <button id="btnTest" class="secondary">Tester la voix</button>
      </div>

      <label class="row checkbox">
        <input type="checkbox" id="translate" />
        <span id="lblTranslate">Traduire si nécessaire (googletrans)</span>
      </label>

      <label class="row">
        <span class="label">
          <span id="targetLangSpeaker" class="speaker" aria-hidden="true"></span>
          <span id="lblTarget">Langue cible :</span>
        </span>
        <div id="targetLangSelect" class="select"></div>
      </label>
    </div>
  </div>

  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

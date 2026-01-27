import * as vscode from "vscode";

export type TranslationPayload = {
  label: string;
  text: string;
  queue: string[];
};

export class TranslationPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly ctx: vscode.ExtensionContext;
  private lastPayload: TranslationPayload | undefined;

  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "codexAudio.translation",
      "Traduction",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
      },
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel.webview.html = this.html(this.panel.webview);
    if (this.lastPayload) this.set(this.lastPayload);
  }

  set(payload: TranslationPayload): void {
    this.lastPayload = payload;
    if (!this.panel) return;
    this.panel.title = payload.label ? `Traduction - ${payload.label}` : "Traduction";
    this.panel.webview.postMessage({ type: "set", payload });
  }


  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "translation.js"));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "translation.css"));

    return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>Traduction</title>
</head>
<body>
  <div id="root">
    <div id="title"></div>
    <div id="content"></div>
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

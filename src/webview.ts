import * as vscode from 'vscode';
import { GridItem, PinnedPreview, PreviewPayload } from './types';

export type ViewMode = 'single' | 'grid';

export type WebviewState = {
  expression: string;
  payload: PreviewPayload;
  liveModeEnabled: boolean;
  viewMode: ViewMode;
  pinned: PinnedPreview[];
};

export interface PreviewPanelCallbacks {
  onRefresh: () => void;
  onToggleLive: () => void;
  onPin: () => void;
  onToggleGrid: () => void;
  onAddToCompare: () => void;
  onPromote: (index: number) => void;
  onUnpin: (index: number) => void;
  onDispose: () => void;
}

export function createPreviewPanel(
  context: vscode.ExtensionContext,
  callbacks: PreviewPanelCallbacks
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'cvPreview',
    'CV Preview',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  panel.onDidDispose(() => callbacks.onDispose(), undefined, context.subscriptions);

  panel.webview.onDidReceiveMessage((message) => {
    switch (message?.command) {
      case 'refresh':
        callbacks.onRefresh();
        break;
      case 'toggleLive':
        callbacks.onToggleLive();
        break;
      case 'pin':
        callbacks.onPin();
        break;
      case 'toggleGrid':
        callbacks.onToggleGrid();
        break;
      case 'addToCompare':
        callbacks.onAddToCompare();
        break;
      case 'promote':
        if (typeof message.index === 'number') {
          callbacks.onPromote(message.index);
        }
        break;
      case 'unpin':
        if (typeof message.index === 'number') {
          callbacks.onUnpin(message.index);
        }
        break;
    }
  }, undefined, context.subscriptions);

  return panel;
}

export function renderPreviewPanel(panel: vscode.WebviewPanel, state: WebviewState, reveal: boolean): void {
  panel.title = `CV Preview: ${state.expression}`;
  panel.webview.html = getWebviewHtml(panel.webview, state);
  if (reveal) {
    panel.reveal(vscode.ViewColumn.Beside);
  }
}

type GridEntry = {
  label: string;
  ok: boolean;
  mime?: string;
  base64?: string;
  metadata?: Record<string, unknown>;
  error?: string;
  kind?: string;
};

function isBatchPayload(payload: PreviewPayload): boolean {
  return payload.kind === 'images' && Array.isArray(payload.items);
}

function getGridEntries(state: WebviewState): GridEntry[] {
  if (isBatchPayload(state.payload)) {
    return (state.payload.items as GridItem[]).map((item, index) => ({
      label: `${state.expression}[${index}]`,
      ok: item.ok,
      mime: item.mime,
      base64: item.base64,
      metadata: item.metadata,
      error: item.error
    }));
  }

  return state.pinned.map((pinned) => ({
    label: pinned.expression,
    ok: pinned.payload.ok,
    mime: pinned.payload.mime,
    base64: pinned.payload.base64,
    metadata: pinned.payload.metadata,
    error: pinned.payload.error,
    kind: pinned.payload.kind
  }));
}

export function getWebviewHtml(webview: vscode.Webview, state: WebviewState): string {
  const nonce = getNonce();
  const showGrid = isBatchPayload(state.payload) || state.viewMode === 'grid';
  const canShowGridToggle = !isBatchPayload(state.payload);
  const canPin = !showGrid && state.payload.ok && state.payload.kind !== 'images';

  const bodyHtml = showGrid
    ? renderGridView(getGridEntries(state))
    : renderSingleView(state.payload);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>CV Preview</title>
  <style>${getStyles()}</style>
</head>
<body>
  <div class="toolbar">
    <div class="title">${escapeHtml(state.expression)}</div>
    <div class="zoomControls" id="zoomControls" ${showGrid || state.payload.kind === 'table' ? 'style="display:none"' : ''}>
      <button id="zoomOut" type="button" title="Zoom out">&minus;</button>
      <span id="zoomLabel">100%</span>
      <button id="zoomIn" type="button" title="Zoom in">+</button>
      <button id="zoomReset" type="button" title="Reset zoom">Reset</button>
    </div>
    <div class="actions">
      ${canPin ? '<button id="pin" type="button">Pin</button>' : ''}
      ${showGrid ? '<button id="addToCompare" type="button">Add to Compare…</button>' : ''}
      ${canShowGridToggle ? `<button id="toggleGrid" type="button">${showGrid ? 'Back to Single' : `Compare (${state.pinned.length})`}</button>` : ''}
      <button id="live" type="button">${state.liveModeEnabled ? 'Live: On' : 'Live: Off'}</button>
      <button id="refresh" type="button">Refresh</button>
    </div>
  </div>
  ${bodyHtml}
  <script nonce="${nonce}">${getClientScript(state, showGrid)}</script>
</body>
</html>`;
}

function renderSingleView(payload: PreviewPayload): string {
  if (payload.kind === 'table' && payload.table) {
    return renderTable(payload);
  }

  if (!payload.ok || !payload.mime || !payload.base64) {
    return `<main class="single"><div class="error">${escapeHtml(payload.error ?? 'Unable to preview this value as an image.')}</div></main>`;
  }

  const metadataRows = renderMetadataRows(payload.metadata ?? {});

  return `<main class="single">
    <div class="imageShell" id="imageShell">
      <canvas id="cvpCanvas"></canvas>
    </div>
    <aside>
      <dl>${metadataRows}</dl>
      <div class="hoverReadout" id="hoverReadout">Hover the image to inspect pixels.</div>
      <div class="histogramBlock">
        <div class="histogramTitle">Histogram</div>
        <canvas id="histogramCanvas" width="240" height="100"></canvas>
      </div>
    </aside>
  </main>`;
}

function renderTable(payload: PreviewPayload): string {
  const table = payload.table!;
  const headerHtml = table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const rowsHtml = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell === null || cell === undefined ? '' : String(cell))}</td>`).join('')}</tr>`)
    .join('');
  const metadataRows = renderMetadataRows(payload.metadata ?? {});
  const truncatedNote = table.truncated
    ? `<div class="note">Showing first ${table.rows.length} of ${table.rowCount} rows.</div>`
    : '';

  return `<main class="single tableMain">
    <div class="tableShell">
      ${truncatedNote}
      <table class="cvpTable">
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <aside>
      <dl>${metadataRows}</dl>
    </aside>
  </main>`;
}

function renderGridView(entries: GridEntry[]): string {
  if (entries.length === 0) {
    return `<main class="grid"><div class="error">Nothing to compare yet. Preview a value and click Pin.</div></main>`;
  }

  const cells = entries.map((entry, index) => {
    const inner = entry.ok && entry.mime && entry.base64
      ? `<img src="data:${escapeHtml(entry.mime)};base64,${entry.base64}" alt="${escapeHtml(entry.label)}" />`
      : entry.kind === 'table'
        ? `<div class="gridTablePlaceholder">Table</div>`
        : `<div class="gridError">${escapeHtml(entry.error ?? 'Unavailable')}</div>`;

    return `<div class="gridCell" data-index="${index}">
      <div class="gridCellImage">${inner}</div>
      <div class="gridCellLabel" title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</div>
      <button class="gridCellRemove" data-index="${index}" title="Remove">&times;</button>
    </div>`;
  }).join('');

  return `<main class="grid"><div class="gridContainer">${cells}</div></main>`;
}

function renderMetadataRows(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .map(([key, value]) => {
      const renderedValue = Array.isArray(value) ? value.join(' x ') : String(value);
      return `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(renderedValue)}</dd>`;
    })
    .join('');
}

function getStyles(): string {
  return `
    :root { color-scheme: light dark; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .actions { display: flex; gap: 6px; flex: 0 0 auto; }
    .zoomControls { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
    button { height: 28px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 0 10px; border-radius: 3px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    main.single { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 280px); min-height: calc(100vh - 49px); }
    main.tableMain { grid-template-columns: minmax(0, 1fr) minmax(200px, 260px); }
    .imageShell { display: flex; align-items: flex-start; justify-content: flex-start; overflow: auto; padding: 16px; background-image: linear-gradient(45deg, var(--vscode-editorWidget-background) 25%, transparent 25%), linear-gradient(-45deg, var(--vscode-editorWidget-background) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--vscode-editorWidget-background) 75%), linear-gradient(-45deg, transparent 75%, var(--vscode-editorWidget-background) 75%); background-size: 24px 24px; background-position: 0 0, 0 12px, 12px -12px, -12px 0; }
    #cvpCanvas { box-shadow: 0 0 0 1px var(--vscode-panel-border); background: var(--vscode-editor-background); }
    aside { border-left: 1px solid var(--vscode-panel-border); padding: 12px; overflow: auto; background: var(--vscode-sideBar-background); display: flex; flex-direction: column; gap: 12px; }
    dl { display: grid; grid-template-columns: minmax(70px, auto) minmax(0, 1fr); gap: 8px 12px; margin: 0; }
    dt { color: var(--vscode-descriptionForeground); }
    dd { margin: 0; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
    .hoverReadout { font-family: var(--vscode-editor-font-family); font-size: 12px; border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; white-space: pre-line; }
    .histogramBlock { border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
    .histogramTitle { color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
    .error { margin: 16px; padding: 12px; border: 1px solid var(--vscode-inputValidation-errorBorder); background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
    .note { margin-bottom: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .tableShell { overflow: auto; padding: 16px; }
    table.cvpTable { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    table.cvpTable th, table.cvpTable td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; white-space: nowrap; }
    table.cvpTable thead th { background: var(--vscode-sideBar-background); position: sticky; top: 0; }
    main.grid { padding: 16px; }
    .gridContainer { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 14px; }
    .gridCell { position: relative; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; display: flex; flex-direction: column; gap: 6px; cursor: pointer; background: var(--vscode-sideBar-background); }
    .gridCell:hover { border-color: var(--vscode-focusBorder); }
    .gridCellImage { height: 120px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: var(--vscode-editor-background); }
    .gridCellImage img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .gridTablePlaceholder, .gridError { font-size: 12px; color: var(--vscode-descriptionForeground); text-align: center; padding: 8px; }
    .gridCellLabel { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gridCellRemove { position: absolute; top: 4px; right: 4px; height: 20px; width: 20px; padding: 0; line-height: 1; border-radius: 50%; }
    @media (max-width: 720px) {
      main.single, main.tableMain { grid-template-columns: 1fr; }
      aside { border-left: 0; border-top: 1px solid var(--vscode-panel-border); }
    }
  `;
}

function getClientScript(state: WebviewState, showGrid: boolean): string {
  const isImageSingle = !showGrid && state.payload.ok && state.payload.kind !== 'table' && !!state.payload.base64;
  const imageDataUrl = isImageSingle ? `data:${state.payload.mime};base64,${state.payload.base64}` : '';
  const metadataJson = JSON.stringify(state.payload.metadata ?? {});

  return `
    const vscode = acquireVsCodeApi();

    function on(id, event, handler) {
      const el = document.getElementById(id);
      if (el) { el.addEventListener(event, handler); }
    }

    on('refresh', 'click', () => vscode.postMessage({ command: 'refresh' }));
    on('live', 'click', () => vscode.postMessage({ command: 'toggleLive' }));
    on('pin', 'click', () => vscode.postMessage({ command: 'pin' }));
    on('toggleGrid', 'click', () => vscode.postMessage({ command: 'toggleGrid' }));
    on('addToCompare', 'click', () => vscode.postMessage({ command: 'addToCompare' }));

    document.querySelectorAll('.gridCellRemove').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const index = Number(btn.getAttribute('data-index'));
        vscode.postMessage({ command: 'unpin', index });
      });
    });

    document.querySelectorAll('.gridCell').forEach((cell) => {
      cell.addEventListener('click', () => {
        const index = Number(cell.getAttribute('data-index'));
        vscode.postMessage({ command: 'promote', index });
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message && message.command === 'liveState') {
        const liveButton = document.getElementById('live');
        if (liveButton) { liveButton.textContent = message.enabled ? 'Live: On' : 'Live: Off'; }
      }
    });

    ${isImageSingle ? getImageInspectionScript(imageDataUrl, metadataJson) : ''}
  `;
}

function getImageInspectionScript(imageDataUrl: string, metadataJson: string): string {
  return `
    (function () {
      const metadata = ${metadataJson};
      const canvas = document.getElementById('cvpCanvas');
      const shell = document.getElementById('imageShell');
      const hoverReadout = document.getElementById('hoverReadout');
      const histogramCanvas = document.getElementById('histogramCanvas');
      const zoomLabel = document.getElementById('zoomLabel');
      if (!canvas || !shell) { return; }

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let scale = 1;
      let imageData = null;

      function applyScale() {
        canvas.style.width = (canvas.width * scale) + 'px';
        canvas.style.height = (canvas.height * scale) + 'px';
        canvas.style.imageRendering = scale > 1 ? 'pixelated' : 'auto';
        if (zoomLabel) { zoomLabel.textContent = Math.round(scale * 100) + '%'; }
      }

      function setScale(next) {
        scale = Math.min(16, Math.max(0.1, next));
        applyScale();
      }

      function bindClick(id, handler) {
        const el = document.getElementById(id);
        if (el) { el.addEventListener('click', handler); }
      }

      bindClick('zoomIn', () => setScale(scale * 1.25));
      bindClick('zoomOut', () => setScale(scale / 1.25));
      bindClick('zoomReset', () => setScale(1));

      shell.addEventListener('wheel', (event) => {
        event.preventDefault();
        setScale(event.deltaY < 0 ? scale * 1.1 : scale / 1.1);
      }, { passive: false });

      function computeHistogram() {
        if (!histogramCanvas || !imageData) { return; }
        const bins = 32;
        const channels = imageData.data.length / (canvas.width * canvas.height) >= 3 ? 3 : 1;
        const histograms = [new Array(bins).fill(0), new Array(bins).fill(0), new Array(bins).fill(0)];
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          for (let c = 0; c < channels; c += 1) {
            const value = data[i + c];
            const bin = Math.min(bins - 1, Math.floor((value / 256) * bins));
            histograms[c][bin] += 1;
          }
        }

        const hctx = histogramCanvas.getContext('2d');
        hctx.clearRect(0, 0, histogramCanvas.width, histogramCanvas.height);
        const colors = channels === 1 ? ['#cccccc'] : ['#ff5555', '#55cc55', '#5599ff'];
        let maxCount = 1;
        histograms.slice(0, channels).forEach((h) => { maxCount = Math.max(maxCount, ...h); });

        const barWidth = histogramCanvas.width / bins;
        hctx.globalAlpha = channels === 1 ? 1 : 0.6;
        for (let c = 0; c < channels; c += 1) {
          hctx.fillStyle = colors[c];
          for (let b = 0; b < bins; b += 1) {
            const barHeight = (histograms[c][b] / maxCount) * histogramCanvas.height;
            hctx.fillRect(b * barWidth, histogramCanvas.height - barHeight, barWidth - 1, barHeight);
          }
        }
      }

      function approxOriginal(displayValue) {
        if (typeof metadata.min !== 'number' || typeof metadata.max !== 'number' || metadata.min === metadata.max) {
          return null;
        }
        return metadata.min + (displayValue / 255) * (metadata.max - metadata.min);
      }

      canvas.addEventListener('mousemove', (event) => {
        if (!imageData) { return; }
        const rect = canvas.getBoundingClientRect();
        const x = Math.floor((event.clientX - rect.left) * (canvas.width / rect.width));
        const y = Math.floor((event.clientY - rect.top) * (canvas.height / rect.height));
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) { return; }

        const offset = (y * canvas.width + x) * 4;
        const r = imageData.data[offset];
        const g = imageData.data[offset + 1];
        const b = imageData.data[offset + 2];
        const a = imageData.data[offset + 3];
        const mode = metadata.mode;

        let displayText;
        let approxText = '';
        if (mode === 'L') {
          displayText = 'Displayed L: ' + r;
          const approx = approxOriginal(r);
          if (approx !== null) { approxText = '\\nApprox. original: ' + approx.toFixed(4); }
        } else if (mode === 'RGBA') {
          displayText = 'Displayed RGBA(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
        } else {
          displayText = 'Displayed RGB(' + r + ', ' + g + ', ' + b + ')';
        }

        if (hoverReadout) {
          hoverReadout.textContent = 'x: ' + x + ', y: ' + y + '\\n' + displayText + approxText;
        }
      });

      const img = new Image();
      img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);
        imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        applyScale();
        computeHistogram();
      };
      img.src = '${imageDataUrl}';
    })();
  `;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

import * as vscode from 'vscode';
import { buildPythonEvaluateExpression, buildPythonMetadataExpression, buildPythonHoverThumbnailExpression } from './pythonHelper';
import { decodeEvaluateResult, hydratePayload } from './resultDecoding';
import { ChannelOrder, GridItem, PinnedPreview, PreviewPayload } from './types';
import { createPreviewPanel, renderPreviewPanel, WebviewState } from './webview';

let previewPanel: vscode.WebviewPanel | undefined;
let lastExpression: string | undefined;
let lastChannelOrder: ChannelOrder | undefined;
let lastPayload: PreviewPayload | undefined;
let liveModeEnabled = false;
let refreshInFlight = false;
let pinnedPreviews: PinnedPreview[] = [];
let viewMode: 'single' | 'grid' = 'single';

const HOVER_CACHE_TTL_MS = 1500;
const HOVER_CACHE_MAX_SIZE = 200;
const hoverCache = new Map<string, { timestamp: number; payload: PreviewPayload }>();

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('cvPreview.previewVariable', async () => {
      await previewVariable(context);
    }),
    vscode.commands.registerCommand('cvPreview.previewVariableFromContext', async (arg: unknown) => {
      await previewVariableFromMenu(context, arg);
    }),
    vscode.commands.registerCommand('cvPreview.toggleLiveRefresh', () => {
      setLiveMode(!liveModeEnabled);
    }),
    vscode.commands.registerCommand('cvPreview.addToCompareFromContext', async (arg: unknown) => {
      await handleAddToCompareFromMenu(context, arg);
    }),
    vscode.debug.onDidChangeActiveStackItem(() => {
      if (liveModeEnabled && previewPanel && lastExpression && !refreshInFlight) {
        void refreshPreview(context, false);
      }
    }),
    vscode.languages.registerHoverProvider({ language: 'python' }, { provideHover })
  );
}

export function deactivate() {
  previewPanel?.dispose();
}

async function previewVariable(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('cvPreview');
  const defaultExpression = lastExpression ?? config.get<string>('defaultExpression') ?? 'img';
  const configuredChannelOrder = config.get<ChannelOrder>('channelOrder') ?? 'RGB';
  const expression = await vscode.window.showInputBox({
    title: 'Preview Python Image Variable',
    prompt: 'Enter a Python expression: a numpy array, PIL image, torch/tensorflow tensor, pandas DataFrame/Series, or a list of arrays.',
    value: defaultExpression,
    ignoreFocusOut: true
  });

  if (!expression?.trim()) {
    return;
  }

  const selectedChannelOrder = await pickChannelOrder(lastChannelOrder ?? configuredChannelOrder);
  if (!selectedChannelOrder) {
    return;
  }

  await runPreview(context, expression.trim(), selectedChannelOrder, true);
}

async function previewVariableFromMenu(context: vscode.ExtensionContext, arg: unknown) {
  const expression = resolveExpressionFromMenuArg(arg);
  if (!expression) {
    vscode.window.showWarningMessage('CV Preview could not determine the variable to preview from this menu.');
    return;
  }

  const config = vscode.workspace.getConfiguration('cvPreview');
  const channelOrder = lastChannelOrder ?? config.get<ChannelOrder>('channelOrder') ?? 'RGB';
  await runPreview(context, expression, channelOrder, true);
}

function resolveExpressionFromMenuArg(arg: unknown): string | undefined {
  const a = arg as { variable?: { evaluateName?: unknown; name?: unknown }; expression?: unknown } | string | undefined;
  if (typeof a === 'string' && a.trim()) {
    return a;
  }

  const evaluateName = (a as { variable?: { evaluateName?: unknown } })?.variable?.evaluateName;
  if (typeof evaluateName === 'string' && evaluateName.trim()) {
    return evaluateName;
  }

  const name = (a as { variable?: { name?: unknown } })?.variable?.name;
  if (typeof name === 'string' && name.trim()) {
    return name;
  }

  const expression = (a as { expression?: unknown })?.expression;
  if (typeof expression === 'string' && expression.trim()) {
    return expression;
  }

  return undefined;
}

async function refreshPreview(context: vscode.ExtensionContext, reveal: boolean) {
  const config = vscode.workspace.getConfiguration('cvPreview');
  const expression = lastExpression ?? config.get<string>('defaultExpression') ?? 'img';
  const channelOrder = lastChannelOrder ?? config.get<ChannelOrder>('channelOrder') ?? 'RGB';
  await runPreview(context, expression, channelOrder, reveal);
}

async function runPreview(context: vscode.ExtensionContext, expression: string, channelOrder: ChannelOrder, reveal: boolean) {
  const session = vscode.debug.activeDebugSession;
  const stackItem = vscode.debug.activeStackItem;

  if (!session) {
    vscode.window.showWarningMessage('Start a Python debug session and pause at a breakpoint before previewing a value.');
    return;
  }

  const frameId = getFrameId(stackItem);
  if (frameId === undefined) {
    vscode.window.showWarningMessage('Select a paused stack frame before previewing a value.');
    return;
  }

  lastExpression = expression;
  lastChannelOrder = channelOrder;

  const task = async () => {
    refreshInFlight = true;
    try {
      const payload = await evaluatePythonImage(session, frameId, expression, channelOrder);
      lastPayload = payload;
      viewMode = payload.kind === 'images' ? 'grid' : 'single';
      showPanel(context, reveal);

      if (!payload.ok) {
        vscode.window.showErrorMessage(payload.error ?? 'The selected value could not be previewed.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`CV Preview failed: ${message}`);
    } finally {
      refreshInFlight = false;
    }
  };

  if (reveal) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Previewing ${expression}`, cancellable: false },
      task
    );
  } else {
    await task();
  }
}

async function pickChannelOrder(defaultValue: ChannelOrder): Promise<ChannelOrder | undefined> {
  const items: Array<vscode.QuickPickItem & { value: ChannelOrder }> = [
    {
      label: 'RGB / RGBA',
      description: 'numpy, Pillow, matplotlib',
      picked: defaultValue === 'RGB',
      value: 'RGB'
    },
    {
      label: 'BGR / BGRA',
      description: 'OpenCV cv2 images',
      picked: defaultValue === 'BGR',
      value: 'BGR'
    }
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Select Channel Order',
    placeHolder: 'Choose how 3-channel and 4-channel arrays should be interpreted.',
    ignoreFocusOut: true
  });

  return selected?.value;
}

function getFrameId(stackItem: vscode.DebugThread | vscode.DebugStackFrame | undefined): number | undefined {
  if (stackItem && 'frameId' in stackItem && typeof stackItem.frameId === 'number') {
    return stackItem.frameId;
  }

  return undefined;
}

async function evaluatePythonImage(
  session: vscode.DebugSession,
  frameId: number,
  expression: string,
  channelOrder: ChannelOrder
): Promise<PreviewPayload> {
  const evaluateExpression = buildPythonEvaluateExpression(expression, channelOrder);
  const response = await session.customRequest('evaluate', {
    expression: evaluateExpression,
    frameId,
    context: 'watch'
  });

  const result = typeof response?.result === 'string' ? response.result : '';
  const payload = decodeEvaluateResult(result);
  return await hydratePayload(payload);
}

async function provideHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken
): Promise<vscode.Hover | undefined> {
  const config = vscode.workspace.getConfiguration('cvPreview');
  if (!config.get<boolean>('enableHoverPreview', true)) {
    return undefined;
  }

  const session = vscode.debug.activeDebugSession;
  if (!session) {
    return undefined;
  }

  const frameId = getFrameId(vscode.debug.activeStackItem);
  if (frameId === undefined) {
    return undefined;
  }

  const wordRange = document.getWordRangeAtPosition(position);
  if (!wordRange) {
    return undefined;
  }

  const expression = document.getText(wordRange);
  if (!expression.trim()) {
    return undefined;
  }

  let payload = await getHoverMetadata(session, frameId, expression);
  if (token.isCancellationRequested || !payload || !payload.ok) {
    return undefined;
  }

  if (payload.kind === 'image') {
    const channelOrder = lastChannelOrder ?? config.get<ChannelOrder>('channelOrder') ?? 'RGB';
    const richPayload = await getHoverImage(session, frameId, expression, channelOrder);
    if (!token.isCancellationRequested && richPayload?.ok) {
      payload = richPayload;
    }
  }

  const markdown = buildHoverMarkdown(expression, payload);
  if (!markdown) {
    return undefined;
  }

  return new vscode.Hover(markdown, wordRange);
}

async function getHoverImage(
  session: vscode.DebugSession,
  frameId: number,
  expression: string,
  channelOrder: ChannelOrder
): Promise<PreviewPayload | undefined> {
  const cacheKey = `img:${frameId}:${channelOrder}:${expression}`;
  const cached = hoverCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < HOVER_CACHE_TTL_MS) {
    return cached.payload;
  }

  try {
    // Thumbnail pipeline: downscales to ≤96 px and returns base64 inline — no temp file,
    // always small enough for VS Code's hover content size limits regardless of source resolution.
    const thumbnailExpression = buildPythonHoverThumbnailExpression(expression, channelOrder);
    const response = await session.customRequest('evaluate', {
      expression: thumbnailExpression,
      frameId,
      context: 'watch'
    });
    const result = typeof response?.result === 'string' ? response.result : '';
    const payload = decodeEvaluateResult(result);
    if (hoverCache.size >= HOVER_CACHE_MAX_SIZE) {
      hoverCache.clear();
    }
    hoverCache.set(cacheKey, { timestamp: Date.now(), payload });
    return payload;
  } catch {
    return undefined;
  }
}

async function getHoverMetadata(
  session: vscode.DebugSession,
  frameId: number,
  expression: string
): Promise<PreviewPayload | undefined> {
  const cacheKey = `${frameId}:${expression}`;
  const cached = hoverCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < HOVER_CACHE_TTL_MS) {
    return cached.payload;
  }

  try {
    const evaluateExpression = buildPythonMetadataExpression(expression);
    const response = await session.customRequest('evaluate', {
      expression: evaluateExpression,
      frameId,
      context: 'watch'
    });
    const result = typeof response?.result === 'string' ? response.result : '';
    const payload = decodeEvaluateResult(result);

    if (hoverCache.size >= HOVER_CACHE_MAX_SIZE) {
      hoverCache.clear();
    }
    hoverCache.set(cacheKey, { timestamp: Date.now(), payload });
    return payload;
  } catch {
    return undefined;
  }
}

const OPEN_PREVIEW_COMMAND = 'cvPreview.previewVariableFromContext';

function buildOpenPreviewLink(expression: string): string {
  const args = [{ expression }];
  const encoded = encodeURIComponent(JSON.stringify(args));
  return `[Open Preview ▸](command:${OPEN_PREVIEW_COMMAND}?${encoded})`;
}

function buildHoverMarkdown(expression: string, payload: PreviewPayload): vscode.MarkdownString | undefined {
  if (!payload.kind) {
    return undefined;
  }

  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.supportHtml = true;
  markdown.isTrusted = { enabledCommands: [OPEN_PREVIEW_COMMAND] };

  const metadata = payload.metadata ?? {};
  const shape = Array.isArray(metadata.shape) ? metadata.shape.join('×') : undefined;

  if (payload.kind === 'table') {
    markdown.appendMarkdown(`**${expression}** — table${shape ? ` (${shape})` : ''}\n\n`);
    markdown.appendMarkdown(buildOpenPreviewLink(expression));
    return markdown;
  }

  if (payload.kind === 'images') {
    const total = metadata.totalCount as number | undefined;
    markdown.appendMarkdown(`**${expression}** — batch of ${total ?? '?'} images\n\n`);
    markdown.appendMarkdown(buildOpenPreviewLink(expression));
    return markdown;
  }

  if (payload.kind === 'image') {
    if (payload.mime && payload.base64) {
      markdown.appendMarkdown(`<img src="data:${payload.mime};base64,${payload.base64}" /><br/>`);
    }
    const summary = [shape, metadata.dtype].filter(Boolean).join(' ');
    markdown.appendMarkdown(`**${expression}**${summary ? ` — ${summary}` : ''}\n\n`);
    markdown.appendMarkdown(buildOpenPreviewLink(expression));
    return markdown;
  }

  return undefined;
}

function setLiveMode(enabled: boolean) {
  liveModeEnabled = enabled;
  previewPanel?.webview.postMessage({ command: 'liveState', enabled });
}

function showPanel(context: vscode.ExtensionContext, reveal: boolean) {
  if (!previewPanel) {
    previewPanel = createPreviewPanel(context, {
      onRefresh: () => {
        void refreshPreview(context, true);
      },
      onToggleLive: () => setLiveMode(!liveModeEnabled),
      onPin: () => handlePin(context),
      onToggleGrid: () => handleToggleGrid(context),
      onAddToCompare: () => {
        void handleAddToCompare(context);
      },
      onPromote: (index) => handlePromote(context, index),
      onUnpin: (index) => handleUnpin(context, index),
      onDispose: () => {
        previewPanel = undefined;
      }
    });
  }

  const state: WebviewState = {
    expression: lastExpression ?? '',
    payload: lastPayload ?? { ok: false, error: 'Nothing previewed yet.' },
    liveModeEnabled,
    viewMode,
    pinned: pinnedPreviews
  };

  renderPreviewPanel(previewPanel, state, reveal);
}

function handlePin(context: vscode.ExtensionContext) {
  if (!lastExpression || !lastPayload || !lastPayload.ok || lastPayload.kind === 'images') {
    return;
  }

  const entry: PinnedPreview = { expression: lastExpression, payload: lastPayload };
  const existingIndex = pinnedPreviews.findIndex((p) => p.expression === lastExpression);
  if (existingIndex >= 0) {
    pinnedPreviews[existingIndex] = entry;
  } else {
    pinnedPreviews.push(entry);
  }

  showPanel(context, true);
}

async function handleAddToCompare(context: vscode.ExtensionContext) {
  const session = vscode.debug.activeDebugSession;
  const stackItem = vscode.debug.activeStackItem;

  if (!session) {
    vscode.window.showWarningMessage('Start a Python debug session and pause at a breakpoint before adding to Compare.');
    return;
  }

  const frameId = getFrameId(stackItem);
  if (frameId === undefined) {
    vscode.window.showWarningMessage('Select a paused stack frame before adding to Compare.');
    return;
  }

  const expression = await vscode.window.showInputBox({
    title: 'Add to Compare',
    prompt: 'Enter a Python expression to add to the comparison grid.',
    ignoreFocusOut: true
  });

  if (!expression?.trim()) {
    return;
  }

  const config = vscode.workspace.getConfiguration('cvPreview');
  const channelOrder = lastChannelOrder ?? config.get<ChannelOrder>('channelOrder') ?? 'RGB';
  const trimmedExpression = expression.trim();

  const payload = await evaluatePythonImage(session, frameId, trimmedExpression, channelOrder);

  if (!payload.ok || payload.kind === 'images') {
    vscode.window.showErrorMessage(payload.error ?? 'This value cannot be added to the comparison grid.');
    return;
  }

  const entry: PinnedPreview = { expression: trimmedExpression, payload };
  const existingIndex = pinnedPreviews.findIndex((p) => p.expression === trimmedExpression);
  if (existingIndex >= 0) {
    pinnedPreviews[existingIndex] = entry;
  } else {
    pinnedPreviews.push(entry);
  }

  viewMode = 'grid';
  showPanel(context, true);
}

async function handleAddToCompareFromMenu(context: vscode.ExtensionContext, arg: unknown) {
  const expression = resolveExpressionFromMenuArg(arg);
  if (!expression) {
    vscode.window.showWarningMessage('CV Preview could not determine the variable from this menu.');
    return;
  }

  const session = vscode.debug.activeDebugSession;
  const stackItem = vscode.debug.activeStackItem;

  if (!session) {
    vscode.window.showWarningMessage('Start a Python debug session and pause at a breakpoint before adding to Compare.');
    return;
  }

  const frameId = getFrameId(stackItem);
  if (frameId === undefined) {
    vscode.window.showWarningMessage('Select a paused stack frame before adding to Compare.');
    return;
  }

  const config = vscode.workspace.getConfiguration('cvPreview');
  const channelOrder = lastChannelOrder ?? config.get<ChannelOrder>('channelOrder') ?? 'RGB';

  const payload = await evaluatePythonImage(session, frameId, expression, channelOrder);

  if (!payload.ok || payload.kind === 'images') {
    vscode.window.showErrorMessage(payload.error ?? 'This value cannot be added to the comparison grid.');
    return;
  }

  const entry: PinnedPreview = { expression, payload };
  const existingIndex = pinnedPreviews.findIndex((p) => p.expression === expression);
  if (existingIndex >= 0) {
    pinnedPreviews[existingIndex] = entry;
  } else {
    pinnedPreviews.push(entry);
  }

  if (!lastExpression) {
    lastExpression = expression;
    lastPayload = payload;
  }
  viewMode = 'grid';
  showPanel(context, true);
}

function handleUnpin(context: vscode.ExtensionContext, index: number) {
  pinnedPreviews.splice(index, 1);
  if (pinnedPreviews.length === 0 && viewMode === 'grid' && lastPayload?.kind !== 'images') {
    viewMode = 'single';
  }
  showPanel(context, true);
}

function handleToggleGrid(context: vscode.ExtensionContext) {
  if (lastPayload?.kind === 'images') {
    return;
  }

  if (viewMode === 'single') {
    if (pinnedPreviews.length === 0) {
      vscode.window.showInformationMessage('Pin a preview first, then use Compare to see it here.');
      return;
    }
    viewMode = 'grid';
  } else {
    viewMode = 'single';
  }

  showPanel(context, true);
}

function handlePromote(context: vscode.ExtensionContext, index: number) {
  if (lastPayload?.kind === 'images' && lastPayload.items) {
    const item: GridItem | undefined = lastPayload.items[index];
    if (!item) {
      return;
    }

    lastExpression = `${lastExpression}[${index}]`;
    lastPayload = {
      ok: item.ok,
      kind: 'image',
      mime: item.mime,
      base64: item.base64,
      metadata: item.metadata,
      error: item.error
    };
    viewMode = 'single';
    showPanel(context, true);
    return;
  }

  const pinned = pinnedPreviews[index];
  if (!pinned) {
    return;
  }

  lastExpression = pinned.expression;
  lastPayload = pinned.payload;
  viewMode = 'single';
  showPanel(context, true);
}

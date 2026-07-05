import * as vscode from 'vscode';
import { GridItem, PreviewPayload } from './types';

export function stripPythonStringQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '\'' && last === '\'') || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }

  return value;
}

export function getJsonCandidates(value: string): string[] {
  const stripped = stripPythonStringQuotes(value);
  const unescaped = stripped
    .replace(/\\"/g, '"')
    .replace(/\\'/g, '\'')
    .replace(/\\\\/g, '\\');

  return Array.from(new Set([value, stripped, unescaped]));
}

export function decodeEvaluateResult(result: string): PreviewPayload {
  const trimmed = result.trim();
  const candidates = getJsonCandidates(trimmed);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'string') {
        return JSON.parse(parsed) as PreviewPayload;
      }

      if (parsed && typeof parsed === 'object') {
        return parsed as PreviewPayload;
      }
    } catch {
      // Try the next representation from the debugger.
    }
  }

  return {
    ok: false,
    error: `CV Preview expected compact JSON describing the preview, but the debugger returned: ${result.slice(0, 240)}`
  };
}

async function readImageAsBase64(imagePath: string): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(imagePath));
  return Buffer.from(bytes).toString('base64');
}

export async function loadImageFromPath(payload: PreviewPayload): Promise<PreviewPayload> {
  if (!payload.ok || payload.base64 || !payload.imagePath) {
    return payload;
  }

  try {
    const base64 = await readImageAsBase64(payload.imagePath);
    return {
      ...payload,
      base64
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Image was encoded, but VS Code could not read ${payload.imagePath}: ${message}`,
      metadata: payload.metadata
    };
  }
}

async function loadGridItem(item: GridItem): Promise<GridItem> {
  if (!item.ok || item.base64 || !item.imagePath) {
    return item;
  }

  try {
    const base64 = await readImageAsBase64(item.imagePath);
    return { ...item, base64 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Image was encoded, but VS Code could not read ${item.imagePath}: ${message}`,
      metadata: item.metadata
    };
  }
}

export async function loadGridImages(payload: PreviewPayload): Promise<PreviewPayload> {
  if (!payload.ok || !payload.items) {
    return payload;
  }

  const items = await Promise.all(payload.items.map(loadGridItem));
  return { ...payload, items };
}

export async function hydratePayload(payload: PreviewPayload): Promise<PreviewPayload> {
  if (!payload.ok) {
    return payload;
  }

  if (payload.kind === 'images') {
    return loadGridImages(payload);
  }

  if (payload.kind === 'table') {
    return payload;
  }

  return loadImageFromPath(payload);
}

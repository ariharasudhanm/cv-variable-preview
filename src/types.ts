export type ChannelOrder = 'RGB' | 'BGR';

export type PreviewKind = 'image' | 'images' | 'table';

export type TablePayload = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
};

export type GridItem = {
  ok: boolean;
  mime?: string;
  base64?: string;
  imagePath?: string;
  metadata?: Record<string, unknown>;
  error?: string;
};

export type PreviewPayload = {
  ok: boolean;
  kind?: PreviewKind;
  mime?: string;
  base64?: string;
  imagePath?: string;
  metadata?: Record<string, unknown>;
  error?: string;
  items?: GridItem[];
  table?: TablePayload;
};

export type PinnedPreview = {
  expression: string;
  payload: PreviewPayload;
};

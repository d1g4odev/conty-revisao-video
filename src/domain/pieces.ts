export const PIECE_KINDS = ["script", "video", "cover", "caption"] as const;

export type PieceKind = (typeof PIECE_KINDS)[number];

export interface PieceKindSpec {
  requiresDuration: boolean;
}

export const PIECE_CATALOG: Readonly<Record<PieceKind, PieceKindSpec>> = {
  script: { requiresDuration: false },
  video: { requiresDuration: true },
  cover: { requiresDuration: false },
  caption: { requiresDuration: false },
};

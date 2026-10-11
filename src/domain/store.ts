import type { Campaign, Comment, Delivery, Version } from "./model.js";
import type { PieceKind } from "./pieces.js";

export class InMemoryStore {
  readonly campaigns = new Map<string, Campaign>();
  readonly deliveries = new Map<string, Delivery>();
  readonly versions = new Map<string, Version>();
  readonly comments = new Map<string, Comment>();

  versionsOf(deliveryId: string, pieceKind: PieceKind): Version[] {
    return [...this.versions.values()]
      .filter((v) => v.deliveryId === deliveryId && v.pieceKind === pieceKind)
      .sort((a, b) => a.number - b.number);
  }

  currentVersion(deliveryId: string, pieceKind: PieceKind): Version | null {
    return this.versionsOf(deliveryId, pieceKind).at(-1) ?? null;
  }

  submittedKinds(deliveryId: string): PieceKind[] {
    const kinds = new Set<PieceKind>();
    for (const version of this.versions.values()) {
      if (version.deliveryId === deliveryId) kinds.add(version.pieceKind);
    }
    return [...kinds];
  }

  commentsOf(versionId: string): Comment[] {
    return [...this.comments.values()]
      .filter((c) => c.versionId === versionId)
      .sort((a, b) => a.second - b.second || a.createdAt.localeCompare(b.createdAt));
  }
}

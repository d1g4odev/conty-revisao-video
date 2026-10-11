import type { PieceKind } from "./pieces.js";

export interface Campaign {
  id: string;
  name: string;
  requiredPieces: PieceKind[];
  createdAt: string;
}

export interface Approval {
  approvedBy: string;
  approvedAt: string;
}

export type RevocationReason = "NEW_VERSION_SUBMITTED" | "CHANGES_REQUESTED";

export type DeliveryEvent =
  | { type: "APPROVED"; at: string; by: string }
  | {
      type: "APPROVAL_REVOKED";
      at: string;
      reason: RevocationReason;
      pieceKind: PieceKind;
      versionId: string;
    };

export interface Delivery {
  id: string;
  campaignId: string;
  creator: string;
  createdAt: string;
  approval: Approval | null;
  history: DeliveryEvent[];
}

export type VersionStatus = "PENDING_REVIEW" | "APPROVED" | "CHANGES_REQUESTED";

export interface VersionReview {
  status: Exclude<VersionStatus, "PENDING_REVIEW">;
  by: string;
  at: string;
  note: string | null;
}

export interface Version {
  id: string;
  deliveryId: string;
  pieceKind: PieceKind;
  number: number;
  content: string;
  durationSeconds: number | null;
  submittedBy: string;
  submittedAt: string;
  status: VersionStatus;
  review: VersionReview | null;
}

export interface Comment {
  id: string;
  versionId: string;
  second: number;
  author: string;
  text: string;
  createdAt: string;
}

export type BlockerReason =
  | "MISSING_PIECE"
  | "CURRENT_VERSION_PENDING_REVIEW"
  | "CURRENT_VERSION_CHANGES_REQUESTED";

export interface Blocker {
  pieceKind: PieceKind;
  reason: BlockerReason;
  currentVersion: number | null;
}

import type { Clock } from "./clock.js";
import { DomainError, notFound } from "./errors.js";
import type { IdGenerator } from "./ids.js";
import type {
  Blocker,
  Campaign,
  Comment,
  Delivery,
  RevocationReason,
  Version,
  VersionStatus,
} from "./model.js";
import { PIECE_CATALOG, PIECE_KINDS, type PieceKind } from "./pieces.js";
import { InMemoryStore } from "./store.js";

export interface CreateCampaignInput {
  name: string;
  requiredPieces: PieceKind[];
}

export interface CreateDeliveryInput {
  creator: string;
}

export interface SubmitVersionInput {
  content: string;
  durationSeconds?: number | undefined;
  submittedBy: string;
}

export type ReviewDecision = "APPROVE" | "REQUEST_CHANGES";

export interface ReviewVersionInput {
  decision: ReviewDecision;
  reviewer: string;
  note?: string | undefined;
}

export interface AddCommentInput {
  second: number;
  author: string;
  text: string;
}

export interface PieceView {
  kind: PieceKind;
  required: boolean;
  versionCount: number;
  currentVersion: Version | null;
}

export interface DeliveryView extends Delivery {
  status: "APPROVED" | "IN_REVIEW";
  requiredPieces: PieceKind[];
  approvable: boolean;
  blockers: Blocker[];
  pieces: PieceView[];
}

const BLOCKER_BY_STATUS: Record<VersionStatus, Blocker["reason"] | null> = {
  PENDING_REVIEW: "CURRENT_VERSION_PENDING_REVIEW",
  CHANGES_REQUESTED: "CURRENT_VERSION_CHANGES_REQUESTED",
  APPROVED: null,
};

const STATUS_BY_DECISION: Record<ReviewDecision, Exclude<VersionStatus, "PENDING_REVIEW">> = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
};

export class ReviewService {
  readonly #store: InMemoryStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(deps: { clock: Clock; ids: IdGenerator; store?: InMemoryStore }) {
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#store = deps.store ?? new InMemoryStore();
  }

  createCampaign(input: CreateCampaignInput): Campaign {
    const campaign: Campaign = {
      id: this.#ids("cmp"),
      name: input.name,
      requiredPieces: PIECE_KINDS.filter((kind) => input.requiredPieces.includes(kind)),
      createdAt: this.#now(),
    };
    this.#store.campaigns.set(campaign.id, campaign);
    return campaign;
  }

  getCampaign(campaignId: string): Campaign {
    const campaign = this.#store.campaigns.get(campaignId);
    if (!campaign) throw notFound("Campaign", campaignId);
    return campaign;
  }

  createDelivery(campaignId: string, input: CreateDeliveryInput): DeliveryView {
    this.getCampaign(campaignId);
    const delivery: Delivery = {
      id: this.#ids("dlv"),
      campaignId,
      creator: input.creator,
      createdAt: this.#now(),
      approval: null,
      history: [],
    };
    this.#store.deliveries.set(delivery.id, delivery);
    return this.getDelivery(delivery.id);
  }

  getDelivery(deliveryId: string): DeliveryView {
    const delivery = this.#delivery(deliveryId);
    const campaign = this.getCampaign(delivery.campaignId);
    const blockers = this.#blockers(delivery, campaign);
    const submitted = this.#store.submittedKinds(delivery.id);
    const kinds = PIECE_KINDS.filter(
      (kind) => campaign.requiredPieces.includes(kind) || submitted.includes(kind),
    );
    return {
      ...delivery,
      status: delivery.approval ? "APPROVED" : "IN_REVIEW",
      requiredPieces: campaign.requiredPieces,
      approvable: delivery.approval === null && blockers.length === 0,
      blockers,
      pieces: kinds.map((kind) => ({
        kind,
        required: campaign.requiredPieces.includes(kind),
        versionCount: this.#store.versionsOf(delivery.id, kind).length,
        currentVersion: this.#store.currentVersion(delivery.id, kind),
      })),
    };
  }

  submitVersion(deliveryId: string, pieceKind: PieceKind, input: SubmitVersionInput): Version {
    const delivery = this.#delivery(deliveryId);
    const durationSeconds = input.durationSeconds ?? null;
    if (PIECE_CATALOG[pieceKind].requiresDuration && durationSeconds === null) {
      throw new DomainError(
        "DURATION_REQUIRED",
        `A ${pieceKind} version must declare durationSeconds so comments can be anchored to a second`,
        { pieceKind },
      );
    }
    const previous = this.#store.currentVersion(deliveryId, pieceKind);
    const version: Version = {
      id: this.#ids("ver"),
      deliveryId,
      pieceKind,
      number: (previous?.number ?? 0) + 1,
      content: input.content,
      durationSeconds,
      submittedBy: input.submittedBy,
      submittedAt: this.#now(),
      status: "PENDING_REVIEW",
      review: null,
    };
    this.#store.versions.set(version.id, version);
    this.#revokeApproval(delivery, "NEW_VERSION_SUBMITTED", version);
    return version;
  }

  listVersions(deliveryId: string, pieceKind: PieceKind): Version[] {
    this.#delivery(deliveryId);
    return this.#store.versionsOf(deliveryId, pieceKind);
  }

  getVersion(versionId: string): Version {
    const version = this.#store.versions.get(versionId);
    if (!version) throw notFound("Version", versionId);
    return version;
  }

  reviewVersion(versionId: string, input: ReviewVersionInput): Version {
    const version = this.getVersion(versionId);
    const current = this.#store.currentVersion(version.deliveryId, version.pieceKind);
    if (current?.id !== version.id) {
      throw new DomainError(
        "VERSION_NOT_CURRENT",
        `Version ${version.number} of ${version.pieceKind} was superseded by version ${current?.number}; only the current version can be reviewed`,
        { versionId, pieceKind: version.pieceKind, currentVersion: current?.number ?? null },
      );
    }
    const status = STATUS_BY_DECISION[input.decision];
    if (version.status === status) return version;
    version.status = status;
    version.review = { status, by: input.reviewer, at: this.#now(), note: input.note ?? null };
    if (status === "CHANGES_REQUESTED") {
      this.#revokeApproval(this.#delivery(version.deliveryId), "CHANGES_REQUESTED", version);
    }
    return version;
  }

  addComment(versionId: string, input: AddCommentInput): Comment {
    const version = this.getVersion(versionId);
    if (version.durationSeconds !== null && input.second > version.durationSeconds) {
      throw new DomainError(
        "COMMENT_OUT_OF_RANGE",
        `Second ${input.second} is beyond the ${version.durationSeconds}s duration of ${version.pieceKind} version ${version.number}`,
        { second: input.second, durationSeconds: version.durationSeconds },
      );
    }
    const comment: Comment = {
      id: this.#ids("cmt"),
      versionId,
      second: input.second,
      author: input.author,
      text: input.text,
      createdAt: this.#now(),
    };
    this.#store.comments.set(comment.id, comment);
    return comment;
  }

  listComments(versionId: string): Comment[] {
    this.getVersion(versionId);
    return this.#store.commentsOf(versionId);
  }

  approveDelivery(deliveryId: string, approver: string): DeliveryView {
    const delivery = this.#delivery(deliveryId);
    if (delivery.approval) {
      throw new DomainError(
        "DELIVERY_ALREADY_APPROVED",
        `Delivery ${deliveryId} is already approved`,
        { approval: delivery.approval },
      );
    }
    const blockers = this.#blockers(delivery, this.getCampaign(delivery.campaignId));
    if (blockers.length > 0) {
      throw new DomainError(
        "DELIVERY_NOT_APPROVABLE",
        `Delivery cannot be approved: ${blockers.map(describeBlocker).join("; ")}`,
        { blockers },
      );
    }
    const at = this.#now();
    delivery.approval = { approvedBy: approver, approvedAt: at };
    delivery.history.push({ type: "APPROVED", at, by: approver });
    return this.getDelivery(deliveryId);
  }

  #blockers(delivery: Delivery, campaign: Campaign): Blocker[] {
    return campaign.requiredPieces.flatMap((pieceKind): Blocker[] => {
      const current = this.#store.currentVersion(delivery.id, pieceKind);
      if (!current) return [{ pieceKind, reason: "MISSING_PIECE", currentVersion: null }];
      const reason = BLOCKER_BY_STATUS[current.status];
      return reason ? [{ pieceKind, reason, currentVersion: current.number }] : [];
    });
  }

  #revokeApproval(delivery: Delivery, reason: RevocationReason, version: Version): void {
    if (!delivery.approval) return;
    delivery.approval = null;
    delivery.history.push({
      type: "APPROVAL_REVOKED",
      at: this.#now(),
      reason,
      pieceKind: version.pieceKind,
      versionId: version.id,
    });
  }

  #delivery(deliveryId: string): Delivery {
    const delivery = this.#store.deliveries.get(deliveryId);
    if (!delivery) throw notFound("Delivery", deliveryId);
    return delivery;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}

const BLOCKER_MESSAGES: Record<Blocker["reason"], (b: Blocker) => string> = {
  MISSING_PIECE: (b) => `required piece "${b.pieceKind}" has no version`,
  CURRENT_VERSION_PENDING_REVIEW: (b) =>
    `required piece "${b.pieceKind}" current version ${b.currentVersion} is pending review`,
  CURRENT_VERSION_CHANGES_REQUESTED: (b) =>
    `required piece "${b.pieceKind}" current version ${b.currentVersion} has changes requested`,
};

function describeBlocker(blocker: Blocker): string {
  return BLOCKER_MESSAGES[blocker.reason](blocker);
}

import { beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../src/domain/clock.js";
import { DomainError } from "../src/domain/errors.js";
import { sequentialIds } from "../src/domain/ids.js";
import type { PieceKind } from "../src/domain/pieces.js";
import { ReviewService } from "../src/domain/review-service.js";

let clock: ManualClock;
let service: ReviewService;

beforeEach(() => {
  clock = new ManualClock("2026-03-01T10:00:00.000Z");
  service = new ReviewService({ clock, ids: sequentialIds() });
});

function deliveryFor(requiredPieces: PieceKind[]) {
  const campaign = service.createCampaign({ name: "Summer launch", requiredPieces });
  return service.createDelivery(campaign.id, { creator: "ana" });
}

function submit(deliveryId: string, kind: PieceKind) {
  return service.submitVersion(deliveryId, kind, {
    content: `https://cdn.example.com/${kind}`,
    durationSeconds: kind === "video" ? 60 : undefined,
    submittedBy: "ana",
  });
}

function approveVersion(versionId: string) {
  return service.reviewVersion(versionId, { decision: "APPROVE", reviewer: "brand" });
}

function submitApproved(deliveryId: string, kind: PieceKind) {
  return approveVersion(submit(deliveryId, kind).id);
}

function domainError(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a DomainError");
}

describe("versions", () => {
  it("numbers versions per piece and exposes the latest as current", () => {
    const delivery = deliveryFor(["video"]);
    submit(delivery.id, "video");
    submit(delivery.id, "script");
    const v2 = submit(delivery.id, "video");

    expect(v2.number).toBe(2);
    expect(service.listVersions(delivery.id, "video").map((v) => v.number)).toEqual([1, 2]);
    const video = service.getDelivery(delivery.id).pieces.find((p) => p.kind === "video");
    expect(video?.currentVersion?.id).toBe(v2.id);
    expect(video?.versionCount).toBe(2);
  });

  it("requires a duration for kinds whose catalog entry says so", () => {
    const delivery = deliveryFor(["video"]);
    const error = domainError(() =>
      service.submitVersion(delivery.id, "video", { content: "x", submittedBy: "ana" }),
    );
    expect(error.code).toBe("DURATION_REQUIRED");
    expect(() =>
      service.submitVersion(delivery.id, "caption", { content: "Hello", submittedBy: "ana" }),
    ).not.toThrow();
  });

  it("only lets the current version be reviewed", () => {
    const delivery = deliveryFor(["video"]);
    const v1 = submit(delivery.id, "video");
    submit(delivery.id, "video");

    const error = domainError(() => approveVersion(v1.id));
    expect(error.code).toBe("VERSION_NOT_CURRENT");
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({ currentVersion: 2 });
  });

  it("records reviewer and time of the review using the clock", () => {
    const delivery = deliveryFor(["video"]);
    const v1 = submit(delivery.id, "video");
    clock.advance(5 * 60_000);
    const reviewed = service.reviewVersion(v1.id, {
      decision: "REQUEST_CHANGES",
      reviewer: "brand",
      note: "Logo too small",
    });
    expect(reviewed.status).toBe("CHANGES_REQUESTED");
    expect(reviewed.review).toEqual({
      status: "CHANGES_REQUESTED",
      by: "brand",
      at: "2026-03-01T10:05:00.000Z",
      note: "Logo too small",
    });
  });
});

describe("comments", () => {
  it("anchors comments to a second and keeps them on the version they were made", () => {
    const delivery = deliveryFor(["video"]);
    const v1 = submit(delivery.id, "video");
    service.addComment(v1.id, { second: 42, author: "brand", text: "Cut this" });
    service.addComment(v1.id, { second: 3, author: "brand", text: "Louder intro" });
    const v2 = submit(delivery.id, "video");

    expect(service.listComments(v1.id).map((c) => [c.second, c.text])).toEqual([
      [3, "Louder intro"],
      [42, "Cut this"],
    ]);
    expect(service.listComments(v2.id)).toEqual([]);
  });

  it("rejects anchors beyond the version duration", () => {
    const delivery = deliveryFor(["video"]);
    const v1 = submit(delivery.id, "video");
    expect(() => service.addComment(v1.id, { second: 60, author: "b", text: "end" })).not.toThrow();
    const error = domainError(() => service.addComment(v1.id, { second: 61, author: "b", text: "x" }));
    expect(error.code).toBe("COMMENT_OUT_OF_RANGE");
  });

  it("still accepts comments on superseded versions without moving them", () => {
    const delivery = deliveryFor(["video"]);
    const v1 = submit(delivery.id, "video");
    const v2 = submit(delivery.id, "video");
    service.addComment(v1.id, { second: 10, author: "brand", text: "late note" });
    expect(service.listComments(v1.id)).toHaveLength(1);
    expect(service.listComments(v2.id)).toHaveLength(0);
  });
});

describe("delivery approval", () => {
  it("is approvable only when every required piece has an approved current version", () => {
    const delivery = deliveryFor(["script", "video", "cover"]);
    submitApproved(delivery.id, "script");
    const video = submit(delivery.id, "video");

    const error = domainError(() => service.approveDelivery(delivery.id, "brand"));
    expect(error.code).toBe("DELIVERY_NOT_APPROVABLE");
    expect(error.details).toEqual({
      blockers: [
        { pieceKind: "video", reason: "CURRENT_VERSION_PENDING_REVIEW", currentVersion: 1 },
        { pieceKind: "cover", reason: "MISSING_PIECE", currentVersion: null },
      ],
    });
    expect(error.message).toContain('required piece "cover" has no version');

    approveVersion(video.id);
    submitApproved(delivery.id, "cover");
    const approved = service.approveDelivery(delivery.id, "brand");
    expect(approved.status).toBe("APPROVED");
    expect(approved.approval).toEqual({ approvedBy: "brand", approvedAt: "2026-03-01T10:00:00.000Z" });
  });

  it("uses the current version, not an older approved one", () => {
    const delivery = deliveryFor(["video"]);
    submitApproved(delivery.id, "video");
    const v2 = submit(delivery.id, "video");
    service.reviewVersion(v2.id, { decision: "REQUEST_CHANGES", reviewer: "brand" });

    const error = domainError(() => service.approveDelivery(delivery.id, "brand"));
    expect(error.details).toEqual({
      blockers: [{ pieceKind: "video", reason: "CURRENT_VERSION_CHANGES_REQUESTED", currentVersion: 2 }],
    });
  });

  it("ignores non-required pieces when deciding approvability", () => {
    const delivery = deliveryFor(["video"]);
    submitApproved(delivery.id, "video");
    const caption = submit(delivery.id, "caption");
    service.reviewVersion(caption.id, { decision: "REQUEST_CHANGES", reviewer: "brand" });

    const view = service.getDelivery(delivery.id);
    expect(view.approvable).toBe(true);
    expect(view.pieces.map((p) => [p.kind, p.required])).toEqual([
      ["video", true],
      ["caption", false],
    ]);
    expect(service.approveDelivery(delivery.id, "brand").status).toBe("APPROVED");
  });

  it("drives requirements from campaign data", () => {
    const captionOnly = deliveryFor(["caption"]);
    submitApproved(captionOnly.id, "caption");
    expect(service.getDelivery(captionOnly.id).approvable).toBe(true);

    const full = deliveryFor(["script", "video", "cover", "caption"]);
    submitApproved(full.id, "caption");
    expect(service.getDelivery(full.id).blockers.map((b) => b.pieceKind)).toEqual([
      "script",
      "video",
      "cover",
    ]);
  });

  it("rejects approving an already approved delivery", () => {
    const delivery = deliveryFor(["video"]);
    submitApproved(delivery.id, "video");
    service.approveDelivery(delivery.id, "brand");
    expect(domainError(() => service.approveDelivery(delivery.id, "brand")).code).toBe(
      "DELIVERY_ALREADY_APPROVED",
    );
  });
});

describe("revocation", () => {
  function approvedDelivery() {
    const delivery = deliveryFor(["video"]);
    submitApproved(delivery.id, "video");
    service.approveDelivery(delivery.id, "brand");
    return delivery;
  }

  it("revokes approval when a new version lands and keeps it revoked until re-approved", () => {
    const delivery = approvedDelivery();
    clock.advance(60_000);
    const v2 = submit(delivery.id, "video");

    const revoked = service.getDelivery(delivery.id);
    expect(revoked.status).toBe("IN_REVIEW");
    expect(revoked.approval).toBeNull();
    expect(revoked.history.at(-1)).toEqual({
      type: "APPROVAL_REVOKED",
      at: "2026-03-01T10:01:00.000Z",
      reason: "NEW_VERSION_SUBMITTED",
      pieceKind: "video",
      versionId: v2.id,
    });
    expect(domainError(() => service.approveDelivery(delivery.id, "brand")).code).toBe(
      "DELIVERY_NOT_APPROVABLE",
    );

    approveVersion(v2.id);
    expect(service.getDelivery(delivery.id).status).toBe("IN_REVIEW");
    clock.advance(60_000);
    const reapproved = service.approveDelivery(delivery.id, "brand");
    expect(reapproved.status).toBe("APPROVED");
    expect(reapproved.history.map((e) => e.type)).toEqual(["APPROVED", "APPROVAL_REVOKED", "APPROVED"]);
    expect(reapproved.approval?.approvedAt).toBe("2026-03-01T10:02:00.000Z");
  });

  it("revokes on a new version of a non-required piece, which can be re-approved right away", () => {
    const delivery = approvedDelivery();
    submit(delivery.id, "caption");
    const view = service.getDelivery(delivery.id);
    expect(view.status).toBe("IN_REVIEW");
    expect(view.approvable).toBe(true);
    expect(service.approveDelivery(delivery.id, "brand").status).toBe("APPROVED");
  });

  it("revokes when changes are requested on the current version", () => {
    const delivery = approvedDelivery();
    const current = service.getDelivery(delivery.id).pieces[0]?.currentVersion;
    service.reviewVersion(current!.id, { decision: "REQUEST_CHANGES", reviewer: "brand" });
    const view = service.getDelivery(delivery.id);
    expect(view.status).toBe("IN_REVIEW");
    expect(view.history.at(-1)).toMatchObject({ type: "APPROVAL_REVOKED", reason: "CHANGES_REQUESTED" });
  });

  it("does not revoke on comments or repeated approvals", () => {
    const delivery = approvedDelivery();
    const current = service.getDelivery(delivery.id).pieces[0]?.currentVersion;
    service.addComment(current!.id, { second: 5, author: "brand", text: "nice" });
    approveVersion(current!.id);
    expect(service.getDelivery(delivery.id).status).toBe("APPROVED");
  });

  it("does nothing on a delivery that was never approved", () => {
    const delivery = deliveryFor(["video"]);
    submit(delivery.id, "video");
    submit(delivery.id, "video");
    expect(service.getDelivery(delivery.id).history).toEqual([]);
  });
});

describe("lookups", () => {
  it("reports unknown entities with NOT_FOUND", () => {
    expect(domainError(() => service.getDelivery("dlv_x")).code).toBe("NOT_FOUND");
    expect(domainError(() => service.createDelivery("cmp_x", { creator: "a" })).status).toBe(404);
    expect(domainError(() => service.listComments("ver_x")).message).toBe("Version ver_x not found");
  });

  it("normalizes required pieces into catalog order", () => {
    const campaign = service.createCampaign({ name: "c", requiredPieces: ["caption", "script"] });
    expect(campaign.requiredPieces).toEqual(["script", "caption"]);
  });
});

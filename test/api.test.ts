import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../src/domain/clock.js";
import { sequentialIds } from "../src/domain/ids.js";
import { buildApp } from "../src/http/app.js";

let app: FastifyInstance;
let clock: ManualClock;

beforeEach(async () => {
  clock = new ManualClock("2026-05-10T09:00:00.000Z");
  app = buildApp({ clock, ids: sequentialIds() });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function call(method: "GET" | "POST", url: string, payload?: object) {
  const response = await app.inject(payload ? { method, url, payload } : { method, url });
  return { status: response.statusCode, body: response.json() };
}

async function setup(requiredPieces: string[]) {
  const campaign = await call("POST", "/campaigns", { name: "Launch", requiredPieces });
  const delivery = await call("POST", `/campaigns/${campaign.body.id}/deliveries`, { creator: "ana" });
  return delivery.body.id as string;
}

async function submit(deliveryId: string, kind: string, extra: object = {}) {
  return call("POST", `/deliveries/${deliveryId}/pieces/${kind}/versions`, {
    content: `https://cdn.example.com/${kind}.mp4`,
    submittedBy: "ana",
    ...(kind === "video" ? { durationSeconds: 30 } : {}),
    ...extra,
  });
}

async function review(versionId: string, decision: "APPROVE" | "REQUEST_CHANGES") {
  return call("POST", `/versions/${versionId}/review`, { decision, reviewer: "brand" });
}

describe("HTTP API", () => {
  it("runs the full review flow end to end", async () => {
    const deliveryId = await setup(["script", "video"]);

    const script = await submit(deliveryId, "script", { content: "Hook: ..." });
    expect(script.status).toBe(201);
    expect(script.body).toMatchObject({ pieceKind: "script", number: 1, status: "PENDING_REVIEW" });
    await review(script.body.id, "APPROVE");

    const video1 = await submit(deliveryId, "video");
    const comment = await call("POST", `/versions/${video1.body.id}/comments`, {
      second: 12,
      author: "brand",
      text: "Product appears too late",
    });
    expect(comment.status).toBe(201);
    expect(comment.body).toEqual({
      id: "cmt_1",
      versionId: video1.body.id,
      second: 12,
      author: "brand",
      text: "Product appears too late",
      createdAt: "2026-05-10T09:00:00.000Z",
    });
    await review(video1.body.id, "REQUEST_CHANGES");

    const blocked = await call("POST", `/deliveries/${deliveryId}/approve`, { approver: "brand" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("DELIVERY_NOT_APPROVABLE");
    expect(blocked.body.error.details.blockers).toEqual([
      { pieceKind: "video", reason: "CURRENT_VERSION_CHANGES_REQUESTED", currentVersion: 1 },
    ]);

    const video2 = await submit(deliveryId, "video");
    expect(video2.body.number).toBe(2);
    expect((await call("GET", `/versions/${video2.body.id}/comments`)).body).toEqual([]);
    expect((await call("GET", `/versions/${video1.body.id}/comments`)).body).toHaveLength(1);

    await review(video2.body.id, "APPROVE");
    const approved = await call("POST", `/deliveries/${deliveryId}/approve`, { approver: "brand" });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("APPROVED");

    clock.advance(3_600_000);
    await submit(deliveryId, "video");
    const revoked = await call("GET", `/deliveries/${deliveryId}`);
    expect(revoked.body.status).toBe("IN_REVIEW");
    expect(revoked.body.approvable).toBe(false);
    expect(revoked.body.history.at(-1)).toMatchObject({
      type: "APPROVAL_REVOKED",
      reason: "NEW_VERSION_SUBMITTED",
      at: "2026-05-10T10:00:00.000Z",
    });
  });

  it("lists versions of a piece in order", async () => {
    const deliveryId = await setup(["video"]);
    await submit(deliveryId, "video");
    await submit(deliveryId, "video");
    const list = await call("GET", `/deliveries/${deliveryId}/pieces/video/versions`);
    expect(list.body.map((v: { number: number }) => v.number)).toEqual([1, 2]);
  });

  it("rejects reviewing a superseded version with a clear error", async () => {
    const deliveryId = await setup(["video"]);
    const v1 = await submit(deliveryId, "video");
    await submit(deliveryId, "video");
    const response = await review(v1.body.id, "APPROVE");
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: "VERSION_NOT_CURRENT",
      message: "Version 1 of video was superseded by version 2; only the current version can be reviewed",
    });
  });

  it("validates payloads", async () => {
    const badCampaign = await call("POST", "/campaigns", { name: "x", requiredPieces: ["video", "story"] });
    expect(badCampaign.status).toBe(400);
    expect(badCampaign.body.error.code).toBe("VALIDATION_ERROR");
    expect(badCampaign.body.error.details[0].path).toBe("requiredPieces.1");

    const duplicated = await call("POST", "/campaigns", { name: "x", requiredPieces: ["video", "video"] });
    expect(duplicated.status).toBe(400);

    const deliveryId = await setup(["video"]);
    const badKind = await submit(deliveryId, "thumbnail");
    expect(badKind.status).toBe(400);

    const noDuration = await submit(deliveryId, "video", { durationSeconds: undefined });
    expect(noDuration.status).toBe(422);
    expect(noDuration.body.error.code).toBe("DURATION_REQUIRED");

    const video = await submit(deliveryId, "video");
    const negative = await call("POST", `/versions/${video.body.id}/comments`, {
      second: -1,
      author: "b",
      text: "x",
    });
    expect(negative.status).toBe(400);

    const late = await call("POST", `/versions/${video.body.id}/comments`, { second: 31, author: "b", text: "x" });
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe("COMMENT_OUT_OF_RANGE");
  });

  it("answers unknown resources and routes with NOT_FOUND", async () => {
    const missing = await call("GET", "/deliveries/dlv_404");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toEqual({
      code: "NOT_FOUND",
      message: "Delivery dlv_404 not found",
      details: { entity: "Delivery", id: "dlv_404" },
    });
    const route = await call("GET", "/nope");
    expect(route.status).toBe(404);
    expect(route.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: { "content-type": "application/json" },
      payload: "{bad",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("BAD_REQUEST");
  });
});

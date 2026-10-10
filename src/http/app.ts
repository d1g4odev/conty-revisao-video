import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { systemClock, type Clock } from "../domain/clock.js";
import { DomainError } from "../domain/errors.js";
import { randomIds, type IdGenerator } from "../domain/ids.js";
import { ReviewService } from "../domain/review-service.js";
import {
  addCommentBody,
  approveDeliveryBody,
  campaignParams,
  createCampaignBody,
  createDeliveryBody,
  deliveryParams,
  pieceParams,
  reviewVersionBody,
  submitVersionBody,
  versionParams,
} from "./schemas.js";

export interface AppOptions {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: boolean;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const service = new ReviewService({
    clock: options.clock ?? systemClock,
    ids: options.ids ?? randomIds,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request is invalid",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }
    const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    return reply.status(status).send({
      error: {
        code: status === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
        message: status === 500 ? "Unexpected error" : error.message,
        details: null,
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: `Route ${request.method} ${request.url} not found`,
        details: null,
      },
    }),
  );

  app.post("/campaigns", async (request, reply) => {
    const body = createCampaignBody.parse(request.body);
    return reply.status(201).send(service.createCampaign(body));
  });

  app.get("/campaigns/:campaignId", async (request) => {
    const { campaignId } = campaignParams.parse(request.params);
    return service.getCampaign(campaignId);
  });

  app.post("/campaigns/:campaignId/deliveries", async (request, reply) => {
    const { campaignId } = campaignParams.parse(request.params);
    const body = createDeliveryBody.parse(request.body);
    return reply.status(201).send(service.createDelivery(campaignId, body));
  });

  app.get("/deliveries/:deliveryId", async (request) => {
    const { deliveryId } = deliveryParams.parse(request.params);
    return service.getDelivery(deliveryId);
  });

  app.post("/deliveries/:deliveryId/approve", async (request) => {
    const { deliveryId } = deliveryParams.parse(request.params);
    const { approver } = approveDeliveryBody.parse(request.body);
    return service.approveDelivery(deliveryId, approver);
  });

  app.post("/deliveries/:deliveryId/pieces/:kind/versions", async (request, reply) => {
    const { deliveryId, kind } = pieceParams.parse(request.params);
    const body = submitVersionBody.parse(request.body);
    return reply.status(201).send(service.submitVersion(deliveryId, kind, body));
  });

  app.get("/deliveries/:deliveryId/pieces/:kind/versions", async (request) => {
    const { deliveryId, kind } = pieceParams.parse(request.params);
    return service.listVersions(deliveryId, kind);
  });

  app.get("/versions/:versionId", async (request) => {
    const { versionId } = versionParams.parse(request.params);
    return service.getVersion(versionId);
  });

  app.post("/versions/:versionId/review", async (request) => {
    const { versionId } = versionParams.parse(request.params);
    const body = reviewVersionBody.parse(request.body);
    return service.reviewVersion(versionId, body);
  });

  app.post("/versions/:versionId/comments", async (request, reply) => {
    const { versionId } = versionParams.parse(request.params);
    const body = addCommentBody.parse(request.body);
    return reply.status(201).send(service.addComment(versionId, body));
  });

  app.get("/versions/:versionId/comments", async (request) => {
    const { versionId } = versionParams.parse(request.params);
    return service.listComments(versionId);
  });

  return app;
}

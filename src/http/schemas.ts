import { z } from "zod";
import { PIECE_KINDS } from "../domain/pieces.js";

const text = z.string().trim().min(1);
const pieceKind = z.enum(PIECE_KINDS);

export const createCampaignBody = z.object({
  name: text,
  requiredPieces: z
    .array(pieceKind)
    .min(1)
    .refine((kinds) => new Set(kinds).size === kinds.length, "requiredPieces must not repeat"),
});

export const createDeliveryBody = z.object({ creator: text });

export const submitVersionBody = z.object({
  content: text,
  durationSeconds: z.number().int().positive().optional(),
  submittedBy: text,
});

export const reviewVersionBody = z.object({
  decision: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  reviewer: text,
  note: text.optional(),
});

export const addCommentBody = z.object({
  second: z.number().int().nonnegative(),
  author: text,
  text,
});

export const approveDeliveryBody = z.object({ approver: text });

export const campaignParams = z.object({ campaignId: z.string() });
export const deliveryParams = z.object({ deliveryId: z.string() });
export const pieceParams = z.object({ deliveryId: z.string(), kind: pieceKind });
export const versionParams = z.object({ versionId: z.string() });

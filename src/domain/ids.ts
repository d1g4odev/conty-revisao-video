import { randomUUID } from "node:crypto";

export type IdGenerator = (prefix: string) => string;

export const randomIds: IdGenerator = (prefix) => `${prefix}_${randomUUID()}`;

export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

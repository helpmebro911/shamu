/**
 * Domain-event re-export. `toDomainEvent` lives in `excerpt.ts` because it
 * needs to call `buildReviewerExcerpt` for the red case, and bundling both
 * here would create a circular import. This file exists so callers can
 * import from `@shamu/ci/events` conceptually; the single-entry `./index.ts`
 * is the public surface.
 */

export { toDomainEvent } from "./excerpt.ts";
export type { CIDomainEvent, CIRed, PatchReady } from "./types.ts";

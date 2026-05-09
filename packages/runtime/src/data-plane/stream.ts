import { DurableStream } from "@durable-streams/client"

// Centralizes the single production DurableStream constructor site tracked by
// the effect-quality ratchet while keeping data-plane writers explicit.
export const makeJsonDurableStream = (
  streamUrl: string,
  contentType = "application/json",
): DurableStream =>
  new DurableStream({
    url: streamUrl,
    contentType,
  })

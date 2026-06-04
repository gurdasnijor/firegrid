export const deferredSurface = [
  {
    family: "retry",
    tutorialTier: "04-retry",
    missing: "journaled retry policy and attempt classification",
  },
  {
    family: "saga",
    tutorialTier: "05-saga",
    missing: "durable compensation steps and compensation ordering helpers",
  },
  {
    family: "cancellation",
    tutorialTier: "06-cancel",
    missing: "durable cancellation events and AbortSignal fanout",
  },
  {
    family: "state",
    tutorialTier: "07-state",
    missing: "state/sharedState log fold and keyed workflow/object routing",
  },
  {
    family: "clients",
    tutorialTier: "08-clients",
    missing: "typed service/object/workflow call and send descriptors",
  },
  {
    family: "workflow-promises",
    tutorialTier: "09-workflows",
    missing: "workflowPromise, attach, key, and shared workflow handler semantics",
  },
  {
    family: "interfaces",
    tutorialTier: "10-ifaces",
    missing: "descriptor-only contracts and codegen/client projection",
  },
  {
    family: "serdes",
    tutorialTier: "11-serdes",
    missing: "runtime input/output serde hooks",
  },
] as const

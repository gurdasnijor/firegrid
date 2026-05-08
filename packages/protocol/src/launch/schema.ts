import { Schema } from "effect"

export const StreamPlaneRefSchema = Schema.Struct({
  kind: Schema.Literal("stream"),
  role: Schema.Literal("state", "events", "control", "diagnostics"),
  streamUrl: Schema.String,
  schemaRef: Schema.optional(Schema.String),
})
export type StreamPlaneRef = Schema.Schema.Type<typeof StreamPlaneRefSchema>

export const ExecutionPlaneRefSchema = Schema.Struct({
  kind: Schema.Literal("local-process", "docker-volume", "remote-sandbox", "hosted-adapter"),
  provider: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  mountPath: Schema.optional(Schema.String),
})
export type ExecutionPlaneRef = Schema.Schema.Type<typeof ExecutionPlaneRefSchema>

export const ResourcePlaneRefSchema = Schema.Struct({
  kind: Schema.Literal("repository", "filesystem-mount", "artifact-bundle", "volume", "mcp-proxy", "secret"),
  ref: Schema.String,
  mountPath: Schema.optional(Schema.String),
  integrity: Schema.optional(Schema.String),
})
export type ResourcePlaneRef = Schema.Schema.Type<typeof ResourcePlaneRefSchema>

export const PlaneBindingSchema = Schema.Struct({
  kind: Schema.Literal("env", "env-secret", "mount", "stdio"),
  name: Schema.String,
  from: Schema.Struct({
    plane: Schema.Literal("session", "diagnostics", "execution", "resources"),
    name: Schema.String,
    field: Schema.Literal("streamUrl", "ref", "mountPath"),
  }),
})
export type PlaneBinding = Schema.Schema.Type<typeof PlaneBindingSchema>

export const RuntimeLaunchRequestSchema = Schema.Struct({
  launchId: Schema.String,
  requestedAt: Schema.String,
  requestedBy: Schema.optional(Schema.String),
  target: Schema.Struct({
    kind: Schema.Literal("command"),
    spec: Schema.Struct({
      argv: Schema.Array(Schema.String),
      protocol: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
    }),
    readiness: Schema.optional(Schema.Struct({
      stream: Schema.String,
      rowType: Schema.String,
      predicateRef: Schema.String,
    })),
    rebuild: Schema.optional(Schema.Struct({
      inputs: Schema.Array(Schema.String),
      strategy: Schema.Literal("fresh", "replay", "session-load"),
      entrypointRef: Schema.String,
    })),
  }),
  planes: Schema.Struct({
    session: Schema.Record({ key: Schema.String, value: StreamPlaneRefSchema }),
    diagnostics: Schema.optional(Schema.Record({ key: Schema.String, value: StreamPlaneRefSchema })),
    execution: Schema.optional(Schema.Record({ key: Schema.String, value: ExecutionPlaneRefSchema })),
    resources: Schema.optional(Schema.Record({ key: Schema.String, value: ResourcePlaneRefSchema })),
  }),
  bindings: Schema.optional(Schema.Array(PlaneBindingSchema)),
  restartPolicy: Schema.optional(Schema.Struct({
    mode: Schema.Literal("never", "on-failure", "always"),
    maxAttempts: Schema.optional(Schema.Number),
  })),
})
export type RuntimeLaunchRequest = Schema.Schema.Type<typeof RuntimeLaunchRequestSchema>

export const RuntimeProcessEventSchema = Schema.Struct({
  processEventId: Schema.String,
  processAttemptId: Schema.String,
  launchId: Schema.String,
  attempt: Schema.Number,
  status: Schema.Literal("started", "ready", "exited", "failed"),
  at: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
})
export type RuntimeProcessEvent = Schema.Schema.Type<typeof RuntimeProcessEventSchema>

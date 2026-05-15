import { Schema } from "effect"

// firegrid-effect-ai-native-agents.ADAPTER_ERRORS.1
export class PermissionRequiredButNotHandled
  extends Schema.TaggedError<PermissionRequiredButNotHandled>()(
    "PermissionRequiredButNotHandled",
    {
      turnId: Schema.optional(Schema.String),
      toolCallId: Schema.optional(Schema.String),
      message: Schema.String,
    },
  )
{}

// firegrid-effect-ai-native-agents.ADAPTER_ERRORS.1
export class AdapterProtocolError extends Schema.TaggedError<AdapterProtocolError>()(
  "AdapterProtocolError",
  {
    op: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// firegrid-effect-ai-native-agents.ADAPTER_ERRORS.1
export class AdapterSessionNotPromptable
  extends Schema.TaggedError<AdapterSessionNotPromptable>()(
    "AdapterSessionNotPromptable",
    { message: Schema.String },
  )
{}

// firegrid-effect-ai-native-agents.ADAPTER_ERRORS.1
export class AdapterCancelled extends Schema.TaggedError<AdapterCancelled>()(
  "AdapterCancelled",
  { message: Schema.String },
) {}

// firegrid-effect-ai-native-agents.ADAPTER_ERRORS.1
export class AdapterTerminated extends Schema.TaggedError<AdapterTerminated>()(
  "AdapterTerminated",
  { message: Schema.String },
) {}

// firegrid-effect-ai-native-agents.ADAPTER_ERRORS.1
export class AdapterUnsupportedFeature
  extends Schema.TaggedError<AdapterUnsupportedFeature>()(
    "AdapterUnsupportedFeature",
    {
      feature: Schema.String,
      message: Schema.String,
    },
  )
{}

// firegrid-effect-ai-native-agents.ADAPTER_ERRORS.1
export class AgentAdapterSelectionError
  extends Schema.TaggedError<AgentAdapterSelectionError>()(
    "AgentAdapterSelectionError",
    {
      provider: Schema.String,
      message: Schema.String,
      cause: Schema.optional(Schema.Unknown),
    },
  )
{}

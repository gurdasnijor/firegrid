export interface FluentControlClientOptions {
  readonly baseUrl: string
}

export interface FluentControlDiscoveryOptions {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly surfaceId: string
}

export interface FluentControlSendInput {
  readonly entityId: string
  readonly inputId: string
  readonly input: unknown
}

export interface FluentControlSendResult {
  readonly entityId: string
  readonly eventName: string
  readonly appendResult: string
  readonly offset: string
  readonly delivery: string
}

export interface FluentControlReadResult {
  readonly entityId: string
  readonly events: number
  readonly addressedInputs: number
  readonly lastAddressedInput: unknown
  readonly head: {
    readonly offset: string
    readonly streamClosed: boolean
    readonly contentType?: string
  }
}

export interface FluentControlHeadResult {
  readonly offset: string
  readonly streamClosed: boolean
}

export interface FluentControlClient {
  readonly send: (
    input: FluentControlSendInput,
  ) => Promise<FluentControlSendResult>
  readonly read: (
    entityId: string,
  ) => Promise<FluentControlReadResult>
  readonly head: (
    entityId: string,
  ) => Promise<FluentControlHeadResult>
}

const trimBaseUrl = (
  baseUrl: string,
): string => baseUrl.replace(/\/+$/u, "")

const discoveryPath = (
  namespace: string,
): string =>
  [
    namespace,
    "fluent-control-surface",
    "discovery",
  ].map(encodeURIComponent).join("/")

const entityUrl = (
  baseUrl: string,
  entityId: string,
  suffix = "",
): string =>
  `${trimBaseUrl(baseUrl)}/entities/${encodeURIComponent(entityId)}${suffix}`

const readJson = async <A>(
  response: Response,
): Promise<A> => {
  if (!response.ok) {
    throw new Error(`fluent control request failed with ${response.status}: ${await response.text()}`)
  }
  return await response.json() as A
}

const isDiscoveryRecord = (
  value: unknown,
): value is { readonly surfaceId: string; readonly baseUrl: string } =>
  typeof value === "object" &&
  value !== null &&
  "surfaceId" in value &&
  "baseUrl" in value &&
  typeof value.surfaceId === "string" &&
  typeof value.baseUrl === "string"

export const makeFluentControlClient = (
  options: FluentControlClientOptions,
): FluentControlClient => ({
  send: async (input) =>
    readJson<FluentControlSendResult>(
      await globalThis.fetch(entityUrl(options.baseUrl, input.entityId, "/inputs"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inputId: input.inputId,
          input: input.input,
        }),
      }),
    ),
  read: async (entityId) =>
    readJson<FluentControlReadResult>(
      await globalThis.fetch(entityUrl(options.baseUrl, entityId), {
        method: "GET",
      }),
    ),
  head: async (entityId) => {
    const response = await globalThis.fetch(entityUrl(options.baseUrl, entityId), {
      method: "HEAD",
    })
    if (!response.ok) {
      throw new Error(`fluent control head failed with ${response.status}: ${await response.text()}`)
    }
    return {
      offset: response.headers.get("fluent-control-offset") ?? "",
      streamClosed: response.headers.get("fluent-control-stream-closed") === "true",
    }
  },
})

export const discoverFluentControlClient = async (
  options: FluentControlDiscoveryOptions,
): Promise<FluentControlClient> => {
  const response = await globalThis.fetch(
    `${trimBaseUrl(options.durableStreamsBaseUrl)}/v1/stream/${discoveryPath(options.namespace)}?offset=-1`,
  )
  if (!response.ok) {
    throw new Error(`fluent control discovery failed with ${response.status}: ${await response.text()}`)
  }
  const body: unknown = await response.json()
  if (!Array.isArray(body)) {
    throw new Error("fluent control discovery returned a non-array payload")
  }
  const match = body.find((item): item is { readonly surfaceId: string; readonly baseUrl: string } =>
    isDiscoveryRecord(item) &&
    item.surfaceId === options.surfaceId,
  )
  if (match === undefined) {
    throw new Error(`fluent control surface ${options.surfaceId} not discovered`)
  }
  return makeFluentControlClient({ baseUrl: match.baseUrl })
}

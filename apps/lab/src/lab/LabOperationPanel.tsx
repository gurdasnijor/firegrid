import { Effect, Fiber, Stream } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  createLabClient,
  type LabOperationHandle,
  type LabOperationOutput,
  type LabOperationState,
} from "./LabClient.ts"
import { LabTypedInputForm } from "./LabTypedInputForm.tsx"
import styles from "./styles.module.css"

// firegrid-client-api.LAB_COMPATIBILITY.1
// firegrid-client-api.LAB_COMPATIBILITY.4
// firegrid-client-api.CLIENT_SURFACE.1
// firegrid-client-api.CLIENT_SURFACE.2
// firegrid-client-api.AUTHORITY_BOUNDARY.1
// runtime-lab-inspector.WRITE_BOUNDARY.1
// runtime-lab-inspector.NO_PRIVILEGED_LAB.1
//
// Typed Operation workbench. React imports only the app-local
// LabClient seam; no runtime handler graph, subscriber graph, claim
// authority, completion authority, or raw durable writer is present in
// the lab UI.

interface LabOperationPanelProps {
  readonly streamUrl: string
}

const summarizeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const summarizeOutput = (output: LabOperationOutput): string =>
  `${output.echoed} (${output.total})`

const summarizeState = (state: LabOperationState): string => {
  if (state._tag === "Completed") {
    return `completed: ${summarizeOutput(state.output)}`
  }
  if (state._tag === "Failed") {
    return `failed: ${state.error.code} ${state.error.message}`
  }
  if (state._tag === "Cancelled") {
    return "cancelled"
  }
  return "pending"
}

const interruptFiber = (
  fiber: Fiber.RuntimeFiber<void, never> | undefined,
): void => {
  if (fiber === undefined) return
  // eslint-disable-next-line no-restricted-syntax
  void Effect.runPromise(Fiber.interrupt(fiber))
}

export function LabOperationPanel({ streamUrl }: LabOperationPanelProps) {
  const [message, setMessage] = useState("hello operation")
  const [count, setCount] = useState(1)
  const [handle, setHandle] = useState<LabOperationHandle | undefined>()
  const [states, setStates] = useState<ReadonlyArray<LabOperationState>>([])
  const [sendStatus, setSendStatus] = useState<string | undefined>()
  const [resultStatus, setResultStatus] = useState<string | undefined>()
  const [resultOutput, setResultOutput] = useState<
    LabOperationOutput | undefined
  >()
  const [callStatus, setCallStatus] = useState<string | undefined>()
  const [callOutput, setCallOutput] = useState<
    LabOperationOutput | undefined
  >()
  const [error, setError] = useState<string | undefined>()
  const resultFiberRef = useRef<Fiber.RuntimeFiber<void, never> | undefined>(
    undefined,
  )
  const callFiberRef = useRef<Fiber.RuntimeFiber<void, never> | undefined>(
    undefined,
  )
  const labClient = useMemo(
    () => createLabClient({ streamUrl }),
    [streamUrl],
  )

  useEffect(
    () => () => {
      interruptFiber(resultFiberRef.current)
      interruptFiber(callFiberRef.current)
      resultFiberRef.current = undefined
      callFiberRef.current = undefined
    },
    [labClient],
  )

  useEffect(() => {
    if (handle === undefined) return
    setStates([])
    setError(undefined)

    // React effect boundary: follow operation state for the active
    // handle and interrupt that follow stream when the handle or URL
    // changes.
    // eslint-disable-next-line no-restricted-syntax
    const fiber = Effect.runFork(
      labClient.operations.observeEcho(handle).pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            setStates((prev) => {
              const next = [...prev, state]
              if (next.length > 20) next.shift()
              return next
            })
          }),
        ),
        Effect.catchAll((cause) =>
          Effect.sync(() => {
            setError(summarizeError(cause))
          }),
        ),
      ),
    )

    return () => {
      // eslint-disable-next-line no-restricted-syntax
      void Effect.runPromise(Fiber.interrupt(fiber))
    }
  }, [handle, labClient])

  const onSend = () => {
    interruptFiber(resultFiberRef.current)
    interruptFiber(callFiberRef.current)
    resultFiberRef.current = undefined
    callFiberRef.current = undefined
    setSendStatus("sending")
    setResultStatus(undefined)
    setResultOutput(undefined)
    setCallStatus(undefined)
    setCallOutput(undefined)
    setError(undefined)
    setStates([])
    // React event-handler boundary: bridge the Effect-native client
    // send into the browser click handler.
    // eslint-disable-next-line no-restricted-syntax
    void Effect.runPromiseExit(
      labClient.operations.sendEcho({ message, count }),
    ).then((exit) => {
      if (exit._tag === "Success") {
        setHandle(exit.value)
        setSendStatus(`sent ${exit.value.id}`)
        setCount((value) => value + 1)
      } else {
        setSendStatus("send failed")
        setError(String(exit.cause))
      }
    })
  }

  const onResult = () => {
    if (handle === undefined) {
      setResultStatus("send an operation first")
      return
    }
    interruptFiber(resultFiberRef.current)
    resultFiberRef.current = undefined
    setResultStatus("waiting for attached runtime result")
    setResultOutput(undefined)
    setError(undefined)

    // firegrid-client-api.CLIENT_SURFACE.4
    // React only starts the seam's Effect; the Firegrid client owns
    // typed result observation and no terminal state is synthesized.
    // eslint-disable-next-line no-restricted-syntax
    resultFiberRef.current = Effect.runFork(
      labClient.operations.resultEcho(handle).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.sync(() => {
              setResultStatus("result failed")
              setError(summarizeError(cause))
              resultFiberRef.current = undefined
            }),
          onSuccess: (output) =>
            Effect.sync(() => {
              setResultOutput(output)
              setResultStatus("result completed")
              resultFiberRef.current = undefined
            }),
        }),
      ),
    )
  }

  const onCall = () => {
    interruptFiber(callFiberRef.current)
    callFiberRef.current = undefined
    setCallStatus("call sent; waiting for attached runtime result")
    setCallOutput(undefined)
    setError(undefined)

    // firegrid-client-api.CLIENT_SURFACE.4
    // client.call is exposed as the production convenience path:
    // send plus result observation, with honest pending UX when no
    // runtime handler is attached.
    // eslint-disable-next-line no-restricted-syntax
    callFiberRef.current = Effect.runFork(
      labClient.operations.callEcho({ message, count }).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.sync(() => {
              setCallStatus("call failed")
              setError(summarizeError(cause))
              callFiberRef.current = undefined
            }),
          onSuccess: (output) =>
            Effect.sync(() => {
              setCallOutput(output)
              setCallStatus("call completed")
              callFiberRef.current = undefined
              setCount((value) => value + 1)
            }),
        }),
      ),
    )
  }

  const latest = states.at(-1)

  return (
    <section
      className={styles.typedPanel}
      aria-label="Typed Operation workbench"
    >
      <div className={styles.panel}>
        <h3>Typed Operation</h3>
        <p className={styles.note}>
          Sends a schema-derived operation intent through the
          app-facing Firegrid client. It remains pending until an
          external runtime with a matching handler is attached.
        </p>
        <LabTypedInputForm
          message={message}
          count={count}
          submitLabel="Send typed operation"
          onMessageChange={setMessage}
          onCountChange={setCount}
          onSubmit={onSend}
        />
        {sendStatus !== undefined ? (
          <div className={styles.note}>{sendStatus}</div>
        ) : null}
        {error !== undefined ? (
          <div className={styles.note}>error: {error}</div>
        ) : null}
      </div>

      <div className={styles.panel}>
        <h3>Operation Result</h3>
        <p className={styles.note}>
          Exercises the production result and call conveniences. These
          controls wait for a real attached runtime and never invent a
          completed response in the lab.
        </p>
        <div className={styles.actionRow}>
          <button
            type="button"
            className={styles.button}
            disabled={handle === undefined}
            onClick={onResult}
          >
            Wait for result
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={onCall}
          >
            Call and wait
          </button>
        </div>
        {handle === undefined ? (
          <div className={styles.note}>
            send an operation before waiting on its result
          </div>
        ) : null}
        {resultStatus !== undefined ? (
          <div className={styles.note}>
            result: {resultStatus}
            {resultOutput === undefined
              ? ""
              : ` - ${summarizeOutput(resultOutput)}`}
          </div>
        ) : null}
        {callStatus !== undefined ? (
          <div className={styles.note}>
            call: {callStatus}
            {callOutput === undefined
              ? ""
              : ` - ${summarizeOutput(callOutput)}`}
          </div>
        ) : null}
      </div>

      <div className={styles.panel}>
        <h3>Operation State</h3>
        {handle === undefined ? (
          <span className={styles.empty}>no operation sent yet</span>
        ) : (
          <>
            <div className={styles.note}>
              handle {handle.id} ({handle.operation})
            </div>
            <div className={styles.note}>
              {latest === undefined
                ? "waiting for projection state..."
                : summarizeState(latest)}
            </div>
            <ol className={styles.records}>
              {states.length === 0 ? (
                <li>
                  <span className={styles.empty}>no observed states yet</span>
                </li>
              ) : (
                states.map((state, index) => (
                  <li key={`${handle.id}:${index}`}>
                    <strong>{state._tag}</strong>
                    <pre className={styles.json}>
                      {JSON.stringify(state, null, 2)}
                    </pre>
                  </li>
                ))
              )}
            </ol>
          </>
        )}
      </div>
    </section>
  )
}

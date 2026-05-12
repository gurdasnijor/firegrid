/**
 * Optional Electric/D2TS ConsumerSource adapters.
 *
 * Implements:
 *  - effect-durable-operators.SOURCE.3
 *  - effect-durable-operators.SOURCE.4
 *  - effect-durable-operators.SOURCE.5
 */

import type {
  ChangeMessage,
  Message,
  Row,
  ShapeStreamInterface,
} from "@electric-sql/client"
import { Effect, Stream } from "effect"
import type { Option } from "effect"
import type { ConsumerSource } from "./ConsumerSource.ts"

export const fromElectricChangeMessages = <
  Fact,
  T extends Row<unknown> = Row,
  E = never,
  R = never,
>(options: {
  readonly messages: Stream.Stream<ChangeMessage<T>, E, R>
  readonly decode: (message: ChangeMessage<T>) => Option.Option<Fact>
}): ConsumerSource<Fact, E, R> => ({
  read: () => options.messages.pipe(Stream.filterMap(options.decode)),
})

const isElectricChangeMessage = <T extends Row<unknown>>(
  message: Message<T>,
): message is ChangeMessage<T> =>
  "value" in message && "operation" in message.headers

export const fromElectricShapeStream = <
  Fact,
  T extends Row<unknown> = Row,
>(options: {
  readonly stream: ShapeStreamInterface<T>
  readonly decode: (message: ChangeMessage<T>) => Option.Option<Fact>
}): ConsumerSource<Fact, Error> => ({
  read: readOptions => {
    const changes = readOptions?.live === true
      ? Stream.async<ChangeMessage<T>, Error>((emit) => {
        const unsubscribe = options.stream.subscribe(
          messages => {
            messages.forEach(message => {
              if (isElectricChangeMessage(message)) void emit.single(message)
            })
          },
          error => {
            void emit.fail(error instanceof Error ? error : new Error(String(error)))
          },
        )
        return Effect.sync(unsubscribe)
      })
      : Stream.fromEffect(
        Effect.tryPromise({
          try: () => options.stream.fetchSnapshot({}),
          catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
        }),
      ).pipe(
        Stream.flatMap(({ data }) => Stream.fromIterable(data)),
      )

    return changes.pipe(Stream.filterMap(options.decode))
  },
})

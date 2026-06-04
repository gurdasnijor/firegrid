import type { Future } from "./future.ts"

// fluent-firegrid-keystone.PACKAGE.4
export interface Operation<T> {
  [Symbol.iterator](): Iterator<unknown, T, unknown>
}

export const operationTag = Symbol("fluentFiregridOperation")

interface LeafNode<T> {
  readonly _tag: "Leaf"
  readonly future: Future<T>
}

export interface PrimitiveOperation<T> extends Operation<T> {
  readonly [operationTag]: LeafNode<T>
}

export const makePrimitive = <T>(node: LeafNode<T>): PrimitiveOperation<T> => {
  const operation: PrimitiveOperation<T> = {
    [operationTag]: node,
    *[Symbol.iterator]() {
      return (yield operation) as T
    },
  } satisfies PrimitiveOperation<T>

  return operation
}

export const isPrimitiveOperation = (
  value: unknown,
): value is PrimitiveOperation<unknown> =>
  typeof value === "object" && value !== null && operationTag in value

export const gen = <T>(
  factory: () => Generator<unknown, T, unknown>,
): Operation<T> => ({
  [Symbol.iterator]: factory,
})

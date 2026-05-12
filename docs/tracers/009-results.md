# 009 Results

Historical. The original tracer 009 runtime implementation was removed during
the required-action cleanup lane. Required-action runtime workflow/service
authority is no longer an active production surface.

Current retained result:

- Required-action row schemas live in `@firegrid/protocol/required-action`.
- Runtime-local `packages/runtime/src/required-action/**` was deleted.
- Future required-action behavior is deferred to generic wait/operator tooling.

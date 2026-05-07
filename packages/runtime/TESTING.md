# Runtime Test Conventions

Runtime tests should prove positive API behavior by executing Effects, checking
public values, or asserting TypeScript contracts. Avoid source-transcript tests
for behavior such as "this function calls that helper" or "this source contains
this type string"; those checks fail on harmless refactors and can pass because
the same text appears in comments.

Source-grep assertions are allowed only for explicit negative architectural
constraints that are difficult to express through behavior, such as "the
runtime binary must not discover app modules by dynamic import." Include a
short comment explaining why source inspection is the right tool.

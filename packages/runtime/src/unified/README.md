# Unified Kernel

`unified/` contains the #765 unified-kernel validation surface while the
stabilization backlog lands. It owns the temporary composition of the runtime
workflow, signal, table, codec, observer, and host factory pieces that replace
the deleted pre-unified `subscribers/` and `composition/` roots.

This is an active stabilization target, not a new long-term layer in the
pre-unified target tree. The full runtime surface realignment is tracked by
tf-ll90.8.

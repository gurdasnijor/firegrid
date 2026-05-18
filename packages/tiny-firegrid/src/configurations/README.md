# tiny-firegrid configurations

Each file in this directory is an executable architecture diagram. A
configuration should wire a whole pipeline through public Firegrid boundaries,
then tests should assert externally visible behavior from the outside.

Use a new configuration when proposing or validating an architectural shape. If
the shape compiles and runs without private production imports, that is evidence
the current public seams can express it. If it only works by reaching through
internal machinery, that is a design finding.

Configurations are intentionally inline and readable. The package is excluded
from the duplication gate because repeated wiring is documentation here; hiding
the wiring behind opaque helpers would make the model less useful.

`DurableTable.rows()` in this package replays current rows and then tails live
changes. Use `query()` for terminating snapshot reads.

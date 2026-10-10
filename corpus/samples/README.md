# Sample networks

A sample is a design Fathom builds for a person to try things on (round 10, lessons B; r15-start). It is data,
reviewed like a rule: `client/src/components/home/sampleNetwork.ts` turns it into a document with the same commands
the editor uses, so a sample can hold nothing a person could not draw by hand.

- `devices[].catalogue` names a model in `corpus/catalogue/`. If the catalogue does not hold it, or holds it
  without a port the sample uses (matched by label and connector), the device is drawn as a sketch with
  `devices[].ports`. Label ports the way the catalogue does: its silkscreen number.
- `cables[].a`/`.b` and every port reference are `hostname:label`.
- `trace` names two devices a path trace must cross end to end; `client/src/engine/sample.trace.test.ts` holds
  the sample to it, with and without catalogue models.
- Every factual claim names its source in `sources` (CLAUDE.md rule 1).

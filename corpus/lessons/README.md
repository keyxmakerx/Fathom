# Lessons

A guided lesson (ADR-0066 item 1.3, round 10 lessons B) is data, reviewed like a rule. Each one runs in its own fresh
copy of a sample network from `corpus/samples/`, so nothing a learner tries touches a real design.
`client/src/components/lessons/` reads these files and checks every step itself; nobody marks a step by hand.

- `sample` names a sample by id. Devices are named by hostname, ports and cables as `hostname:label`.
- `steps[].kind` is one of the kinds ADR-0066 §2 fixes:
  - `read`: text, and optionally an explainer from `corpus/explainers/` to open. Passed by moving on.
  - `click`: the learner picks something on the canvas. `answer` is `{ "device": hostname }` or
    `{ "cable": "hostname:label" }` (the cable on that port). `hint` shows after a wrong pick, `after` after the right one.
  - `trace`: a path trace the learner starts from the step. `from` is `{ "device": hostname }` or
    `{ "port": "hostname:label" }`, `to` is `{ "device": hostname }`, `flow` is optional (`TCP 554`).
    `expect` is `{ "reaches": true, "crosses": [hostnames] }`, `{ "reaches": false, "stopsAt": hostname }` or
    `{ "firstMatch": policy name }` (the first policy on the firewall hop whose state is "matches").
  - `change`: the learner changes the design and watches Checks. `expect` is `{ "rule": rule id, "now": "fires" | "clears" }`.
- `client/src/engine/lessons.test.ts` runs every lesson's trace and change steps against its sample, so a lesson
  whose answer stops being true fails the build.
- Every factual claim names its source in `sources` (CLAUDE.md rule 1).

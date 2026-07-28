# ADR-0019 — Vanilla TypeScript over a first-party render layer, and no npm in any artifact-producing stage

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §3.8 (D08); `41` §§4.2–4.5; `42` §§2, 3, 7, 11
> **Reversal cost:** R2 at 800 lines of render layer; R4 at 3,000
> **Supersedes:** —

## Context

Brief §8 says *"thin TypeScript UI"* and *"Node.js appears in the build pipeline only, and can be
eliminated entirely if desired."* Two questions hide inside that: is there a second language at all,
and if so, what checks it?

The decisive property is the shape of the WASM boundary. `41`'s central performance decision is
*"one crossing per user intention, never one per element"* — a coarse, message-shaped boundary with
a 16-entry traffic census. A Rust-native UI framework is a fine-grained boundary by construction:
one crossing per element, per attribute, per event listener, thousands per frame. Adopting one means
paying the WASM module's costs to get the boundary shape the design specifically chose against.

The framework options fail on gates that exist for reasons: Svelte and Solid are **Node compilers**,
which `42`'s Z2 gate forbids outright; Lit needs a Trusted Types policy whose `createHTML` is
`(s) => s`, which destroys `34` §2.9's argument.

The npm question has a better answer than the one usually given. `42` §3 routes around it: the
TS → JS transform is `oxc`, a Rust library crate pinned by `Cargo.lock`, and the type check is the
Go-native TypeScript compiler, a native binary pinned by SHA-256, run `--noEmit`, producing no
artifact byte.

## Decision

**Vanilla TypeScript over a first-party render layer capped at 800 lines. No UI framework. No
Rust-native UI. No npm package is installed or executed in any stage that can influence an artifact
byte.**

Four properties are part of the decision:

1. **The boundary is coarse and message-shaped** — one WASM crossing per user intention, over a raw
   `(ptr, len)` ABI with ten exports and two imports (`41`). Views are pure functions of typed data.
2. **The render layer is capped at 800 lines and CI fails above it.** Not because 800 is magic, but
   because the failure mode is gradual and a number is the only thing that makes it visible. The
   801st line becomes a design conversation, which is the point.
3. **The honest public sentence is `42` §2's, not the short one.** *"TypeScript exists, is
   type-checked, and no npm package is installed or executed in any stage that can influence an
   artifact byte"* — which is stronger and truer than *"no Node in the build"*. Anyone repeating the
   shorter version in public material is overstating it.
4. **The exit is named and kept open.** `41` §4.3 records that a Rust-native UI is re-openable
   precisely because the views are pure functions of typed data and the render layer is small.

## Consequences

### Positive

- The WASM boundary keeps the shape every performance budget in `44` was computed against.
- The build's trusted closure stays inside `Cargo.lock` plus two SHA-256-pinned binaries, which is
  what makes `35`'s reproducibility claim checkable by a stranger.
- A design language this specific (`51`'s channel budget, `86`'s findings) is easier to hold in
  hand-written DOM than inside a framework's abstractions, because there is no library default to
  fight.
- The 800-line cap is the only mechanism in the corpus that makes accidental framework growth
  visible before it is expensive.

### Negative

- **Two languages, two test harnesses, one boundary, forever.** Every type at the seam exists twice
  and drift between them is `41` §2.5's named main integration risk. Codegen mitigates it and does
  not remove it.
- **A hand-rolled render layer accretes into an undocumented framework with one contributor who
  understands it.** This is the standard failure and the 800-line cap is a speed bump, not a
  guarantee: the pressure at line 801 is to raise the cap, and there is nobody to say no under
  ADR-0003's staffing.
- **No framework means no ecosystem.** Every list virtualisation, every focus trap, every roving
  tab-index, every `aria-live` region is written and maintained here — and `55`'s accessibility
  contract is unusually demanding. `86` D-37 already found a focus-visible failure in the finder,
  which is exactly the class of defect a mature component library would not have.
- **`oxc` and the Go-native TypeScript compiler are both young dependencies in load-bearing
  positions.** `42` §11's fallback for a compiler regression is to ship with the type gate red and a
  recorded exception, which is worse than it sounds: the gate is the only control against boundary
  drift.
- **Vanilla TS with no framework means no reactivity**, so every state change is an explicit re-render
  call. `52`'s `Selection` + `epoch` model handles this well on paper; in practice missed re-renders
  are the most common bug class in this architecture.

## Alternatives considered

| Option | Strongest argument for it, in its own terms | Why rejected |
|---|---|---|
| **Rust-native UI (Dioxus, Leptos, Sycamore)** | *One language, no generated boundary types, no drift, and `42` shrinks to CSS and fonts.* It deletes the seam that `41` §2.5 names as the main integration risk, rather than mitigating it | The boundary shape. A fine-grained UI framework crosses WASM thousands of times per frame against a design whose central property is 16 coarse crossings. `web-sys` in the shipped closure also kills the two-imports property, and text input, IME, selection and accessibility are exactly where reimplementing browser behaviour hurts |
| **Preact (or Lit)** | A real component model, a real ecosystem, small, and the closest survivor of `42`'s gates | Lit's Trusted Types policy has to be `(s) => s`, which destroys the argument `34` §2.9 makes for having Trusted Types at all. Preact survives the gates and brings a dependency into the artifact for a UI that is 3,000 lines of pure-function views |
| **Svelte or Solid** | Best-in-class output size and ergonomics | Both are Node compilers. `42`'s Z2 gate forbids them outright, and the gate exists so that the artifact's provenance is `Cargo.lock` plus two pinned binaries |
| **Plain JavaScript, no types** | Simplest possible build: no transform, no type gate, no generated types | The WASM ABI seam is the highest-risk surface in the product and this leaves it unchecked. It removes the only control against the risk `41` §2.5 names first |
| **JS + JSDoc types** | All of TypeScript's checking with none of the transform step | All of A's tooling, worse ergonomics, no advantage |

## Revisit if

- The UI exceeds ~3,000 lines and boundary types dominate the bug list — reopen the Rust-native
  option. It is the one large stack decision that is not one-way, and almost nothing else in this
  stack has that property.
- The render layer hits 800 lines. That is not automatically a reversal; it is the trigger for the
  design conversation the cap exists to force.
- The Go-native TypeScript compiler becomes unavailable or regresses. `42` §11 handles it and the
  handling is a degradation, so a second consecutive release with the gate red is the real trigger.
- `oxc`'s minifier miscompiles the UI — ship unminified; the single-file artifact is dominated by
  base64 WASM anyway.

export const meta = {
  name: 'author-wo-12-key-boundary',
  description: 'Design and author WO-12 — the key boundary and the first stored row — via a small judge panel, then adversarially verify the order against ADR-0040',
  phases: [
    { title: 'Design', detail: 'three independent designs from different angles' },
    { title: 'Judge', detail: 'score each design on six criteria' },
    { title: 'Author', detail: 'synthesise the winner into WO-12 on disk' },
    { title: 'Verify', detail: 'three skeptics attack the written order' },
    { title: 'Repair', detail: 'apply required fixes, if any' },
  ],
}

const SOURCES = [
  'BINDING SOURCES — read these before designing anything:',
  '  docs/90-decisions/adr-0040-the-server-holds-the-keys-and-says-so.md  (all of it; D1-D8 and §9)',
  '  docs/70-ops/79-work-orders/WO-11-the-server-skeleton-and-the-dependency-gate.md  (the house style, §8 non-goals, §9 as-built, §9.7 the crate-cap escalation)',
  '  docs/40-stack/49-the-server-product.md  §7 (storing a typed graph), §11 (multi-tenancy and RLS), §19 (phase 1), §22',
  '  docs/70-ops/70-owner-answers-and-standing-priorities.md  §18 (tenancy lives OUTSIDE the graph as server tables)',
  '  deps/decisions/00-CLOSURE.md, argon2.md, chacha20poly1305.md  (two crypto crates ALREADY OWNER-APPROVED on 2026-08-15, closure measured at 22 crates, neither vendored yet)',
  '  crates/fathom-server/  (what exists: config, secret, db, health, migrate, one migration)',
  '  docs/70-ops/OPEN-FOR-THE-OWNER.md  §A and §B (what is genuinely undecided — the order must NOT decide any of it)',
  '  .context/conventions.md  (invariants; invariant 4 is scoped by ADR-0040)',
].join('\n')

const CONSTRAINTS = [
  'HARD CONSTRAINTS on the design:',
  '  1. ADR-0040 D1: envelope encryption from the FIRST stored byte. A data key per tenant AND per design. No plaintext customer data in any column, ever.',
  '  2. THE KEY-MANAGEMENT SERVICE IS UNDECIDED (ADR-0040 §9 items 1 and 2; OPEN-FOR-THE-OWNER §A1). The order must make the master-key holder a PROVIDER BEHIND AN INTERFACE chosen by deployment configuration, such that a cloud KMS, a Vault, or a protected local file can each be plugged in later WITH ZERO MIGRATION of stored data. The stored wrapped-key format must be provider-neutral. The first provider built is the local-file one, because self-hosted customers need it regardless.',
  '  3. ADR-0040 D4: deleting a tenant is destroying a key. D7: no length oracle — the persistence layer must be TYPE-unable to store an exact secret length.',
  '  4. Tenancy lives OUTSIDE the graph as server tables (70 §18). No schema/ change for tenancy.',
  '  5. The order must NOT decide anything in OPEN-FOR-THE-OWNER §A or §B — hosted vs shipped, who reads customer maps, backups, sign-up, roles. Where the design touches one, it names it as a stop-and-escalate trigger or leaves it as config.',
  '  6. Crates: argon2 and chacha20poly1305 are already approved (closure 22). Anything else new needs its own record and counts against the ≤160 cap that WO-11 §9.7 already escalated (115 now). Name every crate the design adds and its measured or estimated closure cost.',
  '  7. Every acceptance gate must be FALSIFIABLE and, where it is a safety property, proved by watching it fail — WO-11 §6 G2/G3 style. CLAUDE.md rule 0.',
  '  8. ADR-0034: no security claim from memory. Name the source and the date for anything cryptographic (key sizes, AEAD choice, KDF parameters).',
].join('\n')

const DESIGN = {
  type: 'object',
  properties: {
    angle: { type: 'string' },
    summary: { type: 'string', description: 'the design in ten lines' },
    wrap_interface: { type: 'string', description: 'the Rust trait or function signature for the key-wrap provider, with its error type' },
    wrapped_key_format: { type: 'string', description: 'exactly what bytes/columns are stored for a wrapped data key, and why a later provider needs no migration' },
    tables_in_0002: { type: 'array', items: { type: 'string' }, description: 'each table and its columns, one string per table' },
    first_provider: { type: 'string', description: 'the local-file provider: where the master key lives, how it is protected, what the operator must do' },
    stays_config: { type: 'array', items: { type: 'string' }, description: 'decisions deliberately left as deployment configuration' },
    escalates: { type: 'array', items: { type: 'string' }, description: 'owner questions this touches and must stop on' },
    crates_added: { type: 'array', items: { type: 'string' } },
    gates: { type: 'array', items: { type: 'string' }, description: 'falsifiable acceptance gates, each saying how it is watched to fail' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['angle', 'summary', 'wrap_interface', 'wrapped_key_format', 'tables_in_0002', 'first_provider', 'stays_config', 'escalates', 'crates_added', 'gates', 'risks'],
}

const SCORE = {
  type: 'object',
  properties: {
    retrofit_free: { type: 'number', description: '0-10: can a cloud KMS replace the file provider later with zero data migration?' },
    adr_0040: { type: 'number', description: '0-10: compliance with D1-D8, especially D4 and D7' },
    owner_neutral: { type: 'number', description: '0-10: decides nothing in OPEN-FOR-THE-OWNER §A/§B' },
    crate_cost: { type: 'number', description: '0-10: fewer new crates is better; 10 = only the two already approved' },
    falsifiable: { type: 'number', description: '0-10: gates that can be watched to fail' },
    buildable: { type: 'number', description: '0-10: one execution session can build it on the current tree' },
    total: { type: 'number' },
    strongest_idea: { type: 'string', description: 'the one thing this design does best, worth grafting into the winner' },
    weakest_point: { type: 'string' },
  },
  required: ['retrofit_free', 'adr_0040', 'owner_neutral', 'crate_cost', 'falsifiable', 'buildable', 'total', 'strongest_idea', 'weakest_point'],
}

const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true if the order as written has a defect that must be fixed before execution' },
    reasoning: { type: 'string' },
    required_fixes: { type: 'array', items: { type: 'string' }, description: 'concrete edits to the file, each one sentence, empty if none' },
  },
  required: ['refuted', 'reasoning', 'required_fixes'],
}

const ANGLES = [
  { key: 'security-first', prompt: 'Design from the SECURITY side: start from ADR-0040 D1-D8 and the threat that a database dump, a backup tape, or a stolen server leaks a customer map. Make the wrapped-key format and the provider boundary airtight before thinking about convenience.' },
  { key: 'operator-first', prompt: 'Design from the SELF-HOSTED OPERATOR side: a customer IT team installing this on their own hardware with no cloud. What must they do to hold the master key safely, what happens on restart, on backup, on losing the file. The local-file provider is the product here; make it honest and boring.' },
  { key: 'smallest-cut', prompt: 'Design the SMALLEST order that stores one real encrypted row end to end — the tenant, the design, its wrapped key, one opaque encrypted blob — and proves the custody switch by re-wrapping under a second file key in a test. Minimise tables, crates and surface. The point is to prove the boundary, not build the product.' },
]

phase('Design')
log('Three independent designs')
const designs = (await parallel(ANGLES.map(a => () =>
  agent([
    'You are designing WO-12 for Fathom: THE KEY BOUNDARY AND THE FIRST STORED ROW — the first server order that stores customer data.',
    '', a.prompt, '', SOURCES, '', CONSTRAINTS, '',
    'Read the sources. Then produce a design. Be concrete: real trait signatures, real column lists, real crate names with versions read from the crates.io sparse index (https://index.crates.io/<path>) if you add any beyond the two approved. Do not write the work order yet — that is a later stage.',
  ].join('\n'), { label: 'design:' + a.key, phase: 'Design', schema: DESIGN })
))).filter(Boolean)
log(designs.length + ' designs in')

phase('Judge')
// Barrier justified: each judge scores ALL designs against each other.
const scores = (await parallel(designs.map((d, i) => () =>
  agent([
    'Score this design for WO-12 (Fathom, the key boundary and first stored row) on six criteria, 0-10 each. Be harsh; a 10 is rare.',
    '', SOURCES, '', CONSTRAINTS, '',
    'THE DESIGN UNDER JUDGEMENT (angle: ' + d.angle + '):',
    JSON.stringify(d, null, 2),
    '',
    'THE OTHER DESIGNS, for comparison only:',
    designs.filter((_, j) => j !== i).map(o => '--- ' + o.angle + ' ---\n' + o.summary + '\nwrapped key: ' + o.wrapped_key_format + '\ncrates: ' + o.crates_added.join(', ')).join('\n\n'),
    '',
    'For retrofit_free, actually reason about whether AWS KMS (wrap is an RPC, master key never leaves) and a local file (wrap is local) can share the stored format this design proposes. For adr_0040, check D4 and D7 explicitly. For owner_neutral, check OPEN-FOR-THE-OWNER §A and §B item by item.',
  ].join('\n'), { label: 'judge:' + d.angle, phase: 'Judge', schema: SCORE })
))).filter(Boolean)

const ranked = designs.map((d, i) => ({ d, s: scores[i] })).filter(x => x.s).sort((a, b) => b.s.total - a.s.total)
const winner = ranked[0]
log('Winner: ' + winner.d.angle + ' (' + winner.s.total + '). Grafting: ' + ranked.slice(1).map(r => r.s.strongest_idea).join(' | '))

phase('Author')
const ORDER_PATH = 'docs/70-ops/79-work-orders/WO-12-the-key-boundary-and-the-first-stored-row.md'
const authored = await agent([
  'WRITE the work order file ' + ORDER_PATH + ' to disk. Use the Write tool. Return the path and a three-line summary as your final text.',
  '', SOURCES, '', CONSTRAINTS, '',
  'THE WINNING DESIGN (' + winner.d.angle + ', scored ' + winner.s.total + '):',
  JSON.stringify(winner.d, null, 2),
  '',
  'IDEAS TO GRAFT FROM THE RUNNERS-UP, each judged the strongest thing about its design:',
  ranked.slice(1).map(r => '- from ' + r.d.angle + ': ' + r.s.strongest_idea).join('\n'),
  '',
  'THE WINNER\'S WEAKEST POINT, which the order must address rather than inherit: ' + winner.s.weakest_point,
  '',
  'HOUSE STYLE — copy WO-11\'s structure exactly: a status line (Status: OPEN, depends on WO-11 DONE), §0 contents table, §1 Objective, §2 Binding sources (table), §3 Prior state (verified against the tree TODAY — read crates/fathom-server and Cargo.lock), §4 Deliverables, §5 The plan (numbered steps, one commit per step, gates re-run on every step), §6 Acceptance gates (G1..Gn, each falsifiable, safety ones watched to fail), §7 Stop-and-escalate triggers, §8 Non-goals, then Failure modes / Open decisions / Sources consulted / Disagreements. Date everything 2026-09-04.',
  '',
  'NON-NEGOTIABLE CONTENT:',
  '  - §5 step 0 re-reads every crate version from the sparse index before pinning (WO-11 trigger 1 pattern) and names the two already-approved crates by their deps/decisions records.',
  '  - A gate that proves the CUSTODY SWITCH: data encrypted under file-key A, re-wrapped to file-key B, readable under B and NOT under A, with the data bytes untouched (assert the ciphertext column is byte-identical before and after).',
  '  - A gate that proves D4: destroying a tenant\'s key makes its rows unreadable even though the rows still exist.',
  '  - A gate that proves D7 at the type level: no code path can store an exact secret length.',
  '  - A gate proving the provider boundary: a second, deliberately trivial provider (in tests only) round-trips the SAME stored wrapped-key rows with no migration.',
  '  - A stop-and-escalate trigger for EACH of OPEN-FOR-THE-OWNER §A1, §B1, §B2, §B3 and §B4 stating exactly what the executor does if the work reaches that question: stop, do not choose.',
  '  - Disagreements §: state plainly where this order disagrees with 49 §19\'s ordering (it stores a row before accounts exist) and why.',
  '  - Write for a maintainer who is not here; every number sourced, every claim about a crate dated.',
].join('\n'), { label: 'author:WO-12', phase: 'Author' })
log('Authored: ' + String(authored).slice(0, 200))

phase('Verify')
const LENSES = [
  { key: 'adr-0040-auditor', prompt: 'You are auditing ' + ORDER_PATH + ' against ADR-0040 D1-D8 line by line. Try to REFUTE the claim that executing this order as written keeps every one of the eight decisions. Pay special attention to D4 (delete = destroy key — is there any row that survives readable?), D7 (is there any path that stores an exact length?), and D1 (is there any plaintext customer byte in any column, including tenant or design NAMES?).' },
  { key: 'retrofit-skeptic', prompt: 'You are the RETROFIT skeptic for ' + ORDER_PATH + '. WO-11 stored nothing specifically so that no stored byte would have to be re-encrypted when the key-management service is chosen. Try to REFUTE the claim that this order preserves that: find any stored byte, column, or format that a later choice of AWS KMS, Vault Transit, or an HSM would force to be migrated or re-encrypted. Reason about each provider concretely — KMS wrap is an RPC returning a ciphertext with its own envelope; Vault Transit returns a versioned "vault:v1:..." string; a file provider produces raw AEAD output. Can one column hold all three?' },
  { key: 'protocol-checker', prompt: 'You are checking ' + ORDER_PATH + ' against docs/70-ops/78-execution-protocol.md and CLAUDE.md rule 0. Try to REFUTE that an execution session could run it without making a decision the order leaves open: find any step that requires judgement not covered by a stop-and-escalate trigger; any acceptance gate that is not falsifiable or that a session could pass vacuously; any place it decides something in docs/70-ops/OPEN-FOR-THE-OWNER.md §A or §B; any crate it adds without naming its closure cost against the 160 cap (115 now, +22 for the two approved crypto crates).' },
]
const verdicts = (await parallel(LENSES.map(l => () =>
  agent([l.prompt, '', 'Read the file. Read the binding sources it cites. Default to refuted=true if you find ANY concrete defect; list each as a required fix in one sentence naming the section. If it genuinely holds, say so and why.'].join('\n'),
    { label: 'verify:' + l.key, phase: 'Verify', schema: VERDICT })
))).filter(Boolean)

const fixes = verdicts.flatMap(v => v.required_fixes || [])
log(verdicts.filter(v => v.refuted).length + ' of ' + verdicts.length + ' skeptics refuted; ' + fixes.length + ' required fixes')

phase('Repair')
let repaired = null
if (fixes.length) {
  repaired = await agent([
    'Apply these required fixes to ' + ORDER_PATH + ' with the Edit tool. Each fix came from an adversarial reviewer and must be addressed — either by changing the order or, where the reviewer is wrong, by adding a line to the Disagreements section saying so and why. Do not silently drop any. Return a one-line-per-fix account of what you did.',
    '', 'FIXES:', fixes.map((f, i) => (i + 1) + '. ' + f).join('\n'),
    '', 'REVIEWERS\' REASONING, for context:', verdicts.map(v => '--- ' + (v.refuted ? 'REFUTED' : 'held') + ' ---\n' + v.reasoning).join('\n\n'),
  ].join('\n'), { label: 'repair:WO-12', phase: 'Repair' })
}

return {
  winner: winner.d.angle,
  scores: ranked.map(r => ({ angle: r.d.angle, total: r.s.total, weakest: r.s.weakest_point })),
  path: ORDER_PATH,
  verdicts: verdicts.map(v => ({ refuted: v.refuted, fixes: v.required_fixes })),
  repaired: repaired ? String(repaired).slice(0, 1500) : 'no fixes needed',
}

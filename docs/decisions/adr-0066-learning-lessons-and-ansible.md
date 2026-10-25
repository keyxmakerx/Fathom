# ADR-0066: Learning, lessons and Ansible

**Status:** accepted 2026-10-25 (owner answered sign-off cards learn-next, ansible-scope,
ansible-learn, lesson-builder, ansible-password and ansible-lesson, 25 October). Mockups in the
project's `mockups/r16-learning.html` (frames b1, b2, p1, l1).

**Context.** Teaching and the estate of record are co-equal goals (CLAUDE.md). An audit on
25 October found the "explain the problem in front of you" half in good shape (Why? cards on
13 Checks rules, refusals, path trace, troubleshooting, plans) and the "teach me" half approved
but not built: no Learn switch (ADR-0061 item 6), no guided lessons (ADR-0061, r10-lessons B),
one sample network, and 14 explainer files (55 entries) in `corpus/explainers/` that no screen
showed. The owner also asked for Ansible support, with learning on it.

## Decided

1. **All six learning items, and each must work, not be a stub.** In order:
   1. Show the explainers: a device whose platform has one gets an "About" card in its panel,
      labelled *Unreviewed* while `reviewed_by` is a placeholder, with its sources and read dates.
   2. The Learn switch from r4-teach A.
   3. Guided lessons in sample networks (r10-lessons B): a lesson runner, a small-office sample
      with a firewall, and three first lessons (VLANs, single points of failure, firewall policy
      order).
   4. Read the 13 Checks rules' sources, so each Why? card stands on a source someone has read.
   5. Explainers for Cisco IOS XE and MikroTik RouterOS, the two pasted platforms with none.
   6. Lessons on your own design, made with a lesson builder.
2. **Lesson builder: step by step** (card lesson-builder, A; frame b1). A lesson is a list of
   steps of fixed kinds: Read, Click the answer (picked on the canvas), Trace (with the expected
   result), Change it and watch (which Check fires or clears), Run Ansible. A learner runs it on a
   frozen copy taken when the lesson is published, never on the live design. Fathom checks each
   step; nobody marks it by hand. Recording a lesson by doing it (B) was not chosen.
3. **Ansible: Fathom writes the files, the person runs them** (card ansible-scope, C). Fathom
   writes an inventory (`hosts.yml` grouped by site, rack, role and platform, `ansible_host` from
   `Device.management_address`), `group_vars` with connection settings per platform, and
   playbooks that push changes using the platform's resource modules, always offered with
   `--check --diff` first. **Fathom never connects to a device and never runs Ansible** (ADR-0045
   unchanged). The first use is changing the admin password.
4. **Where a new password lives** (card ansible-password, A and C). Default: in the credential
   vault of ADR-0042, Mode A, sealed in the browser, handed over inside an Ansible Vault file the
   browser writes (format: docs.ansible.com, "Using encrypted variables and files", page dated
   2026-10-19, read 2026-10-25). The old password is kept until the change is recorded as done.
   Also offered: Mode C, a reference to the person's own vault. The owner named **Passbolt,
   Vaultwarden and Delinea**; each vault's API and sign-in model is looked up from its own
   documentation, with a date, before it is built (CLAUDE.md rule 1). A generated password must
   fit what each platform accepts, looked up per platform (CLAUDE.md rule 2).
5. **Ansible lessons are interactive** (card ansible-learn, A; card ansible-lesson approved;
   frame l1). A four-lesson track: read the inventory Fathom wrote; a read-only ad-hoc command; a
   first playbook; change the admin password. The learner edits real YAML and runs it against a
   simulated copy of the sample network in the browser, which answers with `--check --diff`
   output computed from the design. "Run it on your own lab" is an optional last step.

## Wording

Say "Fathom writes the files; you run them." Never imply Fathom reaches a device. Once the
ADR-0042 vault exists, ADR-0040 §6's "destroys every password before it stores anything" is no
longer the whole story, so password screens must not reuse it. The four forbidden sentences
(CLAUDE.md rule 5) stay forbidden.

## Not decided here

Which external vault is built first; which platforms the first Ansible export covers beyond those
with a registry row and a documented collection; firmware how-tos outside Fathom (owned elsewhere).

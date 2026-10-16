# README-pfsense.md — what `corpus/dict/pfsense/` reads, and the sources

**Status:** written 2026-10-10 for the round 15 sign-off ("paste reads home-lab gear"). Sources
were read on 2026-10-10:

- **S1**: the pfSense source at github.com/pfsense/pfsense, master at commit 9363ac5
  (2026-03-31, "2.9.0-DEVELOPMENT").
- **S2**: the 2.7.0 default config, `RELENG_2_7_0/src/conf.default/config.xml`.
- **S3**: real exported configs (21.7, 22.2, 23.3) kept as test fixtures by pfsensible/core
  (`tests/unit/plugins/modules/fixtures`, commit 62b56a1).

The Plus source and the 2.8 branches are not public; nothing here is established for them
specifically.

## What is read

The whole-file backup `config.xml` (Diagnostics > Backup & Restore), pasted as text. Root element
`<pfsense>` (`xml_rootobj`, `globals.inc`, S1). The reader is `crates/fathom-ingest/src/xml.rs`, a
front end of its own; the wasm shell picks it when the document's root is `<pfsense>`.

Format facts it relies on (S1 unless named): flags are empty elements (`<enable></enable>`, S2);
the writer emits no attributes; values are entity-escaped even inside CDATA and decoded after
parsing (`xmlparse.inc`), so the reader decodes CDATA text too; VLANs are `<vlan>` records with
`<if>`, `<tag>`, `<pcp>`, `<descr>`, `<vlanif>` (`interfaces_vlan_edit.php`).

## Why every undescribed value is destroyed

**The dictionary is an allowlist.** The front end destroys every leaf value no entry describes
(`redact::gate_with_forced`). A deny-list cannot work for this file:

- Many secrets are **base64-encoded**, so no word or shape detector sees them: `cert/prv` and
  `ca/prv`, OpenVPN `shared_key` and `tls`, IPsec phase 1 `private-key`, `ppps/ppp/password` and
  `secret`, `dyndnses/dyndns/password`, captive-portal voucher `privatekey`,
  `system/user/authorizedkeys`, and the ACME package's `accountkey` (S1, each found where it is
  written with `base64_encode`; corroborated in S3, where a `<prv>` decodes to
  `-----BEGIN PRIVATE KEY-----`).
- With "include SSH keys" ticked, the backup carries SSH host private keys **deflated then
  base64-encoded** (`ssh_keys_xml()`, `backup.inc`).
- The PPPoE server stores user passwords **inside `<username>`**, as `user:` + base64
  (`services_pppoe_edit.php`).
- pfSense's own sanitiser (`$filtered_tags`, `status_output.inc`) misses `snmpd/rwcommunity`,
  notification API keys, `omapi_key`, `vouchersyncpass`, `acb/device_key` and `sshdata`.
- Every package under `installedpackages` adds fields nobody can list in advance.

`secrets.yaml` names the plaintext and hashed credentials (`bcrypt-hash`, `sha512-hash`,
`ipsecpsk`, phase 1 `pre-shared-key`, SNMP communities) so the stored capture says what was
destroyed. Their values would be destroyed without those entries too. Password hashes are
destroyed like passwords: a hash can be cracked, and the rule is that credentials never arrive.

An **encrypted backup** (`---- BEGIN config.xml ----` armour around AES-256-CBC base64,
`crypt.inc`) cannot be read: it is not XML, nothing binds, and the paste is refused before
anything is stored.

## What is bound

The hostname; interface assignments (the port in `<if>`, its description, `enable`); VLANs (the
`vlanif` interface, its tag, parent port and description). `ipaddr` and `subnet` are kept
readable but not bound: they are two elements, and an `Address` needs them as one value.

## Not bound yet

Addresses, gateways, static routes, DHCP, firewall rules, users and groups, VPNs. Their lines are
residue, and their values are destroyed until an entry describes them.

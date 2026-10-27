# Registry generator

How Libredi builds its [EDIFACT definition registry](../contracts/registry/README.md) from the
official UN/ECE directories. The generator lives in [`packages/registry`](../packages/registry).
It covers the download ([#31](https://github.com/imapanda/libredi/issues/31)), the parser
([#32](https://github.com/imapanda/libredi/issues/32)), the command that runs them
(`libredi registry build`, [#33](https://github.com/imapanda/libredi/issues/33)) and the guard that
keeps derived data out of Git ([#34](https://github.com/imapanda/libredi/issues/34)).

## Why it exists

The UN/EDIFACT directory licence forbids distributing a modified directory without written
permission from the UN. So Libredi never ships a registry: the operator's installation downloads the
official archive, checks it, and builds the registry on the operator's own volume, which makes the
operator the licensee ([ADR 7](adr/0007-standards-licensing.md)). The repository holds the code, the
[registry schema](../contracts/registry/registry.schema.json) and hand-written fictitious test files,
nothing else.

## Running it

```bash
pnpm --filter @libredi/cli libredi registry build --out /var/lib/libredi/registry
```

`libredi registry build` is the command of the `libredi` program ([`packages/cli`](../packages/cli),
which hands the arguments after `registry` to this package's `runCli`). The `libredi` script of
`packages/registry` runs the same code (`node src/main.ts`) without the other commands. The
registries it writes can be handed to `libredi inspect --registry <folder>`.

The command writes one file per directory, `d96a.json` and `d01b.json`, in the output folder.

| Option | Meaning |
| --- | --- |
| `--out <dir>` | Output folder. Default: `$LIBREDI_REGISTRY_DIR`, else `$XDG_DATA_HOME/libredi/registry`, which is `~/.local/share/libredi/registry`: outside the repository. |
| `--directory <id>` | Build only this directory (repeatable). Default: all. |
| `--offline <dir>` | [Offline mode](#offline-mode). Default: `$LIBREDI_REGISTRY_OFFLINE_DIR`. |
| `--cache <dir>` | Where downloaded archives are kept. Default: `<out>/.downloads`. |
| `--sha256 <id>=<hex>` | Expect another checksum than the pinned one. |
| `--force` | Build again even when the registry is up to date. |

- **It can run at every start.** A registry that is already in the output folder is left alone
  when it was built from the archive with the expected checksum, by this version of the generator,
  and still follows the schema and resolves its references. So the first start builds the
  registry, the next ones only check it, and a registry damaged or edited by hand is built again.
  A new version of the generator that changes the output changes `GENERATOR.version`
  (`generator.ts`), which rebuilds every registry.
- **A directory that fails does not stop the others.** The status is 0 when every directory is
  built or up to date, 1 when one failed (with the reason on the error output, one line per
  problem), and 2 for a wrong option.
- **Files are written atomically**, through a temporary file renamed over the target, so a service
  that reads the folder never sees half a registry.
- **In a container**, run the command as the first step of the service that reads the registry (or
  as an init container sharing its volume), with `LIBREDI_REGISTRY_DIR` on the volume and, without
  Internet access, `LIBREDI_REGISTRY_OFFLINE_DIR` on a read-only mount of the archives. The images
  do not contain the command yet: it goes into the image of the first service that loads the
  registry.

## Supported directories

| Directory | Syntax versions | Archive | SHA-256 of the archive |
| --- | --- | --- | --- |
| D.96A | 3 | `https://unece.org/DAM/trade/untdid/d96a/d96a.zip` | `1f94c7663a48bbc99d48e93bab16ed2ee127fda73682e6f4c80363256cbcdcd2` |
| D.01B | 3 and 4 | `https://unece.org/DAM/trade/untdid/d01b/d01b.zip` | `53a44f88b8c54793a07281f220bc30dae6a63deec83348587edbf630c14fac85` |

The table is the source of truth in [`directories.ts`](../packages/registry/src/directories.ts).
The checksums were computed from the copies kept by the Internet Archive, because `unece.org` refuses
the machine they were computed on (HTTP 403). The Archive holds several snapshots of each file, from
2021 to 2023, with identical content.

Adding another directory means adding a line to that table with its checksum, and checking that the
parsers read its files: the layout of the files changed over the years (D.96A and D.01B already
differ), and a newer directory may need a new case.

## Downloading

`obtainDirectory()` returns the archive of a directory, checked against its pinned SHA-256 before
anything reads it.

- **Retries.** A network error, a timeout, a 429 or a 5xx answer is tried again, three times in all,
  waiting one second, then two. Any other answer (403, 404) stops at once, as does a wrong checksum.
- **Limits.** One try lasts at most two minutes, and the file at most 64 MiB, checked on the announced
  size and again while reading.
- **Cache.** With a cache folder, a downloaded archive is kept there (written to a temporary file,
  then renamed) and reused while its checksum matches.
- **A wrong checksum is an error, never a warning.** The message gives the expected and the found
  checksum. If UN/ECE replaced the file, check what changed, then update the table. A caller can also
  pass the checksum it expects.

## Offline mode

For an installation without Internet access, or one that UN/ECE refuses:

1. On a machine that can reach UN/ECE, download the archive of each directory from the address in
   the table (or from the [UN/EDIFACT download page](https://unece.org/trade/uncefact/unedifact/download)),
   without changing it.
2. Put the files in one folder on the Libredi host, named as in the table (`d96a.zip`, `d01b.zip`;
   the case does not matter).
3. Give that folder to the generator as the offline folder. It then reads only from there, checks the
   checksum of each file, and never uses the network, even when a file is missing: it says which file
   to download and from where.

An archive that does not match the pinned checksum is refused. That includes an archive you modified.

## What it reads

An archive holds one archive per part of the directory, and each holds text files in the DOS code
page 437:

| Part | D.96A | D.01B | Becomes |
| --- | --- | --- | --- |
| Data elements | `TRED` | `EDED` | `dataElements` |
| Composites | `TRCD` | `EDCD` | `composites` |
| Segments | `TRSD` | `EDSD` | `segments` |
| Code lists | `UNCL` (two files) | `UNCL` | `codeLists` |
| Messages | `TRMD` | `EDMD` | `messages` (one file per message) |

The other files of the archive (documentation, the interactive messages, the licence text) are
ignored. The ZIP reader is written for this: it works in memory, refuses unsafe names, encrypted
entries and ZIP64, checks every CRC-32, and stops an archive from expanding beyond the sizes it
announces.

Choices made when reading:

- **Positions.** Elements and components keep the order of the directory. The repetition count of a
  segment element comes from D.01B; D.96A does not give one, which means once.
- **Code lists** are `closed`: the files do not say which lists are exhaustive, and the validator
  decides how strict to be ([#45](https://github.com/imapanda/libredi/issues/45)). A list with no
  code is not a code list.
- **Messages.** The segment table is a drawing: a segment group is a line of rules and its segments
  end in a vertical bar. The generator rebuilds the groups, their trigger segment and their nesting
  from the corners. UNH and UNT, which open and close every message, are left out.
- **`UNS`**, the section separator, is in every message table but not in the files. The generator
  defines it itself, with its own wording.
- **Messages it cannot describe are left out, with a warning.** In D.01B, `JUPREQ` and `PAYDUC` use
  the segments `UGH` and `UGT` of syntax version 4, which no file defines.

## Damaged or hostile files

The archive is checked against its SHA-256 before it is read, in every mode, and again when the
registry is built, so that a file nobody vouched for does not reach the parsers. They are
written not to depend on that check alone:

- A line of a directory file is cut at 200 characters (the longest real line has 71), a file or
  an archive that expands beyond 16 MiB per file or 64 MiB in all is refused, and the groups of a
  message may be nested 32 deep at most.
- At most 200 warnings are kept, each cut at 300 characters.
- A file supplied by the operator or found in the cache must be a regular file of at most 64 MiB; a
  link to a device or a pipe is refused. The cache is written through a file with a random name,
  created only if it does not exist, then renamed.
- A download that ends on a page that is not HTTPS is refused.
- Names taken from a file are quoted in error messages.

## Checks

Before returning a registry, the generator validates it against the schema and applies the reference
rules of `checkRegistry()`. A registry that fails either is never returned: the error lists the first
problems with their JSON Pointers. Lines of the files that it does not understand are returned as
warnings; there are none for D.96A and D.01B.

## Keeping derived data out of Git

[`scripts/check-derived-data.sh`](../scripts/check-derived-data.sh) fails when Git tracks:

- the archive of a directory, one of its parts or message files, or its licence, by name;
- a file that carries the licence text or the title pages of the directory files, whatever its name;
- a registry built from UN/ECE files (`"kind": "unece-directory"`), or any registry-shaped JSON
  file outside `contracts/registry/`.

It runs in the `Derived data` job of the CI, on every pull request: unlike most jobs, it does not wait
for the path filter, since such a file can be committed anywhere. The `.gitignore` also lists the
usual places (`/registry/`, `/.libredi/`, `*.registry.json`, `d96a.zip` and the like). Run the script
by hand before pushing if you work with real archives. The guard looks for files, not for facts:
it does not notice a fragment pasted into another file, so review what you paste.

## Tests

The tests never download anything and use no real directory data. They build small archives in
memory from the text files in
[`src/test-support/fixtures`](../packages/registry/src/test-support/fixtures): fictitious
directories with invented tags and texts that imitate the layout of the D.96A and D.01B files,
including their oddities (change indicators in several places, names that go over two lines, notes
under a segment, a table that wraps a name, an annex after the table).

To check the generator against the real files, run it on archives you downloaded, from a script
outside the repository, and keep the output out of it. Never commit an archive, a file taken out of
one, or a registry built from them: the guard of
[#34](https://github.com/imapanda/libredi/issues/34) exists to catch exactly that.

## Using the registry in a service

`@libredi/registry` imports the schema from `contracts/` so that a bundle carries it. A service
that imports the package therefore needs `contracts/` in its Docker build context (the
[`.dockerignore`](../.dockerignore) leaves it out today).

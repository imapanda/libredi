# Development

How to build, test and run Libredi on your machine. For how a change reaches `main`, see
[CONTRIBUTING.md](../CONTRIBUTING.md); for what the CI checks, see [CI/CD](ci-cd.md).

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Docker | Engine 28 or later, with Compose v2 | Runs the whole stack and builds the images. Older engines can expose a port published on `127.0.0.1` to other hosts of the same network. |
| Node.js | 26.12.1 | Pinned in [`.nvmrc`](../.nvmrc); `engine-strict` refuses other majors. |
| pnpm | 12.15.0 | Pinned in `package.json` (`packageManager`). Node.js no longer ships Corepack: `npm install --global pnpm@12.15.0`. |
| Go | 1.27.3 | For `services/connectors` and `tools/codegen`; pinned in their `go.mod`. |

No local install is needed in a Codespace or the VS Code dev container
([`.devcontainer`](../.devcontainer/devcontainer.json)): it provides all of the above and runs
`pnpm install` and `scripts/init-env.sh` for you. The container runs Docker-in-Docker, which is
privileged: open branches you trust, not an unreviewed fork.

## Quick start

```bash
pnpm install                              # all TypeScript packages and services
pnpm verify                               # Biome, typecheck, tests

scripts/init-env.sh                       # once: creates .env with a random database password
docker compose up --build --wait          # PostgreSQL + pgmq, five services, reverse proxy
curl http://127.0.0.1:8080/api/healthz    # {"status":"ok","service":"api"}

docker compose up --wait --scale worker=5 # five workers; --scale translator=2 works too
docker compose down                       # add --volumes to also delete the database
```

The proxy is the only container with a host port (`LIBREDI_PORT`, default `8080`, bound to
`127.0.0.1`). Services have none, so any number of replicas can run. The proxy routes
`/api/*` to `api` and `/mcp/*` to `mcp`, strips the prefix, and spreads requests over every
replica. `worker`, `translator` and `connectors` are internal. It answers only to the host names
in `LIBREDI_HOSTS` (default `localhost 127.0.0.1`) and replies 421 to any other `Host` header,
so a web page cannot reach it through DNS rebinding.

Compose networks enforce the architecture: the `translator` shares a network with the `worker`
only, so it cannot reach PostgreSQL; `postgres`, `worker` and `translator` have no Internet
access; only `connectors` can reach partners. `scripts/smoke-compose.sh` checks this.

## Repository layout

| Path | Content |
| --- | --- |
| `services/api`, `worker`, `translator`, `mcp` | TypeScript services. Each has its `Dockerfile`, a `src/main.ts` entry point and tests. |
| `services/connectors` | Go service, with its own `go.mod` and `Dockerfile`. |
| `packages/service-kit` | Shared runtime of the TypeScript services: `/healthz`, port handling, graceful shutdown. |
| `packages/contracts` | Tests that check that the files in `contracts/` are valid, and the TypeScript types generated from them (`@libredi/contracts/canonical/v1`, `/api`, `/jobs`). Each service tests its own responses against the contracts. |
| `packages/edifact` | The UN/EDIFACT engine. Today: the tokenizer (bytes in, flat tokens out), the character sets UNOA, UNOB, UNOC and UNOW, the splitter that finds the messages of a file in constant memory, the tree of messages with positions and a memory budget, and the serializer (a parsed tree byte for byte, or built data with the service characters and character set it is given), with syntax version 4 (the repetition separator), the CONTRL acknowledgement (written from a validation, read and matched with what was sent), and the validator (the file, its envelopes and, against a registry, the structure and data of its messages, with plain-language errors, see [Validation errors](validation-errors.md)); tested against `samples/edifact`, with a benchmark. See its [README](../packages/edifact/README.md). |
| `packages/cli` | The `libredi` program: `libredi inspect <file>` shows an EDIFACT file and what is wrong with it, as text or JSON, with documented exit codes; `libredi test <mapping>` runs the fixtures of a mapping in the sandbox; `libredi registry build` runs the registry generator. See its [README](../packages/cli/README.md). |
| `packages/erp-formats` | The files ERPs import and export: CSV written and read, JSON and XML written, from a format configuration (see [`contracts/erp-formats`](../contracts/erp-formats/README.md)), with positioned errors. See its [README](../packages/erp-formats/README.md). |
| `packages/mapping` | The mapping runner: a pure evaluator of the mappings of `contracts/mapping` (also for the browser preview), and a pool of worker threads that sandboxes it with time, depth, sequence and memory limits. See its [README](../packages/mapping/README.md). |
| `packages/registry` | The registry generator ([docs](registry-generator.md)): downloads the UN/ECE directories, parses them into the EDIFACT definition registry of `contracts/registry/`, and checks the result. Tests use fictitious files only. |
| `samples/edifact` | Fictitious EDIFACT interchanges with expected results, for the tokenizer, parser and validator. See its [README](../samples/edifact/README.md). |
| `contracts/` | OpenAPI (`openapi/`), job JSON Schemas (`jobs/`), canonical documents (`canonical/`), the mapping format (`mapping/`), the ERP file formats (`erp-formats/`) and the EDIFACT registry schema (`registry/`), written before the code. See its [README](../contracts/README.md). |
| `infra/postgres`, `infra/caddy` | Image of PostgreSQL with pgmq; configuration of the reverse proxy. |
| `compose.yaml`, `.env.example` | The stack on one machine. |
| `tools/codegen` | Go module that pins the generators of the Go code (`oapi-codegen`, `go-jsonschema`). |
| `scripts/` | `init-env.sh`, `check-pins.sh`, `check-derived-data.sh`, `generate-go.sh`, `smoke-image.sh`, `smoke-compose.sh`. |

Services are stubs for now: each answers `GET /healthz` and nothing else. Business logic comes
with the milestones of the [roadmap](roadmap.md).

## Commands

| Command | Does |
| --- | --- |
| `pnpm check` / `pnpm fix` | Lint and format check / apply the safe fixes (Biome, whole repository). |
| `pnpm typecheck` | `tsc --noEmit` in every package. |
| `pnpm test` | Vitest (with fast-check for property tests) in every package. |
| `pnpm build` | Bundle every service into `dist/main.js` with esbuild. |
| `pnpm --filter @libredi/edifact bench` | Benchmark the EDIFACT tokenizer, parser and serializer on a generated 10 MB interchange: throughput and memory. Never part of `verify`. |
| `pnpm verify` | `check`, `typecheck` and `test`. Run it before every push. |
| `pnpm --filter @libredi/contracts generate` | Regenerate the TypeScript types after changing a contract in `contracts/`. The tests fail when they are out of date. |
| `scripts/generate-go.sh` | Regenerate the Go code of `services/connectors/internal/generated` from the contracts. The Go job of the CI fails when it is out of date. |
| `pnpm --filter @libredi/api dev` | Run a service from source with `node --watch`. |
| `scripts/check-pins.sh` | Check that the Node.js, pnpm, Go and Biome versions agree across files. |
| `scripts/check-derived-data.sh` | Check that Git tracks no UN/EDIFACT directory file and no registry built from one ([ADR 7](adr/0007-standards-licensing.md)). |
| `pnpm --filter @libredi/cli libredi inspect <file>` | Show an EDIFACT file, validate it (`--json`, `--registry <path>`, exit status 0, 1, 2 or 3): see the [README](../packages/cli/README.md). |
| `pnpm --filter @libredi/cli libredi test <mapping>` | Run the fixtures of a mapping in the sandbox and show the differences (exit status 0, 1, 2 or 3): see the [README](../packages/cli/README.md#libredi-test). |
| `pnpm --filter @libredi/mapping bench` | Throughput of the mapping runner, on the main thread and in the worker pool: see the [README](../packages/mapping/README.md#throughput). |
| `pnpm --filter @libredi/cli libredi registry build` | Build the EDIFACT definition registry from the UN/ECE directories ([docs](registry-generator.md)). |
| `scripts/smoke-image.sh api` | Build one image, run it locked down, check health, user and shutdown. |
| `scripts/smoke-compose.sh` | The acceptance test: whole stack, three workers, routes, network isolation, pgmq. |

Go, from `services/connectors`:

```bash
go vet ./... && go test -race ./...
```

Without a local Go installation, from the repository root:

```bash
docker run --rm -v "$PWD/services/connectors":/src -w /src golang:1.27.3 go test -race ./...
```

## TypeScript conventions

- **No build step for packages.** A workspace package exports its `src/*.ts` files. Node.js
  (type stripping), Vitest and esbuild read them directly, so imports carry the `.ts`
  extension and only erasable syntax is allowed (no `enum`, no parameter properties).
  Each service is bundled into one file for its image.
- **Strict compiler**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`
  ([`tsconfig.base.json`](../tsconfig.base.json)).
- **Shared versions** live once, in the `catalog:` of
  [`pnpm-workspace.yaml`](../pnpm-workspace.yaml); packages refer to them with `"catalog:"`.
- **Supply chain**: pnpm ignores versions published less than 7 days ago
  (`minimumReleaseAge`, the same cooldown as Dependabot) and runs no dependency install
  script unless it is listed in `allowBuilds`.

### Lint and format: Biome

[Biome](https://biomejs.dev/) lints and formats the whole repository with one command
(`pnpm check`). It was preferred to ESLint with typescript-eslint and Prettier because it is a
single dependency instead of about a hundred packages to pin and review, which matters for a
gateway that handles partner data, and because it runs in milliseconds. It ships the rules we
need most: `noFloatingPromises` and `noMisusedPromises` (async code that silently drops
errors). Revisit if we need a rule only typescript-eslint has.

Rules beyond Biome's recommended set ([`biome.json`](../biome.json)):

- floating and misused promises are errors;
- `import type` for type-only imports, no non-null assertions (`!`);
- `console` only through `console.info` and `console.error` (services log JSON lines);
- `useLiteralKeys` is off: it conflicts with `noPropertyAccessFromIndexSignature`, which makes
  `process.env["PORT"]` the correct spelling.

Formatting: 2 spaces, double quotes, semicolons, 100 columns, LF
([`.editorconfig`](../.editorconfig) covers every other file type).

## One image per service

Each service has its own `Dockerfile` and its own CI job. The TypeScript images build from the
repository root (the shared packages are in the context); `connectors` builds from its own
directory.

- Multi-stage builds; the TypeScript images ship one bundled `dist/main.js` on
  `node:26.12.1-alpine`, the Go image one static binary on distroless.
- Non-root user, no write access needed (Compose runs them read-only, without capabilities).
- Base images are pinned by tag **and digest**; Dependabot proposes updates.
- `HEALTHCHECK` runs `main.js healthcheck` (or `connectors healthcheck`), which probes the
  local `/healthz`. Distroless has no `curl` or shell, so the binary checks itself.
- `org.opencontainers.image.source` points to the repository, so that GitHub Container
  Registry links an image to it.
- Services stop cleanly on `SIGTERM`: no new connections, requests in flight finish, exit 0.

One image and one CI job per service, and no service importing another service's code, are
decision 1 of [ADR 10](adr/0010-service-boundaries-and-communication.md): code shared between
services lives in `packages/*` and language-neutral interfaces in `contracts/`.

To add a service, copy `services/api` (or `services/connectors`), then:

1. add its filter to the `changes` job of [`ci.yml`](../.github/workflows/ci.yml), and its
   name to the `IN(...)` list of the `plan` step (TypeScript services only);
   Also add it to the list `CHANGES='[...]'` of the same step, which a manual run uses;
2. add its directory to the `docker` entry of
   [`dependabot.yml`](../.github/dependabot.yml);
3. add it to `compose.yaml` with its networks, to the
   [Caddyfile](../infra/caddy/Caddyfile) if it must be reachable from outside, to the `case` of
   `scripts/smoke-image.sh` and to the Dockerfile list of `scripts/check-pins.sh`;
4. run `pnpm install` and commit the lockfile: the CI and the Docker builds use
   `--frozen-lockfile`.

A new TypeScript service is picked up by the pnpm workspace on its own (`services/*`).

## PostgreSQL and the job queue

The `postgres` image adds [pgmq](https://github.com/pgmq/pgmq) to PostgreSQL 18 by running its
SQL file at first start (the "SQL-only" installation): no extension to compile, so the same
queue works on any managed PostgreSQL. The file is downloaded at build time from a tagged
release and verified against a SHA-256 checksum. To upgrade, change the tag and the checksum
in [`infra/postgres/Dockerfile`](../infra/postgres/Dockerfile) and follow pgmq's
`UPDATING.md`: the unversioned SQL install only supports a fresh database.

## Versions to bump together

| Pin | Where |
| --- | --- |
| Node.js | `.nvmrc`, `engines.node` in `package.json`, the two `FROM` lines of each TypeScript `Dockerfile`, `--target=node26` in each service's `build` script, the major of `@types/node` in `pnpm-workspace.yaml`, `.devcontainer/devcontainer.json`, this page |
| pnpm | `packageManager` and `engines.pnpm` in `package.json`, the `npm install` line of each TypeScript `Dockerfile`, `.devcontainer/devcontainer.json`, this page |
| Go | `go.mod` of `services/connectors` and of `tools/codegen`, the build `FROM` line of `services/connectors/Dockerfile`, `.devcontainer/devcontainer.json`, this page |
| Biome | the `catalog:` of `pnpm-workspace.yaml` and the `$schema` URL of `biome.json` |

Dependabot proposes the Docker and npm updates and leaves the other places alone, so
`scripts/check-pins.sh` runs in CI and fails when two of them disagree: change them in the
same pull request. Dependabot's `ignore` rules keep `node`, `postgres` and `@types/node` on
their current major: moving to a new Node.js LTS is a deliberate pull request.

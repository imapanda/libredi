# Contracts

The language-neutral interfaces between services, written before the code that implements
them. A service in any language reads these files; none of them is generated from code.

| Path | Describes | Used for |
| --- | --- | --- |
| [`openapi/api.yaml`](openapi/api.yaml) | The REST API of the `api` service (OpenAPI 3.1) | Synchronous calls between services, the web console and the MCP server |
| [`jobs/job-envelope.schema.json`](jobs/job-envelope.schema.json) | The envelope of every job in the PostgreSQL queue (JSON Schema 2020-12) | Asynchronous steps, through pgmq |
| [`canonical/`](canonical/README.md) | The neutral order, order response, despatch advice and invoice (JSON Schema 2020-12, versioned) | The documents partner mappings produce and ERP exports read |
| [`mapping/`](mapping/README.md) | The YAML format of a mapping, with its JSON Schema and examples | Declarative conversion between a message and a canonical document |
| [`registry/registry.schema.json`](registry/registry.schema.json) | The EDIFACT definition registry: segments, composites, data elements, code lists, message structures (JSON Schema 2020-12) | The registry generator writes it; the parser and the validator read it. See its [README](registry/README.md) |
| [`overrides/overrides.schema.json`](overrides/overrides.schema.json) | The rules a partner or a flow changes in a registry: element rules, mandatory positions, code-list changes, structure cardinalities, severities (JSON Schema 2020-12). See its [README](overrides/README.md) | The validator applies it on top of a registry; a service stores it per partner |

## Rules

- **Contract first.** Change the file, then the code. A pull request that changes a route or a
  payload changes the matching file in `contracts/`.
- **Compatible within a version.** Add optional properties and new job types freely. Removing
  or renaming a property, or making one required, needs a new job `version` (queue) or
  a new path or version (REST). Readers ignore properties they do not know.
- **No raw EDI in the queue.** Payloads are small. Raw and rendered files stay in the archive
  and are referenced by their SHA-256.
- **Examples live next to the schema**, with fictitious data only.
- **Checked by the CI** whenever `contracts/`, a package or a service changes:
  [`packages/contracts`](../packages/contracts) checks that the files are valid, that the
  examples pass and that broken variants fail; each service tests its own responses against
  the contract (see `services/api/src/contract.test.ts`). A service never imports another
  service's code. The registry schema is checked the same way by
  [`packages/registry`](../packages/registry), which will also hold the code that reads registries.

Each job type will get its own payload schema next to the envelope, in `jobs/`, when the
worker implements it.

## Generated code

Code is generated from the contracts, never the other way round, and committed in `generated`
folders (marked as generated for GitHub, left alone by Biome):

| Contract | TypeScript, in `packages/contracts/src/generated/` | Go, in `services/connectors/internal/generated/` |
| --- | --- | --- |
| [`openapi/api.yaml`](openapi/api.yaml) | `api.ts`: the schemas, as `Components["schemas"]` | `api/api.gen.go`: types and an HTTP client |
| [`jobs/job-envelope.schema.json`](jobs/job-envelope.schema.json) | `jobs.ts`: `JobEnvelope` | `jobs/jobs.gen.go`: `JobEnvelope`, which checks required properties, the enumeration and patterns when decoding |
| [`canonical/`](canonical/README.md) | `canonical-v1.ts`: one type per document | not needed yet |

- **Regenerate** after changing a contract. TypeScript: `pnpm --filter @libredi/contracts generate`.
  Go: `scripts/generate-go.sh` (it runs in the `golang` image when Go is not installed).
  Generators are pinned: [`json-schema-to-typescript`](https://github.com/bcherny/json-schema-to-typescript)
  in the pnpm catalog, [`oapi-codegen`](https://github.com/oapi-codegen/oapi-codegen) and
  [`go-jsonschema`](https://github.com/atombender/go-jsonschema) in
  [`tools/codegen/go.mod`](../tools/codegen/go.mod), whose `go.sum` makes the Go build reproducible.
- **Drift fails the CI.** The tests of `packages/contracts` regenerate the TypeScript in memory
  and compare it with the committed files; the Go job of the CI runs `scripts/generate-go.sh`
  and fails if `git status` shows a difference.
- **A break is caught twice.** A change of shape that is regenerated no longer compiles where the
  generated types are used (`services/connectors/internal/server` for Go, the typed examples in
  `contract-types.test.ts` for TypeScript), and the `api` service tests still check real responses
  against the schemas. Tests also change the contracts in memory and check that the generated
  types change with them.
- **Types for services.** A TypeScript service that wants the types adds `@libredi/contracts` to
  its dependencies and the matching `COPY` line to its Dockerfile; none does yet. A TypeScript
  client is not generated yet: `openapi-typescript` needs the TypeScript compiler API, which the
  native TypeScript 7 of this repository no longer ships.

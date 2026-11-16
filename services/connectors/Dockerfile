# syntax=docker/dockerfile:1
#
# connectors service (Go). Build from its own directory:
#   docker build --tag libredi/connectors services/connectors

FROM golang:1.27.3-alpine@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/connectors ./cmd/connectors

# No shell, no package manager: only the static binary and CA certificates.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:aafe993665bf6200db38a02c11a9351e782a84b6a45e7f33b6695638c88e3931
LABEL org.opencontainers.image.title="libredi-connectors" \
      org.opencontainers.image.description="Libredi connectors service" \
      org.opencontainers.image.source="https://github.com/imapanda/libredi" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV PORT=8080
COPY --from=build /out/connectors /connectors
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/connectors", "healthcheck"]
ENTRYPOINT ["/connectors"]

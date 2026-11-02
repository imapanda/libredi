# syntax=docker/dockerfile:1
#
# PostgreSQL with the pgmq job queue (https://github.com/pgmq/pgmq, PostgreSQL licence),
# installed from its SQL file so that it works on any PostgreSQL, with no extension to
# compile. The file runs once, when the data directory is first created.
#
# To upgrade pgmq: change the tag in the URL and the checksum (sha256sum of the file),
# and read https://github.com/pgmq/pgmq/blob/main/UPDATING.md. The unversioned SQL
# install only supports a fresh database, so an existing one needs the upgrade scripts.

FROM postgres:18.6-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5
LABEL org.opencontainers.image.title="libredi-postgres" \
      org.opencontainers.image.description="PostgreSQL with the pgmq job queue, for Libredi" \
      org.opencontainers.image.source="https://github.com/imapanda/libredi" \
      org.opencontainers.image.licenses="PostgreSQL"
ADD --checksum=sha256:e861fcbd8c602df70a00eb9d230b1a2f591860a2230b9a6084172e3eff463642 \
    --chmod=0644 \
    https://raw.githubusercontent.com/pgmq/pgmq/v1.13.1/pgmq-extension/sql/pgmq.sql \
    /docker-entrypoint-initdb.d/10-pgmq.sql

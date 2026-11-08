FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
WORKDIR /app
COPY electron/crash-schema.cjs electron/
COPY telemetry/crashes/server.cjs telemetry/crashes/
USER node
CMD ["node", "telemetry/crashes/server.cjs"]

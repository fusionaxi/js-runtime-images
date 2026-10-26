FROM fusionaxi/bun-node:slim
USER bun
COPY --chown=bun:bun package.json main.ts /app/
RUN bun run build
CMD ["node", "dist/main.js"]

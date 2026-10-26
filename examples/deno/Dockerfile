FROM fusionaxi/bun-deno:debian
USER bun
COPY --chown=bun:bun main.ts /app/main.ts
RUN bun main.ts
CMD ["deno", "run", "main.ts"]

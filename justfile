# Nalu development commands

# Start dev server
dev:
    bun run dev

# Production build
build:
    bun run build

# Run unit tests
test:
    bun run test

# Run unit tests in watch mode
test-watch:
    bun run test:watch

# Lint
lint:
    bun run lint

# Type check without emitting
typecheck:
    bunx tsc --noEmit

# Run all checks (lint + typecheck + test)
check: lint typecheck test

# Start production server
start:
    bun run start

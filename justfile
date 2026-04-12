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

# Format all files with Prettier
format:
    bun x prettier --write .

# Check formatting without writing
format-check:
    bun x prettier --check .

# Find unused exports, deps, files
deadcode:
    bun x knip

# Run all checks (format + lint + typecheck + test + deadcode).
# Matches CI; green locally means green on PR.
check: format-check lint typecheck test deadcode

# Start production server
start:
    bun run start

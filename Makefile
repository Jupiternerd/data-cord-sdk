# Works on macOS and Linux/WSL: needs bun and make.
.PHONY: install lint fmt test check

install:
	bun install

lint: ## lint + typecheck, no writes (CI)
	bunx biome check .
	bunx tsc -p .

fmt: ## apply formatting and safe lint fixes
	bunx biome check --write .

test:
	bun test

check: lint test

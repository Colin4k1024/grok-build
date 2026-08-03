.PHONY: tsp-bundle build check test

# Regenerate the TSP bundle from the sibling tsp/ repository.
# Run this after updating TSP content.
tsp-bundle:
	@echo "Generating TSP .grok-build/ output..."
	cd "$(shell cd .. && pwd)/tsp" && node scripts/grok/grok-packager.js
	@echo "Packing into tar.gz..."
	./scripts/pack-tsp-bundle.sh

build: tsp-bundle
	cargo build

check:
	cargo check --workspace

test:
	cargo test --workspace

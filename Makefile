.PHONY: install test test-engine test-web fmt dev dev-engine dev-web build wheel serve

install:
	cd engine && uv sync
	cd web && npm install

test: test-engine test-web

test-engine:
	cd engine && uv run ruff check . && uv run ruff format --check . && uv run pytest -q

test-web:
	cd web && npm run --silent typecheck && npm run --silent test

fmt:
	cd engine && uv run ruff format . && uv run ruff check --fix .

# Engine on :8787, Vite on :5173 (proxies /api). Open :5173.
dev:
	$(MAKE) -j2 dev-engine dev-web

dev-engine:
	cd engine && uv run diffusion serve --reload

dev-web:
	cd web && npm run dev

# Build the UI; `diffusion serve` then serves it on one port.
build:
	cd web && npm ci && npm run build
	rm -rf engine/src/diffusion/web && cp -r web/dist engine/src/diffusion/web

# A self-contained wheel (UI included): dist/diffusion_review-*.whl
wheel: build
	cd engine && uv build --wheel --out-dir ../dist

serve:
	cd engine && uv run diffusion serve

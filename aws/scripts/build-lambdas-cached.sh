#!/bin/bash
# Builds every aws/ Lambda package's dist/zip, using S3 as a build cache so a
# fresh CloudShell session (which starts with an empty /tmp every time it's
# reconnected -- see aws/infra README notes) doesn't have to rebuild all 13
# shared library packages + 8 Lambdas from source every time.
#
# Cache key: sha256 of each package's src/, package.json, package-lock.json,
# and tsconfig.json (when present), concatenated -- content-addressed, so a
# source change automatically invalidates the cache without any manual
# version bump. Cached artifacts live at
# s3://vibesdk-terraform-state/lambda-build-cache/<package>/<hash>.tar.gz
#
# Usage: run from anywhere; cd's into aws/ itself.
#   bash aws/scripts/build-lambdas-cached.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CACHE_BUCKET="vibesdk-terraform-state"
CACHE_PREFIX="lambda-build-cache"

LIBS="oauth-clients auth-crypto db-identity db-auth-flows db-audit db-apps db-analytics db-model-config model-config-defaults llm-client git-storage secrets-vault auth-orchestration rate-limit"
LAMBDAS="actor-spike auth-api-lambda apps-api-lambda user-api-lambda agent-runtime github-export-lambda browser-capture-lambda sandbox-orchestrator-lambda"

package_hash() {
	local pkg_dir="$1"
	local hash_inputs=()
	[ -d "$pkg_dir/src" ] && hash_inputs+=("$pkg_dir/src")
	[ -f "$pkg_dir/package.json" ] && hash_inputs+=("$pkg_dir/package.json")
	[ -f "$pkg_dir/package-lock.json" ] && hash_inputs+=("$pkg_dir/package-lock.json")
	[ -f "$pkg_dir/tsconfig.json" ] && hash_inputs+=("$pkg_dir/tsconfig.json")
	find "${hash_inputs[@]}" -type f 2>/dev/null | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1
}

# $1 = package dir, $2 = output artifact glob relative to package dir (what
# npm run build/package actually produces -- dist/ for libs, *.zip for lambdas)
try_restore_from_cache() {
	local pkg_dir="$1" name="$2" artifact="$3" hash
	hash="$(package_hash "$pkg_dir")"
	local cache_key="s3://$CACHE_BUCKET/$CACHE_PREFIX/$name/$hash.tar.gz"
	if aws s3 cp "$cache_key" /tmp/cache-restore.tar.gz >/dev/null 2>&1; then
		echo "=== $name: cache hit ($hash) ==="
		tar -xzf /tmp/cache-restore.tar.gz -C "$pkg_dir"
		rm -f /tmp/cache-restore.tar.gz
		return 0
	fi
	echo "=== $name: cache miss ($hash), building ==="
	return 1
}

save_to_cache() {
	local pkg_dir="$1" name="$2" artifact="$3" hash
	hash="$(package_hash "$pkg_dir")"
	local cache_key="s3://$CACHE_BUCKET/$CACHE_PREFIX/$name/$hash.tar.gz"
	tar -czf /tmp/cache-save.tar.gz -C "$pkg_dir" $artifact
	aws s3 cp /tmp/cache-save.tar.gz "$cache_key" >/dev/null 2>&1
	rm -f /tmp/cache-save.tar.gz
}

# CloudShell's default persistent storage is 1GB total, and each package's
# node_modules runs 100-130MB -- building all 21 packages without cleanup
# blows past that well before reaching the last few packages. node_modules
# is only needed transiently to run the package's own build/package script;
# lib dependents consume the lib via its dist/ output (referenced through
# the file: dependency's package directory, not its node_modules), and
# lambdas bundle everything into a self-contained zip via esbuild. So it's
# safe -- and necessary here -- to remove node_modules immediately after
# each package's build step.
for lib in $LIBS; do
	dir="$AWS_DIR/$lib"
	if try_restore_from_cache "$dir" "$lib" "dist"; then
		(cd "$dir" && npm install --no-audit --no-fund >/dev/null 2>&1)
	else
		(cd "$dir" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1)
		save_to_cache "$dir" "$lib" "dist"
	fi
	rm -rf "$dir/node_modules"
done

for lam in $LAMBDAS; do
	dir="$AWS_DIR/$lam"
	zip_name="$(basename "$lam").zip"
	if try_restore_from_cache "$dir" "$lam" "$zip_name"; then
		(cd "$dir" && npm install --no-audit --no-fund >/dev/null 2>&1)
	else
		(cd "$dir" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run package >/dev/null 2>&1)
		save_to_cache "$dir" "$lam" "$zip_name"
	fi
	rm -rf "$dir/node_modules"
done

echo "BUILD DONE (cached)"

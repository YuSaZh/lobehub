#!/usr/bin/env bash
set -euo pipefail

base_ref="${1:-upstream/main}"
patch_ref="${2:-origin/feature/model-capability-overrides}"
patch_file="${3:-patches/model-capability-overrides.patch}"
path_manifest="${4:-patches/model-capability-overrides.paths}"
control_manifest="${5:-.github/workflows/model-capability-overrides-control.paths}"

if ! git rev-parse --verify "$base_ref^{commit}" > /dev/null; then
  echo "Unable to resolve base ref: $base_ref" >&2
  exit 1
fi
if ! git rev-parse --verify "$patch_ref^{commit}" > /dev/null; then
  echo "Unable to resolve patch source ref: $patch_ref" >&2
  exit 1
fi
if [ ! -f "$path_manifest" ]; then
  echo "Unable to read patch path manifest: $path_manifest" >&2
  exit 1
fi
if [ ! -f "$control_manifest" ]; then
  echo "Unable to read control path manifest: $control_manifest" >&2
  exit 1
fi

mapfile -t patch_paths < <(
  sed -E '/^[[:space:]]*(#|$)/d' "$path_manifest"
)
if [ "${#patch_paths[@]}" -eq 0 ]; then
  echo "Patch path manifest is empty: $path_manifest" >&2
  exit 1
fi
mapfile -t control_paths < <(
  sed -E '/^[[:space:]]*(#|$)/d' "$control_manifest"
)

merge_base="$(git merge-base "$base_ref" "$patch_ref")"
mapfile -t changed_paths < <(git diff --name-only "$merge_base" "$patch_ref")
if [ "${#changed_paths[@]}" -eq 0 ]; then
  echo "Patch source has no changes relative to $base_ref merge-base" >&2
  exit 1
fi

declare -A allowed_path_set=()
for path in "${patch_paths[@]}"; do
  allowed_path_set["$path"]=1
done
for path in "${control_paths[@]}"; do
  allowed_path_set["$path"]=1
done
for path in "${changed_paths[@]}"; do
  if [ -z "${allowed_path_set[$path]+present}" ]; then
    echo "Patch source changed a non-allowlisted path: $path" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$patch_file")"
patch_file="$(cd "$(dirname "$patch_file")" && pwd -P)/$(basename "$patch_file")"
git diff --no-ext-diff --binary --full-index "$merge_base" "$patch_ref" -- \
  "${patch_paths[@]}" > "$patch_file"
if [ ! -s "$patch_file" ]; then
  echo "No model capability changes found in $patch_ref" >&2
  exit 1
fi

validation_dir="$(mktemp -d)"
cleanup() {
  git worktree remove --force "$validation_dir" > /dev/null 2>&1 || true
}
trap cleanup EXIT

git worktree add --detach "$validation_dir" "$base_ref" > /dev/null
git -C "$validation_dir" apply --check "$patch_file"
echo "Generated and validated $patch_file from $patch_ref against $base_ref"

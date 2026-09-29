#!/usr/bin/env bash
#
# Set the app version everywhere it is written down.
#
# It lives in seven places: package.json, the two version fields of
# package-lock.json, tauri.conf.json's version and Android versionCode,
# Cargo.toml and Cargo.lock. Only four were once checked, so a bump could
# leave the versionCode behind and Play would reject the upload after the
# build had already run. The lockfile was not written at all, so its two
# fields sat at 0.0.23-alpha through two bumps until npm rewrote them. This
# writes all seven from one argument.
#
# The changelog is deliberately not written here: an entry is a sentence about
# what changed, which nothing can generate. `version.test.ts` fails until one
# exists, which is the point of it.

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
    echo "usage: $0 <version>    e.g. $0 0.1.0-alpha" >&2
    exit 1
fi

# Optional pre-release suffix, so 0.1.0-alpha and 0.1.0 are both accepted.
if [[ ! "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "error: '$VERSION' is not major.minor.patch with an optional -suffix" >&2
    exit 1
fi
MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"

# Android requires a monotonically increasing integer, and Play refuses an
# upload that repeats or lowers one. The 1000 offset keeps this scheme above
# the codes already published under the old hand-written numbering.
# Monotonic while minor and patch stay below 100.
if (( MINOR > 99 || PATCH > 99 )); then
    echo "error: minor and patch must stay below 100 for the versionCode scheme" >&2
    exit 1
fi
VERSION_CODE=$(( 1000 + MAJOR * 10000 + MINOR * 100 + PATCH ))

cd "$(dirname "$0")/.."

node - "$VERSION" "$VERSION_CODE" <<'NODE'
const fs = require('node:fs');
const [version, versionCode] = process.argv.slice(2);

function edit(file, fn) {
    const before = fs.readFileSync(file, 'utf8');
    const after = fn(before);
    if (before === after) throw new Error(`${file}: nothing matched, refusing a silent no-op`);
    fs.writeFileSync(file, after);
    console.log(`  ${file}`);
}

edit('package.json', (s) => s.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`));
// npm writes the version into the lockfile twice: at its root, and on the
// entry for the package itself. Only those two, since every dependency's entry
// has a "version" of its own. Edited in place rather than through
// `npm install --package-lock-only`, which goes to the registry and may
// rewrite more of the lockfile than these two fields. Both are checked
// afterwards: one found without the other would otherwise pass as an edit.
edit('package-lock.json', (s) => {
    const after = s
        .replace(/^( {2}"version":\s*)"[^"]*"/m, `$1"${version}"`)
        .replace(/("":\s*\{[^{}]*?"version":\s*)"[^"]*"/, `$1"${version}"`);
    const lock = JSON.parse(after);
    if (lock.version !== version || lock.packages?.['']?.version !== version) {
        throw new Error('package-lock.json: did not find both of its version fields');
    }
    return after;
});
edit('src-tauri/tauri.conf.json', (s) =>
    s
        .replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`)
        .replace(/^(\s*"versionCode":\s*)\d+/m, `$1${versionCode}`),
);
edit('src-tauri/Cargo.toml', (s) => s.replace(/^version = "[^"]*"/m, `version = "${version}"`));
NODE

echo "Refreshing Cargo.lock..."
cargo update --manifest-path src-tauri/Cargo.toml --package oyot --quiet 2>/dev/null \
    || cargo check --manifest-path src-tauri/Cargo.toml --quiet

cat <<EOF

Set to $VERSION (Android versionCode $VERSION_CODE).

Still to do by hand:
  1. Add an entry at the top of src/lib/changelog.ts. \`npm test\` fails
     until you do, which is how you are reminded.
  2. Commit, then \`make release-tag VERSION=$VERSION\`.
EOF

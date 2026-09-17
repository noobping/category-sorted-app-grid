set shell := ["bash", "-c"]

default: check

[parallel]
check: check-just check-whitespace check-metadata check-extension

check-just:
    #!/usr/bin/env bash
    set -euo pipefail
    just={{ quote(just_executable()) }}
    "$just" --fmt --check

check-whitespace:
    #!/usr/bin/env bash
    set -euo pipefail
    git diff --check
    git diff --cached --check
    git log -1 --check --format=

check-metadata:
    #!/usr/bin/env bash
    set -euo pipefail
    if perl -MJSON::PP -e 1 >/dev/null 2>&1; then
        perl -MJSON::PP=decode_json -0777 -e '
            my $metadata = decode_json(<>);
            die "metadata.json: uuid is invalid\n"
                unless ($metadata->{uuid} // "") eq "category-sorted-app-grid\@noobping.dev";
            die "metadata.json: name is required\n"
                unless length($metadata->{name} // "");
            die "metadata.json: description is required\n"
                unless length($metadata->{description} // "");
            die "metadata.json: url is invalid\n"
                unless ($metadata->{url} // "") eq "https://github.com/noobping/category-sorted-app-grid";
            die "metadata.json: version must be a positive integer\n"
                unless ($metadata->{version} // 0) =~ /^\d+$/ && $metadata->{version} > 0;
            die "metadata.json: shell-version must contain numeric versions\n"
                unless ref($metadata->{"shell-version"}) eq "ARRAY"
                    && @{$metadata->{"shell-version"}}
                    && !grep { !/^\d+$/ } @{$metadata->{"shell-version"}};
            die "metadata.json: shell-version must include 51\n"
                unless grep { $_ eq "51" } @{$metadata->{"shell-version"}};
        ' metadata.json
    elif command -v python3 >/dev/null 2>&1; then
        python3 - <<'PY'
    import json
    from pathlib import Path

    metadata = json.loads(Path("metadata.json").read_text())
    assert metadata.get("uuid") == "category-sorted-app-grid@noobping.dev"
    assert metadata.get("name")
    assert metadata.get("description")
    assert metadata.get("url") == "https://github.com/noobping/category-sorted-app-grid"
    assert isinstance(metadata.get("version"), int) and metadata["version"] > 0
    versions = metadata.get("shell-version")
    assert isinstance(versions, list) and versions
    assert all(isinstance(version, str) and version.isdigit() for version in versions)
    assert "51" in versions
    PY
    else
        echo 'checking metadata requires JSON::PP or python3' >&2
        exit 1
    fi

check-extension:
    #!/usr/bin/env bash
    set -euo pipefail
    test -s extension.js
    grep -Fq 'export default class CategorySortedAppGridExtension extends Extension' extension.js
    grep -Eq '^[[:space:]]+enable\(\)[[:space:]]*\{' extension.js
    grep -Eq '^[[:space:]]+disable\(\)[[:space:]]*\{' extension.js
    if command -v node >/dev/null 2>&1; then
        node --check --input-type=module < extension.js
    else
        echo 'node not found; completed structural extension checks'
    fi

build: check package

package:
    #!/usr/bin/env bash
    set -euo pipefail
    artifact='dist/category-sorted-app-grid@noobping.dev.shell-extension.zip'
    files=(*.js metadata.json LICENSE)
    archive_args=()

    for file in "${files[@]}"; do
        test -s "$file"
        archive_args+=(--add-file="$file")
    done

    empty_tree="$(git hash-object -t tree /dev/null)"
    mkdir -p dist
    rm -f -- "$artifact"
    git archive \
        --format=zip \
        --output="$artifact" \
        "${archive_args[@]}" \
        "$empty_tree"
    test -s "$artifact"
    printf 'Created %s\n' "$artifact"

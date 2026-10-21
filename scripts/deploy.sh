#!/usr/bin/env bash
# Deploy the site to https://nfpmap.bdaic.ai (S3 bucket nfpmap.bdaic.ai behind CloudFront E307ZY8JYGD9DF).
#
#   scripts/deploy.sh            # code from this working tree + data from s3://nfp-food-insecurity-map-data/current/
#   scripts/deploy.sh --dry-run  # list what would be uploaded; change nothing
#
# Push to main first so git matches production. Needs AWS credentials that can write the site bucket and
# create a CloudFront invalidation (see OPERATIONS.md §2.2).
set -euo pipefail
cd "$(dirname "$0")/.."

BUCKET=nfpmap.bdaic.ai
DISTRIBUTION=E307ZY8JYGD9DF
DATA=s3://nfp-food-insecurity-map-data/current/
DRY=${1:-}
export AWS_REGION=us-east-1 AWS_PAGER=""

if [ -n "$(git status --porcelain -- index.html Map.html About.html map.js styles.css assets)" ]; then
  echo "warning: uncommitted changes in site files will be deployed" >&2
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/assets" "$STAGE/data"
cp index.html Map.html About.html map.js styles.css "$STAGE/"
cp assets/bdaic-logo.png assets/nfp-logo.png "$STAGE/assets/"
cp data/last_updated.txt "$STAGE/data/"
# The served data is the pipeline's published output, not whatever is in local data/.
aws s3 sync "$DATA" "$STAGE/data/" --exclude "*.parquet" --only-show-errors

upload() {  # file key content-type cache-control
  if [ "$DRY" = "--dry-run" ]; then printf '  would upload %-34s %s\n' "$2" "$3"; return; fi
  aws s3 cp "$1" "s3://$BUCKET/$2" --only-show-errors --content-type "$3" --cache-control "$4"
}
for f in index.html Map.html About.html; do upload "$STAGE/$f" "$f" "text/html; charset=utf-8" "no-cache"; done
upload "$STAGE/map.js" map.js "application/javascript; charset=utf-8" "no-cache"
upload "$STAGE/styles.css" styles.css "text/css; charset=utf-8" "no-cache"
for f in "$STAGE"/assets/*.png; do upload "$f" "assets/$(basename "$f")" image/png "public, max-age=86400"; done
for f in "$STAGE"/data/*; do
  case "$f" in
    *.geojson) ct="application/geo+json" ;;
    *.json)    ct="application/json" ;;
    *.csv)     ct="text/csv; charset=utf-8" ;;
    *.txt)     ct="text/plain; charset=utf-8" ;;
    *)         continue ;;
  esac
  upload "$f" "data/$(basename "$f")" "$ct" "public, max-age=3600"
done

if [ "$DRY" = "--dry-run" ]; then echo "dry run: nothing uploaded"; exit 0; fi
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" --paths "/*" \
  --query 'Invalidation.Id' --output text | sed 's/^/invalidation /'
echo "Deployed. Live at https://nfpmap.bdaic.ai within a few minutes."

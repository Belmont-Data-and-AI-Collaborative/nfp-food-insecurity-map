# Operations Guide

Practical reference for deploying, running, and handing off the NFP Food Insecurity Map. If you just want to hack on the code locally, [README.md](README.md) is enough. This document covers what's behind the deploy: S3 buckets, CloudFront, IAM, and the out-of-band pipeline.

For architectural context and invariants, see [CLAUDE.md](CLAUDE.md). For design decisions (crosswalk math, geocoding semantics), see [ASSUMPTIONS.md](ASSUMPTIONS.md).

---

## 1. What runs where

| Piece | Where it lives | Who/what runs it |
|---|---|---|
| Static site (HTML/JS/Leaflet) | S3 bucket `nfpmap.bdaic.ai` (private) behind CloudFront `E307ZY8JYGD9DF` | Served at https://tnfpmap.bdaic.ai; uploaded by `scripts/deploy.sh` |
| Built data files (geojson/csv/parquet) | `s3://nfp-food-insecurity-map-data/current/` | `scripts/deploy.sh` copies the served ones (csv/geojson/json) into the site bucket |
| Raw source data (Census ACS, CDC PLACES, USDA LILA, partner CSVs) | `s3://bdaic-public-transform/nfp-mapping/...` | Read by the Python pipeline |
| Python data pipeline | Any machine with AWS creds — laptop, scheduled job, or EC2 | Invoked manually via `python -m pipeline`. Writes locally to `data/`, then the operator uploads to the output bucket |
| Geocoding (partners only) | OpenStreetMap Nominatim (public API, no key) | Called from `pipeline/process_partners.py` during a pipeline run |

There is **no runtime backend**: CloudFront serves only the static HTML/JS and the pre-built `data/` files. The Python pipeline runs out of band; a deploy only copies its published output.

**Production URL:** https://tnfpmap.bdaic.ai (moved from Vercel, `nfp-food-insecurity-map-ecru.vercel.app`, on 2026-10-21; first published as `nfpmap.bdaic.ai`, which now redirects)

---

## 2. AWS setup

### 2.1 Buckets

| Bucket | Purpose | Access pattern |
|---|---|---|
| `bdaic-public-transform` | **SOURCE** — raw inputs shared with other Belmont data projects. Under the `nfp-mapping/` prefix: partner CSVs, geocode caches. Census/PLACES/LILA live at their own prefixes (see `s3_prefix:` entries in [project.yml](project.yml)). | Pipeline reads. Do NOT delete or rename. |
| `nfp-food-insecurity-map-data` | **OUTPUT** — dedicated to this project. Published files live under `current/`. | Pipeline writes; `scripts/deploy.sh` reads. |
| `nfpmap.bdaic.ai` | **SITE** — what CloudFront serves. Private (public access blocked); only CloudFront `E307ZY8JYGD9DF` can read it (origin access control). Versioned, encrypted. | `scripts/deploy.sh` writes. |

The `current/` prefix exists so peer prefixes can be added without disrupting the live deploy:
- `archive/<YYYY-MM-DD>/` — optional point-in-time snapshots before a pipeline rerun (none created yet).
- `staging/` — optional pre-production copy to test a new build before promoting.
- `logs/` — reserved in case S3 access logs are enabled later.

### 2.2 IAM — two separate credential sets

The project involves two distinct "who is doing what" roles. **Do not share keys between them.**

**a) Pipeline operator credentials**
Used when a human (or scheduled job) runs `python -m pipeline` and then uploads the output. Requires:
- `s3:GetObject` and `s3:ListBucket` on `bdaic-public-transform` (source reads)
- `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on `nfp-food-insecurity-map-data` (output writes)

Today these are the operator's own IAM user keys in `~/.aws/credentials`. If a scheduled job takes over, create a dedicated IAM user for it.

**b) Deploy credentials**
Used by `scripts/deploy.sh`. Needs `s3:GetObject`/`s3:ListBucket` on `nfp-food-insecurity-map-data/current/`, `s3:PutObject` on `nfpmap.bdaic.ai`, `cloudfront:CreateInvalidation` on distribution `E307ZY8JYGD9DF`, and `ssm:GetParameter` (with decryption) on `/nfpmap/carto-basemap-key`. Today that's a BDAIC admin's own credentials; no long-lived key is stored anywhere for deploys.

**Retired 2026-10-21:** the Vercel build user `nfp-map-vercel-reader` (its key was deactivated 2026-09-29) and its Vercel env vars, along with Vercel itself.

---

## 3. Hosting (AWS)

| Piece | Value |
|---|---|
| URL | https://tnfpmap.bdaic.ai |
| Redirect | `nfpmap.bdaic.ai` → 301 → `tnfpmap.bdaic.ai` (same path and query), done by CloudFront Function `nfpmap-redirect` on viewer-request |
| CloudFront | `E307ZY8JYGD9DF` (`d1jwmo9cga6oc3.cloudfront.net`): HTTPS only (HTTP redirects), HTTP/2+3, compression, `Managed-CachingOptimized`, `Managed-SecurityHeadersPolicy`; unknown paths return the home page with status 404 |
| Certificate | ACM `tnfpmap.bdaic.ai` + `nfpmap.bdaic.ai` (us-east-1), DNS-validated in Route 53, renews automatically |
| DNS | Route 53 A + AAAA aliases for both names → the distribution |
| Site bucket | `nfpmap.bdaic.ai` (keeps the first name; it's internal), readable only by the distribution |
| Tags | `Project=nashville_food_project__food_insecurity_mapping_tool`, `Owner`, `Environment=prod`, `Client=tnfp` |

### 3.1 What gets served

`scripts/deploy.sh` stages exactly what the site loads: the three pages, `map.js`, `styles.css`, the two logos, `data/last_updated.txt` from the repo, and the csv/geojson/json files from `s3://nfp-food-insecurity-map-data/current/` (parquet files are pipeline-only and are not uploaded). It also inserts the CARTO basemap key (SSM SecureString `/nfpmap/carto-basemap-key`, requested 2026-10-21 under data@belmont.edu) into the staged `map.js`: CARTO watermarks keyless tiles, and keeping the key out of git honours CARTO's "don't share your key" term. A local preview has no key and shows the watermark. Each file gets an explicit content type; pages, JS and CSS are `no-cache`, data is cached for an hour, logos for a day.

### 3.2 Deploying

Deploys are **intentionally manual**: nothing deploys on push. Commit and push to `main` first so git and production stay aligned.

```bash
git push origin main
scripts/deploy.sh --dry-run    # list what would be uploaded
scripts/deploy.sh              # upload + CloudFront invalidation; live within a few minutes
```

The site's code comes from your working tree, and its data always comes from the bucket's `current/` prefix, so a code-only deploy can't accidentally ship unpublished local data.

**Data change only (pipeline rerun):**
```bash
python -m pipeline
aws s3 sync data/ s3://nfp-food-insecurity-map-data/current/ --exclude "mock/*"
scripts/deploy.sh
```

---

## 4. Running the pipeline

### 4.1 Local, against real S3

```bash
source .venv/bin/activate
cp .env.example .env
# Edit .env:
#   USE_MOCK_DATA=false
#   AWS_ACCESS_KEY_ID=<pipeline operator creds>
#   AWS_SECRET_ACCESS_KEY=<pipeline operator creds>
#   AWS_BUCKET_NAME=bdaic-public-transform   # source bucket

python -m pipeline
```

The pipeline writes to `data/*.parquet`, `data/*.geojson`, `data/*.csv`, and `data/config.json`. See [CLAUDE.md](CLAUDE.md) for the data contract.

### 4.2 Uploading results to the output bucket

After the pipeline succeeds:
```bash
aws s3 sync data/ s3://nfp-food-insecurity-map-data/current/ --exclude "mock/*"
```

Then run `scripts/deploy.sh` (§3.2).

### 4.3 Local-only (mock mode)

`USE_MOCK_DATA=true` reads from `data/mock/*.csv` (regenerated via `scripts/generate_mock_data.py` + `scripts/generate_mock_parquet.py`). Useful for UI work without AWS access.

---

## 5. Runbook

### 5.1 "The site is showing old data"

1. Check when the pipeline was last run — look at the modified-timestamp of any file in `s3://nfp-food-insecurity-map-data/current/` with `aws s3 ls`.
2. If the S3 files are fresh but the site shows old data: the site bucket wasn't redeployed. Run `scripts/deploy.sh` (it also clears CloudFront's cache).
3. If the S3 files are stale: rerun the pipeline (§4.1), upload (§4.2), redeploy.

### 5.2 "The deploy script fails"

1. **`AccessDenied` on the data bucket or the site bucket:** your credentials lack the permissions in §2.2 (b).
2. **`AccessDenied` on `CreateInvalidation`:** the upload succeeded but the cache wasn't cleared; the site updates once cached copies expire (up to an hour for data), or rerun with the right credentials.
3. **Site shows XML "AccessDenied" instead of a page:** the bucket policy no longer names the distribution. It must allow `cloudfront.amazonaws.com` `s3:GetObject` on `nfpmap.bdaic.ai/*` with `AWS:SourceArn` = distribution `E307ZY8JYGD9DF`.

### 5.3 "A partner is missing from the map"

The partner was probably dropped by the geocoder — Nominatim couldn't resolve the address, so the pipeline sets lat/lon to NaN and skips the feature during GeoJSON writing. Check the pipeline logs for `Geocoding failed for ...`. Fix the source CSV (clean up the address) and rerun.

### 5.4 "I need to add a new indicator"

Follow the "Adding a new data layer" section in [README.md](README.md). Do **not** edit `map.js` constants — they're regenerated from `project.yml`.

### 5.5 "I accidentally deleted files from the S3 output bucket"

Versioning is enabled on `nfp-food-insecurity-map-data` (as of 2026-04-23), so deleted objects leave a delete marker behind the previous version. To restore:

```bash
# List versions for a specific key
aws s3api list-object-versions --bucket nfp-food-insecurity-map-data --prefix current/config.json

# Remove the delete marker (bringing the prior version back as current)
aws s3api delete-object --bucket nfp-food-insecurity-map-data --key current/config.json --version-id <DELETE_MARKER_VERSION_ID>
```

For broader restores, the simplest path is re-running the pipeline and re-uploading — the data is fully reproducible.

---

## 6. Known gaps (pick up when convenient)

None of these block production, but they are the load-bearing items the next operator should know about:

1. **Pipeline can exit 0 with partial output.** `process_data_source()` returns `None` on source-load failure ([pipeline/load_source.py:322-324](pipeline/load_source.py)) and the caller ([pipeline/__main__.py:90-96](pipeline/__main__.py)) does not check. In practice this means: if one source's S3 read fails, the overall pipeline logs the error but continues, and the step's parquet may be missing (and a stale one could get re-uploaded). Mitigation: always scan the pipeline's stderr after a full run, or add an output-validation pass that fails the step if `len(df) == 0`.

2. **No CI.** There is no `.github/workflows/`. Tests exist (`pytest tests/ -v`) but nobody runs them automatically. Adding a PR-level workflow that runs pytest + lint is ~30 minutes of work.

3. **Pipeline is manual.** Out-of-band operator runs. A scheduled GitHub Action (weekly?) that does `python -m pipeline && aws s3 sync ...` would close the loop. README "Next steps" lists this already.

**Resolved** (2026-10-21):
- Hosting moved from Vercel to S3 + CloudFront at https://nfpmap.bdaic.ai. That retires the unpinned `npm install` build and `sync-data.mjs`'s partial-download risk (both gaps were Vercel-build only).

**Resolved** (2026-04-23):
- Vercel build used a dedicated least-privilege IAM user (`nfp-map-vercel-reader`) instead of the operator's admin keys (retired with Vercel on 2026-10-21).
- S3 versioning is enabled on `nfp-food-insecurity-map-data` — accidental `rm` is now recoverable via delete-marker cleanup (see §5.5).

---

## 7. Onboarding checklist for a new engineer

- [ ] Clone the repo, read [README.md](README.md) + [CLAUDE.md](CLAUDE.md) + this doc.
- [ ] Get AWS credentials (ask current owner): pipeline-operator access to both data buckets, plus deploy access (§2.2 b) if you'll ship changes.
- [ ] Run the pipeline once in mock mode (`USE_MOCK_DATA=true`) to verify local setup.
- [ ] Run the pipeline once against real S3 to verify AWS creds work end-to-end.
- [ ] Run `scripts/deploy.sh --dry-run` to verify read access to the published data.
- [ ] Read through `pipeline/__main__.py` and one source module (e.g. `pipeline/process_census_acs.py`) to understand the step pattern.
- [ ] Read `map.js` top-to-bottom once — it's ~1k lines and is the single frontend file.

#!/usr/bin/env bash
# Runs automatically inside the LocalStack container on startup (LocalStack's
# /etc/localstack/init/ready.d/ hook). Creates the same bucket + table shapes
# the real deployment scripts create against AWS — this file mirrors them for
# local testing only and is not used by, or a substitute for, the real infra
# scripts in scripts/.
set -euo pipefail

REGION="ap-south-1"
BUCKET="mediavault-local-media"
PROJ='["title","mediaType","sizeBytes","durationSec","status","createdAt"]'

echo "[local-init] creating S3 bucket: $BUCKET"
awslocal s3api create-bucket \
  --bucket "$BUCKET" \
  --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION" \
  || echo "[local-init] bucket already exists, continuing"

awslocal s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 300
  }]
}'

echo "[local-init] creating DynamoDB tables"

awslocal dynamodb create-table \
  --region "$REGION" \
  --table-name mediavault-local-items \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
      AttributeName=mediaId,AttributeType=S \
      AttributeName=gsi1pk,AttributeType=S \
      AttributeName=gsi1sk,AttributeType=S \
      AttributeName=gsi2pk,AttributeType=S \
      AttributeName=gsi2sk,AttributeType=S \
  --key-schema AttributeName=mediaId,KeyType=HASH \
  --global-secondary-indexes "[
    {\"IndexName\":\"gsi1-feed\",
     \"KeySchema\":[{\"AttributeName\":\"gsi1pk\",\"KeyType\":\"HASH\"},
                    {\"AttributeName\":\"gsi1sk\",\"KeyType\":\"RANGE\"}],
     \"Projection\":{\"ProjectionType\":\"INCLUDE\",\"NonKeyAttributes\":$PROJ}},
    {\"IndexName\":\"gsi2-type\",
     \"KeySchema\":[{\"AttributeName\":\"gsi2pk\",\"KeyType\":\"HASH\"},
                    {\"AttributeName\":\"gsi2sk\",\"KeyType\":\"RANGE\"}],
     \"Projection\":{\"ProjectionType\":\"INCLUDE\",\"NonKeyAttributes\":$PROJ}}
  ]" \
  || echo "[local-init] items table already exists, continuing"

awslocal dynamodb create-table \
  --region "$REGION" \
  --table-name mediavault-local-uploads \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=uploadId,AttributeType=S \
  --key-schema AttributeName=uploadId,KeyType=HASH \
  || echo "[local-init] uploads table already exists, continuing"

awslocal dynamodb create-table \
  --region "$REGION" \
  --table-name mediavault-local-audit \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
      AttributeName=entityId,AttributeType=S \
      AttributeName=eventAt,AttributeType=S \
  --key-schema \
      AttributeName=entityId,KeyType=HASH \
      AttributeName=eventAt,KeyType=RANGE \
  || echo "[local-init] audit table already exists, continuing"

# TTL: LocalStack accepts the call; note in the community edition items are
# NOT actively expired in the background the way real DynamoDB does it. That's
# fine for local testing — it just means abandoned tickets won't vanish on
# their own here the way they would in AWS.
awslocal dynamodb update-time-to-live --region "$REGION" \
  --table-name mediavault-local-uploads \
  --time-to-live-specification "Enabled=true,AttributeName=expiresAt" || true

awslocal dynamodb update-time-to-live --region "$REGION" \
  --table-name mediavault-local-audit \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" || true

echo "[local-init] done"

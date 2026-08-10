resource "aws_dynamodb_table" "items" {
  name         = "yayyy-mediavault-items"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "mediaId"

  attribute {
    name = "mediaId"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }
  attribute {
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  global_secondary_index {
    name               = "gsi1-feed"
    hash_key           = "gsi1pk"
    range_key          = "gsi1sk"
    projection_type    = "INCLUDE"
    non_key_attributes = ["title", "mediaType", "sizeBytes", "durationSec", "status", "createdAt"]
  }

  global_secondary_index {
    name               = "gsi2-type"
    hash_key           = "gsi2pk"
    range_key          = "gsi2sk"
    projection_type    = "INCLUDE"
    non_key_attributes = ["title", "mediaType", "sizeBytes", "durationSec", "status", "createdAt"]
  }
}

resource "aws_dynamodb_table" "audit" {
  name         = "yayyy-mediavault-audit"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "entityId"
  range_key    = "eventAt"

  attribute {
    name = "entityId"
    type = "S"
  }

  attribute {
    name = "eventAt"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}


resource "aws_dynamodb_table" "uploads" {
  name         = "yayyy-mediavault-uploads"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "uploadId"

  attribute {
    name = "uploadId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

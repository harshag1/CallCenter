-- Author: Harsha Gundala
-- 007_s3.sql — documents.s3_key for S3-stored raw bytes (bytea in documents.data remains the fallback).

ALTER TABLE documents ADD COLUMN IF NOT EXISTS s3_key text;

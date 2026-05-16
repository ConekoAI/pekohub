#!/usr/bin/env bash
# AWS Infrastructure Setup Script for PekoHub
# Run this once to create ECR repos, ECS cluster, and Secrets Manager entries
# Requires: AWS CLI configured with appropriate credentials

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "=== PekoHub AWS Infrastructure Setup ==="
echo "Region: $AWS_REGION"
echo "Account: $AWS_ACCOUNT_ID"
echo ""

# ── ECR Repositories ──────────────────────────────────────────
echo "Creating ECR repositories..."
aws ecr create-repository --repository-name pekohub-backend --region "$AWS_REGION" 2>/dev/null || echo "Backend repo already exists"
aws ecr create-repository --repository-name pekohub-frontend --region "$AWS_REGION" 2>/dev/null || echo "Frontend repo already exists"

# ── ECS Cluster ───────────────────────────────────────────────
echo "Creating ECS cluster..."
aws ecs create-cluster --cluster-name pekohub --region "$AWS_REGION" 2>/dev/null || echo "Cluster already exists"

# ── CloudWatch Log Groups ─────────────────────────────────────
echo "Creating CloudWatch log groups..."
aws logs create-log-group --log-group-name /ecs/pekohub-backend --region "$AWS_REGION" 2>/dev/null || true
aws logs create-log-group --log-group-name /ecs/pekohub-frontend --region "$AWS_REGION" 2>/dev/null || true

# ── Secrets Manager (placeholder secrets) ─────────────────────
echo "Creating Secrets Manager entries..."
# These are placeholders — update them with real values via AWS Console or CLI

for secret in database-url s3-endpoint s3-access-key s3-secret-key meilisearch-url meilisearch-api-key jwt-secret github-client-id github-client-secret google-client-id google-client-secret registry-base-url; do
  aws secretsmanager create-secret \
    --name "pekohub/$secret" \
    --secret-string "REPLACE_ME" \
    --region "$AWS_REGION" 2>/dev/null || echo "Secret pekohub/$secret already exists"
done

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Update secrets in AWS Secrets Manager with real values:"
echo "   aws secretsmanager put-secret-value --secret-id pekohub/database-url --secret-string 'postgres://...'"
echo ""
echo "2. Create ECS task definitions:"
echo "   sed 's/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/g; s/AWS_REGION/$AWS_REGION/g' infra/aws/ecs-task-definition-backend.json | aws ecs register-task-definition --cli-input-json file:///dev/stdin"
echo "   sed 's/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/g; s/AWS_REGION/$AWS_REGION/g' infra/aws/ecs-task-definition-frontend.json | aws ecs register-task-definition --cli-input-json file:///dev/stdin"
echo ""
echo "3. Create ECS services with ALB (use AWS Console or Terraform)"
echo ""
echo "4. Update GitHub repository secrets for Actions deployment"

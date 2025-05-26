#!/bin/bash
set -e

# Serverless Image Processing deployment script
echo "================================================================="
echo "Serverless Image Processing - Deployment Script"
echo "================================================================="

# Check for AWS CLI
if ! command -v aws &> /dev/null; then
  echo "AWS CLI is not installed. Please install it first."
  exit 1
fi

# Check for CDK
# No CDK required for this deployment

# Set up variables
SOLUTION_NAME="serverless-image-processing"
SOURCE_DIR="../source"
VERSION=$(cat ../VERSION.txt 2>/dev/null || echo "1.0.0")
CONFIG_FILE="./config.env"

# Load configuration if available
if [ -f "$CONFIG_FILE" ]; then
  echo "Loading configuration from $CONFIG_FILE..."
  source "$CONFIG_FILE"
else
  echo "Warning: Configuration file $CONFIG_FILE not found. Using defaults."
fi

# Process command-line options
DEPLOY=false

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --deploy) DEPLOY=true ;;
    --region) REGION="$2"; shift ;;
    --profile) PROFILE="$2"; shift ;;
    --help) 
      echo "Usage: $0 [options]"
      echo "Options:"
      echo "  --deploy            Deploy the stack to AWS"
      echo "  --region REGION     AWS region to deploy to"
      echo "  --profile PROFILE   AWS CLI profile to use"
      echo "  --help              Show this help message"
      exit 0
      ;;
    *) echo "Unknown parameter: $1"; exit 1 ;;
  esac
  shift
done

# Set region and profile options if provided
CDK_OPTIONS=""
if [ ! -z "$REGION" ]; then
  CDK_OPTIONS="$CDK_OPTIONS --region $REGION"
fi
if [ ! -z "$PROFILE" ]; then
  CDK_OPTIONS="$CDK_OPTIONS --profile $PROFILE"
fi

echo "Building and deploying $SOLUTION_NAME version $VERSION"

# Install dependencies
echo "Installing dependencies..."
npm --prefix "$SOURCE_DIR" install || { echo "Failed to install source dependencies"; exit 1; }

# Build the project
echo "Building the project..."
npm --prefix "$SOURCE_DIR" run build || { echo "Failed to build source code"; exit 1; }

# Create the Sharp layer if it doesn't exist
echo "Checking for Sharp layer..."
REGION=${REGION:-$(aws configure get region)}
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

LAYER_NAME="sharp"
LAYER_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:layer:${LAYER_NAME}:1"

if ! aws lambda get-layer-version --layer-name $LAYER_NAME --version-number 1 $CDK_OPTIONS >/dev/null 2>&1; then
  echo "Creating Sharp lambda layer..."
  mkdir -p /tmp/lambda-layer/nodejs
  
  # Create package.json for Sharp
  cat > /tmp/lambda-layer/nodejs/package.json <<EOF
{
  "name": "sharp-layer",
  "version": "1.0.0",
  "description": "Sharp image processing library for Lambda",
  "dependencies": {
    "sharp": "^0.32.0"
  }
}
EOF
  
  # Install Sharp with binary for Lambda environment
  cd /tmp/lambda-layer/nodejs
  npm install --platform=linux --arch=arm64 --target=18

  # Create zip file
  cd /tmp/lambda-layer
  zip -r /tmp/sharp-layer.zip .
  
  # Publish layer
  aws lambda publish-layer-version \
    --layer-name $LAYER_NAME \
    --description "Sharp image processing library" \
    --license-info "Apache-2.0" \
    --compatible-runtimes nodejs18.x \
    --zip-file fileb:///tmp/sharp-layer.zip \
    --compatible-architectures "arm64" \
    $CDK_OPTIONS
  
  echo "Sharp layer created!"
  cd -
else
  echo "Sharp layer already exists"
fi

# Check for needed resources
echo "Checking AWS resources..."

if [ "$DEPLOY" = true ]; then
  echo "Deploying resources..."
  
  # Generate random IDs for resources
  RANDOM_SUFFIX=$(cat /dev/urandom | tr -dc 'a-z0-9' | fold -w 8 | head -n 1)
  SOURCE_BUCKET="image-source-${RANDOM_SUFFIX}"
  PROCESSED_BUCKET="image-processed-${RANDOM_SUFFIX}"
  FUNCTION_NAME="image-handler-function"
  ROLE_NAME="image-processor-role-${RANDOM_SUFFIX}"
  
  # Create S3 buckets
  echo "Creating S3 buckets..."
  aws s3api create-bucket --bucket $SOURCE_BUCKET --region ${REGION:-us-east-1} $CDK_OPTIONS
  aws s3api create-bucket --bucket $PROCESSED_BUCKET --region ${REGION:-us-east-1} $CDK_OPTIONS
  
  # Create IAM role for Lambda
  echo "Creating IAM role for Lambda..."
  aws iam create-role --role-name $ROLE_NAME --assume-role-policy-document '{"Version": "2012-10-17","Statement": [{"Effect": "Allow","Principal": {"Service": "lambda.amazonaws.com"},"Action": "sts:AssumeRole"}]}' $CDK_OPTIONS
  
  # Attach policies to role
  aws iam attach-role-policy --role-name $ROLE_NAME --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole $CDK_OPTIONS
  aws iam attach-role-policy --role-name $ROLE_NAME --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess $CDK_OPTIONS
  
  if [ "${ENABLE_DYNAMODB:-true}" = "true" ]; then
    aws iam attach-role-policy --role-name $ROLE_NAME --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess $CDK_OPTIONS
  fi
  
  # Create zip package for Lambda
  echo "Creating Lambda deployment package..."
  mkdir -p /tmp/lambda-package
  cp -r $SOURCE_DIR/image-handler/* /tmp/lambda-package/
  cd /tmp/lambda-package
  npm install --production
  zip -r /tmp/lambda-function.zip *
  
  # Wait for role to propagate
  echo "Waiting for IAM role to propagate..."
  sleep 10
  
  # Create Lambda function
  echo "Creating Lambda function..."
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
  
  aws lambda create-function \
    --function-name $FUNCTION_NAME \
    --zip-file fileb:///tmp/lambda-function.zip \
    --handler index.handler \
    --runtime nodejs18.x \
    --role $ROLE_ARN \
    --timeout ${TIMEOUT:-30} \
    --memory-size ${MEMORY_SIZE:-1024} \
    --environment "Variables={SOURCE_BUCKETS=$SOURCE_BUCKET,OUTPUT_BUCKET=$PROCESSED_BUCKET,ENABLE_CORS=${ENABLE_CORS:-true},CORS_ORIGIN=${CORS_ORIGIN:-'*'}}" \
    $CDK_OPTIONS
  
  # Set up S3 event trigger
  echo "Setting up S3 event trigger..."
  aws lambda add-permission \
    --function-name $FUNCTION_NAME \
    --statement-id s3-trigger \
    --action lambda:InvokeFunction \
    --principal s3.amazonaws.com \
    --source-arn arn:aws:s3:::$SOURCE_BUCKET \
    $CDK_OPTIONS
    
  aws s3api put-bucket-notification-configuration \
    --bucket $SOURCE_BUCKET \
    --notification-configuration "{\"LambdaFunctionConfigurations\":[{\"LambdaFunctionArn\":\"arn:aws:lambda:${REGION:-us-east-1}:$ACCOUNT_ID:function:$FUNCTION_NAME\",\"Events\":[\"s3:ObjectCreated:*\"],\"Filter\":{\"Key\":{\"FilterRules\":[{\"Name\":\"prefix\",\"Value\":\"uploads/\"}]}}}]}" \
    $CDK_OPTIONS
  
  # Create DynamoDB table if enabled
  if [ "${ENABLE_DYNAMODB:-true}" = "true" ]; then
    echo "Creating DynamoDB table..."
    aws dynamodb create-table \
      --table-name ImageMetadata \
      --attribute-definitions AttributeName=imageId,AttributeType=S \
      --key-schema AttributeName=imageId,KeyType=HASH \
      --billing-mode PAY_PER_REQUEST \
      $CDK_OPTIONS
  fi
  
  # Create API Gateway if enabled
  if [ "${ENABLE_API_GATEWAY:-true}" = "true" ]; then
    echo "Creating API Gateway..."
    API_ID=$(aws apigateway create-rest-api --name "Image-Processor-API" --query 'id' --output text $CDK_OPTIONS)
    RESOURCE_ID=$(aws apigateway get-resources --rest-api-id $API_ID --query 'items[0].id' --output text $CDK_OPTIONS)
    
    # Create API resources and methods
    echo "Configuring API Gateway..."
    # Create /image resource
    IMAGE_RESOURCE=$(aws apigateway create-resource --rest-api-id $API_ID --parent-id $RESOURCE_ID --path-part "image" --query 'id' --output text $CDK_OPTIONS)
    aws apigateway put-method --rest-api-id $API_ID --resource-id $IMAGE_RESOURCE --http-method GET --authorization-type NONE $CDK_OPTIONS
    
    # Create Lambda integration
    aws apigateway put-integration --rest-api-id $API_ID --resource-id $IMAGE_RESOURCE --http-method GET --type AWS_PROXY --integration-http-method POST --uri arn:aws:apigateway:${REGION:-us-east-1}:lambda:path/2015-03-31/functions/arn:aws:lambda:${REGION:-us-east-1}:$ACCOUNT_ID:function:$FUNCTION_NAME/invocations $CDK_OPTIONS
    
    # Deploy API
    aws apigateway create-deployment --rest-api-id $API_ID --stage-name prod $CDK_OPTIONS
  fi
  
  echo "Deployment completed successfully!"
  echo ""
  echo "Resources created:"
  echo "- Source S3 Bucket: $SOURCE_BUCKET"
  echo "- Processed Images S3 Bucket: $PROCESSED_BUCKET"
  echo "- Lambda Function: $FUNCTION_NAME"
  if [ "${ENABLE_DYNAMODB:-true}" = "true" ]; then
    echo "- DynamoDB Table: ImageMetadata"
  fi
  if [ "${ENABLE_API_GATEWAY:-true}" = "true" ]; then
    echo "- API Gateway Endpoint: https://$API_ID.execute-api.${REGION:-us-east-1}.amazonaws.com/prod/image"
  fi
  
  echo ""
  echo "Next steps:"
  echo "1. Upload images to the 'uploads/' folder in the source bucket"
  echo "2. Access processed images in the processed bucket"
  echo "3. If you enabled the API Gateway, use the API endpoint to trigger image processing"
else
  echo ""
  echo "Stack is ready for deployment. Use --deploy to deploy it."
  echo "For a list of all options, use --help."
fi

echo ""
echo "================================================================="
echo "Deployment script completed"
echo "================================================================="
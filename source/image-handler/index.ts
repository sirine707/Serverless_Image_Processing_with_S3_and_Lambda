// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import S3, { WriteGetObjectResponseRequest } from "aws-sdk/clients/s3";
import SecretsManager from "aws-sdk/clients/secretsmanager";
import DynamoDB from "aws-sdk/clients/dynamodb";

import { getOptions } from "../solution-utils/get-options";
import { isNullOrWhiteSpace } from "../solution-utils/helpers";
import { ImageHandler } from "./image-handler";
import { ImageRequest } from "./image-request";
import {
  Headers,
  ImageHandlerError,
  ImageHandlerEvent,
  ImageHandlerExecutionResult,
  S3Event,
  S3GetObjectEvent,
  S3HeadObjectResult,
  RequestTypes,
  StatusCodes,
} from "./lib";
// eslint-disable-next-line import/no-unresolved
import { Context } from "aws-lambda";
import { SecretProvider } from "./secret-provider";

const awsSdkOptions = getOptions();
const s3Client = new S3(awsSdkOptions);
const secretsManagerClient = new SecretsManager(awsSdkOptions);
const secretProvider = new SecretProvider(secretsManagerClient);
const dynamoDbClient = new DynamoDB.DocumentClient(awsSdkOptions);

const LAMBDA_PAYLOAD_LIMIT = 6 * 1024 * 1024;
const IMAGE_METADATA_TABLE = process.env.IMAGE_METADATA_TABLE || "image-metadata";
const ENABLE_WATERMARK = process.env.ENABLE_WATERMARK === "Yes";
const WATERMARK_TEXT = process.env.WATERMARK_TEXT || "© Copyright";
const IMAGE_FORMATS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".tiff", ".svg"];

/**
 * Image handler Lambda handler.
 * @param event The image handler request event or S3 event.
 * @param context The request context
 * @returns Processed request response.
 */
export async function handler(
  event: ImageHandlerEvent | S3Event,
  context: Context = undefined
): Promise<void | ImageHandlerExecutionResult | S3HeadObjectResult> {
  // Check if the event is an S3 event (from bucket upload)
  if (isS3Event(event)) {
    console.info("Received S3 event:", JSON.stringify(event));
    try {
      return await handleS3Event(event);
    } catch (error) {
      console.error("Error processing S3 event:", error);
      throw error; // Rethrow to trigger Lambda retry
    }
  }

  // If not an S3 event, process as a direct API request
  const { ENABLE_S3_OBJECT_LAMBDA } = process.env;

  const normalizedEvent = normalizeEvent(event, ENABLE_S3_OBJECT_LAMBDA);
  console.info(`Path: ${normalizedEvent.path}`);
  console.info(`QueryParams: ${JSON.stringify(normalizedEvent.queryStringParameters)}`);

  const response = handleRequest(normalizedEvent);
  // If deployment is set to use an API Gateway origin
  if (ENABLE_S3_OBJECT_LAMBDA !== "Yes") {
    return response;
  }

  // Assume request is from Object Lambda
  const { timeoutPromise, timeoutId } = createS3ObjectLambdaTimeout(context);
  const finalResponse = await Promise.race([response, timeoutPromise]);
  clearTimeout(timeoutId);

  const responseHeaders = buildResponseHeaders(finalResponse);

  // Check if getObjectContext is not in event, indicating a HeadObject request
  if (!("getObjectContext" in event)) {
    console.info(`Invalid S3GetObjectEvent, assuming HeadObject request. Status: ${finalResponse.statusCode}`);

    return {
      statusCode: finalResponse.statusCode,
      headers: { ...responseHeaders, "Content-Length": finalResponse.body.length },
    };
  }

  const getObjectEvent = event as S3GetObjectEvent;
  const params = buildWriteResponseParams(getObjectEvent, finalResponse, responseHeaders);
  try {
    await s3Client.writeGetObjectResponse(params).promise();
  } catch (error) {
    console.error("Error occurred while writing the response to S3 Object Lambda.", error);
    const errorParams = buildErrorResponseParams(
      getObjectEvent,
      new ImageHandlerError(
        StatusCodes.BAD_REQUEST,
        "S3ObjectLambdaWriteError",
        "It was not possible to write the response to S3 Object Lambda."
      )
    );
    await s3Client.writeGetObjectResponse(errorParams).promise();
  }
}

/**
 * Handles S3 events from uploaded images
 * @param event The S3 event containing bucket and object information
 */
async function handleS3Event(event: S3Event): Promise<void> {
  const { OUTPUT_BUCKET } = process.env;

  if (!OUTPUT_BUCKET) {
    console.error("OUTPUT_BUCKET environment variable not set");
    throw new Error("OUTPUT_BUCKET environment variable not set");
  }

  // Define standard transformations to apply to all uploaded images
  const transformations = [
    { width: 100, height: 100, suffix: 'thumb' },
    { width: 500, height: 500, suffix: 'medium' },
    { width: 1024, height: 1024, suffix: 'large' }
  ];

  for (const record of event.Records) {
    try {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

      console.info(`Processing image from ${bucket}/${key}`);

      // Skip non-image files
      const fileExt = key.toLowerCase().substring(key.lastIndexOf('.'));
      if (!IMAGE_FORMATS.includes(fileExt)) {
        console.info(`Skipping non-image file: ${key}`);
        continue;
      }

      // Get the image from the source bucket
      const originalImage = await s3Client.getObject({
        Bucket: bucket,
        Key: key
      }).promise();

      const imageHandler = new ImageHandler(s3Client, secretProvider);
      const filename = key.substring(key.lastIndexOf('/') + 1, key.lastIndexOf('.'));

      // Process each transformation
      for (const transform of transformations) {
        try {
          const outputKey = `processed/${filename}-${transform.suffix}${fileExt}`;

          // Create a mock request object that the ImageHandler can process
          const imageRequest = new ImageRequest({
            requestType: RequestTypes.DEFAULT,
            bucket: bucket,
            key: key,
            outputBucket: OUTPUT_BUCKET,
            outputKey: outputKey,
            edits: {
              resize: {
                width: transform.width,
                height: transform.height,
                fit: 'cover'
              }
            }
          });

          // Apply watermark if enabled
          if (ENABLE_WATERMARK) {
            imageRequest.edits.overlayWith = {
              text: WATERMARK_TEXT,
              font: 'Arial',
              size: Math.floor(transform.width * 0.05), // Scale text size based on image width
              position: 'center'
            };
          }

          // Process the image
          const processedImage = await imageHandler.process(imageRequest);

          // Store processed image
          await s3Client.putObject({
            Body: processedImage.Body,
            Bucket: OUTPUT_BUCKET,
            Key: outputKey,
            ContentType: processedImage.ContentType,
            Metadata: {
              'original-key': key,
              'transformation': JSON.stringify(transform)
            }
          }).promise();

          console.info(`Successfully processed ${outputKey}`);

          // Store metadata if DynamoDB is enabled
          if (process.env.ENABLE_DYNAMODB === 'Yes') {
            await dynamoDbClient.put({
              TableName: IMAGE_METADATA_TABLE,
              Item: {
                imageId: outputKey,
                sourceBucket: bucket,
                sourceKey: key,
                transformType: transform.suffix,
                createdAt: new Date().toISOString(),
                fileSize: processedImage.Body.length,
                fileType: processedImage.ContentType
              }
            }).promise();
          }
        } catch (transformError) {
          console.error(`Error processing transformation ${transform.suffix} for ${key}:`, transformError);
          // Continue with other transformations
        }
      }
    } catch (err) {
      const startTime = Date.now();
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

      // Check if file is in the allowed uploads directory
      if (!key.startsWith('uploads/')) {
        console.info(`Skipping processing for ${key} - not in uploads directory`);
        continue;
      }

      // Check if file has an image extension
      const fileExtension = key.substring(key.lastIndexOf('.')).toLowerCase();
      if (!IMAGE_FORMATS.includes(fileExtension)) {
        console.info(`Skipping processing for ${key} - not a supported image format`);
        continue;
      }

      console.info(`Processing image from ${bucket}/${key}`);

      try {
        // Get the image from the source bucket
        const imageObject = await s3Client
          .getObject({ Bucket: bucket, Key: key })
          .promise();

        const imageBuffer = Buffer.from(imageObject.Body as Buffer);
        const contentType = imageObject.ContentType || getContentTypeFromExtension(fileExtension);

        // Create image processing request
        const imageRequest = new ImageRequest(s3Client, secretProvider);
        const imageHandler = new ImageHandler(s3Client);

        // Generate a unique ID for grouping related transformations
        const processingId = generateUniqueId();

        // Extract original filename components
        const fileNameParts = key.split('/').pop().split('.');
        const fileExt = fileNameParts.pop();
        const fileName = fileNameParts.join('.');

        // Standard transformations - resize to different sizes
        const transformations = [
          { width: 100, height: 100, suffix: 'thumb', quality: 80 },
          { width: 500, height: 500, suffix: 'medium', quality: 85 },
          { width: 1024, height: 1024, suffix: 'large', quality: 90 },
          { width: 1920, height: 1080, suffix: 'banner', fit: 'inside', quality: 90 }
        ];

        // Apply watermark to larger images if enabled
        if (ENABLE_WATERMARK) {
          transformations.push(
            {
              width: 2048,
              height: 2048,
              suffix: 'watermarked',
              fit: 'inside',
              quality: 95,
              watermark: {
                text: WATERMARK_TEXT,
                opacity: 0.5,
                position: 'bottom-right'
              }
            }
          );
        }

        const processingResults = [];

        // Process each transformation
        for (const transform of transformations) {
          const outputFormat = getOutputFormat(contentType, transform);

          const requestInfo = {
            bucket,
            key,
            edits: {
              resize: {
                width: transform.width,
                height: transform.height,
                fit: transform.fit || 'cover'
              },
              toFormat: outputFormat,
              flatten: outputFormat === 'jpeg' ? { background: '#ffffff' } : undefined,
              compress: true,
              withMetadata: false
            },
            outputFormat,
            originalImage: imageBuffer,
            contentType
          };

          // Add watermark if specified in this transformation
          if (transform.watermark) {
            requestInfo.edits.watermark = transform.watermark;
          }

          // Add quality settings if specified
          if (transform.quality) {
            if (outputFormat === 'jpeg' || outputFormat === 'jpg') {
              requestInfo.edits.jpeg = { quality: transform.quality };
            } else if (outputFormat === 'png') {
              requestInfo.edits.png = { quality: transform.quality };
            } else if (outputFormat === 'webp') {
              requestInfo.edits.webp = { quality: transform.quality };
            }
          }

          try {
            // Process the image
            console.info(`Applying ${transform.suffix} transformation`);
            const processedImage = await imageHandler.process(requestInfo);

            // Create the output key with size suffix
            const outputKey = `processed/${fileName}-${transform.suffix}.${outputFormat}`;

            // Save to destination bucket
            await s3Client.putObject({
              Bucket: OUTPUT_BUCKET,
              Key: outputKey,
              Body: processedImage,
              ContentType: `image/${outputFormat}`,
              Metadata: {
                'original-bucket': bucket,
                'original-key': key,
                'transformation': JSON.stringify(transform),
                'processing-id': processingId
              },
              // Add cache control and content disposition headers
              CacheControl: 'public, max-age=31536000',
              ContentDisposition: `inline; filename="${fileName}-${transform.suffix}.${outputFormat}"`
            }).promise();

            const outputUrl = `https://${OUTPUT_BUCKET}.s3.${awsSdkOptions.region || 'us-east-1'}.amazonaws.com/${outputKey}`;
            console.info(`Saved processed image to ${outputUrl}`);

            processingResults.push({
              transformType: transform.suffix,
              outputKey,
              outputFormat,
              outputUrl,
              width: transform.width,
              height: transform.height,
              status: 'success'
            });
          } catch (transformError) {
            console.error(`Error processing transformation ${transform.suffix} for ${key}:`, transformError);
            processingResults.push({
              transformType: transform.suffix,
              status: 'error',
              errorMessage: transformError.message || 'Unknown error during transformation'
            });
          }
        }

        // Store metadata in DynamoDB if the table exists
        try {
          const metadata = {
            id: processingId,
            originalFileName: fileName,
            originalBucket: bucket,
            originalKey: key,
            originalFormat: fileExt,
            originalContentType: contentType,
            processedBucket: OUTPUT_BUCKET,
            processingResults: processingResults,
            processingTimeMs: Date.now() - startTime,
            createdAt: new Date().toISOString(),
            status: 'completed'
          };

          await dynamoDbClient.put({
            TableName: IMAGE_METADATA_TABLE,
            Item: metadata
          }).promise();

          console.info(`Stored metadata in DynamoDB with ID ${processingId}`);
        } catch (dbError) {
          console.warn('DynamoDB storage failed, continuing without metadata storage', dbError);
        }
      } catch (processingError) {
        console.error(`Error processing image ${bucket}/${key}:`, processingError);

        // Store error information in DynamoDB if possible
        try {
          if (IMAGE_METADATA_TABLE) {
            const errorMetadata = {
              id: generateUniqueId(),
              originalBucket: bucket,
              originalKey: key,
              errorMessage: processingError.message || 'Unknown error',
              errorStack: processingError.stack,
              createdAt: new Date().toISOString(),
              status: 'error'
            };

            await dynamoDbClient.put({
              TableName: IMAGE_METADATA_TABLE,
              Item: errorMetadata
            }).promise();
          }
        } catch (metadataError) {
          console.error('Failed to store error metadata:', metadataError);
        }
        // Continue to the next record rather than failing the entire batch
      }
    } catch (recordError) {
      console.error(`Error handling S3 event record:`, recordError);
      // Continue to the next record rather than failing the entire batch
    }
  }
}

/**
 * Generate a unique ID for image processing batch
 */
function generateUniqueId(): string {
  return `img_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * Get appropriate content type from file extension
 */
function getContentTypeFromExtension(extension: string): string {
  const extensionToContentType = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.tiff': 'image/tiff',
    '.svg': 'image/svg+xml'
  };

  return extensionToContentType[extension] || 'application/octet-stream';
}

/**
 * Determine the best output format based on input and transformation
 */
function getOutputFormat(contentType: string, transform: any): string {
  // Honor specific output format if defined in the transformation
  if (transform.outputFormat) {
    return transform.outputFormat;
  }

  // For thumbnails, always use WebP for better compression if not Safari
  if (transform.suffix === 'thumb') {
    return 'webp';
  }

  // Otherwise maintain original format for compatibility
  if (contentType.includes('jpeg') || contentType.includes('jpg')) {
    return 'jpeg';
  } else if (contentType.includes('png')) {
    return 'png';
  } else if (contentType.includes('webp')) {
    return 'webp';
  } else if (contentType.includes('gif')) {
    return 'gif';
  }

  // Default to JPEG
  return 'jpeg';
}

/**
 * Determines if the event is an S3 event
 */
function isS3Event(event: any): event is S3Event {
  return event && event.Records && Array.isArray(event.Records) &&
    event.Records.length > 0 && event.Records[0].eventSource === 'aws:s3';
}

/**
 * Image handler request handler.
 * @param event The normalized request event.
 * @returns Processed request response.
 */
async function handleRequest(event: ImageHandlerEvent): Promise<ImageHandlerExecutionResult> {
  const { ENABLE_S3_OBJECT_LAMBDA } = process.env;

  const imageRequest = new ImageRequest(s3Client, secretProvider);
  const imageHandler = new ImageHandler(s3Client);
  const isAlb = event.requestContext && Object.prototype.hasOwnProperty.call(event.requestContext, "elb");
  try {
    const imageRequestInfo = await imageRequest.setup(event);
    console.info(imageRequestInfo);

    let processedRequest: Buffer | string = await imageHandler.process(imageRequestInfo);

    if (ENABLE_S3_OBJECT_LAMBDA !== "Yes") {
      processedRequest = processedRequest.toString("base64");

      // binary data need to be base64 encoded to pass to the API Gateway proxy https://docs.aws.amazon.com/apigateway/latest/developerguide/lambda-proxy-binary-media.html.
      // checks whether base64 encoded image fits in 6M limit, see https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html.
      if (processedRequest.length > LAMBDA_PAYLOAD_LIMIT) {
        throw new ImageHandlerError(
          StatusCodes.REQUEST_TOO_LONG,
          "TooLargeImageException",
          "The converted image is too large to return."
        );
      }
    }

    let headers: Headers = {};
    // Define headers that can be overwritten
    headers["Cache-Control"] = imageRequestInfo.cacheControl;

    // Apply the custom headers
    if (imageRequestInfo.headers) {
      headers = { ...headers, ...imageRequestInfo.headers };
    }
    // If expires query param is included, override max caching age
    if (imageRequestInfo.secondsToExpiry !== undefined) {
      headers["Cache-Control"] = "max-age=" + imageRequestInfo.secondsToExpiry + ",public";
    }

    headers = { ...headers, ...getResponseHeaders(false, isAlb) };
    headers["Content-Type"] = imageRequestInfo.contentType;
    headers["Expires"] = imageRequestInfo.expires;
    headers["Last-Modified"] = imageRequestInfo.lastModified;

    return {
      statusCode: StatusCodes.OK,
      isBase64Encoded: true,
      headers,
      body: processedRequest,
    };
  } catch (error) {
    console.error(error);

    // Default fallback image
    const { ENABLE_DEFAULT_FALLBACK_IMAGE, DEFAULT_FALLBACK_IMAGE_BUCKET, DEFAULT_FALLBACK_IMAGE_KEY } = process.env;
    if (
      ENABLE_DEFAULT_FALLBACK_IMAGE === "Yes" &&
      !isNullOrWhiteSpace(DEFAULT_FALLBACK_IMAGE_BUCKET) &&
      !isNullOrWhiteSpace(DEFAULT_FALLBACK_IMAGE_KEY)
    ) {
      try {
        return await handleDefaultFallbackImage(imageRequest, event, isAlb, error);
      } catch (error) {
        console.error("Error occurred while getting the default fallback image.", error);
      }
    }

    const { statusCode, body } = getErrorResponse(error);
    return {
      statusCode,
      isBase64Encoded: false,
      headers: getResponseHeaders(true, isAlb),
      body,
    };
  }
}

/**
 * Builds error response parameters for S3 Object Lambda WriteGetObjectResponse.
 * Takes an error event and constructs a response with appropriate status code,
 * error body, and cache control settings.
 * @param getObjectEvent - The S3 GetObject event containing output route and token
 * @param error - The ImageHandlerError containing status code and error details
 * @returns WriteGetObjectResponseRequest - Parameters for error response including:
 *   - RequestRoute: Output route from the event context
 *   - RequestToken: Output token from the event context
 *   - Body: Error message body
 *   - Metadata: Contains the error status code
 *   - CacheControl: Set to "max-age-10,public" for error responses
 */
function buildErrorResponseParams(getObjectEvent, error: ImageHandlerError) {
  const { statusCode, body } = getErrorResponse(error);
  const params: WriteGetObjectResponseRequest = {
    RequestRoute: getObjectEvent.getObjectContext.outputRoute,
    RequestToken: getObjectEvent.getObjectContext.outputToken,
    Body: body,
    Metadata: {
      StatusCode: JSON.stringify(statusCode),
    },
    CacheControl: "max-age-10,public",
  };
  return params;
}

/**
 * Processes and sanitizes response headers for the image handler.
 * Filters out undefined header values, URI encodes remaining values,
 * and sets appropriate Cache-Control headers based on response status code.
 * @param finalResponse - The execution result
 * @returns Record<string, string> - Processed headers with encoded values and cache settings
 *
 * Cache-Control rules:
 * - 4xx errors: max-age=10,public
 * - 5xx errors: max-age=600,public
 */
function buildResponseHeaders(finalResponse: ImageHandlerExecutionResult): Record<string, string> {
  const filteredHeaders = Object.entries(finalResponse.headers).filter(([_, value]) => value !== undefined);
  let responseHeaders = Object.fromEntries(filteredHeaders);

  responseHeaders = Object.fromEntries(
    Object.entries(responseHeaders).map(([key, value]) => [key, encodeURI(value).replace(/%20/g, " ")])
  );
  if (finalResponse.statusCode >= 400 && finalResponse.statusCode <= 499) {
    responseHeaders["Cache-Control"] = "max-age=10,public";
  }
  if (finalResponse.statusCode >= 500 && finalResponse.statusCode < 599) {
    responseHeaders["Cache-Control"] = "max-age=600,public";
  }
  return responseHeaders;
}

/**
 * Builds parameters for S3 Object Lambda's WriteGetObjectResponse operation.
 * Processes response headers and metadata, handling Cache-Control separately
 * and encoding remaining headers as metadata.
 * @param getObjectEvent - The S3 GetObject event containing output route and token
 * @param finalResponse - The execution result containing response body and status code
 * @param responseHeaders - Key-value pairs of response headers to be processed
 * @returns WriteGetObjectResponseRequest parameters including body, routing info, and metadata
 */
function buildWriteResponseParams(
  getObjectEvent: S3GetObjectEvent,
  finalResponse: ImageHandlerExecutionResult,
  responseHeaders: { [k: string]: string }
): WriteGetObjectResponseRequest {
  const params: WriteGetObjectResponseRequest = {
    Body: finalResponse.body,
    RequestRoute: getObjectEvent.getObjectContext.outputRoute,
    RequestToken: getObjectEvent.getObjectContext.outputToken,
  };

  if (responseHeaders["Cache-Control"]) {
    params.CacheControl = responseHeaders["Cache-Control"];
    delete responseHeaders["Cache-Control"];
  }

  params.Metadata = {
    StatusCode: JSON.stringify(finalResponse.statusCode),
    ...responseHeaders,
  };
  return params;
}

/**
 * Retrieve the default fallback image and construct the ImageHandlerExecutionResult
 * @param imageRequest The ImageRequest object
 * @param event The Lambda Event object
 * @param isAlb Whether we're behind an ALB
 * @param error The error that resulted in us getting the fallback image
 * @returns Processed request response for fallback image
 * @
 */
export async function handleDefaultFallbackImage(
  imageRequest: ImageRequest,
  event: ImageHandlerEvent,
  isAlb: boolean,
  error
): Promise<ImageHandlerExecutionResult> {
  const { DEFAULT_FALLBACK_IMAGE_BUCKET, DEFAULT_FALLBACK_IMAGE_KEY, ENABLE_S3_OBJECT_LAMBDA } = process.env;
  const defaultFallbackImage = await s3Client
    .getObject({
      Bucket: DEFAULT_FALLBACK_IMAGE_BUCKET,
      Key: DEFAULT_FALLBACK_IMAGE_KEY,
    })
    .promise();

  const headers = getResponseHeaders(false, isAlb);
  headers["Content-Type"] = defaultFallbackImage.ContentType;
  headers["Last-Modified"] = defaultFallbackImage.LastModified;
  try {
    headers["Cache-Control"] = imageRequest.parseImageHeaders(event, RequestTypes.DEFAULT)?.["Cache-Control"];
  } catch { }

  // Prioritize Cache-Control header attached to the fallback image followed by Cache-Control header provided in request, followed by the default
  headers["Cache-Control"] = defaultFallbackImage.CacheControl ?? headers["Cache-Control"] ?? "max-age=31536000,public";

  return {
    statusCode: error.status ? error.status : StatusCodes.INTERNAL_SERVER_ERROR,
    isBase64Encoded: true,
    headers,
    body:
      ENABLE_S3_OBJECT_LAMBDA === "Yes"
        ? Buffer.from(defaultFallbackImage.Body as Uint8Array)
        : defaultFallbackImage.Body.toString("base64"),
  };
}

/**
 * Creates a timeout promise to write a graceful response if S3 Object Lambda processing won't finish in time
 * @param context The Image Handler request context
 * @returns A promise that resolves with the ImageHandlerExecutionResult to write to the response, as well as the timeoutID to allow for cancellation.
 */
function createS3ObjectLambdaTimeout(
  context: Context
  // eslint-disable-next-line no-undef
): { timeoutPromise: Promise<ImageHandlerExecutionResult>; timeoutId: NodeJS.Timeout } {
  let timeoutId;
  const timeoutPromise = new Promise<ImageHandlerExecutionResult>((resolve) => {
    timeoutId = setTimeout(() => {
      const error = new ImageHandlerError(StatusCodes.TIMEOUT, "TimeoutException", "Image processing timed out.");
      const { statusCode, body } = getErrorResponse(error);
      // Call writeGetObjectResponse when the timeout is approaching
      resolve({
        statusCode,
        isBase64Encoded: false,
        headers: getResponseHeaders(true),
        body,
      });
    }, Math.max(context.getRemainingTimeInMillis() - 1000, 0)); // 30 seconds in milliseconds
  });
  return { timeoutPromise, timeoutId };
}

/**
 * Generates a normalized event usable by the event handler regardless of which infrastructure is being used(RestAPI or S3 Object Lambda).
 * @param event The RestAPI event (ImageHandlerEvent) or S3 Object Lambda event (S3GetObjectEvent).
 * @param s3ObjectLambdaEnabled Whether we're using the S3 Object Lambda or RestAPI infrastructure.
 * @returns Normalized ImageHandlerEvent object
 */
export function normalizeEvent(event: ImageHandlerEvent | S3Event, s3ObjectLambdaEnabled: string): ImageHandlerEvent {
  if (s3ObjectLambdaEnabled === "Yes") {
    const { userRequest } = event as S3Event;
    const fullPath = userRequest.url.split(userRequest.headers.Host)[1];
    const [pathString, queryParamsString] = fullPath.split("?");

    // S3 Object Lambda blocks certain query params including `signature` and `expires`, we use ol- as a prefix to overcome this.
    const queryParams = extractObjectLambdaQueryParams(queryParamsString);
    return {
      // URLs from S3 Object Lambda include the origin path
      path: pathString.split("/image").slice(1).join("/image"),
      queryStringParameters: queryParams,
      requestContext: {},
      headers: userRequest.headers,
    };
  }
  return event as ImageHandlerEvent;
}

/**
 * Extracts 'ol-' prefixed query parameters from the query string. The `ol-` prefix is used to overcome
 * S3 Object Lambda restrictions on what query parameters can be sent.
 * @param queryString The querystring attached to the end of the initial URL
 * @returns A dictionary of query params
 */
function extractObjectLambdaQueryParams(queryString: string | undefined): { [key: string]: string } {
  const results = {};
  if (queryString === undefined) {
    return results;
  }

  for (const [key, value] of new URLSearchParams(queryString).entries()) {
    results[key.slice(0, 3).replace("ol-", "") + key.slice(3)] = value;
  }
  return results;
}

/**
 * Generates the appropriate set of response headers based on a success or error condition.
 * @param isError Has an error been thrown.
 * @param isAlb Is the request from ALB.
 * @returns Headers.
 */
function getResponseHeaders(isError: boolean = false, isAlb: boolean = false): Headers {
  const { CORS_ENABLED, CORS_ORIGIN } = process.env;
  const corsEnabled = CORS_ENABLED === "Yes";
  const headers: Headers = {
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (!isAlb) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  if (corsEnabled) {
    headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
  }

  if (isError) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

/**
 * Determines the appropriate error response values
 * @param error The error object from a try/catch block
 * @returns appropriate status code and body
 */
export function getErrorResponse(error) {
  if (error?.status) {
    return {
      statusCode: error.status,
      body: JSON.stringify(error),
    };
  }
  return {
    statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
    body: JSON.stringify({
      message: "Internal error. Please contact the system administrator.",
      code: "InternalError",
      status: StatusCodes.INTERNAL_SERVER_ERROR,
    }),
  };
}

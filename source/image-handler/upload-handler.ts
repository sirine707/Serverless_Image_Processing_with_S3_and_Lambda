// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import S3 from 'aws-sdk/clients/s3';
import { getOptions } from '../solution-utils/get-options';
import { APIGatewayEvent, APIGatewayProxyResult } from 'aws-lambda';
import * as crypto from 'crypto';
import * as path from 'path';

// Initialize S3 client with AWS SDK options
const awsSdkOptions = getOptions();
const s3Client = new S3(awsSdkOptions);

// Constants for configuration
const SOURCE_BUCKET = process.env.SOURCE_BUCKET || '';
const UPLOAD_PREFIX = process.env.UPLOAD_PREFIX || 'uploads/';
const MAX_ALLOWED_SIZE = parseInt(process.env.MAX_ALLOWED_SIZE || '10485760', 10); // 10MB default
const ALLOWED_FORMATS = (process.env.ALLOWED_FORMATS || '.jpg,.jpeg,.png,.gif,.webp,.tiff,.svg').split(',');

/**
 * Lambda handler for processing direct image uploads via API Gateway
 * @param event The API Gateway event
 * @returns API Gateway proxy response
 */
export async function handler(event: APIGatewayEvent): Promise<APIGatewayProxyResult> {
    try {
        // Validate environment variables
        if (!SOURCE_BUCKET) {
            return errorResponse(500, 'Internal server error: Source bucket not configured');
        }

        // Check if multipart/form-data content type
        const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
        if (!contentType.includes('multipart/form-data')) {
            return errorResponse(400, 'Invalid content type. Only multipart/form-data is supported');
        }

        // Parse multipart form data to extract file
        const { fileBuffer, fileName, fileSize, fileType } = parseMultipartFormData(event);

        // Validate file
        if (!fileBuffer || !fileName) {
            return errorResponse(400, 'No file found in request');
        }

        if (fileSize > MAX_ALLOWED_SIZE) {
            return errorResponse(400, `File size exceeds maximum allowed size of ${MAX_ALLOWED_SIZE / 1024 / 1024}MB`);
        }

        // Validate file extension
        const fileExt = path.extname(fileName).toLowerCase();
        if (!ALLOWED_FORMATS.includes(fileExt)) {
            return errorResponse(400, `Unsupported file type. Allowed formats: ${ALLOWED_FORMATS.join(', ')}`);
        }

        // Generate a unique filename to prevent overwriting
        const uniqueFileName = generateUniqueFileName(fileName);
        const key = `${UPLOAD_PREFIX}${uniqueFileName}`;

        // Upload to S3
        await s3Client.putObject({
            Bucket: SOURCE_BUCKET,
            Key: key,
            Body: fileBuffer,
            ContentType: fileType,
            Metadata: {
                'original-filename': fileName,
                'upload-date': new Date().toISOString()
            }
        }).promise();

        // Return success response with the uploaded file information
        return {
            statusCode: 200,
            headers: getCorsHeaders(),
            body: JSON.stringify({
                success: true,
                message: 'File uploaded successfully',
                data: {
                    fileName: uniqueFileName,
                    originalName: fileName,
                    fileSize,
                    bucket: SOURCE_BUCKET,
                    key
                }
            })
        };
    } catch (error) {
        console.error('Error processing upload:', error);
        return errorResponse(500, 'Error processing upload');
    }
}

/**
 * Generate a unique filename to prevent collisions in S3
 * @param originalFilename The original file name
 * @returns A unique filename with timestamp and random hash
 */
function generateUniqueFileName(originalFilename: string): string {
    const timestamp = new Date().getTime();
    const randomHash = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(originalFilename);
    const baseName = path.basename(originalFilename, ext);

    return `${baseName}_${timestamp}_${randomHash}${ext}`;
}

/**
 * Parse multipart form data from API Gateway event
 * @param event The API Gateway event
 * @returns Parsed file information
 */
function parseMultipartFormData(event: APIGatewayEvent): {
    fileBuffer: Buffer | null;
    fileName: string | null;
    fileSize: number;
    fileType: string | null;
} {
    // Simple parser for multipart/form-data 
    // Note: In a production environment, consider using a library like busboy or formidable
    // This is a simplified implementation for demonstration purposes
    const body = event.body || '';
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';

    // Get boundary from content type
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) {
        return { fileBuffer: null, fileName: null, fileSize: 0, fileType: null };
    }

    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const parts = body.split(new RegExp(`--${boundary}`));

    // Look for file part in the form data
    for (const part of parts) {
        const fileNameMatch = part.match(/filename="([^"]+)"/i);
        const contentTypeMatch = part.match(/Content-Type:\s?([^\r\n]+)/i);

        if (fileNameMatch && contentTypeMatch) {
            const fileName = fileNameMatch[1];
            const fileType = contentTypeMatch[1];

            // Extract file content
            const fileContentStart = part.indexOf('\r\n\r\n') + 4;
            const fileContentEnd = part.lastIndexOf('\r\n');

            if (fileContentStart > 0 && fileContentEnd > fileContentStart) {
                const fileContent = part.substring(fileContentStart, fileContentEnd);
                const fileBuffer = Buffer.from(fileContent, 'base64');
                return {
                    fileBuffer,
                    fileName,
                    fileSize: fileBuffer.length,
                    fileType
                };
            }
        }
    }

    return { fileBuffer: null, fileName: null, fileSize: 0, fileType: null };
}

/**
 * Generate CORS headers
 * @returns Object with CORS headers
 */
function getCorsHeaders() {
    return {
        'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
    };
}

/**
 * Generate an error response
 * @param statusCode HTTP status code
 * @param message Error message
 * @returns API Gateway proxy response
 */
function errorResponse(statusCode: number, message: string): APIGatewayProxyResult {
    return {
        statusCode,
        headers: getCorsHeaders(),
        body: JSON.stringify({
            success: false,
            message
        })
    };
}
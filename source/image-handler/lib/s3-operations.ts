// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { S3 } from "aws-sdk";
import { ImageMetadata } from "./interfaces";
import { DbOperations } from "./db-operations";
import { EnvConfig } from "./env-config";

/**
 * Helper class to handle interactions with S3 for storing and retrieving images.
 */
export class S3Operations {
    private readonly s3Client: S3;
    private readonly dbOperations: DbOperations;
    private readonly outputBucket: string;

    /**
     * Constructs a new S3Operations instance.
     */
    constructor() {
        this.s3Client = new S3();
        this.dbOperations = new DbOperations();
        this.outputBucket = EnvConfig.getOutputBucket();

        if (!this.outputBucket) {
            console.warn("OUTPUT_BUCKET_NAME environment variable not set. S3 write operations will fail.");
        }
    }

    /**
     * Stores a processed image to S3 and updates metadata in DynamoDB.
     * @param key The object key
     * @param contentType The content type of the image
     * @param buffer The image buffer to store
     * @param metadata Optional metadata about the image
     * @returns Promise resolving to the S3 put result
     */
    public async storeProcessedImage(
        key: string,
        contentType: string,
        buffer: Buffer,
        metadata?: Partial<ImageMetadata>
    ): Promise<S3.ManagedUpload.SendData> {
        const startTime = Date.now();
        const params: S3.PutObjectRequest = {
            Bucket: this.outputBucket,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            CacheControl: "max-age=31536000", // 1 year cache,
            Metadata: {
                'processed': 'true',
                'processing-time': startTime.toString(),
                'file-size': buffer.length.toString(),
                ...(metadata && { 'source-metadata': JSON.stringify(metadata) })
            },
        };

        try {
            // Upload to S3
            const result = await this.s3Client.upload(params).promise();
            console.info(`Successfully stored processed image: ${key}`);

            // Build metadata
            const imageMetadata: ImageMetadata = {
                imageId: key,
                bucketName: this.outputBucket,
                key: key,
                format: contentType.split('/')[1],
                size: buffer.length,
                contentType: contentType,
                processingStatus: 'processed',
                ...metadata,
            };

            // Store metadata in DynamoDB
            await this.dbOperations.storeImageMetadata(key, imageMetadata);

            return result;
        } catch (error) {
            console.error(`Error storing processed image: ${key}`, error);

            // If specified, update metadata with error status
            if (metadata) {
                try {
                    await this.dbOperations.storeImageMetadata(key, {
                        imageId: key,
                        bucketName: this.outputBucket,
                        key: key,
                        processingStatus: 'failed',
                        processingError: (error as Error).message,
                        ...metadata,
                    });
                } catch (dbError) {
                    console.error(`Failed to store error metadata for ${key}`, dbError);
                }
            }

            throw error;
        }
    }

    /**
     * Checks if an image already exists in the output bucket.
     * @param key The object key to check
     * @returns Promise resolving to boolean indicating if the image exists
     */
    public async doesProcessedImageExist(key: string): Promise<boolean> {
        const params = {
            Bucket: this.outputBucket,
            Key: key,
        };

        try {
            await this.s3Client.headObject(params).promise();
            return true;
        } catch (error) {
            if ((error as Error).name === 'NotFound') {
                return false;
            }
            throw error;
        }
    }

    /**
     * Gets image metadata from both S3 and DynamoDB.
     * @param bucket The bucket name
     * @param key The object key
     * @returns Promise resolving to extended metadata
     */
    public async getImageMetadata(bucket: string, key: string): Promise<ImageMetadata> {
        const params = {
            Bucket: bucket,
            Key: key,
        };

        try {
            // Get S3 metadata
            const s3Metadata = await this.s3Client.headObject(params).promise();

            // Try to get DynamoDB metadata
            let dbMetadata: ImageMetadata | null = null;
            try {
                dbMetadata = await this.dbOperations.getImageMetadata(key);
            } catch (dbError) {
                console.warn(`Could not retrieve DynamoDB metadata for ${key}`, dbError);
            }

            // Combine metadata
            const combinedMetadata: ImageMetadata = {
                imageId: key,
                bucketName: bucket,
                key: key,
                size: s3Metadata.ContentLength,
                contentType: s3Metadata.ContentType,
                originalEtag: s3Metadata.ETag,
                ...dbMetadata, // Overlay any DB metadata we have
            };

            return combinedMetadata;
        } catch (error) {
            console.error(`Error retrieving metadata for image: ${key}`, error);
            throw error;
        }
    }

    /**
     * Updates access information for an image.
     * @param key The image key
     */
    public async updateAccessStats(key: string): Promise<void> {
        try {
            // Try to get existing metadata
            const existingMetadata = await this.dbOperations.getImageMetadata(key);

            // Update with new access stats
            if (existingMetadata) {
                const accessCount = (existingMetadata.accessCount || 0) + 1;
                await this.dbOperations.updateImageMetadata(key, {
                    accessCount,
                    lastAccessed: new Date().toISOString(),
                });
            }
        } catch (error) {
            // Just log the error but don't fail the request
            console.error(`Error updating access stats for image: ${key}`, error);
        }
    }
}

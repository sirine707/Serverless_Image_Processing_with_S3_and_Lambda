// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDB } from "aws-sdk";
import { ImageMetadata } from "./interfaces";
import { EnvConfig } from "./env-config";

/**
 * Helper class to handle interactions with DynamoDB for storing and retrieving image metadata.
 */
export class DbOperations {
    private readonly docClient: DynamoDB.DocumentClient;
    private readonly tableName: string;

    /**
     * Constructs a new DbOperations instance.
     */
    constructor() {
        this.docClient = new DynamoDB.DocumentClient();
        this.tableName = EnvConfig.getMetadataTable();

        if (!this.tableName) {
            console.warn("METADATA_TABLE_NAME environment variable not set. DynamoDB operations will fail.");
        }
    }

    /**
     * Stores metadata for an image in DynamoDB.
     * @param imageId Unique identifier for the image (typically the S3 object key)
     * @param metadata Object containing metadata about the image
     * @returns Promise resolving to the DynamoDB result
     */
    public async storeImageMetadata(imageId: string, metadata: ImageMetadata): Promise<DynamoDB.DocumentClient.PutItemOutput> {
        const params = {
            TableName: this.tableName,
            Item: {
                imageId,
                createdAt: new Date().toISOString(),
                ...metadata,
            },
        };

        try {
            const result = await this.docClient.put(params).promise();
            console.info(`Successfully stored metadata for image: ${imageId}`);
            return result;
        } catch (error) {
            console.error(`Error storing metadata for image: ${imageId}`, error);
            throw error;
        }
    }

    /**
     * Retrieves metadata for an image from DynamoDB.
     * @param imageId Unique identifier for the image
     * @returns Promise resolving to the image metadata
     */
    public async getImageMetadata(imageId: string): Promise<ImageMetadata | null> {
        const params = {
            TableName: this.tableName,
            Key: {
                imageId,
            },
        };

        try {
            const result = await this.docClient.get(params).promise();
            return result.Item as ImageMetadata || null;
        } catch (error) {
            console.error(`Error retrieving metadata for image: ${imageId}`, error);
            throw error;
        }
    }

    /**
     * Updates metadata for an existing image.
     * @param imageId Unique identifier for the image
     * @param metadata Partial metadata to update
     * @returns Promise resolving to the DynamoDB result
     */
    public async updateImageMetadata(imageId: string, metadata: Partial<ImageMetadata>): Promise<DynamoDB.DocumentClient.UpdateItemOutput> {
        // Prepare update expression and attribute values
        const updateExpressions: string[] = [];
        const expressionAttributeNames: Record<string, string> = {};
        const expressionAttributeValues: Record<string, any> = {};

        // Build update expressions for each metadata property
        Object.entries(metadata).forEach(([key, value], index) => {
            if (key !== 'imageId') { // Avoid updating the primary key
                const nameKey = `#attr${index}`;
                const valueKey = `:val${index}`;

                updateExpressions.push(`${nameKey} = ${valueKey}`);
                expressionAttributeNames[nameKey] = key;
                expressionAttributeValues[valueKey] = value;
            }
        });

        // Add updatedAt timestamp
        updateExpressions.push('#updatedAt = :updatedAt');
        expressionAttributeNames['#updatedAt'] = 'updatedAt';
        expressionAttributeValues[':updatedAt'] = new Date().toISOString();

        const params = {
            TableName: this.tableName,
            Key: {
                imageId,
            },
            UpdateExpression: `SET ${updateExpressions.join(', ')}`,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'UPDATED_NEW',
        };

        try {
            const result = await this.docClient.update(params).promise();
            console.info(`Successfully updated metadata for image: ${imageId}`);
            return result;
        } catch (error) {
            console.error(`Error updating metadata for image: ${imageId}`, error);
            throw error;
        }
    }
}

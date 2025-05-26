// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ENV_VARS } from './constants';

/**
 * Helper class to access environment variables with proper type handling and defaults
 */
export class EnvConfig {
    /**
     * Get source buckets from environment variables
     * @returns Array of source bucket names
     */
    static getSourceBuckets(): string[] {
        const sourceBuckets = process.env[ENV_VARS.SOURCE_BUCKETS] || '';
        if (!sourceBuckets) {
            console.warn('SOURCE_BUCKETS environment variable is not set');
            return [];
        }
        return sourceBuckets.split(',').map(bucket => bucket.trim());
    }

    /**
     * Get output bucket name from environment variables
     * @returns Output bucket name
     */
    static getOutputBucket(): string {
        const outputBucket = process.env[ENV_VARS.OUTPUT_BUCKET] || '';
        if (!outputBucket) {
            console.warn('OUTPUT_BUCKET_NAME environment variable is not set');
        }
        return outputBucket;
    }

    /**
     * Get metadata table name from environment variables
     * @returns Metadata table name
     */
    static getMetadataTable(): string {
        const tableName = process.env[ENV_VARS.METADATA_TABLE] || '';
        if (!tableName) {
            console.warn('METADATA_TABLE_NAME environment variable is not set');
        }
        return tableName;
    }

    /**
     * Check if caching is enabled
     * @returns True if caching is enabled
     */
    static isCacheEnabled(): boolean {
        return process.env[ENV_VARS.ENABLE_CACHE] === 'Yes';
    }

    /**
     * Check if CORS is enabled
     * @returns True if CORS is enabled
     */
    static isCorsEnabled(): boolean {
        return process.env[ENV_VARS.CORS_ENABLED] === 'Yes';
    }

    /**
     * Get CORS origin
     * @returns CORS origin or '*' as default
     */
    static getCorsOrigin(): string {
        return process.env[ENV_VARS.CORS_ORIGIN] || '*';
    }

    /**
     * Check if metrics collection is enabled
     * @returns True if metrics collection is enabled
     */
    static isMetricsEnabled(): boolean {
        return process.env[ENV_VARS.ENABLE_METRICS] === 'Yes';
    }

    /**
     * Get default fallback image key
     * @returns Default fallback image key or empty string
     */
    static getDefaultFallbackImageKey(): string {
        return process.env[ENV_VARS.DEFAULT_FALLBACK_IMAGE] || '';
    }
}

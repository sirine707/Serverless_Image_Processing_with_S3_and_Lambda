// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ContentTypes, StatusCodes } from "./enums";
import { SHARP_EDIT_ALLOWLIST_ARRAY, ALTERNATE_EDIT_ALLOWLIST_ARRAY } from "./constants";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Headers = Record<string, any>;

type AllowlistedEdit = (typeof SHARP_EDIT_ALLOWLIST_ARRAY)[number] | (typeof ALTERNATE_EDIT_ALLOWLIST_ARRAY)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ImageEdits = Partial<Record<AllowlistedEdit, any>>;

export class ImageHandlerError extends Error {
  constructor(public readonly status: StatusCodes, public readonly code: string, public readonly message: string) {
    super();
  }
}

export interface ErrorMapping {
  pattern: string;
  statusCode: number;
  errorType: string;
  message: string | ((err: Error) => string);
}

export type SecretManagerKeyOptions = {
  DynamoDBTable: string;
};

export type WildcardImageEdits = ImageEdits & {
  toFormat?: string;
  resize?: Record<string, string | number>;
  [key: string]: unknown;
};

export type WildcardHeaders = { [key: string]: string | undefined };

export type DefaultImageRequest = {
  bucket?: string;
  key?: string;
  edits?: WildcardImageEdits;
  headers?: WildcardHeaders;
  outputFormat?: string;
  effort?: number;
  [key: string]: unknown;
};

export type ImageRequestInfo = {
  requestType: RequestTypes;
  bucket: string;
  key: string;
  edits?: WildcardImageEdits;
  originalImage: Buffer;
  headers?: Headers;
  contentType?: ContentTypes | string;
  outputFormat?: string;
  cacheControl?: string;
  expires?: string;
  lastModified?: string;
  effort?: number;
  secondsToExpiry?: number;
};

export type ImageHandlerExecutionResult = {
  statusCode: number;
  isBase64Encoded: boolean;
  headers: Headers;
  body: string | Buffer;
};

export type S3HeadObjectResult = {
  statusCode: number;
  headers: { [key: string]: string };
};

// S3 Event Types for handling image uploads
export type S3Event = {
  Records: S3EventRecord[];
};

export type S3EventRecord = {
  eventVersion: string;
  eventSource: string;
  awsRegion: string;
  eventTime: string;
  eventName: string;
  userIdentity: {
    principalId: string;
  };
  requestParameters: {
    sourceIPAddress: string;
  };
  responseElements: {
    'x-amz-request-id': string;
    'x-amz-id-2': string;
  };
  s3: {
    s3SchemaVersion: string;
    configurationId: string;
    bucket: {
      name: string;
      ownerIdentity: {
        principalId: string;
      };
      arn: string;
    };
    object: {
      key: string;
      size: number;
      eTag: string;
      sequencer: string;
      versionId?: string;
    };
  };
};

export type S3GetObjectEvent = {
  getObjectContext: {
    inputS3Url: string;
    outputRoute: string;
    outputToken: string;
  };
  userRequest: {
    url: string;
    headers: {
      Host: string;
      [key: string]: string;
    };
  };
};

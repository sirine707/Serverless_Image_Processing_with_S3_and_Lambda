// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Sharp from "sharp";
import S3 from "aws-sdk/clients/s3";

import {
  ImageEdits,
  ImageFormatTypes,
  ImageHandlerError,
  ImageRequestInfo,
  StatusCodes,
  ImageMetadata,
  S3Operations,
  DbOperations,
  EnvConfig
} from "./lib"; zon.com, Inc.or its affiliates.All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Sharp from "sharp";
import S3 from "aws-sdk/clients/s3";

import {
  ImageEdits,
  ImageFormatTypes,
  ImageHandlerError,
  ImageRequestInfo,
  StatusCodes,
  ImageMetadata,
  S3Operations,
  DbOperations
} from "./lib";

/**
 * Performs image modifications based on the request and image type.
 */
export class ImageHandler {
  private readonly s3Operations: S3Operations;
  private readonly dbOperations: DbOperations;

  constructor(private readonly s3Client: S3) {
    this.s3Operations = new S3Operations();
    this.dbOperations = new DbOperations();
  }

  /**
   * Main method for processing image requests and applying transformations.
   * @param imageRequestInfo An image request with defined parameters.
   * @returns Promise<Buffer> The modified image buffer.
   */
  async process(imageRequestInfo: ImageRequestInfo): Promise<Buffer> {
    const { originalImage, edits, outputFormat } = imageRequestInfo;

    // Create a unique image ID based on the request
    const imageId = this.generateImageId(imageRequestInfo);

    // Check if the processed image already exists in the output bucket
    try {
      const imageExists = await this.s3Operations.doesProcessedImageExist(imageId);
      if (imageExists) {
        console.info(`Using cached processed image: ${imageId}`);
        // Update access statistics for the image
        await this.s3Operations.updateAccessStats(imageId);

        // Retrieve the image from S3 (we'd need to extract this from S3Operations to avoid code duplication)
        const params = {
          Bucket: process.env.OUTPUT_BUCKET_NAME || "",
          Key: imageId,
        };
        const cachedImage = await this.s3Client.getObject(params).promise();
        return cachedImage.Body as Buffer;
      }
    } catch (error) {
      // Log the error, but proceed with processing
      console.warn(`Error checking for cached image: ${error}`);
    }

    const formats = Object.values(ImageFormatTypes);
    const imageBuffer = Buffer.isBuffer(originalImage) ? originalImage : Buffer.from(originalImage);
    let contentType;

    try {
      if ("ContentType" in imageRequestInfo) {
        contentType = imageRequestInfo.ContentType;
      } else {
        const metadata = await Sharp(imageBuffer).metadata();
        contentType = metadata.format;
      }
    } catch (error) {
      console.error("Error occurred during image metadata processing:", error);
      throw new ImageHandlerError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        "ImageProcessingError",
        "Error occurred during image metadata processing."
      );
    }

    let modifiedImage = null;
    if (formats.includes(contentType as ImageFormatTypes)) {
      // Apply edits if specified
      if (edits) {
        modifiedImage = await this.applyEdits(imageBuffer, edits);
      } else {
        modifiedImage = imageBuffer;
      }
    } else {
      // If the input format is not supported, return an error
      throw new ImageHandlerError(
        StatusCodes.BAD_REQUEST,
        "ImageFormatNotSupported",
        "The requested image format is not supported."
      );
    }

    // Apply formatting modifications to the image if specified
    if (outputFormat && formats.includes(outputFormat)) {
      if (modifiedImage === null) {
        throw new ImageHandlerError(
          StatusCodes.INTERNAL_SERVER_ERROR,
          "ImageProcessingError",
          "Error occurred during image processing. Unable to convert image to desired format."
        );
      }
      try {
        const formatted = await this.applyFormatting(modifiedImage, contentType as ImageFormatTypes, outputFormat);

        // Store processed image in S3 and metadata in DynamoDB if caching is enabled
        if (process.env.ENABLE_CACHE === 'Yes') {
          try {
            const imageId = this.generateImageId(imageRequestInfo);
            const contentTypeMap = {
              [ImageFormatTypes.JPEG]: 'image/jpeg',
              [ImageFormatTypes.PNG]: 'image/png',
              [ImageFormatTypes.WEBP]: 'image/webp',
              [ImageFormatTypes.TIFF]: 'image/tiff',
              [ImageFormatTypes.GIF]: 'image/gif',
              [ImageFormatTypes.AVIF]: 'image/avif'
            };

            const outputContentType = contentTypeMap[outputFormat] || 'image/jpeg';

            // Get image dimensions
            const metadata = await Sharp(formatted).metadata();

            // Store metadata
            await this.s3Operations.storeProcessedImage(
              imageId,
              outputContentType,
              formatted,
              {
                imageId: imageId,
                bucketName: process.env.OUTPUT_BUCKET_NAME || '',
                key: imageId,
                format: outputFormat,
                width: metadata.width,
                height: metadata.height,
                size: formatted.length,
                contentType: outputContentType,
                requestedEdits: edits,
                processingStatus: 'processed'
              }
            );

            console.info(`Successfully stored processed image: ${imageId}`);
          } catch (storageError) {
            // Log the error but don't fail the request
            console.error('Failed to store processed image:', storageError);
          }
        }

        return formatted;
      } catch (error) {
        console.error("Error during image formatting:", error);
        throw new ImageHandlerError(
          StatusCodes.INTERNAL_SERVER_ERROR,
          "ImageFormatError",
          "Error occurred while converting the image to the desired format."
        );
      }
    } else if (modifiedImage) {
      return modifiedImage;
    } else {
      // This case should not happen if all other error cases were handled properly
      throw new ImageHandlerError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        "ImageProcessingError",
        "Error occurred during image processing. Please check your request parameters."
      );
    }
  }

  /**
   * Applies edits to the supplied image
   * @param originalImage The original image.
   * @param edits The edits to be made to the image.
   * @returns A modified Sharp image object.
   */
  private async applyEdits(originalImage: Buffer, edits: ImageEdits): Promise<Buffer> {
    let image = Sharp(originalImage, { failOn: "none" });

    try {
      // Apply edits
      if (edits.resize) {
        if (edits.resize.fit && edits.resize.fit !== "cover") {
          image = image.resize({
            width: edits.resize.width,
            height: edits.resize.height,
            fit: edits.resize.fit,
            position: edits.resize.position ?? "center", // Defaulting to center
            background: edits.resize.background ? this.convertHexToRgb(edits.resize.background) : { r: 0, g: 0, b: 0, alpha: 0 },
          });
        } else {
          image = image.resize(edits.resize.width, edits.resize.height, {
            fit: edits.resize.fit ?? "cover", // Default to cover
            position: edits.resize.position ?? "center", // Default to center
          });
        }
      }

      // Apply other edits
      if (edits.grayscale) {
        image = image.grayscale();
      }

      if (edits.flip) {
        image = image.flip();
      }

      if (edits.flop) {
        image = image.flop();
      }

      if (edits.rotate !== undefined) {
        // Use the flip and flop values in the rotate function, if they exist.
        image = image.rotate(Number(edits.rotate), {
          background: edits.background ? this.convertHexToRgb(edits.background) : { r: 0, g: 0, b: 0, alpha: 0 },
        });
      }

      if (edits.background) {
        image = image.flatten({
          background: this.convertHexToRgb(edits.background),
        });
      }

      if (edits.flatten) {
        const background = edits.flatten.background ? this.convertHexToRgb(edits.flatten.background) : { r: 0, g: 0, b: 0 };
        image = image.flatten({ background });
      }

      if (edits.rgb && Object.values(edits.rgb).some(value => value !== 0)) {
        image = image.modulate({ ...edits.rgb });
      }

      if (edits.normalize) {
        image = image.normalize();
      }

      if (edits.threshold) {
        image = image.threshold(edits.threshold);
      }

      if (edits.sharpen) {
        image = image.sharpen(edits.sharpen);
      }

      if (edits.blur) {
        image = image.blur(edits.blur);
      }

      if (edits.extend) {
        const { top = 0, right = 0, bottom = 0, left = 0 } = edits.extend;
        const background = edits.extend.background
          ? this.convertHexToRgb(edits.extend.background)
          : { r: 0, g: 0, b: 0, alpha: 0 };

        image = image.extend({
          top,
          bottom,
          left,
          right,
          background,
        });
      }

      if (edits.watermark) {
        // Add watermark text
        const { text, position = 'center', color = '#ffffff', opacity = 0.5, fontSize = 48, padding = 20 } = edits.watermark;
        const svgText = Buffer.from(`
          <svg width="100%" height="100%">
            <style>
              .text {
                fill: ${color};
                opacity: ${opacity};
                font-size: ${fontSize}px;
                font-family: Arial, sans-serif;
                font-weight: bold;
              }
            </style>
            <text x="${this.getTextPosition(position, 'x', padding)}%" 
                  y="${this.getTextPosition(position, 'y', padding)}%" 
                  text-anchor="${this.getTextAnchor(position)}"
                  dominant-baseline="${this.getTextBaseline(position)}"
                  class="text">${text}</text>
          </svg>`);

        const metadata = await image.metadata();
        const watermarkImage = await Sharp(svgText)
          .resize(metadata.width, metadata.height)
          .toBuffer();

        image = await Sharp(await image.toBuffer())
          .composite([{ input: watermarkImage, gravity: 'center' }]);
      }

      // Apply format-specific options
      if (edits.jpeg) {
        image = image.jpeg(edits.jpeg);
      } else if (edits.png) {
        image = image.png(edits.png);
      } else if (edits.webp) {
        image = image.webp(edits.webp);
      } else if (edits.tiff) {
        image = image.tiff(edits.tiff);
      } else if (edits.gif) {
        image = image.gif(edits.gif);
      } else if (edits.avif) {
        image = image.avif(edits.avif);
      }

      return await image.toBuffer();
    } catch (error) {
      console.error("Error when applying image edits:", error);
      throw new ImageHandlerError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        "ImageEditsError",
        "Error occurred while applying edits to the image."
      );
    }
  }

  /**
   * Gets text anchor position for SVG watermark
   */
  private getTextAnchor(position: string): string {
    if (position.includes('left')) return 'start';
    if (position.includes('right')) return 'end';
    return 'middle';
  }

  /**
   * Gets text baseline position for SVG watermark
   */
  private getTextBaseline(position: string): string {
    if (position.includes('top')) return 'hanging';
    if (position.includes('bottom')) return 'baseline';
    return 'middle';
  }

  /**
   * Gets text position percentage for SVG watermark
   */
  private getTextPosition(position: string, axis: 'x' | 'y', padding: number): number {
    if (axis === 'x') {
      if (position.includes('left')) return padding;
      if (position.includes('right')) return 100 - padding;
      return 50;
    } else {
      if (position.includes('top')) return padding;
      if (position.includes('bottom')) return 100 - padding;
      return 50;
    }
  }

  /**
   * Applies formatting to the image according to the specified output format.
   * @param image the Sharp image to format
   * @param contentType the content type of the image
   * @param outputFormat the desired output format
   * @returns Formatted Sharp image.
   */
  private async applyFormatting(
    image: Buffer,
    contentType: ImageFormatTypes,
    outputFormat: ImageFormatTypes
  ): Promise<Buffer> {
    try {
      const sharpImage = Sharp(image, { failOn: "none" });

      // Convert image to the specified format
      switch (outputFormat) {
        case ImageFormatTypes.JPEG:
          return await sharpImage.jpeg().toBuffer();
        case ImageFormatTypes.PNG:
          return await sharpImage.png().toBuffer();
        case ImageFormatTypes.WEBP:
          return await sharpImage.webp().toBuffer();
        case ImageFormatTypes.TIFF:
          return await sharpImage.tiff().toBuffer();
        case ImageFormatTypes.GIF:
          return await sharpImage.gif().toBuffer();
        case ImageFormatTypes.AVIF:
          return await sharpImage.avif().toBuffer();
        default:
          return await sharpImage.toBuffer();
      }
    } catch (error) {
      console.error("Error when formatting image:", error);
      throw new ImageHandlerError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        "ImageFormatError",
        "Error occurred while converting the image."
      );
    }
  }

  /**
   * Converts hexadecimal color value to RGB.
   * @param hex The hexadecimal color value.
   * @returns Object representing RGB values.
   */
  private convertHexToRgb(hex: string): { r: number; g: number; b: number; alpha?: number } {
    // Expand shorthand form (e.g. "03F") to full form (e.g. "0033FF")
    const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
    const hexValue = hex.replace(shorthandRegex, (_, r, g, b) => {
      return r + r + g + g + b + b;
    });

    // Parse hex values
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hexValue);
    if (result) {
      const r = parseInt(result[1], 16);
      const g = parseInt(result[2], 16);
      const b = parseInt(result[3], 16);
      return { r, g, b };
    }

    // Default to black if parsing fails
    return { r: 0, g: 0, b: 0 };
  }

  /**
   * Generates a unique ID for an image based on request parameters
   * @param imageRequestInfo The image request information
   * @returns A unique string ID for the processed image
   */
  private generateImageId(imageRequestInfo: ImageRequestInfo): string {
    const { bucket, key, edits, outputFormat } = imageRequestInfo;

    // Create a deterministic hash from the request parameters
    const editString = edits ? JSON.stringify(edits) : '';
    const requestString = `${bucket}/${key}/${editString}/${outputFormat || ''}`;

    // Create a simple hash
    let hash = 0;
    for (let i = 0; i < requestString.length; i++) {
      const char = requestString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    // Format as hex string
    const hashHex = Math.abs(hash).toString(16);

    // Create a unique ID that preserves some of the original structure
    const ext = outputFormat?.toLowerCase() || 'jpg';
    return `${key.split('/').pop()?.split('.')[0] || 'image'}-${hashHex}.${ext}`;
  }
}

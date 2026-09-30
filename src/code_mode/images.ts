import type { ImageContent } from "@earendil-works/pi-ai";
import { isSupportedImageType, prepareImageForModel } from "../core/utils/model_image.js";

export const CODE_MODE_MAX_IMAGE_PIXELS = 40_000_000;

export async function prepareCodeModeImage(value: unknown): Promise<ImageContent> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("type" in value) ||
    value.type !== "image" ||
    !("data" in value) ||
    typeof value.data !== "string" ||
    !("mimeType" in value) ||
    typeof value.mimeType !== "string"
  ) {
    throw new Error('image() expects { type: "image", data: base64, mimeType }.');
  }
  if (!isSupportedImageType(value.mimeType)) {
    throw new Error("image() supports image/jpeg, image/png, and image/webp.");
  }
  const content = Buffer.from(value.data, "base64");
  if (!value.data || content.toString("base64") !== value.data) {
    throw new Error("image() requires valid, padded base64 data.");
  }
  const [{ fileTypeFromBuffer }, { default: sharp }] = await Promise.all([
    import("file-type"),
    import("sharp"),
  ]);
  const detected = await fileTypeFromBuffer(content);
  if (detected?.mime !== value.mimeType) {
    throw new Error("image() MIME type does not match the image data.");
  }
  await sharp(content, { limitInputPixels: CODE_MODE_MAX_IMAGE_PIXELS })
    .resize({ width: 1, height: 1, fit: "inside" })
    .raw()
    .toBuffer();
  const prepared = await prepareImageForModel(content, value.mimeType, sharp);
  return { type: "image", data: prepared.content.toString("base64"), mimeType: prepared.mimeType };
}

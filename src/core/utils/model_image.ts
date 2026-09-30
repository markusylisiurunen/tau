import { formatBytes } from "./truncate.js";

export const MODEL_IMAGE_MAX_BYTES = 3.5 * 1024 * 1024;
const MODEL_IMAGE_MAX_DIMENSION_PX = 4096;
const MODEL_IMAGE_DIMENSION_STEPS = [
  4096, 3840, 3584, 3072, 2560, 2048, 2000, 1920, 1792, 1664, 1536, 1408, 1280, 1152, 1024, 896,
  768, 640, 512,
] as const;
const MODEL_IMAGE_LOSSY_QUALITY_STEPS = [95, 90, 85] as const;
export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

type ImageEncodePlan =
  | {
      mimeType: "image/jpeg";
      quality: number;
    }
  | {
      mimeType: "image/png";
    }
  | {
      mimeType: "image/webp";
      quality: number;
      lossless?: boolean;
    };

type EncodedImage = {
  content: Buffer;
  mimeType: SupportedImageType;
  width: number;
  height: number;
};

type Sharp = typeof import("sharp")["default"];

export function isSupportedImageType(mimeType: string | undefined): mimeType is SupportedImageType {
  return mimeType ? SUPPORTED_IMAGE_TYPES.includes(mimeType as SupportedImageType) : false;
}

function buildDimensionCaps(maxDimension: number): number[] {
  const caps = new Set<number>([maxDimension]);
  for (const step of MODEL_IMAGE_DIMENSION_STEPS) {
    if (step < maxDimension) {
      caps.add(step);
    }
  }
  return [...caps];
}

function buildEncodePlans(args: {
  sourceMimeType: SupportedImageType;
  hasAlpha: boolean;
}): ImageEncodePlan[] {
  const { sourceMimeType, hasAlpha } = args;
  const plans: ImageEncodePlan[] = [];

  if (sourceMimeType !== "image/webp") {
    plans.push({ mimeType: "image/png" });
  }
  plans.push({ mimeType: "image/webp", quality: 100, lossless: true });

  for (const quality of MODEL_IMAGE_LOSSY_QUALITY_STEPS) {
    plans.push({ mimeType: "image/webp", quality });
    if (!hasAlpha) {
      plans.push({ mimeType: "image/jpeg", quality });
    }
  }

  return plans;
}

async function encodeImageCandidate(args: {
  content: Buffer;
  maxDimension: number;
  plan: ImageEncodePlan;
  sharp: Sharp;
}): Promise<EncodedImage> {
  const { content, maxDimension, plan, sharp } = args;
  const pipeline = sharp(content).resize({
    width: maxDimension,
    height: maxDimension,
    fit: "inside",
    withoutEnlargement: true,
  });

  if (plan.mimeType === "image/jpeg") {
    const { data, info } = await pipeline
      .jpeg({ quality: plan.quality })
      .toBuffer({ resolveWithObject: true });
    return { mimeType: "image/jpeg", content: data, width: info.width, height: info.height };
  }

  if (plan.mimeType === "image/png") {
    const { data, info } = await pipeline
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { mimeType: "image/png", content: data, width: info.width, height: info.height };
  }

  const { data, info } = await pipeline
    .webp({
      quality: plan.quality,
      lossless: plan.lossless,
    })
    .toBuffer({ resolveWithObject: true });
  return { mimeType: "image/webp", content: data, width: info.width, height: info.height };
}

export async function prepareImageForModel(
  content: Buffer,
  sourceMimeType: SupportedImageType,
  sharp: Sharp,
): Promise<EncodedImage> {
  const metadata = await sharp(content).metadata();
  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height) {
    throw new Error("Failed to read image dimensions.");
  }

  if (
    width <= MODEL_IMAGE_MAX_DIMENSION_PX &&
    height <= MODEL_IMAGE_MAX_DIMENSION_PX &&
    content.byteLength <= MODEL_IMAGE_MAX_BYTES
  ) {
    return { content, mimeType: sourceMimeType, width, height };
  }

  const maxDimension = Math.min(MODEL_IMAGE_MAX_DIMENSION_PX, Math.max(width, height));
  const dimensionCaps = buildDimensionCaps(maxDimension);
  const encodePlans = buildEncodePlans({
    sourceMimeType,
    hasAlpha: metadata.hasAlpha ?? false,
  });

  let smallest: EncodedImage | undefined;

  for (const dimensionCap of dimensionCaps) {
    for (const plan of encodePlans) {
      const candidate = await encodeImageCandidate({
        content,
        maxDimension: dimensionCap,
        plan,
        sharp,
      });

      if (!smallest || candidate.content.byteLength < smallest.content.byteLength) {
        smallest = candidate;
      }

      if (candidate.content.byteLength <= MODEL_IMAGE_MAX_BYTES) {
        return candidate;
      }
    }
  }

  const targetSizeLabel = formatBytes(MODEL_IMAGE_MAX_BYTES);
  if (smallest) {
    throw new Error(
      `Image could not be reduced below ${targetSizeLabel} (best effort produced ${formatBytes(smallest.content.byteLength)}).`,
    );
  }

  throw new Error(`Image could not be reduced below ${targetSizeLabel}.`);
}

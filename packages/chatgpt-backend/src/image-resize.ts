import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { ChatGptImageGenerationRequest, ChatGptImageGenerationResponse } from './client.js';
import { imageResolutionAlias } from './images.js';
import { invalidImageOutput, ResponsesImageBudget, RESPONSES_IMAGE_LIMITS } from './image-output.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Bound decoded memory before handing potentially highly compressed PNGs to the
// decoder. Output sizes have a separate, smaller request-side bound.
const MAX_SOURCE_PIXELS = 16_777_216;
const MAX_SOURCE_DIMENSION = 8192;
const PNG_MODULE_PATH = createRequire(import.meta.url).resolve('pngjs');
const MAX_RESIZE_WORKERS = 2;
let activeWorkers = 0;
const workerWaiters: Array<() => void> = [];

/** Local resolution aliases promise physical PNG dimensions. Native IDs retain
 * upstream bytes unchanged, including their existing metadata behavior. */
export async function resizeAliasedImageResponse(result: ChatGptImageGenerationResponse,
  request: ChatGptImageGenerationRequest, signal: AbortSignal): Promise<ChatGptImageGenerationResponse> {
  const alias = imageResolutionAlias(request.model ?? '');
  if (!alias) return result;
  const requestedSize = request.size ?? alias.size;
  const target = requestedSize === 'auto' ? undefined : requestedSize.split('x').map(Number);
  const opaque = (result.background ?? request.background) === 'opaque';
  const budget = new ResponsesImageBudget();
  const data: ChatGptImageGenerationResponse['data'] = [];
  const sizes = new Set<string>();
  try {
    for (const image of result.data) {
      signal.throwIfAborted();
      if (result.output_format !== undefined && result.output_format !== 'png') throw invalidImageOutput();
      const source = Buffer.from(image.b64_json, 'base64');
      const transformed = await transformPng(source, target, opaque, signal);
      const b64_json = transformed.unchanged ? image.b64_json : Buffer.from(transformed.bytes).toString('base64');
      signal.throwIfAborted();
      const item = { ...image, b64_json };
      budget.add(item);
      data.push(item);
      sizes.add(transformed.width + 'x' + transformed.height);
    }
    const { size: _upstreamSize, ...metadata } = result;
    return { ...metadata, data, output_format: 'png', ...(sizes.size === 1 ? { size: [...sizes][0] } : {}) };
  } catch (error) {
    signal.throwIfAborted();
    throw invalidImageOutput();
  }
}

function validatePngHeader(bytes: Buffer): void {
  // Validate IHDR before allocation. The worker enforces PNG chunk structure
  // and exact scanline length before the decoder checks supported chunk CRCs.
  if (bytes.length < 33 || bytes.length > RESPONSES_IMAGE_LIMITS.itemBytes * 3 / 4 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw invalidImageOutput();
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION
    || width * height > MAX_SOURCE_PIXELS) throw invalidImageOutput();
}

interface TransformedPng { bytes: Uint8Array; width: number; height: number; unchanged: boolean; }
async function transformPng(bytes: Buffer, target: number[] | undefined, opaque: boolean, signal: AbortSignal): Promise<TransformedPng> {
  validatePngHeader(bytes);
  signal.throwIfAborted();
  const release = await acquireWorkerSlot(signal);
  try { return await runWorker(bytes, target, opaque, signal); }
  finally { release(); }
}

function acquireWorkerSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = workerWaiters.indexOf(grant);
      if (index !== -1) workerWaiters.splice(index, 1);
      reject(signal.reason);
    };
    const grant = () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { reject(signal.reason); workerWaiters.shift()?.(); return; }
      activeWorkers++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeWorkers--;
        workerWaiters.shift()?.();
      });
    };
    if (activeWorkers < MAX_RESIZE_WORKERS) grant();
    else {
      workerWaiters.push(grant);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

async function runWorker(bytes: Buffer, target: number[] | undefined, opaque: boolean, signal: AbortSignal): Promise<TransformedPng> {
  signal.throwIfAborted();
  // Keep expensive work off the main thread. Cooperative cancellation lets
  // bounded native zlib operations close normally; force-terminating a worker
  // during native initialization/cleanup can crash supported Node runtimes.
  const cancelBuffer = new SharedArrayBuffer(4);
  const cancelFlag = new Int32Array(cancelBuffer);
  const worker = new Worker(RESIZE_WORKER_SOURCE, { eval: true, execArgv: [], workerData: {
    bytes, target, opaque, cancelBuffer, pngModulePath: PNG_MODULE_PATH,
    maxEncodedBytes: RESPONSES_IMAGE_LIMITS.itemBytes * 3 / 4,
  }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  return new Promise<TransformedPng>((resolve, reject) => {
    let result: TransformedPng | undefined;
    let failure: unknown;
    const abort = () => { Atomics.store(cancelFlag, 0, 1); };
    worker.once('error', () => { failure = invalidImageOutput(); });
    worker.once('exit', (code) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (failure || code !== 0 || !result) reject(failure ?? invalidImageOutput());
      else resolve(result);
    });
    worker.once('message', (value: TransformedPng & { error?: boolean }) => {
      if (value.error || !(value.bytes instanceof Uint8Array)
        || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) failure = invalidImageOutput();
      else result = value;
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

// Literal JS avoids any dependency on a test runner's transformed function
// names, or on source .ts files being present in a compiled release package.
// Request data is passed only through workerData, never interpolated into code.
const RESIZE_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { inflateSync } = require('node:zlib');
const { PNG } = require(workerData.pngModulePath);
const cancelFlag = new Int32Array(workerData.cancelBuffer);
function checkCancelled() {
  if (Atomics.load(cancelFlag, 0)) throw new Error('Image processing cancelled');
}
function validateInflatedPng(bytes) {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const depth = bytes[24], channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[bytes[25]];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || bytes[28] > 1) throw new Error('Invalid PNG header');
  let expected = 0;
  const passes = bytes[28] ? [[0,0,8,8], [4,0,8,8], [0,4,4,8], [2,0,4,4], [0,2,2,4], [1,0,2,2], [0,1,1,2]] : [[0,0,1,1]];
  for (const [x, y, dx, dy] of passes) {
    const passWidth = Math.max(0, Math.ceil((width - x) / dx));
    const passHeight = Math.max(0, Math.ceil((height - y) / dy));
    if (passWidth && passHeight) expected += (Math.ceil(passWidth * channels * depth / 8) + 1) * passHeight;
  }
  const chunks = [];
  let sawHeader = false, sawData = false, dataEnded = false, sawEnd = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('Truncated PNG');
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length) throw new Error('Truncated PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!sawHeader && (offset !== 8 || type !== 'IHDR' || length !== 13)) throw new Error('Missing first PNG header');
    if (type === 'IHDR') {
      if (sawHeader || offset !== 8 || length !== 13) throw new Error('Duplicate PNG header');
      sawHeader = true;
    } else if (type === 'IDAT') {
      if (!sawHeader || dataEnded || sawEnd) throw new Error('Noncontiguous PNG data');
      sawData = true;
      chunks.push(bytes.subarray(offset + 8, end - 4));
    } else {
      if (sawData) dataEnded = true;
      if (type === 'IEND') {
        if (!sawData || length !== 0 || end !== bytes.length) throw new Error('Invalid final PNG chunk');
        sawEnd = true;
      }
    }
    offset = end;
  }
  if (!sawHeader || !sawData || !sawEnd) throw new Error('Incomplete PNG');
  // pngjs's interlaced sync path otherwise inflates without a byte ceiling, and
  // its non-interlaced path truncates excess scanline data. Bound and validate
  // the exact scanline byte count before either decoder path allocates it.
  if (inflateSync(Buffer.concat(chunks), { maxOutputLength: expected }).length !== expected) throw new Error('Invalid PNG scanline length');
}
function samples(source, target) {
  const indices = new Int32Array(target * 4), weights = new Float64Array(target * 4);
  for (let x = 0; x < target; x++) {
    const coordinate = (x + 0.5) * source / target - 0.5;
    const first = Math.floor(coordinate) - 1;
    for (let tap = 0; tap < 4; tap++) {
      indices[x * 4 + tap] = Math.min(source - 1, Math.max(0, first + tap));
      const distance = Math.abs(coordinate - (first + tap));
      weights[x * 4 + tap] = distance <= 1 ? (1.5 * distance - 2.5) * distance * distance + 1
        : distance < 2 ? ((-0.5 * distance + 2.5) * distance - 4) * distance + 2 : 0;
    }
  }
  return { indices, weights };
}

/** Catmull-Rom filtering in premultiplied alpha, followed by centered contain
 * padding. Row caches bound working memory. This standalone function and its
 * sample helper run inside the worker without imports or module state. */
function containPng(source, width, height, opaque, PngClass) {
  const scale = Math.min(width / source.width, height / source.height);
  const contentWidth = Math.max(1, Math.min(width, Math.round(source.width * scale)));
  const contentHeight = Math.max(1, Math.min(height, Math.round(source.height * scale)));
  const offsetX = Math.floor((width - contentWidth) / 2), offsetY = Math.floor((height - contentHeight) / 2);
  const output = new PngClass({ width, height, colorType: 6, inputColorType: 6, inputHasAlpha: true,
    deflateLevel: 6, deflateStrategy: 0 });
  output.data.fill(opaque ? 255 : 0);
  const horizontal = samples(source.width, contentWidth), vertical = samples(source.height, contentHeight);
  const rows = new Map();
  const getRow = (y) => {
    let row = rows.get(y);
    if (row) return row;
    row = new Float64Array(contentWidth * 4);
    for (let x = 0; x < contentWidth; x++) {
      for (let tap = 0; tap < 4; tap++) {
        const index = (y * source.width + horizontal.indices[x * 4 + tap]) * 4;
        const weight = horizontal.weights[x * 4 + tap];
        const alpha = source.data[index + 3];
        row[x * 4] += source.data[index] * alpha / 255 * weight;
        row[x * 4 + 1] += source.data[index + 1] * alpha / 255 * weight;
        row[x * 4 + 2] += source.data[index + 2] * alpha / 255 * weight;
        row[x * 4 + 3] += alpha * weight;
      }
    }
    rows.set(y, row);
    return row;
  };
  for (let y = 0; y < contentHeight; y++) {
    if (y % 16 === 0) checkCancelled();
    const selected = [0, 1, 2, 3].map((tap) => getRow(vertical.indices[y * 4 + tap]));
    for (let x = 0; x < contentWidth; x++) {
      const filtered = [0, 0, 0, 0];
      for (let tap = 0; tap < 4; tap++) for (let channel = 0; channel < 4; channel++) {
        filtered[channel] += selected[tap][x * 4 + channel] * vertical.weights[y * 4 + tap];
      }
      const alpha = Math.min(255, Math.max(0, filtered[3]));
      const destination = ((y + offsetY) * width + x + offsetX) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const premultiplied = Math.min(alpha, Math.max(0, filtered[channel]));
        output.data[destination + channel] = Math.round(opaque ? premultiplied + 255 - alpha
          : alpha > 0 ? premultiplied * 255 / alpha : 0);
      }
      output.data[destination + 3] = opaque ? 255 : Math.round(alpha);
    }
    const needed = new Set([0, 1, 2, 3].map((tap) => vertical.indices[Math.min(contentHeight - 1, y + 1) * 4 + tap]));
    for (const row of rows.keys()) if (!needed.has(row)) rows.delete(row);
  }
  return output;
}

// Use pngjs's public async decoder. Its sync decoder relies on legacy private
// zlib handles, which are unsafe during worker teardown on supported Node 22.
(async () => { try {
  checkCancelled();
  const bytes = Buffer.from(workerData.bytes);
  validateInflatedPng(bytes);
  checkCancelled();
  const image = await new Promise((resolve, reject) => {
    new PNG({ checkCRC: true }).parse(bytes, (error, decoded) => error ? reject(error) : resolve(decoded));
  });
  checkCancelled();
  if (image.width !== bytes.readUInt32BE(16) || image.height !== bytes.readUInt32BE(20)
    || image.data.length !== image.width * image.height * 4) throw new Error('PNG header changed during decode');
  const [width, height] = workerData.target || [image.width, image.height];
  const unchanged = width === image.width && height === image.height;
  const output = unchanged ? bytes : PNG.sync.write(containPng(image, width, height, workerData.opaque, PNG), {
    colorType: 6, inputColorType: 6, inputHasAlpha: true, deflateLevel: 6, deflateStrategy: 0,
  });
  checkCancelled();
  if (output.length > workerData.maxEncodedBytes) throw new Error('Image byte limit');
  parentPort.postMessage({ bytes: output, width, height, unchanged });
} catch { parentPort.postMessage({ error: true }); }
finally { parentPort.close(); } })();
`;

import { parentPort, workerData } from 'node:worker_threads';
import { readPicture } from './trace.mjs';

const picture = readPicture(workerData);
parentPort.postMessage(picture.index !== null && picture.unit >= workerData.minShare * picture.width);

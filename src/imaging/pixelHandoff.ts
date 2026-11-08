// Pixels a bridge already holds in memory (the browser build's engine Worker hands its buffer over without a copy) go
// to the interface as they are: an empty Response carries the headers, and the buffer travels beside it. A body
// would be copied once when the Response is made and again when it is read, about a quarter of a second of the page's
// own time for a 200 MB series. The desktop's pixels arrive over a stream and do not use this.

const buffers = new WeakMap<Response, ArrayBuffer>();

/** A Response for `bytes` with `headers` (Content-Length and the pixel headers), handing the buffer over as it is. */
export function handOverPixels(bytes: ArrayBuffer, headers: Headers): Response {
  const response = new Response(null, { status: 200, headers });
  buffers.set(response, bytes);
  return response;
}

/** The buffer handed over with `response`, once; undefined for a Response with a body. */
export function takePixels(response: Response): ArrayBuffer | undefined {
  const bytes = buffers.get(response);
  buffers.delete(response);
  return bytes;
}

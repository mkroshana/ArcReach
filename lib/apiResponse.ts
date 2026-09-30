/**
 * Reading API responses on the client pages. A route that fails answers with a
 * JSON { error } body, and the pages show that message. A load that failed, or
 * answered with something other than what the page shows, is reported as an
 * error, never shown as an empty list or zeros. Uses only the Fetch Response
 * API, so it can be tested outside the browser.
 */

/** A load that failed or answered in the wrong shape; its message is meant for the page. */
export class LoadError extends Error {}

/** The message a failed response carries in its JSON `error`, else the fallback. Reads the body. */
export async function responseErrorMessage(res: Response, fallback: string): Promise<string> {
  const data: unknown = await res.json().catch(() => null);
  const error = data && typeof data === 'object' ? (data as { error?: unknown }).error : undefined;
  return typeof error === 'string' && error.trim() ? error.trim() : fallback;
}

async function readOkBody(res: Response, what: string): Promise<unknown> {
  if (!res.ok) throw new LoadError(await responseErrorMessage(res, `${what} could not be loaded (the server answered ${res.status}).`));
  return res.json().catch(() => undefined);
}

/** The list a load answered. Throws a LoadError when the request failed or the body is not a JSON array. */
export async function readJsonList<T = any>(res: Response, what: string): Promise<T[]> {
  const data = await readOkBody(res, what);
  if (!Array.isArray(data)) throw new LoadError(`${what} could not be loaded: the server did not send a list.`);
  return data as T[];
}

/** The object a load answered. Throws a LoadError when the request failed or the body is not a JSON object. */
export async function readJsonObject<T = Record<string, any>>(res: Response, what: string): Promise<T> {
  const data = await readOkBody(res, what);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new LoadError(`${what} could not be loaded: the server did not send what the page shows.`);
  }
  return data as T;
}

/** What a page says about a failed load: the LoadError's message, or a network failure for anything else (fetch rejects with a TypeError). */
export function loadErrorMessage(err: unknown, what: string): string {
  if (err instanceof LoadError) return err.message;
  return `${what} could not be loaded. Check your connection and try again.`;
}

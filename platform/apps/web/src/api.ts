import { useCallback, useEffect, useRef, useState } from "react";
let csrfToken: string | undefined;
export function setCsrfToken(token?: string) {
  csrfToken = token;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const mutation =
    options.method && !["GET", "HEAD"].includes(options.method.toUpperCase());
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.body || mutation ? { "Content-Type": "application/json" } : {}),
    ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    ...((options.headers as Record<string, string>) || {}),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      headers,
      credentials: "same-origin",
      signal: options.signal || controller.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError")
      throw new ApiError(
        "The request timed out. Check the connection and try again.",
        0,
      );
    throw new ApiError(
      "Cannot reach the server. Displayed data may be stale.",
      0,
    );
  } finally {
    clearTimeout(timeout);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json"))
    throw new ApiError(
      "The server returned an unexpected response. Check that the API service is running.",
      response.status,
    );
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      typeof data.error === "string"
        ? data.error
        : data.message ||
          data.error?.message ||
          `Request failed (${response.status}).`,
      response.status,
    );
  }
  return data as T;
}
export function useResource<T>(path: string | null, interval = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!path) return;
    const id = ++generation.current;
    setRefreshing(true);
    try {
      const next = await api<T>(path);
      if (generation.current === id) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (generation.current === id) setError((e as Error).message);
    } finally {
      if (generation.current === id) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    setLoading(true);
    setError("");
    void refresh();
    const t = interval
      ? setInterval(() => {
          if (!document.hidden) void refresh();
        }, interval)
      : undefined;
    return () => {
      generation.current++;
      if (t) clearInterval(t);
    };
  }, [refresh, interval]);
  return { data, setData, error, loading, refreshing, refresh };
}
export interface StreamEvent {
  name: string;
  data: unknown;
}
export interface StreamBatch {
  events: StreamEvent[];
  id: number;
}
export function useEvents(
  enabled: boolean,
  onEvents: (events: StreamEvent[]) => void,
) {
  const fn = useRef(onEvents);
  fn.current = onEvents;
  const [state, setState] = useState("connecting");
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource("/api/v1/events", { withCredentials: true });
    const queue: StreamEvent[] = [];
    source.onopen = () => setState("connected");
    source.onerror = () => setState("reconnecting");
    for (const name of ["snapshot", "tick", "feed", "research"])
      source.addEventListener(name, (event) => {
        try {
          queue.push({ name, data: JSON.parse((event as MessageEvent).data) });
        } catch {
          setState("invalid event");
        }
      });
    // Preserve every print in a provider burst while rendering at most 20 times per second.
    const flush = setInterval(() => {
      if (queue.length) fn.current(queue.splice(0));
    }, 50);
    return () => {
      clearInterval(flush);
      source.close();
    };
  }, [enabled]);
  return state;
}

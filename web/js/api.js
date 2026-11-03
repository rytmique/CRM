const TOKEN_KEY = 'agc_token';

export const session = {
  get token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  set token(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
  user: null,
};

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Немає зв’язку з сервером');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/login') {
    session.token = '';
    onUnauthorized();
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Помилка ${res.status}`);
  return data;
}

export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const put = (p, body = {}) => api(p, { method: 'PUT', body });
export const patch = (p, body = {}) => api(p, { method: 'PATCH', body });
export const del = (p) => api(p, { method: 'DELETE' });

/** Uploads one file as the raw request body. */
export async function upload(path, file) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), authorization: `Bearer ${session.token}` },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'Немає зв’язку з сервером');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || (res.status === 413 ? 'Файл завеликий' : `Помилка ${res.status}`));
  return data;
}

/** A protected file as an object URL (for <img> previews). */
export async function blobUrl(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${session.token}` } });
  if (!res.ok) throw new ApiError(res.status, 'Файл недоступний');
  return URL.createObjectURL(await res.blob());
}

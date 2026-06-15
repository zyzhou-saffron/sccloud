/**
 * scCloud v2 — API 调用工具库
 * 统一封装所有后端 API 调用，自动注入 JWT + 错误处理。
 *
 * 所有请求均使用相对路径 (/api/...)
 * 本地开发: Next.js rewrites 代理至后端
 * 生产环境: Nginx 反代 /api/* → backend:8000
 */

/** API 基地址 — 空字符串表示同源相对路径 */
const API_BASE = "";

/* ===== 存储层隔离 =====
 * 游客 token → sessionStorage（标签页隔离）
 * 正式用户 token → localStorage（跨标签页持久）
 */

const AUTH_KEYS = ["access_token", "refresh_token", "username", "role", "is_guest"];

export function getAuthItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(key) ?? localStorage.getItem(key);
}

function removeAuthItem(key: string): void {
  sessionStorage.removeItem(key);
  localStorage.removeItem(key);
}

function clearAllAuth(): void {
  AUTH_KEYS.forEach(k => removeAuthItem(k));
}

/* ===== Refresh Token 自动续期机制 ===== */

/**
 * 共享的刷新锁 — 防止多个并发请求同时触发 refresh。
 * 第一个遇到 401 的请求执行 refresh，后续请求等待同一个 Promise。
 */
let refreshPromise: Promise<string | null> | null = null;

/**
 * 调用 POST /api/auth/refresh 获取新的 access_token。
 * 成功时更新对应 storage 并返回新 token；失败返回 null。
 */
async function doRefreshToken(): Promise<string | null> {
  const refreshToken = getAuthItem("refresh_token");
  if (!refreshToken) return null;

  const guest = getAuthItem("is_guest") === "true";
  const storage = guest ? sessionStorage : localStorage;

  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    storage.setItem("access_token", data.access_token);
    if (data.refresh_token) {
      storage.setItem("refresh_token", data.refresh_token);
    }
    if (data.username) {
      storage.setItem("username", data.username);
      storage.setItem("role", data.role || "user");
    }
    return data.access_token as string;
  } catch {
    return null;
  }
}

/**
 * 尝试刷新 token（带并发锁）。
 * 多个请求同时 401 时，只有第一个真正执行 refresh，其余复用结果。
 */
export async function tryRefresh(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = doRefreshToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/** 清除登录态并跳转首页 */
function forceLogout(): never {
  clearAllAuth();
  window.location.href = "/";
  throw new Error("登录已过期，请重新登录");
}

/** Guest 登录兜底 — 当 refresh 失败时自动获取新 guest token（存入 sessionStorage） */
async function guestLoginFallback(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/guest`, { method: "POST" });
    if (!res.ok) return null;
    const data = await res.json();
    sessionStorage.setItem("access_token", data.access_token);
    if (data.refresh_token) sessionStorage.setItem("refresh_token", data.refresh_token);
    if (data.username) sessionStorage.setItem("username", data.username);
    sessionStorage.setItem("role", data.role || "user");
    sessionStorage.setItem("is_guest", "true");
    return data.access_token as string;
  } catch {
    return null;
  }
}

/** 通用 fetch 封装 — 自动注入 auth header + 401 自动续期 */
export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getAuthItem("access_token");

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  /* 如果 body 不是 FormData，默认 JSON content type */
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    /* 401 = token 过期 → 尝试用 refresh_token 续期 */
    if (res.status === 401 && typeof window !== "undefined") {
      const newToken = await tryRefresh();
      if (newToken) {
        /* 续期成功 — 用新 token 重试原请求 */
        headers["Authorization"] = `Bearer ${newToken}`;
        const retry = await fetch(`${API_BASE}${path}`, {
          ...options,
          headers,
        });
        if (retry.ok) {
          if (retry.status === 204) return undefined as T;
          return retry.json();
        }
        if (retry.status === 401) {
          /* 重试仍 401 → 尝试 guest 登录兜底 */
          const guestToken = await guestLoginFallback();
          if (guestToken) {
            headers["Authorization"] = `Bearer ${guestToken}`;
            const retry2 = await fetch(`${API_BASE}${path}`, { ...options, headers });
            if (retry2.ok) {
              if (retry2.status === 204) return undefined as T;
              return retry2.json();
            }
          }
          forceLogout();
        }
        const text = await retry.text();
        throw new Error(`API ${retry.status}: ${text}`);
      }
      /* refresh 也失败 → 尝试 guest 登录兜底 */
      const guestToken = await guestLoginFallback();
      if (guestToken) {
        headers["Authorization"] = `Bearer ${guestToken}`;
        const retry = await fetch(`${API_BASE}${path}`, { ...options, headers });
        if (retry.ok) {
          if (retry.status === 204) return undefined as T;
          return retry.json();
        }
      }
      forceLogout();
    }

    let text = await res.text(); try { const j = JSON.parse(text); if (j.detail) text = j.detail; } catch {}
    throw new Error(text);
  }

  // 204 No Content — 无响应体，直接返回 undefined
  if (res.status === 204) return undefined as T;

  return res.json();
}

/* ===== Auth ===== */

interface AuthResponse {
  role?: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  username: string;
}

export async function login(
  username: string,
  password: string
): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }),
  });
  if (!res.ok) throw new Error("登录失败");
  return res.json();
}

export async function register(
  username: string,
  password: string
): Promise<AuthResponse> {
  return apiFetch<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

/**
 * 游客登录 — 无需用户名密码，后端自动创建临时用户。
 */
export async function guestLogin(): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/guest`, { method: "POST" });
  if (!res.ok) throw new Error("游客登录失败");
  return res.json();
}

/**
 * 游客升级 — 将临时 guest 账号转为正式注册用户。
 */
export async function upgradeGuest(
  username: string,
  password: string
): Promise<AuthResponse> {
  return apiFetch<AuthResponse>("/api/auth/upgrade", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

/**
 * 保存认证数据。游客 → sessionStorage（标签页隔离），正式用户 → localStorage。
 */
export function saveAuthData(data: AuthResponse, guest = false): void {
  const storage = guest ? sessionStorage : localStorage;
  storage.setItem("access_token", data.access_token);
  storage.setItem("refresh_token", data.refresh_token);
  storage.setItem("username", data.username);
  storage.setItem("role", data.role || "user");
  storage.setItem("is_guest", guest ? "true" : "false");
  // 清除另一个 storage 的旧数据，避免冲突
  const other = guest ? localStorage : sessionStorage;
  AUTH_KEYS.forEach(k => other.removeItem(k));
}

/**
 * 游客升级为正式用户后，将 token 从 sessionStorage 迁移到 localStorage。
 */
export function moveGuestToUser(data: AuthResponse): void {
  AUTH_KEYS.forEach(k => sessionStorage.removeItem(k));
  localStorage.setItem("access_token", data.access_token);
  localStorage.setItem("refresh_token", data.refresh_token);
  localStorage.setItem("username", data.username);
  localStorage.setItem("role", data.role || "user");
  localStorage.setItem("is_guest", "false");
}

/**
 * 检查当前用户是否为游客。
 */
export function isGuest(): boolean {
  return getAuthItem("is_guest") === "true";
}

export function getUserRole(): string {
  return getAuthItem("role") || "user";
}

export function hasPhase2Access(): boolean {
  const role = getUserRole();
  return role === "super" || role === "admin";
}

export function getAuthToken(): string | null {
  return getAuthItem("access_token");
}

export function clearAuthData(): void {
  clearAllAuth();
}

export const ROLE_LABELS: Record<string, string> = {
  guest: "游客",
  user: "注册用户",
  super: "付费用户",
  admin: "管理员",
};

/* ===== Projects ===== */

export interface Project {
  id: number;
  name: string;
  description: string | null;
  species: string;
  status: string;
  storage_path: string | null;
  created_at: string;
  updated_at: string;
  has_analyzed?: boolean;
}

interface ProjectList {
  total: number;
  projects: Project[];
}

export async function listProjects(): Promise<ProjectList> {
  return apiFetch<ProjectList>("/api/projects");
}

export async function createProject(data: {
  name: string;
  description?: string;
  species?: string;
}): Promise<Project> {
  return apiFetch<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deleteProject(id: number): Promise<void> {
  await apiFetch<void>(`/api/projects/${id}`, { method: "DELETE" });
}

/* ===== Tasks ===== */

export interface Task {
  id: string;
  project_id: number;
  step: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  progress_message: string | null;
  params: Record<string, unknown> | null;
  result_path: string | null;
  error_msg: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface TaskList {
  total: number;
  tasks: Task[];
}

export async function submitTask(data: {
  project_id: number;
  step: string;
  params?: Record<string, unknown>;
}): Promise<Task> {
  return apiFetch<Task>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function listTasks(
  projectId?: number,
  status?: string
): Promise<TaskList> {
  const params = new URLSearchParams();
  if (projectId !== undefined) params.set("project_id", String(projectId));
  if (status) params.set("status", status);
  return apiFetch<TaskList>(`/api/tasks?${params.toString()}`);
}

export async function getTask(taskId: string): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${taskId}`);
}

export async function cancelTask(taskId: string): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${taskId}/cancel`, { method: "POST" });
}

export async function updateTaskResult(
  taskId: string,
  data: Record<string, unknown>
): Promise<{ status: string }> {
  return apiFetch<{ status: string }>(`/api/tasks/${taskId}/result`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

/* ===== WebSocket ===== */

/**
 * 创建 WebSocket 连接，监听任务进度。
 * R 引擎通过 Redis PUBLISH → FastAPI → WS → 前端
 */
export function connectTaskWS(
  taskId: string,
  onProgress: (data: { progress: number; message: string }) => void,
  onComplete?: () => void,
  onError?: (msg: string) => void
): WebSocket {
  /* 从当前页面 URL 自动推导 WebSocket 地址（同源） */
  const loc = typeof window !== "undefined" ? window.location : null;
  const wsProto = loc?.protocol === "https:" ? "wss:" : "ws:";
  const wsHost = loc?.host || "localhost:8000";
  const ws = new WebSocket(`${wsProto}//${wsHost}/ws/tasks/${taskId}`);

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    onProgress(data);

    if (data.progress >= 100) {
      onComplete?.();
    }
    if (data.status === "failed") {
      onError?.(data.error_msg || "分析任务失败");
    }
  };

  ws.onerror = () => {
    onError?.("WebSocket 连接失败");
  };

  return ws;
}

/* ===== Health ===== */

export async function healthCheck(): Promise<{
  status: string;
  version: string;
  db: string;
  redis: string;
}> {
  return apiFetch("/api/health");
}

/* ===== 分片上传 ===== */

interface UploadProgress {
  phase: "uploading" | "merging" | "done";
  percent: number;
  chunkIndex: number;
  totalChunks: number;
}

/**
 * 分片上传大文件 (RDS/H5AD)。
 * 流程: init → chunk × N → complete
 */
export async function uploadFileChunked(
  file: File,
  projectId?: number,
  onProgress?: (p: UploadProgress) => void
): Promise<{ path: string; filename: string; size_mb: number }> {
  const initForm = new FormData();
  initForm.append("filename", file.name);
  initForm.append("file_size", String(file.size));

  const initRes = await apiFetch<{ upload_id: string; chunk_size: number }>(
    "/api/upload/init",
    { method: "POST", body: initForm }
  );

  const { upload_id, chunk_size } = initRes;
  const totalChunks = Math.ceil(file.size / chunk_size);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunk_size;
    const end = Math.min(start + chunk_size, file.size);
    const blob = file.slice(start, end);

    const chunkForm = new FormData();
    chunkForm.append("upload_id", upload_id);
    chunkForm.append("chunk_index", String(i));
    chunkForm.append("chunk", blob, `chunk_${i}`);

    await apiFetch("/api/upload/chunk", {
      method: "POST",
      body: chunkForm,
    });

    onProgress?.({
      phase: "uploading",
      percent: Math.round(((i + 1) / totalChunks) * 90),
      chunkIndex: i + 1,
      totalChunks,
    });
  }

  onProgress?.({
    phase: "merging",
    percent: 95,
    chunkIndex: totalChunks,
    totalChunks,
  });

  const completeForm = new FormData();
  completeForm.append("upload_id", upload_id);
  if (projectId !== undefined) {
    completeForm.append("project_id", String(projectId));
  }

  const result = await apiFetch<{
    status: string;
    path: string;
    filename: string;
    size_mb: number;
    total_chunks: number;
  }>("/api/upload/complete", {
    method: "POST",
    body: completeForm,
  });

  onProgress?.({
    phase: "done",
    percent: 100,
    chunkIndex: totalChunks,
    totalChunks,
  });

  return {
    path: result.path,
    filename: result.filename,
    size_mb: result.size_mb,
  };
}


/* ===== 项目文件列表 ===== */

export interface ProjectFile {
  filename: string;
  path: string;
  size_mb: number;
}

export async function listProjectFiles(projectId: number): Promise<ProjectFile[]> {
  const res = await apiFetch<{ files: ProjectFile[] }>(`/api/projects/${projectId}/files`);
  return res.files;
}

export interface InspectResult {
  filename: string;
  n_rows: number;
  n_cols: number;
  genes: string[];
  gene_ids: string[];
  file_size_mb: number;
  metadata_columns: string[];
  samples?: { name: string; cell_count: number }[];
  ensembl_version?: string;
}

export async function inspectFileByPath(filePath: string): Promise<InspectResult> {
  const form = new FormData();
  form.append("file_path", filePath);
  return apiFetch<InspectResult>("/api/upload/inspect-path", {
    method: "POST",
    body: form,
  });
}


// ===== 管理员 API =====

export interface AdminUser {
  id: number;
  username: string;
  email: string | null;
  role: string;
  is_guest: boolean;
  max_projects: number;
  total_quota: number;
  used_quota: number;
  is_active: boolean;
  created_at: string | null;
}

export interface AdminUserListResponse {
  users: AdminUser[];
  total: number;
}

export async function listUsers(
  page = 1,
  pageSize = 20,
  search = ""
): Promise<AdminUserListResponse> {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (search) params.set("search", search);
  return apiFetch<AdminUserListResponse>("/api/admin/users?" + params.toString());
}

export async function getUser(userId: number): Promise<AdminUser> {
  return apiFetch<AdminUser>("/api/admin/users/" + userId);
}

export async function updateUser(
  userId: number,
  data: Partial<Pick<AdminUser, "role" | "max_projects" | "total_quota" | "used_quota" | "is_active">>
): Promise<{ status: string }> {
  return apiFetch<{ status: string }>("/api/admin/users/" + userId, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteUser(userId: number): Promise<{ status: string }> {
  return apiFetch<{ status: string }>("/api/admin/users/" + userId, {
    method: "DELETE",
  });
}

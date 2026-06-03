/**
 * Pipeline API 调用函数
 */

import { apiFetch } from "./api";

export interface PipelineParams {
  project_id: number;
  params: Record<string, Record<string, unknown>>;
  marker_file_path?: string;
  skip_phase1?: boolean;
}

export interface PipelineTask {
  id: string;
  step: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "paused";
  progress: number;
  progress_message?: string;
  result_path?: string;
  error_msg?: string;
}

export interface ResumePipelineParams {
  params: Record<string, Record<string, unknown>>;
  enabled_steps: string[];
}

export interface Pipeline {
  id: string;
  project_id: number;
  user_id: number;
  status: string;
  current_step?: string;
  error_step?: string;
  error_msg?: string;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  tasks: PipelineTask[];
}

export async function createPipeline(
  token: string,
  data: PipelineParams
): Promise<{ pipeline_id: string; status: string; message: string }> {
  return apiFetch("/api/pipeline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function getPipeline(
  token: string,
  pipelineId: string
): Promise<Pipeline> {
  return apiFetch(`/api/pipeline/${pipelineId}`);
}

export async function listPipelines(
  token: string,
  projectId: number,
  limit: number = 10
): Promise<Pipeline[]> {
  return apiFetch(`/api/pipeline?project_id=${projectId}&limit=${limit}`);
}

export async function resumePipeline(
  token: string,
  pipelineId: string,
  params?: ResumePipelineParams
): Promise<{ pipeline_id: string; status: string; message: string }> {
  return apiFetch(`/api/pipeline/${pipelineId}/resume`, {
    method: "POST",
    headers: params ? { "Content-Type": "application/json" } : undefined,
    body: params ? JSON.stringify(params) : undefined,
  });
}

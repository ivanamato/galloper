// PlanSchema module: typed plan contract and validation
// Defines the JSON structure that planner outputs and taskrunner consumes

export type FileAction = 'create' | 'edit' | 'delete';

export interface FileSpec {
  path: string;
  action: FileAction;
}

export type FileSpecInput = string | { path?: string; action?: FileAction };

export interface PlanTask {
  id: string;
  title: string;
  files: FileSpec[];
  instructions: string;
  verify: string;
  dependsOn: string[];
  maxAttempts?: number;
}

export interface RetryPolicy {
  verify?: 'retry' | 'abort';
  hook?: 'retry' | 'abort';
  'executor-crash'?: 'retry' | 'abort';
}

export interface Plan {
  planId: string;
  prompt?: string;
  createdAt?: string;
  maxAttempts?: number;
  concurrency?: number;
  onTaskAbandoned?: 'continue' | 'abort' | 'abort-branch';
  retryPolicy?: RetryPolicy;
  tasks: PlanTask[];
}

function normalizeFileSpec(input: unknown, taskIndex: number): FileSpec {
  if (typeof input === 'string') {
    if (!input.trim()) {
      throw new Error(`Task[${taskIndex}] file path must be non-empty string`);
    }
    return { path: input, action: 'edit' };
  }

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    const path = obj.path;
    const action = obj.action ?? 'edit';

    if (typeof path !== 'string' || !path.trim()) {
      throw new Error(`Task[${taskIndex}] file spec must have non-empty "path" field`);
    }

    if (typeof action !== 'string' || !['create', 'edit', 'delete'].includes(action)) {
      throw new Error(`Task[${taskIndex}] file action must be 'create', 'edit', or 'delete', got: ${action}`);
    }

    return { path, action: action as FileAction };
  }

  throw new Error(`Task[${taskIndex}] file must be string or {path, action?} object`);
}

/**
 * Infer the file action (create/edit/delete) based on whether the file exists.
 * Used as an optional post-parse enhancement by the Planner to auto-detect
 * file operations when the LLM emits bare strings.
 *
 * @param filePath - The file path to check
 * @param existsFn - Optional function to check if file exists (defaults to checking existence)
 * @returns 'create' if file doesn't exist, 'edit' otherwise
 */
export function inferFileAction(filePath: string, existsFn?: (path: string) => boolean): FileAction {
  if (!existsFn) {
    return 'edit';
  }
  return existsFn(filePath) ? 'edit' : 'create';
}

export function parsePlan(raw: string): Plan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse plan JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Plan must be a JSON object (not an array or null)');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.planId !== 'string' || !obj.planId.trim()) {
    throw new Error('Plan must have a non-empty "planId" string field');
  }

  if (!Array.isArray(obj.tasks)) {
    throw new Error('Plan must have a "tasks" array field');
  }

  // Validate optional Plan fields
  if (obj.maxAttempts !== undefined && typeof obj.maxAttempts !== 'number') {
    throw new Error('Plan "maxAttempts" must be a number');
  }
  if (obj.concurrency !== undefined && typeof obj.concurrency !== 'number') {
    throw new Error('Plan "concurrency" must be a number');
  }
  if (obj.onTaskAbandoned !== undefined && !['continue', 'abort', 'abort-branch'].includes(obj.onTaskAbandoned as string)) {
    throw new Error('Plan "onTaskAbandoned" must be "continue", "abort", or "abort-branch"');
  }
  if (obj.prompt !== undefined && typeof obj.prompt !== 'string') {
    throw new Error('Plan "prompt" must be a string');
  }
  if (obj.createdAt !== undefined && typeof obj.createdAt !== 'string') {
    throw new Error('Plan "createdAt" must be a string');
  }

  const tasks = obj.tasks as unknown[];
  const parsedTasks: PlanTask[] = [];

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new Error(`Task at index ${i} must be an object`);
    }

    const taskObj = task as Record<string, unknown>;

    if (typeof taskObj.id !== 'string' || !taskObj.id.trim()) {
      throw new Error(`Task[${i}] missing or invalid "id" field (must be non-empty string)`);
    }

    if (typeof taskObj.title !== 'string' || !taskObj.title.trim()) {
      throw new Error(`Task[${i}] missing or invalid "title" field (must be non-empty string)`);
    }

    if (!Array.isArray(taskObj.files)) {
      throw new Error(`Task[${i}] "files" must be an array`);
    }

    // Normalize and validate files
    const normalizedFiles: FileSpec[] = [];
    const seenPaths = new Set<string>();
    for (const file of taskObj.files) {
      const spec = normalizeFileSpec(file, i);
      if (seenPaths.has(spec.path)) {
        throw new Error(`Task[${i}] duplicate file path: ${spec.path}`);
      }
      seenPaths.add(spec.path);
      normalizedFiles.push(spec);
    }

    if (typeof taskObj.instructions !== 'string' || !taskObj.instructions.trim()) {
      throw new Error(`Task[${i}] missing or invalid "instructions" field (must be non-empty string)`);
    }

    if (typeof taskObj.verify !== 'string' || !taskObj.verify.trim()) {
      throw new Error(`Task[${i}] missing or invalid "verify" field (must be non-empty string)`);
    }

    if (!Array.isArray(taskObj.dependsOn) || !taskObj.dependsOn.every((d) => typeof d === 'string')) {
      throw new Error(`Task[${i}] missing or invalid "dependsOn" field (must be array of strings)`);
    }

    if (taskObj.maxAttempts !== undefined && typeof taskObj.maxAttempts !== 'number') {
      throw new Error(`Task[${i}] "maxAttempts" must be a number`);
    }

    parsedTasks.push({
      id: taskObj.id as string,
      title: taskObj.title as string,
      files: normalizedFiles,
      instructions: taskObj.instructions as string,
      verify: taskObj.verify as string,
      dependsOn: taskObj.dependsOn as string[],
      maxAttempts: taskObj.maxAttempts as number | undefined,
    });
  }

  return {
    planId: obj.planId as string,
    prompt: obj.prompt as string | undefined,
    createdAt: obj.createdAt as string | undefined,
    maxAttempts: obj.maxAttempts as number | undefined,
    concurrency: obj.concurrency as number | undefined,
    onTaskAbandoned: obj.onTaskAbandoned as 'continue' | 'abort' | 'abort-branch' | undefined,
    tasks: parsedTasks,
  };
}

export function topoSort(tasks: PlanTask[]): PlanTask[] {
  const taskMap = new Map<string, PlanTask>();
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const task of tasks) {
    taskMap.set(task.id, task);
    inDegree.set(task.id, 0);
    adjList.set(task.id, []);
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!taskMap.has(dep)) {
        throw new Error(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
      const adjListForDep = adjList.get(dep);
      if (adjListForDep && !adjListForDep.includes(task.id)) {
        adjListForDep.push(task.id);
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [taskId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(taskId);
    }
  }

  const sorted: PlanTask[] = [];
  while (queue.length > 0) {
    const taskId = queue.shift();
    if (!taskId) break;

    const task = taskMap.get(taskId);
    if (task) {
      sorted.push(task);
    }

    const neighbors = adjList.get(taskId) ?? [];
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (sorted.length !== tasks.length) {
    throw new Error('Cycle detected in task dependency graph');
  }

  return sorted;
}

export function readyTasks(tasks: PlanTask[], completed: Set<string>): PlanTask[] {
  return tasks.filter((task) => task.dependsOn.every((dep) => completed.has(dep)));
}

export function descendantsOf(taskId: string, tasks: PlanTask[]): PlanTask[] {
  const descendants: PlanTask[] = [];
  const visited = new Set<string>();
  const queue: string[] = [taskId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);

    for (const task of tasks) {
      if (task.dependsOn.includes(currentId) && !visited.has(task.id)) {
        descendants.push(task);
        queue.push(task.id);
      }
    }
  }

  return descendants;
}

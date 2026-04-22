import { describe, it, expect } from 'vitest';
import { parsePlan, topoSort, PlanTask, inferFileAction } from '../../src/lib/PlanSchema.js';

describe('PlanSchema', () => {
  describe('parsePlan', () => {
    it('should parse valid plan JSON', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            files: [{ path: '/path/to/file.ts', action: 'edit' }],
            instructions: 'Do something',
            verify: 'echo ok',
            dependsOn: [],
          },
        ],
      });

      const plan = parsePlan(json);
      expect(plan.planId).toBe('plan-1');
      expect(plan.tasks).toHaveLength(1);
      expect(plan.tasks[0]?.id).toBe('t1');
      expect(plan.tasks[0]?.title).toBe('Task 1');
      expect(plan.tasks[0]?.files).toEqual([{ path: '/path/to/file.ts', action: 'edit' }]);
      expect(plan.tasks[0]?.verify).toBe('echo ok');
      expect(plan.tasks[0]?.dependsOn).toEqual([]);
    });

    it('should throw on missing planId', () => {
      const json = JSON.stringify({
        tasks: [],
      });

      expect(() => parsePlan(json)).toThrow('planId');
    });

    it('should throw on empty planId', () => {
      const json = JSON.stringify({
        planId: '   ',
        tasks: [],
      });

      expect(() => parsePlan(json)).toThrow('planId');
    });

    it('should throw on missing tasks array', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
      });

      expect(() => parsePlan(json)).toThrow('tasks');
    });

    it('should throw on non-array tasks field', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: 'not an array',
      });

      expect(() => parsePlan(json)).toThrow('tasks');
    });

    it('should throw on task missing id', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: [
          {
            title: 'Task 1',
            files: [],
            instructions: 'Do something',
            verify: 'echo ok',
            dependsOn: [],
          },
        ],
      });

      expect(() => parsePlan(json)).toThrow('id');
    });

    it('should throw on task missing title', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: [
          {
            id: 't1',
            files: [],
            instructions: 'Do something',
            verify: 'echo ok',
            dependsOn: [],
          },
        ],
      });

      expect(() => parsePlan(json)).toThrow('title');
    });

    it('should throw on task missing files', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            instructions: 'Do something',
            verify: 'echo ok',
            dependsOn: [],
          },
        ],
      });

      expect(() => parsePlan(json)).toThrow('files');
    });

    it('should throw on task missing instructions', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            files: [],
            verify: 'echo ok',
            dependsOn: [],
          },
        ],
      });

      expect(() => parsePlan(json)).toThrow('instructions');
    });

    it('should throw on task missing verify', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            files: [],
            instructions: 'Do something',
            dependsOn: [],
          },
        ],
      });

      expect(() => parsePlan(json)).toThrow('verify');
    });

    it('should throw on task missing dependsOn', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            files: [],
            instructions: 'Do something',
            verify: 'echo ok',
          },
        ],
      });

      expect(() => parsePlan(json)).toThrow('dependsOn');
    });

    it('should throw on invalid JSON', () => {
      expect(() => parsePlan('not valid json')).toThrow('Failed to parse plan JSON');
    });

    it('should throw on JSON that is not an object', () => {
      expect(() => parsePlan('["array"]')).toThrow('must be a JSON object');
    });

    it('should handle multiple tasks', () => {
      const json = JSON.stringify({
        planId: 'plan-2',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            files: [{ path: '/a.ts', action: 'edit' }],
            instructions: 'Inst 1',
            verify: 'test 1',
            dependsOn: [],
          },
          {
            id: 't2',
            title: 'Task 2',
            files: [{ path: '/b.ts', action: 'create' }],
            instructions: 'Inst 2',
            verify: 'test 2',
            dependsOn: ['t1'],
          },
        ],
      });

      const plan = parsePlan(json);
      expect(plan.tasks).toHaveLength(2);
      expect(plan.tasks[0]?.dependsOn).toEqual([]);
      expect(plan.tasks[1]?.dependsOn).toEqual(['t1']);
    });

    it('should normalize string files to FileSpec with default action edit', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            files: ['/file1.ts', '/file2.ts'],
            instructions: 'Do something',
            verify: 'echo ok',
            dependsOn: [],
          },
        ],
      });

      const plan = parsePlan(json);
      expect(plan.tasks[0]?.files).toEqual([
        { path: '/file1.ts', action: 'edit' },
        { path: '/file2.ts', action: 'edit' },
      ]);
    });

    it('should accept FileSpec objects with action', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            files: [
              { path: '/new.ts', action: 'create' },
              { path: '/edit.ts', action: 'edit' },
              { path: '/delete.ts', action: 'delete' },
            ],
            instructions: 'Do something',
            verify: 'echo ok',
            dependsOn: [],
          },
        ],
      });

      const plan = parsePlan(json);
      expect(plan.tasks[0]?.files).toEqual([
        { path: '/new.ts', action: 'create' },
        { path: '/edit.ts', action: 'edit' },
        { path: '/delete.ts', action: 'delete' },
      ]);
    });

    it('should throw on invalid file action', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            files: [{ path: '/file.ts', action: 'invalid' }],
            instructions: 'Do something',
            verify: 'echo ok',
            dependsOn: [],
          },
        ],
      });

      expect(() => parsePlan(json)).toThrow('action must be');
    });

    it('should throw on duplicate file paths', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            files: ['/file.ts', '/file.ts'],
            instructions: 'Do something',
            verify: 'echo ok',
            dependsOn: [],
          },
        ],
      });

      expect(() => parsePlan(json)).toThrow('duplicate');
    });

    it('should parse optional Plan fields', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        prompt: 'make a todo app',
        createdAt: '2026-04-17T15:00:00Z',
        maxAttempts: 5,
        onTaskAbandoned: 'abort',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            files: [],
            instructions: 'Do something',
            verify: 'echo ok',
            dependsOn: [],
            maxAttempts: 3,
          },
        ],
      });

      const plan = parsePlan(json);
      expect(plan.prompt).toBe('make a todo app');
      expect(plan.createdAt).toBe('2026-04-17T15:00:00Z');
      expect(plan.maxAttempts).toBe(5);
      expect(plan.onTaskAbandoned).toBe('abort');
      expect(plan.tasks[0]?.maxAttempts).toBe(3);
    });

    it('should throw on invalid onTaskAbandoned value', () => {
      const json = JSON.stringify({
        planId: 'plan-1',
        onTaskAbandoned: 'invalid',
        tasks: [],
      });

      expect(() => parsePlan(json)).toThrow('onTaskAbandoned');
    });
  });

  describe('inferFileAction', () => {
    it('should return "create" when file does not exist', () => {
      const action = inferFileAction('/nonexistent/file.ts', () => false);
      expect(action).toBe('create');
    });

    it('should return "edit" when file exists', () => {
      const action = inferFileAction('/existing/file.ts', () => true);
      expect(action).toBe('edit');
    });

    it('should return "edit" when existsFn is undefined', () => {
      const action = inferFileAction('/some/file.ts');
      expect(action).toBe('edit');
    });
  });

  describe('topoSort', () => {
    it('should sort tasks with no dependencies', () => {
      const tasks: PlanTask[] = [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Inst',
          verify: 'test',
          dependsOn: [],
        },
        {
          id: 't2',
          title: 'Task 2',
          files: [],
          instructions: 'Inst',
          verify: 'test',
          dependsOn: [],
        },
      ];

      const sorted = topoSort(tasks);
      expect(sorted).toHaveLength(2);
      expect(sorted.map((t) => t.id)).toEqual(['t1', 't2']);
    });

    it('should sort linear dependency chain', () => {
      const tasks: PlanTask[] = [
        {
          id: 't3',
          title: 'Task 3',
          files: [],
          instructions: 'Inst',
          verify: 'test',
          dependsOn: ['t2'],
        },
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Inst',
          verify: 'test',
          dependsOn: [],
        },
        {
          id: 't2',
          title: 'Task 2',
          files: [],
          instructions: 'Inst',
          verify: 'test',
          dependsOn: ['t1'],
        },
      ];

      const sorted = topoSort(tasks);
      expect(sorted.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    });

    it('should detect cycles', () => {
      const tasks: PlanTask[] = [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Inst',
          verify: 'test',
          dependsOn: ['t2'],
        },
        {
          id: 't2',
          title: 'Task 2',
          files: [],
          instructions: 'Inst',
          verify: 'test',
          dependsOn: ['t1'],
        },
      ];

      expect(() => topoSort(tasks)).toThrow('Cycle detected');
    });

    it('should throw on reference to unknown task', () => {
      const tasks: PlanTask[] = [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Inst',
          verify: 'test',
          dependsOn: ['unknown'],
        },
      ];

      expect(() => topoSort(tasks)).toThrow('depends on unknown task');
    });

    it('should handle complex multi-level dependencies', () => {
      const tasks: PlanTask[] = [
        { id: 't1', title: 'T1', files: [], instructions: '', verify: '', dependsOn: [] },
        { id: 't2', title: 'T2', files: [], instructions: '', verify: '', dependsOn: ['t1'] },
        { id: 't3', title: 'T3', files: [], instructions: '', verify: '', dependsOn: ['t1'] },
        { id: 't4', title: 'T4', files: [], instructions: '', verify: '', dependsOn: ['t2', 't3'] },
      ];

      const sorted = topoSort(tasks);
      const ids = sorted.map((t) => t.id);

      expect(ids[0]).toBe('t1');
      expect(ids.indexOf('t2')).toBeGreaterThan(0);
      expect(ids.indexOf('t3')).toBeGreaterThan(0);
      expect(ids.indexOf('t4')).toBeGreaterThan(ids.indexOf('t2'));
      expect(ids.indexOf('t4')).toBeGreaterThan(ids.indexOf('t3'));
    });

    it('should preserve order for independent tasks', () => {
      const tasks: PlanTask[] = [
        { id: 't1', title: 'T1', files: [], instructions: '', verify: '', dependsOn: [] },
        { id: 't2', title: 'T2', files: [], instructions: '', verify: '', dependsOn: [] },
        { id: 't3', title: 'T3', files: [], instructions: '', verify: '', dependsOn: [] },
      ];

      const sorted = topoSort(tasks);
      expect(sorted.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    });
  });
});

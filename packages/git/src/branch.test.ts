/**
 * Tests for base-branch resolution and merge checks.
 *
 * These run against real git repositories rather than mocked exec output. The
 * bug they cover — a configured base branch that exists only as a remote-tracking
 * ref — is entirely about how git itself resolves a bare branch name, so mocking
 * the git call would have asserted our assumptions instead of git's behavior.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';

// Defined inline rather than imported: mock.module replaces the *entire*
// @archon/paths module, so the mock must not depend on anything from it.
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { execFileAsync } from './exec';
import { isBranchMerged, resolveBranchRef } from './branch';
import { toRepoPath, toBranchName } from './types';

const git = (cwd: string, ...args: string[]) => execFileAsync('git', ['-C', cwd, ...args]);

/**
 * Build an "origin" repo with a `staging` branch, then clone it. The clone ends
 * up with `origin/staging` as a remote-tracking ref and NO local `staging`
 * branch — exactly the shape of the kwenv-fleetillo checkout in production.
 */
async function makeClonedRepo(root: string): Promise<{ origin: string; clone: string }> {
  const origin = join(root, 'origin');
  await mkdir(origin, { recursive: true });
  await git(origin, 'init', '--initial-branch=main');
  await git(origin, 'config', 'user.email', 'test@example.com');
  await git(origin, 'config', 'user.name', 'Test');
  await git(origin, 'commit', '--allow-empty', '-m', 'root commit');
  await git(origin, 'branch', 'staging');

  const clone = join(root, 'clone');
  await execFileAsync('git', ['clone', origin, clone]);
  await git(clone, 'config', 'user.email', 'test@example.com');
  await git(clone, 'config', 'user.name', 'Test');
  return { origin, clone };
}

describe('branch resolution', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `branch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // ==========================================================================
  // The precondition this whole fix rests on
  // ==========================================================================

  test('git cannot resolve a bare name that exists only as a remote-tracking ref', async () => {
    const { clone } = await makeClonedRepo(root);

    // Sanity: the remote-tracking ref really is there...
    const { stdout } = await git(clone, 'branch', '-a', '--list', '*staging*');
    expect(stdout).toContain('remotes/origin/staging');

    // ...but a bare `staging` still does not resolve, because git checks
    // refs/heads, refs/tags and refs/remotes/<name> — never refs/remotes/origin/<name>.
    await expect(git(clone, 'branch', '--merged', 'staging')).rejects.toThrow();
  });

  // ==========================================================================
  // resolveBranchRef
  // ==========================================================================

  test('returns the bare name when a local branch exists', async () => {
    const { clone } = await makeClonedRepo(root);
    const resolved = await resolveBranchRef(toRepoPath(clone), toBranchName('main'));
    expect(resolved).toBe('main');
  });

  test('falls back to origin/<branch> when only the remote-tracking ref exists', async () => {
    const { clone } = await makeClonedRepo(root);
    const resolved = await resolveBranchRef(toRepoPath(clone), toBranchName('staging'));
    expect(resolved).toBe('origin/staging');
  });

  test('prefers the local branch over the remote-tracking ref', async () => {
    const { clone } = await makeClonedRepo(root);
    await git(clone, 'branch', 'staging', 'origin/staging');
    const resolved = await resolveBranchRef(toRepoPath(clone), toBranchName('staging'));
    expect(resolved).toBe('staging');
  });

  test('returns null when the branch exists nowhere', async () => {
    const { clone } = await makeClonedRepo(root);
    const resolved = await resolveBranchRef(toRepoPath(clone), toBranchName('nope'));
    expect(resolved).toBeNull();
  });

  test('returns null for a non-repository instead of throwing', async () => {
    const notARepo = join(root, 'plain');
    await mkdir(notARepo, { recursive: true });
    const resolved = await resolveBranchRef(toRepoPath(notARepo), toBranchName('main'));
    expect(resolved).toBeNull();
  });

  test('an already-qualified origin/<branch> resolves as given', async () => {
    const { clone } = await makeClonedRepo(root);
    const resolved = await resolveBranchRef(toRepoPath(clone), toBranchName('origin/staging'));
    expect(resolved).toBe('origin/staging');
  });

  // ==========================================================================
  // isBranchMerged
  // ==========================================================================

  test('reports a merged branch against a remote-tracking base', async () => {
    const { clone } = await makeClonedRepo(root);
    // A branch pointing at origin/staging is trivially merged into it.
    await git(clone, 'branch', 'archon/thread-merged', 'origin/staging');

    const merged = await isBranchMerged(
      toRepoPath(clone),
      toBranchName('archon/thread-merged'),
      toBranchName('origin/staging')
    );
    expect(merged).toBe(true);
  });

  test('reports an unmerged branch as unmerged', async () => {
    const { clone } = await makeClonedRepo(root);
    await git(clone, 'checkout', '-b', 'archon/thread-ahead', 'origin/staging');
    await git(clone, 'commit', '--allow-empty', '-m', 'extra work');
    await git(clone, 'checkout', 'main');

    const merged = await isBranchMerged(
      toRepoPath(clone),
      toBranchName('archon/thread-ahead'),
      toBranchName('origin/staging')
    );
    expect(merged).toBe(false);
  });

  test('an unresolvable base branch degrades to "not merged" instead of throwing', async () => {
    const { clone } = await makeClonedRepo(root);
    mockLogger.error.mockClear();

    // This is the production failure: git emits "malformed object name staging".
    // Cleanup must treat it as "cannot confirm merged" and leave the branch alone,
    // not throw once per environment on every tick.
    const merged = await isBranchMerged(
      toRepoPath(clone),
      toBranchName('archon/thread-x'),
      toBranchName('staging')
    );
    expect(merged).toBe(false);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('a missing repository degrades to "not merged"', async () => {
    const merged = await isBranchMerged(
      toRepoPath(join(root, 'does-not-exist')),
      toBranchName('any'),
      toBranchName('main')
    );
    expect(merged).toBe(false);
  });
});

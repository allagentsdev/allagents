import { describe, it, expect } from 'bun:test';
import { parseMarketplaceSource } from '../../../src/core/marketplace.js';
import { parseMarketplaceLocation } from '../../../src/utils/plugin-path.js';

describe('parseMarketplaceLocation', () => {
  it('should parse owner/repo without branch', () => {
    expect(parseMarketplaceLocation('owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('should parse owner/repo with simple branch', () => {
    expect(parseMarketplaceLocation('owner/repo/my-branch')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'my-branch',
    });
  });

  it('should parse owner/repo with nested branch', () => {
    expect(
      parseMarketplaceLocation('WiseTechGlobal/CargoWise.Shared/feat/v2'),
    ).toEqual({
      owner: 'WiseTechGlobal',
      repo: 'CargoWise.Shared',
      branch: 'feat/v2',
    });
  });
});

describe('parseMarketplaceSource branch extraction', () => {
  it('should extract branch from GitHub URL with /tree/', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo/tree/feat/v2');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo/feat/v2',
      name: 'repo',
      branch: 'feat/v2',
    });
  });

  it('should extract simple branch from GitHub URL', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo/tree/main');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo/main',
      name: 'repo',
      branch: 'main',
    });
  });

  it('should handle GitHub URL without branch (unchanged)', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo',
      name: 'repo',
    });
  });

  it('should handle GitHub URL with .git suffix and branch', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo.git/tree/dev');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo/dev',
      name: 'repo',
      branch: 'dev',
    });
  });

  it('should handle GitHub URL with trailing slash', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo/');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo',
      name: 'repo',
    });
  });

  it('should not extract branch from owner/repo shorthand', () => {
    const result = parseMarketplaceSource('owner/repo');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo',
      name: 'repo',
    });
  });
});

describe('parseMarketplaceSource Windows local paths', () => {
  it('should parse Windows absolute path with forward slashes', () => {
    const result = parseMarketplaceSource('D:/GitHub/WiseTechGlobal/WTG.AI.Prompts');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('local');
    expect(result!.name).toBe('WTG.AI.Prompts');
  });

  it('should parse Windows absolute path with backslashes', () => {
    const result = parseMarketplaceSource('C:\\Users\\test\\my-marketplace');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('local');
    expect(result!.name).toBe('my-marketplace');
  });

  it('should parse lowercase Windows drive letter', () => {
    const result = parseMarketplaceSource('c:/projects/plugins');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('local');
    expect(result!.name).toBe('plugins');
  });

  it('should parse UNC paths', () => {
    const result = parseMarketplaceSource('\\\\server\\share\\marketplace');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('local');
  });

  it('should parse relative path with backslashes as local', () => {
    const result = parseMarketplaceSource('some\\local\\path');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('local');
  });
});

describe('parseMarketplaceSource git source type', () => {
  it('should parse non-GitHub git URL as git type', () => {
    const result = parseMarketplaceSource('https://gitlab.com/owner/repo');
    expect(result).toEqual({
      type: 'git',
      location: 'https://gitlab.com/owner/repo',
      name: 'repo',
    });
  });

  it('should parse generic git URL with .git suffix', () => {
    const result = parseMarketplaceSource('https://gitlab.com/owner/repo.git');
    expect(result).toEqual({
      type: 'git',
      location: 'https://gitlab.com/owner/repo.git',
      name: 'repo',
    });
  });

  it('should keep GitHub URLs as github type', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo',
      name: 'repo',
    });
  });
});

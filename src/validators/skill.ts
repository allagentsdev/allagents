import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import {
  SkillMetadataSchema,
  type SkillMetadata,
} from '../models/skill-metadata.js';
import { flattenZodIssues } from '../utils/zod-issues.js';

/**
 * Result of skill validation
 */
export interface SkillValidationResult {
  valid: boolean;
  metadata?: SkillMetadata;
  error?: string;
  path: string;
}

/**
 * Validate a skill directory by checking its SKILL.md file
 * @param skillDir - Path to skill directory
 * @returns Validation result with metadata if valid
 */
export async function validateSkill(
  skillDir: string,
): Promise<SkillValidationResult> {
  const skillMdPath = join(skillDir, 'SKILL.md');

  // Check if SKILL.md exists
  if (!existsSync(skillMdPath)) {
    return {
      valid: false,
      path: skillMdPath,
      error: `SKILL.md not found in ${skillDir}`,
    };
  }

  try {
    // Read and parse SKILL.md
    const content = await readFile(skillMdPath, 'utf-8');
    const { data: frontmatter } = matter(content);

    // Check if frontmatter exists
    if (!frontmatter || Object.keys(frontmatter).length === 0) {
      return {
        valid: false,
        path: skillMdPath,
        error: 'SKILL.md must have YAML frontmatter with name and description',
      };
    }

    // Validate with Zod schema
    const result = SkillMetadataSchema.safeParse(frontmatter);

    if (!result.success) {
      const errors = flattenZodIssues(result.error).map(
        (err) => `${err.path.join('.')}: ${err.message}`,
      );
      return {
        valid: false,
        path: skillMdPath,
        error: `Invalid skill metadata: ${errors.join(', ')}`,
      };
    }

    return {
      valid: true,
      metadata: result.data,
      path: skillMdPath,
    };
  } catch (error) {
    if (error instanceof Error) {
      return {
        valid: false,
        path: skillMdPath,
        error: `Failed to parse SKILL.md: ${error.message}`,
      };
    }
    return {
      valid: false,
      path: skillMdPath,
      error: 'Unknown error parsing SKILL.md',
    };
  }
}

/**
 * Validate all skills in a directory
 * @param skillsDir - Path to skills directory (contains skill subdirectories)
 * @returns Array of validation results
 */
export async function validateAllSkills(
  skillsDir: string,
): Promise<SkillValidationResult[]> {
  const { readdir } = await import('node:fs/promises');

  if (!existsSync(skillsDir)) {
    return [];
  }

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skillDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => join(skillsDir, e.name));

  const results: SkillValidationResult[] = [];

  for (const skillDir of skillDirs) {
    const result = await validateSkill(skillDir);
    results.push(result);
  }

  return results;
}

/**
 * Parse skill metadata from SKILL.md content
 * @param content - Raw SKILL.md file content
 * @returns Parsed metadata or null if invalid
 */
export function parseSkillMetadata(content: string): SkillMetadata | null {
  try {
    const { data: frontmatter } = matter(content);
    const result = SkillMetadataSchema.safeParse(frontmatter);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
